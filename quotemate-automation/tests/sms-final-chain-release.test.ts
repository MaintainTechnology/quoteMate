import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSmsFinalChainFixture } from './fixtures/sms-final-chain-fixture'
import type { BalanceRow as Row } from './fixtures/sms-balance-payment-fixture'

type Attempt = { to: string; from: string; text: string; callback: string; sid: string; mode: string }
const h = vi.hoisted(() => ({ client: null as SupabaseClient | null, tenant: null as Row | null,
  unexpected: [] as string[], pdfs: new Map<string, string>(), downloads: [] as unknown[],
  rpcCalls: [] as string[], failBeforeRpc: null as string | null, loseAfterRpc: null as string | null,
  carrier: [] as Attempt[], reads: [] as string[], mode: 'accepted', readMode: 'delivered',
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => new Proxy({}, {
  get: (_, key) => { if (!h.client) throw new Error('Chain fixture not ready'); return Reflect.get(h.client, key) },
}) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async (_db: unknown, request: Request) =>
  request.headers.get('authorization') === 'Bearer offline-chain-owner'
    ? { tenant: h.tenant, identity: { userId: '22222222-2222-4222-8222-222222222222' } } : null,
}))
vi.mock('@/lib/estimation/auth', () => ({ tenantFromBearer: async (request: Request) =>
  request.headers.get('authorization') === 'Bearer offline-chain-owner' ? h.tenant : null,
}))
vi.mock('next/server', () => ({ after: () => {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/q/offline', useRouter: () => ({}), useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NOT_FOUND') }, redirect: (url: string) => { throw new Error(`REDIRECT:${url}`) },
}))
vi.mock('@/lib/auth/client-token', () => ({ getAuthToken: async () => null }))
vi.mock('@/app/q/_chrome/TradieJobBanner', () => ({ TradieJobBanner: () => null }))
vi.mock('@/app/q/_chrome/TradieDashboardPill', () => ({ TradieDashboardPill: () => null }))
// Exercise the actual link-only mode. No fabricated PDF or renderer success.
vi.mock('@/lib/pdf/gotenberg', () => ({ gotenbergConfigured: () => false,
  renderPdfFromHtml: async () => { h.unexpected.push('PDF renderer'); throw new Error('Unexpected renderer') },
}))

import { POST as issueFinal } from '@/app/api/quote/[id]/issue-final/route'
import { POST as sendFinal } from '@/app/api/quote/[id]/send/route'
import { GET as readBalance, POST as requestBalance } from '@/app/api/quote/[id]/request-final-payment/route'
import { GET as deliveryGET, POST as deliveryRetry } from '@/app/api/tenant/sms-delivery/route'
import { POST as receiptPOST } from '@/app/api/sms/status/route'
import QuotePage from '@/app/q/[token]/page'
import { quoteEditRevision } from '@/lib/quote/edit-authority'
import { genericQuoteSendKey, quoteCustomerReleaseRevision, quoteCustomerReleaseSnapshot } from '@/lib/quote/customer-release'
import { captureQuotePricingVersion } from '@/lib/quote/pricing-version'
import { readQuoteCreditSettlement } from '@/lib/quote/credit-settlement'
import { dispatchQuoteMessage, recoverSmsOutbox } from '@/lib/sms/dispatch'
import { handleExistingQuoteAction } from '@/lib/sms/quote-actions'
import { withSmsDeliveryContext } from '@/lib/sms/delivery-context'

