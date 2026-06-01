// Multi-structure roofing pricing — the call-out floor + the
// priceMultiRoof aggregator (per-structure pricing, combined totals,
// per-structure inspection gate). These are the correctness guards the
// feature spec called blockers: mixed materials must NOT be summed onto
// one rate, loadings/inspection must be evaluated per structure, and a
// tiny shed must not compute an unrealistic price.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROOFING_RATE_CARD,
  calculateRoofingPrice,
  priceMultiRoof,
  type RoofStructureInput,
} from './pricing'
import type { RoofMetrics, RoofUserInputs } from './types'

function metrics(overrides: Partial<RoofMetrics> = {}): RoofMetrics {
  return {
    footprint_m2: 200,
    sloped_area_m2: 220,
    storeys: 1,
    form: 'hip',
    hips: 4,
    valleys: 0,
    ridge_lm: null,
    polygon_geojson: null,
    capture_date: null,
    buildingId: 'b-primary',
    ...overrides,
  }
}

function inputs(overrides: Partial<RoofUserInputs> = {}): RoofUserInputs {
  return {
    material: 'colorbond_trimdek',
    pitch: 'standard',
    building_year_built: 2005,
    intent: 'full_reroof',
    ...overrides,
  }
}

describe('call-out minimum floor', () => {
  it('raises a tiny shed Good tier to the floor and flags it', () => {
    // 12 m² shed → better = 12 × 95 = 1140; good = 1140 × 0.20 = 228.
    const r = calculateRoofingPrice({
      metrics: metrics({ footprint_m2: 11, sloped_area_m2: 12, storeys: 1, form: 'gable', buildingId: 'b-shed' }),
      inputs: inputs(),
    })
    expect(r.tiers[0].ex_gst).toBe(550) // good floored from 228 → 550
    expect(r.tiers[1].ex_gst).toBe(1140) // better above floor, untouched
    expect(r.call_out_minimum_applied).toBe(true)
  })

  it('does NOT bind on a full-size house (no flag, exact tier maths preserved)', () => {
    const r = calculateRoofingPrice({ metrics: metrics(), inputs: inputs() })
    expect(r.tiers[1].ex_gst).toBe(20_900) // 220 × 95
    expect(r.tiers[0].ex_gst).toBeCloseTo(20_900 * 0.2, 1) // good = better × 0.20, NOT floored
    expect(r.call_out_minimum_applied).toBe(false)
  })

  it('leaves a zero-rate (inspection-routed) tier at 0 rather than fabricating a floor', () => {
    // cement_sheet has a $0 base rate AND routes to inspection.
    const r = calculateRoofingPrice({
      metrics: metrics({ footprint_m2: 11, sloped_area_m2: 12 }),
      inputs: inputs({ material: 'cement_sheet' }),
    })
    // better/good derive from a 0 base rate → stay 0 (not floored to 550).
    expect(r.tiers[1].ex_gst).toBe(0)
    expect(r.tiers[0].ex_gst).toBe(0)
  })
})

