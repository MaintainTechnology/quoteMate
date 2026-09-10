import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Narrow composition: actual pricing and persistence glue, fixture database and
// delivery transport. F17 starts at the SMS dispatcher, not inbound dialog.
const h = vi.hoisted(() => {
  const state = { db: null, sent: [], unexpected: [] }
  const paintPrice = vi.fn()
  const clone = value => JSON.parse(JSON.stringify(value))
  const client = { from: table => state.db.from(table) }
  const send = vi.fn(async args => {
    state.sent.push(clone(args))
    return { ok: true, outboxId: `fixture-intent-${state.sent.length}`, sid: `SM-fixture-${state.sent.length}` }
  })
  function database(seed) {
    const rows = new Map(Object.entries(clone(seed)))
    const operations = []
    let nextId = 1
    return { rows, operations, from(table) {
      const filters = []
      let action = 'read', payload, single = false, options = {}
      const query = {
        select: () => query,
        eq: (key, value) => { filters.push([key, value]); return query },
        single: () => { single = true; return query },
        maybeSingle: () => { single = true; return query },
        insert: value => { action = 'insert'; payload = value; return query },
        upsert: (value, settings = {}) => { action = 'upsert'; payload = value; options = settings; return query },
        update: value => { action = 'update'; payload = value; return query },
        then: (fulfilled, rejected) => Promise.resolve().then(() => {
          if (!rows.has(table)) {
            state.unexpected.push(`Unregistered fixture table ${table}`)
            throw new Error(`Unregistered fixture table ${table}`)
          }
          operations.push({ table, action, filters: clone(filters) })
          let found = rows.get(table).filter(row => filters.every(([key, value]) => row[key] === value))
          if (action === 'insert' || action === 'upsert') {
            const keys = String(options.onConflict ?? 'id').split(',')
            const existing = action === 'upsert' && rows.get(table).find(row => keys.every(key => row[key] === payload[key]))
            if (existing) found = [existing]
            else {
              const saved = { id: `${table}-${nextId++}`, ...(table === 'sms_human_tasks' ? { status: 'open' } : {}), ...clone(payload) }
              rows.get(table).push(saved); found = [saved]
            }
          } else if (action === 'update') for (const row of found) Object.assign(row, clone(payload))
          return { data: clone(single ? found[0] ?? null : found), error: null }
        }).then(fulfilled, rejected),
      }
      return query
    } }
  }
  return { state, database, client, send, paintPrice }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: h.send }))
vi.mock('@/lib/painting/pricing', async original => {
  const actual = await original()
  h.paintPrice.mockImplementation(actual.calculatePaintingPrice)
  return { ...actual, calculatePaintingPrice: h.paintPrice }
})
vi.mock('@/lib/quote/pdf', () => ({
  ensurePaintingPdf: () => { h.state.unexpected.push('PDF generation'); throw new Error('Held parity must not generate a customer PDF') },
  signQuotePdfUrl: () => { h.state.unexpected.push('PDF signing'); throw new Error('Held parity must not sign a customer PDF') },
}))
import { POST as paintingFormPost } from '@/app/api/paint-request/[token]/route'
import { estimateAndDispatchPainting } from '@/lib/sms/painting-estimate-dispatch'
import { loadTenantRoofingPricingContext } from '@/lib/roofing/pricing-authority'
import { priceMultiRoof } from '@/lib/roofing/pricing'