const APP = fileURLToPath(new URL('../', import.meta.url)), WEB = 'https://chain-customer.example.test'
const TENANT = '11111111-1111-4111-8111-111111111111', ROOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INTAKE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PHONE = '+61411111111', FROM = '+61488888888', ACCOUNT = `AC${'1'.repeat(32)}`, SECRET = 'offline-chain-signature-only'
const REQUEST = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
const paths = ['tests/sms-final-chain-release.test.ts', 'tests/fixtures/sms-final-chain-fixture.ts',
  'tests/fixtures/sms-balance-payment-fixture.ts', 'scripts/sms-owner-release-fixture.mjs', 'scripts/sms-route-fixture-db.mjs',
  'app/api/quote/[id]/issue-final/route.ts', 'app/api/quote/[id]/send/route.ts', 'app/api/quote/[id]/request-final-payment/route.ts',
  'app/api/tenant/sms-delivery/route.ts', 'app/api/sms/status/route.ts', 'app/q/[token]/page.tsx',
  'lib/quote/customer-release.ts', 'lib/quote/credit-settlement.ts', 'lib/quote/chain-money.ts', 'lib/quote/pricing-version.ts',
  'lib/quote/report-pricing.ts', 'lib/quote/pdf.ts', 'lib/quote/delivery-recipient.ts', 'lib/quote/tier-materialise.ts',
  'lib/sms/twilio.ts', 'lib/sms/twilio-validator.ts', 'lib/sms/dispatch.ts', 'lib/sms/durable-outbox.ts',
  'lib/sms/quote-actions.ts', 'lib/sms/templates.ts', 'lib/sms/send-quote-pdf.ts', 'lib/sms/quote-origin-conversation.ts',
  ...['198_sms_durable_work.sql','199_sms_delivery_outbox.sql','201_sms_trade_quote_contract.sql','202_job_quote_operations.sql',
    '205_generic_quote_customer_release.sql','207_quote_pricing_versions.sql','211_commercial_quote_release_guard.sql',
    '212_plan_quote_release_guard.sql','213_prepare_balance_quote.sql','214_prepare_final_quote.sql',
    '215_generic_release_snapshot.sql','217_final_quote_credit_settlement.sql'].map(file => `sql/migrations/${file}`)]
const hash = (path: string) => createHash('sha256').update(readFileSync(join(APP, path))).digest('hex')
const output = join(APP, '../docs/audits/2026-09-09-sms-final-chain-release.json')
const evidence = { completed: false, results: [] as Row[], sourceHashes: Object.fromEntries(paths.map(path => [path, hash(path)])),
  limits: ['Paid initial inspection and its historical priced tier are synthetic inputs. Final creation214, release215, credit settlement217, balance213, dispatch199, actual Twilio HTTP parsing and signed status route execute locally.',
    'PGlite has one connection and explicit minimal physical columns, not a production schema/RLS or multi-connection certification.',
    'Only electrical and plumbing use this inspection/final/balance chain. No Stripe charge, live model, real SMS, deployed front desk or native/browser action is executed.',
    'Final and balance pages use actual server rendering; balance token redirects to the final page. Payment short-link URLs are asserted but no checkout is opened.',
    'Auth and PostgREST transport are fixtures. Carrier fetch is replaced at the HTTP boundary, validates destination/body/attempt identity, and never leaves the process.',
    'PDF renderer is explicitly unavailable; actual send validates saved report pricing and uses supported link-only mode. PDF rendering/visual fidelity is a separate gate.',
    'Stale timestamps and thrown timeout events are injected, not real elapsed five-minute/ten-second waits. Hashes cover named boundaries, not the entire import closure.'] }
