import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaintRateRow, PaintTakeoffItem } from '@/lib/commercial-painting/types'

const { from, rpc, tenantFromBearer, loadPaintRates } = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  tenantFromBearer: vi.fn(),
  loadPaintRates: vi.fn(),
}))

vi.mock('@/lib/estimation/auth', () => ({
  tenantFromBearer,
  estimatorSupabase: { from, rpc },
}))
vi.mock('@/lib/commercial-painting/rates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/commercial-painting/rates')>(
    '@/lib/commercial-painting/rates',
  )
  return { ...actual, loadPaintRates }
})

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

type DbState = {
  extractionItems?: PaintTakeoffItem[]
  book?: { id: string; gst_registered: boolean } | null
  clearError?: { message: string; code?: string } | null
  released?: boolean
  missingRun?: boolean
  runError?: boolean
  emptyWrite?: boolean
  runWriteError?: boolean
  extractionUpdates: unknown[]
  runUpdates: unknown[]
}

function chain(result: unknown) {
  const q: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'is', 'limit', 'abortSignal']) q[method] = vi.fn(() => q)
  q.maybeSingle = vi.fn(async () => result)
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return q
}

function installDb(state: DbState) {
  rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === 'sms_commercial_quote_guard_ready') return chain({ data: true, error: null })
    const result = async () => {
      if (name === 'commercial_paint_pricing_source') return { data: { version: 1,
        run: { id: '22222222-2222-4222-8222-222222222222', tenant_id: '11111111-1111-4111-8111-111111111111', job_name: null, site_address: null },
        extraction: { id: '33333333-3333-4333-8333-333333333333', tenant_id: '11111111-1111-4111-8111-111111111111',
          paint_run_id: '22222222-2222-4222-8222-222222222222', items: state.extractionItems ?? [ITEM], corrected_items: null },
        rates: await loadPaintRates(), pricing_book: state.book ? { ...state.book,
          tenant_id: '11111111-1111-4111-8111-111111111111', trade: 'commercial_painting' } : null }, error: null }
      if (name !== 'persist_commercial_paint_pricing') throw new Error(`Unexpected RPC ${name}`)
      if (state.clearError || state.emptyWrite || state.runWriteError) return { data: null, error: state.clearError ?? { code: 'XX000' } }
      state.extractionUpdates.push({ priced_bom: args.p_bom, priced_at: args.p_bom ? '2026-09-09T00:00:00Z' : null })
      state.runUpdates.push({ status: args.p_bom ? 'priced' : 'ready' })
      return { data: args.p_bom ? { ok: true, priced_at: '2026-09-09T00:00:00Z', pricingProof: (args.p_proof as { digest: string }).digest }
        : { ok: true, cleared: true }, error: null }
    }
    return { abortSignal: () => result() }
  })
  from.mockImplementation((table: string) => {
    if (table === 'plan_extractions') {
      const q = chain({
        data: { id: '33333333-3333-4333-8333-333333333333', items: state.extractionItems ?? [ITEM], corrected_items: null },
        error: null,
      }) as Record<string, unknown>
      q.update = vi.fn((payload: unknown) => {
        state.extractionUpdates.push(payload)
        return chain({
          data: state.clearError || state.emptyWrite ? null : { id: '33333333-3333-4333-8333-333333333333', priced_bom: null, priced_at: null },
          error: state.clearError ?? null,
        })
      })
      return q
    }
    if (table === 'pricing_book') return chain({ data: state.book ?? null, error: null })
    if (table === 'paint_runs') {
      const q = chain({ data: state.missingRun ? null : { id: '22222222-2222-4222-8222-222222222222', released_at: state.released ? '2026-09-09T00:00:00Z' : null }, error: state.runError ? { message: 'offline' } : null }) as Record<string, unknown>
      q.update = vi.fn((payload: unknown) => {
        state.runUpdates.push(payload)
        return chain({ data: state.runWriteError ? null : { id: '22222222-2222-4222-8222-222222222222' }, error: state.runWriteError ? { message: 'offline' } : null })
      })
      return q
    }
    throw new Error(`Unexpected table ${table}`)
  })
}

