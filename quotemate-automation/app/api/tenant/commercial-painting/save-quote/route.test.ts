import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pricePaintTakeoff } from '@/lib/commercial-painting/price'
import { resolvePaintRates } from '@/lib/commercial-painting/rates'
import type { PaintRateRow, PaintTakeoffItem, PricedPaintBom } from '@/lib/commercial-painting/types'
import { calculatePaintPricing, paintLabourIntent, type PaintPricingSource } from '@/lib/commercial-painting/pricing-proof'

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  archiveAndIngestQuote: vi.fn(),
  buildQuoteKbText: vi.fn(() => ({ markdown: 'kb', contentHash: 'hash' })),
  createClient: vi.fn(),
  dispatchQuoteWithPdf: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  generateShareToken: vi.fn(() => 'share-token'),
  loadPaintRates: vi.fn(),
  loadTenantBranding: vi.fn(async () => ({ businessName: 'Tenant Painting' })),
  provisionSessionStore: vi.fn(),
  tenantFromBearer: vi.fn(),
}))

vi.mock('next/server', () => ({ after: mocks.after }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/estimation/auth', () => ({
  tenantFromBearer: mocks.tenantFromBearer,
  estimatorSupabase: { from: mocks.from, rpc: mocks.rpc },
}))
vi.mock('@/lib/commercial-painting/rates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/commercial-painting/rates')>(
    '@/lib/commercial-painting/rates',
  )
  return { ...actual, loadPaintRates: mocks.loadPaintRates }
})
vi.mock('@/lib/filestore/ingest-quote', () => ({ archiveAndIngestQuote: mocks.archiveAndIngestQuote }))
vi.mock('@/lib/filestore/minimize', () => ({ buildQuoteKbText: mocks.buildQuoteKbText }))
vi.mock('@/lib/pdf/branding', () => ({ loadTenantBranding: mocks.loadTenantBranding }))
vi.mock('@/lib/pdf/gotenberg', () => ({ gotenbergConfigured: () => false, renderPdfFromHtml: vi.fn() }))
vi.mock('@/lib/sms/send-quote-pdf', () => ({ dispatchQuoteWithPdf: mocks.dispatchQuoteWithPdf }))
vi.mock('@/lib/quote/pdf', () => ({ signQuotePdfUrl: vi.fn() }))
vi.mock('@/lib/stripe/checkout', () => ({ generateShareToken: mocks.generateShareToken }))
vi.mock('@/lib/log/pipeline', () => ({ pipelineLog: () => ({ ok: vi.fn(), err: vi.fn() }) }))
vi.mock('@/lib/filestore/provision', () => ({ provisionSessionStore: mocks.provisionSessionStore }))

const storageUpload = vi.fn(async () => ({ error: null }))
mocks.createClient.mockReturnValue({ storage: { from: () => ({ upload: storageUpload }) } })

import { POST } from './route'

const ITEM: PaintTakeoffItem = {
  surface: 'Internal walls',
  room: 'Retail',
  substrate: 'plasterboard',
  system: 'low_sheen',
  unit: 'm2',
  quantity: 100,
  coats: 2,
  confidence: 'high',
  source: 'plan',
}

const TENANT_ROWS: PaintRateRow[] = [
  { kind: 'labour', code: 'labour:low_sheen:roller', label: 'Tenant labour', tenant_id: '11111111-1111-4111-8111-111111111111', system: 'low_sheen', method: 'roller', coverage_m2_per_hr: 10, is_default: false },
  { kind: 'material', code: 'mat:wall_low_sheen', label: 'Tenant paint', tenant_id: '11111111-1111-4111-8111-111111111111', system: 'low_sheen', product: 'Tenant low sheen', spread_m2_per_l: 15, price_per_l_ex_gst: 11, is_default: false },
  { kind: 'modifier', code: 'mod:height_low', label: 'low', tenant_id: '11111111-1111-4111-8111-111111111111', value: 1, is_default: false },
  { kind: 'modifier', code: 'mod:height_mid', label: 'mid', tenant_id: '11111111-1111-4111-8111-111111111111', value: 1.25, is_default: false },
  { kind: 'modifier', code: 'mod:height_high', label: 'high', tenant_id: '11111111-1111-4111-8111-111111111111', value: 1.4, is_default: false },
  { kind: 'modifier', code: 'mod:prep_pct', label: 'prep', tenant_id: '11111111-1111-4111-8111-111111111111', value: 0.1, is_default: false },
  { kind: 'modifier', code: 'mod:sundries_pct', label: 'sundries', tenant_id: '11111111-1111-4111-8111-111111111111', value: 0.08, is_default: false },
  { kind: 'modifier', code: 'mod:labour_rate', label: 'rate', tenant_id: '11111111-1111-4111-8111-111111111111', value: 95, is_default: false },
  { kind: 'modifier', code: 'mod:crew_hours_per_day', label: 'hours', tenant_id: '11111111-1111-4111-8111-111111111111', value: 7.6, is_default: false },
  { kind: 'modifier', code: 'mod:default_crew_size', label: 'crew', tenant_id: '11111111-1111-4111-8111-111111111111', value: 3, is_default: false },
]

