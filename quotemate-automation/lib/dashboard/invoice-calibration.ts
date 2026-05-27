// Invoice-history calibration — pure module that backs the dashboard's
// "upload your past invoices, we tune your prices" flow (A5).
//
// What this module does:
//   • Accepts the STRUCTURED form of a past invoice (extraction already done
//     upstream by Gemini vision + Opus — see app/api/tenant/calibration/*).
//   • Tries to match the scope to a shared_assemblies row.
//   • Computes what our recipe WOULD have quoted vs the invoice's actual total.
//   • When enough invoices accumulate (trust gates), suggests an hourly-rate
//     adjustment to close the systematic gap.
//   • Returns suggestions with explicit trust labels — UI never auto-applies.
//
// All pure: no DB, no fetch, no LLM. The API route assembles inputs from
// Supabase + the structured extraction and hands them here. Easy to test
// without mocking anything.
//
// Trust philosophy: changing a tradie's pricing_book affects every future
// quote. Suggestions must be defensible. We refuse to suggest when:
//   • Fewer than MIN_INVOICES_FOR_SUGGESTION invoices have a confident match
//   • The implied delta exceeds MAX_DELTA_PCT in a single suggestion
//   • The variance across invoice diffs is too high (signal:noise too low)

// ─────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────

/** What the extractor pulls out of a past invoice. Most fields are
 *  optional because real-world invoices are sparse (sometimes just
 *  "replaced 6 LED downlights — $850"). The two required fields are
 *  scope text + the inc-GST total — without them there's nothing to
 *  reconcile against. */
export type InvoiceExtraction = {
  /** Free-text scope of work as it appears on the invoice. */
  scope_description: string
  /** Customer total inc-GST (the only reliable money number — itemised
   *  totals are often missing from one-liner invoices). */
  total_inc_gst: number
  /** Best-guess job_type from the extraction prompt — one of the
   *  easy-5/easy-11 slugs the dialog already knows (downlights,
   *  power_points, hot_water, etc.). null if extraction couldn't guess. */
  job_type_guess?: string | null
  /** Best-guess item count (e.g. "6 downlights" → 6). null when the
   *  invoice doesn't say. */
  quantity?: number | null
  /** Optional customer metadata. Not used for calibration math, but
   *  surfaces in the audit log so the tradie can spot-check. */
  customer_name?: string | null
  customer_suburb?: string | null
  invoice_date?: string | null
}

/** A row from shared_assemblies — only the columns the recipe-matcher uses.
 *  Tenant overlay rows from tenant_custom_assemblies can be supplied in the
 *  same shape. */
export type AssemblyForMatch = {
  id: string
  name: string
  category: string | null
  trade: string | null
  default_labour_hours: number | string | null
  default_unit_price_ex_gst: number | string | null
}

/** Just the pricing_book fields calibration cares about. */
export type TenantPricingContext = {
  hourly_rate: number
  default_markup_pct: number
  /** Used to decide whether to gross-up materials/sundries for GST in the
   *  prediction calc. Matches the estimator's own behaviour. */
  gst_registered: boolean
  trade: string
}

// ─────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────

/** A recipe-match attempt against shared_assemblies + tenant overlays. */
export type RecipeMatch = {
  assembly_id: string
  assembly_name: string
  default_labour_hours: number
  default_unit_price_ex_gst: number
  confidence: 'high' | 'medium' | 'low'
  match_reason: string
}

/** What our recipe predicts vs what the invoice actually charged. Computed
 *  per invoice once a recipe match exists. */
export type PredictionDiff = {
  recipe_total_ex_gst: number
  recipe_total_inc_gst: number
  invoice_total_inc_gst: number
  /** invoice_total_inc_gst - recipe_total_inc_gst. Positive ⇒ tradie
   *  historically charges MORE than our recipe predicts. */
  diff_inc_gst: number
  /** (invoice - recipe) / recipe * 100. Positive ⇒ tradie charges more. */
  diff_pct: number
}

/** A suggested change to pricing_book. The UI surfaces these; tradie
 *  explicitly clicks Accept before any DB write. */
