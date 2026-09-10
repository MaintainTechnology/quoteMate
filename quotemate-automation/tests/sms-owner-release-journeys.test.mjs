import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createOwnerReleaseFixture } from '../scripts/sms-owner-release-fixture.mjs'
import { addCommercialPricingSql } from '../scripts/sms-commercial-pricing-fixture.mjs'

// Auth verification and carrier transport are explicit local fixtures. Release,
// review, public rendering, saved-reference lookup, dispatch and SQL stay real.
const h = vi.hoisted(() => ({ client: null, tenant: null, carrier: [], unexpected: [], pdfs: new Map(), downloads: [], renderConfigured: false }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  from: (...args) => {
    const query = h.client.from(...args)
    // The shared minimal adapter returns full rows. Match PostgREST's actual
    // field projection specifically at the generic PDF context read; otherwise
    // lifecycle fields that production never selects corrupt its cache hash.
    if (args[0] === 'quotes') {
      const select = query.select
      query.select = fields => {
        const result = select(fields)
        if (typeof fields === 'string' && fields.split(',').map(field => field.trim()).includes('pdf_signature')) {
          const maybeSingle = query.maybeSingle
          query.maybeSingle = async (...options) => {
            const response = await maybeSingle(...options)
            return { ...response, data: response.data && Object.fromEntries(fields.split(',').map(field => [field.trim(), response.data[field.trim()] ?? null])) }
          }
        }
        return result
      }
    }
    return query
  }, rpc: (...args) => h.client.rpc(...args),
  storage: { from: (...args) => h.client.storage.from(...args) },
}) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async (_db, request) => {
  const auth = request.headers.get('authorization')
  if (auth === 'Bearer fixture-owner') return { tenant: h.tenant, identity: { userId: 'fixture-owner', provider: 'clerk' } }
  if (auth === 'Bearer fixture-other') return { tenant: { ...h.tenant, id: '99999999-9999-4999-8999-999999999999' }, identity: { userId: 'fixture-other' } }
  return null
} }))
vi.mock('@/lib/estimation/auth', () => ({ tenantFromBearer: async request =>
  request.headers.get('authorization') === 'Bearer fixture-owner' ? h.tenant : null,
  estimatorSupabase: { from: (...args) => h.client.from(...args), rpc: (...args) => h.client.rpc(...args) } }))
vi.mock('@/lib/sms/twilio', () => ({
  sendSms: async options => { const sid = `SM${String(h.carrier.length + 1).padStart(32, '0')}`; h.carrier.push({ ...options, sid }); return { ok: true, sid, status: 'queued' } },
  sendWhatsApp: async () => { h.unexpected.push('WhatsApp'); throw new Error('Unexpected WhatsApp') },
  readTwilioMessage: async () => { h.unexpected.push('carrier-reconciliation'); throw new Error('Unexpected carrier reconciliation') },
}))
vi.mock('next/server', () => ({ after: () => {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/q/fixture', useRouter: () => ({}), useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NOT_FOUND') }, redirect: url => { throw new Error(`REDIRECT:${url}`) } }))
vi.mock('@/lib/auth/client-token', () => ({ getAuthToken: async () => null }))
vi.mock('@/app/q/_chrome/TradieJobBanner', () => ({ TradieJobBanner: () => null }))
vi.mock('@/app/q/_chrome/TradieDashboardPill', () => ({ TradieDashboardPill: () => null }))
vi.mock('@/lib/pdf/gotenberg', () => ({ gotenbergConfigured: () => h.renderConfigured,
  renderPdfFromHtml: async () => { h.unexpected.push('PDF-renderer'); throw new Error('Expected saved PDF') } }))

