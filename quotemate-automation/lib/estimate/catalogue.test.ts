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
  normaliseCategory,
  categoryHasCatalogueProduct,
  enrichLinesWithCatalogue,
  applyChosenProduct,
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

  it('is_preferred breaks a tie between otherwise-equal rows (WP2)', () => {
    const rows: TenantMaterial[] = [
      { category: 'tap', name: 'Plain tap', brand: 'Acme', unit_price_ex_gst: 50, active: true },
      { category: 'tap', name: 'Go-to tap', brand: 'Acme', unit_price_ex_gst: 60, active: true, is_preferred: true },
    ]
    // No brand/range/tier signal → both score equally except the
    // preferred flag, which must win.
    const r = chooseMaterial({ tenantRows: rows, sharedRows: [], category: 'tap' })
    expect(r?.source).toBe('tenant')
    expect(r && 'row' in r && (r.row as TenantMaterial).name).toBe('Go-to tap')
  })

  it('is_preferred NEVER overrides a stronger brand/range match (WP2)', () => {
    const rows: TenantMaterial[] = [
      { category: 'tap', name: 'Preferred generic', brand: 'Acme', range_series: 'Basic', unit_price_ex_gst: 40, active: true, is_preferred: true },
      { category: 'tap', name: 'Exact match', brand: 'Caroma', range_series: 'Liano', unit_price_ex_gst: 90, active: true },
    ]
    // Customer/tier asked for Caroma Liano — the exact brand+range hit
    // (+8) must beat the preferred-but-wrong product (+1).
    const r = chooseMaterial({ tenantRows: rows, sharedRows: [], category: 'tap', brand: 'Caroma', range: 'Liano' })
    expect(r && 'row' in r && (r.row as TenantMaterial).name).toBe('Exact match')
  })

  // ── v7 Phase 3 — tier ladder behaviour ─────────────────────────────
  it('tier ladder hit overrides brand/range scoring (Phase 3)', () => {
    const rows: TenantMaterial[] = [
      { id: 'cat-good', category: 'gpo', name: 'HPM Excel GPO', brand: 'HPM', range_series: 'Excel', unit_price_ex_gst: 8, active: true },
      { id: 'cat-better', category: 'gpo', name: 'Clipsal Iconic GPO', brand: 'Clipsal', range_series: 'Iconic', unit_price_ex_gst: 25, active: true },
      { id: 'cat-best', category: 'gpo', name: 'Saturn Zen GPO', brand: 'Clipsal', range_series: 'Saturn Zen', unit_price_ex_gst: 70, active: true },
    ]
    // Without ladder: asking for Better tier + Clipsal Iconic → picks Iconic by score.
    // With ladder: tenant says "for gpo at Better, use HPM Excel" — that MUST win.
    const r = chooseMaterial({
      tenantRows: rows,
      sharedRows: [],
      category: 'gpo',
      tier: 'better',
      brand: 'Clipsal',
      range: 'Iconic',
      tierLadder: [{ category: 'gpo', tier: 'better', catalogue_id: 'cat-good' }],
    })
    expect(r?.source).toBe('tenant')
    expect(r && 'row' in r && (r.row as TenantMaterial).name).toBe('HPM Excel GPO')
    expect(r?.price).toBe(8)
  })
  it('tier ladder does not fire when tier is missing', () => {
    const rows: TenantMaterial[] = [
      { id: 'a', category: 'gpo', name: 'A', brand: 'Acme', unit_price_ex_gst: 10, active: true },
      { id: 'b', category: 'gpo', name: 'B', brand: 'Boss', unit_price_ex_gst: 20, active: true },
    ]
    const r = chooseMaterial({
      tenantRows: rows,
      sharedRows: [],
      category: 'gpo',
      // tier intentionally omitted — ladder should be ignored.
      tierLadder: [{ category: 'gpo', tier: 'good', catalogue_id: 'b' }],
    })
    // Falls back to scoring — both rows score equally, first one wins.
    expect(r && 'row' in r && (r.row as TenantMaterial).name).toBe('A')
  })
  it('tier ladder falls back to scoring when the ladder row was deleted from catalogue', () => {
    const rows: TenantMaterial[] = [
      { id: 'still-here', category: 'gpo', name: 'Still here', brand: 'Acme', unit_price_ex_gst: 10, active: true },
    ]
    const r = chooseMaterial({
      tenantRows: rows,
      sharedRows: [],
      category: 'gpo',
      tier: 'good',
      // Ladder points at an id that's no longer in tenantRows.
      tierLadder: [{ category: 'gpo', tier: 'good', catalogue_id: 'deleted-uuid' }],
    })
    // Falls back to scoring instead of returning null.
    expect(r?.source).toBe('tenant')
    expect(r && 'row' in r && (r.row as TenantMaterial).name).toBe('Still here')
  })
  it('tier ladder is case-insensitive on category', () => {
    const rows: TenantMaterial[] = [
      { id: 'pick-me', category: 'gpo', name: 'Pick me', brand: 'Acme', unit_price_ex_gst: 10, active: true },
      { id: 'not-me', category: 'gpo', name: 'Not me', brand: 'Acme', unit_price_ex_gst: 99, active: true },
    ]
    const r = chooseMaterial({
      tenantRows: rows,
      sharedRows: [],
      category: 'GPO',
      tier: 'good',
      tierLadder: [{ category: 'gpo', tier: 'good', catalogue_id: 'pick-me' }],
    })
    expect(r && 'row' in r && (r.row as TenantMaterial).name).toBe('Pick me')
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
    expect(e.labourHours).toEqual({ value: 2, source: 'global' })
    expect(e.markupPct).toEqual({ value: 28, source: 'global' })
  })
  it('localises labour + markup from a per-tenant override', () => {
    const e = effectiveAssembly(2, 28, { labour_hours_override: 3.5, markup_pct_override: 15 })
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
      { category: 'gpo', name: 'Unset customer supply GPO', unit_price_ex_gst: 42, customer_supply_price_ex_gst: 0, active: true },
      { category: 'tap', name: 'Invalid tap', unit_price_ex_gst: 0, customer_supply_price_ex_gst: null, active: true },
      { category: 'tap', name: 'Disabled tap', unit_price_ex_gst: 5, active: false },
    ]
    const out = catalogueCandidateRows(rows)
    expect(out).toEqual([
      { name: 'Phoenix mixer', price: 180, category: 'tap' },
      { name: 'Phoenix mixer', price: 90, category: 'tap' },
      { name: 'Unset customer supply GPO', price: 42, category: 'gpo' },
    ])
  })
})

