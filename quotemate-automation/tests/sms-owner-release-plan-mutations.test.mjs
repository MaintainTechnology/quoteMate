import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// Real authenticated mutation handlers, deterministic pricing and public page.
// The shared query adapter models an already released row; it is not SQL/RLS proof.
const h = vi.hoisted(() => {
  const state = { row: null, book: null, assemblies: [], writes: [], unexpected: [], indexed: [], guardMode: '', readError: false, releaseRace: false }
  const client = { rpc(name) {
    if (name !== 'sms_plan_quote_guard_ready') { state.unexpected.push(name); throw new Error(`Unexpected RPC ${name}`) }
    return { abortSignal: async signal => {
      expect(signal).toBeInstanceOf(AbortSignal)
      if (state.guardMode === 'timeout') return await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      if (state.guardMode === 'transport') throw new Error('Guard network failure')
      return state.guardMode === 'missing' ? { data: null, error: { code: 'PGRST202' } } : { data: state.guardMode !== 'false', error: null }
    } }
  }, from(table) {
    const filters = []; let payload = null
    const query = {
      select: () => query, eq: (key, value) => { filters.push([key, value]); return query },
      is: (key, value) => { filters.push([key, value]); return query },
      update: value => { payload = value; return query },
      abortSignal: () => query,
      maybeSingle: () => result(), then: (resolve, reject) => result().then(resolve, reject),
    }
    async function result() {
      if (table === 'plan_extractions') {
        if (!payload && state.readError) return { data: null, error: { code: '08006', message: 'Read unavailable' } }
        const matches = state.row && filters.every(([key, value]) => state.row[key] === value)
        if (!matches) return { data: null, error: null }
        if (payload && state.releaseRace) {
          state.row.released_at = '2026-09-09T00:00:00.000Z'
          return { data: null, error: { code: 'QM001', message: 'released_quote_immutable' } }
        }
        if (payload) { state.writes.push(structuredClone(payload)); Object.assign(state.row, structuredClone(payload)) }
        return { data: structuredClone(state.row), error: null }
      }
      if (table === 'pricing_book') return { data: state.book, error: null }
      if (table === 'tenant_custom_assemblies') return { data: state.assemblies, error: null }
      if (table === 'tenants') return { data: { business_name: 'Offline Electrician' }, error: null }
      state.unexpected.push(table); throw new Error(`Unexpected table ${table}`)
    }
    return query
  } }
  return { state, client }
})
vi.mock('@/lib/estimation/auth', () => ({ estimatorSupabase: h.client, tenantFromBearer: async () => ({ id: 'plan-tenant' }) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/filestore/provision', () => ({ provisionSessionStore: input => { h.state.indexed.push(input) } }))
vi.mock('next/navigation', () => ({ usePathname: () => '/q/plan/released-plan-token', notFound: () => { throw new Error('NOT_FOUND') } }))
vi.mock('@/app/q/_chrome/TradieJobBanner', () => ({ TradieJobBanner: () => null }))
import { PATCH } from '@/app/api/tenant/estimator/extract/[id]/route'
import { POST as price } from '@/app/api/tenant/estimator/price/route'
import PlanResultsPage from '@/app/q/plan/[token]/page'
import { priceTakeoff } from '@/lib/estimation/price'

const item = count => ({ type: 'double power point', count, confidence: 'high' })
beforeEach(() => {
  h.state.book = { id: 'plan-book', tenant_id: 'plan-tenant', trade: 'electrical', hourly_rate: 120, default_markup_pct: 0, min_labour_hours: 0, gst_registered: true }
  h.state.assemblies = [{ id: 'plan-assembly', tenant_id: 'plan-tenant', trade: 'electrical', enabled: true,
    name: 'Double power point', category: 'power_points', default_unit_price_ex_gst: 50, default_labour_hours: 0.5, default_unit: 'each' }]
  const bom = priceTakeoff([item(2)], h.state.assemblies, h.state.book)
  expect(bom.totalIncGst).toBe(242)
  h.state.row = { id: 'plan-extraction', tenant_id: 'plan-tenant', trade: 'electrical', share_token: 'released-plan-token',
    released_at: '2026-09-09T00:00:00.000Z', items: [item(2)], corrected_items: [item(2)], priced_bom: bom,
    priced_at: '2026-09-08T23:00:00.000Z', created_at: '2026-09-08T23:00:00.000Z', plan_uploads: { filename: 'fixture-plan.pdf' }, sheets_used: ['E1'] }
  h.state.writes = []; h.state.unexpected = []; h.state.indexed = []
  h.state.guardMode = ''; h.state.readError = false; h.state.releaseRace = false
  vi.stubGlobal('fetch', async () => { h.state.unexpected.push('fetch'); throw new Error('Unexpected external I/O') })
})
afterEach(() => { vi.unstubAllGlobals(); expect(h.state.unexpected).toEqual([]) })
const html = async () => renderToStaticMarkup(await PlanResultsPage({ params: Promise.resolve({ token: 'released-plan-token' }) }))
const mutate = method => method === 'PATCH'
  ? PATCH(new Request('https://offline.invalid/api/tenant/estimator/extract/plan-extraction', { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ corrected_items: [item(8)] }) }), { params: Promise.resolve({ id: 'plan-extraction' }) })
  : price(new Request('https://offline.invalid/api/tenant/estimator/price', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ extractionId: 'plan-extraction', items: [item(8)] }) }))

