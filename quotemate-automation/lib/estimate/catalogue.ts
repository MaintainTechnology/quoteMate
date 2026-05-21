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
  /** What the tradie PAYS (margin insight only — never a sell price;
   *  the estimator and grounding validator never read this). */
  cost_price_ex_gst?: number | string | null
  /** Operator's own product blurb (display + later WP9 option labels). */
  description?: string | null
  /** Real product photo (WP4 render reference — URL or storage path).
   *  Carried through so the rendered preview shows THE EXACT product. */
  image_path?: string | null
  tier_hint?: Tier | null
  /** "My go-to product for this category" — a SOFT tiebreaker in
   *  chooseMaterial(), strictly below an exact brand/range/tier match. */
  is_preferred?: boolean | null
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

/** v7 Phase 3 — one entry in a tenant's explicit Good/Better/Best ladder.
 *  Sourced from tenant_tier_ladder (migration 043). */
export interface TierLadderEntry {
  category: string
  tier: Tier
  catalogue_id: string
}

export interface ChooseMaterialInput {
  tenantRows: TenantMaterial[]
  sharedRows: SharedMaterial[]
  category: string
  brand?: string | null
  range?: string | null
  tier?: Tier | null
  /** v7 Phase 3 — when set AND `tier` is set, a (category, tier) ladder
   *  hit beats every other signal. Lets a tradie pin "for downlights at
   *  Better tier, ALWAYS use SAL Anova" even when the model's brand/range
   *  inference would have picked a different row. */
  tierLadder?: TierLadderEntry[]
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
 *
 * v7 Phase 3 precedence: an explicit tier-ladder hit (when input.tier is
 * set AND the tenant declared a ladder for this category+tier) beats the
 * scoring loop. If the ladder row isn't in tenantRows (e.g. recently
 * deleted), we fall through to scoring — preserving the "zero-config
 * still works" guarantee.
 */
export function chooseMaterial(input: ChooseMaterialInput): ChosenMaterial {
  const cat = input.category?.trim().toLowerCase()

  // v7 Phase 3 — explicit ladder hit wins.
  if (input.tier && input.tierLadder && input.tierLadder.length > 0) {
    const ladderHit = input.tierLadder.find(
      (e) => e.tier === input.tier && e.category?.trim().toLowerCase() === cat,
    )
    if (ladderHit) {
      const ladderRow = input.tenantRows.find(
        (r) =>
          r.id === ladderHit.catalogue_id &&
          (r.active ?? true) &&
          Number.isFinite(num(r.unit_price_ex_gst)),
      )
      if (ladderRow) {
        return { source: 'tenant', row: ladderRow, price: money(num(ladderRow.unit_price_ex_gst)) }
      }
      // Ladder row not stocked / inactive → fall through to scoring.
    }
  }

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
      // "My go-to product" — a SOFT +1 tiebreaker only. Deliberately
      // below brand (+4), range (+4) and tier (+2) so it can ONLY decide
      // between rows that are otherwise an equal match; it never pulls
      // the estimator off an exact brand/range/tier hit.
      if (r.is_preferred === true) s += 1
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
  labour_hours_override?: number | string | null
  markup_pct_override?: number | string | null
}
export interface EffectiveAssembly {
  labourHours: ResolvedParam<number>
  markupPct: ResolvedParam<number>
}
/** Fold a global assembly + a per-tenant override into the effective params
 *  the estimator should use AND the dashboard should display.
 *  v7 Phase 0: `enabled` was removed — it lived on tenant_assembly_overrides
 *  but nothing wrote to it. The Services-tab toggle writes
 *  tenant_service_offerings.enabled instead, and that is now the single
 *  source of truth (read by /api/tenant/me AND /api/tenant/estimation). */