let db: Awaited<ReturnType<typeof createSmsFinalChainFixture>>
const req = (path: string, body?: Row, auth = true) => new Request(WEB + path, { method: body ? 'POST' : 'GET',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer offline-chain-owner' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
async function rows(table: 'quotes' | 'sms_outbox' | 'sms_messages' | 'quote_credit_settlements') {
  const result = await db.pg.query<{ value: Row }>(`select to_jsonb(t) as value from ${table} t order by ${table === 'quote_credit_settlements' ? 'outbox_id' : 'id'}`)
  return result.rows.map(row => row.value)
}
async function quote(id: string) { return (await rows('quotes')).find(row => row.id === id)! }
async function page(token: string) {
  return renderToStaticMarkup(await QuotePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) }))
}
async function prepare(trade = 'electrical', gst = false) {
  const bookId = randomUUID(), subtotal = gst ? 250.01 : 300.01, total = gst ? 275.01 : 300.01
  await db.seed('pricing_book', [{ id: bookId, tenant_id: TENANT, trade, gst_registered: gst, quote_tier_mode: 'single',
    hourly_rate: 125, overlays: { deposit_pct_by_job_type: { default: 30 } } }])
  const book = await db.client.from('pricing_book').select('*').eq('id', bookId).single()
  const version = await captureQuotePricingVersion(db.client, book.data!, TENANT, trade)
  await db.seed('intakes', [{ id: INTAKE, tenant_id: TENANT, trade, job_type: trade === 'electrical' ? 'power_points' : 'tap_replacement',
    address: '12 Offline Road, Sydney NSW 2000', suburb: 'Sydney', caller: { name: 'Sam', phone: PHONE },
    scope: { description: 'Agreed small repair after site inspection', item_count: 1 }, photo_paths: [] }])
  await db.seed('quotes', [{ id: ROOT, tenant_id: TENANT, intake_id: INTAKE, quote_kind: 'initial', parent_quote_id: null,
    share_token: 'offline_paid_inspection_root_token', paid_at: '2026-09-08T00:00:00Z', paid_tier: 'inspection', paid_amount_cents: 9900,
    sent_at: '2026-09-07T00:00:00Z', status: 'paid', pricing_book_version_id: version.id,
    good: { label: 'Confirmed repair', subtotal_ex_gst: subtotal,
      line_items: [{ description: 'Agreed small repair', quantity: 1, unit_price_ex_gst: subtotal, total_ex_gst: subtotal, source: 'inspection:agreed-scope' }] },
    selected_tier: 'good', subtotal_ex_gst: subtotal, total_inc_gst: total, deposit_pct: 30, applied_discount_pct: 0,
    scope_of_works: 'Agreed small repair', scope_short: 'Repair after inspection', assumptions: [], risk_flags: [], optional_upsells: [],
    estimated_timeframe: 'One day', needs_inspection: true, inspection_reason: 'Site assessment', gst_note: gst ? 'Includes GST' : 'GST not registered',
    display_mode: 'full', stripe_links: {} }])
  await db.seed('sms_conversations', [{ id: CONV, tenant_id: TENANT, from_number: PHONE, to_number: FROM, intake_id: INTAKE,
    quote_id: ROOT, status: 'done', conversation_type: 'customer_quote', photo_paths: [] }])
  const original = await quote(ROOT)
  const create = () => issueFinal(req(`/api/quote/${ROOT}/issue-final`, { expected_revision: quoteEditRevision(original) }), { params: Promise.resolve({ id: ROOT }) })
  const response = await create(), body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  const saved = await quote(body.quote_id)
  expect(saved).toMatchObject({ quote_kind: 'final', status: 'draft', parent_quote_id: ROOT, pricing_book_version_id: version.id,
    total_inc_gst: total, deposit_pct: 30, paid_at: null, sent_at: null, customer_released_at: null })
  expect(saved.good).toMatchObject({ subtotal_ex_gst: subtotal, line_items: [expect.objectContaining({ source: 'inspection:agreed-scope' })] })
  expect(h.carrier).toHaveLength(0); expect(await rows('sms_outbox')).toHaveLength(0)
  expect(await page(String(saved.share_token))).not.toContain(total.toFixed(2))
  // Reopening retains exact child/token and historical price after mutable tax/rates change.
  await db.pg.query('update pricing_book set hourly_rate=900,gst_registered=$1 where id=$2', [!gst, bookId])
  expect(await (await create()).json()).toMatchObject({ already: true, quote_id: saved.id, share_token: saved.share_token })
  expect(await quote(ROOT)).toEqual(original)
  return { final: saved, original, versionId: version.id, total }
}
async function send(saved: Row, auth = true, revision = quoteCustomerReleaseRevision(saved)) {
  return sendFinal(req(`/api/quote/${saved.id}/send`, { channel: 'sms', expected_recipient: PHONE, expected_revision: revision }, auth),
    { params: Promise.resolve({ id: String(saved.id) }) })
}
async function delivery(id: string) {
  const response = await deliveryGET(req(`/api/tenant/sms-delivery?quoteId=${id}`))
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store')
  const body = await response.json(); expect(JSON.stringify(body)).not.toContain(PHONE); return body
}
async function signed(attempt: Attempt, status: string, extra: Record<string, string> = {}, legacy = false, url = attempt.callback, valid = true) {
  const params: Record<string, string> = { AccountSid: ACCOUNT, MessageSid: attempt.sid, [legacy ? 'SmsStatus' : 'MessageStatus']: status, ...extra }
  const signature = createHmac('sha1', SECRET).update(url + Object.keys(params).sort().map(key => key + params[key]).join('')).digest('base64')
  return receiptPOST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': valid ? signature : 'invalid-signature' }, body: new URLSearchParams(params).toString() }))
}
async function assertTranscript(box: Row, status: string) {
  const messages = (await rows('sms_messages')).filter(row => row.outbox_id === box.id)
  expect(messages).toEqual([expect.objectContaining({ tenant_id: TENANT, conversation_id: CONV, direction: 'outbound',
    audience: 'customer', to_number: PHONE, body: box.body, delivery_status: status, twilio_message_sid: box.provider_sid })])
}
function scenario(name: string, run: () => Promise<Row | void>) {
  it(name, async () => { try { const result = await run(); evidence.results.push({ name, passed: true, carrierPosts: h.carrier.length, carrierReads: h.reads.length, ...result }) }
    catch (error) { evidence.results.push({ name, passed: false, error: String(error), carrierPosts: h.carrier.length }); throw error } })
}
beforeAll(async () => {
  writeFileSync(output, JSON.stringify(evidence, null, 2))
  for (const [key, value] of Object.entries({ PUBLIC_WEB_ORIGIN: WEB, APP_URL: 'https://offline-engine.invalid',
    NEXT_PUBLIC_SUPABASE_URL: 'https://offline-db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'offline-chain-only',
    TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: SECRET, TWILIO_SMS_NUMBER: '+61499999999', TWILIO_PHONE_NUMBER: '+61499999999',
    SMS_QUOTE_PDF_MMS: '0', FULL_QUOTE_DOC: 'false', GOOGLE_MAPS_API_KEY: '', TENANT_FILESTORE_ENABLED: 'false',
  })) vi.stubEnv(key, value)
  db = await createSmsFinalChainFixture(APP, h); h.client = db.client
  h.tenant = { id: TENANT, business_name: 'Offline Chain Tradie', twilio_sms_number: FROM, state: 'NSW',
    stripe_connect_account_id: 'acct_offline', stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true }
  await db.seed('tenants', [h.tenant])
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), base = `/2010-04-01/Accounts/${ACCOUNT}/Messages`
    if (url.origin !== 'https://api.twilio.com' || init?.headers == null ||
        new Headers(init.headers).get('authorization') !== 'Basic ' + Buffer.from(`${ACCOUNT}:${SECRET}`).toString('base64')) {
      h.unexpected.push('Unexpected HTTP destination/auth'); throw new Error('Unexpected HTTP')
    }
    if (init.method === 'POST' && url.pathname === base + '.json') {
      const form = new URLSearchParams(String(init.body)), callback = form.get('StatusCallback')!
      expect(form.get('To')).toBe(PHONE); expect(form.get('From')).toBe(FROM); expect(form.has('MediaUrl')).toBe(false)
      const cb = new URL(callback); expect(cb.origin).toBe(WEB); expect(cb.pathname).toBe('/api/sms/status')
      const box = (await rows('sms_outbox')).find(row => row.id === cb.searchParams.get('outbox'))!
      expect(box).toMatchObject({ status: 'sending', attempt_token: cb.searchParams.get('attempt'), tenant_id: TENANT, conversation_id: CONV, body: form.get('Body') })
      const sid = `SM${String(h.carrier.length + 1).padStart(32, '0')}`
      h.carrier.push({ to: PHONE, from: FROM, text: form.get('Body')!, callback, sid, mode: h.mode })
      if (h.mode === 'unreadable') {
        return new Response(new ReadableStream({ start(controller) {
          controller.error(new Error('Injected response body loss'))
        } }), { status: 201 })
      }
      return Response.json(h.mode === 'missing-sid' ? { status: 'queued' } : { sid, status: 'queued', to: PHONE }, { status: 201 })
    }
    if ((!init.method || init.method === 'GET') && url.pathname.startsWith(base + '/') && url.pathname.endsWith('.json')) {
      const sid = url.pathname.slice((base + '/').length, -5); expect(h.carrier.some(call => call.sid === sid)).toBe(true)
      h.reads.push(sid)
      if (h.readMode === 'timeout') throw new DOMException('Injected bounded carrier read timeout', 'TimeoutError')
      if (h.readMode === 'failed') return Response.json({ error: 'Unavailable' }, { status: 503 })
      return Response.json({ sid, status: h.readMode, error_code: null })
    }
    h.unexpected.push('Unexpected HTTP operation'); throw new Error('Unexpected HTTP operation')
  })
}, 30000)
beforeEach(async () => {
  await db.pg.exec('truncate quotes,intakes,sms_conversations,sms_outbox,sms_messages,pricing_book,quote_pricing_versions,quote_followup_events cascade')
  h.carrier.length = 0; h.reads.length = 0; h.rpcCalls.length = 0; h.mode = 'accepted'; h.readMode = 'delivered'
})
afterAll(async () => {
  try { expect(h.unexpected).toEqual([]); for (const [path, expected] of Object.entries(evidence.sourceHashes)) expect(hash(path), path).toBe(expected)
    evidence.completed = evidence.results.length === 9 && evidence.results.every(row => row.passed)
  } finally { writeFileSync(output, JSON.stringify({ ...evidence, unexpected: h.unexpected }, null, 2)); await db?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }
})