describe('priceMultiRoof — per-structure pricing + aggregation', () => {
  const house: RoofStructureInput = {
    buildingId: 'b-house',
    role: 'primary',
    metrics: metrics({ footprint_m2: 200, sloped_area_m2: 220, buildingId: 'b-house' }),
    inputs: inputs({ material: 'terracotta_tile' }), // $130/m²
  }
  const shed: RoofStructureInput = {
    buildingId: 'b-shed',
    role: 'secondary',
    metrics: metrics({ footprint_m2: 45, sloped_area_m2: 50, storeys: 1, form: 'gable', buildingId: 'b-shed' }),
    inputs: inputs({ material: 'colorbond_trimdek' }), // $95/m²
  }

  it('prices each structure with its OWN material — never sums areas onto one rate', () => {
    const q = priceMultiRoof({ structures: [house, shed] })
    const houseLine = q.structures.find((s) => s.buildingId === 'b-house')!
    const shedLine = q.structures.find((s) => s.buildingId === 'b-shed')!
    expect(houseLine.price.tiers[1].ex_gst).toBe(220 * 130) // 28,600
    expect(shedLine.price.tiers[1].ex_gst).toBe(50 * 95) // 4,750
  })

  it('combined better tier = sum of the per-structure better tiers', () => {
    const q = priceMultiRoof({ structures: [house, shed] })
    expect(q.combined.tiers[1].ex_gst).toBe(220 * 130 + 50 * 95) // 33,350
    expect(q.combined.area_m2).toBe(270) // 220 + 50
  })

  it('combined inc-GST is the linear sum of per-structure inc-GST', () => {
    const q = priceMultiRoof({ structures: [house, shed] })
    const expected = (220 * 130 + 50 * 95) * 1.1
    expect(q.combined.tiers[1].inc_gst).toBeCloseTo(expected, 1)
  })

  it('quotable primary + inspection-needed secondary → quote the primary, flag the secondary (whole job NOT inspected)', () => {
    const asbestosShed: RoofStructureInput = { ...shed, inputs: inputs({ material: 'cement_sheet' }) }
    const q = priceMultiRoof({ structures: [house, asbestosShed] })
    // The whole job is NOT blocked — we quote the main dwelling…
    expect(q.routing.decision).toBe('tradie_review')
    // …and flag the secondary that needs a look.
    expect(q.inspection_structures.length).toBe(1)
    // Combined reflects the QUOTABLE structures only (the house, 220 × 130).
    expect(q.combined.tiers[1].ex_gst).toBe(220 * 130)
    const houseLine = q.structures.find((s) => s.buildingId === 'b-house')!
    expect(houseLine.price.routing.decision).toBe('tradie_review')
  })

  it('PRIMARY needs inspection → whole job routes to inspection', () => {
    const asbestosHouse: RoofStructureInput = { ...house, inputs: inputs({ material: 'cement_sheet' }) }
    const q = priceMultiRoof({ structures: [asbestosHouse, shed] })
    expect(q.routing.decision).toBe('inspection_required')
  })

  it('nothing quotable → inspection', () => {
    const q = priceMultiRoof({
      structures: [
        { ...house, inputs: inputs({ material: 'cement_sheet' }) },
        { ...shed, inputs: inputs({ material: 'cement_sheet' }) },
      ],
    })
    expect(q.routing.decision).toBe('inspection_required')
  })

  it('multi-storey loading applies per structure, not across the whole job', () => {
    const twoStoreyHouse: RoofStructureInput = {
      ...house,
      metrics: metrics({ footprint_m2: 200, sloped_area_m2: 220, storeys: 2, buildingId: 'b-house' }),
      inputs: inputs({ material: 'colorbond_trimdek' }),
    }
    const q = priceMultiRoof({ structures: [twoStoreyHouse, shed] })
    const houseLine = q.structures.find((s) => s.buildingId === 'b-house')!
    const shedLine = q.structures.find((s) => s.buildingId === 'b-shed')!
    // House: 220 × 95 × 1.20 = 25,080 (loading applied)
    expect(houseLine.price.tiers[1].ex_gst).toBe(25_080)
    expect(houseLine.price.loadings_applied.map((l) => l.code)).toContain('multi_storey')
    // Shed: single-storey → no multi-storey loading, plain 50 × 95.
    expect(shedLine.price.tiers[1].ex_gst).toBe(4_750)
    expect(shedLine.price.loadings_applied).toEqual([])
  })

  it('all structures clean → tradie_review (roofing never auto-quotes)', () => {
    const q = priceMultiRoof({ structures: [house, shed] })
    expect(q.routing.decision).toBe('tradie_review')
    expect(q.inspection_structures).toEqual([])
  })

  it('derives default labels: primary = Main dwelling, secondaries numbered', () => {
    const shed2: RoofStructureInput = { ...shed, buildingId: 'b-shed-2' }
    const q = priceMultiRoof({ structures: [house, shed, shed2] })
    expect(q.structures[0].label).toBe('Main dwelling')
    expect(q.structures[1].label).toBe('Secondary structure 1')
    expect(q.structures[2].label).toBe('Secondary structure 2')
  })

  it('honours an explicit per-structure rate card', () => {
    const card = { ...DEFAULT_ROOFING_RATE_CARD, reroof_rate_per_m2: { ...DEFAULT_ROOFING_RATE_CARD.reroof_rate_per_m2, colorbond_trimdek: 100 } }
    const q = priceMultiRoof({ structures: [shed], rateCard: card })
    expect(q.structures[0].price.tiers[1].ex_gst).toBe(50 * 100) // 5,000
  })
})