export function effectiveAssembly(
  globalLabourHours: number | string,
  globalMarkupPct: number | string,
  override?: AssemblyOverride | null,
): EffectiveAssembly {
  const lhOv = override ? num(override.labour_hours_override) : NaN
  const muOv = override ? num(override.markup_pct_override) : NaN
  return {
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
  /** WP4 — which operator catalogue product priced this line (render
   *  reference). Render-only metadata: NEVER read by the grounding
   *  validator or any price math, so it cannot affect money/routing. */
  catalogue_id?: string | null
  image_path?: string | null
  /** Operator's catalogue blurb for this product (render-only, same
   *  no-money guarantee as catalogue_id/image_path). */
  product_description?: string | null
}
export interface BuildBomInput {
  bom: BomLine[]
  /** Resolve a marked-up unit price + display name for a material category.
   *  Injected so this stays DB-free and unit-testable. Return null when the
   *  category cannot be priced (caller routes to inspection). The optional
   *  catalogue_id/image_path are WP4 render metadata only — they never
   *  influence price. */
  resolveMaterial: (category: string) => {
    name: string
    markedUpPrice: number
    catalogue_id?: string | null
    image_path?: string | null
  } | null
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
      // WP4 — stamp the priced product so the render can show it.
      ...(m.catalogue_id ? { catalogue_id: m.catalogue_id } : {}),
      ...(m.image_path ? { image_path: m.image_path } : {}),
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
): Array<{ name: string; price: number; category: string | null }> {
  const out: Array<{ name: string; price: number; category: string | null }> = []
  for (const r of tenantRows) {
    if (r.active === false) continue
    const p = num(r.unit_price_ex_gst)
    const category = r.category ?? null
    if (Number.isFinite(p) && p > 0) out.push({ name: r.name, price: money(p), category })
    const cs = num(r.customer_supply_price_ex_gst)
    if (Number.isFinite(cs) && cs > 0) out.push({ name: r.name, price: money(cs), category })
  }
  return out
}

// ── soft prompt hints (WP2 brand/range, WP3 structured BOM) ─────────
// Both are SOFT hints appended to the user message — the grounding
// validator still enforces correctness regardless. Empty input -> null
// so legacy/no-catalogue tenants and an unseeded BOM table change
// nothing (additive, no regression).

export interface CatalogueHintRow {
  category: string
  name: string
  brand?: string | null
  range_series?: string | null
  tier_hint?: Tier | null
}
/** "Prefer THESE exact products, mapped to the tier shown" — makes the
 *  operator's brand+range catalogue (WP2) visible to the model. */
export function formatCatalogueHint(rows: CatalogueHintRow[]): string | null {
  const valid = rows.filter((r) => r?.category && r?.name)
  if (valid.length === 0) return null
  const byCat = new Map<string, string[]>()
  for (const r of valid) {
    const tier = resolveTierForBrandRange(r.brand, r.range_series, r.tier_hint ?? null)
    const label = [r.brand, r.range_series].filter(Boolean).join(' ')
    const desc = `${r.name}${label ? ` (${label})` : ''}${tier ? ` -> ${tier}` : ''}`
    const arr = byCat.get(r.category) ?? []
    arr.push(desc)
    byCat.set(r.category, arr)
  }
  const lines = [...byCat.entries()].map(([cat, items]) => `  • ${cat}: ${items.join('; ')}`)
  return [
    "Tradie operator catalogue (prefer THESE exact products; brand+range maps to the tier shown):",
    ...lines,
    "Pick the catalogue row that fits the customer's tier/spec; grounding validation runs regardless.",
  ].join('\n')
}

/** v7 Phase 3 — one row of a tenant's explicit Good/Better/Best ladder
 *  for prompt-time soft hinting (formatTierLadderHint). The product_name
 *  + brand are denormalised from the tenant_material_catalogue row that
 *  catalogue_id points to so the helper stays DB-free. */
export interface TierLadderHintRow {
  category: string
  tier: Tier
  product_name: string
  brand?: string | null
}

/** "MUST use these products for the named tier" — the strongest soft
 *  hint we surface, designed to be paired with formatCatalogueHint()
 *  (which lists the wider catalogue) and formatBomHint() (which lists
 *  the BOM). The grounding validator still has the final say. */
export function formatTierLadderHint(rows: TierLadderHintRow[]): string | null {
  const valid = rows.filter((r) => r?.category && r?.tier && r?.product_name)
  if (valid.length === 0) return null
  const TIER_ORDER: Record<Tier, number> = { good: 0, better: 1, best: 2 }
  const byCat = new Map<string, TierLadderHintRow[]>()
  for (const r of valid) {
    const arr = byCat.get(r.category) ?? []
    arr.push(r)
    byCat.set(r.category, arr)
  }
  const lines = [...byCat.entries()].map(([cat, items]) => {
    const sorted = [...items].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier])
    const labels = sorted.map((i) => {
      const brand = i.brand ? ` (${i.brand})` : ''
      return `${i.tier}=${i.product_name}${brand}`
    })
    return `  • ${cat}: ${labels.join('; ')}`
  })
  return [
    "Tradie's EXPLICIT Good/Better/Best ladder (use these exact products for the named tier):",
    ...lines,
  ].join('\n')
}

