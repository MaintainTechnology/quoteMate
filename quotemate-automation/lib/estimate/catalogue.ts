// WP2 + WP3 — operator materials catalogue, brand/range -> tier mapping,
// structured bill-of-materials quote-line builder, and global-vs-local
// estimation-parameter resolution.
//
// PURE + dependency-free (unit-tested in catalogue.test.ts). No DB, no
// Supabase, no Next runtime. This is the single source of truth for the
// keystone behaviour; the estimator wiring (tools.ts lookup, run.ts
// candidate loader / preference block) and the dashboard both call into
// these helpers so the logic is provable in isolation before it ever
// touches the live money path.
//
// Money convention (CLAUDE.md): prices stored/computed ex-GST; markups
// round to 2dp exactly like applyMarkup() and buildCandidatePrices() so
// a BOM-built line grounds against the validator's candidate set instead
// of being dumped to inspection (the WP2 "trap").

export type Tier = 'good' | 'better' | 'best'

export interface TenantMaterial {
  id?: string
  category: string
  name: string
  brand?: string | null
  range_series?: string | null
  supplier?: string | null
  unit?: string | null
  unit_price_ex_gst: number | string
  customer_supply_price_ex_gst?: number | string | null
  tier_hint?: Tier | null
  active?: boolean | null
}

export interface SharedMaterial {
  name: string
  category?: string | null
  brand?: string | null
  unit?: string | null
  default_unit_price_ex_gst?: number | string | null
  unit_price_ex_gst?: number | string | null
}

export interface BomLine {
  material_category: string
  description?: string | null
  quantity: number | string
  required?: boolean | null
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === '') return NaN
  return typeof v === 'string' ? parseFloat(v) : v
}

/** Round to 2dp the same way applyMarkup()/buildCandidatePrices() do. */
function money(x: number): number {
  return +x.toFixed(2)
}

// ── brand + range -> tier ───────────────────────────────────────────
// A tradie can pin a tier explicitly via tenant_material_catalogue.tier_hint.
// When they haven't, infer from the range/series wording (Clipsal Iconic
// is the premium line; Clipsal 2000 is the standard line, etc.).
const BEST_RANGE = /\b(elite|signature|designer|deluxe|prestige)\b/i
const BETTER_RANGE = /\b(iconic|premium|pro|plus|smart|saturn)\b/i
const GOOD_RANGE = /\b(2000|standard|basic|budget|essential|classic|value|slimline)\b/i

/**
 * Resolve which tier a branded product belongs in.
 * Precedence: explicit hint > range/series keywords > brand keywords > null.
 * `null` means "no opinion" — the estimator treats it as tier-neutral.
 */
export function resolveTierForBrandRange(
  brand?: string | null,
  range?: string | null,
  hint?: Tier | null,
): Tier | null {
  if (hint === 'good' || hint === 'better' || hint === 'best') return hint
  const hay = `${brand ?? ''} ${range ?? ''}`.trim()
  if (!hay) return null
  if (BEST_RANGE.test(hay)) return 'best'
  if (BETTER_RANGE.test(hay)) return 'better'
  if (GOOD_RANGE.test(hay)) return 'good'
  return null
}

// ── tenant-preferred material selection ─────────────────────────────
export interface ChooseMaterialInput {
  tenantRows: TenantMaterial[]
  sharedRows: SharedMaterial[]
  category: string
  brand?: string | null
  range?: string | null
  tier?: Tier | null
}
export type ChosenMaterial =
  | { source: 'tenant'; row: TenantMaterial; price: number }
  | { source: 'shared'; row: SharedMaterial; price: number }
  | null

const eqi = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Pick the best material for a category. Operator-owned (active) rows are
 * ALWAYS preferred ahead of generic shared rows (WP2), scored by how
 * tightly they match the requested brand/range/tier. Falls back to shared
 * rows so a tenant who hasn't built a catalogue still gets a quote.
 */
export function chooseMaterial(input: ChooseMaterialInput): ChosenMaterial {
  const cat = input.category?.trim().toLowerCase()
  const tenant = input.tenantRows
    .filter((r) => (r.active ?? true) && r.category?.trim().toLowerCase() === cat)
    .filter((r) => Number.isFinite(num(r.unit_price_ex_gst)))
  if (tenant.length > 0) {
    const scored = tenant.map((r) => {
      let s = 1
      if (eqi(r.brand, input.brand)) s += 4
      if (eqi(r.range_series, input.range)) s += 4
      const rowTier = resolveTierForBrandRange(r.brand, r.range_series, r.tier_hint ?? null)
      if (input.tier && rowTier === input.tier) s += 2
      return { r, s }
    })
    scored.sort((a, b) => b.s - a.s)
    const best = scored[0].r
    return { source: 'tenant', row: best, price: money(num(best.unit_price_ex_gst)) }
  }
  const shared = input.sharedRows
    .filter((r) => !r.category || r.category.trim().toLowerCase() === cat)
    .map((r) => ({ r, price: num(r.unit_price_ex_gst ?? r.default_unit_price_ex_gst) }))
    .filter((x) => Number.isFinite(x.price))
  if (shared.length === 0) return null
  const brandHit = shared.find((x) => eqi(x.r.brand, input.brand))
  const pick = brandHit ?? shared[0]
  return { source: 'shared', row: pick.r, price: money(pick.price) }
}

