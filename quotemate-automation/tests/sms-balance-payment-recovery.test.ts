import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createSmsBalancePaymentFixture, type BalanceRow } from './fixtures/sms-balance-payment-fixture'

type CarrierInput = { to: string; from?: string; text: string; statusCallback?: string; mediaUrl?: unknown }
type CarrierAttempt = CarrierInput & { sid: string | null; outcome: string }
const h = vi.hoisted(() => ({
  client: null as SupabaseClient | null, tenant: null as BalanceRow | null,
  unexpected: [] as string[], pdfs: new Map<string, string>(), downloads: [] as unknown[],
  rpcCalls: [] as string[], failBeforeRpc: null as string | null, loseAfterRpc: null as string | null,
  carrier: [] as CarrierAttempt[], providerMode: 'accepted',
  provider: null as ((input: CarrierInput) => Promise<unknown>) | null,
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => new Proxy({}, {
  get: (_, key) => { if (!h.client) throw new Error('Balance fixture not initialized'); return Reflect.get(h.client, key) },
}) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async (_db: unknown, req: Request) => {
  if (req.headers.get('authorization') !== 'Bearer offline-owner') return null
  return { tenant: h.tenant, identity: { userId: '22222222-2222-4222-8222-222222222222' } }
} }))
vi.mock('@/lib/estimation/auth', () => ({ tenantFromBearer: async (req: Request) =>
  req.headers.get('authorization') === 'Bearer offline-owner' ? h.tenant : null }))
