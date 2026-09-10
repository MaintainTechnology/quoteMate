import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const state = vi.hoisted(() => ({
  tenant: '11111111-1111-4111-8111-111111111111' as string | null,
  db: null as unknown as PGlite,
  beforeRpc: null as null | (() => Promise<void>),
  badQuoteChange: false,
  engine: vi.fn(),
  externalAfter: vi.fn(),
  rpcCalls: 0,
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  from(table: string) {
    const filters: Array<[string, unknown]> = []
    const query = {
      select: () => query,
      upsert: async () => ({ error: null }), // per-building cache cannot publish a quote
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
      async maybeSingle() {
        const where = filters.map(([key], i) => `"${key}"=$${i + 1}`).join(' and ')
        const result = await state.db.query<{ row: Record<string, unknown> }>(
          `select to_jsonb(t) row from ${table} t where ${where}`, filters.map(([, value]) => value))
        return { data: result.rows[0]?.row ?? null, error: null }
      },
    }
    return query
  },
  async rpc(name: string, args: Record<string, unknown>) {
    state.rpcCalls++
    if (state.beforeRpc) { const operation = state.beforeRpc; state.beforeRpc = null; await operation() }
    const keys = Object.keys(args)
    try {
      const result = await state.db.query<{ row: Record<string, unknown> }>(
        `select ${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(',')}) row`,
        keys.map((key) => typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]))
      return { data: result.rows[0]?.row, error: null }
    } catch (error) { return { data: null, error } }
  },
}) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () =>
  state.tenant ? { tenant: { id: state.tenant } } : null }))
vi.mock('next/server', () => ({ after: state.externalAfter }))
vi.mock('@/lib/roofing/pricing-authority', () => ({ loadTenantRoofingPricingContext: async () =>
  ({ rateCard: {}, authority: { tenant_id: state.tenant, revision: 'current' } }) }))
vi.mock('@/lib/roofing/solar-detect', () => ({ detectSolarForJob: async () => ({ allowance: { applies: false } }) }))
vi.mock('@/lib/roofing/reprice', () => ({ repriceWithEdgeOverrides: (quote: object) => quote }))
vi.mock('@/lib/roofing/selection', () => ({
  structureCount: () => 2,
  sanitizeIndices: (indices: number[]) => indices,
  denormFromSelection: (_quote: unknown, indices: number[]) =>
    ({ structure_count: indices.length, combined_area_m2: 100, combined_better_inc_gst: 1234 }),
}))
vi.mock('@/lib/solar/intake', () => ({ runSolarEstimate: state.engine }))
vi.mock('@/lib/solar/config', () => ({ loadSolarConfig: async () => ({}) }))
vi.mock('@/lib/solar/rate-card-overlay', () => ({ loadSolarTenantRates: async () =>
  ({ config: {}, rateCard: {}, overlay: {} }), loadSolarRateOverlay: async () => ({}), depositPctFromOverlay: () => 10 }))
vi.mock('@/lib/solar/redraft', () => ({
  redraftEligibility: ({ confirmedAt }: { confirmedAt: string | null }) => confirmedAt
    ? { ok: false, error: 'already_released', status: 409 } : { ok: true },
  reconstructSolarInputs: () => ({ input: { address: 'Test address', state: 'NSW', postcode: '2000' } }),
}))
vi.mock('@/lib/solar/persist-helpers', () => ({ buildSolarRowPayloads: () => ({
  solarEstimate: { tenant_id: state.tenant, public_token: 'solar-token', address: 'Test address',
    state: 'NSW', postcode: '2000', estimate: { price: 'new' } },
  quote: { tenant_id: state.tenant, status: 'draft', share_token: 'solar-token',
    ...(state.badQuoteChange ? { column_that_does_not_exist: true } : { total_inc_gst: 9000 }) },
}) }))
vi.mock('@/lib/solar/network-lookup', () => ({ resolveNetworkFromPostcode: () => null }))
vi.mock('@/lib/solar/pylon-aftercheck', () => ({ applyPylonStcCrossCheck: vi.fn() }))
vi.mock('@/lib/solar/opensolar-supplement', () => ({ applyOpenSolarSupplement: vi.fn() }))
vi.mock('@/lib/solar/sun-assets', () => ({ applySolarSunAssets: vi.fn() }))
vi.mock('@/lib/solar/felt-provision', () => ({ applySolarFeltMap: vi.fn() }))
vi.mock('@/lib/solar/ai-brief', () => ({ applySolarAiBrief: vi.fn() }))
vi.mock('@/lib/solar/quote-page-row', () => ({ resolveSolarQuoteView: () => ({ pricesVisible: false }) }))

