import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadElectricalPricingContext, priceElectricalTakeoff } from './pricing-context'

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(), from: vi.fn(), provision: vi.fn(),
}))
vi.mock('@/lib/estimation/auth', () => ({
  tenantFromBearer: mocks.tenant, estimatorSupabase: { from: mocks.from, rpc: (name: string) => {
    expect(name).toBe('sms_plan_quote_guard_ready')
    return { abortSignal: async () => ({ data: true, error: null }) }
  } },
}))
vi.mock('@/lib/filestore/provision', () => ({ provisionSessionStore: mocks.provision }))
vi.mock('@/lib/filestore/estimate-summary', () => ({ electricalEstimateSummaryText: () => 'priced summary' }))
import { POST } from '@/app/api/tenant/estimator/price/route'

const BOOK = {
  id: 'book-a', tenant_id: 'tenant-a', trade: 'electrical', hourly_rate: 100,
  default_markup_pct: 20, min_labour_hours: 0, gst_registered: false,
}
const ASSEMBLY = {
  id: 'assembly-a', tenant_id: 'tenant-a', trade: 'electrical', enabled: true,
  name: 'LED downlight', category: 'lighting', default_unit_price_ex_gst: 25,
  default_labour_hours: 0.5, default_unit: 'each',
}

let book: unknown
let assemblies: unknown
let readError: unknown
let saved: unknown
let saveError: unknown
let queries: Array<{ table: string; filters: Array<[string, unknown]>; patch?: Record<string, unknown> }>

function query(table: string) {
  const call: typeof queries[number] = { table, filters: [] }
  queries.push(call)
  const result = () => table === 'pricing_book' ? { data: book, error: readError }
    : table === 'tenant_custom_assemblies' ? { data: assemblies, error: readError }
      : table === 'plan_extractions' ? { data: saved, error: saveError }
        : { data: null, error: new Error('unexpected unowned source') }
  const builder = {
    select: () => builder,
    abortSignal: () => builder,
    eq: (column: string, value: unknown) => { call.filters.push([column, value]); return builder },
    update: (patch: Record<string, unknown>) => { call.patch = patch; return builder },
    maybeSingle: async () => result(),
    then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
  }
  return builder
}
const db = { from: mocks.from } as never
const items = [{ type: 'LED downlight', count: 2 }]
const request = (body: unknown = { items, extractionId: 'run-a' }) => new Request('https://example.test/api/tenant/estimator/price', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  book = { ...BOOK }; assemblies = [{ ...ASSEMBLY }]
  readError = null; saved = { id: 'run-a' }; saveError = null; queries = []
  mocks.from.mockImplementation(query)
  mocks.tenant.mockResolvedValue({ id: 'tenant-a' })
})