describe('categoryHasCatalogueProduct (Catalogue↔Recipe sync badge)', () => {
  it('matches case- and whitespace-insensitively', () => {
    expect(categoryHasCatalogueProduct('Downlight', ['downlight'])).toBe(true)
    expect(categoryHasCatalogueProduct('  tap ', ['tap', 'gpo'])).toBe(true)
    expect(categoryHasCatalogueProduct('GPO', ['  gpo  '])).toBe(true)
  })
  it('is false when no catalogue product covers the recipe category', () => {
    // The exact silent-mispricing bug: recipe "downlights" vs catalogue "downlight".
    expect(categoryHasCatalogueProduct('downlights', ['downlight'])).toBe(false)
    expect(categoryHasCatalogueProduct('tap', [])).toBe(false)
    expect(categoryHasCatalogueProduct('tap', ['gpo', 'fan'])).toBe(false)
  })
  it('is false for empty / nullish recipe category or empty catalogue', () => {
    expect(categoryHasCatalogueProduct('', ['tap'])).toBe(false)
    expect(categoryHasCatalogueProduct(null, ['tap'])).toBe(false)
    expect(categoryHasCatalogueProduct(undefined, ['tap'])).toBe(false)
    expect(categoryHasCatalogueProduct('tap', [null, undefined, ''])).toBe(false)
  })
  it('normaliseCategory is the single canonical comparison form', () => {
    expect(normaliseCategory('  Hot_Water ')).toBe('hot_water')
    expect(normaliseCategory(null)).toBe('')
    expect(normaliseCategory(undefined)).toBe('')
  })
})

