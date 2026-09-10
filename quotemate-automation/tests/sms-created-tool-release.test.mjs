import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { renderToStaticMarkup } from 'react-dom/server'
import { createToolReleaseFixture } from '../scripts/sms-created-tool-release-fixture.mjs'

const h = vi.hoisted(() => ({ client: null, tenant: null, carrier: [], unexpected: [], pdfs: new Map(), downloads: [],
  locationCalls: 0, airconPrices: 0, paintPrices: 0, paintOutputs: [] }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (...args) => h.client.from(...args),
  rpc: (...args) => h.client.rpc(...args), storage: { from: (...args) => h.client.storage.from(...args) } }) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => ({
  tenant: h.tenant, identity: { provider: 'clerk', userId: 'user_offline' } }) }))
vi.mock('@/lib/estimation/auth', () => ({ tenantFromBearer: async () => h.tenant,
  estimatorSupabase: { from: (...args) => h.client.from(...args),rpc: (...args) => h.client.rpc(...args) } }))
vi.mock('@/lib/aircon/location', () => ({ resolveAcLocationEvidence: async () => { h.locationCalls++; return { building: { ok: false } } } }))
vi.mock('@/lib/aircon/recommend', async original => { const actual = await original(); return { ...actual,
  recommendAircon: (...args) => { h.airconPrices++; return actual.recommendAircon(...args) } } })
vi.mock('@/lib/commercial-painting/price', async original => { const actual = await original(); return { ...actual,
  pricePaintTakeoff: (...args) => { h.paintPrices++; const result = actual.pricePaintTakeoff(...args); h.paintOutputs.push(result); return result } } })
