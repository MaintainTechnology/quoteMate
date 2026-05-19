// WP2 — MaterialCatalogueSchema validation coverage.

import { describe, expect, it } from 'vitest'
import {
  MaterialCatalogueSchema,
  MaterialCataloguePatchSchema,
} from './update-schema'

describe('MaterialCatalogueSchema', () => {
  it('accepts a full valid catalogue row', () => {
    const r = MaterialCatalogueSchema.safeParse({
      trade: 'electrical',
      category: 'gpo',
      name: 'Clipsal Iconic GPO',
      brand: 'Clipsal',
      range_series: 'Iconic',
      supplier: 'Reece',
      unit_price_ex_gst: 42,
      customer_supply_price_ex_gst: 20,
      tier_hint: 'better',
      active: true,
    })
    expect(r.success).toBe(true)
  })

  it('accepts a minimal row (brand/range/tier omitted)', () => {
    const r = MaterialCatalogueSchema.safeParse({
      trade: 'plumbing',
      category: 'tap',
      name: 'Basic mixer',
      unit_price_ex_gst: 99,
    })
    expect(r.success).toBe(true)
  })

  it('coerces a numeric string price', () => {
    const r = MaterialCatalogueSchema.safeParse({
      trade: 'electrical', category: 'downlight', name: 'LED DL', unit_price_ex_gst: '36.50',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.unit_price_ex_gst).toBe(36.5)
  })

  it('rejects a bad trade, missing price, and an invalid tier', () => {
    expect(MaterialCatalogueSchema.safeParse({ trade: 'gas', category: 'x', name: 'Ok name', unit_price_ex_gst: 1 }).success).toBe(false)
    expect(MaterialCatalogueSchema.safeParse({ trade: 'electrical', category: 'gpo', name: 'No price' }).success).toBe(false)
    expect(MaterialCatalogueSchema.safeParse({ trade: 'electrical', category: 'gpo', name: 'Tier bad', unit_price_ex_gst: 1, tier_hint: 'platinum' }).success).toBe(false)
  })

  it('rejects a negative / absurd price', () => {
    expect(MaterialCatalogueSchema.safeParse({ trade: 'electrical', category: 'gpo', name: 'Neg', unit_price_ex_gst: -5 }).success).toBe(false)
    expect(MaterialCatalogueSchema.safeParse({ trade: 'electrical', category: 'gpo', name: 'Huge', unit_price_ex_gst: 9_999_999 }).success).toBe(false)
  })

  it('patch schema allows a single-field partial (e.g. just the active toggle)', () => {
    const r = MaterialCataloguePatchSchema.safeParse({ active: false })
    expect(r.success).toBe(true)
  })
})