export type CalibrationSuggestion = {
  field: 'hourly_rate'
  current_value: number
  suggested_value: number
  /** suggested - current. */
  delta: number
  /** delta / current * 100. */
  delta_pct: number
  /** Human-readable explanation: "5 invoices show your prices run 12% above
   *  our recipe. Raising hourly from $120 to $134 closes the gap." */
  reason: string
  /** high: many invoices, low variance, modest delta → safe to apply.
   *  medium: borderline — UI should show "review carefully" copy.
   *  low: at the edge of trust gates — UI should make accept harder.
   *  reject: trust gates failed — UI should NOT show an accept button. */
  trust: 'high' | 'medium' | 'low' | 'reject'
  reject_reason?: string
  /** How many invoices contributed to this suggestion. */
  invoices_used: number
  /** Variance of diff_pct across the contributing invoices — surface this
   *  so the tradie can see "5 invoices range +8% to +18%" before clicking. */
  diff_pct_min: number
  diff_pct_max: number
  diff_pct_median: number
}

/** Top-level calibration report — what the dashboard panel displays. */
export type CalibrationReport = {
  invoices_total: number
  invoices_matched: number
  invoices_skipped: number
  /** Skipped reasons aggregated for tradie visibility. */
  skip_breakdown: Record<string, number>
  /** Currently zero or one entry — only hourly_rate is suggested for v1.
   *  Future iterations may add markup, materials, etc. */
  suggestions: CalibrationSuggestion[]
}

// ─────────────────────────────────────────────────────────────────────
// Tunables (trust gates)
// ─────────────────────────────────────────────────────────────────────

export const TRUST_GATES = {
  /** Minimum confidently-matched invoices before any suggestion. */
  MIN_INVOICES_FOR_SUGGESTION: 5,
  /** Suggestions exceeding this single-step delta are clamped + downgraded
   *  to medium trust (or rejected if even further out). */
  MAX_DELTA_PCT_HIGH_TRUST: 10,
  /** Above this delta we won't even surface — too big a jump to defend
   *  from invoice history alone. */
  MAX_DELTA_PCT_HARD_CAP: 25,
  /** If invoice diff_pcts swing wider than this range, signal is too
   *  noisy to suggest. */
  MAX_DIFF_PCT_RANGE_HIGH_TRUST: 15,
  /** Hard cap on noise. Beyond this we reject regardless. */
  MAX_DIFF_PCT_RANGE_HARD_CAP: 35,
} as const

// ─────────────────────────────────────────────────────────────────────
// Recipe matching
// ─────────────────────────────────────────────────────────────────────

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === '') return NaN
  return typeof v === 'string' ? parseFloat(v) : v
}

/**
 * Try to match an extracted invoice to a shared_assemblies row.
 *
 * Strategy (in order):
 *   1. If extraction.job_type_guess maps to a category, prefer assemblies
 *      with that category (most reliable signal).
 *   2. Otherwise, keyword match on assembly.name against scope_description.
 *   3. If multiple candidates remain, pick the one with the shortest name
 *      (avoids preferring overly-specific variants — e.g. "Install LED
 *      downlight" wins over "Install LED downlight (new install, single-
 *      storey)" when scope text is ambiguous).
 *
 * Returns null when nothing matches confidently — caller should record this
 * as a skipped invoice rather than suggest from bad data.
 */
