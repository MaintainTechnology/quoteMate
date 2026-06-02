import { describe, expect, it } from 'vitest'
import {
  reconcileTierMath,
  checkQuantityVsItemCount,
  collapseDuplicateTiers,
} from './reconcile'
import { findHeadlineMaterialIndex } from './catalogue'

function tier(line_items: any[], subtotal?: number) {
  return { line_items, subtotal_ex_gst: subtotal, label: 'x' }
}

describe('reconcileTierMath', () => {
  it('fixes a wrong line total and a wrong subtotal from the grounded unit prices', () => {
    const draft: any = {
      good: tier(
        [
          { description: 'LED downlight', unit: 'each', quantity: 6, unit_price_ex_gst: 20.48, total_ex_gst: 99 },
          { description: 'Labour', unit: 'hr', quantity: 3, unit_price_ex_gst: 110, total_ex_gst: 330 },
        ],
        999,
      ),
    }
    const { corrections } = reconcileTierMath(draft)
    expect(draft.good.line_items[0].total_ex_gst).toBe(122.88)
    expect(draft.good.line_items[1].total_ex_gst).toBe(330)
    expect(draft.good.subtotal_ex_gst).toBe(452.88)
    expect(corrections.length).toBeGreaterThan(0)
  })

  it('is a no-op when the maths is already correct', () => {
    const draft: any = {
      better: tier([{ description: 'GPO', unit: 'each', quantity: 2, unit_price_ex_gst: 35, total_ex_gst: 70 }], 70),
    }
    const { corrections } = reconcileTierMath(draft)
    expect(corrections).toHaveLength(0)
    expect(draft.better.subtotal_ex_gst).toBe(70)
  })

  it('leaves a line with non-finite numbers untouched (never fabricates a price)', () => {
    const draft: any = {
      good: tier([{ description: 'Mystery', unit: 'each', quantity: null, unit_price_ex_gst: undefined, total_ex_gst: 50 }], 50),
    }
    reconcileTierMath(draft)
    expect(draft.good.line_items[0].total_ex_gst).toBe(50)
    expect(draft.good.subtotal_ex_gst).toBe(50)
  })

  it('skips null tiers (inspection-style draft)', () => {
    const draft: any = { good: null, better: null, best: null }
    const { corrections } = reconcileTierMath(draft)
    expect(corrections).toHaveLength(0)
  })
})

describe('checkQuantityVsItemCount', () => {
  it('flags a headline each-line whose quantity disagrees with item_count, without changing it', () => {
    const draft: any = {
      good: tier([
        { description: 'LED downlight', unit: 'each', quantity: 4, unit_price_ex_gst: 20, total_ex_gst: 80, source: 'material' },
        { description: 'Labour', unit: 'hr', quantity: 3, unit_price_ex_gst: 110, total_ex_gst: 330, source: 'labour' },
      ]),
    }
    const flags = checkQuantityVsItemCount(draft, 6)
    expect(flags).toHaveLength(1)
    expect(flags[0]).toContain('quantity 4')
    expect(flags[0]).toContain('item_count 6')
    expect(draft.good.line_items[0].quantity).toBe(4) // unchanged
  })

  it('is silent when the headline quantity matches item_count', () => {
    const draft: any = { good: tier([{ description: 'GPO', unit: 'each', quantity: 6, unit_price_ex_gst: 30, source: 'material' }]) }
    expect(checkQuantityVsItemCount(draft, 6)).toHaveLength(0)
  })

  it('is silent when item_count is absent or non-positive', () => {
    const draft: any = { good: tier([{ description: 'GPO', unit: 'each', quantity: 6, unit_price_ex_gst: 30, source: 'material' }]) }
    expect(checkQuantityVsItemCount(draft, undefined)).toHaveLength(0)
    expect(checkQuantityVsItemCount(draft, 0)).toHaveLength(0)
  })
})

describe('collapseDuplicateTiers', () => {
  const line = (d: string, q: number, p: number) => ({
    description: d, unit: 'each', quantity: q, unit_price_ex_gst: p, total_ex_gst: q * p, source: 'material',
  })

  it('collapses three identical tiers to one and re-points selected_tier off a nulled tier', () => {
    const items = () => [line('LED downlight', 6, 20)]
    const draft: any = {
      good: tier(items(), 120),
      better: tier(items(), 120),
      best: tier(items(), 120),
      selected_tier: 'best',
    }
    const { collapsed } = collapseDuplicateTiers(draft)
    expect(collapsed.sort()).toEqual(['best', 'better'])
    expect(draft.good).not.toBeNull()
    expect(draft.better).toBeNull()
    expect(draft.best).toBeNull()
    expect(draft.selected_tier).toBe('good')
  })

  it('leaves genuinely-different tiers untouched', () => {
    const draft: any = {
      good: tier([line('Budget downlight', 6, 16)], 96),
      better: tier([line('Mid downlight', 6, 28)], 168),
      best: tier([line('Premium downlight', 6, 55)], 330),
    }
    const { collapsed } = collapseDuplicateTiers(draft)
    expect(collapsed).toHaveLength(0)
    expect(draft.good).not.toBeNull()
    expect(draft.better).not.toBeNull()
    expect(draft.best).not.toBeNull()
  })
})

describe('findHeadlineMaterialIndex', () => {
  it('prefers a non-sundry material line, falls back to any non-labour line, else -1', () => {
    expect(
      findHeadlineMaterialIndex([
        { description: 'Sundries & fixings', source: 'material' },
        { description: 'LED downlight', source: 'material' },
        { description: 'Labour', source: 'labour' },
      ]),
    ).toBe(1)
    expect(
      findHeadlineMaterialIndex([
        { description: 'Cable clip', source: 'material' },
        { description: 'Labour', source: 'labour' },
      ]),
    ).toBe(0)
    expect(findHeadlineMaterialIndex([{ description: 'Labour', source: 'labour' }])).toBe(-1)
    expect(findHeadlineMaterialIndex(null)).toBe(-1)
  })
})
