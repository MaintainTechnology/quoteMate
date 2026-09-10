import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createToolReleaseFixture } from '../scripts/sms-created-tool-release-fixture.mjs'

// Actual tool routes, rate loaders, pricers, row shaping and persistence helpers.
// Auth, PostgREST-shaped storage and optional PDF/filestore providers are fixtures.
const h = vi.hoisted(() => ({
  tables: {}, errors: [], calls: [], pdfHtml: [], pdfErrors: [], nextId: 0, failures: {}, planCalls: 0,
  tenant: { id: '11111111-1111-4111-8111-111111111111', trade: 'commercial_painting', owner_user_id: '22222222-2222-4222-8222-222222222222' },
  from: null, rpc: null, pricingProof: null, pricedAt: null,
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  from: (...args) => h.from(...args),
  storage: { from: () => ({ upload: async () => ({ error: null }) }) },
}) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => ({
  identity: { provider: 'clerk', userId: 'user_offline', email: null }, tenant: h.tenant,
}) }))
vi.mock('@/lib/estimation/auth', () => ({
  tenantFromBearer: async () => h.tenant,
  estimatorSupabase: { from: (...args) => h.from(...args), rpc: (...args) => h.rpc(...args) },
}))
vi.mock('@/lib/aircon/location', () => ({ resolveAcLocationEvidence: async () => ({ building: { ok: false } }) }))
vi.mock('@/lib/aircon/plan-extract', () => ({
  PLAN_MEDIA_TYPES: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  LOAD_TYPE_BY_ROOM: { bedroom: 'bedroom', study: 'bedroom', living: 'living', kitchen: 'living' },
  runPlanExtraction: async () => {
    h.planCalls++
    if (h.failures.plan) throw new Error('The model fixture is unavailable')
    return { model: 'offline-model', runtimeSeconds: 1, parsed: {
      page: 1, rooms: [
        { name: 'Bed 1', room_type: 'bedroom', polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], area_m2: 12, confidence: 'high' },
        { name: 'Living', room_type: 'living', polygon: [{ x: 20, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }], area_m2: 32, confidence: 'high' },
      ], stated_total_area_m2: null, overall_note: '',
    } }
  },
}))
vi.mock('next/server', () => ({ after: () => {} }))
vi.mock('@/lib/pdf/branding', () => ({ loadTenantBranding: async () => ({ businessName: 'Offline Painting' }) }))
vi.mock('@/lib/pdf/gotenberg', async (importOriginal) => ({
  ...await importOriginal(),
  gotenbergConfigured: () => true,
  renderPdfFromHtml: async (html) => { h.pdfHtml.push(html); return Buffer.from('%PDF-offline') },
}))
vi.mock('@/lib/filestore/ingest-quote', () => ({ archiveAndIngestQuote: async () => {} }))
vi.mock('@/lib/filestore/minimize', () => ({ buildQuoteKbText: () => ({ markdown: 'offline', contentHash: 'offline' }) }))
vi.mock('@/lib/filestore/provision', () => ({ provisionSessionStore: async () => {} }))
vi.mock('@/lib/stripe/checkout', () => ({ generateShareToken: () => `offline_saved_token_${++h.nextId}` }))
vi.mock('@/lib/log/pipeline', () => ({ pipelineLog: () => ({ ok: () => {}, err: (message, error) => { if (error) h.pdfErrors.push(`${message}: ${error.stack ?? error}`) } }) }))

import { POST as recommend } from '@/app/api/aircon/recommend/route'
import { POST as recommendPlan } from '@/app/api/aircon/plan/route'
import { POST as pricePaint } from '@/app/api/tenant/commercial-painting/price/route'
import { POST as savePaint } from '@/app/api/tenant/commercial-painting/save-quote/route'