export function matchRecipe(
  extraction: InvoiceExtraction,
  candidates: AssemblyForMatch[],
  trade: string,
): RecipeMatch | null {
  const scope = (extraction.scope_description ?? '').toLowerCase()
  if (scope.trim().length === 0) return null

  const tradeNorm = trade.trim().toLowerCase()
  const inTrade = candidates.filter(
    (a) => (a.trade ?? '').trim().toLowerCase() === tradeNorm,
  )
  if (inTrade.length === 0) return null

  // Job-type → category mapping mirrors lib/sms/product-options.ts's
  // JOB_TYPE_CATEGORY, but kept locally to avoid the dialog dependency.
  const jobTypeCategory: Record<string, string> = {
    downlights: 'downlight',
    power_points: 'gpo',
    ceiling_fans: 'fan',
    smoke_alarms: 'smoke_alarm',
    outdoor_lighting: 'outdoor_light',
    blocked_drain: 'drain',
    hot_water: 'hot_water',
    tap_repair: 'tap',
    tap_replace: 'tap',
    toilet_repair: 'toilet',
    toilet_replace: 'toilet',
  }

  // Step 1: category match.
  let candidatesForMatch = inTrade
  let matchReason = ''
  const guessed = (extraction.job_type_guess ?? '').trim().toLowerCase()
  if (guessed && jobTypeCategory[guessed]) {
    const cat = jobTypeCategory[guessed]
    const byCat = inTrade.filter(
      (a) => (a.category ?? '').trim().toLowerCase() === cat,
    )
    if (byCat.length > 0) {
      candidatesForMatch = byCat
      matchReason = `category=${cat} (from job_type_guess=${guessed})`
    }
  }

  // Step 2: keyword filter by name tokens present in the scope.
  // We only narrow if at least one candidate has a name word in the scope.
  const tokensByCandidate = candidatesForMatch.map((c) => {
    const name = c.name.toLowerCase()
    // Token = any 3+ char word in the name not in the stoplist. The 3-char
    // floor is deliberate so domain terms like "gpo" and "led" survive
    // while still dropping the worst of the noise ("a", "in", "to").
    const tokens = name
      .split(/[^a-z0-9]+/g)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    const matches = tokens.filter((t) => scope.includes(t))
    return { c, matches }
  })
  const withMatches = tokensByCandidate.filter((x) => x.matches.length > 0)
  if (withMatches.length > 0) {
    // Sort by most-matched tokens, then shortest name (specificity tiebreak).
    withMatches.sort((a, b) => {
      if (a.matches.length !== b.matches.length)
        return b.matches.length - a.matches.length
      return a.c.name.length - b.c.name.length
    })
    const best = withMatches[0]
    const labour = num(best.c.default_labour_hours)
    const unit = num(best.c.default_unit_price_ex_gst)
    if (!Number.isFinite(labour) || !Number.isFinite(unit)) return null
    const confidence: RecipeMatch['confidence'] =
      best.matches.length >= 2 && matchReason
        ? 'high'
        : best.matches.length >= 2 || matchReason
          ? 'medium'
          : 'low'
    return {
      assembly_id: best.c.id,
      assembly_name: best.c.name,
      default_labour_hours: labour,
      default_unit_price_ex_gst: unit,
      confidence,
      match_reason:
        [matchReason, `keywords=${best.matches.join(',')}`]
          .filter(Boolean)
          .join(' · '),
    }
  }

  // Step 3: category-only fallback (no keyword overlap but category was set).
  if (matchReason && candidatesForMatch.length > 0) {
    // Pick shortest name in the category as the most-generic row.
    const pick = [...candidatesForMatch].sort(
      (a, b) => a.name.length - b.name.length,
    )[0]
    const labour = num(pick.default_labour_hours)
    const unit = num(pick.default_unit_price_ex_gst)
    if (!Number.isFinite(labour) || !Number.isFinite(unit)) return null
    return {
      assembly_id: pick.id,
      assembly_name: pick.name,
      default_labour_hours: labour,
      default_unit_price_ex_gst: unit,
      confidence: 'low',
      match_reason: matchReason + ' (category-only)',
    }
  }

  return null
}

const STOPWORDS = new Set([
  // Verbs that appear in nearly every assembly name — kill them so a scope
  // can't trivially "match" via the verb alone.
  'install', 'replace', 'remove', 'fit', 'add', 'set',
  // Short connectors — don't help discriminate.
  'with', 'from', 'that', 'this', 'have', 'been', 'will', 'just', 'into',
  'over', 'and', 'the', 'for', 'are', 'was', 'one', 'two',
])