function request() {
  return new Request('http://localhost/api/tenant/commercial-painting/price', {
    method: 'POST',
    body: JSON.stringify({ paintRunId: '22222222-2222-4222-8222-222222222222', extractionId: '33333333-3333-4333-8333-333333333333' }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  tenantFromBearer.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', trade: 'commercial_painting' })
  loadPaintRates.mockResolvedValue(TENANT_ROWS)
  rpc.mockImplementation((name: string) => {
    if (name !== 'sms_commercial_quote_guard_ready') throw new Error(`Unexpected RPC ${name}`)
    return chain({ data: true, error: null })
  })
})

describe('commercial painting price authority route', () => {
  it.each([
    [{ released: true }, 409, 'released_quote_immutable'],
    [{ missingRun: true }, 404, 'run_not_found'],
    [{ runError: true }, 503, 'run_unavailable'],
  ] as const)('rejects an unavailable or released owned run before pricing: %s', async (flags, status, error) => {
    const state: DbState = { ...flags, extractionUpdates: [], runUpdates: [] }
    installDb(state)
    const response = await POST(request())
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ ok: false, error })
    expect(loadPaintRates).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(state.extractionUpdates).toEqual([])
    expect(state.runUpdates).toEqual([])
  })

  it.each(['missing', 'disabled', 'transport'])('fails closed before pricing when the database guard is %s', async (failure) => {
    const state: DbState = { extractionUpdates: [], runUpdates: [] }
    installDb(state)
    rpc.mockImplementation(() => {
      if (failure === 'transport') throw new Error('offline')
      return chain({ data: failure === 'disabled' ? false : null, error: failure === 'missing' ? { code: 'PGRST202' } : null })
    })
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'quote_guard_unavailable' })
    expect(loadPaintRates).not.toHaveBeenCalled()
    expect(state.extractionUpdates).toEqual([])
    expect(state.runUpdates).toEqual([])
  })

  it.each([false, true])('returns409 when approval wins the database write race, invalid pricing=%s', async (invalid) => {
    const state: DbState = { book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true },
      extractionItems: invalid ? [{ ...ITEM, system: 'textured' as never }] : [ITEM],
      clearError: { code: 'QM001', message: 'Published quote immutable' }, extractionUpdates: [], runUpdates: [] }
    installDb(state)
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'released_quote_immutable' })
  })

  it.each([
    [{ emptyWrite: true }, 'pricing_persist_unconfirmed'],
    [{ runWriteError: true }, 'pricing_persist_unconfirmed'],
  ] as const)('does not claim success for an unconfirmed write: %s', async (flags, error) => {
    const state: DbState = { ...flags, book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true }, extractionUpdates: [], runUpdates: [] }
    installDb(state)
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error })
  })

  it.each([true, false])('persists valid tenant pricing with gst_registered=%s', async (gst) => {
    const state: DbState = {
      book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: gst },
      extractionUpdates: [],
      runUpdates: [],
    }
    installDb(state)

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.gst_registered).toBe(gst)
    expect(body.bom.gstRegistered).toBe(gst)
    if (gst) expect(body.bom.gst).toBeGreaterThan(0)
    else expect(body.bom.gst).toBe(0)
    expect(state.extractionUpdates).toContainEqual(
      expect.objectContaining({ priced_bom: expect.objectContaining({ gstRegistered: gst }) }),
    )
  })

  it('returns inspection_required and never persists a customer-priceable unmatched BOM', async () => {
    const state: DbState = {
      book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true },
      extractionItems: [{ ...ITEM, system: 'textured' as never }],
      extractionUpdates: [],
      runUpdates: [],
    }
    installDb(state)

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(422)
    expect(body).toMatchObject({ ok: false, error: 'inspection_required' })
    expect(body.bom).toBeUndefined()
    expect(state.extractionUpdates).toContainEqual(expect.objectContaining({ priced_bom: null, priced_at: null }))
    expect(state.extractionUpdates.some((update) => {
      const priced = (update as { priced_bom?: unknown }).priced_bom
      return priced !== null && typeof priced === 'object'
    })).toBe(false)
  })

  it('returns tenant_pricing_required and never persists a seed-priced BOM', async () => {
    loadPaintRates.mockResolvedValue(TENANT_ROWS.map((row) => ({ ...row, is_default: true })))
    const state: DbState = {
      book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true },
      extractionUpdates: [],
      runUpdates: [],
    }
    installDb(state)

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(422)
    expect(body).toMatchObject({ ok: false, error: 'tenant_pricing_required' })
    expect(body.bom).toBeUndefined()
    expect(state.extractionUpdates).toContainEqual(expect.objectContaining({ priced_bom: null, priced_at: null }))
    expect(state.extractionUpdates.some((update) => {
      const priced = (update as { priced_bom?: unknown }).priced_bom
      return priced !== null && typeof priced === 'object'
    })).toBe(false)
  })

  it('fails closed when stale priced state cannot be cleared', async () => {
    const state: DbState = {
      book: { id: '44444444-4444-4444-8444-444444444444', gst_registered: true },
      extractionItems: [{ ...ITEM, system: 'textured' as never }],
      clearError: { message: 'write denied' },
      extractionUpdates: [],
      runUpdates: [],
    }
    installDb(state)

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ ok: false, error: 'pricing_persist_unconfirmed' })
  })
})