vi.mock('@/lib/sms/twilio', () => ({
  sendSms: (input: CarrierInput) => h.provider!(input),
  sendWhatsApp: async () => { h.unexpected.push('WhatsApp'); throw new Error('Unexpected WhatsApp') },
  readTwilioMessage: async () => { h.unexpected.push('Carrier reconciliation read'); throw new Error('Unexpected reconciliation') },
}))
import { GET, POST } from '@/app/api/quote/[id]/request-final-payment/route'
import { POST as retryDelivery } from '@/app/api/tenant/sms-delivery/route'
import { recoverSmsOutbox } from '@/lib/sms/dispatch'
import { recordDeliveryReceipt } from '@/lib/sms/durable-outbox'
import { genericQuoteSendKey, quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { captureQuotePricingVersion } from '@/lib/quote/pricing-version'
import { resolveOwnedQuoteCustomerContact } from '@/lib/quote/delivery-recipient'

const APP = fileURLToPath(new URL('../', import.meta.url))
const WEBSITE = 'https://balance-customer.example.test'
const T = '11111111-1111-4111-8111-111111111111', INTAKE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', FINAL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CONVERSATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', BOOK = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const A = 'abcdefab-cdef-4abc-8def-abcdefabcdef', B = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba'
const PHONE = '+61411111111', FROM = '+61488888888'
const tracked = ['tests/sms-balance-payment-recovery.test.ts', 'tests/fixtures/sms-balance-payment-fixture.ts',
  'scripts/sms-owner-release-fixture.mjs', 'scripts/sms-route-fixture-db.mjs',
  'app/api/quote/[id]/request-final-payment/route.ts', 'app/api/quote/[id]/request-final-payment/route.test.ts', 'app/api/tenant/sms-delivery/route.ts',
  'lib/sms/dispatch.ts', 'lib/sms/durable-outbox.ts', 'lib/sms/quote-origin-conversation.ts',
  'lib/quote/customer-release.ts', 'lib/quote/chain-money.ts', 'lib/quote/delivery-recipient.ts', 'lib/quote/job-quote-operation.ts', 'lib/quote/pricing-version.ts',
  ...['198_sms_durable_work.sql', '199_sms_delivery_outbox.sql', '201_sms_trade_quote_contract.sql',
    '202_job_quote_operations.sql', '205_generic_quote_customer_release.sql', '207_quote_pricing_versions.sql',
    '211_commercial_quote_release_guard.sql', '212_plan_quote_release_guard.sql', '213_prepare_balance_quote.sql', '215_generic_release_snapshot.sql',
    '217_final_quote_credit_settlement.sql'].map(name => `sql/migrations/${name}`)]
const hash = (path: string) => createHash('sha256').update(readFileSync(join(APP, path))).digest('hex')
const evidence = { completed: false, results: [] as { name: string; passed: boolean; carrierAttempts: number }[],
  sourceHashes: Object.fromEntries(tracked.map(path => [path, hash(path)])),
  limits: ['Actual source POST/GET, chain/readiness/origin helpers, dispatch and SQL198/199/201/202/205/207/211/212/213/215/217 over one PGlite database.',
    'Owned paid root/final/intake are fixtures; this does not execute issue-final, Stripe payment settlement, browser/native UI or compiled fleet bootstrap.',
    'Auth, PostgREST-shaped transport, accepted/rejected/unknown carrier responses and response-loss injection are fixtures; no external I/O.',
    'Exact native operation and outbox/transcript constraints are executed; single-connection PGlite does not certify multi-connection production races.',
    'Pre-215 compatibility cases reconstruct only historical revision/snapshot metadata on a real generated intent; they do not execute the old application binary.',
    'Missing-current-contact fixtures unlink only the conversation intake lookup; the original saved delivery conversation and recipient remain owned and unchanged.',
    'Named hashes are explicit dependencies, not the complete runtime import closure.'] }
let db: Awaited<ReturnType<typeof createSmsBalancePaymentFixture>>
let originalChain: BalanceRow[]
let pricingVersionId: string
const output = join(APP, '../docs/audits/2026-09-09-sms-balance-payment-recovery.json')
const request = (path: string, body?: BalanceRow) => new Request(WEBSITE + path, {
  method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer offline-owner', 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
async function rows(table: 'quotes' | 'sms_outbox' | 'sms_messages' | 'intakes' | 'sms_conversations') {
  const result = await db.pg.query<{ value: BalanceRow }>(`select to_jsonb(t) as value from ${table} t order by id`)
  return result.rows.map(item => item.value)
}
async function balance() { const result = (await rows('quotes')).filter(row => row.quote_kind === 'balance'); expect(result).toHaveLength(1); return result[0] }
async function final() { return (await rows('quotes')).find(row => row.id === FINAL)! }
async function post(requestId: string | null = A, expected = PHONE) {
  return POST(request(`/api/quote/${FINAL}/request-final-payment`, {
    ...(requestId ? { requestId } : {}), expected_recipient: expected, expected_revision: quoteCustomerReleaseRevision(await final()),
  }), { params: Promise.resolve({ id: FINAL }) })
}
async function get(requestId: string | null = A) {
  const response = await GET(request(`/api/quote/${FINAL.toUpperCase()}/request-final-payment${requestId ? `?requestId=${requestId}` : ''}`),
    { params: Promise.resolve({ id: FINAL.toUpperCase() }) })
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store')
  const result = await response.json()
  expect(result).not.toHaveProperty('payload'); expect(result.message ?? {}).not.toHaveProperty('payload')
  expect(JSON.stringify(result)).not.toContain(PHONE)
  return result
}
async function assertAccepted(expectedIntents = 1) {
  const outboxes = await rows('sms_outbox'), messages = await rows('sms_messages'), child = await balance()
  const quotes = await rows('quotes')
  expect(quotes).toHaveLength(3)
  expect(quotes.filter(row => row.id === ROOT || row.id === FINAL)).toEqual(originalChain)
  expect(outboxes).toHaveLength(expectedIntents); expect(messages).toHaveLength(expectedIntents)
  expect(h.carrier.filter(call => call.outcome === 'accepted')).toHaveLength(expectedIntents)
  expect(child).toMatchObject({ parent_quote_id: FINAL, tenant_id: T, intake_id: INTAKE, total_inc_gst: 700, deposit_pct: 30,
    pricing_book_version_id: pricingVersionId, quote_kind: 'balance', status: 'sent' })
  expect(child.sent_at).toBeTruthy(); expect(child.customer_released_at).toBeTruthy()
  for (const box of outboxes) {
    expect(box).toMatchObject({ status: 'accepted', tenant_id: T, conversation_id: CONVERSATION, to_number: PHONE, audience: 'customer' })
    const payload = box.payload as BalanceRow
    expect(payload).toMatchObject({ tenantId: T, to: PHONE, from: FROM, conversationId: CONVERSATION, quoteReleaseId: child.id })
    expect(payload.text).toContain(`${WEBSITE}/r/${child.share_token}/balance`)
    expect(messages.filter(message => message.outbox_id === box.id)).toEqual([expect.objectContaining({
      tenant_id: T, conversation_id: CONVERSATION, to_number: PHONE, direction: 'outbound', audience: 'customer',
      body: payload.text, twilio_message_sid: box.provider_sid, delivery_status: 'accepted',
    })])
    expect(h.carrier.filter(call => call.sid === box.provider_sid)).toEqual([expect.objectContaining({ to: PHONE, from: FROM, text: payload.text })])
  }
  return outboxes
}
async function assertReadOnly(requestId: string | null = A) {
  const before = { quotes: await rows('quotes'), boxes: await rows('sms_outbox'), messages: await rows('sms_messages'), calls: h.carrier.length, rpc: h.rpcCalls.length }
  const result = await get(requestId)
  expect({ quotes: await rows('quotes'), boxes: await rows('sms_outbox'), messages: await rows('sms_messages'), calls: h.carrier.length, rpc: h.rpcCalls.length }).toEqual(before)
  return result
}
async function assertReplayReadOnly(requestId = A, expected = PHONE, status = 200) {
  const snapshot = async () => ({ quotes: await rows('quotes'), boxes: await rows('sms_outbox'), messages: await rows('sms_messages'),
    conversations: await rows('sms_conversations'), calls: h.carrier.length, rpc: h.rpcCalls.length })
  const before = await snapshot()
  const response = await post(requestId, expected)
  expect(response.status).toBe(status)
  const result = await response.json()
  expect(JSON.stringify(result)).not.toContain(PHONE)
  expect(await snapshot()).toEqual(before)
  return result
}
async function changeContact(phone: string | null) {
  await db.pg.query('update intakes set caller=$1::jsonb where id=$2', [JSON.stringify({ name: 'Sam', phone, email: 'sam@offline.example.test' }), INTAKE])
  // A missing caller phone alone still resolves the owned conversation fallback.
  // Remove its current intake lookup association, keeping the original delivery
  // conversation and transcript ownership intact for the saved operation.
  if (phone === null) await db.pg.query('update sms_conversations set intake_id=null where id=$1', [CONVERSATION])
  expect((await resolveOwnedQuoteCustomerContact(db.client, T, (await rows('intakes'))[0])).phone).toBe(phone)
}
function scenario(name: string, run: () => Promise<void>) {
  it(name, async () => { try { await run(); evidence.results.push({ name, passed: true, carrierAttempts: h.carrier.length }) }
    catch (error) { evidence.results.push({ name, passed: false, carrierAttempts: h.carrier.length }); throw error } })
}

beforeAll(async () => {
  writeFileSync(output, JSON.stringify(evidence, null, 2))
  vi.stubEnv('PUBLIC_WEB_ORIGIN', WEBSITE); vi.stubEnv('APP_URL', 'https://offline-internal.example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://offline-db.invalid'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'offline-balance-only')
  vi.stubEnv('TWILIO_SMS_NUMBER', '+61499999999'); vi.stubEnv('TWILIO_PHONE_NUMBER', '+61499999999')
  vi.stubGlobal('fetch', async () => { h.unexpected.push('fetch'); throw new Error('Unexpected external fetch') })
  db = await createSmsBalancePaymentFixture(APP, h); h.client = db.client
  await db.seed('tenants', [{ id: T }])
  await db.seed('pricing_book', [{ id: BOOK, tenant_id: T, trade: 'electrical', gst_registered: false }])
  const book = await db.client.from('pricing_book').select('*').eq('id', BOOK).single()
  expect(book.error).toBeNull()
  pricingVersionId = (await captureQuotePricingVersion(db.client, book.data!, T, 'electrical')).id
  h.tenant = { id: T, business_name: 'Offline owner', twilio_sms_number: FROM, stripe_connect_account_id: 'acct_offline',
    stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true }
  h.provider = async input => {
    expect(input.to).toBe(PHONE); expect(input.from).toBe(FROM); expect(input.mediaUrl).toBeUndefined()
    const callback = new URL(input.statusCallback!); expect(callback.origin).toBe(WEBSITE); expect(callback.pathname).toBe('/api/sms/status')
    const saved = (await rows('sms_outbox')).find(row => row.id === callback.searchParams.get('outbox'))!
    expect(saved).toMatchObject({ status: 'sending', attempt_token: callback.searchParams.get('attempt'), tenant_id: T, conversation_id: CONVERSATION })
    expect((saved.payload as BalanceRow).text).toBe(input.text)
    const sid = h.providerMode === 'accepted' ? `SM${String(h.carrier.length + 1).padStart(32, '0')}` : null
    h.carrier.push({ ...input, sid, outcome: h.providerMode })
    if (h.providerMode === 'ambiguous') throw new Error('Injected carrier response lost after possible acceptance')
    if (h.providerMode === 'rejected') return { ok: false, code: '21612', reason: 'Explicit provider rejection', raw: null }
    return { ok: true, sid, status: 'queued' }
  }
}, 30000)
beforeEach(async () => {
  h.carrier.length = 0; h.rpcCalls.length = 0; h.providerMode = 'accepted'; h.failBeforeRpc = null; h.loseAfterRpc = null
  await db.pg.exec('truncate sms_messages,sms_outbox,sms_conversations,quotes,intakes cascade')
  await db.seed('intakes', [{ id: INTAKE, tenant_id: T, trade: 'electrical', job_type: 'power_points', caller: { name: 'Sam', phone: PHONE, email: 'sam@offline.example.test' } }])
  const common = { tenant_id: T, intake_id: INTAKE, needs_inspection: false, inspection_reason: null, assumptions: [], estimated_timeframe: null,
    display_mode: null, applied_discount_pct: 0, deposit_pct: 30, scope_of_works: 'Completed electrical work', scope_short: null, stripe_links: {},
    paid_at: '2026-09-08T00:00:00Z', sent_at: '2026-09-07T00:00:00Z', status: 'paid', pricing_book_version_id: pricingVersionId }
  await db.seed('quotes', [{ ...common, id: ROOT, parent_quote_id: null, quote_kind: 'initial', paid_tier: 'inspection', share_token: 'offline-paid-inspection-root' },
    { ...common, id: FINAL, parent_quote_id: ROOT, quote_kind: 'final', paid_tier: 'deposit', share_token: 'offline-paid-final', total_inc_gst: 1000, gst_note: 'GST not registered' }])
  await db.seed('sms_conversations', [{ id: CONVERSATION, tenant_id: T, from_number: PHONE, to_number: FROM, intake_id: INTAKE, quote_id: ROOT, status: 'done', conversation_type: 'customer_quote' }])
  originalChain = await rows('quotes')
})
afterAll(async () => {
  try {
    expect(h.unexpected).toEqual([])
    for (const [path, expected] of Object.entries(evidence.sourceHashes)) expect(hash(path), path).toBe(expected)
    evidence.completed = evidence.results.length === 23 && evidence.results.every(result => result.passed)
  } finally { writeFileSync(output, JSON.stringify({ ...evidence, unexpected: h.unexpected }, null, 2)); await db?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }
})

describe('actual balance payment operation through durable SQL and carrier boundary', () => {
  scenario('native first UUID, case-folded replay and exact read-only GET identify one accepted customer intent', async () => {
    expect((await post()).status).toBe(200)
    expect((await post(A.toUpperCase())).status).toBe(200)
    const [box] = await assertAccepted()
    expect(box.delivery_key).toBe(genericQuoteSendKey(String((await balance()).id), A))
    expect(await assertReadOnly(A.toUpperCase())).toMatchObject({ finalQuoteId: FINAL, outboxId: box.id, status: 'accepted', approved: true })
    expect(await assertReadOnly(null)).toMatchObject({ status: 'not_found', outboxId: null })
    expect(h.carrier).toHaveLength(1)
  })
  scenario('lost release acknowledgement keeps one pending intent; POST only recovers state and the worker accepts its persisted payload', async () => {
    h.loseAfterRpc = 'approve_generic_quote_release'
    expect((await post()).status).toBe(503); expect(h.carrier).toHaveLength(0)
    const [pending] = await rows('sms_outbox'); expect(pending.status).toBe('pending')
    expect((await balance()).sent_at).toBeNull(); expect(await rows('sms_messages')).toEqual([])
    expect(await assertReadOnly()).toMatchObject({ outboxId: pending.id, status: 'pending', approved: true })
    expect(await assertReplayReadOnly(A, PHONE, 202)).toMatchObject({ accepted: false, deliveryStatus: 'pending', outboxId: pending.id })
    expect(await recoverSmsOutbox()).toEqual({ attempted: 1, reconciled: 0 })
    const [accepted] = await assertAccepted(); expect(accepted.id).toBe(pending.id); expect(accepted.payload).toEqual(pending.payload)
  })
  scenario('lost finish acknowledgement after acceptance is recovered by GET and never resends', async () => {
    h.loseAfterRpc = 'sms_outbox_finish'
    expect((await post()).status).toBe(202)
    const [accepted] = await assertAccepted()
    expect(await assertReadOnly()).toMatchObject({ outboxId: accepted.id, status: 'accepted' })
    expect((await post()).status).toBe(200); await assertAccepted(); expect(h.carrier).toHaveLength(1)
  })
  scenario('unsaved accepted outcome expires to unknown and only a matching receipt repairs publication', async () => {
    h.failBeforeRpc = 'sms_outbox_finish'
    expect((await post()).status).toBe(202)
    const [sending] = await rows('sms_outbox')
    expect(sending).toMatchObject({ status: 'sending', provider_sid: null })
    expect(await rows('sms_messages')).toEqual([]); expect((await balance()).sent_at).toBeNull()
    expect(await assertReadOnly()).toMatchObject({ status: 'sending', outboxId: sending.id })
    expect((await post()).status).toBe(202); expect(h.carrier).toHaveLength(1)
    await db.pg.query("update sms_outbox set lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second' where id=$1", [sending.id])
    expect(await recoverSmsOutbox()).toEqual({ attempted: 1, reconciled: 0 })
    expect(await assertReadOnly()).toMatchObject({ status: 'unknown', outboxId: sending.id })
    expect((await retryDelivery(request('/api/tenant/sms-delivery', { id: sending.id }))).status).toBe(409)
    const callback = new URL(h.carrier[0].statusCallback!)
    const receipt = { outboxId: String(sending.id), attempt: callback.searchParams.get('attempt')!, sid: h.carrier[0].sid!, status: 'sent' }
    expect(await recordDeliveryReceipt(receipt, db.client)).toBe(true)
    expect(await recordDeliveryReceipt(receipt, db.client)).toBe(true)
    await assertAccepted(); expect(h.carrier).toHaveLength(1)
  })
  scenario('explicit second UUID adds one intent to the same balance while each operation replay remains stable', async () => {
    expect((await post()).status).toBe(200); const original = structuredClone((await rows('sms_outbox'))[0])
    expect((await post(B)).status).toBe(200); expect((await post(B.toUpperCase())).status).toBe(200); expect((await post(A)).status).toBe(200)
    const boxes = await assertAccepted(2); expect(boxes.find(row => row.id === original.id)).toEqual(original)
    expect((await assertReadOnly(B)).outboxId).not.toBe(original.id); expect((await assertReadOnly(A)).outboxId).toBe(original.id)
  })
  scenario('legacy omitted identity retains its own initial intent and never aliases a supplied UUID', async () => {
    expect((await post(null)).status).toBe(200); expect((await post(null)).status).toBe(200)
    const [box] = await assertAccepted(); expect(box.delivery_key).toBe(genericQuoteSendKey(String((await balance()).id)))
    expect(await assertReadOnly(null)).toMatchObject({ status: 'accepted', outboxId: box.id })
    expect(await assertReadOnly(A)).toMatchObject({ status: 'not_found', outboxId: null })
  })
  scenario('a pre-release persistence failure sends nothing and retries the same prepared child', async () => {
    h.failBeforeRpc = 'approve_generic_quote_release'
    expect((await post()).status).toBe(503); const prepared = await balance()
    expect(prepared.sent_at).toBeNull(); expect(prepared.customer_released_at).toBeNull()
    expect(await rows('sms_outbox')).toEqual([]); expect(await rows('sms_messages')).toEqual([]); expect(h.carrier).toEqual([])
    expect(await assertReadOnly()).toMatchObject({ quoteId: prepared.id, approved: false, status: 'not_found' })
    expect((await post()).status).toBe(200); await assertAccepted(); expect((await balance()).id).toBe(prepared.id)
  })
  scenario('ambiguous carrier outcome cannot be retried by replay, automatic recovery or owner retry', async () => {
    h.providerMode = 'ambiguous'; expect((await post()).status).toBe(202)
    const [unknown] = await rows('sms_outbox'); expect(unknown).toMatchObject({ status: 'unknown', requires_attention: true })
    expect(await assertReadOnly()).toMatchObject({ status: 'unknown', outboxId: unknown.id })
    h.providerMode = 'accepted'; expect((await post()).status).toBe(202)
    expect(await recoverSmsOutbox()).toEqual({ attempted: 0, reconciled: 0 })
    expect((await retryDelivery(request('/api/tenant/sms-delivery', { id: unknown.id }))).status).toBe(409)
    expect(h.carrier).toHaveLength(1); expect(await rows('sms_messages')).toEqual([]); expect((await balance()).sent_at).toBeNull()
  })
  scenario('definite provider rejection requires explicit owner recovery and yields one accepted transcript', async () => {
    h.providerMode = 'rejected'; expect((await post()).status).toBe(202)
    const [failed] = await rows('sms_outbox'); expect(failed).toMatchObject({ status: 'failed', requires_attention: true })
    expect(await rows('sms_messages')).toEqual([]); expect((await balance()).sent_at).toBeNull()
    h.providerMode = 'accepted'; expect((await post()).status).toBe(202); expect(h.carrier).toHaveLength(1)
    expect((await retryDelivery(request('/api/tenant/sms-delivery', { id: failed.id }))).status).toBe(200)
    expect(await recoverSmsOutbox()).toEqual({ attempted: 1, reconciled: 0 })
    const [accepted] = await assertAccepted(); expect(accepted.id).toBe(failed.id); expect(accepted.payload).toEqual(failed.payload); expect(h.carrier).toHaveLength(2)
  })
  for (const phone of ['+61422222222', null]) {
    scenario(`accepted UUID retains its original recipient when current contact becomes ${phone ?? 'null'} and refuses retargeting`, async () => {
      expect((await post()).status).toBe(200); const [original] = await assertAccepted()
      const revision = quoteCustomerReleaseRevision(await final())
      await changeContact(phone)
      expect(quoteCustomerReleaseRevision(await final())).toBe(revision)
      expect(await assertReadOnly()).toMatchObject({ status: 'accepted', outboxId: original.id })
      expect(await assertReplayReadOnly(A.toUpperCase())).toMatchObject({ accepted: true, deliveryStatus: 'accepted', outboxId: original.id, requestId: A })
      expect(await assertReplayReadOnly(A, '+61422222222', 409)).toMatchObject({ error: 'quote_recipient_changed' })
      expect(await rows('sms_outbox')).toEqual([original]); await assertAccepted(); expect(h.carrier).toHaveLength(1)
    })
    for (const state of ['pending', 'unknown']) {
      scenario(`${state} UUID retains its recipient when current contact becomes ${phone ?? 'null'} without implicit dispatch`, async () => {
        if (state === 'pending') h.loseAfterRpc = 'approve_generic_quote_release'
        else h.providerMode = 'ambiguous'
        expect((await post()).status).toBe(state === 'pending' ? 503 : 202)
        const [original] = await rows('sms_outbox'); expect(original.status).toBe(state)
        await changeContact(phone)
        expect(await assertReplayReadOnly(A.toUpperCase(), PHONE, 202)).toMatchObject({ accepted: false, sent: false, deliveryStatus: state, outboxId: original.id })
        expect(await assertReplayReadOnly(A, '+61422222222', 409)).toMatchObject({ error: 'quote_recipient_changed' })
        expect(await assertReadOnly()).toMatchObject({ status: state, outboxId: original.id })
        expect(await rows('sms_outbox')).toEqual([original]); expect(await rows('sms_messages')).toEqual([])
        expect(h.carrier).toHaveLength(state === 'pending' ? 0 : 1)
        h.providerMode = 'accepted'
        if (state === 'pending') {
          expect(await recoverSmsOutbox()).toEqual({ attempted: 1, reconciled: 0 })
          const [accepted] = await assertAccepted(); expect(accepted.payload).toEqual(original.payload)
        } else expect(await recoverSmsOutbox()).toEqual({ attempted: 0, reconciled: 0 })
      })
    }
    scenario(`an unbound next UUID still checks current ${phone ?? 'missing'} contact`, async () => {
      expect((await post()).status).toBe(200); const [original] = await assertAccepted()
      await changeContact(phone)
      expect(await assertReplayReadOnly(B, PHONE, 409)).toMatchObject({ error: phone ? 'quote_recipient_changed' : 'no_customer_number' })
      expect(await rows('sms_outbox')).toEqual([original]); await assertAccepted()
    })
  }
  scenario('a retained operation rejects a mismatched saved quote resource without dispatch', async () => {
    expect((await post()).status).toBe(200)
    await db.pg.query("update sms_outbox set payload=jsonb_set(payload,'{quoteReleaseId}',to_jsonb($1::text))", [ROOT])
    expect(await assertReplayReadOnly(A, PHONE, 409)).toMatchObject({ error: 'balance_delivery_review_required' })
  })
  scenario('a retained operation rejects a mismatched payload operation key without dispatch', async () => {
    expect((await post()).status).toBe(200)
    await db.pg.query("update sms_outbox set payload=jsonb_set(payload,'{deliveryKey}',to_jsonb($1::text))", [genericQuoteSendKey(String((await balance()).id), B)])
    expect(await assertReplayReadOnly(A, PHONE, 409)).toMatchObject({ error: 'balance_delivery_review_required' })
  })
  scenario('a retained operation refuses conversation ownership that now points at another recipient', async () => {
    expect((await post()).status).toBe(200)
    await db.pg.query('update sms_conversations set from_number=$1 where id=$2', ['+61422222222', CONVERSATION])
    expect(await assertReplayReadOnly(A, PHONE, 409)).toMatchObject({ error: 'balance_delivery_review_required' })
  })
  scenario('a retained operation still rejects a stale final review revision', async () => {
    expect((await post()).status).toBe(200)
    const before = { boxes: await rows('sms_outbox'), calls: h.carrier.length, rpc: h.rpcCalls.length }
    const response = await POST(request(`/api/quote/${FINAL}/request-final-payment`, {
      requestId: A, expected_recipient: PHONE, expected_revision: 'stale-owner-review',
    }), { params: Promise.resolve({ id: FINAL }) })
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'quote_review_required' })
    expect({ boxes: await rows('sms_outbox'), calls: h.carrier.length, rpc: h.rpcCalls.length }).toEqual(before)
    await assertAccepted()
  })
  for (const state of ['accepted', 'pending']) {
    scenario(`a retained ${state} pre-215 payload shape remains recoverable without rewriting its old revision`, async () => {
      if (state === 'pending') h.loseAfterRpc = 'approve_generic_quote_release'
      expect((await post()).status).toBe(state === 'pending' ? 503 : 200)
      const [box] = await rows('sms_outbox'), payload = { ...(box.payload as BalanceRow) }
      const snapshot = { ...(payload.quoteReleaseSnapshot as BalanceRow) }
      for (const key of ['parent_quote_id', 'pricing_book_version_id', 'report_doc', 'report_style']) delete snapshot[key]
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value ?? null
      payload.quoteReleaseRevision = createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex')
      delete payload.quoteReleaseSnapshot
      expect(payload.quoteReleaseRevision).not.toBe(quoteCustomerReleaseRevision(await balance()))
      // Compatibility fixture: only historical metadata is reconstructed; the
      // owned quote, intent, carrier receipt and body were produced by real routes.
      await db.pg.query('update sms_outbox set payload=$1::jsonb where id=$2', [JSON.stringify(payload), box.id])
      await changeContact(null)
      expect(await assertReplayReadOnly(A, PHONE, state === 'pending' ? 202 : 200)).toMatchObject({ outboxId: box.id, deliveryStatus: state })
      if (state === 'pending') expect(await recoverSmsOutbox()).toEqual({ attempted: 1, reconciled: 0 })
      const [accepted] = await assertAccepted(); expect(accepted.payload).toEqual(payload)
    })
  }
})