describe('buildBomQuoteLines — WP4 catalogue stamping', () => {
  const bom = [{ material_category: 'tap', quantity: 1, required: true }]
  it('stamps catalogue_id + image_path when the resolver supplies them', () => {
    const r = buildBomQuoteLines({
      bom,
      resolveMaterial: () => ({
        name: 'Caroma Liano Tap',
        markedUpPrice: 150,
        catalogue_id: 'P-123',
        image_path: 'https://x/caroma.jpg',
      }),
      labourHours: 1,
      labourRate: 110,
    })
    const mat = r.lines.find((l) => l.source === 'material')!
    expect(mat.catalogue_id).toBe('P-123')
    expect(mat.image_path).toBe('https://x/caroma.jpg')
  })
  it('omits the fields entirely for a shared (no-id) product', () => {
    const r = buildBomQuoteLines({
      bom,
      resolveMaterial: () => ({ name: 'Generic tap', markedUpPrice: 90 }),
      labourHours: 1,
      labourRate: 110,
    })
    const mat = r.lines.find((l) => l.source === 'material')!
    expect('catalogue_id' in mat).toBe(false)
    expect('image_path' in mat).toBe(false)
  })
})

describe('enrichLinesWithCatalogue (WP4 — link Opus lines to products)', () => {
  const catalogue = [
    { id: 'P-1', name: 'Caroma Liano Tap', image_path: 'https://x/liano.jpg' },
    { id: 'P-2', name: 'Clipsal Iconic GPO', image_path: 'https://x/iconic.jpg' },
  ]
  it('links a material line by case/space-insensitive name match', () => {
    const draft = {
      good: {
        line_items: [
          { description: 'caroma   liano tap', source: 'material' },
          { description: 'Labour', source: 'labour' },
        ],
      },
    }
    const r = enrichLinesWithCatalogue(draft, catalogue)
    expect(r.linked).toBe(1)
    expect(r.draft.good.line_items[0].catalogue_id).toBe('P-1')
    expect(r.draft.good.line_items[0].image_path).toBe('https://x/liano.jpg')
    // labour line untouched
    expect(r.draft.good.line_items[1].catalogue_id).toBeUndefined()
  })
  it('carries the catalogue description into product_description (render-only)', () => {
    const cat = [
      { id: 'P-1', name: 'Caroma Liano Tap', image_path: 'https://x/liano.jpg', description: 'Caroma Liano II wall mixer, chrome' },
    ]
    const draft = {
      good: { line_items: [{ description: 'Caroma Liano Tap', source: 'material' }] },
    }
    const r = enrichLinesWithCatalogue(draft, cat)
    expect(r.draft.good.line_items[0].product_description).toBe('Caroma Liano II wall mixer, chrome')
    // does not invent one when the catalogue row has no blurb
    const r2 = enrichLinesWithCatalogue(
      { good: { line_items: [{ description: 'Caroma Liano Tap', source: 'material' }] } },
      catalogue,
    )
    expect('product_description' in r2.draft.good.line_items[0]).toBe(false)
  })
  it('never overwrites an explicit link (deterministic stamping wins)', () => {
    const draft = {
      better: { line_items: [{ description: 'Caroma Liano Tap', source: 'material', catalogue_id: 'KEEP' }] },
    }
    const r = enrichLinesWithCatalogue(draft, catalogue)
    expect(r.draft.better.line_items[0].catalogue_id).toBe('KEEP')
    expect(r.linked).toBe(0)
  })
  it('is a no-op for inspection drafts, empty catalogue, and is idempotent', () => {
    expect(enrichLinesWithCatalogue({ needs_inspection: true, good: {} }, catalogue).linked).toBe(0)
    const d = { good: { line_items: [{ description: 'Caroma Liano Tap', source: 'material' }] } }
    expect(enrichLinesWithCatalogue(d, []).linked).toBe(0)
    const once = enrichLinesWithCatalogue(d, catalogue)
    const twice = enrichLinesWithCatalogue(once.draft, catalogue)
    expect(twice.linked).toBe(0) // already linked → idempotent
    expect(once.draft.good.line_items[0].catalogue_id).toBe('P-1')
  })
})