const TENANT = '11111111-1111-4111-8111-111111111111'
const BOOK = '22222222-2222-4222-8222-222222222222'
const CUSTOMER = '+61411111111', OWNER = '+61422222222', TO = '+61488888888'
const WEBSITE = 'https://quotemax.com.au'
const roofCard = {
  reroof_rate_per_m2: { colorbond_corrugated: 151, colorbond_trimdek: 167, colorbond_spandek: 171, colorbond_kliplok: 199, concrete_tile: 141, terracotta_tile: 181, cement_sheet: 211 },
  multi_storey_loading_pct: 0.21, asbestos_loading_pct: 0.36, complexity_loading_pct: 0.16,
  upgrade_material: 'colorbond_trimdek', gst_registered: true, call_out_minimum_ex_gst: 777,
  gutter_rate_per_lm: 43, downpipe_rate_per_each: 231, fascia_rate_per_lm: 59, soffit_rate_per_lm: 67,
  ridge_hip_repoint_rate_per_lm: 19, valley_flashing_rate_per_lm: 49, box_gutter_rate_per_lm: 79,
  price_edge_works: true, solar_detach_reinstate_base_ex_gst: 1300, solar_detach_reinstate_per_array_ex_gst: 550,
}
const paintCard = {
  rate_per_unit: { walls: 37, ceilings: 23, trim: 17, exterior: 59 },
  coats_multiplier: { 1: 0.7, 2: 1, 3: 1.35 }, condition_multiplier: { sound: 1, minor: 1.15, bare: 1.4 },
  colour_change_extra: 0.11, good_refresh_fraction: 0.73, premium_uplift_pct: 0.29,
  double_storey_loading_pct: 0.51, gst_registered: true, call_out_minimum_ex_gst: 551,
  pricing_model: 'sqm', hourly_rate: 97, production_rate_per_unit: { walls: 3, ceilings: 4, trim: 7, exterior: 2 },
}
const brief = { address: { address: '12 Example Road, Sydney NSW 2000', postcode: '2000', state: 'NSW' },
  inputs: { scopes: ['walls'], coats: 2, condition: 'sound', ceiling_height: 'standard', storeys: 1, colour_change: false, manual_floor_area_m2: 180 } }
const slots = { ...brief.address, ...brief.inputs, address_confirmed: true }
const clone = value => JSON.parse(JSON.stringify(value))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const testPath = fileURLToPath(import.meta.url), appDirectory = resolve(dirname(testPath), '..')
const canonicalHashes = Object.fromEntries([
  'lib/roofing/pricing-authority.ts', 'lib/roofing/pricing.ts', 'app/api/paint-request/[token]/route.ts',
  'lib/sms/painting-estimate-dispatch.ts', 'lib/painting/quote-dispatch.ts', 'lib/painting/measure.ts',
  'lib/painting/complete-rate-card.ts',
  'lib/painting/pricing.ts', 'lib/painting/save-row.ts', 'lib/sms/human-handoff.ts',
].map(path => { const absolute = join(appDirectory, path); return [absolute, hash(absolute)] }))
const evidence = { scope: 'Offline F16 pricing parity and F17 painting form/SMS dispatcher composition', canonicalHashes, results: [], failedTests: [] }

function paintingDb() {
  return h.database({
    pricing_book: [{ id: BOOK, tenant_id: TENANT, trade: 'painting', overlays: { painting_rate_card: clone(paintCard) } }],
    painting_measurements: [], sms_human_tasks: [],
    tenants: [{ id: TENANT, owner_mobile: OWNER, twilio_sms_number: TO }],
    sms_conversations: [{ id: 'conversation-parity' }],
    painting_lead_requests: [{ token: 'form-parity', tenant_id: TENANT, customer_phone: CUSTOMER, conversation_id: 'conversation-parity', status: 'new' }],
  })
}

function boundRoofCandidate() {
  const fleet = resolve(process.env.QM_PARITY_FLEET)
  const readyPath = join(fleet, 'final-validation-2026-09-09/final-ready.json')
  const ready = JSON.parse(readFileSync(readyPath, 'utf8'))
  expect(ready.ready).toBe(true); expect(resolve(ready.candidateRoot)).toBe(fleet)
  const candidate = join(fleet, 'qm-roofing-receptionist')
  const release = ready.services.find(row => row.trade === 'roofing')
  expect(resolve(release.directory)).toBe(candidate)
  expect(resolve(release.manifestPath)).toBe(join(candidate, 'release-manifest.json'))
  expect(resolve(release.attestationPath)).toBe(join(candidate, 'build-attestation.json'))
  expect(hash(release.manifestPath)).toBe(release.manifestSha256)
  expect(hash(release.attestationPath)).toBe(release.attestationSha256)
  const attestation = JSON.parse(readFileSync(release.attestationPath, 'utf8'))
  expect(attestation.sourceHash).toBe(release.sourceHash)
  function walk(directory, paths = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path, paths)
      else { expect(entry.isFile()).toBe(true); paths.push(relative(candidate, path).replaceAll('\\', '/')) }
    }
    return paths.sort()
  }
  const paths = walk(join(candidate, 'dist'))
  expect(paths).toEqual(Object.keys(attestation.compiledHashes).sort())
  for (const path of paths) expect(hash(join(candidate, path))).toBe(attestation.compiledHashes[path])
  const watched = [readyPath, release.manifestPath, release.attestationPath, ...paths.map(path => join(candidate, path))]
  const hashes = Object.fromEntries(watched.map(path => [path, hash(path)]))
  return { candidate, release, hashes, verify: () => {
    expect(walk(join(candidate, 'dist'))).toEqual(paths)
    for (const [path, expected] of Object.entries(hashes)) expect(hash(path)).toBe(expected)
  } }
}