const tenantBook = resolvePaintRates(TENANT_ROWS)
const validBom = JSON.parse(JSON.stringify(pricePaintTakeoff([ITEM], tenantBook, { gstRegistered: true }))) as PricedPaintBom
const unmatchedBom = pricePaintTakeoff([{ ...ITEM, system: 'textured' as never }], tenantBook)
const baselineSource: PaintPricingSource = { version: 1,
  run: { id: '22222222-2222-4222-8222-222222222222', tenant_id: '11111111-1111-4111-8111-111111111111', job_name: 'Retail repaint', site_address: '1 Test St' },
  extraction: { id: '33333333-3333-4333-8333-333333333333', tenant_id: '11111111-1111-4111-8111-111111111111',
    paint_run_id: '22222222-2222-4222-8222-222222222222', items: [ITEM], corrected_items: null },
  rates: TENANT_ROWS, pricing_book: { id: '44444444-4444-4444-8444-444444444444', tenant_id: '11111111-1111-4111-8111-111111111111', trade: 'commercial_painting', gst_registered: true } }
const baselineProof = calculatePaintPricing(baselineSource, paintLabourIntent(undefined)).proof

type DbState = {
  bom: PricedPaintBom
  extractionItems?: PaintTakeoffItem[]
  correctedItems?: PaintTakeoffItem[] | null
  book?: { id: string; gst_registered: boolean } | null
  inserts: Array<{ table: string; payload: unknown }>
  updates: Array<{ table: string; payload: unknown }>
}

function chain(result: () => unknown) {
  const q: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'limit', 'is']) q[method] = vi.fn(() => q)
  q.maybeSingle = vi.fn(() => q)
  q.single = vi.fn(() => q)
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve)
  return q
}

function installDb(state: DbState) {
  mocks.rpc.mockImplementation((name: string, args: Record<string, unknown>) => ({ abortSignal: async () => {
    if (name === 'commercial_paint_pricing_source') return { data: { ...baselineSource,
      extraction: { ...baselineSource.extraction, items: state.extractionItems ?? [ITEM], corrected_items: state.correctedItems ?? null },
      rates: await mocks.loadPaintRates(), pricing_book: state.book ? { ...baselineSource.pricing_book, ...state.book } : null }, error: null }
    if (name !== 'save_commercial_paint_quote') throw new Error(`Unexpected RPC ${name}`)
    state.inserts.push({ table: 'intakes', payload: args.p_intake }, { table: 'quotes', payload: args.p_quote })
    return { data: { ok: true, already: false }, error: null }
  } }))
  mocks.from.mockImplementation((table: string) => {
    let savedPayload: Record<string, unknown> | undefined
    const filters: Record<string, unknown> = {}
    let updatePayload: unknown
    let result: unknown
    if (table === 'paint_runs') result = { data: { id: '22222222-2222-4222-8222-222222222222', job_name: 'Retail repaint', site_address: '1 Test St' }, error: null }
    else if (table === 'plan_extractions') result = { data: {
      id: '33333333-3333-4333-8333-333333333333',
      items: state.extractionItems ?? [ITEM],
      corrected_items: state.correctedItems ?? null,
      priced_bom: state.bom,
      paint_pricing_proof: baselineProof,
      priced_at: '2026-08-28T00:00:00Z',
      sheets_used: {},
    }, error: null }
    else if (table === 'pricing_book') result = { data: state.book ?? null, error: null }
    else if (table === 'tenants') result = { data: { business_name: 'Tenant Painting', twilio_sms_number: null }, error: null }
    else if (table === 'intakes' || table === 'quotes') result = { data: null, error: null }
    else throw new Error(`Unexpected table ${table}`)

    const q = chain(() => {
      if (updatePayload) { state.updates.push({ table, payload: updatePayload }); return { data: null, error: null } }
      if (savedPayload && !state.inserts.some((row) => row.table === table && (row.payload as Record<string, unknown>).id === savedPayload?.id)) state.inserts.push({ table, payload: savedPayload })
      if (table === 'quotes' || table === 'intakes') {
        const found = state.inserts.find((row) => row.table === table && Object.entries(filters).every(([key, value]) => (row.payload as Record<string, unknown>)[key] === value))
        return { data: found?.payload ?? null, error: null }
      }
      return result
    })
    q.eq = vi.fn((key: string, value: unknown) => { filters[key] = value; return q })
    q.insert = q.upsert = vi.fn((payload: Record<string, unknown>) => {
      savedPayload = payload
      return q
    })
    q.update = vi.fn((payload: unknown) => {
      updatePayload = payload
      return q
    })
    return q
  })
}