export interface BomHintRow {
  material_category: string
  quantity: number | string
  required?: boolean | null
  description?: string | null
}
/** "Standard bill of materials for this job" — makes WP3's structured
 *  BOM visible so the same job quotes the same parts every time. */
export function formatBomHint(rows: BomHintRow[]): string | null {
  const valid = rows.filter((r) => r?.material_category && Number(num(r.quantity)) > 0)
  if (valid.length === 0) return null
  const lines = valid.map((r) => {
    const opt = (r.required ?? true) ? '' : ' (optional)'
    const d = r.description ? ` ${r.description}` : ''
    return `  • ${num(r.quantity)} x ${r.material_category}${d}${opt}`
  })
  return [
    'Standard bill of materials for this job (quote these parts consistently every time):',
    ...lines,
    'These are the baseline parts. Price each from the catalogue / shared materials.',
  ].join('\n')
}

// ── Catalogue ↔ Recipe coverage (Phase 1 sync visibility) ───────────
// The estimator joins a Recipe line to a Catalogue product by matching
// their category strings. If those strings don't line up, the tradie's
// real product + price is silently dropped and the line falls back to a
// generic price (or inspection). These helpers are the ONE definition of
// "same category" so the dashboard badge — and any future estimator-side
// check — agree. Pure; unit-tested in catalogue.test.ts.

/** Trim + lowercase, the single canonical category comparison form. */
export function normaliseCategory(c: string | null | undefined): string {
  return (c ?? '').trim().toLowerCase()
}

/**
 * True when the tradie has at least one priced, active catalogue product
 * in this recipe line's category. Drives the Recipes "priced from your
 * catalogue" vs "no product — generic price" badge so a silent
 * Catalogue↔Recipe category mismatch becomes visible instead of quietly
 * costing the operator their real product and price.
 */
export function categoryHasCatalogueProduct(
  recipeCategory: string | null | undefined,
  catalogueCategories: Array<string | null | undefined>,
): boolean {
  const target = normaliseCategory(recipeCategory)
  if (!target) return false
  return catalogueCategories.some((c) => normaliseCategory(c) === target)
}

// ── WP4 — link quote lines back to the catalogue product ────────────
// The Opus draft writes line items as free text ("Caroma Liano tap").
// AFTER grounding has PASSED, match each material line back to the
// operator catalogue row that priced it (by normalised name) and stamp
// catalogue_id + image_path so the render step can show THE EXACT
// product. This is render-only metadata: it runs after pricing +
// validation, never touches a price/total/route, and only fills fields
// that are MISSING (so the deterministic path's own stamping always
// wins and the helper is idempotent). Pure; unit-tested.

export interface CatalogueProductRef {
  id?: string | null
  name: string
  image_path?: string | null
  /** Operator's own product blurb — carried to the render prompt. */
  description?: string | null
}

export interface EnrichResult {
  draft: any
  /** How many line items got an operator product linked (for logging). */
  linked: number
}

/** Canonical product-name comparison form (trim + lowercase + collapse
 *  internal whitespace) so "Caroma  Liano Tap" == "caroma liano tap". */
