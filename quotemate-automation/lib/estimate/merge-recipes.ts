// Phase 3 — wire the price-bands recipe engine into the estimator
// pipeline. After Opus produces a draft (and after applyMinLabourFloor
// has filled the labour floor), this module walks each tier's line items
// looking for `source: "assembly:<id>"` references whose underlying
// catalogue row carries a `price_recipe`. For each match, the recipe is
// evaluated against the customer's slot answers (typically lifted from
// intake.scope and conversation_state.slots) and the resulting modifiers
// are merged into the tier.
//
// Two transformations are possible per matched line:
//
//   1. APPEND (always, when bands produce extras)
//      • Additional labour line items at pricing_book.hourly_rate
//      • Additional material line items at raw catalogue price × markup
//      • Risk-flag strings appended to draft.risk_flags
//      Subtotal is recalculated so the customer sees the right total.
//
//   2. SWAP (only when a select band fires use_assembly_id)
//      • The old assembly's sundries line + paired source='labour' lines
//        are removed
//      • New sundries + labour lines for the override assembly are
//        inserted in their place, at the override assembly's own
//        default_unit_price_ex_gst (× markup) and default_labour_hours
//        (× hourly_rate). Other lines (materials, callout, risk_buffer,
//        tradie_edit) are preserved.
//
// Design notes:
//   • Pure function — no I/O, no Supabase, no LLM. Determined entirely
//     by its inputs (draft, recipesByAssemblyId, assembliesById, slots,
//     pricingBook). Tested in isolation in merge-recipes.test.ts.
//   • Idempotent on no-op — if no tier carries a recipe-bearing assembly,
//     or no slot data matches, the draft is returned with outcome.changed
//     = false. The grounding validator downstream sees the unchanged
//     draft and validates exactly as today.
//   • Labour-strip semantics for SWAP: when an override fires, we remove
//     ALL `source: 'labour'` lines from the tier and insert ONE replacement
//     for the new assembly's labour hours. This deliberately overwrites
//     any labour line Opus emitted for the original assembly. Callout,
//     risk-buffer, and tradie_edit lines use distinct source tags and are
//     preserved unchanged. Lines without a recognised source pass through.
//   • Subtotal recompute: round to 2dp to match the grounding validator's
//     ±$0.50 tolerance band and avoid floating-point drift.
//   • Multiple recipe-bearing lines per tier: each is processed in order,
//     extras accumulate, the LAST override (if any) wins (matches the
//     applyPriceBands "later override wins" contract for assembly_override_id).

import {
  applyPriceBands,
  type PriceQuestion,
  type ApplyPriceBandsResult,
  type BandLineItem,
} from './price-bands'

/** A line item on a draft tier. Loose typing — Opus emits a fixed shape
 *  but other fields may be present (e.g. catalogue_id, image_path); we
 *  preserve them on passthrough. */
export type DraftLineItem = {
  description?: string
  quantity?: number | string
  unit?: string
  unit_price_ex_gst?: number | string
  source?: string
  total_ex_gst?: number | string
  [k: string]: unknown
}

export type DraftTier = {
  line_items?: DraftLineItem[]
  subtotal_ex_gst?: number | string
  [k: string]: unknown
}

export type DraftWithTiers = {
  good?: DraftTier | null
  better?: DraftTier | null
  best?: DraftTier | null
  risk_flags?: string[]
  [k: string]: unknown
}

/** Subset of shared_assemblies / tenant_custom_assemblies needed to swap
 *  a tier's base assembly. price_recipe stays out of this shape — it
 *  goes through recipesByAssemblyId instead so callers can keep the
 *  recipe map in jsonb form and the assembly meta in row form. */
export type AssemblyMeta = {
  id: string
  name: string
  default_unit_price_ex_gst: number | string
  default_labour_hours: number | string
}

export type MergePricingBook = {
  hourly_rate: number | string
  default_markup_pct?: number | string
}

export type MergeInput = {
  /** assembly_id → ordered list of PriceQuestion. Empty/missing = no recipe. */
  recipesByAssemblyId: Map<string, readonly PriceQuestion[]>
  /** assembly_id → row meta (name, price, labour). Used for SWAP rebuilds. */
  assembliesById: Map<string, AssemblyMeta>
  /** Slot answers from conversation_state + intake.scope. The recipe
   *  engine reads these by `id` to bucket the customer's response into
   *  the right band. */
  slots: Readonly<Record<string, unknown>>
  pricingBook: MergePricingBook
}

/** Per-tier diagnostic record — emitted for log visibility so operators
 *  can see when a recipe fired without sifting through line-item diffs. */
export type TierMergeOutcome = {
  changed: boolean
  recipes_fired: string[]
  swapped_from: string[]
  swapped_to: string[]
  added_line_items: number
  risk_flags_added: string[]
  defaults_used: string[]
}

export type DraftMergeOutcome = {
  good: TierMergeOutcome
  better: TierMergeOutcome
  best: TierMergeOutcome
  /** True if ANY tier changed. Cheap sentinel for log/skip checks. */
  any_changed: boolean
}