describe('electrical owned pricing context', () => {
  it('loads only owned sources and preserves GST false and explicit zeroes', async () => {
    book = { ...BOOK, default_markup_pct: 0, min_labour_hours: 0 }
    assemblies = [{ ...ASSEMBLY, default_unit_price_ex_gst: 0, default_labour_hours: 0 }]
    const context = await loadElectricalPricingContext(db, 'tenant-a')
    expect(context.bookSource).toBe('tenant')
    expect(priceElectricalTakeoff(items, context)).toMatchObject({ totalIncGst: 0, gstRegistered: false, pricingComplete: true })
    expect(queries.map((call) => call.table)).toEqual(['pricing_book', 'tenant_custom_assemblies'])
    for (const call of queries) {
      expect(call.filters).toContainEqual(['tenant_id', 'tenant-a'])
      expect(call.filters).toContainEqual(['trade', 'electrical'])
    }
    expect(queries[1].filters).toContainEqual(['enabled', true])
  })

  it.each([null, { ...BOOK, tenant_id: null }, { ...BOOK, tenant_id: 'tenant-b' }, { ...BOOK, trade: 'plumbing' }])(
    'rejects missing/default/foreign/wrong-trade book %j', async (value) => {
      book = value
      await expect(loadElectricalPricingContext(db, 'tenant-a')).rejects.toMatchObject({ code: 'tenant_pricing_required' })
      expect(queries).toHaveLength(2)
    },
  )

  it.each([
    ['hourly_rate', 0], ['hourly_rate', null], ['hourly_rate', '100'], ['hourly_rate', Infinity],
    ['default_markup_pct', -1], ['default_markup_pct', 101], ['default_markup_pct', NaN],
    ['min_labour_hours', null], ['min_labour_hours', 9], ['gst_registered', null], ['gst_registered', 'false'],
  ])('rejects malformed book field %s=%s', async (key, value) => {
    book = { ...BOOK, [key as string]: value }
    await expect(loadElectricalPricingContext(db, 'tenant-a')).rejects.toMatchObject({ code: 'tenant_pricing_required' })
  })

  it.each([
    [], [{ ...ASSEMBLY, tenant_id: 'tenant-b' }], [{ ...ASSEMBLY, enabled: false }],
    [{ ...ASSEMBLY, trade: 'plumbing' }], [{ ...ASSEMBLY, default_unit_price_ex_gst: null }],
    [{ ...ASSEMBLY, default_unit_price_ex_gst: -1 }], [{ ...ASSEMBLY, default_unit_price_ex_gst: 100_001 }],
    [{ ...ASSEMBLY, default_labour_hours: Infinity }], [{ ...ASSEMBLY, default_labour_hours: '0.5' }],
    [{ ...ASSEMBLY, default_labour_hours: 81 }],
  ].map((data) => ({ data })))('rejects absent or unsafe owned assembly data $data', async ({ data }) => {
    assemblies = data
    await expect(loadElectricalPricingContext(db, 'tenant-a')).rejects.toMatchObject({ code: 'tenant_pricing_required' })
  })

  it('content revision changes with rates, tax and assemblies, but not DB row order', async () => {
    const other = { ...ASSEMBLY, id: 'assembly-b', name: 'GPO' }
    assemblies = [ASSEMBLY, other]
    const first = await loadElectricalPricingContext(db, 'tenant-a')
    assemblies = [other, ASSEMBLY]
    expect((await loadElectricalPricingContext(db, 'tenant-a')).authority).toEqual(first.authority)
    book = { ...BOOK, hourly_rate: 120 }
    expect((await loadElectricalPricingContext(db, 'tenant-a')).authority.revision).not.toBe(first.authority.revision)
    book = { ...BOOK, gst_registered: true }
    expect((await loadElectricalPricingContext(db, 'tenant-a')).authority.revision).not.toBe(first.authority.revision)
    book = BOOK; assemblies = [{ ...ASSEMBLY, default_unit_price_ex_gst: 30 }, other]
    expect((await loadElectricalPricingContext(db, 'tenant-a')).authority.revision).not.toBe(first.authority.revision)
  })

  it('rejects arithmetic overflow before persistence', async () => {
    book = { ...BOOK, hourly_rate: Number.MAX_VALUE }
    const context = await loadElectricalPricingContext(db, 'tenant-a')
    expect(() => priceElectricalTakeoff([{ type: 'LED downlight', count: 100 }], context))
      .toThrow('supported calculation range')
  })
})