describe('applyChosenProduct (WP9 — chosen product gates the quote)', () => {
  const chosen = { catalogue_id: 'P-89', name: 'Black Fireflies', price_ex_gst: 89, image_path: 'bf.jpg' }

  it('forces the headline line to the chosen product + catalogue price + photo, recomputing totals', () => {
    const draft = {
      good: {
        subtotal_ex_gst: 999,
        line_items: [
          { description: 'Generic LED downlight', source: 'material', quantity: 6, unit: 'each', unit_price_ex_gst: 40, total_ex_gst: 240 },
          { description: 'Labour', source: 'labour', quantity: 2, unit: 'hr', unit_price_ex_gst: 110, total_ex_gst: 220 },
        ],
      },
    }
    const r = applyChosenProduct(draft, chosen)
    expect(r.applied).toEqual(['good'])
    const mat = r.draft.good.line_items[0]
    expect(mat.description).toBe('Black Fireflies')
    expect(mat.unit_price_ex_gst).toBe(89) // catalogue price, not 40
    expect(mat.quantity).toBe(6) // qty preserved
    expect(mat.total_ex_gst).toBe(534) // 89 * 6
    expect(mat.catalogue_id).toBe('P-89')
    expect(mat.image_path).toBe('bf.jpg') // WP4 render uses this
    expect(r.draft.good.subtotal_ex_gst).toBe(754) // 534 + 220 labour
  })

  it('stamps the catalogue blurb as render-only product_description (WP4 context)', () => {
    const draft = {
      good: {
        line_items: [
          { description: 'Generic LED downlight', source: 'material', quantity: 6, unit_price_ex_gst: 40, total_ex_gst: 240 },
          { description: 'Labour', source: 'labour', quantity: 2, unit_price_ex_gst: 110, total_ex_gst: 220 },
        ],
      },
    }
    const r = applyChosenProduct(draft, {
      ...chosen,
      description: 'Firefly Pro Series LED bulb, E27, frosted, warm white',
    })
    const mat = r.draft.good.line_items[0]
    expect(mat.product_description).toBe('Firefly Pro Series LED bulb, E27, frosted, warm white')
    // never overwrites the line text (that stays the product NAME)
    expect(mat.description).toBe('Black Fireflies')
    // absent blurb → no product_description key at all
    const r2 = applyChosenProduct(
      { good: { line_items: [{ description: 'x', source: 'material', quantity: 1, unit_price_ex_gst: 1, total_ex_gst: 1 }] } },
      chosen, // no description
    )
    expect('product_description' in r2.draft.good.line_items[0]).toBe(false)
  })

  it('skips sundry lines and never touches labour', () => {
    const draft = {
      better: {
        line_items: [
          { description: 'Plumbing sundries', source: 'material', quantity: 1, unit_price_ex_gst: 12, total_ex_gst: 12 },
          { description: 'Generic downlight', source: 'material', quantity: 2, unit_price_ex_gst: 30, total_ex_gst: 60 },
          { description: 'Labour', source: 'labour', quantity: 1, unit_price_ex_gst: 110, total_ex_gst: 110 },
        ],
      },
    }
    const r = applyChosenProduct(draft, chosen)
    expect(r.draft.better.line_items[0].description).toBe('Plumbing sundries')
    expect(r.draft.better.line_items[1].description).toBe('Black Fireflies')
    expect(r.draft.better.line_items[2].source).toBe('labour')
  })

  it('rewrites the stale tier label so it never contradicts the chosen product', () => {
    // Reported 2026-05-21: Opus labelled the tier with the DEFAULT tier
    // product ("Good — Brilliant Halo 90 9W LED") but the customer picked
    // a different one. The SMS + /q page render the label, so the customer
    // saw a product name that was NOT what they were quoted. The label
    // must always follow the chosen product.
    const draft = {
      good: {
        label: 'Good — Brilliant Halo 90 9W LED (warm white)',
        line_items: [
          { description: 'Brilliant Halo 90 9W LED', source: 'material', quantity: 6, unit: 'each', unit_price_ex_gst: 19.5, total_ex_gst: 117 },
          { description: 'Labour', source: 'labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 118, total_ex_gst: 354 },
        ],
      },
    }
    const r = applyChosenProduct(draft, chosen)
    expect(r.draft.good.label).toBe('Black Fireflies')
    // the invariant: label and the headline line item never disagree
    expect(r.draft.good.label).toBe(r.draft.good.line_items[0].description)
  })

  it('is a no-op for inspection drafts, no chosen, or bad price', () => {
    const d = { good: { line_items: [{ description: 'x', source: 'material', quantity: 1, unit_price_ex_gst: 1, total_ex_gst: 1 }] } }
    expect(applyChosenProduct({ needs_inspection: true, good: d.good }, chosen).applied).toEqual([])
    expect(applyChosenProduct(d, null).applied).toEqual([])
    expect(applyChosenProduct(d, { ...chosen, price_ex_gst: NaN }).applied).toEqual([])
  })
})

// PROOF for the exact real-world case Jon reported: a generic Opus
// draft (all tiers ~$759) + the customer's catalogue pick must produce
// the CATALOGUE price, not the generic number.
describe('applyChosenProduct — Jon\'s scenario (6 downlights, GST maths)', () => {
  // A realistic generic Opus draft: 6 generic downlights + 3h labour.
  const genericDraft = () => ({
    good: {
      subtotal_ex_gst: 690, // ~$759 inc GST — the wrong generic number
      line_items: [
        { description: 'Warm-white LED downlight', source: 'material', quantity: 6, unit: 'each', unit_price_ex_gst: 60, total_ex_gst: 360 },
        { description: 'Labour', source: 'labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 110, total_ex_gst: 330 },
      ],
    },
  })
  const incGst = (exGst: number) => +(exGst * 1.1).toFixed(2)

  it('Clipsal Downlight ($56) → 6×$56 + 3h labour ≈ $733 inc GST (NOT $759)', () => {
    const r = applyChosenProduct(genericDraft(), {
      catalogue_id: 'P-clipsal',
      name: 'Clipsal Downlight',
      price_ex_gst: 56,
      image_path: 'clipsal.jpg',
    })
    const t = r.draft.good
    const mat = t.line_items[0]
    expect(mat.description).toBe('Clipsal Downlight') // exact catalogue name
    expect(mat.unit_price_ex_gst).toBe(56) // exact catalogue price, no markup
    expect(mat.total_ex_gst).toBe(336) // 6 × 56
    expect(mat.image_path).toBe('clipsal.jpg') // → Gemini render
    expect(t.subtotal_ex_gst).toBe(666) // 336 + 330 labour (generic 60 gone)
    expect(incGst(t.subtotal_ex_gst)).toBe(732.6) // ≈ $730, NOT $759
  })

  it('Black Fireflies ($69) → 6×$69 + 3h labour ≈ $818 inc GST', () => {
    const r = applyChosenProduct(genericDraft(), {
      catalogue_id: 'P-fireflies',
      name: 'Black Fireflies',
      price_ex_gst: 69,
      image_path: 'ff.jpg',
    })
    const t = r.draft.good
    expect(t.line_items[0].unit_price_ex_gst).toBe(69)
    expect(t.line_items[0].total_ex_gst).toBe(414) // 6 × 69
    expect(t.subtotal_ex_gst).toBe(744) // 414 + 330
    expect(incGst(t.subtotal_ex_gst)).toBe(818.4) // ≈ $820
  })
})