function request(extra: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/tenant/commercial-painting/save-quote', {
    method: 'POST',
    body: JSON.stringify({ paintRunId: '22222222-2222-4222-8222-222222222222', extractionId: '33333333-3333-4333-8333-333333333333', pricingProof: baselineProof.digest, pricedAt: '2026-08-28T00:00:00.000000Z', ...extra }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createClient.mockReturnValue({ storage: { from: () => ({ upload: storageUpload }) } })
  mocks.tenantFromBearer.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', trade: 'commercial_painting' })
  mocks.loadPaintRates.mockResolvedValue(TENANT_ROWS)
  mocks.generateShareToken.mockReturnValue('share-token')
})

describe('commercial painting save quote authority route', () => {
  it('blocks an unmatched stored BOM before intake or quote insertion', async () => {
    const state: DbState = { bom: unmatchedBom, book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true }, inserts: [], updates: [] }
    installDb(state)

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false, error: 'pricing_changed' })
    expect(state.inserts).toEqual([])
  })

  it('blocks seed/default rates before intake or quote insertion', async () => {
    mocks.loadPaintRates.mockResolvedValue(TENANT_ROWS.map((row) => ({ ...row, is_default: true })))
    const state: DbState = { bom: validBom, book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true }, inserts: [], updates: [] }
    installDb(state)

    const response = await POST(request())

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ ok: false, error: 'tenant_pricing_required' })
    expect(state.inserts).toEqual([])
  })

  it('keeps the current tradie-review success path for fully tenant-priced BOMs', async () => {
    const state: DbState = { bom: validBom, book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true }, inserts: [], updates: [] }
    installDb(state)

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, quoteId: expect.stringMatching(/^[0-9a-f-]{36}$/), shareToken: 'share-token' })
    expect(state.inserts.map((entry) => entry.table)).toEqual(['intakes', 'quotes'])
    const quote = state.inserts.find((entry) => entry.table === 'quotes')?.payload as Record<string, unknown>
    expect(quote.routing_decision).toBe('tradie_review')
    expect(quote.needs_inspection).toBe(false)
  })

  it('saves a valid customer-linked quote as a draft without dispatching it', async () => {
    const state: DbState = { bom: validBom, book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true }, inserts: [], updates: [] }
    installDb(state)

    const response = await POST(request({ customerPhone: '0412 345 678', customerName: 'Sam' }))

    expect(response.status).toBe(200)
    expect(mocks.dispatchQuoteWithPdf).not.toHaveBeenCalled()
    const quote = state.inserts.find((entry) => entry.table === 'quotes')?.payload as Record<string, unknown>
    expect(quote.routing_decision).toBe('tradie_review')
  })

  it('rejects a stale stored BOM when the current confirmed takeoff is now unmatched', async () => {
    const state: DbState = {
      bom: validBom,
      correctedItems: [{ ...ITEM, system: 'textured' as never }],
      book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true },
      inserts: [],
      updates: [],
    }
    installDb(state)

    const response = await POST(request())

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ ok: false, error: 'inspection_required' })
    expect(state.inserts).toEqual([])
  })

  it('rejects a stale stored BOM when the current confirmed quantity changed', async () => {
    const state: DbState = {
      bom: validBom,
      correctedItems: [{ ...ITEM, quantity: ITEM.quantity + 20 }],
      book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true },
      inserts: [],
      updates: [],
    }
    installDb(state)

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false, error: 'pricing_changed' })
    expect(state.inserts).toEqual([])
  })
})