const tenantId = h.tenant.id
const runId = 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee'
const extractionId = 'bbbbbbbb-cccc-4ddd-aeee-ffffffffffff'
const requestId = '55555555-5555-4555-8555-555555555555'
// PostgREST/JSONB removes undefined object fields, unlike structuredClone.
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const item = { surface: 'Internal walls', room: 'Retail', substrate: 'plasterboard', system: 'low_sheen', unit: 'm2', quantity: 100, coats: 2, confidence: 'high', source: 'plan' }
const acCard = {
  split: { per_head: { '2.5': 1200, '3.5': 1500, '5': 2000, '7': 2700, '8': 3200 }, multi_head_discount_pct: 0.05 },
  ducted: { rate_per_kw: 1250, base_ex_gst: 4500, per_zone: 400, min_ex_gst: 8500 }, gst_registered: true,
}
const acBody = {
  request_id: requestId,
  address: { address: '12 Example St, Sydney', postcode: '2000', state: 'NSW' },
  inputs: { bedrooms: 3, bathrooms: 2, living_spaces: 2, storeys: 1, floor_area_m2: 150, ceiling_height: 'standard', insulation: 'average', current_situation: 'replacing' },
}
const paintRows = [
  { kind: 'labour', code: 'labour:low_sheen:roller', label: 'Tenant labour', system: 'low_sheen', method: 'roller', coverage_m2_per_hr: 10 },
  { kind: 'material', code: 'mat:wall_low_sheen', label: 'Tenant paint', system: 'low_sheen', product: 'Tenant low sheen', spread_m2_per_l: 15, price_per_l_ex_gst: 11 },
  ...Object.entries({ height_low: 1, height_mid: 1.25, height_high: 1.4, prep_pct: 0.1, sundries_pct: 0.08, labour_rate: 95, crew_hours_per_day: 7.6, default_crew_size: 3 })
    .map(([key, value]) => ({ kind: 'modifier', code: `mod:${key}`, label: key, value })),
].map((row) => ({ ...row, tenant_id: tenantId, trade: 'commercial_painting', is_default: false }))