// ─────────────────────────────────────────────────────────────────────
// Prediction
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute what our recipe WOULD have quoted for this invoice — vs what
 * the tradie actually charged. The recipe is a deliberately simple
 * approximation: assembly.unit_price + labour at the tenant's hourly,
 * multiplied by quantity, with markup on materials/sundries.
 *
 * Not a full re-implementation of run.ts — calibration is about
 * SYSTEMATIC bias, not per-line accuracy. We accept that the recipe
 * total here may differ from a real Opus draft by a few %; what we care
 * about is whether the tradie's invoices consistently run high or low.
 */
export function computePrediction(
  match: RecipeMatch,
  quantity: number,
  context: TenantPricingContext,
  invoiceTotalIncGst: number,
): PredictionDiff {
  const q = Number.isFinite(quantity) && quantity > 0 ? quantity : 1

  // Material/sundries side — markup applies.
  const sundriesBase = match.default_unit_price_ex_gst * q
  const sundriesAfterMarkup =
    sundriesBase * (1 + context.default_markup_pct / 100)

  // Labour side — no markup.
  const labourBase = match.default_labour_hours * q * context.hourly_rate

  const recipeTotalExGst = +(sundriesAfterMarkup + labourBase).toFixed(2)
  const recipeTotalIncGst = context.gst_registered
    ? +(recipeTotalExGst * 1.1).toFixed(2)
    : recipeTotalExGst

  const diffIncGst = +(invoiceTotalIncGst - recipeTotalIncGst).toFixed(2)
  const diffPct =
    recipeTotalIncGst > 0 ? +((diffIncGst / recipeTotalIncGst) * 100).toFixed(2) : 0

  return {
    recipe_total_ex_gst: recipeTotalExGst,
    recipe_total_inc_gst: recipeTotalIncGst,
    invoice_total_inc_gst: +invoiceTotalIncGst.toFixed(2),
    diff_inc_gst: diffIncGst,
    diff_pct: diffPct,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Suggestion
// ─────────────────────────────────────────────────────────────────────

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * Given a set of prediction diffs, suggest an hourly-rate change that
 * would close the systematic gap (positive diff = tradie historically
 * charges MORE than our recipe → raise their hourly). Applies all the
 * trust gates from TRUST_GATES.
 *
 * Returns a CalibrationSuggestion with trust='reject' (and reject_reason)
 * when gates fail. The UI should NOT offer an Accept button in that case.
 */
export function suggestHourlyRateAdjustment(
  diffs: PredictionDiff[],
  context: TenantPricingContext,
): CalibrationSuggestion | null {
  if (diffs.length === 0) return null

  const diffPcts = diffs.map((d) => d.diff_pct)
  const medianPct = +median(diffPcts).toFixed(2)
  const minPct = +Math.min(...diffPcts).toFixed(2)
  const maxPct = +Math.max(...diffPcts).toFixed(2)
  const rangePct = +(maxPct - minPct).toFixed(2)

  // Apply the median delta as a multiplier on hourly_rate. We could split
  // the delta between hourly and markup, but for v1 we attribute all
  // systematic bias to hourly — most tradies underprice labour, not
  // materials, and surfacing one knob keeps the UI legible.
  const suggested = +Math.max(
    1,
    context.hourly_rate * (1 + medianPct / 100),
  ).toFixed(0)
  const delta = +(suggested - context.hourly_rate).toFixed(2)
  const deltaPct =
    context.hourly_rate > 0
      ? +((delta / context.hourly_rate) * 100).toFixed(2)
      : 0

  // Apply trust gates.
  let trust: CalibrationSuggestion['trust']
  let rejectReason: string | undefined
  if (diffs.length < TRUST_GATES.MIN_INVOICES_FOR_SUGGESTION) {
    trust = 'reject'
    rejectReason = `Need at least ${TRUST_GATES.MIN_INVOICES_FOR_SUGGESTION} matched invoices to suggest; have ${diffs.length}.`
  } else if (Math.abs(deltaPct) > TRUST_GATES.MAX_DELTA_PCT_HARD_CAP) {
    trust = 'reject'
    rejectReason = `Suggested change of ${Math.abs(deltaPct).toFixed(1)}% exceeds the hard cap of ${TRUST_GATES.MAX_DELTA_PCT_HARD_CAP}%. Review the invoices manually before adjusting.`
  } else if (rangePct > TRUST_GATES.MAX_DIFF_PCT_RANGE_HARD_CAP) {
    trust = 'reject'
    rejectReason = `Invoice variance (${rangePct.toFixed(1)}%) is too high — the underlying jobs are too different to suggest a single rate change.`
  } else if (
    Math.abs(deltaPct) <= TRUST_GATES.MAX_DELTA_PCT_HIGH_TRUST &&
    rangePct <= TRUST_GATES.MAX_DIFF_PCT_RANGE_HIGH_TRUST
  ) {
    trust = 'high'
  } else if (
    Math.abs(deltaPct) <= TRUST_GATES.MAX_DELTA_PCT_HARD_CAP &&
    rangePct <= TRUST_GATES.MAX_DIFF_PCT_RANGE_HARD_CAP
  ) {
    trust = 'medium'
  } else {
    trust = 'low'
  }

  const reason =
    `${diffs.length} matched invoice${diffs.length === 1 ? '' : 's'} show ` +
    `your prices ${medianPct >= 0 ? 'run' : 'come in'} ${Math.abs(medianPct).toFixed(1)}% ` +
    `${medianPct >= 0 ? 'above' : 'below'} our recipe (range ${minPct.toFixed(1)}% to ${maxPct.toFixed(1)}%). ` +
    `${medianPct >= 0 ? 'Raising' : 'Lowering'} hourly from $${context.hourly_rate} to $${suggested} closes the median gap.`

  return {
    field: 'hourly_rate',
    current_value: context.hourly_rate,
    suggested_value: suggested,
    delta,
    delta_pct: deltaPct,
    reason,
    trust,
    reject_reason: rejectReason,
    invoices_used: diffs.length,
    diff_pct_min: minPct,
    diff_pct_max: maxPct,
    diff_pct_median: medianPct,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Top-level orchestration
// ─────────────────────────────────────────────────────────────────────

/** One row of the per-invoice audit. */
export type CalibrationAuditEntry = {
  scope_short: string
  matched: boolean
  match_reason?: string
  diff_pct?: number
  skip_reason?: string
}

/**
 * Glue function: take N invoice extractions + the catalogue + the tenant's
 * pricing context. Run match → predict → suggest. Return the full report.
 *
 * Caller is responsible for sourcing the extractions (the upstream pipeline:
 * upload → Gemini vision → Opus structure). This function does no I/O.
 */
export function buildCalibrationReport(
  extractions: InvoiceExtraction[],
  candidates: AssemblyForMatch[],
  context: TenantPricingContext,
): CalibrationReport {
  const diffs: PredictionDiff[] = []
  const skipBreakdown: Record<string, number> = {}
  const incrementSkip = (reason: string) => {
    skipBreakdown[reason] = (skipBreakdown[reason] ?? 0) + 1
  }

  for (const ext of extractions) {
    if (!ext.scope_description || ext.scope_description.trim().length < 3) {
      incrementSkip('no_scope_text')
      continue
    }
    if (!Number.isFinite(ext.total_inc_gst) || ext.total_inc_gst <= 0) {
      incrementSkip('no_total')
      continue
    }
    const match = matchRecipe(ext, candidates, context.trade)
    if (!match) {
      incrementSkip('no_recipe_match')
      continue
    }
    if (match.confidence === 'low') {
      // Low-confidence matches inform the audit but don't feed the
      // suggestion — they'd just inject noise.
      incrementSkip('low_confidence_match')
      continue
    }
    const q = ext.quantity ?? 1
    const diff = computePrediction(match, q, context, ext.total_inc_gst)
    diffs.push(diff)
  }

  const suggestion = suggestHourlyRateAdjustment(diffs, context)
  const suggestions = suggestion ? [suggestion] : []

  return {
    invoices_total: extractions.length,
    invoices_matched: diffs.length,
    invoices_skipped: extractions.length - diffs.length,
    skip_breakdown: skipBreakdown,
    suggestions,
  }
}