vi.mock('@/lib/sms/twilio', () => ({ sendSms: async options => {
  const sid = `SM${String(h.carrier.length + 1).padStart(32,'0')}`; h.carrier.push({ ...options,sid }); return { ok: true,sid,status: 'queued' }
}, sendWhatsApp: async () => { h.unexpected.push('WhatsApp'); throw new Error('Unexpected WhatsApp') },
readTwilioMessage: async () => { h.unexpected.push('reconciliation'); throw new Error('Unexpected reconciliation') } }))
vi.mock('next/server', () => ({ after: () => {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/q/fixture', useSearchParams: () => new URLSearchParams(), useRouter: () => ({}),
  notFound: () => { throw new Error('NOT_FOUND') }, redirect: value => { throw new Error(`REDIRECT:${value}`) } }))
vi.mock('@/lib/auth/client-token', () => ({ getAuthToken: async () => null }))
vi.mock('@/app/q/_chrome/TradieJobBanner', () => ({ TradieJobBanner: () => null }))
vi.mock('@/app/q/_chrome/TradieDashboardPill', () => ({ TradieDashboardPill: () => null }))
vi.mock('@/lib/pdf/branding', () => ({ loadTenantBranding: async () => ({ businessName: 'Offline tool tradie' }) }))
vi.mock('@/lib/pdf/gotenberg', () => ({ gotenbergConfigured: () => false,
  renderPdfFromHtml: async () => { h.unexpected.push('PDF-renderer'); throw new Error('No renderer') } }))

import { POST as recommend } from '@/app/api/aircon/recommend/route'
import { POST as pricePaint } from '@/app/api/tenant/commercial-painting/price/route'
import { POST as savePaint } from '@/app/api/tenant/commercial-painting/save-quote/route'
import { GET as readPaintCorrection, POST as confirmPaint } from '@/app/api/tenant/commercial-painting/run/[id]/corrections/route'
import { GET as reviewTrade, POST as approveTrade } from '@/app/api/sms/quote-release/route'
import { POST as sendGeneric } from '@/app/api/quote/[id]/send/route'
import { GET as tradeJobs } from '@/app/api/tenant/trade-jobs/route'
import { quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { handleExistingQuoteAction } from '@/lib/sms/quote-actions'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { withSmsDeliveryContext } from '@/lib/sms/delivery-context'
import AirconPage from '@/app/q/aircon/[token]/page'
import GenericPage from '@/app/q/[token]/page'
import CommercialPage from '@/app/q/commercial-paint/[token]/page'

const app = fileURLToPath(new URL('../',import.meta.url)), WEBSITE = 'https://quotemax.com.au'
const output = join(app,'../docs/audits/2026-09-09-sms-created-tool-release.json')
const TENANT = '11111111-1111-4111-8111-111111111111', OWNER = '22222222-2222-4222-8222-222222222222', TO = '+61488888888'
const RUN = 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee', EXT = 'bbbbbbbb-cccc-4ddd-aeee-ffffffffffff'
const acCard = { split: { per_head: { '2.5': 1200,'3.5': 1500,'5': 2000,'7': 2700,'8': 3200 },multi_head_discount_pct: 0.05 },
  ducted: { rate_per_kw: 1250,base_ex_gst: 4500,per_zone: 400,min_ex_gst: 8500 },gst_registered: true }
const acBody = { request_id: '55555555-5555-4555-8555-555555555555',address: { address: '12 Example St, Sydney',postcode: '2000',state: 'NSW' },
  inputs: { bedrooms: 3,bathrooms: 2,living_spaces: 2,storeys: 1,floor_area_m2: 150,ceiling_height: 'standard',insulation: 'average',current_situation: 'replacing' } }
const rateRows = [
  { kind: 'labour',code: 'labour:low_sheen:roller',label: 'Tenant labour',system: 'low_sheen',method: 'roller',coverage_m2_per_hr: 10 },
  { kind: 'material',code: 'mat:wall_low_sheen',label: 'Tenant paint',system: 'low_sheen',product: 'Tenant low sheen',spread_m2_per_l: 15,price_per_l_ex_gst: 11 },
  ...Object.entries({ height_low: 1,height_mid: 1.25,height_high: 1.4,prep_pct: 0.1,sundries_pct: 0.08,labour_rate: 95,crew_hours_per_day: 7.6,default_crew_size: 3 })
    .map(([key,value]) => ({ kind: 'modifier',code: `mod:${key}`,label: key,value })),
].map(row => ({ ...row,tenant_id: TENANT,trade: 'commercial_painting',is_default: false }))
const tracked = ['tests/sms-created-tool-release.test.mjs','scripts/sms-created-tool-release-fixture.mjs','scripts/sms-commercial-pricing-fixture.mjs','scripts/sms-owner-release-fixture.mjs','scripts/sms-route-fixture-db.mjs',
  'sql/02_stages_06_10_partial.sql','lib/quote/report-pricing.ts',
  'app/api/aircon/recommend/route.ts','lib/aircon/save-recommendation.ts','lib/aircon/recommend.ts','lib/aircon/sizing.ts','lib/aircon/pricing-context.ts',
  'app/api/tenant/commercial-painting/price/route.ts','app/api/tenant/commercial-painting/save-quote/route.ts','lib/commercial-painting/price.ts','lib/commercial-painting/rates.ts','lib/commercial-painting/saved-quote.ts','lib/commercial-painting/pricing-proof.ts',
  'app/api/tenant/commercial-painting/run/[id]/corrections/route.ts','lib/commercial-painting/correction-contract.ts','lib/commercial-painting/correction-operations.ts','lib/commercial-painting/rich-run-review.ts','lib/sms/quote-review.ts',
  'app/api/sms/quote-release/route.ts','app/api/quote/[id]/send/route.ts','app/api/tenant/trade-jobs/route.ts','lib/sms/quote-origin-conversation.ts',
  'lib/sms/quote-actions.ts','lib/sms/durable-outbox.ts','lib/quote/customer-release.ts',
  'app/q/aircon/[token]/page.tsx','app/q/[token]/page.tsx','app/q/commercial-paint/[token]/page.tsx',
  ...['107_commercial_painting.sql','198_sms_durable_work.sql','199_sms_delivery_outbox.sql','201_sms_trade_quote_contract.sql','202_job_quote_operations.sql','205_generic_quote_customer_release.sql','207_quote_pricing_versions.sql','211_commercial_quote_release_guard.sql','212_plan_quote_release_guard.sql','215_generic_release_snapshot.sql','217_final_quote_credit_settlement.sql','219_commercial_paint_pricing_proof.sql','221_commercial_paint_correction_operations.sql'].map(name => `sql/migrations/${name}`)]
const hash = path => createHash('sha256').update(readFileSync(join(app,path))).digest('hex')
const evidence = { completed: false,results: [],failedTests: [],sourceHashes: Object.fromEntries(tracked.map(path => [path,hash(path)])),
  limits: ['Owner auth, external location evidence and accepted carrier are fixtures; no live I/O.',
    'Actual tool creation, tenant rates/pricers, saves, owner approvals, release/outbox/reference SQL and public server rendering share local rows.',
    'Commercial pricing executes actual 219 source/proof persistence/atomic save over the physical 107 rate table and index; default rate seeds are not installed. The save consumes the proof returned by the real price route.',
    'Commercial input is a raw unpriced takeoff. Actual corrections GET/POST and 221 SQL establish the reviewed baseline, atomic confirmation and retained receipt before actual219 pricing/save. Extraction generation and browser confirmation UI are not executed; no confirmation, priced result or proof is seeded.',
    'Minimal local PGlite/PostgREST-shaped fixture schema, not production RLS/PostgREST or deployed acceptance.',
    'No PDF generation/visual inspection, browser-only overlays, post-response archival or payment flow. Named source hashes are not the whole import closure.'] }
let db
const request = (path,body) => new Request(`${WEBSITE}${path}`, { method: body ? 'POST' : 'GET',headers: { authorization: 'Bearer offline-owner','content-type': 'application/json' },...(body ? { body: JSON.stringify(body) } : {}) })
const render = async (Page,token) => renderToStaticMarkup(await Page({ params: Promise.resolve({ token }),searchParams: Promise.resolve({}) })).replace(/<[^>]*>/g,' ')
const load = async (table,id) => { const result = await db.client.from(table).select('*').eq('id',id).single(); expect(result.error).toBeNull(); return result.data }
async function tradeReview(family,id) {
  const response = await reviewTrade(request(`/api/sms/quote-release?family=${family}&id=${id}`)); expect(response.status).toBe(200)
  const body = await response.json(); expect(body.review.canApprove).toBe(true); return body.review.version
}
async function sendSaved(family,id,token,phone) {
  const conversationId = randomUUID(),turnId = randomUUID(),before = h.carrier.length
  await db.seed('sms_conversations',[{ id: conversationId,tenant_id: TENANT,from_number: phone,to_number: TO,status: 'done',conversation_type: 'customer_quote' }])
  const resend = () => withSmsDeliveryContext({ tenantId: TENANT,conversationId,turnId },async () => {
    const result = await handleExistingQuoteAction({ supabase: db.client,tenantId: TENANT,customerPhone: phone,text: 'Please send the quote link again' })
    expect(result.reference).toMatchObject({ family,id,token,stage: 'ready' })
    const sent = await dispatchQuoteMessage({ tenantId: TENANT,to: phone,from: TO,text: result.reply }); expect(sent.ok).toBe(true); return sent
  })
  const first = await resend(); expect((await resend()).outboxId).toBe(first.outboxId)
  expect(h.carrier).toHaveLength(before + 1)
  const transcript = await db.client.from('sms_messages').select('*').eq('outbox_id',first.outboxId).single()
  expect(transcript.data).toMatchObject({ conversation_id: conversationId,twilio_message_sid: first.sid,delivery_status: 'accepted' })
  return { outboxId: first.outboxId,conversationId,transcriptId: transcript.data.id }
}
beforeAll(async () => {
  writeFileSync(output,JSON.stringify(evidence,null,2))
  vi.stubEnv('PUBLIC_WEB_ORIGIN',WEBSITE); vi.stubEnv('APP_URL','https://offline-engine.invalid')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://offline-db.invalid')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','offline-idempotency-secret'); vi.stubEnv('TENANT_FILESTORE_ENABLED','false'); vi.stubEnv('SMS_QUOTE_PDF_MMS','0')
  vi.stubGlobal('fetch',async () => { h.unexpected.push('fetch'); throw new Error('Unexpected external fetch') })
  db = await createToolReleaseFixture(app,h,TENANT); h.client = db.client
  h.tenant = { id: TENANT,owner_user_id: OWNER,trade: 'commercial_painting',business_name: 'Offline tool tradie',twilio_sms_number: TO }
  await db.seed('tenants',[h.tenant])
  await db.seedCommercialRates(rateRows)
  await db.seed('pricing_book',[{ id: randomUUID(),tenant_id: TENANT,trade: 'commercial_painting',gst_registered: true,quote_tier_mode: 'single',overlays: { aircon_rate_card: acCard } }])
  await db.seed('paint_runs',[{ id: RUN,tenant_id: TENANT,job_name: 'Retail repaint',site_address: '42 Example Road',status: 'ready',public_token: null }])
  await db.seed('plan_extractions',[{ id: EXT,tenant_id: TENANT,trade: 'commercial_painting',paint_run_id: RUN,items: [{ surface: 'Internal walls',room: 'Retail',substrate: 'plasterboard',system: 'low_sheen',unit: 'm2',quantity: 100,coats: 2,confidence: 'high',source: 'plan' }],corrected_items: null,sheets_used: {},priced_bom: null,priced_at: null }])
},20000)
afterAll(async () => {
  try {
    for (const [path,expected] of Object.entries(evidence.sourceHashes)) expect(hash(path)).toBe(expected)
    expect(h.unexpected).toEqual([])
    for (const sent of h.carrier) for (const url of sent.text.match(/https?:\/\/[^\s<>()]+/g) ?? []) expect(new URL(url.replace(/[.,;:!?]+$/,'')).origin).toBe(WEBSITE)
    evidence.completed = evidence.results.length === 2 && evidence.failedTests.length === 0
  } finally { if (db) await db.close(); evidence.generatedAt = new Date().toISOString(); evidence.carrierCalls = h.carrier.length; evidence.unexpected = h.unexpected
    writeFileSync(output,JSON.stringify(evidence,null,2)); vi.unstubAllEnvs(); vi.unstubAllGlobals() }
})

it('aircon actual recommendation save → owner approval → public page → same saved-reference resend',async () => {
  try {
    const response = await recommend(request('/api/aircon/recommend',acBody)); expect(response.status).toBe(200)
    const created = await response.json(),saved = await load('aircon_recommendations',created.saved.id)
    expect(created.recommendation.pricing_status).toBe('priced'); expect(created.recommendation.pricing_authority.tenant_id).toBe(TENANT)
    expect(saved.tenant_id).toBe(TENANT); expect(saved.released_at).toBeNull(); expect(h.carrier).toHaveLength(0)
    const priceText = Math.round(created.recommendation.options[0].price.low).toLocaleString('en-AU')
    expect(await render(AirconPage,created.saved.public_token)).not.toContain(priceText)
    const phone = '+61411111171'
    const approve = async () => approveTrade(request('/api/sms/quote-release',{ family: 'aircon',id: saved.id,approve: true,customerPhone: phone,reviewVersion: await tradeReview('aircon',saved.id) }))
    const released = await approve(); evidence.airconApproval = { status: released.status,body: await released.clone().json() }
    expect(released.status).toBe(200); expect((await approve()).status).toBe(200); expect(h.carrier).toHaveLength(1)
    expect(await render(AirconPage,created.saved.public_token)).toContain(priceText)
    const jobs = await (await tradeJobs(request('/api/tenant/trade-jobs'))).json()
    expect(jobs.jobs.find(row => row.id === saved.id).href).toBe(`/q/aircon/${created.saved.public_token}`)
    const resend = await sendSaved('aircon',saved.id,created.saved.public_token,phone)
    expect((await load('aircon_recommendations',saved.id)).recommendation).toEqual(saved.recommendation)
    const replay = await (await recommend(request('/api/aircon/recommend',acBody))).json()
    expect(replay.saved).toEqual(created.saved); expect(replay.recommendation).toEqual(created.recommendation)
    expect(h.airconPrices).toBe(1); expect(h.locationCalls).toBe(1)
    expect((await db.client.from('aircon_recommendations').select('*')).data).toHaveLength(1)
    evidence.results.push({ family: 'aircon',passed: true,id: saved.id,token: created.saved.public_token,priceText,priceCalls: h.airconPrices,resend })
  } catch (error) { evidence.failedTests.push({ family: 'aircon',message: String(error) }); throw error }
},20000)

it('commercial actual confirmation → price/save → returned quote approval → dashboard public link and saved-reference resend',async () => {
  try {
    const before = h.carrier.length
    const correctionPath = `/api/tenant/commercial-painting/run/${RUN}/corrections`
    const correctionContext = { params: Promise.resolve({ id: RUN }) }
    const baselineResponse = await readPaintCorrection(request(correctionPath),correctionContext)
    expect(baselineResponse.status).toBe(200)
    const { snapshot } = await baselineResponse.json()
    expect(snapshot).toMatchObject({ runId: RUN,extractionId: EXT,released: false,corrected_items: null })
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/)
    const initialRun = await load('paint_runs',RUN),initialExtraction = await load('plan_extractions',EXT)
    expect(snapshot.items).toEqual(initialExtraction.items)
    const confirmationBody = { operationId: randomUUID(),expectedRevision: snapshot.revision,extractionId: snapshot.extractionId,
      job_name: snapshot.job_name,site_address: snapshot.site_address,corrected_items: snapshot.items }
    const applyConfirmation = body => confirmPaint(request(correctionPath,body),correctionContext)
    // Invalid takeoff data cannot partially commit the accompanying metadata.
    const invalid = await applyConfirmation({ ...confirmationBody,operationId: randomUUID(),job_name: 'Rejected metadata edit',
      corrected_items: [{ ...snapshot.items[0],quantity: -1 }] })
    expect(invalid.status).toBe(400)
    expect(await load('paint_runs',RUN)).toEqual(initialRun)
    expect(await load('plan_extractions',EXT)).toEqual(initialExtraction)
    const applied = await applyConfirmation(confirmationBody)
    expect(applied.status).toBe(200)
    const confirmation = await applied.json()
    expect(confirmation).toMatchObject({ ok: true,status: 'applied',runId: RUN,extractionId: EXT,
      operationId: confirmationBody.operationId,expectedRevision: snapshot.revision })
    expect(confirmation.requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(confirmation.revision).not.toBe(snapshot.revision)
    const confirmedRun = await load('paint_runs',RUN),confirmedExtraction = await load('plan_extractions',EXT)
    expect(confirmedRun).toMatchObject({ status: 'ready',job_name: snapshot.job_name,site_address: snapshot.site_address })
    expect(confirmedExtraction).toMatchObject({ corrected_items: snapshot.items,priced_bom: null,priced_at: null,paint_pricing_proof: null })
    const confirmationReplay = await applyConfirmation(confirmationBody)
    expect(confirmationReplay.status).toBe(200); expect(await confirmationReplay.json()).toEqual(confirmation)
    const reused = await applyConfirmation({ ...confirmationBody,job_name: 'A different operation payload' })
    expect(reused.status).toBe(409); expect(await reused.json()).toMatchObject({ error: 'correction_operation_reused' })
    const stale = await applyConfirmation({ ...confirmationBody,operationId: randomUUID() })
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: 'correction_conflict' })
    expect(await load('paint_runs',RUN)).toEqual(confirmedRun)
    expect(await load('plan_extractions',EXT)).toEqual(confirmedExtraction)
    const readback = await readPaintCorrection(request(`${correctionPath}?operationId=${confirmationBody.operationId}`),correctionContext)
    expect(readback.status).toBe(200); expect(await readback.json()).toEqual(confirmation)
    const currentResponse = await readPaintCorrection(request(correctionPath),correctionContext)
    expect(currentResponse.status).toBe(200)
    const current = (await currentResponse.json()).snapshot
    expect(current).toMatchObject({ revision: confirmation.revision,extractionId: EXT,corrected_items: snapshot.items })
    const receipts = await db.pg.query('select to_jsonb(r) as row from commercial_paint_correction_operations r where tenant_id=$1 and run_id=$2',[TENANT,RUN])
    expect(receipts.rows).toHaveLength(1)
    expect(receipts.rows[0].row).toMatchObject({ operation_id: confirmationBody.operationId,expected_revision: snapshot.revision,
      request_hash: confirmation.requestHash,extraction_id: EXT,outcome: confirmation })
    const stalePrice = await pricePaint(request('/api/tenant/commercial-painting/price',{
      paintRunId: RUN,extractionId: EXT,expectedRevision: snapshot.revision }))
    expect(stalePrice.status).toBe(409); expect(await stalePrice.json()).toMatchObject({ error: 'correction_conflict' })
    expect(await load('paint_runs',RUN)).toEqual(confirmedRun)
    expect(await load('plan_extractions',EXT)).toEqual(confirmedExtraction)
    expect(h.paintPrices).toBe(0); expect(h.carrier).toHaveLength(before)
    evidence.commercialConfirmation = { baseline: snapshot,operation: confirmation,currentSnapshot: current,
      invalidStatus: invalid.status,reusedStatus: reused.status,staleStatus: stale.status,stalePriceStatus: stalePrice.status,receiptCount: receipts.rows.length }
    const priced = await pricePaint(request('/api/tenant/commercial-painting/price',{ paintRunId: RUN,extractionId: EXT,expectedRevision: confirmation.revision })); expect(priced.status).toBe(200)
    const priceResult = await priced.json(), bom = priceResult.bom; expect(bom.totalIncGst).toBeGreaterThan(0)
    expect(priceResult.pricingProof).toMatch(/^[a-f0-9]{64}$/)
    expect(priceResult.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    expect(priceResult.labourBasis).toEqual({ mode: 'tenant',ratePerHr: null })
    const saveBody = { paintRunId: RUN,extractionId: EXT,customerPhone: '0411111172',customerName: 'Sam',pricingProof: priceResult.pricingProof,pricedAt: priceResult.pricedAt }
    const response = await savePaint(request('/api/tenant/commercial-painting/save-quote',saveBody))
    evidence.commercialSave = { status: response.status,body: await response.clone().json(),pricerCalls: h.paintPrices }
    const storedBom = (await load('plan_extractions',EXT)).priced_bom,recomputedBom = h.paintOutputs.at(-1)
    evidence.commercialEquality = { strictEqual: isDeepStrictEqual(storedBom,recomputedBom),
      jsonEquivalent: isDeepStrictEqual(storedBom,JSON.parse(JSON.stringify(recomputedBom))),
      storedFirstLineKeys: Object.keys(storedBom.lines[0]),recomputedFirstLineKeys: Object.keys(recomputedBom.lines[0]),
      recomputedHeightUndefined: recomputedBom.lines[0].height_m === undefined }
    expect(response.status).toBe(200)
    const created = await response.json(),saved = await load('quotes',created.quoteId),run = await load('paint_runs',RUN)
    expect(created.quoteViewUrl).toBe(`/q/${saved.share_token}`); expect(created.delivery.attempted).toBe(false)
    expect(saved.total_inc_gst).toBe(bom.totalIncGst); expect(saved.customer_released_at).toBeNull(); expect(h.carrier).toHaveLength(before)
    const priceText = Math.round(bom.totalIncGst).toLocaleString('en-AU')
    const genericPriceText = bom.totalIncGst.toLocaleString('en-AU',{ minimumFractionDigits: 2,maximumFractionDigits: 2 })
    expect(await render(GenericPage,saved.share_token)).not.toContain(genericPriceText)
    expect(await render(CommercialPage,run.public_token)).not.toContain(priceText)
    const approve = async () => sendGeneric(request(`/api/quote/${saved.id}/send`,{ channel: 'sms',expected_revision: quoteCustomerReleaseRevision(await load('quotes',saved.id)) }),{ params: Promise.resolve({ id: saved.id }) })
    expect((await approve()).status).toBe(200); expect((await approve()).status).toBe(200); expect(h.carrier).toHaveLength(before + 1)
    expect(await render(GenericPage,saved.share_token)).toContain(genericPriceText)
    const resend = await sendSaved('generic',saved.id,saved.share_token,'+61411111172')
    const replay = await (await savePaint(request('/api/tenant/commercial-painting/save-quote',saveBody))).json()
    expect(replay.quoteId).toBe(saved.id); expect(replay.shareToken).toBe(saved.share_token)
    expect((await db.client.from('quotes').select('*')).data).toHaveLength(1)
    expect((await load('quotes',saved.id)).better).toEqual(saved.better); expect(h.paintPrices).toBe(2)
    const jobs = await (await tradeJobs(request('/api/tenant/trade-jobs'))).json(),card = jobs.jobs.find(row => row.id === RUN)
    evidence.commercialCard = { href: card.href,returnedQuoteUrl: created.quoteViewUrl,runReleasedAt: (await load('paint_runs',RUN)).released_at }
    // The returned generic quote and rich dashboard document are distinct
    // existing surfaces. Record the latter's state without inferring that
    // approving one document must automatically approve a separate document.
    evidence.commercialCard.priceVisibleAfterGenericApproval = (await render(CommercialPage,run.public_token)).includes(priceText)
    const producerPriceCalls = h.paintPrices
    expect(producerPriceCalls).toBe(2)
    const richReviewVersion = await tradeReview('commercial-paint',RUN)
    expect(h.paintPrices).toBe(producerPriceCalls + 1)
    const richApproval = await approveTrade(request('/api/sms/quote-release',{ family: 'commercial-paint',id: RUN,approve: true,
      customerPhone: '+61411111172',reviewVersion: richReviewVersion }))
    expect(richApproval.status).toBe(200)
    expect(h.paintPrices).toBe(producerPriceCalls + 2)
    const afterRichApprovalPriceCalls = h.paintPrices
    evidence.commercialPricingCalls = { producer: producerPriceCalls,reviewGetValidation: 1,approvalPostValidation: 1,total: afterRichApprovalPriceCalls }
    expect(await render(CommercialPage,run.public_token)).toContain(priceText)
    const approvedRun = await load('paint_runs',RUN)
    // Change only a tradie's source rate, then invoke the real price route.
    // No generated/repriced result is manually inserted into this fixture.
    await db.pg.query("update paint_rates set value=190 where tenant_id=$1 and code='mod:labour_rate'",[TENANT])
    const repricedResponse = await pricePaint(request('/api/tenant/commercial-painting/price',{ paintRunId: RUN,extractionId: EXT }))
    const repricedBody = await repricedResponse.json()
    expect((await load('quotes',saved.id)).better).toEqual(saved.better)
    const publicAfterReprice = await render(CommercialPage,run.public_token),afterBom = (await load('plan_extractions',EXT)).priced_bom
    evidence.commercialReprice = { token: run.public_token,originalIncGst: bom.totalIncGst,attemptedLabourRate: 190,
      responseStatus: repricedResponse.status,response: repricedBody,
      releasedAtBefore: approvedRun.released_at,releasedAtAfter: (await load('paint_runs',RUN)).released_at,
      savedBomUnchanged: isDeepStrictEqual(afterBom,bom),originalPriceVisible: publicAfterReprice.includes(priceText) }
    expect(repricedResponse.status).toBe(409)
    expect(repricedBody).toMatchObject({ ok: false,error: 'released_quote_immutable' })
    expect(afterBom).toEqual(bom)
    expect((await load('paint_runs',RUN)).released_at).toBe(approvedRun.released_at)
    expect(publicAfterReprice).toContain(priceText)
    expect(h.paintPrices).toBe(afterRichApprovalPriceCalls)
    // Replaying the retained earlier confirmation reads its receipt without
    // clearing the later priced/released result or generating a new operation.
    const finalRun = await load('paint_runs',RUN),finalExtraction = await load('plan_extractions',EXT)
    const lateConfirmationReplay = await applyConfirmation(confirmationBody)
    expect(lateConfirmationReplay.status).toBe(200); expect(await lateConfirmationReplay.json()).toEqual(confirmation)
    expect(await load('paint_runs',RUN)).toEqual(finalRun)
    expect(await load('plan_extractions',EXT)).toEqual(finalExtraction)
    expect((await db.pg.query('select count(*)::integer as count from commercial_paint_correction_operations where tenant_id=$1 and run_id=$2',[TENANT,RUN])).rows[0].count).toBe(1)
    evidence.commercialConfirmation.lateReplayPreservedReleasedResult = true
    evidence.results.push({ family: 'commercial-painting',passed: true,id: saved.id,runId: RUN,token: saved.share_token,priceText,genericPriceText,priceCalls: h.paintPrices,cardHref: card.href,resend })
  } catch (error) { evidence.failedTests.push({ family: 'commercial-painting',message: String(error) }); throw error }
},20000)