function normaliseName(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function enrichLinesWithCatalogue(
  draft: any,
  catalogue: CatalogueProductRef[],
): EnrichResult {
  if (!draft || draft.needs_inspection === true) return { draft, linked: 0 }
  const byName = new Map<string, CatalogueProductRef>()
  for (const p of catalogue ?? []) {
    const k = normaliseName(p?.name)
    if (k && !byName.has(k)) byName.set(k, p)
  }
  if (byName.size === 0) return { draft, linked: 0 }

  let linked = 0
  for (const tierKey of ['good', 'better', 'best'] as const) {
    const tier = draft[tierKey] as
      | { line_items?: Array<Record<string, unknown>> }
      | null
      | undefined
    if (!tier || !Array.isArray(tier.line_items)) continue
    for (const li of tier.line_items) {
      if (!li) continue
      const src = li.source
      if (src === 'labour' || src === 'call_out') continue
      // Never overwrite an explicit link — the deterministic builder
      // already stamped the exact source product.
      if (li.catalogue_id) continue
      const hit = byName.get(normaliseName(li.description as string))
      if (!hit) continue
      if (hit.id) li.catalogue_id = hit.id
      if (hit.image_path) li.image_path = hit.image_path
      // Render-only blurb; only fill when the line doesn't already have
      // one (deterministic / WP9 stamping always wins). Never priced.
      if (
        hit.description &&
        String(hit.description).trim() !== '' &&
        !li.product_description
      ) {
        li.product_description = String(hit.description).trim()
      }
      if (hit.id || hit.image_path) linked++
    }
  }
  return { draft, linked }
}

// ── WP9 — force the customer's mid-chat pick into the quote ─────────
// When a customer chose a specific operator product, the quote MUST
// show THAT product at THAT catalogue price with THAT photo — not a
// generic line. enrichLinesWithCatalogue only *links by name*; this
// goes further and overwrites the headline material line of each
// priced tier with the chosen product. Runs AFTER grounding: the price
// is the operator's own catalogue price (the WP2-guaranteed legitimate
// price the customer literally selected), so this is consistent with
// the money model — same "adjust the locked draft" pattern as
// applyMinLabourFloor. Pure; unit-tested. No-op when nothing chosen.

export interface ChosenProductInput {
  catalogue_id: string
  name: string
  price_ex_gst: number
  image_path?: string | null
  /** Operator's own product blurb (render-only context for WP4). */
  description?: string | null
}
export interface ApplyChosenResult {
  draft: any
  /** Tiers whose headline line was set to the chosen product. */
  applied: string[]
}

const SUNDRY_RE = /sundr|seal|tape|\bclip\b|terminal|^fittings,/i

export function applyChosenProduct(
  draft: any,
  chosen: ChosenProductInput | null | undefined,
): ApplyChosenResult {
  if (!draft || draft.needs_inspection === true || !chosen) return { draft, applied: [] }
  const price = Number(chosen.price_ex_gst)
  if (!Number.isFinite(price) || price < 0 || !chosen.name) return { draft, applied: [] }
  const unitPrice = +price.toFixed(2)
  const applied: string[] = []

  for (const tierKey of ['good', 'better', 'best'] as const) {
    const tier = draft[tierKey] as
      | { line_items?: Array<Record<string, any>>; subtotal_ex_gst?: number | string; label?: string }
      | null
      | undefined
    if (!tier || !Array.isArray(tier.line_items) || tier.line_items.length === 0) continue
    const items = tier.line_items
    const notLabour = (li: any) => li && li.source !== 'labour' && li.source !== 'call_out'
    // Prefer the headline (non-sundry) material line; else any material line.
    let idx = items.findIndex(
      (li) => notLabour(li) && !SUNDRY_RE.test(String(li?.description ?? '')),
    )
    if (idx < 0) idx = items.findIndex((li) => notLabour(li))
    if (idx < 0) continue

    const li = items[idx]
    const qty = Number(li.quantity)
    const q = Number.isFinite(qty) && qty > 0 ? qty : 1
    li.description = chosen.name
    li.unit = li.unit || 'each'
    li.quantity = q
    li.unit_price_ex_gst = unitPrice
    li.total_ex_gst = +(unitPrice * q).toFixed(2)
    li.source = 'material'
    li.catalogue_id = chosen.catalogue_id
    if (chosen.image_path) li.image_path = chosen.image_path
    // Render-only product blurb (same guarantee as image_path /
    // catalogue_id: never read by the validator or any price math).
    // Fed to the WP4 image prompt so Gemini knows WHAT the product is,
    // not just its photo.
    if (chosen.description && String(chosen.description).trim() !== '') {
      li.product_description = String(chosen.description).trim()
    }

    // Keep the tier label consistent with the headline line we just
    // rewrote. Opus generated the label around the DEFAULT tier product;
    // once the customer's explicit pick is forced into the line item, a
    // stale label names a product the quote no longer contains — the
    // customer SMS and /q page would show the wrong product name. The
    // label must always match the chosen product.
    tier.label = chosen.name

    tier.subtotal_ex_gst = +items
      .reduce((s, x) => s + (Number(x?.total_ex_gst) || 0), 0)
      .toFixed(2)
    applied.push(tierKey)
  }
  return { draft, applied }
}
