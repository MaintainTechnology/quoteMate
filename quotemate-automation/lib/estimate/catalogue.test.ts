// WP2 + WP3 regression coverage — operator catalogue, brand/range -> tier,
// structured-BOM quote-line builder, global-vs-local override, and the
// validator-acceptance feed (the WP2 "trap"). Pure logic, fully provable
// here before any of it touches the live money path.

import { describe, expect, it } from 'vitest'
import {
  resolveTierForBrandRange,
  chooseMaterial,
  resolveParam,
  effectiveAssembly,
  buildBomQuoteLines,
  catalogueCandidateRows,
  type TenantMaterial,
} from './catalogue'

describe('resolveTierForBrandRange', () => {
  it('explicit hint always wins', () => {
    expect(resolveTierForBrandRange('Clipsal', 'Iconic', 'good')).toBe('good')
    expect(resolveTierForBrandRange('X', 'elite', 'better')).toBe('better')
  })
  it('infers Better from premium ranges (Clipsal Iconic)', () => {
    expect(resolveTierForBrandRange('Clipsal', 'Iconic')).toBe('better')
  })
  it('infers Good from standard ranges (Clipsal 2000)', () => {
    expect(resolveTierForBrandRange('Clipsal', '2000')).toBe('good')
  })
  it('infers Best from elite ranges', () => {
    expect(resolveTierForBrandRange('Legrand', 'Signature')).toBe('best')
  })
  it('returns null when nothing matches / empty', () => {
    expect(resolveTierForBrandRange('Acme', 'XYZ')).toBeNull()
    expect(resolveTierForBrandRange(null, null)).toBeNull()
  })
})

describe('chooseMaterial', () => {
  const tenant: TenantMaterial[] = [
    { category: 'gpo', name: 'Clipsal Iconic GPO', brand: 'Clipsal', range_series: 'Iconic', unit_price_ex_gst: 22, active: true },
    { category: 'gpo', name: 'Clipsal 2000 GPO', brand: 'Clipsal', range_series: '2000', unit_price_ex_gst: 12, active: true },
    { category: 'gpo', name: 'Old disabled GPO', brand: 'Clipsal', range_series: '2000', unit_price_ex_gst: 1, active: false },
  ]
  const shared = [{ name: 'Generic GPO', category: 'gpo', brand: 'HPM', default_unit_price_ex_gst: 9 }]

  it('prefers an active tenant row matching brand + range', () => {
    const r = chooseMaterial({ tenantRows: tenant, sharedRows: shared, category: 'gpo', brand: 'Clipsal', range: 'Iconic' })
    expect(r?.source).toBe('tenant')
    expect(r && 'row' in r && (r.row as TenantMaterial).name).toBe('Clipsal Iconic GPO')
    expect(r?.price).toBe(22)
  })
  it('never selects an inactive tenant row', () => {
    const r = chooseMaterial({ tenantRows: tenant, sharedRows: shared, category: 'gpo', brand: 'Clipsal', range: '2000' })
    expect(r?.source).toBe('tenant')
    expect(r?.price).toBe(12) // the active 2000 row, not the $1 disabled one
  })
  it('falls back to shared when the tenant has no catalogue for the category', () => {
    const r = chooseMaterial({ tenantRows: [], sharedRows: shared, category: 'gpo' })
    expect(r?.source).toBe('shared')
    expect(r?.price).toBe(9)
  })
  it('returns null when nothing can be priced', () => {
    expect(chooseMaterial({ tenantRows: [], sharedRows: [], category: 'gpo' })).toBeNull()
  })
})

describe('resolveParam (global vs local)', () => {
  it('local override wins when present', () => {
    expect(resolveParam(28, 18)).toEqual({ value: 18, source: 'local' })
  })
  it('null/undefined override -> global', () => {
    expect(resolveParam(28, null)).toEqual({ value: 28, source: 'global' })
    expect(resolveParam(28, undefined)).toEqual({ value: 28, source: 'global' })
  })
  it('non-finite numeric override -> global', () => {
    expect(resolveParam(28, NaN)).toEqual({ value: 28, source: 'global' })
  })
})

describe('effectiveAssembly', () => {
  it('uses global params with no override', () => {
    const e = effectiveAssembly(2, 28, null)
    expect(e.enabled).toBe(true)
    expect(e.labourHours).toEqual({ value: 2, source: 'global' })
    expect(e.markupPct).toEqual({ value: 28, source: 'global' })
  })
  it('localises labour + markup and reports the disabled toggle', () => {
    const e = effectiveAssembly(2, 28, { enabled: false, labour_hours_override: 3.5, markup_pct_override: 15 })
    expect(e.enabled).toBe(false)
    expect(e.labourHours).toEqual({ value: 3.5, source: 'local' })
    expect(e.markupPct).toEqual({ value: 15, source: 'local' })
  })
})

describe('buildBomQuoteLines (WP3 determinism)', () => {
  const bom = [
    { material_category: 'downlight', quantity: 6, required: true },
    { material_category: 'sundry', quantity: 1, required: true },
    { material_category: 'dimmer', quantity: 1, required: false },
  ]
  const resolveMaterial = (c: string) =>
    c === 'downlight' ? { name: 'LED downlight', markedUpPrice: 30 } :
    c === 'sundry' ? { name: 'Sundries', markedUpPrice: 12 } :
    c === 'dimmer' ? { name: 'Dimmer', markedUpPrice: 45 } : null

  it('produces the same lines every run (required only) + a labour line', () => {
    const a = buildBomQuoteLines({ bom, resolveMaterial, labourHours: 2, labourRate: 110 })
    const b = buildBomQuoteLines({ bom, resolveMaterial, labourHours: 2, labourRate: 110 })
    expect(a).toEqual(b)
    expect(a.missingRequired).toEqual([])
    const descs = a.lines.map((l) => l.description)
    expect(descs).toEqual(['LED downlight', 'Sundries', 'Labour'])
    expect(a.lines[0]).toMatchObject({ quantity: 6, unit_price_ex_gst: 30, total_ex_gst: 180 })
    expect(a.lines[2]).toMatchObject({ unit: 'hr', quantity: 2, total_ex_gst: 220 })
  })
  it('includes optional parts only when asked', () => {
    const withOpt = buildBomQuoteLines({ bom, resolveMaterial, labourHours: 2, labourRate: 110, includeOptional: true })
    expect(withOpt.lines.map((l) => l.description)).toContain('Dimmer')
  })
  it('flags missing required categories instead of shipping a hole', () => {
    const r = buildBomQuoteLines({
      bom, resolveMaterial: (c) => (c === 'sundry' ? { name: 'Sundries', markedUpPrice: 12 } : null),
      labourHours: 2, labourRate: 110,
    })
    expect(r.missingRequired).toContain('downlight')
  })
})

describe('catalogueCandidateRows (the WP2 trap feed)', () => {
  it('emits supply + customer-supply price variants, skips inactive', () => {
    const rows: TenantMaterial[] = [
      { category: 'tap', name: 'Phoenix mixer', unit_price_ex_gst: 180, customer_supply_price_ex_gst: 90, active: true },
      { category: 'tap', name: 'Disabled tap', unit_price_ex_gst: 5, active: false },
    ]
    const out = catalogueCandidateRows(rows)
    expect(out).toEqual([
      { name: 'Phoenix mixer', price: 180 },
      { name: 'Phoenix mixer', price: 90 },
    ])
  })
})
