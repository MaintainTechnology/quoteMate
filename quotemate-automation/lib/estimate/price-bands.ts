// Price-band recipes — turn a customer's answer to a clarifying question
// into concrete line-item modifiers (extra labour, extra materials,
// assembly swap, risk flags) so jobs that today route to a $99 inspection
// get auto-quoted with the right scope instead.
//
// The recipe model:
//   • Each metric-able trigger (e.g. "no power within 5 metres of the GPO")
//     becomes a PriceQuestion with a numeric or select variant.
//   • Each PriceQuestion carries `bands` — an ordered list of (threshold,
//     modifier) pairs.
//   • At quote time we read the customer's answer from the dialog state,
//     find the matching band, and apply its modifier to the draft.
//
// Phase 1 (this file): pure module + types + tests. NO DB integration,
// NO live-path wiring. We prove the algorithm in isolation first.
// Phase 2 will land the DB shape + estimator integration + dialog
// slot extensions.
//
// Design decisions baked in here:
//   • EVERY band must produce a price. No "route_to_inspection" band
//     outcome — the inspection escape hatch lives only at the
//     non-metric trigger layer (wet-area, pre-1970, gas, asbestos).
//     The last numeric band MUST set max=Number.POSITIVE_INFINITY so
//     unbounded answers always land somewhere with a real price.
//   • Per-trigger defaults — when the dialog hasn't captured the slot
//     yet (customer didn't volunteer it, dialog didn't ask), the
//     question's `default_when_unanswered` decides which band applies.
//     `used_default: true` is surfaced on the result so the caller can
//     stamp a risk_flag explaining the assumption.
//   • Labour cost is always pricing_book.hourly_rate × extra_labour_hr —
//     the band stores the HOURS, the caller's pricing_book stores the $/hr.
//   • Material cost is whatever `unit_price_ex_gst` the band specifies —
//     the band author (operator) is responsible for setting the
//     marked-up price. This module is a pass-through.

/** A single line-item the band wants added to the draft. Mirrors the
 *  shape the estimator produces (see lib/estimate/run.ts), so the caller
 *  can append these to draft.good.line_items / better / best as-is. */
export type BandLineItem = {
  description: string
  quantity: number
  unit: 'each' | 'hr' | 'lm' | 'm' | 'metre' | 'metres'
  unit_price_ex_gst: number
  /** Source tag for the grounding validator. 'labour' for labour lines,
   *  'material:<id>' for material lines whose UUID anchor is known, or a
   *  plain category-style string for legacy/loose grounding. */
  source: string
}

/** Material entry inside a band's modifier list. The author supplies the
 *  final marked-up unit_price (the recipe author knows the catalogue
 *  price + the markup policy; this module is dumb pass-through). */
export type BandExtraMaterial = {
  description: string
  quantity: number
  unit: BandLineItem['unit']
  unit_price_ex_gst: number
  /** Optional source tag — recommended to thread the catalogue UUID
   *  through so the grounding validator's strict-UUID path accepts it. */
  source?: string
}

/** Numeric band — used for questions whose answer is a measurement
 *  (distance in metres, ceiling height, item count, fixture count). The
 *  customer's answer (a number) gets bucketed into the FIRST band where
 *  `answer <= max`. The catch-all band uses `max: null` (JSON-safe) or
 *  `max: Number.POSITIVE_INFINITY` (in-process). */
export type NumericBand = {
  /** Inclusive upper bound. Bands are checked top-to-bottom in array
   *  order, so always declare them ascending. The last band MUST set
   *  `max: null` (preferred for DB storage — Number.POSITIVE_INFINITY
   *  doesn't round-trip through JSON.stringify) or
   *  `max: Number.POSITIVE_INFINITY` (for in-code fixtures). Either is
   *  treated as the catch-all. */
  max: number | null
  /** Human-readable description for the modifier line description.
   *  Surfaced as "Additional labour — <label>" etc. */
  label?: string
  /** Extra hours added to labour. Priced at pricing_book.hourly_rate. */
  extra_labour_hr?: number
  /** Extra materials to append as separate line items. */
  extra_materials?: BandExtraMaterial[]
  /** Risk_flag string appended to draft.risk_flags. */
  risk_flag?: string
}

/** Select/enum band — used for categorical questions (10A vs 20A vs
 *  three-phase, single-storey vs multi-storey). The customer's answer is
 *  compared verbatim against `value`. First exact match wins. */
export type SelectBand = {
  /** The slot value this band fires on. Case-insensitive comparison via
   *  applyPriceBands. */
  value: string
  label?: string
  /** Optionally swap the base assembly entirely. The caller is responsible
   *  for re-running lookup against this new id. Common pattern: 10A → 20A
   *  → 32A-3phase assemblies that each have their own labour profile. */
  use_assembly_id?: string
  extra_labour_hr?: number
  extra_materials?: BandExtraMaterial[]
  risk_flag?: string
}

/** A single clarifying question with price-recipe semantics. The `id`
 *  must match a key in the dialog's conversation_state.slots so the
 *  customer's answer can be looked up. */
export type PriceQuestion =
  | {
      id: string
      question: string
      variant: 'numeric'
      /** Used when slots[id] is null/undefined. Falls into one of the
       *  numeric bands so a missing answer still yields a price. */
      default_when_unanswered?: number
      bands: NumericBand[]
    }
  | {
      id: string
      question: string
      variant: 'select'
      default_when_unanswered?: string
      bands: SelectBand[]
    }

/** Result of applying all bands across a question set. The caller
 *  appends these to draft.line_items + draft.risk_flags, and consults
 *  assembly_override_id to decide if a different base assembly should
 *  be looked up. */