// ── global-vs-local override resolution ─────────────────────────────
export interface ResolvedParam<T> {
  value: T
  source: 'local' | 'global'
}
/** Local override wins when present (non-null, and finite for numbers). */
export function resolveParam<T>(globalVal: T, localOverride: T | null | undefined): ResolvedParam<T> {
  if (localOverride === null || localOverride === undefined) {
    return { value: globalVal, source: 'global' }
  }
  if (typeof localOverride === 'number' && !Number.isFinite(localOverride)) {
    return { value: globalVal, source: 'global' }
  }
  return { value: localOverride, source: 'local' }
}

export interface AssemblyOverride {
  enabled?: boolean | null
  labour_hours_override?: number | string | null
  markup_pct_override?: number | string | null
}
export interface EffectiveAssembly {
  enabled: boolean
  labourHours: ResolvedParam<number>
  markupPct: ResolvedParam<number>
}
/** Fold a global assembly + a per-tenant override into the effective params
 *  the estimator should use AND the dashboard should display. */
export function effectiveAssembly(
  globalLabourHours: number | string,
  globalMarkupPct: number | string,
  override?: AssemblyOverride | null,
): EffectiveAssembly {
  const lhOv = override ? num(override.labour_hours_override) : NaN
  const muOv = override ? num(override.markup_pct_override) : NaN
  return {
    enabled: override?.enabled ?? true,
    labourHours: resolveParam(num(globalLabourHours), Number.isFinite(lhOv) ? lhOv : null),
    markupPct: resolveParam(num(globalMarkupPct), Number.isFinite(muOv) ? muOv : null),
  }
}

// ── structured BOM -> deterministic quote lines (WP3) ───────────────
export interface QuoteLine {
  description: string
  quantity: number
  unit: string
  unit_price_ex_gst: number
  total_ex_gst: number
  source: string
}
export interface BuildBomInput {
  bom: BomLine[]
  /** Resolve a marked-up unit price + display name for a material category.
   *  Injected so this stays DB-free and unit-testable. Return null when the
   *  category cannot be priced (caller routes to inspection). */
  resolveMaterial: (category: string) => { name: string; markedUpPrice: number } | null
  labourHours: number
  labourRate: number
  includeOptional?: boolean
}
export interface BuildBomResult {
  lines: QuoteLine[]
  /** Required BOM categories that could not be priced — non-empty means
   *  the caller should route the quote to inspection rather than ship a
   *  hole. Mirrors the grounding validator's safe-failure philosophy. */
  missingRequired: string[]
}
/**
 * Build the same quote lines for the same job every time (WP3): walk the
 * structured BOM in order, price each line via the injected resolver, add
 * a single labour line. No model free-association — deterministic.
 */
export function buildBomQuoteLines(input: BuildBomInput): BuildBomResult {
  const lines: QuoteLine[] = []
  const missingRequired: string[] = []
  const sorted = [...input.bom]
  for (const b of sorted) {
    const required = b.required ?? true
    if (!required && !input.includeOptional) continue
    const qty = num(b.quantity)
    if (!Number.isFinite(qty) || qty <= 0) {
      if (required) missingRequired.push(b.material_category)
      continue
    }
    const m = input.resolveMaterial(b.material_category)
    if (!m) {
      if (required) missingRequired.push(b.material_category)
      continue
    }
    const unitPrice = money(m.markedUpPrice)
    lines.push({
      description: b.description?.trim() || m.name,
      quantity: qty,
      unit: 'each',
      unit_price_ex_gst: unitPrice,
      total_ex_gst: money(unitPrice * qty),
      source: 'material',
    })
  }
  const lh = num(input.labourHours)
  const lr = num(input.labourRate)
  if (Number.isFinite(lh) && lh > 0 && Number.isFinite(lr)) {
    lines.push({
      description: 'Labour',
      quantity: lh,
      unit: 'hr',
      unit_price_ex_gst: money(lr),
      total_ex_gst: money(lh * lr),
      source: 'labour',
    })
  }
  return { lines, missingRequired }
}

// ── validator-acceptance feed (the WP2 "trap") ──────────────────────
/**
 * Flatten a tenant's catalogue into the {name, price} rows that
 * run.ts loadCandidatePrices feeds to buildCandidatePrices(), so a
 * branded tenant-priced line grounds instead of being dumped to
 * inspection. Includes the customer-supply price variant when set.
 * Pure so the acceptance logic is tested here, ahead of the wiring.
 */
export function catalogueCandidateRows(
  tenantRows: TenantMaterial[],
): Array<{ name: string; price: number }> {
  const out: Array<{ name: string; price: number }> = []
  for (const r of tenantRows) {
    if (r.active === false) continue
    const p = num(r.unit_price_ex_gst)
    if (Number.isFinite(p)) out.push({ name: r.name, price: money(p) })
    const cs = num(r.customer_supply_price_ex_gst)
    if (Number.isFinite(cs)) out.push({ name: r.name, price: money(cs) })
  }
  return out
}
