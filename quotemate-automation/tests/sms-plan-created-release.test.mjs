import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPlanReleaseFixture } from '../scripts/sms-plan-created-release-fixture.mjs'

const h = await vi.hoisted(async () => {
  const state = { client: null, tenant: null, carrier: [], unexpected: [], pdfs: new Map(), uploads: [], downloads: [],
    modelCalls: [], pricingCalls: [], inputBytes: null }
  // Install before application/SDK imports so cached transport references also
  // point to the denial. Vitest's already-open IPC and local PGlite need no TCP.
  const [http, https, net, tls, dgram, module] = await Promise.all([
    import('node:http'), import('node:https'), import('node:net'), import('node:tls'), import('node:dgram'), import('node:module'),
  ])
  const originals = []
  const patch = (object, key, label) => {
    originals.push([object, key, Object.getOwnPropertyDescriptor(object, key)])
    Object.defineProperty(object, key, { configurable: true, writable: true, value: () => {
      state.unexpected.push(label); throw new Error(`Unexpected external transport: ${label}`)
    } })
  }
  for (const [object, keys, label] of [
    [http.default, ['request','get'], 'HTTP'], [https.default, ['request','get'], 'HTTPS'],
    [net.default, ['connect','createConnection'], 'TCP'], [net.default.Socket.prototype, ['connect'], 'Socket'],
    [tls.default, ['connect'], 'TLS'], [dgram.default, ['createSocket'], 'UDP'], [globalThis, ['fetch'], 'fetch'],
  ]) for (const key of keys) patch(object, key, `${label}.${key}`)
  module.syncBuiltinESMExports()
  return { ...state, restoreNetwork() {
    for (const [object, key, descriptor] of originals.reverse()) {
      if (descriptor) Object.defineProperty(object, key, descriptor)
      else delete object[key]
    }
    module.syncBuiltinESMExports()
  } }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (...args) => h.client.from(...args),
  rpc: (...args) => h.client.rpc(...args), storage: { from: (...args) => h.client.storage.from(...args) } }) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async (_db, request) => {
  if (request.headers.get('authorization') !== 'Bearer offline-plan-owner') return null
  return { tenant: h.tenant, identity: { provider: 'clerk', userId: 'offline-plan-owner' } }
} }))
vi.mock('@/lib/estimation/auth', () => ({ tenantFromBearer: async request =>
  request.headers.get('authorization') === 'Bearer offline-plan-owner' ? h.tenant : null,
  estimatorSupabase: { from: (...args) => h.client.from(...args), rpc: (...args) => h.client.rpc(...args) } }))
// Extraction is the sole model/provider seam. Actual stored PDF bytes must be
// passed into it. No generated extraction or priced result is inserted by tests.
vi.mock('@/lib/estimation/extract', () => ({ runExtraction: async options => {
  h.modelCalls.push({ sha256: createHash('sha256').update(options.pdf).digest('hex'), sheetHint: options.sheetHint })
  expect(Buffer.from(options.pdf)).toEqual(h.inputBytes)
  return { parsed: { items: [{ type: 'Double power point', count: 2, confidence: 'high', note: 'Two symbols in the provider fixture' }],
    sheets_used: ['E1'], overall_note: 'Local provider fixture' }, model: 'offline-extraction-fixture', runtimeSeconds: 0.1 }
} }))
vi.mock('@/lib/estimation/pricing-context', async original => { const actual = await original(); return { ...actual,
  priceElectricalTakeoff: (...args) => { const bom = actual.priceElectricalTakeoff(...args); h.pricingCalls.push(bom); return bom } } })
