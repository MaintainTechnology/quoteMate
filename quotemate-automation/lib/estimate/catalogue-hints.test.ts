// WP2/WP3 prompt-hint coverage — the soft brand+range and structured-BOM
// hints. Empty input MUST return null (additive: no catalogue / unseeded
// BOM => no hint => unchanged estimator behaviour).

import { describe, expect, it } from 'vitest'
import { formatCatalogueHint, formatBomHint } from './catalogue'

describe('formatCatalogueHint (WP2)', () => {
  it('returns null with no rows (no behaviour change for catalogue-less tenants)', () => {
    expect(formatCatalogueHint([])).toBeNull()
  })
  it('groups by category and maps brand+range to a tier', () => {
    const out = formatCatalogueHint([
      { category: 'gpo', name: 'Iconic GPO', brand: 'Clipsal', range_series: 'Iconic' },
      { category: 'gpo', name: '2000 GPO', brand: 'Clipsal', range_series: '2000' },
      { category: 'downlight', name: 'LED DL', brand: 'Brightgreen', range_series: null, tier_hint: 'best' },
    ])
    expect(out).toContain('gpo:')
    expect(out).toContain('Iconic GPO (Clipsal Iconic) -> better')
    expect(out).toContain('2000 GPO (Clipsal 2000) -> good')
    expect(out).toContain('LED DL (Brightgreen) -> best') // explicit hint wins
  })
})

describe('formatBomHint (WP3)', () => {
  it('returns null with no rows (unseeded BOM => unchanged behaviour)', () => {
    expect(formatBomHint([])).toBeNull()
  })
  it('lists baseline parts, marks optional ones', () => {
    const out = formatBomHint([
      { material_category: 'downlight', quantity: 6, required: true },
      { material_category: 'sundry', quantity: 1, required: true, description: 'clips + connectors' },
      { material_category: 'dimmer', quantity: 1, required: false },
    ])
    expect(out).toContain('6 x downlight')
    expect(out).toContain('1 x sundry clips + connectors')
    expect(out).toContain('1 x dimmer (optional)')
  })
  it('ignores zero/invalid quantities', () => {
    expect(formatBomHint([{ material_category: 'x', quantity: 0 }])).toBeNull()
  })
})