import { GET as reviewTrade, POST as approveTrade } from '@/app/api/sms/quote-release/route'
import { GET as readPaintCorrection, POST as confirmPaint } from '@/app/api/tenant/commercial-painting/run/[id]/corrections/route'
import { POST as pricePaint } from '@/app/api/tenant/commercial-painting/price/route'
import { POST as approveGeneric } from '@/app/api/quote/[id]/approve/route'
import { POST as sendGeneric } from '@/app/api/quote/[id]/send/route'
import { quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { handleExistingQuoteAction, lookupCustomerQuotes, canonicalQuoteUrl } from '@/lib/sms/quote-actions'
import { handleSavedJobCorrection } from '@/lib/sms/job-corrections'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { withSmsDeliveryContext } from '@/lib/sms/delivery-context'
import { GET as genericPdf } from '@/app/api/q/[token]/pdf/route'
import { GET as roofPdf } from '@/app/api/q/roof/[token]/pdf/route'
import { GET as paintPdf } from '@/app/api/q/paint/[token]/pdf/route'
import { GET as solarPdf } from '@/app/api/q/solar/[token]/pdf/route'
import { GET as planPdf } from '@/app/api/q/plan/[token]/pdf/route'
import GenericPage from '@/app/q/[token]/page'
import RoofPage from '@/app/q/roof/[token]/page'
import PaintPage from '@/app/q/paint/[token]/page'
import SolarPage from '@/app/q/solar/[token]/page'
import PlanPage from '@/app/q/plan/[token]/page'
import AirconPage from '@/app/q/aircon/[token]/page'
import CommercialPage from '@/app/q/commercial-paint/[token]/page'
import { makeFixtureEstimate } from '@/lib/solar/__fixtures__/estimate'
import { sizeAircon } from '@/lib/aircon/sizing'
import { recommendAircon } from '@/lib/aircon/recommend'
import { loadTenantAcPricingContext } from '@/lib/aircon/pricing-context'
import { solarPdfRev } from '@/lib/quote/pdf-rev'
import { quotePdfSignature } from '@/lib/quote/pdf-signature'
import { quoteEditRevision } from '@/lib/quote/edit-authority'
import { REPORT_TEMPLATE_VERSION } from '@/lib/quote/report-html'

const app = fileURLToPath(new URL('../', import.meta.url))
const output = join(app, '../docs/audits/2026-09-09-sms-owner-release-journeys.json')
const seedPath = join(app, 'tests/fixtures/sms-owner-release-seed.json')
const seed = JSON.parse(readFileSync(seedPath, 'utf8'))
const WEBSITE = 'https://quotemax.com.au', TENANT = '11111111-1111-4111-8111-111111111111', TO = '+61488888888'
const commercialRates = [
  { kind: 'labour', code: 'labour:low_sheen:roller', label: 'Tenant labour', system: 'low_sheen', method: 'roller', coverage_m2_per_hr: 10 },
  { kind: 'material', code: 'mat:wall_low_sheen', label: 'Tenant paint', system: 'low_sheen', product: 'Tenant low sheen', spread_m2_per_l: 15, price_per_l_ex_gst: 11 },
  ...Object.entries({ height_low: 1, height_mid: 1.25, height_high: 1.4, prep_pct: 0.1, sundries_pct: 0.08, labour_rate: 95, crew_hours_per_day: 7.6, default_crew_size: 3 })
    .map(([key, value]) => ({ kind: 'modifier', code: `mod:${key}`, label: key, value })),
].map(row => ({ ...row, tenant_id: TENANT, trade: 'commercial_painting', is_default: false }))
const CORRECTION_ACK = 'Your requested change is saved for tradie review. It has not been applied to the existing job or quote.'
const families = ['generic','roof','paint','solar','plan','aircon','commercial-paint']
const tables = { generic: 'quotes', roof: 'roofing_measurements', paint: 'painting_measurements', solar: 'solar_estimates', plan: 'plan_extractions', aircon: 'aircon_recommendations', 'commercial-paint': 'paint_runs' }
const pages = { generic: GenericPage, roof: RoofPage, paint: PaintPage, solar: SolarPage, plan: PlanPage, aircon: AirconPage, 'commercial-paint': CommercialPage }
const pdfRoutes = { generic: genericPdf, roof: roofPdf, paint: paintPdf, solar: solarPdf, plan: planPdf }
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const tracked = [
  'app/api/sms/quote-release/route.ts', 'app/api/quote/[id]/approve/route.ts', 'app/api/quote/[id]/send/route.ts',
  ...families.map(family => `app/q/${family === 'generic' ? '' : `${family}/`}[token]/page.tsx`),
  ...Object.keys(pdfRoutes).map(family => `app/api/q/${family === 'generic' ? '' : `${family}/`}[token]/pdf/route.ts`),
  'lib/sms/quote-review.ts','lib/sms/quote-actions.ts','lib/sms/dispatch.ts','lib/sms/durable-outbox.ts','lib/sms/delivery-context.ts',
  'lib/sms/quote-origin-conversation.ts','lib/sms/job-corrections.ts','lib/sms/human-handoff.ts','lib/sms/durable-work.ts',
  'lib/quote/customer-release.ts','lib/quote/job-quote-operation.ts','lib/quote/pdf.ts',
  'lib/quote/pdf-signature.ts','lib/quote/edit-authority.ts','lib/quote/report-html.ts','lib/quote/report-pricing.ts',
  'app/api/tenant/commercial-painting/run/[id]/corrections/route.ts','app/api/tenant/commercial-painting/price/route.ts',
  'lib/commercial-painting/correction-contract.ts','lib/commercial-painting/correction-operations.ts',
  'lib/commercial-painting/pricing-proof.ts','lib/commercial-painting/price.ts','lib/commercial-painting/rates.ts','lib/commercial-painting/rich-run-review.ts',
  ...['107_commercial_painting.sql','198_sms_durable_work.sql','199_sms_delivery_outbox.sql','201_sms_trade_quote_contract.sql','202_job_quote_operations.sql','205_generic_quote_customer_release.sql','207_quote_pricing_versions.sql','211_commercial_quote_release_guard.sql','212_plan_quote_release_guard.sql','215_generic_release_snapshot.sql','217_final_quote_credit_settlement.sql','219_commercial_paint_pricing_proof.sql','221_commercial_paint_correction_operations.sql'].map(file => `sql/migrations/${file}`),
  'scripts/sms-owner-release-fixture.mjs','scripts/sms-commercial-pricing-fixture.mjs','scripts/sms-route-fixture-db.mjs','tests/sms-owner-release-journeys.test.mjs',
]
const evidence = { scope: 'Seven held quote families through actual owner approval, SQL/outbox, public server rendering and saved-reference resend',
  completed: false, results: [], additionalScenarios: [], failedTests: [], sourceHashes: Object.fromEntries(tracked.map(path => [path, hash(join(app, path))])),
  seedEvidence: { path: seedPath, sha256: hash(seedPath), fixtureVersion: seed.fixtureVersion, provenance: seed.provenance },
  limits: ['Saved resources and raw commercial takeoff are synthetic inputs. Commercial confirmation and pricing execute actual221/219 before review; other resource creation and inbound SMS receipt routing are not exercised.',
    'Local PGlite applies actual approval/reference/outbox migrations on a minimal fixture schema; not production schema/RLS or deployed verification.',
    'Verified-owner resolver and accepted carrier are fixtures. Real public server components render static markup; browser-only owner overlays and post-response archival are omitted.',
    'Saved private PDF byte fixtures exercise actual access/cache/download routes. No PDF renderer, visual inspection, payment checkout or real carrier delivery.',
    'Aircon and commercial painting have public pages here; no public PDF GET is invented for them. Source hashes bind named boundaries, not the whole import closure.',
    'Final quote, owner revision, historical payment and next-day conversation records are seeded states; their creation/edit/payment handlers and real elapsed time are not exercised.'],
}
let db
const resources = {}
const clone = value => structuredClone(value)
function assertCanonicalLinks(text) {
  const links = text.match(/https?:\/\/[^\s<>()]+/g) ?? []
  expect(links.length).toBeGreaterThan(0)
  for (const link of links) expect(new URL(link.replace(/[.,;:!?]+$/, '')).origin).toBe(WEBSITE)
}
const request = (path, body, owner = 'fixture-owner') => new Request(`${WEBSITE}${path}`, {
  method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(owner ? { authorization: `Bearer ${owner}` } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
})
async function rowFor(resource) {
  const result = await db.client.from(tables[resource.family]).select('*').eq('id', resource.id).maybeSingle()
  expect(result.error).toBeNull(); return result.data
}
async function render(resource) {
  const page = await pages[resource.family]({ params: Promise.resolve({ token: resource.token }), searchParams: Promise.resolve({}) })
  return renderToStaticMarkup(page).replace(/<[^>]*>/g, ' ')
}
async function pdf(resource) {
  // All priced public downloads must validate their saved cache. The external
  // renderer remains an unexpected boundary, so an invalid fixture signature
  // cannot pass by falling back to unsigned/stale PDF bytes.
  h.renderConfigured = true
  try {
    return await pdfRoutes[resource.family](request(`/api/q/${resource.family === 'generic' ? '' : `${resource.family}/`}${resource.token}/pdf`, null, null),
      { params: Promise.resolve({ token: resource.token }) })
  } finally { h.renderConfigured = false }
}
async function seedGenericPdfCache(resource) {
  const row = await rowFor(resource)
  // Match the immutable storage key written by the actual PDF service. These
  // are explicit saved byte fixtures; renderer success remains forbidden.
  const bytes = `%PDF-1.4\nOwned generic saved price ${resource.priceText}\n%%EOF`
  const path = `quotes/${resource.id}/${createHash('sha256').update(bytes).digest('hex')}.pdf`
  // These four lifecycle fields are absent from the actual PDF context SELECT;
  // quoteEditRevision canonicalises its absent fields to null. Price/tax fields
  // come from the persisted row, with the explicit fixture's single-tier book.
  const pdfContextQuote = { ...row, status: null, paid_at: null, stripe_links: null, risk_flags: null }
  const signature = `${quotePdfSignature({ templateVersion: REPORT_TEMPLATE_VERSION,
    tierMode: 'single', visibleTierKeys: ['better'], recommendedTier: null,
    gstRegistered: true, appliedDiscountPct: row.applied_discount_pct })}|web=${WEBSITE}|pricing=${quoteEditRevision(pdfContextQuote)}`
  const saved = await db.client.from('quotes').update({ pdf_signature: signature, pdf_path: path }).eq('id', resource.id)
  expect(saved.error).toBeNull()
  h.pdfs.set(`quote-pdfs:${path}`, bytes)
}
async function review(resource, owner = 'fixture-owner') {
  if (resource.family === 'generic') return quoteCustomerReleaseRevision(await rowFor(resource))
  const response = await reviewTrade(request(`/api/sms/quote-release?family=${resource.family}&id=${resource.id}`, null, owner))
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result.review.canApprove).toBe(true)
  expect(result.review).not.toHaveProperty('sourceSnapshot')
  return result.review.version
}
async function approve(resource, revision, owner = 'fixture-owner') {
  h.renderConfigured = false
  if (resource.family === 'generic') return approveGeneric(request(`/api/quote/${resource.id}/approve`, { expected_revision: revision }, owner), { params: Promise.resolve({ id: resource.id }) })
  return approveTrade(request('/api/sms/quote-release', { family: resource.family, id: resource.id, approve: true, reviewVersion: revision }, owner))
}
async function resend(resource, conversationId, turnId) {
  return withSmsDeliveryContext({ tenantId: TENANT, conversationId, turnId }, async () => {
    const result = await handleExistingQuoteAction({ supabase: db.client, tenantId: TENANT, customerPhone: resource.phone,
      text: 'Could you send the quote link again?' })
    expect(result).toMatchObject({ handled: true, reference: { family: resource.family, id: resource.id, stage: 'ready' } })
    expect(result.reply).toContain(canonicalQuoteUrl(result.reference))
    const sent = await dispatchQuoteMessage({ tenantId: TENANT, to: resource.phone, from: TO, audience: 'customer', text: result.reply })
    expect(sent.ok).toBe(true)
    return { ...sent, reply: result.reply }
  })
}

beforeAll(async () => {
  writeFileSync(output, JSON.stringify(evidence, null, 2))
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://offline-db.invalid')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'offline-only')
  vi.stubEnv('PUBLIC_WEB_ORIGIN', WEBSITE); vi.stubEnv('APP_URL', 'https://offline-engine.invalid')
  vi.stubEnv('SMS_QUOTE_PDF_MMS', '0'); vi.stubEnv('SOLAR_PREMIUM_QUOTE', '0')
  vi.stubEnv('GOOGLE_MAPS_API_KEY', ''); vi.stubEnv('TENANT_FILESTORE_ENABLED', 'false')
  vi.stubEnv('FULL_QUOTE_DOC', 'false')
  vi.stubGlobal('fetch', async () => { h.unexpected.push('fetch'); throw new Error('No external I/O allowed') })
  // These saved values are test inputs, not a generated parity pass report.
  // Keep fresh-checkout approval/page tests independent of prior test execution.
  expect(Object.keys(seed).sort()).toEqual(['estimate','fixtureVersion','provenance','quote'])
  expect(seed.fixtureVersion).toBe(1)
  expect(seed.provenance).toMatchObject({ kind: 'synthetic-test-data',
    sourceArtifact: '2026-09-09-sms-cross-channel-parity-results.json',
    sourceFields: ['results[finding=F16].quote','results[finding=F17].savedEstimate'] })
  expect(seed.provenance.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(seed.quote.routing.decision).toBe('tradie_review')
  expect(seed.quote.structures).toHaveLength(1)
  expect(seed.quote.combined.tiers.map(tier => tier.tier)).toEqual(['good','better','best'])
  expect(seed.quote.combined.tiers.find(tier => tier.tier === 'better').inc_gst).toBe(42388.72)
  expect(seed.estimate).toMatchObject({ provider: 'mock', measurement: { floor_area_m2: 180 },
    price: { routing: { decision: 'tradie_review' } } })
  expect(seed.estimate.price.tiers.map(tier => tier.tier)).toEqual(['good','better','best'])
  expect(seed.estimate.price.tiers.find(tier => tier.tier === 'better').ex_gst).toBe(18648)
  for (const tier of [...seed.quote.combined.tiers, ...seed.estimate.price.tiers]) {
    expect(Number.isFinite(tier.ex_gst) && tier.ex_gst > 0).toBe(true)
    expect(Number.isFinite(tier.inc_gst) && tier.inc_gst > 0).toBe(true)
  }
  db = await createOwnerReleaseFixture(app, h)
  try { db = await addCommercialPricingSql(app, db, h, TENANT) }
  catch (error) { await db.close(); db = null; throw error }
  h.client = db.client
  h.tenant = { id: TENANT, business_name: 'Offline Approval Tradie', twilio_sms_number: TO, owner_mobile: '+61422222222', state: 'NSW' }
  await db.seed('tenants', [h.tenant])
  await db.seedCommercialRates(commercialRates)
  const acCard = { split: { per_head: { '2.5': 1200, '3.5': 1500, '5': 2000, '7': 2700, '8': 3200 }, multi_head_discount_pct: 0.05 },
    ducted: { rate_per_kw: 1250, base_ex_gst: 4500, per_zone: 400, min_ex_gst: 8500 }, gst_registered: true }
  await db.seed('pricing_book', families.map(family => ({ id: randomUUID(), tenant_id: TENANT, trade: family === 'generic' ? 'electrical' : family === 'roof' ? 'roofing' : family === 'paint' ? 'painting' : family === 'commercial-paint' ? 'commercial_painting' : family,
    quote_tier_mode: 'single', gst_registered: true, overlays: family === 'aircon' ? { aircon_rate_card: acCard } : {} })))
  const airconContext = await loadTenantAcPricingContext(db.client, TENANT, 'aircon')
  expect(airconContext).not.toBeNull()
  const acInputs = { bedrooms: 3, bathrooms: 2, living_spaces: 2, storeys: 1, floor_area_m2: 150, ceiling_height: 'standard', insulation: 'average', current_situation: 'replacing' }
  const recommendation = { ...recommendAircon({ sizing: sizeAircon('temperate', acInputs), inputs: acInputs, rateCard: airconContext.rateCard }), pricing_authority: airconContext.authority }
  for (const [index, family] of families.entries()) {
    const id = randomUUID(), token = `owned_${family.replace('-', '_')}_quote_token_12345`, phone = `+614111111${String(index).padStart(2, '0')}`
    const resource = resources[family] = { id, token, family, phone, conversationIds: [randomUUID(), randomUUID()] }
    // An old completed conversation and a new active one share the exact
    // customer/tradie numbers while retaining the production unique index.
    for (const [conversationIndex, conversationId] of resource.conversationIds.entries()) await db.seed('sms_conversations', [{ id: conversationId, tenant_id: TENANT, from_number: phone, to_number: TO,
      status: conversationIndex ? 'open' : 'done', conversation_type: 'customer_quote', created_at: conversationIndex ? '2026-09-08T00:00:00Z' : '2026-09-07T00:00:00Z' }])
    const common = { id, tenant_id: TENANT, address: `${12 + index} Example Road, Sydney NSW 2000`, customer_phone: phone, public_token: token,
      created_at: '2026-09-08T00:00:00Z', released_at: null, routing: 'tradie_review' }
    let row, commercialExtraction
    if (family === 'generic') {
      const intakeId = randomUUID()
      await db.seed('intakes', [{ id: intakeId, tenant_id: TENANT, address: common.address, trade: 'electrical', job_type: 'power_points', caller: { name: 'Sam', phone }, scope: { description: 'Replace two power points', item_count: 2 } }])
      const tier = { subtotal_ex_gst: 500, total_ex_gst: 500, total_inc_gst: 550, description: 'Replace two power points', line_items: [{ description: 'Replace two power points', quantity: 2, unit_price_ex_gst: 250, total_ex_gst: 500 }] }
      row = { id, tenant_id: TENANT, intake_id: intakeId, share_token: token, status: 'awaiting_tradie_approval', good: null, better: tier, best: null,
        selected_tier: 'better', total_inc_gst: 550, scope_of_works: 'Replace two power points', assumptions: [], estimated_timeframe: 'One day',
        needs_inspection: false, inspection_reason: null, deposit_pct: 30, display_mode: null, applied_discount_pct: 0, quote_kind: 'initial',
        parent_quote_id: null, price_hold_until: null, stripe_links: {}, pdf_path: null, created_at: common.created_at }
      resource.priceText = '550'
    } else if (family === 'roof') {
      row = { ...common, quote: { ...clone(seed.quote), pricing_authority: { tenant_id: TENANT } },
        confirmed_at: common.created_at, included_indices: [0], state: 'NSW' }
      resource.priceText = '42,389'
    } else if (family === 'paint') {
      row = { ...common, estimate: clone(seed.estimate), scopes: ['walls'], state: 'NSW' }
      resource.priceText = '18,648'
    } else if (family === 'solar') {
      row = { ...common, estimate: makeFixtureEstimate({ token }), confirmed_at: null, guardrail_flags: [], state: 'NSW' }
      resource.priceText = '9,216'
    } else if (family === 'aircon') {
      row = { ...common, recommendation, postcode: '2000', state: 'NSW' }
      resource.priceText = recommendation.options[0].price.low.toLocaleString('en-AU')
    } else if (family === 'plan') {
      const uploadId = randomUUID()
      await db.seed('plan_uploads', [{ id: uploadId, tenant_id: TENANT, filename: 'Reviewed electrical plan.pdf' }])
      row = { id, tenant_id: TENANT, plan_upload_id: uploadId, share_token: token, released_at: null, corrected_items: [{ item: 'Double power point', count: 2, page: 1 }],
        sheets_used: ['1'], priced_bom: { lines: [{ item: 'Double power point', count: 2, materialExGst: 100, labourExGst: 400 }], totalIncGst: 550,
          materialExGst: 100, labourExGst: 400, labourFloorAddedExGst: 0, subtotalExGst: 500, gstExGst: 50, gstRegistered: true, assumptions: [], exclusions: [], unmatched: [] },
        report_pdf_path: `plans/${id}.pdf`, created_at: common.created_at }
      await db.seed('plan_upload_requests', [{ tenant_id: TENANT, plan_extraction_id: id, customer_phone: phone, token: `upload_${token}` }])
      resource.priceText = '550'
    } else {
      row = { ...common, job_name: 'Reviewed retail repaint', site_address: common.address, status: 'ready' }
      commercialExtraction = { id: randomUUID(), tenant_id: TENANT, trade: 'commercial_painting', paint_run_id: id,
        items: [{ surface: 'Internal walls', room: 'Retail', substrate: 'plasterboard', system: 'low_sheen', unit: 'm2', quantity: 100, coats: 2, confidence: 'high', source: 'plan' }],
        corrected_items: null, sheets_used: {}, priced_at: null, priced_bom: null, paint_pricing_proof: null }
      // Independently fixed expected amount for these known rows/rates; never
      // accept a price merely because the route and public page agree on it.
      resource.priceText = '2,482'
    }
    if (['roof','paint','solar'].includes(family)) {
      const revision = family === 'solar' ? solarPdfRev(row, false) : '-v7'
      const bytes = `%PDF-1.4\nOwned ${family} saved price ${resource.priceText}\n%%EOF`
      row.pdf_path = `${family === 'roof' ? 'roofs' : family}/${token}${revision}-web-${createHash('sha256').update(WEBSITE).digest('hex').slice(0, 16)}/${createHash('sha256').update(bytes).digest('hex')}.pdf`
    }
    await db.seed(tables[family], [row])
    if (family === 'generic') await seedGenericPdfCache(resource)
    if (commercialExtraction) {
      await db.seed('plan_extractions', [commercialExtraction])
      const correctionPath = `/api/tenant/commercial-painting/run/${id}/corrections`, context = { params: Promise.resolve({ id }) }
      const observed = await readPaintCorrection(request(correctionPath), context)
      expect(observed.status).toBe(200)
      const baseline = (await observed.json()).snapshot
      expect(baseline).toMatchObject({ runId: id, extractionId: commercialExtraction.id, corrected_items: null, released: false })
      expect(baseline.items).toEqual(commercialExtraction.items)
      const operationId = randomUUID()
      const confirmed = await confirmPaint(request(correctionPath, { operationId, expectedRevision: baseline.revision,
        extractionId: baseline.extractionId, corrected_items: baseline.items, job_name: baseline.job_name, site_address: baseline.site_address }), context)
      expect(confirmed.status).toBe(200)
      const confirmation = await confirmed.json()
      expect(confirmation).toMatchObject({ ok: true, status: 'applied', runId: id, operationId, extractionId: commercialExtraction.id, expectedRevision: baseline.revision })
      expect(confirmation.revision).not.toBe(baseline.revision)
      const priced = await pricePaint(request('/api/tenant/commercial-painting/price', {
        paintRunId: id, extractionId: commercialExtraction.id, expectedRevision: confirmation.revision }))
      expect(priced.status).toBe(200)
      const result = await priced.json()
      expect(result.bom.totalIncGst).toBe(2481.95)
      expect(Math.round(result.bom.totalIncGst).toLocaleString('en-AU')).toBe(resource.priceText)
      expect(result.pricingProof).toMatch(/^[a-f0-9]{64}$/)
      expect(result.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
      const stored = await db.client.from('plan_extractions').select('*').eq('id', commercialExtraction.id).single()
      expect(stored.error).toBeNull()
      expect(stored.data.corrected_items).toEqual(baseline.items)
      expect(stored.data.priced_bom).toEqual(result.bom)
      expect(stored.data.paint_pricing_proof.digest).toBe(result.pricingProof)
      expect((await rowFor(resource)).released_at).toBeNull()
      expect(h.carrier).toHaveLength(0)
      evidence.commercialFixturePricing = { runId: id, extractionId: commercialExtraction.id, confirmation,
        expectedTotalIncGst: 2481.95, totalIncGst: result.bom.totalIncGst, pricingProof: result.pricingProof, pricedAt: result.pricedAt }
    }
    const path = row.pdf_path ?? row.report_pdf_path
    if (path) h.pdfs.set(`${family === 'plan' ? 'plan-pdfs' : 'quote-pdfs'}:${path}`, `%PDF-1.4\nOwned ${family} saved price ${resource.priceText}\n%%EOF`)
  }
}, 20000)

afterAll(async () => {
  if (db) await db.close()
  try {
    for (const [path, expected] of Object.entries(evidence.sourceHashes)) expect(hash(join(app, path))).toBe(expected)
    expect(hash(seedPath)).toBe(evidence.seedEvidence.sha256)
    expect(h.unexpected).toEqual([])
    expect(h.carrier.filter(message => message.text === CORRECTION_ACK)).toHaveLength(2)
    for (const message of h.carrier) if (message.text !== CORRECTION_ACK) assertCanonicalLinks(message.text)
    evidence.completed = evidence.results.length === families.length && evidence.additionalScenarios.length === 4 && evidence.failedTests.length === 0
    evidence.carrierCalls = h.carrier.length
  } finally {
    evidence.generatedAt = new Date().toISOString(); evidence.unexpected = h.unexpected
    writeFileSync(output, JSON.stringify(evidence, null, 2))
    vi.unstubAllEnvs(); vi.unstubAllGlobals()
  }
})

describe('seven-family saved owner release and resend composition', () => {
  it.each(families)('%s: held → reviewed approval → public resource → same/new conversation resend', async family => {
    try {
      const resource = resources[family], savedBefore = await rowFor(resource)
      const initialCount = h.carrier.length, initialDownloads = h.downloads.length
      const held = await handleExistingQuoteAction({ supabase: db.client, tenantId: TENANT, customerPhone: resource.phone, text: 'Send the quote link again' })
      expect(held).toMatchObject({ handled: true, reference: { family, id: resource.id, stage: 'awaiting_review' } })
      expect(held.reply).not.toMatch(/https?:|shortly|on its way|\$/i)
      const heldHtml = await render(resource)
      expect(heldHtml).not.toContain(resource.priceText)
      if (pdfRoutes[family]) expect([403,409]).toContain((await pdf(resource)).status)
      expect(h.downloads).toHaveLength(initialDownloads)
      const version = await review(resource)
      expect([403,404]).toContain((await approve(resource, version, 'fixture-other')).status)
      expect((await approve(resource, 'stale-review-version')).status).toBe(409)
      expect(h.carrier).toHaveLength(initialCount)
      const approved = await approve(resource, version)
      expect(approved.status).toBe(200)
      const approvedBody = await approved.json()
      expect(approvedBody).toMatchObject({ ok: true, approved: true, accepted: true })
      expect(h.carrier).toHaveLength(initialCount + 1)
      const savedAfter = await rowFor(resource)
      expect(savedAfter[family === 'solar' ? 'confirmed_at' : family === 'generic' ? 'customer_released_at' : 'released_at']).toBeTruthy()
      for (const key of ['good','better','best','estimate','quote','recommendation','corrected_items','priced_bom']) expect(savedAfter[key]).toEqual(savedBefore[key])
      const initialIntent = await db.client.from('sms_outbox').select('*').eq('to_number', resource.phone).single()
      expect(initialIntent.data.status).toBe('accepted')
      expect(initialIntent.data.provider_sid).toBe(h.carrier.at(-1).sid)
      expect(initialIntent.data.payload.text).toContain(`/q/${family === 'generic' ? '' : `${family}/`}${resource.token}`)
      assertCanonicalLinks(initialIntent.data.payload.text)
      // These portal-origin resources have no exact SMS relationship. An
      // existing same-phone conversation alone must never supply attribution.
      expect(initialIntent.data.conversation_id).toBeNull()
      const initialTranscript = await db.client.from('sms_messages').select('*').eq('outbox_id', initialIntent.data.id)
      expect(initialTranscript.data).toEqual([])
      // Repeat approval with a freshly reviewed snapshot; its initial intent
      // remains one even though release timestamps have now changed.
      expect((await approve(resource, await review(resource))).status).toBe(200)
      expect(h.carrier).toHaveLength(initialCount + 1)
      const releasedHtml = await render(resource)
      expect(releasedHtml).toContain(resource.priceText)
      let pdfStatus = null
      if (pdfRoutes[family]) {
        const download = await pdf(resource); pdfStatus = download.status
        expect(download.status).toBe(200)
        expect(await download.text()).toContain(`Owned ${family} saved price ${resource.priceText}`)
      }
      const resendResults = []
      for (const conversationId of resource.conversationIds) {
        const turnId = randomUUID(), count = h.carrier.length
        const sent = await resend(resource, conversationId, turnId)
        const replay = await resend(resource, conversationId, turnId)
        expect(replay.outboxId).toBe(sent.outboxId); expect(replay.sid).toBe(sent.sid)
        expect(h.carrier).toHaveLength(count + 1)
        const transcript = await db.client.from('sms_messages').select('*').eq('conversation_id', conversationId).eq('outbox_id', sent.outboxId).single()
        expect(transcript.data).toMatchObject({ body: sent.reply, twilio_message_sid: sent.sid, direction: 'outbound' })
        const conversation = await db.client.from('sms_conversations').select('*').eq('id', conversationId).single()
        resendResults.push({ conversationId, turnId, outboxId: sent.outboxId, sid: sent.sid, conversationCreatedAt: conversation.data.created_at })
      }
      expect(Date.parse(resendResults[1].conversationCreatedAt) - Date.parse(resendResults[0].conversationCreatedAt)).toBe(24 * 60 * 60 * 1000)
      expect(await lookupCustomerQuotes({ supabase: db.client, tenantId: '99999999-9999-4999-8999-999999999999', customerPhone: resource.phone })).toEqual([])
      const intents = await db.client.from('sms_outbox').select('*').eq('to_number', resource.phone)
      expect(intents.data).toHaveLength(3); expect(intents.data.every(row => row.status === 'accepted')).toBe(true)
      expect(h.unexpected).toEqual([])
      evidence.results.push({ family, passed: true, resourceId: resource.id, token: resource.token, initialIntentId: initialIntent.data.id,
        initialTranscriptRows: initialTranscript.data.length, publicPriceText: resource.priceText, pdfStatus,
        acceptedIntents: intents.data.length, carrierCalls: h.carrier.length - initialCount, resends: resendResults })
    } catch (error) { evidence.failedTests.push({ family, message: String(error) }); throw error }
  }, 20000)

  it('a revised held final quote rejects stale approval, preserves the approved original, then becomes the authoritative resend target', async () => {
    try {
      const original = resources.generic, prior = await rowFor(original), id = randomUUID(), token = 'owned_revised_final_quote_token_12345'
      const final = { ...original, id, token, priceText: '880' }
      const finalRow = { ...prior, id, share_token: token, parent_quote_id: original.id, quote_kind: 'final', status: 'awaiting_tradie_approval',
        sent_at: null, customer_released_at: null, customer_released_by: null, paid_at: null, price_hold_until: null,
        better: { ...prior.better, total_ex_gst: 700, subtotal_ex_gst: 700, total_inc_gst: 770 }, total_inc_gst: 770,
        pdf_path: null, created_at: '2026-09-08T01:00:00Z' }
      await db.seed('quotes', [finalRow])
      const staleRevision = await review(final)
      // A saved owner edit changes the reviewed numbers. The editing action
      // itself is outside this seeded approval/resend composition.
      const changed = { ...finalRow.better, subtotal_ex_gst: 800, total_ex_gst: 800, total_inc_gst: 880,
        line_items: [{ description: 'Revised final scope', quantity: 2, unit_price_ex_gst: 400, total_ex_gst: 800 }] }
      await db.client.from('quotes').update({ better: changed, total_inc_gst: 880 }).eq('id', id)
      await seedGenericPdfCache(final)
      await db.client.from('quotes').update({ paid_at: '2026-09-08T00:30:00Z', paid_tier: 'inspection' }).eq('id', original.id)
      expect(await render(original)).toContain('550')
      expect(await render(final)).not.toContain('880')
      expect((await pdf(final)).status).toBe(403)
      const count = h.carrier.length
      expect((await approve(final, staleRevision)).status).toBe(409)
      expect(h.carrier).toHaveLength(count)
      expect((await approve(final, await review(final))).status).toBe(200)
      expect(h.carrier).toHaveLength(count + 1)
      await expect(render(original)).rejects.toThrow(`REDIRECT:/q/${token}`)
      expect(await render(final)).toContain('880')
      const finalPdf = await pdf(final)
      expect(finalPdf.status).toBe(200); expect(await finalPdf.text()).toContain('saved price 880')
      const references = await lookupCustomerQuotes({ supabase: db.client, tenantId: TENANT, customerPhone: original.phone })
      expect(references.map(row => row.id)).toEqual([id])
      const turnId = randomUUID(), sent = await resend(final, original.conversationIds[1], turnId)
      expect((await resend(final, original.conversationIds[1], turnId)).outboxId).toBe(sent.outboxId)
      expect(h.carrier).toHaveLength(count + 2)
      expect((await rowFor(original)).better).toEqual(prior.better)
      resources.final = final
      evidence.additionalScenarios.push({ scenario: 'revised-final', passed: true, originalId: original.id, finalId: id, token,
        staleApprovalStatus: 409, originalPageRedirect: `/q/${token}`, pdfStatus: 200, resendOutboxId: sent.outboxId })
    } catch (error) { evidence.failedTests.push({ scenario: 'revised-final', message: String(error) }); throw error }
  }, 20000)

  it('multiple approved jobs require owned selection and never accept another tenant reference', async () => {
    try {
      const final = resources.final
      expect(final).toBeDefined()
      const existing = await rowFor(final), intakeId = randomUUID(), id = randomUUID(), token = 'owned_second_job_quote_token_12345'
      await db.seed('intakes', [{ id: intakeId, tenant_id: TENANT, address: '42 Different Road, Sydney NSW 2000', trade: 'electrical', job_type: 'power_points', caller: { phone: final.phone } }])
      await db.seed('quotes', [{ ...existing, id, intake_id: intakeId, share_token: token, parent_quote_id: null, quote_kind: 'initial', created_at: '2026-09-08T02:00:00Z' }])
      const args = { supabase: db.client, tenantId: TENANT, customerPhone: final.phone }
      const offered = await handleExistingQuoteAction({ ...args, text: 'Please send the quote link again' })
      expect(offered.reference).toBeUndefined(); expect(offered.candidates).toHaveLength(2)
      expect(offered.reply).toMatch(/Which job/i); expect(offered.reply).not.toMatch(/https?:/i)
      const finalIndex = offered.candidates.findIndex(candidate => candidate.id === final.id)
      const selected = await handleExistingQuoteAction({ ...args, text: String(finalIndex + 1), selectionCandidates: offered.candidates })
      expect(selected.reference.id).toBe(final.id); expect(selected.reply).toContain(`/q/${final.token}`)
      const invalid = await handleExistingQuoteAction({ ...args, text: '1', selectionCandidates: [{ family: 'generic', id: randomUUID() }] })
      expect(invalid.reference).toBeUndefined(); expect(invalid.reply).not.toMatch(/https?:/i)
      const otherTenant = await handleExistingQuoteAction({ ...args, tenantId: '99999999-9999-4999-8999-999999999999', text: 'quote link again', preferredReference: { family: 'generic', id: final.id } })
      expect(otherTenant.reference).toBeUndefined(); expect(otherTenant.reply).not.toContain(final.token)
      const count = h.carrier.length, turnId = randomUUID()
      const dispatch = () => withSmsDeliveryContext({ tenantId: TENANT, conversationId: final.conversationIds[1], turnId }, () =>
        dispatchQuoteMessage({ tenantId: TENANT, to: final.phone, from: TO, audience: 'customer', text: selected.reply }))
      const sent = await dispatch(); expect(sent.ok).toBe(true)
      expect((await dispatch()).outboxId).toBe(sent.outboxId); expect(h.carrier).toHaveLength(count + 1)
      expect(h.unexpected).toEqual([])
      evidence.additionalScenarios.push({ scenario: 'multiple-jobs-owned-selection', passed: true, offeredIds: offered.candidates.map(candidate => candidate.id),
        selectedId: final.id, otherTenantTokenExposed: false, selectedOutboxId: sent.outboxId })
    } catch (error) { evidence.failedTests.push({ scenario: 'multiple-jobs-owned-selection', message: String(error) }); throw error }
  }, 20000)

  it.each(['generic','paint'])('%s: proven SMS origin receives exactly one accepted initial transcript across owner approval replay', async family => {
    try {
      const original = resources[family], previous = await rowFor(original), id = randomUUID(), conversationId = randomUUID()
      const phone = family === 'generic' ? '+61411111188' : '+61411111189', token = `owned_sms_origin_${family}_token_12345`
      const resource = { ...original, id, phone, token }
      const saved = { ...previous, id, customer_phone: phone, released_at: null, confirmed_at: null,
        sent_at: null, paid_at: null, customer_released_at: null, customer_released_by: null }
      const conversation = { id: conversationId, tenant_id: TENANT, from_number: phone, to_number: TO, status: 'done', conversation_type: 'customer_quote' }
      if (family === 'generic') {
        const intakeId = randomUUID()
        await db.seed('intakes', [{ id: intakeId, tenant_id: TENANT, address: 'SMS origin electrical work', trade: 'electrical', job_type: 'power_points', caller: { phone } }])
        Object.assign(saved, { intake_id: intakeId, share_token: token, quote_kind: 'initial', parent_quote_id: null, status: 'awaiting_tradie_approval' })
        Object.assign(conversation, { quote_id: id, intake_id: intakeId })
      } else saved.public_token = token
      await db.seed(tables[family], [saved])
      await db.seed('sms_conversations', [conversation])
      await db.seed('sms_human_tasks', [{ tenant_id: TENANT, customer_phone: phone, conversation_id: conversationId,
        request_key: `origin:${family}:${id}`, trade: family, reason: 'Review this saved SMS draft', resource_type: family, resource_id: id, status: 'notified' }])
      const count = h.carrier.length
      const correctionConversationId = randomUUID(), correctionReceipt = `SM-correction-${family}-${id}`, correctionTurn = randomUUID()
      await db.seed('sms_conversations', [{ id: correctionConversationId, tenant_id: TENANT, from_number: phone, to_number: TO,
        status: 'open', conversation_type: 'customer_quote', conversation_state: { slots: {}, sources: {} } }])
      const beforeCorrection = await rowFor(resource)
      const change = { supabase: db.client, tenantId: TENANT, customerPhone: phone, fromNumber: TO,
        conversationId: correctionConversationId, receiptId: correctionReceipt, trade: family === 'paint' ? 'painting' : 'electrical',
        text: 'Please change the address to 22 New Road, Sydney NSW 2000.' }
      // Real helper/task/SQL/dispatch composition. The inbound POST and durable
      // receipt claim are covered separately; do not seed a correction task.
      const correction = await handleSavedJobCorrection(change)
      expect(correction).toMatchObject({ handled: true, reference: { family, id } })
      expect(correction.reply).toBe(CORRECTION_ACK)
      const sendCorrection = () => withSmsDeliveryContext({ tenantId: TENANT, conversationId: correctionConversationId, turnId: correctionTurn }, () =>
        dispatchQuoteMessage({ tenantId: TENANT, to: phone, from: TO, text: correction.reply, deliveryKey: `correction-fixture:${correctionReceipt}` }))
      const correctionSend = await sendCorrection()
      expect(correctionSend.ok).toBe(true)
      expect((await handleSavedJobCorrection(change)).reply).toBe(correction.reply)
      expect((await sendCorrection()).outboxId).toBe(correctionSend.outboxId)
      const correctionTasks = await db.client.from('sms_human_tasks').select('*').eq('tenant_id', TENANT).eq('request_key', `sms-correction:${correctionReceipt}`)
      expect(correctionTasks.data).toHaveLength(1)
      expect(correctionTasks.data[0]).toMatchObject({ conversation_id: correctionConversationId, resource_type: family, resource_id: id, status: 'notified' })
      expect(correctionTasks.data[0].reason).toContain(change.text)
      expect(await rowFor(resource)).toEqual(beforeCorrection)
      const approved = await approve(resource, await review(resource))
      expect(approved.status).toBe(200)
      expect((await approved.json()).accepted).toBe(true)
      const intent = await db.client.from('sms_outbox').select('*').eq('to_number', phone).eq('conversation_id', conversationId).single()
      expect(intent.data).toMatchObject({ conversation_id: conversationId, tenant_id: TENANT, status: 'accepted' })
      const transcript = await db.client.from('sms_messages').select('*').eq('outbox_id', intent.data.id).single()
      expect(transcript.data).toMatchObject({ conversation_id: conversationId, tenant_id: TENANT, body: intent.data.body,
        twilio_message_sid: intent.data.provider_sid, direction: 'outbound', delivery_status: 'accepted' })
      expect((await approve(resource, await review(resource))).status).toBe(200)
      if (family === 'generic') {
        const manualReplay = await sendGeneric(request(`/api/quote/${id}/send`, { channel: 'sms',
          expected_revision: await review(resource) }), { params: Promise.resolve({ id }) })
        expect(manualReplay.status).toBe(200)
        expect((await manualReplay.json()).outboxId).toBe(intent.data.id)
      }
      expect(h.carrier).toHaveLength(count + 3)
      const after = await db.client.from('sms_messages').select('*').eq('outbox_id', intent.data.id)
      expect(after.data).toHaveLength(1)
      expect(h.unexpected).toEqual([])
      evidence.additionalScenarios.push({ scenario: 'accepted-initial-origin-transcript', family, passed: true, id, conversationId,
        outboxId: intent.data.id, transcriptId: transcript.data.id, acceptedSid: intent.data.provider_sid, carrierCalls: 3,
        correction: { conversationId: correctionConversationId, taskId: correctionTasks.data[0].id, outboxId: correctionSend.outboxId,
          taskCreatedByActualHelper: true, originalSnapshotUnchanged: true, originalApprovalConversationPreserved: true } })
    } catch (error) { evidence.failedTests.push({ scenario: 'accepted-initial-origin-transcript', family, message: String(error) }); throw error }
  }, 20000)
})