vi.mock('@/lib/sms/twilio', () => ({ sendSms: async options => {
  const sid = `SM${String(h.carrier.length + 1).padStart(32, '0')}`
  h.carrier.push({ ...options, sid }); return { ok: true, sid, status: 'queued' }
}, sendWhatsApp: async () => { h.unexpected.push('WhatsApp'); throw new Error('Unexpected WhatsApp') },
readTwilioMessage: async () => { h.unexpected.push('carrier-reconciliation'); throw new Error('Unexpected reconciliation') } }))
vi.mock('@/lib/pdf/branding', () => ({ loadTenantBranding: async () => ({ businessName: 'Offline plan electrician' }) }))
vi.mock('@/lib/pdf/gotenberg', () => ({ gotenbergConfigured: () => false,
  renderPdfFromHtml: async () => { h.unexpected.push('PDF-renderer'); throw new Error('Unexpected renderer') } }))
vi.mock('next/server', () => ({ after: () => { h.unexpected.push('post-response-work'); throw new Error('Unexpected post-response work') } }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/q/plan/offline', useRouter: () => ({}), useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NOT_FOUND') }, redirect: url => { throw new Error(`REDIRECT:${url}`) } }))
vi.mock('@/lib/auth/client-token', () => ({ getAuthToken: async () => null }))
vi.mock('@/app/q/_chrome/TradieJobBanner', () => ({ TradieJobBanner: () => null }))
vi.mock('@/app/q/_chrome/TradieDashboardPill', () => ({ TradieDashboardPill: () => null }))

import { POST as uploadPlan } from '@/app/api/upload/plan/[token]/route'
import { handlePlanAnalysis } from '@/lib/estimation/plan-work'
import { runSmsWorkBatch } from '@/lib/sms/durable-work'
import { PATCH as confirmQuantities } from '@/app/api/tenant/estimator/extract/[id]/route'
import { POST as priceConfirmedPlan } from '@/app/api/tenant/estimator/price/route'
import { GET as reviewPlan, POST as approvePlan } from '@/app/api/sms/quote-release/route'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { handleExistingQuoteAction } from '@/lib/sms/quote-actions'
import { withSmsDeliveryContext } from '@/lib/sms/delivery-context'
import PlanPage from '@/app/q/plan/[token]/page'

const app = fileURLToPath(new URL('../', import.meta.url))
const WEBSITE = 'https://quotemax.com.au', TENANT = '11111111-1111-4111-8111-111111111111'
const REQUEST = '22222222-2222-4222-8222-222222222222', CONVERSATION = '33333333-3333-4333-8333-333333333333'
const BOOK = '44444444-4444-4444-8444-444444444444', ASSEMBLY = '55555555-5555-4555-8555-555555555555'
const CUSTOMER = '+61411111181', SENDER = '+61488888888', OWNER = '+61499999999', UPLOAD_TOKEN = 'offline-plan-upload-token'
const output = join(app, '../docs/audits/2026-09-09-sms-plan-created-release.json')
const tracked = ['tests/sms-plan-created-release.test.mjs', 'scripts/sms-plan-created-release-fixture.mjs', 'scripts/vitest-sms-plan-created-release.config.mjs',
  'scripts/sms-owner-release-fixture.mjs', 'scripts/sms-route-fixture-db.mjs', 'app/api/upload/plan/[token]/route.ts',
  'lib/estimation/plan-work.ts', 'lib/estimation/sms-run.ts', 'lib/estimation/pricing-context.ts', 'lib/estimation/price.ts',
  'app/api/tenant/estimator/extract/[id]/route.ts', 'app/api/tenant/estimator/price/route.ts', 'lib/filestore/provision.ts',
  'lib/storage/plan-pdf.ts', 'lib/sms/durable-work.ts', 'lib/sms/durable-outbox.ts', 'lib/sms/human-handoff.ts', 'lib/sms/dispatch.ts',
  'lib/sms/quote-origin-conversation.ts', 'lib/sms/quote-actions.ts', 'lib/sms/quote-review.ts', 'app/api/sms/quote-release/route.ts', 'app/q/plan/[token]/page.tsx',
  ...['198_sms_durable_work.sql','199_sms_delivery_outbox.sql','201_sms_trade_quote_contract.sql','202_job_quote_operations.sql',
    '205_generic_quote_customer_release.sql','207_quote_pricing_versions.sql','210_sms_plan_work.sql','211_commercial_quote_release_guard.sql',
    '212_plan_quote_release_guard.sql','215_generic_release_snapshot.sql','217_final_quote_credit_settlement.sql'].map(name => `sql/migrations/${name}`)]