import { POST as confirm } from '@/app/api/solar/confirm/[token]/route'
import { POST as redraft } from '@/app/api/solar/redraft/[token]/route'
import { POST as selectBuilding } from '@/app/api/solar/q/[token]/select-building/route'
import { PATCH as roofPatch, POST as roofRescan } from '@/app/api/roofing/measurement/[token]/route'
import { roofMeasurementVersion } from '@/lib/roofing/measurement-version'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ROOF = '22222222-2222-4222-8222-222222222222'
const SOLAR = '33333333-3333-4333-8333-333333333333'
const QUOTE = '44444444-4444-4444-8444-444444444444'
const roofCtx = { params: Promise.resolve({ token: 'roof-measure-token' }) }
const solarCtx = { params: Promise.resolve({ token: 'solar-token' }) }
const request = (body: object = {}) => new Request('https://local.test/api/action', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
async function row(table: string, id: string) {
  return (await state.db.query<{ value: Record<string, unknown> }>(`select to_jsonb(t) value from ${table} t where id=$1`, [id])).rows[0].value
}
async function roofBody(body: object = {}) {
  const saved = await row('roofing_measurements', ROOF)
  return { expected_revision: roofMeasurementVersion({ quote: saved.quote, included_indices: saved.included_indices }), included_indices: [1], ...body }
}

beforeAll(async () => {
  state.db = new PGlite()
  await state.db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table roofing_measurements (
      id uuid primary key default gen_random_uuid(),tenant_id uuid,address text,postcode text,state text,provider text,
      customer_name text,customer_phone text,routing text,quote jsonb,structures jsonb,included_indices int[],
      structure_count int,combined_area_m2 numeric,combined_better_inc_gst numeric,public_token text unique,
      measure_token text unique,source_request_key text,released_at timestamptz,confirmed_at timestamptz,
      paid_at timestamptz,pdf_path text,quote_share_token text,unique(tenant_id,source_request_key));
    create table quotes (id uuid primary key,tenant_id uuid,share_token text,status text,total_inc_gst numeric,paid_at timestamptz,sent_at timestamptz);
    create table solar_estimates (id uuid primary key,tenant_id uuid,public_token text,address text,state text,postcode text,
      estimate jsonb,confirmed_at timestamptz,paid_at timestamptz,quote_variant text,pdf_path text,panels_image_path text,panels_image_status text,buildings jsonb);
  `)
  await state.db.exec(readFileSync(resolve('sql/migrations/204_sms_owned_quote_revisions.sql'), 'utf8'))
}, 60000)
afterAll(async () => { await state.db.close() })
beforeEach(async () => {
  state.tenant = TENANT; state.beforeRpc = null; state.badQuoteChange = false; state.rpcCalls = 0
  state.engine.mockReset().mockResolvedValue({ context: {}, routing: { decision: 'auto_quote' }, guardrail_flags: [], config_version: 'new' })
  state.externalAfter.mockReset()
  await state.db.exec('truncate roofing_measurements,solar_estimates,quotes')
  await state.db.query(`insert into roofing_measurements(id,tenant_id,address,quote,structures,included_indices,public_token,measure_token)
    values($1,$2,'Test address','{"structures":[{"role":"primary"},{}]}','[]',array[1,2],'roof-public-token','roof-measure-token')`, [ROOF, TENANT])
  await state.db.query(`insert into solar_estimates(id,tenant_id,public_token,address,state,postcode,estimate,quote_variant)
    values($1,$2,'solar-token','Test address','NSW','2000','{"price":"old"}','instant')`, [SOLAR, TENANT])
  await state.db.query(`insert into quotes(id,tenant_id,share_token,status,total_inc_gst) values($1,$2,'solar-token','draft',8000)`, [QUOTE, TENANT])
})

describe('actual legacy solar confirmation route', () => {
  it('requires the owner and sends first approval to the versioned review screen without a write or callback', async () => {
    state.tenant = null
    expect((await confirm(request(), solarCtx)).status).toBe(401)
    state.tenant = '99999999-9999-4999-8999-999999999999'
    expect((await confirm(request(), solarCtx)).status).toBe(404)
    state.tenant = TENANT
    const response = await confirm(request(), solarCtx)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ reviewUrl: `/dashboard/quote-review?family=solar&id=${SOLAR}` })
    expect((await row('solar_estimates', SOLAR)).confirmed_at).toBeNull()
    expect(state.rpcCalls).toBe(0); expect(state.externalAfter).not.toHaveBeenCalled()
  })
  it('preserves an existing owner approval without resending', async () => {
    await state.db.query('update solar_estimates set confirmed_at=now() where id=$1', [SOLAR])
    const before = await row('solar_estimates', SOLAR)
    expect((await confirm(request(), solarCtx)).status).toBe(200)
    expect(await row('solar_estimates', SOLAR)).toEqual(before)
    expect(state.externalAfter).not.toHaveBeenCalled()
  })
})

describe('actual roofing mutation routes and atomic revision SQL', () => {
  it('rejects anonymous, another tenant, stale editor and paid edits before any mutation', async () => {
    const body = await roofBody()
    state.tenant = null
    expect((await roofPatch(request(body), roofCtx)).status).toBe(401)
    expect((await roofRescan(request(body), roofCtx)).status).toBe(401)
    state.tenant = '99999999-9999-4999-8999-999999999999'
    expect((await roofPatch(request(body), roofCtx)).status).toBe(404)
    state.tenant = TENANT
    expect((await roofPatch(request({ ...body, expected_revision: '0'.repeat(64) }), roofCtx)).status).toBe(409)
    await state.db.query('update roofing_measurements set paid_at=now() where id=$1', [ROOF])
    expect((await roofPatch(request(body), roofCtx)).status).toBe(409)
    expect(state.rpcCalls).toBe(0)
  })
  it('saves an unreleased measurement in place with its existing tokens', async () => {
    const response = await roofPatch(request(await roofBody()), roofCtx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ successor: false, measureToken: 'roof-measure-token' })
    expect(await row('roofing_measurements', ROOF)).toMatchObject({ included_indices: [1], released_at: null })
  })
  it('creates one held successor on a released quote retry while preserving every original field', async () => {
    await state.db.query('update roofing_measurements set released_at=now(),confirmed_at=now(),pdf_path=$2 where id=$1', [ROOF, 'old.pdf'])
    const before = await row('roofing_measurements', ROOF)
    const body = await roofBody()
    const first = await (await roofPatch(request(body), roofCtx)).json()
    const second = await (await roofPatch(request(body), roofCtx)).json()
    expect(first).toMatchObject({ ok: true, successor: true })
    expect(second.measureToken).toBe(first.measureToken)
    expect(await row('roofing_measurements', ROOF)).toEqual(before)
    const saved = (await state.db.query<{ row: Record<string, unknown> }>('select to_jsonb(t) row from roofing_measurements t where id<>$1', [ROOF])).rows
    expect(saved).toHaveLength(1)
    expect(saved[0].row).toMatchObject({ released_at: null, confirmed_at: null, pdf_path: null, included_indices: [1] })
    expect(saved[0].row.public_token).not.toBe(before.public_token)
  })
  it('uses the same held-successor boundary for photo-derived repricing', async () => {
    await state.db.query('update roofing_measurements set released_at=now() where id=$1', [ROOF])
    const before = await row('roofing_measurements', ROOF)
    const response = await roofRescan(request(await roofBody({ photos: [{ base64: 'test', mime: 'image/jpeg' }] })), roofCtx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ successor: true })
    expect(await row('roofing_measurements', ROOF)).toEqual(before)
  })
  it('rejects a release or payment arriving after the route read', async () => {
    state.beforeRpc = async () => { await state.db.query('update roofing_measurements set released_at=now() where id=$1', [ROOF]) }
    expect((await roofPatch(request(await roofBody()), roofCtx)).status).toBe(409)
    expect((await row('roofing_measurements', ROOF)).included_indices).toEqual([1, 2])
  })
  it('protects a roof whose promoted generic quote was paid instead of the measurement row', async () => {
    await state.db.query('update roofing_measurements set quote_share_token=$2 where id=$1', [ROOF, 'solar-token'])
    await state.db.query('update quotes set paid_at=now() where id=$1', [QUOTE])
    expect((await roofPatch(request(await roofBody()), roofCtx)).status).toBe(409)
    expect((await row('roofing_measurements', ROOF)).included_indices).toEqual([1, 2])
  })
})

it('probes the revision contract without writes and refuses public RPC access', async () => {
  const result = await state.db.query<{ ready: boolean }>('select sms_owned_quote_revision_contract() ready')
  expect(result.rows[0].ready).toBe(true)
  await state.db.exec('set role anon')
  try {
    await expect(state.db.query('select sms_owned_quote_revision_contract()')).rejects.toThrow(/permission denied/)
  } finally { await state.db.exec('reset role') }
})

describe('actual solar redraft and atomic linked quote update', () => {
  it('rejects another tenant, a released estimate and a paid estimate without running the engine', async () => {
    state.tenant = '99999999-9999-4999-8999-999999999999'
    expect((await redraft(request(), solarCtx)).status).toBe(404)
    state.tenant = TENANT
    await state.db.query('update solar_estimates set confirmed_at=now() where id=$1', [SOLAR])
    expect((await redraft(request(), solarCtx)).status).toBe(409)
    await state.db.query('update solar_estimates set confirmed_at=null,paid_at=now() where id=$1', [SOLAR])
    expect((await redraft(request(), solarCtx)).status).toBe(409)
    expect(state.engine).not.toHaveBeenCalled()
  })
  it('updates the held estimate and its linked generic quote in one transaction', async () => {
    const response = await redraft(request(), solarCtx)
    expect(response.status).toBe(200)
    expect((await row('solar_estimates', SOLAR)).estimate).toEqual({ price: 'new' })
    expect((await row('quotes', QUOTE)).total_inc_gst).toBe(9000)
  })
  it('keeps old prices if linked quote refresh fails', async () => {
    state.badQuoteChange = true
    expect((await redraft(request(), solarCtx)).status).toBe(409)
    expect((await row('solar_estimates', SOLAR)).estimate).toEqual({ price: 'old' })
    expect((await row('quotes', QUOTE)).total_inc_gst).toBe(8000)
  })
  it('never changes prices after a concurrent owner approval or linked customer payment', async () => {
    state.beforeRpc = async () => { await state.db.query('update solar_estimates set confirmed_at=now() where id=$1', [SOLAR]) }
    expect((await redraft(request(), solarCtx)).status).toBe(409)
    expect((await row('solar_estimates', SOLAR)).estimate).toEqual({ price: 'old' })
    await state.db.query('update solar_estimates set confirmed_at=null where id=$1', [SOLAR])
    state.beforeRpc = async () => { await state.db.query('update quotes set paid_at=now() where id=$1', [QUOTE]) }
    expect((await redraft(request(), solarCtx)).status).toBe(409)
    expect((await row('quotes', QUOTE)).total_inc_gst).toBe(8000)
  })
})

describe('public customer building choice remains held at commit', () => {
  beforeEach(() => {
    state.engine.mockResolvedValue({ context: {}, coverage_source: 'google', routing: { decision: 'auto_quote' }, guardrail_flags: [] })
    state.tenant = null // customer token flow intentionally does not require owner authentication
  })
  const choose = () => selectBuilding(request({ centroid: { lat: -33.86, lng: 151.2 } }), solarCtx)
  it('keeps the customer building selector available before approval', async () => {
    expect((await choose()).status).toBe(200)
    expect((await row('solar_estimates', SOLAR)).confirmed_at).toBeNull()
    expect((await row('quotes', QUOTE)).total_inc_gst).toBe(9000)
  })
  it('rejects an owner approval arriving while the building estimator runs', async () => {
    state.beforeRpc = async () => { await state.db.query('update solar_estimates set confirmed_at=now() where id=$1', [SOLAR]) }
    expect((await choose()).status).toBe(409)
    expect((await row('solar_estimates', SOLAR)).estimate).toEqual({ price: 'old' })
    expect((await row('quotes', QUOTE)).total_inc_gst).toBe(8000)
  })
  it('rolls back the building estimate if its paired quote cannot be saved', async () => {
    state.badQuoteChange = true
    expect((await choose()).status).toBe(409)
    expect((await row('solar_estimates', SOLAR)).estimate).toEqual({ price: 'old' })
    expect((await row('quotes', QUOTE)).total_inc_gst).toBe(8000)
  })
})