describe('released plan extraction price and quantity immutability', () => {
  it.each(['PATCH', 'POST'])('bounds a stalled %s readiness read and performs no write', async method => {
    h.state.guardMode = 'timeout'
    const started = Date.now()
    expect((await mutate(method)).status).toBe(503)
    expect(Date.now() - started).toBeLessThan(4500)
    expect(h.state.writes).toEqual([]); expect(h.state.indexed).toEqual([])
  }, 6000)
  it.each(['PATCH', 'POST'])('preserves ordinary held editing through %s', async method => {
    h.state.row.released_at = null
    const response = await mutate(method)
    expect(response.status).toBe(200)
    expect(h.state.row.released_at).toBeNull()
    expect(h.state.writes).toHaveLength(1)
    if (method === 'PATCH') { expect(h.state.row.corrected_items[0].count).toBe(8); expect(h.state.row.priced_bom).toBeNull() }
    else { expect(h.state.row.priced_bom.totalIncGst).toBe(968); expect(h.state.row.priced_bom.pricingAuthority.source).toBe('tenant_pricing_book') }
  })
  it.each(['PATCH', 'POST'].flatMap(method => ['false', 'missing', 'transport'].map(mode => ({ method, mode }))))('fails closed before $method writes when readiness is $mode', async ({ method, mode }) => {
    h.state.guardMode = mode; h.state.row.released_at = null
    const before = structuredClone(h.state.row)
    const response = await mutate(method)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'plan_release_guard_unavailable' })
    expect(h.state.row).toEqual(before); expect(h.state.writes).toEqual([]); expect(h.state.indexed).toEqual([])
  })
  it.each(['PATCH', 'POST'])('returns immutable conflict for a concurrent release rejected by the %s write trigger', async method => {
    h.state.row.released_at = null; h.state.releaseRace = true
    const before = structuredClone(h.state.row)
    const response = await mutate(method)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'released_quote_immutable' })
    expect(h.state.row).toEqual({ ...before, released_at: '2026-09-09T00:00:00.000Z' })
    expect(h.state.writes).toEqual([]); expect(h.state.indexed).toEqual([])
  })
  it.each(['PATCH', 'POST'])('fails closed on the %s release-state read error', async method => {
    h.state.readError = true
    expect((await mutate(method)).status).toBe(503)
    expect(h.state.writes).toEqual([])
  })
  it.each(['PATCH', 'POST'].flatMap(method => [{ tenant_id: 'foreign-tenant' }, { trade: 'commercial_painting' }].map(change => ({ method, change }))))('does not mutate an unowned or other-trade extraction through $method', async ({ method, change }) => {
    Object.assign(h.state.row, change)
    expect((await mutate(method)).status).toBe(404)
    expect(h.state.writes).toEqual([])
  })
  it('cannot overwrite reviewed quantities through actual electrical PATCH after release', async () => {
    const before = structuredClone(h.state.row)
    expect(await html()).toContain('$242.00')
    const response = await PATCH(new Request('https://offline.invalid/api/tenant/estimator/extract/plan-extraction', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ corrected_items: [item(8)] }),
    }), { params: Promise.resolve({ id: before.id }) })
    const after = await html()
    console.log('PLAN_PATCH_RELEASE_PROBE', JSON.stringify({ status: response.status, releasedAt: h.state.row.released_at,
      originalCount: before.corrected_items[0].count, currentCount: h.state.row.corrected_items[0].count,
      publicShowsEight: />8<\/td>/.test(after), publicStillShowsApprovedPrice: after.includes('$242.00') }))
    expect(response.status).toBe(409)
    expect(h.state.row).toEqual(before)
    expect(h.state.writes).toEqual([])
    expect(after).toContain('$242.00')
  })
  it('cannot replace a released public BOM through the actual deterministic price POST', async () => {
    const before = structuredClone(h.state.row)
    expect(await html()).toContain('$242.00')
    const response = await price(new Request('https://offline.invalid/api/tenant/estimator/price', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ extractionId: before.id, items: [item(8)] }),
    }))
    const after = await html()
    console.log('PLAN_PRICE_RELEASE_PROBE', JSON.stringify({ status: response.status, releasedAt: h.state.row.released_at,
      approvedTotal: before.priced_bom.totalIncGst, currentTotal: h.state.row.priced_bom?.totalIncGst, publicShowsUnapprovedPrice: after.includes('$968.00') }))
    expect(response.status).toBe(409)
    expect(h.state.row).toEqual(before)
    expect(h.state.writes).toEqual([])
    expect(after).toContain('$242.00')
    expect(after).not.toContain('$968.00')
  })
})