const hash = path => createHash('sha256').update(readFileSync(join(app, path))).digest('hex')
const evidence = { completed: false, results: [], failedTests: [], sourceHashes: Object.fromEntries(tracked.map(path => [path, hash(path)])),
  limits: ['Actual multipart upload, migration210 receipt/fenced worker, electrical loader/pricer, saved extraction, human task, owner quantity PATCH/reprice/release201, public page and outbox/reference paths share local rows.',
    'Only an existing owned upload invitation/conversation, tenant rate book and assembly are seeded; extraction and priced BOM are created by actual worker code.',
    'Model extraction response, private storage service, PDF branding, verified owner identity and carrier acceptance are fixtures. Actual storage wrapper round-trips the uploaded bytes.',
    'No PDF report generation, filestore, browser-only overlays, live model/provider, production PostgREST/RLS, original SMS upload invitation or actual carrier delivery.',
    'Single local PGlite connection; no multiconnection contention or process kill. Named source hashes are not the entire import closure.'] }
let db
const ownerRequest = (path, body) => new Request(`${WEBSITE}${path}`, { method: body ? 'POST' : 'GET',
  headers: { authorization: 'Bearer offline-plan-owner', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
const submit = () => {
  const form = new FormData(); form.set('pdf', new File([h.inputBytes], 'customer-plan.pdf', { type: 'application/pdf' }))
  return uploadPlan(new Request(`${WEBSITE}/api/upload/plan/${UPLOAD_TOKEN}`, { method: 'POST', body: form }), { params: Promise.resolve({ token: UPLOAD_TOKEN }) })
}
const load = async (table, id) => { const result = await db.client.from(table).select('*').eq('id', id).single(); expect(result.error).toBeNull(); return result.data }
const rows = async table => { const result = await db.client.from(table).select('*'); expect(result.error).toBeNull(); return result.data }
const publicText = async token => renderToStaticMarkup(await PlanPage({ params: Promise.resolve({ token }) })).replace(/<[^>]*>/g, ' ')
async function assertTranscript(outboxId, conversationId) {
  const intent = await load('sms_outbox', outboxId)
  expect(intent).toMatchObject({ tenant_id: TENANT, status: 'accepted', audience: 'customer', to_number: CUSTOMER,
    conversation_id: conversationId, payload: { tenantId: TENANT, from: SENDER, to: CUSTOMER } })
  const messages = (await rows('sms_messages')).filter(row => row.outbox_id === outboxId)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ tenant_id: TENANT, audience: 'customer', to_number: CUSTOMER,
    conversation_id: conversationId, body: intent.payload.text,
    twilio_message_sid: intent.provider_sid, delivery_status: 'accepted' })
  return messages[0].id
}
async function resend(extraction, conversationId) {
  const turnId = randomUUID(), before = h.carrier.length
  const action = () => withSmsDeliveryContext({ tenantId: TENANT, conversationId, turnId }, async () => {
    const reply = await handleExistingQuoteAction({ supabase: db.client, tenantId: TENANT, customerPhone: CUSTOMER, text: 'Please send the quote link again' })
    expect(reply.reference).toMatchObject({ family: 'plan', id: extraction.id, token: extraction.share_token, stage: 'ready' })
    const sent = await dispatchQuoteMessage({ tenantId: TENANT, from: SENDER, to: CUSTOMER, text: reply.reply })
    expect(sent.ok).toBe(true); return sent
  })
  const sent = await action(); expect((await action()).outboxId).toBe(sent.outboxId)
  expect(h.carrier).toHaveLength(before + 1)
  return { outboxId: sent.outboxId, conversationId, transcriptId: await assertTranscript(sent.outboxId, conversationId) }
}

beforeAll(async () => {
  writeFileSync(output, JSON.stringify(evidence, null, 2))
  vi.stubEnv('PUBLIC_WEB_ORIGIN', WEBSITE); vi.stubEnv('APP_URL', 'https://offline-engine.invalid'); vi.stubEnv('ENGINE_BASE_URL', 'https://offline-engine.invalid')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://offline-db.invalid'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'offline-plan-key')
  vi.stubEnv('SMS_WORKER_SERVICE', 'platform'); vi.stubEnv('SMS_QUOTE_PDF_MMS', '0'); vi.stubEnv('TENANT_FILESTORE_ENABLED', 'false')
  vi.stubEnv('ESTIMATOR_CHATBOT_ENABLED', 'false')
  vi.stubGlobal('fetch', async () => { h.unexpected.push('fetch'); throw new Error('Unexpected external fetch') })
  h.inputBytes = Buffer.from('%PDF-1.7\nOffline plan extraction boundary fixture\n%%EOF')
  db = await createPlanReleaseFixture(app, h); h.client = db.client
  h.tenant = { id: TENANT, business_name: 'Offline plan electrician', trade: 'electrical', owner_mobile: OWNER, twilio_sms_number: SENDER }
  await db.seed('tenants', [h.tenant])
  await db.seed('sms_conversations', [{ id: CONVERSATION, tenant_id: TENANT, from_number: CUSTOMER, to_number: SENDER, status: 'open', conversation_type: 'customer_quote' }])
  await db.seed('plan_upload_requests', [{ id: REQUEST, token: UPLOAD_TOKEN, tenant_id: TENANT, sms_conversation_id: CONVERSATION,
    customer_phone: CUSTOMER, twilio_number: SENDER, status: 'awaiting_upload', expires_at: '2099-01-01T00:00:00Z' }])
  await db.seed('pricing_book', [{ id: BOOK, tenant_id: TENANT, trade: 'electrical', hourly_rate: 120, default_markup_pct: 0, min_labour_hours: 0, gst_registered: true }])
  await db.seed('tenant_custom_assemblies', [{ id: ASSEMBLY, tenant_id: TENANT, trade: 'electrical', enabled: true,
    name: 'Double power point', category: 'power_points', default_unit_price_ex_gst: 50, default_labour_hours: 0.5, default_unit: 'each' }])
}, 20000)
afterAll(async () => {
  try {
    for (const [path, expected] of Object.entries(evidence.sourceHashes)) expect(hash(path)).toBe(expected)
    expect(h.unexpected).toEqual([])
    for (const sent of h.carrier) for (const url of sent.text.match(/https?:\/\/[^\s<>()]+/g) ?? []) expect(new URL(url.replace(/[.,;:!?]+$/, '')).origin).toBe(WEBSITE)
    evidence.completed = evidence.results.length === 1 && evidence.failedTests.length === 0
  } finally {
    if (db) await db.close()
    Object.assign(evidence, { generatedAt: new Date().toISOString(), carrierCalls: h.carrier.length, modelCalls: h.modelCalls,
      pricingCalls: h.pricingCalls.length, storageUploads: h.uploads, storageDownloads: h.downloads, unexpected: h.unexpected })
    writeFileSync(output, JSON.stringify(evidence, null, 2)); vi.unstubAllEnvs(); vi.unstubAllGlobals(); h.restoreNetwork()
  }
})

it('actual plan upload → durable worker → priced held extraction → owner release → public access and stable resends', async () => {
  try {
    expect(await rows('plan_extractions')).toEqual([])
    const first = await submit(); expect(first.status).toBe(202)
    const receipt = await first.json(), duplicate = await submit()
    expect(duplicate.status).toBe(202); expect((await duplicate.json()).jobId).toBe(receipt.jobId)
    const queued = await load('sms_work_jobs', receipt.jobId), uploadedRequest = await load('plan_upload_requests', REQUEST)
    expect(queued).toMatchObject({ kind: 'plan', status: 'pending', tenant_id: TENANT, serial_key: `plan:${REQUEST}` })
    expect(uploadedRequest).toMatchObject({ status: 'analysing', analysis_work_id: receipt.jobId, input_sha256: createHash('sha256').update(h.inputBytes).digest('hex') })
    expect(await rows('plan_uploads')).toHaveLength(1); expect(h.pdfs.size).toBe(1); expect(h.carrier).toHaveLength(0)
    expect(await runSmsWorkBatch({ plan: handlePlanAnalysis }, { db: db.client, limit: 1 })).toEqual([{ id: receipt.jobId, ok: true }])
    const finished = await load('sms_work_jobs', receipt.jobId), request = await load('plan_upload_requests', REQUEST)
    expect(finished.status).toBe('completed'); expect(request.status).toBe('complete')
    const extraction = await load('plan_extractions', request.plan_extraction_id)
    expect(extraction).toMatchObject({ tenant_id: TENANT, plan_upload_id: uploadedRequest.plan_upload_id, released_at: null,
      sms_source_key: `plan:${REQUEST}:${request.input_sha256}` })
    expect(extraction.priced_bom).toMatchObject({ totalIncGst: 242, pricingComplete: true,
      pricingAuthority: { tenant_id: TENANT, trade: 'electrical', pricing_book_id: BOOK, source: 'tenant_pricing_book' } })
    expect(extraction.priced_bom.lines[0]).toMatchObject({ count: 2, matched: 'Double power point', unitPriceExGst: 50, labourHours: 1 })
    expect(h.modelCalls).toHaveLength(1); expect(h.pricingCalls).toHaveLength(1); expect(h.downloads).toHaveLength(1)
    expect(await rows('plan_extractions')).toHaveLength(1)
    const tasks = await rows('sms_human_tasks')
    expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ tenant_id: TENANT, conversation_id: CONVERSATION,
      customer_phone: CUSTOMER, resource_type: 'plan', resource_id: extraction.id, status: 'notified' })
    expect(h.carrier).toHaveLength(2); expect(h.carrier.filter(sent => sent.to === OWNER)).toHaveLength(1)
    const statusIntent = (await rows('sms_outbox')).find(row => row.payload.audience !== 'tradie' && row.payload.to === CUSTOMER)
    expect(statusIntent.payload.text).toMatch(/saved.*review and approve.*awaiting approval/i)
    expect(statusIntent.payload.text).not.toMatch(/\$242|on (?:its|the) way|send.*shortly/i)
    const statusTranscriptId = await assertTranscript(statusIntent.id, CONVERSATION)
    const held = await publicText(extraction.share_token)
    expect(held).toMatch(/review|approval/i); expect(held).not.toContain('$242.00')
    const initialReview = await (await reviewPlan(ownerRequest(`/api/sms/quote-release?family=plan&id=${extraction.id}`))).json()
    expect(initialReview.review.canApprove).toBe(false)
    const confirmation = await confirmQuantities(new Request(`${WEBSITE}/api/tenant/estimator/extract/${extraction.id}`, {
      method: 'PATCH', headers: { authorization: 'Bearer offline-plan-owner', 'content-type': 'application/json' },
      body: JSON.stringify({ corrected_items: extraction.items }),
    }), { params: Promise.resolve({ id: extraction.id }) })
    expect(confirmation.status).toBe(200)
    const confirmed = await load('plan_extractions', extraction.id)
    expect(confirmed).toMatchObject({ id: extraction.id, share_token: extraction.share_token, released_at: null, priced_bom: null })
    expect(confirmed.corrected_items).toHaveLength(1)
    expect(confirmed.corrected_items[0]).toMatchObject({ type: 'Double power point', count: 2 })
    const repriced = await priceConfirmedPlan(ownerRequest('/api/tenant/estimator/price', { extractionId: extraction.id, items: confirmed.corrected_items }))
    expect(repriced.status).toBe(200)
    const ownerPriced = await load('plan_extractions', extraction.id)
    expect(ownerPriced).toMatchObject({ id: extraction.id, share_token: extraction.share_token, released_at: null })
    expect(ownerPriced.priced_bom).toEqual(extraction.priced_bom)
    expect(h.pricingCalls).toHaveLength(2)
    expect(await publicText(extraction.share_token)).not.toContain('$242.00')
    const reviewResponse = await reviewPlan(ownerRequest(`/api/sms/quote-release?family=plan&id=${extraction.id}`))
    expect(reviewResponse.status).toBe(200); const review = (await reviewResponse.json()).review
    expect(review.canApprove).toBe(true)
    const approval = await approvePlan(ownerRequest('/api/sms/quote-release', { family: 'plan', id: extraction.id, approve: true, reviewVersion: review.version }))
    expect(approval.status).toBe(200); const accepted = await approval.json()
    const approvalTranscriptId = await assertTranscript(accepted.outboxId, CONVERSATION)
    const approved = await load('plan_extractions', extraction.id)
    expect(approved.released_at).toBeTruthy(); expect(approved.priced_bom).toEqual(extraction.priced_bom)
    expect(accepted.url).toBe(`${WEBSITE}/q/plan/${extraction.share_token}`)
    expect(await publicText(extraction.share_token)).toContain('$242.00')
    const freshReview = await (await reviewPlan(ownerRequest(`/api/sms/quote-release?family=plan&id=${extraction.id}`))).json()
    const repeatedApproval = await approvePlan(ownerRequest('/api/sms/quote-release', { family: 'plan', id: extraction.id, approve: true, reviewVersion: freshReview.review.version }))
    expect(repeatedApproval.status).toBe(200); expect((await repeatedApproval.json()).outboxId).toBe(accepted.outboxId)
    expect(h.carrier).toHaveLength(3)
    const sameConversation = await resend(extraction, CONVERSATION), nextConversation = randomUUID()
    await db.seed('sms_conversations', [{ id: nextConversation, tenant_id: TENANT, from_number: CUSTOMER, to_number: SENDER,
      status: 'done', conversation_type: 'customer_quote' }])
    const newConversation = await resend(extraction, nextConversation)
    await db.pg.query('update pricing_book set hourly_rate=999 where id=$1', [BOOK])
    const completedUploadReplay = await submit(); expect(completedUploadReplay.status).toBe(200)
    expect(await completedUploadReplay.json()).toEqual({ ok: true, alreadyDone: true })
    expect(await runSmsWorkBatch({ plan: handlePlanAnalysis }, { db: db.client, limit: 1 })).toEqual([])
    expect(h.modelCalls).toHaveLength(1); expect(h.pricingCalls).toHaveLength(2); expect(h.carrier).toHaveLength(5)
    expect(await load('plan_extractions', extraction.id)).toEqual(approved)
    expect(await rows('sms_work_jobs')).toHaveLength(1); expect(await rows('plan_extractions')).toHaveLength(1); expect(await rows('plan_uploads')).toHaveLength(1)
    expect(await rows('sms_human_tasks')).toEqual(tasks)
    const intents = await rows('sms_outbox')
    expect(intents).toHaveLength(5)
    expect(new Set(intents.map(row => row.provider_sid)).size).toBe(5)
    for (const intent of intents) {
      const recipient = intent.audience === 'tradie' ? OWNER : CUSTOMER
      expect(intent).toMatchObject({ tenant_id: TENANT, status: 'accepted', to_number: recipient,
        payload: { tenantId: TENANT, from: SENDER, to: recipient } })
      const calls = h.carrier.filter(sent => sent.sid === intent.provider_sid)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ from: SENDER, to: recipient, text: intent.payload.text })
    }
    evidence.results.push({ passed: true, requestId: REQUEST, workId: receipt.jobId, uploadId: uploadedRequest.plan_upload_id,
      extractionId: extraction.id, token: extraction.share_token, totalIncGst: extraction.priced_bom.totalIncGst,
      ownerTaskId: tasks[0].id, statusOutboxId: statusIntent.id, statusTranscriptId, approvalOutboxId: accepted.outboxId,
      approvalTranscriptId, sameConversation, newConversation })
  } catch (error) { evidence.failedTests.push(String(error)); throw error }
}, 20000)