describe('joined final creation, owner release, inspection credit, balance and signed delivery', () => {
  for (const [trade, gst] of [['electrical', false], ['plumbing', true]] as const) scenario(`${trade}: actual 214 → 215 → 217 → 213 preserves one priced chain and canonical customer links`, async () => {
    const built = await prepare(trade, gst), saved = built.final
    expect((await send(saved, false)).status).toBe(401)
    expect((await send(saved, true, 'f'.repeat(64))).status).toBe(409)
    expect(await rows('sms_outbox')).toHaveLength(0)
    const response = await send(saved), sent = await response.json()
    expect(response.status, JSON.stringify(sent)).toBe(200)
    expect(sent).toMatchObject({ approved: true, accepted: true, deposit_covered_by_credit: true, credit_settlement: { status: 'settled' } })
    const final = await quote(String(saved.id)), [finalBox] = await rows('sms_outbox')
    expect(final).toMatchObject({ paid_tier: 'credit', paid_amount_cents: 0, paid_stripe_session_id: null, pricing_book_version_id: built.versionId, total_inc_gst: built.total })
    expect(final.paid_at).toBeTruthy(); expect(final.customer_released_at).toBeTruthy()
    expect((finalBox.payload as Row).quoteReleaseSnapshot).toEqual(quoteCustomerReleaseSnapshot(saved))
    expect(finalBox.body).toContain(`${WEB}/q/${saved.share_token}`)
    expect(finalBox.body).toContain('site visit covers the deposit - nothing to pay now')
    expect(finalBox.body).not.toContain(`/r/${saved.share_token}/deposit`)
    expect(await readQuoteCreditSettlement(db.client, String(saved.id), TENANT)).toMatchObject({ status: 'settled', quote_id: saved.id })
    expect(await page(String(saved.share_token))).toContain(built.total.toFixed(2))
    const balanceRequest = () => requestBalance(req(`/api/quote/${saved.id}/request-final-payment`, { requestId: REQUEST,
      expected_recipient: PHONE, expected_revision: quoteCustomerReleaseRevision(final) }), { params: Promise.resolve({ id: String(saved.id) }) })
    const balanceResponse = await balanceRequest(), balanceResult = await balanceResponse.json()
    expect(balanceResponse.status, JSON.stringify(balanceResult)).toBe(200)
    const balance = (await rows('quotes')).find(row => row.quote_kind === 'balance')!
    expect(balance).toMatchObject({ parent_quote_id: saved.id, pricing_book_version_id: built.versionId, total_inc_gst: Math.round((built.total - 99) * 100) / 100 })
    const balanceBox = (await rows('sms_outbox')).find(row => row.delivery_key === genericQuoteSendKey(String(balance.id), REQUEST))!
    expect(balanceBox.body).toContain(`${WEB}/r/${balance.share_token}/balance`)
    // The stored balance excludes the established 2% platform fee; the public
    // payable CTA includes that fee and retains cents (205.03 / 179.53).
    const finalPage = await page(String(saved.share_token))
    expect(finalPage).toContain(gst ? '179.53' : '205.03')
    expect(finalPage).toContain(`/r/${balance.share_token}/balance`)
    await expect(page(String(balance.share_token))).rejects.toThrow(`REDIRECT:/q/${saved.share_token}`)
    await expect(page(String(built.original.share_token))).rejects.toThrow(`REDIRECT:/q/${saved.share_token}`)
    const snapshot = await rows('quotes'), before = h.carrier.length
    expect((await balanceRequest()).status).toBe(200)
    const read = await readBalance(req(`/api/quote/${saved.id}/request-final-payment?requestId=${REQUEST}`), { params: Promise.resolve({ id: String(saved.id) }) })
    expect(await read.json()).toMatchObject({ status: 'accepted', outboxId: balanceBox.id, quoteId: balance.id })
    expect(h.carrier).toHaveLength(before); expect(await rows('quotes')).toEqual(snapshot)
    const turnId = randomUUID(), resend = () => withSmsDeliveryContext({ tenantId: TENANT, conversationId: CONV, turnId }, async () => {
      const action = await handleExistingQuoteAction({ supabase: db.client, tenantId: TENANT, customerPhone: PHONE, text: 'quote link again',
        preferredReference: { family: 'generic', id: String(balance.id) } })
      expect(action).toMatchObject({ handled: true, reference: { id: balance.id, stage: 'ready' } })
      expect(action.reply).toContain(`${WEB}/q/${balance.share_token}`)
      return dispatchQuoteMessage({ tenantId: TENANT, to: PHONE, from: FROM, audience: 'customer', text: action.reply! })
    })
    const resent = await resend(); expect(resent.ok).toBe(true); expect((await resend()).outboxId).toBe(resent.outboxId)
    for (const attempt of h.carrier) expect((await signed(attempt, 'delivered')).status).toBe(204)
    expect(await delivery(String(saved.id))).toMatchObject({ status: 'delivered', outboxId: finalBox.id })
    const boxes = await rows('sms_outbox'); expect(boxes).toHaveLength(3); expect(h.carrier).toHaveLength(3)
    for (const box of boxes) await assertTranscript(box, 'delivered')
    expect(await quote(ROOT)).toEqual(built.original); expect(await rows('quotes')).toEqual(snapshot)
    return { trade, totalCents: Math.round(built.total * 100), balanceCents: Math.round(Number(balance.total_inc_gst) * 100), finalId: saved.id,
      balanceId: balance.id, finalToken: saved.share_token, balanceToken: balance.share_token, pricingVersionId: built.versionId, outboxes: boxes.map(box => box.id) }
  })

  scenario('signed queued → delivered, duplicate, out-of-order and legacy SmsStatus retain one transcript', async () => {
    const { final } = await prepare(); expect((await send(final)).status).toBe(200)
    const attempt = h.carrier[0]
    for (const [status, legacy] of [['queued', false], ['delivered', true], ['delivered', false], ['sent', false], ['undelivered', false]] as const)
      expect((await signed(attempt, status, {}, legacy)).status).toBe(204)
    const [box] = await rows('sms_outbox'); expect(box).toMatchObject({ status: 'delivered', provider_status: 'delivered', requires_attention: false })
    expect(await delivery(String(final.id))).toMatchObject({ status: 'delivered' }); await assertTranscript(box, 'delivered'); expect(h.carrier).toHaveLength(1)
  })
  scenario('signed non-delivery is visible; explicit owner recovery replaces only the attempt and ignores its stale callback', async () => {
    const { final } = await prepare(); expect((await send(final)).status).toBe(200)
    const old = h.carrier[0]; expect((await signed(old, 'undelivered', { ErrorCode: '30003' })).status).toBe(204)
    const [box] = await rows('sms_outbox'); expect(box).toMatchObject({ status: 'undelivered', requires_attention: true, provider_error: '30003' })
    expect(await delivery(String(final.id))).toMatchObject({ status: 'undelivered' }); await assertTranscript(box, 'undelivered')
    expect((await deliveryRetry(req('/api/tenant/sms-delivery', { id: box.id }))).status).toBe(200)
    expect(await recoverSmsOutbox()).toMatchObject({ attempted: 1 }); expect(h.carrier).toHaveLength(2)
    expect(h.carrier[1].text).toBe(old.text); expect(h.carrier[1].callback).not.toBe(old.callback)
    expect((await signed(old, 'delivered')).status).toBe(409)
    expect((await signed(h.carrier[1], 'delivered')).status).toBe(204)
    const [recovered] = await rows('sms_outbox'); expect(recovered.id).toBe(box.id); await assertTranscript(recovered, 'delivered')
  })
  scenario('invalid signature, account, SID and attempt cannot mutate the saved delivery', async () => {
    const { final } = await prepare(); await send(final); const attempt = h.carrier[0], before = await rows('sms_outbox')
    expect((await signed(attempt, 'delivered', {}, false, attempt.callback, false)).status).toBe(403)
    expect((await signed(attempt, 'delivered', { AccountSid: `AC${'2'.repeat(32)}` })).status).toBe(403)
    expect((await signed(attempt, 'delivered', { MessageSid: `SM${'2'.repeat(32)}` })).status).toBe(409)
    const wrong = new URL(attempt.callback); wrong.searchParams.set('attempt', randomUUID())
    expect((await signed(attempt, 'delivered', {}, false, wrong.href)).status).toBe(409)
    expect(await rows('sms_outbox')).toEqual(before); await assertTranscript(before[0], 'accepted')
  })
  for (const failure of ['timeout', 'failed']) scenario(`stale accepted SID ${failure} remains visible without another send`, async () => {
    const { final } = await prepare(); await send(final); h.readMode = failure
    await db.pg.exec("update sms_outbox set updated_at=now()-interval '10 minutes'")
    expect(await recoverSmsOutbox()).toEqual({ attempted: 0, reconciled: 0 })
    const [box] = await rows('sms_outbox'); expect(box).toMatchObject({ status: 'accepted', requires_attention: true })
    expect(h.reads).toHaveLength(1); expect(h.carrier).toHaveLength(1); await assertTranscript(box, 'accepted')
    h.readMode = 'delivered'; await db.pg.exec("update sms_outbox set updated_at=now()-interval '10 minutes'")
    expect(await recoverSmsOutbox()).toEqual({ attempted: 0, reconciled: 1 })
    expect(await delivery(String(final.id))).toMatchObject({ status: 'delivered' }); expect(h.carrier).toHaveLength(1)
  })
  for (const mode of ['unreadable', 'missing-sid']) scenario(`HTTP 201 ${mode} is retained without auto-resend; a matching signed receipt supplies the missing SID`, async () => {
    const { final } = await prepare(); h.mode = mode
    const response = await send(final), body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ accepted: true, credit_settlement: { status: 'pending' } })
    let [box] = await rows('sms_outbox'); expect(box).toMatchObject({ status: 'accepted', provider_sid: null })
    expect((await quote(String(final.id))).paid_at).toBeNull()
    await db.pg.exec("update sms_outbox set updated_at=now()-interval '10 minutes'")
    expect(await recoverSmsOutbox()).toEqual({ attempted: 0, reconciled: 0 })
    expect((await deliveryRetry(req('/api/tenant/sms-delivery', { id: box.id }))).status).toBe(409)
    expect(h.carrier).toHaveLength(1); expect(h.reads).toHaveLength(0)
    expect((await signed(h.carrier[0], 'delivered')).status).toBe(204)
    ;[box] = await rows('sms_outbox'); expect(box).toMatchObject({ status: 'delivered', provider_sid: h.carrier[0].sid })
    expect((await quote(String(final.id))).paid_tier).toBe('credit'); await assertTranscript(box, 'delivered')
  })
})