describe('POST electrical pricing action boundary', () => {
  it.each([false, true])('persists owned proof and exact money for GST=%s', async (gst) => {
    book = { ...BOOK, gst_registered: gst }
    const response = await POST(request())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, persisted: true, pricingComplete: true, pricingBookSource: 'tenant',
      bom: { subtotalExGst: 160, totalIncGst: gst ? 176 : 160, gstRegistered: gst,
        pricingAuthority: { source: 'tenant_pricing_book', tenant_id: 'tenant-a', pricing_book_id: 'book-a', trade: 'electrical' } } })
    expect(body.bom.pricingAuthority.revision).toMatch(/^[a-f0-9]{64}$/)
    const write = queries.find((call) => call.patch)
    expect(write?.patch?.priced_bom).toEqual(body.bom)
    expect(write?.filters).toEqual([['id', 'run-a'], ['tenant_id', 'tenant-a'], ['trade', 'electrical']])
    expect(mocks.provision).toHaveBeenCalledOnce()
    book = { ...BOOK, hourly_rate: 120, gst_registered: gst }
    const repriced = await (await POST(request())).json()
    expect(repriced.bom.pricingAuthority.revision).not.toBe(body.bom.pricingAuthority.revision)
    expect(repriced.bom.subtotalExGst).toBe(180)
  })

  it('returns actionable setup-required without saving or indexing', async () => {
    book = null
    const response = await POST(request())
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ ok: false, code: 'tenant_pricing_required' })
    expect(queries.some((call) => call.patch)).toBe(false)
    expect(mocks.provision).not.toHaveBeenCalled()
  })

  it('does not fall back or persist when DB lookup fails', async () => {
    readError = { message: 'database unavailable' }
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'pricing_unavailable' })
    expect(queries.some((call) => call.patch)).toBe(false)
  })

  it('keeps shared-only items unmatched, without authoring their price', async () => {
    const response = await POST(request({ items: [{ type: 'Ceiling fan', count: 1 }] }))
    expect(await response.json()).toMatchObject({ pricingComplete: false, persisted: false,
      bom: { lines: [], unmatched: [{ type: 'Ceiling fan', count: 1 }] } })
    expect(queries.map((call) => call.table)).not.toContain('shared_assemblies')
  })

  it('returns partial owner review without persisting it as a complete customer BOM', async () => {
    const response = await POST(request({ items: [...items, { type: 'Ceiling fan', count: 1 }], extractionId: 'run-a' }))
    expect(await response.json()).toMatchObject({ pricingComplete: false, persisted: false,
      bom: { lines: [expect.objectContaining({ type: 'LED downlight' })], unmatched: [{ type: 'Ceiling fan', count: 1 }] } })
    expect(queries.some((call) => call.patch)).toBe(false)
    expect(mocks.provision).not.toHaveBeenCalled()
  })

  it.each([null, '2', -1, 1.5, 'Infinity'])('rejects invalid count %s before pricing reads', async (count) => {
    expect((await POST(request({ items: [{ type: 'LED downlight', count }] }))).status).toBe(400)
    expect(queries).toHaveLength(0)
  })

  it.each([
    { items: [], minimumHours: 0 },
    { items: [{ type: 'LED downlight', count: 0 }], minimumHours: 0 },
    { items: [], minimumHours: 2 },
    { items: [{ type: 'LED downlight', count: 0 }], minimumHours: 2 },
  ])('keeps empty/zero-count take-offs incomplete with minimum $minimumHours', async ({ items, minimumHours }) => {
    book = { ...BOOK, min_labour_hours: minimumHours }
    const response = await POST(request({ items, extractionId: 'run-a' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ pricingComplete: false, persisted: false,
      bom: { lines: [], pricingComplete: false } })
    expect(queries.some((call) => call.patch)).toBe(false)
    expect(mocks.provision).not.toHaveBeenCalled()
  })

  it('preserves an explicitly configured zero price for actual positive-count work', async () => {
    assemblies = [{ ...ASSEMBLY, default_unit_price_ex_gst: 0, default_labour_hours: 0 }]
    const response = await POST(request())
    expect(await response.json()).toMatchObject({ pricingComplete: true, persisted: true,
      bom: { totalIncGst: 0, lines: [expect.objectContaining({ count: 2 })] } })
  })

  it('rejects unauthorized access before data reads', async () => {
    mocks.tenant.mockResolvedValue(null)
    expect((await POST(request())).status).toBe(401)
    expect(queries).toHaveLength(0)
  })

  it('does not claim persistence for missing/foreign run or failed write', async () => {
    saved = null
    expect((await POST(request())).status).toBe(404)
    saveError = { message: 'write failed' }
    expect((await POST(request())).status).toBe(503)
    expect(mocks.provision).not.toHaveBeenCalled()
  })
})