function installDatabase() {
  h.from = (table) => {
    if (!(table in h.tables)) { h.errors.push(`Unexpected table ${table}`); throw new Error(h.errors.at(-1)) }
    const filters = []; let operation = 'select'; let payload; let single = false; let selected = false; let upsertOptions = {}
    const q = {
      select() { selected = true; return q },
      eq(key, value) { filters.push((row) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? String(row[key]).toLowerCase() === value.toLowerCase() : row[key] === value); return q },
      is(key, value) { filters.push((row) => (row[key] ?? null) === value); return q },
      or(value) { if (value !== `tenant_id.is.null,tenant_id.eq.${tenantId}`) { h.errors.push(`Unexpected or ${value}`); throw new Error(h.errors.at(-1)) }; filters.push((row) => row.tenant_id == null || row.tenant_id === tenantId); return q },
      limit() { return q },
      insert(value) { operation = 'insert'; payload = value; return q },
      upsert(value, options = {}) { operation = 'upsert'; payload = value; upsertOptions = options; return q },
      update(value) { operation = 'update'; payload = value; return q },
      single() { single = true; return q },
      maybeSingle() { single = true; return q },
      then(resolve, reject) {
        try {
          h.calls.push({ table, operation, payload: copy(payload) })
          if (operation === 'select' && h.failures.read === table) return Promise.resolve({ data: null, error: { code: 'offline_read_unavailable' } }).then(resolve, reject)
          let rows = h.tables[table].filter((row) => filters.every((fn) => fn(row)))
          if (operation === 'update' && table === 'plan_extractions' && payload.sheets_used?.saved_quote && h.failures.checkpoint) return Promise.resolve({ data: null, error: { code: 'offline_checkpoint_loss' } }).then(resolve, reject)
          if (operation === 'update' && table === 'intakes' && payload.caller && h.failures.customer) return Promise.resolve({ data: null, error: { code: 'offline_customer_loss' } }).then(resolve, reject)
          if (operation === 'insert' || operation === 'upsert') {
            if (h.failures.insert === table) return Promise.resolve({ data: null, error: { code: 'offline_insert_unavailable' } }).then(resolve, reject)
            const value = copy(payload)
            value.id ??= `offline-row-${++h.nextId}`
            const prior = h.tables[table].find((row) => row.id === value.id || (value.public_token && row.public_token === value.public_token))
            if (prior) {
              if (operation !== 'upsert' || !upsertOptions.ignoreDuplicates) return Promise.resolve({ data: null, error: { code: '23505' } }).then(resolve, reject)
              rows = []
            } else {
              h.tables[table].push(value); rows = [value]
              if (h.failures.insertAfterCommit === table) { h.failures.insertAfterCommit = null; return Promise.resolve({ data: null, error: { code: 'offline_lost_commit_response' } }).then(resolve, reject) }
            }
          } else if (operation === 'update') { for (const row of rows) Object.assign(row, copy(payload)) }
          const data = operation === 'select' || selected ? copy(single ? rows[0] ?? null : rows) : null
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        } catch (error) { h.errors.push(error.message); return Promise.reject(error).then(resolve, reject) }
      },
    }
    return q
  }
}
const post = (handler, path, body) => handler(new Request(`https://web.quotemax.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const priceRequest = async () => {
  const response = await post(pricePaint, '/api/tenant/commercial-painting/price', { paintRunId: runId, extractionId })
  if (response.ok) {
    const priced = await response.clone().json()
    expect(priced.pricingProof).toMatch(/^[a-f0-9]{64}$/)
    expect(priced.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    h.pricingProof = priced.pricingProof
    h.pricedAt = priced.pricedAt
  }
  return response
}
const saveRequest = () => post(savePaint, '/api/tenant/commercial-painting/save-quote', {
  paintRunId: runId, extractionId, customerPhone: '0412345678', customerName: 'Sam', pricingProof: h.pricingProof, pricedAt: h.pricedAt,
})
const planRequest = (bytes = '%PDF original plan') => {
  const form = new FormData()
  form.append('request_id', requestId)
  form.append('address', JSON.stringify(acBody.address))
  form.append('inputs', JSON.stringify(acBody.inputs))
  form.append('plan', new File([bytes], 'floor-plan.pdf', { type: 'application/pdf' }))
  return recommendPlan(new Request('https://web.quotemax.example/api/aircon/plan', { method: 'POST', body: form }))
}

let commercial
const commercialState = { unexpected: [], pdfs: new Map(), downloads: [] }
async function commercialRows(table) {
  expect(['quotes', 'intakes', 'plan_extractions', 'paint_runs'].includes(table)).toBe(true)
  const result = await commercial.pg.query(`select to_jsonb(t) as row from ${table} t order by id`)
  return result.rows.map(value => value.row)
}
async function installCommercialDatabase() {
  commercial ??= await createToolReleaseFixture(fileURLToPath(new URL('../', import.meta.url)), commercialState, tenantId)
  await commercial.pg.exec('truncate quotes,intakes,plan_extractions,paint_runs,pricing_book,tenants cascade')
  await commercial.seed('tenants', [h.tenant])
  await commercial.seedCommercialRates(paintRows)
  for (const table of ['pricing_book', 'paint_runs', 'plan_extractions']) await commercial.seed(table, h.tables[table])
  h.errors = commercialState.unexpected
  h.from = table => {
    const query = commercial.client.from(table)
    let operation = 'select', payload, terminal, promise
    const execute = () => promise ??= (async () => {
      h.calls.push({ table, operation, payload: copy(payload) })
      if (operation === 'update' && table === 'plan_extractions' && payload?.sheets_used?.saved_quote && h.failures.checkpoint)
        return { data: null, error: { code: 'offline_checkpoint_loss' } }
      if (operation === 'update' && table === 'intakes' && payload?.caller && h.failures.customer)
        return { data: null, error: { code: 'offline_customer_loss' } }
      return terminal ? query[terminal]() : await query
    })()
    const wrapper = new Proxy({}, { get: (_, key) => {
      if (key === 'then') return (resolve, reject) => execute().then(resolve, reject)
      if (key === 'maybeSingle' || key === 'single') return () => { terminal = key; return wrapper }
      return (...args) => {
        if (key === 'update' || key === 'insert' || key === 'upsert') { operation = key; payload = args[0] }
        query[key](...args); return wrapper
      }
    } })
    return wrapper
  }
  h.rpc = (name, args) => {
    const result = (async () => {
      if (name === 'save_commercial_paint_quote' && h.failures.sqlInsertTarget) {
        // Invoke the actual transaction while the explicitly targeted physical
        // insert trigger fails. A quote failure rolls its intake back too.
        const parameters = ['p_tenant_id','p_run_id','p_extraction_id','p_source','p_proof','p_bom','p_priced_at','p_intake','p_quote']
        expect(Object.keys(args).sort()).toEqual([...parameters].sort())
        try {
          await commercial.pg.query(`select save_commercial_paint_quote(${parameters.map((_, i) => `$${i + 1}`).join(',')})`,
            parameters.map(key => ['p_source','p_proof','p_bom','p_intake','p_quote'].includes(key) ? JSON.stringify(args[key]) : args[key]))
          throw new Error('Injected physical insert failure did not execute')
        } catch (error) {
          expect(error.code).toBe('ZX001')
          expect(error.message).toBe(`offline ${h.failures.sqlInsertTarget} insert unavailable`)
          h.calls.push({ rpc: name, forcedSqlFailure: h.failures.sqlInsertTarget })
          return { data: null, error: { code: error.code, message: error.message } }
        }
      }
      const output = await commercial.client.rpc(name, args)
      if (name === 'save_commercial_paint_quote' && !output.error && h.failures.insertAfterCommit === 'quotes') {
        h.failures.insertAfterCommit = null
        return { data: null, error: { code: 'offline_lost_commit_response' } }
      }
      return output
    })()
    return Object.assign(result, { abortSignal(signal) { signal.throwIfAborted(); return result } })
  }
}

beforeEach(async ({ task }) => {
  h.errors = []; h.calls = []; h.pdfHtml = []; h.pdfErrors = []; h.nextId = 0; h.failures = {}; h.planCalls = 0
  h.pricingProof = null; h.pricedAt = null; commercialState.unexpected.length = 0
  h.tables = {
    pricing_book: [{ id: '66666666-6666-4666-8666-666666666666', tenant_id: tenantId, trade: 'commercial_painting', gst_registered: true, overlays: { aircon_rate_card: copy(acCard) } }],
    paint_rates: copy(paintRows),
    paint_runs: [{ id: runId, tenant_id: tenantId, job_name: 'Retail repaint', site_address: '12 Example St', status: 'ready', public_token: null }],
    plan_extractions: [{ id: extractionId, tenant_id: tenantId, trade: 'commercial_painting', paint_run_id: runId, items: [copy(item)], corrected_items: null, sheets_used: {}, priced_bom: null, priced_at: null }],
    intakes: [], quotes: [], aircon_recommendations: [],
  }
  installDatabase()
  h.rpc = name => { h.errors.push(`Unexpected aircon RPC ${name}`); throw new Error(h.errors.at(-1)) }
  if (task.name.startsWith('commercial')) await installCommercialDatabase()
  vi.stubEnv('APP_URL', 'https://internal-engine.example')
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://web.quotemax.example')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'offline-idempotency-secret')
  vi.stubGlobal('fetch', async () => { h.errors.push('Unexpected remote fetch'); throw new Error(h.errors.at(-1)) })
})
afterAll(async () => { await commercial?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
afterEach(({ task }) => { if (task.name.startsWith('commercial')) expect(commercialState.unexpected).toEqual([]) })

describe('additional tradie tools keep saved quote identity through retry', () => {
  it('aircon returns the stored recommendation when its request is replayed after rates change', async () => {
    const first = await post(recommend, '/api/aircon/recommend', acBody)
    expect(first.status).toBe(200)
    const initial = await first.json()
    expect(initial.recommendation.pricing_status).toBe('priced')
    expect(h.tables.aircon_recommendations).toHaveLength(1)
    expect(h.tables.aircon_recommendations[0].released_at).toBeUndefined()
    h.tables.pricing_book[0].overlays.aircon_rate_card.ducted.rate_per_kw *= 2
    h.tables.pricing_book[0].overlays.aircon_rate_card.split.per_head['2.5'] *= 2
    const replay = await post(recommend, '/api/aircon/recommend', acBody)
    expect(replay.status).toBe(200)
    const repeated = await replay.json()
    expect(repeated.saved).toEqual(initial.saved)
    expect(repeated.recommendation).toEqual(initial.recommendation)
    const { _request_receipt: receipt, ...storedRecommendation } = h.tables.aircon_recommendations[0].recommendation
    expect(storedRecommendation).toEqual(initial.recommendation)
    expect(receipt.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(repeated).toEqual({ ...initial, replayed: true })
    expect(h.tables.aircon_recommendations).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  it('aircon replays its complete original response without current rates or provider work', async () => {
    const initial = await (await post(recommend, '/api/aircon/recommend', acBody)).json()
    h.tables.pricing_book = []
    h.calls = []
    const replay = await post(recommend, '/api/aircon/recommend', acBody)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ ...initial, replayed: true })
    expect(h.calls.map((call) => call.table)).toEqual(['aircon_recommendations'])
    expect(h.errors).toEqual([])
  })

  it.each(['address', 'inputs'])('aircon rejects changed %s under the same request identity', async (field) => {
    expect((await post(recommend, '/api/aircon/recommend', acBody)).status).toBe(200)
    const before = copy(h.tables.aircon_recommendations)
    const changed = copy(acBody)
    if (field === 'address') changed.address.address = '98 Different Street'
    else changed.inputs.floor_area_m2 = 300
    const response = await post(recommend, '/api/aircon/recommend', changed)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: 'request_id_conflict' })
    expect(h.tables.aircon_recommendations).toEqual(before)
    expect(h.errors).toEqual([])
  })

  it('aircon concurrent different requests cannot pair one token with two price snapshots', async () => {
    const changed = { ...acBody, inputs: { ...acBody.inputs, floor_area_m2: 300 } }
    const responses = await Promise.all([post(recommend, '/api/aircon/recommend', acBody), post(recommend, '/api/aircon/recommend', changed)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(h.tables.aircon_recommendations).toHaveLength(1)
    const successful = await responses.find((response) => response.status === 200).json()
    const { _request_receipt, ...saved } = h.tables.aircon_recommendations[0].recommendation
    expect(successful.recommendation).toEqual(saved)
    expect(_request_receipt.responseContext.location).toEqual(successful.location)
    expect(h.errors).toEqual([])
  })

  it('aircon plan replay retains original geometry, design and prices without another model call', async () => {
    const first = await planRequest()
    expect(first.status).toBe(200)
    const initial = await first.json()
    expect(initial.plan.rooms.length).toBe(2)
    expect(initial.design).toBeTruthy()
    expect(initial.recommendation.pricing_status).toBe('priced')
    h.failures.plan = true
    h.tables.pricing_book = []
    const replay = await planRequest()
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ ...initial, replayed: true })
    expect(h.planCalls).toBe(1)
    const changed = await planRequest('%PDF different bytes')
    expect(changed.status).toBe(409)
    expect(await changed.json()).toEqual({ ok: false, error: 'request_id_conflict' })
    expect(h.planCalls).toBe(1)
    expect(h.tables.aircon_recommendations).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  it('aircon cannot mistake a lookup failure for a new request', async () => {
    h.failures.read = 'aircon_recommendations'
    const response = await post(recommend, '/api/aircon/recommend', acBody)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, error: 'saved_request_unavailable' })
    expect(h.tables.aircon_recommendations).toEqual([])
    expect(h.calls.map((call) => call.table)).toEqual(['aircon_recommendations'])
  })

  it('commercial price→save embeds the public website in its real tender HTML', async () => {
    expect((await priceRequest()).status).toBe(200)
    const response = await saveRequest()
    expect(response.status).toBe(200)
    const quotes = await commercialRows('quotes')
    expect(quotes).toHaveLength(1)
    expect(quotes[0].routing_decision).toBe('tradie_review')
    expect(quotes[0].customer_released_at).toBeNull()
    expect(h.pdfErrors).toEqual([])
    expect(h.pdfHtml).toHaveLength(1)
    expect(h.pdfHtml[0]).toContain(`https://web.quotemax.example/q/${quotes[0].share_token}`)
    expect(h.pdfHtml[0]).not.toContain('https://internal-engine.example')
    expect(h.errors).toEqual([])
  })

  it('commercial checkpoint write failure cannot mint another intake/quote on replay', async () => {
    expect((await priceRequest()).status).toBe(200)
    h.failures.checkpoint = true
    await saveRequest()
    const savedId = (await commercialRows('quotes'))[0]?.id
    h.failures.checkpoint = false
    const replay = await saveRequest()
    expect(replay.status).toBe(200)
    expect(await commercialRows('intakes')).toHaveLength(1)
    expect(await commercialRows('quotes')).toHaveLength(1)
    expect((await replay.json()).quoteId).toBe(savedId)
    expect(h.errors).toEqual([])
  })

  it('commercial lost atomic-save response and parallel retries retain one saved token', async () => {
    expect((await priceRequest()).status).toBe(200)
    h.failures.insertAfterCommit = 'quotes'
    const responses = await Promise.all([saveRequest(), saveRequest()])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 503])
    const unconfirmed = await responses.find(response => response.status === 503).json()
    expect(unconfirmed).not.toHaveProperty('shareToken')
    const retry = await saveRequest(); expect(retry.status).toBe(200)
    const bodies = [await responses.find(response => response.status === 200).json(), await retry.json()]
    const quotes = await commercialRows('quotes')
    expect(quotes).toHaveLength(1)
    expect(await commercialRows('intakes')).toHaveLength(1)
    expect(bodies.map((body) => body.quoteId)).toEqual([quotes[0].id, quotes[0].id])
    expect(bodies.map((body) => body.shareToken)).toEqual([quotes[0].share_token, quotes[0].share_token])
    expect(h.errors).toEqual([])
  })

  it('commercial UUID casing changes cannot create a second quote after projection loss', async () => {
    expect((await priceRequest()).status).toBe(200)
    h.failures.checkpoint = true
    const first = await post(savePaint, '/api/tenant/commercial-painting/save-quote', { paintRunId: runId.toUpperCase(), extractionId: extractionId.toUpperCase(), customerPhone: '0412345678', customerName: 'Sam', pricingProof: h.pricingProof, pricedAt: h.pricedAt })
    expect(first.status).toBe(200)
    const initial = await first.json()
    h.failures.checkpoint = false
    const second = await saveRequest()
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ quoteId: initial.quoteId, shareToken: initial.shareToken, alreadySaved: true })
    expect(await commercialRows('intakes')).toHaveLength(1)
    expect(await commercialRows('quotes')).toHaveLength(1)
  })

  it.each(['intakes', 'quotes'])('commercial failed %s write with no committed row cannot return a link', async (table) => {
    expect((await priceRequest()).status).toBe(200)
    h.failures.sqlInsertTarget = table
    await commercial.pg.exec(`create function sms_tool_insert_failure() returns trigger language plpgsql as $$
      begin raise exception using errcode='ZX001',message='offline ${table} insert unavailable'; end $$;
      create trigger sms_tool_insert_failure before insert on ${table} for each row execute function sms_tool_insert_failure();`)
    try {
      const response = await saveRequest()
      expect(response.status).toBe(503)
      expect(await response.json()).not.toHaveProperty('shareToken')
      expect(await commercialRows('quotes')).toEqual([])
      expect(await commercialRows('intakes')).toEqual([])
      expect(h.calls.filter(call => call.forcedSqlFailure === table)).toHaveLength(1)
    } finally {
      await commercial.pg.exec(`drop trigger sms_tool_insert_failure on ${table}; drop function sms_tool_insert_failure()`)
      h.failures.sqlInsertTarget = null
    }
    expect((await saveRequest()).status).toBe(200)
    expect(await commercialRows('intakes')).toHaveLength(1)
    expect(await commercialRows('quotes')).toHaveLength(1)
  })

  it.each(['source', 'customer', 'legacy'])('commercial %s mismatch keeps the saved quote unchanged and refuses a guessed association', async (kind) => {
    expect((await priceRequest()).status).toBe(200)
    expect((await saveRequest()).status).toBe(200)
    const original = await commercialRows('quotes')
    if (kind === 'source') await commercial.pg.exec(`update intakes set scope=jsonb_set(scope,'{extraction_id}','"cccccccc-dddd-4eee-afff-aaaaaaaaaaaa"')`)
    if (kind === 'customer') await commercial.pg.exec(`update intakes set caller=jsonb_set(caller,'{phone}','"+61499999999"')`)
    if (kind === 'legacy') await commercial.pg.exec("update intakes set scope=scope-'extraction_id'")
    const response = await saveRequest()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false, error: 'saved_quote_unverifiable' })
    expect(await commercialRows('quotes')).toEqual(original)
    expect(await commercialRows('intakes')).toHaveLength(1)
  })

  it('commercial customer details persist with the initial draft even if later projection fails', async () => {
    expect((await priceRequest()).status).toBe(200)
    h.failures.customer = true
    const response = await saveRequest()
    expect(response.status).toBe(200)
    expect((await commercialRows('intakes'))[0].caller).toMatchObject({ name: 'Sam', phone: '+61412345678' })
    expect(h.errors).toEqual([])
  })
})
