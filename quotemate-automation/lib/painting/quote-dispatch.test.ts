// Spec painting-auto-send R1 — the shared non-dashboard save path releases a
// PRICED painting quote at save time (both origins route through here), and
// leaves an inspection-routed one held exactly as before.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaintingEstimate } from './types'

const h = vi.hoisted(() => ({
  estimatePainting: vi.fn(),
}))

vi.mock('./measure', () => ({ estimatePainting: h.estimatePainting }))

import { DEFAULT_PAINTING_RATE_CARD } from './pricing'
import { runAndSavePaintingQuote } from './quote-dispatch'

function estimateFixture(decision: 'auto_quote' | 'inspection_required'): PaintingEstimate {
  return {
    provider: 'google_solar',
    measurement: { floor_area_m2: 180 },
    price: {
      total_area_m2: 320,
      confidence: 'medium',
      routing: { decision, reason: 'because' },
      tiers: [
        { tier: 'good', inc_gst: 9000 },
        { tier: 'better', inc_gst: 12000 },
        { tier: 'best', inc_gst: 15000 },
      ],
    },
  } as unknown as PaintingEstimate
}

/** Minimal Supabase double: captures the painting_measurements insert row. */
function clientCapturing(inserted: Record<string, unknown>[], options: { saveError?: unknown; rates?: unknown; existing?: unknown } = {}) {
  return { from: (table: string) => {
    const query = { select: () => query, eq: () => query,
      insert: (row: Record<string, unknown>) => { inserted.push(row); return query },
      maybeSingle: async () => ({ data: options.existing ?? null, error: null }),
      single: async () => ({ data: options.saveError ? null : { public_token: 'pub-1', estimate_token: 'est-1' }, error: options.saveError ?? null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: table === 'pricing_book' ? [{ trade: 'painting', overlays: { painting_rate_card: options.rates === undefined ? DEFAULT_PAINTING_RATE_CARD : options.rates } }] : null, error: null }),
    }; return query
  } } as unknown as SupabaseClient
}

const request = {
  address: { address: '5 Smith St', postcode: '2000', state: 'NSW' },
  inputs: {
    scopes: ['interior_walls'],
    coats: 2,
    condition: 'good',
    ceiling_height: 'standard',
    colour_change: false,
    storeys: 1,
    manual_floor_area_m2: null,
  },
} as never

beforeEach(() => h.estimatePainting.mockReset())

describe('runAndSavePaintingQuote — human review', () => {
  it('persists a PRICED draft held for explicit human approval', async () => {
    h.estimatePainting.mockResolvedValue({ ok: true, estimate: estimateFixture('auto_quote') })
    const inserted: Record<string, unknown>[] = []

    const disp = await runAndSavePaintingQuote({
      supabase: clientCapturing(inserted),
      tenantId: 'tenant-1',
      customerPhone: '+61400000000',
      request,
    })

    expect(disp.ok).toBe(true)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].released_at).toBeNull()
    expect(inserted[0].source_request_key).toEqual(expect.any(String))
  })

  it('leaves an INSPECTION-routed quote held — no price to show, behaviour unchanged', async () => {
    h.estimatePainting.mockResolvedValue({
      ok: true,
      estimate: estimateFixture('inspection_required'),
    })
    const inserted: Record<string, unknown>[] = []

    const disp = await runAndSavePaintingQuote({
      supabase: clientCapturing(inserted),
      tenantId: 'tenant-1',
      request,
    })

    expect(disp.ok && disp.inspection).toBe(true)
    expect(inserted[0].released_at).toBeNull()
  })
})

it('fails closed when tenant pricing is missing or incomplete', async () => {
  for (const rates of [null, {}, { rate_per_unit: { walls: 5 } }]) {
    h.estimatePainting.mockClear()
    const inserted: Record<string, unknown>[] = []
    const result = await runAndSavePaintingQuote({ supabase: clientCapturing(inserted, { rates }), tenantId: 'tenant-1', request })
    expect(result.ok).toBe(false)
    expect(h.estimatePainting).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
  }
})
it('returns the persisted token on replay, without re-pricing', async () => {
  h.estimatePainting.mockClear()
  const inserted: Record<string, unknown>[] = []
  const result = await runAndSavePaintingQuote({ supabase: clientCapturing(inserted, { existing: { public_token: 'persisted', estimate_token: 'review', estimate: estimateFixture('auto_quote'), routing: 'auto_quote' } }), tenantId: 'tenant-1', request })
  expect(result).toMatchObject({ ok: true, token: 'persisted' })
  expect(h.estimatePainting).not.toHaveBeenCalled()
  expect(inserted).toHaveLength(0)
})
it('honours resolved save errors instead of returning a fabricated link', async () => {
  h.estimatePainting.mockResolvedValue({ ok: true, estimate: estimateFixture('auto_quote') })
  const result = await runAndSavePaintingQuote({ supabase: clientCapturing([], { saveError: { message: 'DB unavailable' } }), tenantId: 'tenant-1', request })
  expect(result).toMatchObject({ ok: false })
})