const emptyOutcome = (): TierMergeOutcome => ({
  changed: false,
  recipes_fired: [],
  swapped_from: [],
  swapped_to: [],
  added_line_items: 0,
  risk_flags_added: [],
  defaults_used: [],
})

/** Extract `<id>` from a source string shaped `"assembly:<id>"`.
 *  Returns null for material:* / labour / callout / undefined / malformed. */
function parseAssemblyId(source: unknown): string | null {
  if (typeof source !== 'string') return null
  const m = source.match(/^assembly:([A-Za-z0-9_-]+)$/)
  return m ? m[1] : null
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return parseFloat(v)
  return Number.NaN
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Tier-level merge. Returns a new tier object — the input tier is
 *  never mutated. */
export function mergeRecipesIntoTier(
  tier: DraftTier,
  input: MergeInput,
): { tier: DraftTier; outcome: TierMergeOutcome } {
  const outcome = emptyOutcome()
  const inputLines = Array.isArray(tier.line_items) ? tier.line_items : []
  if (inputLines.length === 0) {
    return { tier, outcome }
  }

  // Walk all lines once, collect recipe results keyed by assembly id.
  // We process recipes IN ORDER so that "last override wins" matches the
  // applyPriceBands contract: if two recipe-bearing assemblies fire on
  // the same tier with conflicting overrides, the later one stays.
  const recipeResults: Array<{ asmId: string; result: ApplyPriceBandsResult }> = []
  for (const li of inputLines) {
    const asmId = parseAssemblyId(li.source)
    if (!asmId) continue
    const recipe = input.recipesByAssemblyId.get(asmId)
    if (!recipe || recipe.length === 0) continue
    const result = applyPriceBands(recipe, input.slots, input.pricingBook)
    outcome.recipes_fired.push(asmId)
    for (const d of result.defaults_used) {
      if (!outcome.defaults_used.includes(d)) outcome.defaults_used.push(d)
    }
    recipeResults.push({ asmId, result })
  }

  if (recipeResults.length === 0) {
    return { tier, outcome }
  }

  // Find the LAST override (if any). Earlier overrides are ignored to
  // match applyPriceBands's "later override wins" within a single recipe;
  // when multiple recipes fire we extend that ordering across tiers.
  let overrideTargetId: string | null = null
  let overrideSourceId: string | null = null
  for (const { asmId, result } of recipeResults) {
    if (result.assembly_override_id) {
      overrideTargetId = result.assembly_override_id
      overrideSourceId = asmId
    }
  }

  let workingLines: DraftLineItem[]

  if (overrideTargetId) {
    const newAsm = input.assembliesById.get(overrideTargetId)
    if (!newAsm) {
      // Override target not in candidate set — defensive no-swap path.
      // Falling back to "no override" rather than silently mis-pricing
      // matches the grounding validator's fail-closed philosophy.
      workingLines = inputLines.slice()
    } else {
      const markupPct = toNumber(input.pricingBook.default_markup_pct)
      const markupMultiplier =
        Number.isFinite(markupPct) && markupPct > 0 ? 1 + markupPct / 100 : 1
      const hourly = toNumber(input.pricingBook.hourly_rate)
      const newSundriesPrice = round2(
        toNumber(newAsm.default_unit_price_ex_gst) * markupMultiplier,
      )
      const newLabourHours = toNumber(newAsm.default_labour_hours)

      // Strip ALL assembly:<id> lines + ALL source='labour' lines; preserve
      // everything else (materials, callout, risk_buffer, tradie_edit, lines
      // without a recognised source).
      const preserved = inputLines.filter((li) => {
        const src = typeof li.source === 'string' ? li.source : ''
        if (parseAssemblyId(li.source)) return false
        if (src === 'labour') return false
        return true
      })

      const newSundriesLine: DraftLineItem = {
        description: newAsm.name,
        quantity: 1,
        unit: 'each',
        unit_price_ex_gst: newSundriesPrice,
        total_ex_gst: newSundriesPrice,
        source: `assembly:${newAsm.id}`,
      }
      const newLabourLine: DraftLineItem = {
        description: `Labour — ${newAsm.name}`,
        quantity: Number.isFinite(newLabourHours) ? newLabourHours : 0,
        unit: 'hr',
        unit_price_ex_gst: Number.isFinite(hourly) ? hourly : 0,
        total_ex_gst:
          Number.isFinite(newLabourHours) && Number.isFinite(hourly)
            ? round2(newLabourHours * hourly)
            : 0,
        source: 'labour',
      }
      workingLines = [newSundriesLine, newLabourLine, ...preserved]
      outcome.swapped_from.push(overrideSourceId!)
      outcome.swapped_to.push(overrideTargetId)
    }
  } else {
    workingLines = inputLines.slice()
  }

  // Append the extras from EVERY recipe that fired. Extras accumulate
  // (they're additive scoping — extra cable run, extra labour, etc. —
  // not competing).
  for (const { result } of recipeResults) {
    for (const li of result.extra_line_items) {
      workingLines.push(bandLineToDraftLine(li))
      outcome.added_line_items += 1
    }
    for (const rf of result.risk_flags) {
      outcome.risk_flags_added.push(rf)
    }
  }

  // `changed` reflects whether the tier was MATERIALLY modified — extras
  // appended OR a successful swap fired. A recipe that ran but produced
  // zero effects (e.g. customer answer fell into the zero-modifier band,
  // or defaults landed there) returns the original tier untouched. The
  // diagnostic fields on outcome (recipes_fired, defaults_used) are
  // still populated so operators can see what ran.
  const actuallyChanged =
    outcome.added_line_items > 0 || outcome.swapped_to.length > 0
  if (!actuallyChanged) {
    return { tier, outcome }
  }

  // Recompute subtotal_ex_gst from final lines. Uses quantity * unit_price
  // (matches how the schema documents subtotal — sum of line totals).
  const subtotal = workingLines.reduce((s, li) => {
    const q = toNumber(li.quantity)
    const p = toNumber(li.unit_price_ex_gst)
    if (!Number.isFinite(q) || !Number.isFinite(p)) return s
    return s + q * p
  }, 0)

  outcome.changed = true
  const outTier: DraftTier = {
    ...tier,
    line_items: workingLines,
    subtotal_ex_gst: round2(subtotal),
  }
  return { tier: outTier, outcome }
}

function bandLineToDraftLine(li: BandLineItem): DraftLineItem {
  return {
    description: li.description,
    quantity: li.quantity,
    unit: li.unit,
    unit_price_ex_gst: li.unit_price_ex_gst,
    total_ex_gst: round2(li.quantity * li.unit_price_ex_gst),
    source: li.source,
  }
}

/** Draft-level merge — walks good/better/best, returns a new draft with
 *  recipe modifiers applied + per-tier outcome + roll-up. Risk flags from
 *  every tier are appended to draft.risk_flags (deduped). */
export function mergeRecipesIntoDraft(
  draft: DraftWithTiers | null | undefined,
  input: MergeInput,
): { draft: DraftWithTiers; outcome: DraftMergeOutcome } {
  const safeDraft: DraftWithTiers = draft ?? {}
  const outcome: DraftMergeOutcome = {
    good: emptyOutcome(),
    better: emptyOutcome(),
    best: emptyOutcome(),
    any_changed: false,
  }
  // Fast-path: zero recipes loaded → nothing to do. Cheap, common.
  if (input.recipesByAssemblyId.size === 0) {
    return { draft: safeDraft, outcome }
  }

  const result: DraftWithTiers = { ...safeDraft }
  const accumulatedFlags = new Set<string>(
    Array.isArray(safeDraft.risk_flags) ? safeDraft.risk_flags : [],
  )

  for (const key of ['good', 'better', 'best'] as const) {
    const tier = safeDraft[key]
    if (!tier || typeof tier !== 'object') continue
    const { tier: outTier, outcome: tierOutcome } = mergeRecipesIntoTier(
      tier,
      input,
    )
    if (tierOutcome.changed) {
      result[key] = outTier
      for (const rf of tierOutcome.risk_flags_added) accumulatedFlags.add(rf)
      outcome.any_changed = true
    }
    outcome[key] = tierOutcome
  }

  if (outcome.any_changed) {
    result.risk_flags = Array.from(accumulatedFlags)
  }
  return { draft: result, outcome }
}

/** Helper for callers building the slot map from a typical intake +
 *  conversation_state. The recipe engine looks up by `id`, so:
 *    1. Top-level intake fields (job_type, suburb, item_count, …)
 *    2. intake.scope.* keys
 *    3. conversation_state.slots.* keys (overrides intake — newer signal)
 *  Later sources win on conflict. Returns a flat object. */
export function buildRecipeSlots(
  intake: any,
  conversationState?: { slots?: Record<string, unknown> } | null,
): Record<string, unknown> {
  const slots: Record<string, unknown> = {}
  if (intake && typeof intake === 'object') {
    // 1. shallow top-level
    for (const [k, v] of Object.entries(intake)) {
      if (v == null) continue
      if (typeof v === 'object') continue // nested goes through scope below
      slots[k] = v
    }
    // 2. scope
    const scope = (intake as any).scope
    if (scope && typeof scope === 'object') {
      for (const [k, v] of Object.entries(scope)) {
        if (v == null) continue
        if (typeof v === 'object') continue
        slots[k] = v
      }
      // 2b. scope.specs
      const specs = (scope as any).specs
      if (specs && typeof specs === 'object') {
        for (const [k, v] of Object.entries(specs)) {
          if (v == null) continue
          if (typeof v === 'object') continue
          slots[k] = v
        }
      }
    }
  }
  // 3. conversation_state.slots (most recent answers)
  if (conversationState && typeof conversationState === 'object') {
    const convSlots = conversationState.slots
    if (convSlots && typeof convSlots === 'object') {
      for (const [k, v] of Object.entries(convSlots)) {
        if (v == null) continue
        slots[k] = v
      }
    }
  }
  return slots
}
