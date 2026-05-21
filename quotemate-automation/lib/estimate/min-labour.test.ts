// Coverage for the minimum-charge floor — the fix that stops a small,
// correctly-DB-priced job (e.g. "replace one GPO") being bounced to a
// $99 inspection purely because labour < min_labour_hours.

import { describe, expect, it } from 'vitest'
import { applyMinLabourFloor } from './min-labour'

const BOOK = { hourly_rate: 110, min_labour_hours: 2.0 }

function labourHrs(tier: any): number {
  return (tier?.line_items ?? [])
    .filter((li: any) => li.unit === 'hr')
    .reduce((s: number, li: any) => s + Number(li.quantity || 0), 0)
}

describe('applyMinLabourFloor', () => {
  it('leaves an inspection-required draft untouched', () => {
    const d = { needs_inspection: true, good: null, better: null, best: null }
    const r = applyMinLabourFloor(d, BOOK)
    expect(r.adjustedTiers).toEqual([])
    expect(r.draft).toBe(d)
  })

  it('does not touch a tier that already meets the floor', () => {
    const d = {
      good: {
        subtotal_ex_gst: 350,
        line_items: [
          { description: 'GPO', unit: 'each', quantity: 1, unit_price_ex_gst: 20, total_ex_gst: 20 },
          { description: 'Labour', unit: 'hr', quantity: 2.5, unit_price_ex_gst: 110, total_ex_gst: 275 },
        ],
      },
    }
    const r = applyMinLabourFloor(d, BOOK)
    expect(r.adjustedTiers).toEqual([])
    expect(labourHrs(r.draft.good)).toBe(2.5)
  })

  it('tops up an existing hourly labour line to the floor and recomputes totals', () => {
    const d = {
      good: {
        subtotal_ex_gst: 53,
        line_items: [
          { description: 'GPO', unit: 'each', quantity: 1, unit_price_ex_gst: 20, total_ex_gst: 20 },
          { description: 'Labour', unit: 'hr', quantity: 0.3, unit_price_ex_gst: 110, total_ex_gst: 33 },
        ],
      },
    }
    const r = applyMinLabourFloor(d, BOOK)
    expect(r.adjustedTiers).toEqual(['good'])
    expect(labourHrs(r.draft.good)).toBeCloseTo(2.0, 5) // now meets the floor
    const lab = r.draft.good.line_items.find((li: any) => li.unit === 'hr')
    expect(lab.quantity).toBeCloseTo(2.0, 5)
    expect(lab.total_ex_gst).toBeCloseTo(220, 5) // 2.0 * 110
    expect(r.draft.good.subtotal_ex_gst).toBeCloseTo(53 + 1.7 * 110, 5) // +187 added labour
  })

  it('adds a labour line when the tier has materials but zero labour', () => {
    const d = {
      better: {
        subtotal_ex_gst: 40,
        line_items: [
          { description: 'Downlight', unit: 'each', quantity: 2, unit_price_ex_gst: 20, total_ex_gst: 40 },
        ],
      },
    }
    const r = applyMinLabourFloor(d, BOOK)
    expect(r.adjustedTiers).toEqual(['better'])
    expect(labourHrs(r.draft.better)).toBeCloseTo(2.0, 5)
    const lab = r.draft.better.line_items.find((li: any) => li.unit === 'hr')
    expect(lab.unit_price_ex_gst).toBe(110)
    expect(lab.total_ex_gst).toBeCloseTo(220, 5)
  })

  it('never undercharges: result labour is always >= the configured floor', () => {
    const d = {
      good: { subtotal_ex_gst: 10, line_items: [{ description: 'x', unit: 'hr', quantity: 0.1, unit_price_ex_gst: 110, total_ex_gst: 11 }] },
      best: { subtotal_ex_gst: 10, line_items: [{ description: 'y', unit: 'each', quantity: 1, unit_price_ex_gst: 10, total_ex_gst: 10 }] },
    }
    const r = applyMinLabourFloor(d, BOOK)
    expect(labourHrs(r.draft.good)).toBeGreaterThanOrEqual(2.0 - 0.05)
    expect(labourHrs(r.draft.best)).toBeGreaterThanOrEqual(2.0 - 0.05)
  })

  it('does NOT mutate when hourly_rate is unusable (safe fallback, no fabrication)', () => {
    const d = { good: { subtotal_ex_gst: 20, line_items: [{ description: 'GPO', unit: 'each', quantity: 1, unit_price_ex_gst: 20, total_ex_gst: 20 }] } }
    const r = applyMinLabourFloor(d, { hourly_rate: null, min_labour_hours: 2.0 })
    expect(r.adjustedTiers).toEqual([])
    expect(r.draft.good.line_items.length).toBe(1)
  })

  it('respects a custom min_labour_hours (plumbing 1.5)', () => {
    const d = { good: { subtotal_ex_gst: 30, line_items: [{ description: 'tap', unit: 'each', quantity: 1, unit_price_ex_gst: 30, total_ex_gst: 30 }] } }
    const r = applyMinLabourFloor(d, { hourly_rate: 120, min_labour_hours: 1.5 })
    expect(labourHrs(r.draft.good)).toBeCloseTo(1.5, 5)
  })
})