beforeEach(() => {
  onTestFailed(({ task }) => { evidence.failedTests.push(task.name) })
  vi.clearAllMocks(); h.state.sent = []; h.state.unexpected = []
  vi.stubEnv('PUBLIC_WEB_ORIGIN', WEBSITE)
  for (const key of ['GOOGLE_MAPS_API_KEY', 'GEOSCAPE_API_KEY', 'PROPRADAR_API', 'DOMAIN_API_KEY', 'DOMAIN_API']) vi.stubEnv(key, '')
  vi.stubGlobal('fetch', vi.fn(() => { h.state.unexpected.push('external fetch'); throw new Error('External IO prohibited in parity test') }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
afterAll(() => {
  for (const [path, expected] of Object.entries(canonicalHashes)) expect(hash(path)).toBe(expected)
  if (!process.env.QM_PARITY_REPORT) return
  const path = resolve(process.env.QM_PARITY_REPORT)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...evidence, completed: evidence.results.length === 2 && evidence.failedTests.length === 0,
    testSha256: hash(testPath), generatedAt: new Date().toISOString(),
    limits: ['F16 fixes measurement facts and executes authority lookup/pricing in platform and compiled service; it does not run rooftop providers or HTTP ingress.',
      'F17 executes platform form POST and real SMS dispatcher, real estimator/area/pricer/save/task helpers. SMS inbound dialog and generated painting service are separate journey evidence.',
      'Database query fixture and accepted-dispatch recorder; no SQL/RLS/lease/outbox/carrier delivery certification. Painting uses the existing deterministic property provider with explicit manual floor area and an owned complete persisted rate card.',
      'No customer release, PDF, payment, model or deployed provider workflow runs.'],
  }, null, 2) + '\n')
})

describe('F16/F17 composed parity with actual business code', () => {
  it.skipIf(!process.env.QM_PARITY_FLEET)('F16: approved owned card and identical roof metrics produce identical platform/service quotes', async () => {
    const bound = boundRoofCandidate()
    const load = createRequire(join(bound.candidate, 'package.json'))
    const serviceAuthority = load(join(bound.candidate, 'dist/lib/roofing/pricing-authority.js'))
    const servicePricing = load(join(bound.candidate, 'dist/lib/roofing/pricing.js'))
    const seed = { pricing_book: [
      { id: BOOK, tenant_id: TENANT, trade: 'roofing', overlays: { roofing_rate_card: clone(roofCard) } },
      { id: 'wrong-book', tenant_id: 'another-tenant', trade: 'roofing', overlays: { roofing_rate_card: { ...clone(roofCard), call_out_minimum_ex_gst: 99999 } } },
    ] }
    const platformDb = h.database(seed), serviceDb = h.database(seed)
    const platform = await loadTenantRoofingPricingContext(platformDb, TENANT, 'roofing')
    const service = await serviceAuthority.loadTenantRoofingPricingContext(serviceDb, TENANT, 'roofing')
    expect(platform).not.toBeNull(); expect(service).toEqual(platform)
    expect(service.authority).toMatchObject({ tenant_id: TENANT, pricing_book_id: BOOK })
    expect(service.rateCard.reroof_rate_per_m2.colorbond_corrugated).toBe(151)
    for (const db of [platformDb, serviceDb]) expect(db.operations).toEqual([{ table: 'pricing_book', action: 'read', filters: [['tenant_id', TENANT]] }])
    const structures = [{ buildingId: 'fixed-house', role: 'primary',
      metrics: { footprint_m2: 200, sloped_area_m2: 220, storeys: 1, form: 'gable', hips: 0, valleys: 0, ridge_lm: null, polygon_geojson: null, capture_date: null },
      inputs: { material: 'colorbond_corrugated', pitch: 'standard', building_year_built: 2010, intent: 'full_reroof' } }]
    const platformQuote = priceMultiRoof({ structures: clone(structures), rateCard: platform.rateCard })
    const serviceQuote = servicePricing.priceMultiRoof({ structures: clone(structures), rateCard: service.rateCard })
    expect(serviceQuote).toEqual(platformQuote)
    // The persisted card explicitly applies 16% complexity to every priced roof.
    expect(serviceQuote.combined.tiers[1].ex_gst).toBe(38_535.20)
    expect(serviceQuote.structures[0].price.loadings_applied).toContainEqual(expect.objectContaining({ code: 'complexity', pct: 0.16 }))
    expect(serviceQuote.routing.decision).not.toBe('inspection_required')
    expect(h.state.unexpected).toEqual([])
    bound.verify()
    evidence.results.push({ finding: 'F16', passed: true, tenantId: TENANT, bookId: BOOK, authority: service.authority,
      serviceSourceHash: bound.release.sourceHash, candidateHashes: bound.hashes, quote: serviceQuote })
  })

  it('F17: the same painting brief through real form and SMS dispatcher saves the same held price and review stage', async () => {
    const formDb = paintingDb(); h.state.db = formDb
    const response = await paintingFormPost(new Request(`${WEBSITE}/api/paint-request/form-parity`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(brief),
    }), { params: Promise.resolve({ token: 'form-parity' }) })
    expect(response.status).toBe(200)
    const formResult = await response.json()
    expect(formResult).toMatchObject({ ok: true, stage: 'awaiting_review', texted: false, inspection: false })
    expect(h.paintPrice).toHaveBeenCalledTimes(1)
    const formMessages = clone(h.state.sent)
    const smsDb = paintingDb(); h.state.db = smsDb; h.state.sent = []
    const smsResult = await estimateAndDispatchPainting({ supabase: smsDb, tenantId: TENANT, customerPhone: CUSTOMER,
      firstName: null, baseUrl: WEBSITE, slots: clone(slots), requestKey: 'sms-parity', conversationId: 'conversation-parity',
      sendReply: text => h.send({ tenantId: TENANT, conversationId: 'conversation-parity', to: CUSTOMER, from: TO, audience: 'customer', text }),
    })
    expect(smsResult).toMatchObject({ ok: true, inspection: false, state: { workflow_stage: formResult.stage } })
    expect(h.paintPrice).toHaveBeenCalledTimes(2)
    for (const [input] of h.paintPrice.mock.calls) expect(input.rateCard.rate_per_unit.walls).toBe(37)
    const formRow = formDb.rows.get('painting_measurements')[0], smsRow = smsDb.rows.get('painting_measurements')[0]
    expect(formRow.estimate).toEqual(smsRow.estimate)
    expect(formRow.inputs).toEqual(smsRow.inputs)
    expect(formRow.better_inc_gst).toBeGreaterThan(0)
    for (const db of [formDb, smsDb]) {
      expect(db.rows.get('painting_measurements')).toHaveLength(1)
      expect(db.rows.get('painting_measurements')[0]).toMatchObject({ tenant_id: TENANT, customer_phone: CUSTOMER, released_at: null })
      expect(db.rows.get('sms_human_tasks')).toHaveLength(1)
      expect(db.rows.get('sms_human_tasks')[0]).toMatchObject({ tenant_id: TENANT, resource_type: 'paint', resource_id: db.rows.get('painting_measurements')[0].id, status: 'notified' })
    }
    expect(formDb.rows.get('sms_conversations')[0].painting_state).toMatchObject({ workflow_stage: 'awaiting_review', pending_quote_token: formRow.public_token })
    expect(formDb.rows.get('painting_lead_requests')[0]).toMatchObject({ status: 'submitted', quote_token: formRow.public_token })
    expect(smsResult.token).toBe(smsRow.public_token)
    expect(smsResult.state.pending_quote_token).toBe(smsRow.public_token)
    const customerText = messages => {
      expect(messages.filter(row => row.to === OWNER && row.audience === 'tradie')).toHaveLength(1)
      const customer = messages.filter(row => row.to === CUSTOMER)
      expect(customer).toHaveLength(1)
      expect(customer[0].text).toMatch(/saved.*awaiting review/i)
      expect(customer[0].text).not.toMatch(/https?:|\$|on its way|shortly|has been sent/i)
      return customer[0].text
    }
    expect(customerText(formMessages)).toBe(customerText(h.state.sent))
    expect(h.state.unexpected).toEqual([])
    evidence.results.push({ finding: 'F17', passed: true, tenantId: TENANT, bookId: BOOK, pricedCalls: h.paintPrice.mock.calls.length,
      stage: formResult.stage, releasedAt: formRow.released_at, savedEstimate: formRow.estimate,
      formSavedToken: formRow.public_token, smsSavedToken: smsRow.public_token, customerText: customerText(formMessages) })
  })
})