export type ApplyPriceBandsResult = {
  extra_line_items: BandLineItem[]
  risk_flags: string[]
  /** When a select band sets use_assembly_id, the LAST one wins (later
   *  questions override earlier ones — operators should order their
   *  recipes so the most-specific question runs last). */
  assembly_override_id?: string
  /** Per-question diagnostic: which slots fell back to the default. The
   *  estimator can stamp these as risk flags ("Assumed X based on
   *  catalogue default — confirm onsite") if visibility is wanted. */
  defaults_used: string[]
}

/** Minimal pricing-book shape we depend on. Kept narrow so callers can
 *  pass either a real pricing_book row or a test fixture. */
export type PriceBandsPricingBook = {
  hourly_rate: number | string
  /** Per-tenant markup percentage (e.g. 36 = 36%). Applied to RAW catalogue
   *  prices stored in band.extra_materials so a single shared recipe can be
   *  used across tenants with different markups. When undefined or 0, the
   *  raw price is passed through unchanged (back-compat with Phase-1 tests
   *  and any caller that pre-marked-up prices in the band itself). */
  default_markup_pct?: number | string
}

/**
 * Apply every question's price-band recipe to a slot object and return
 * the accumulated line items + risk flags + (optional) assembly swap.
 *
 * Pure function — no I/O, no Supabase, no side effects. Determined entirely
 * by its inputs, which makes it easy to unit-test every band edge case.
 */
export function applyPriceBands(
  questions: readonly PriceQuestion[],
  slots: Readonly<Record<string, unknown>>,
  pricingBook: PriceBandsPricingBook,
): ApplyPriceBandsResult {
  const out: ApplyPriceBandsResult = {
    extra_line_items: [],
    risk_flags: [],
    defaults_used: [],
  }
  const hourlyRate = toNumber(pricingBook.hourly_rate)
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
    // Defensive: a misconfigured pricing book would otherwise produce
    // NaN-priced labour lines that the grounding validator would reject
    // with a confusing message. Bail early and let the caller fall back
    // to the un-banded draft.
    return out
  }
  // Per-tenant markup multiplier applied to RAW material prices stored on
  // bands. 36% → 1.36. Negative or NaN → treated as 0 (no markup, raw
  // passes through — back-compat with Phase-1 tests).
  const markupPctRaw = toNumber(pricingBook.default_markup_pct)
  const markupMultiplier =
    Number.isFinite(markupPctRaw) && markupPctRaw > 0 ? 1 + markupPctRaw / 100 : 1

  for (const q of questions) {
    const rawAnswer = slots[q.id]
    let answer: unknown = rawAnswer
    if (rawAnswer === null || rawAnswer === undefined || rawAnswer === '') {
      if (q.default_when_unanswered === undefined) continue
      answer = q.default_when_unanswered
      out.defaults_used.push(q.id)
    }

    if (q.variant === 'numeric') {
      applyNumericBand(q, answer, hourlyRate, markupMultiplier, out)
    } else {
      applySelectBand(q, answer, hourlyRate, markupMultiplier, out)
    }
  }
  return out
}

function applyNumericBand(
  q: Extract<PriceQuestion, { variant: 'numeric' }>,
  answer: unknown,
  hourlyRate: number,
  markupMultiplier: number,
  out: ApplyPriceBandsResult,
): void {
  const n = toNumber(answer)
  if (!Number.isFinite(n)) return
  // Bands are checked in declaration order — first one whose max >= n wins.
  // null max acts as the catch-all (Number.POSITIVE_INFINITY equivalent;
  // chosen because Infinity doesn't survive JSON.stringify for the DB).
  const band = q.bands.find((b) => b.max === null || b.max === undefined || n <= b.max)
  if (!band) return
  emitBandSideEffects(band, hourlyRate, markupMultiplier, out)
}

function applySelectBand(
  q: Extract<PriceQuestion, { variant: 'select' }>,
  answer: unknown,
  hourlyRate: number,
  markupMultiplier: number,
  out: ApplyPriceBandsResult,
): void {
  const v = String(answer).trim().toLowerCase()
  if (!v) return
  const band = q.bands.find((b) => b.value.trim().toLowerCase() === v)
  if (!band) return
  if (band.use_assembly_id) out.assembly_override_id = band.use_assembly_id
  emitBandSideEffects(band, hourlyRate, markupMultiplier, out)
}

function emitBandSideEffects(
  band: NumericBand | SelectBand,
  hourlyRate: number,
  markupMultiplier: number,
  out: ApplyPriceBandsResult,
): void {
  if (band.extra_labour_hr && band.extra_labour_hr > 0) {
    const desc = band.label
      ? `Additional labour — ${band.label}`
      : 'Additional labour (recipe)'
    out.extra_line_items.push({
      description: desc,
      quantity: band.extra_labour_hr,
      unit: 'hr',
      unit_price_ex_gst: hourlyRate,
      source: 'labour',
    })
  }
  for (const m of band.extra_materials ?? []) {
    if (!Number.isFinite(m.unit_price_ex_gst) || m.unit_price_ex_gst < 0) continue
    if (!Number.isFinite(m.quantity) || m.quantity <= 0) continue
    // Raw catalogue price × tenant markup. round2 keeps the line price at
    // 2-decimal cents to match the grounding validator's ±$0.50 tolerance
    // band without floating-point fuzz.
    const marked = round2(m.unit_price_ex_gst * markupMultiplier)
    out.extra_line_items.push({
      description: m.description,
      quantity: m.quantity,
      unit: m.unit,
      unit_price_ex_gst: marked,
      source: m.source ?? 'material',
    })
  }
  if (band.risk_flag) out.risk_flags.push(band.risk_flag)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return parseFloat(v)
  return Number.NaN
}
