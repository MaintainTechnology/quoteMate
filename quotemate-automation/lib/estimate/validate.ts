// Database-grounding validator — runs after Opus emits a draft quote and
// before the quote is persisted. Walks every line_item and verifies its
// unit_price_ex_gst is traceable to a real DB row × pricing_book derivation.
//
// If any line item fails, the route handler downgrades the entire quote
// to inspection-required: tiers wiped to null, $199 site-visit fee becomes
// the only chargeable amount, customer is told "pricing not yet available".
//
// This is the fourth layer of defence against fabricated prices, on top of:
//   1. STRICT GROUNDING in the system prompt
//   2. NON-NEGOTIABLE RULES in the system prompt
//   3. Route-level forced null tiers when needs_inspection is true
//   4. THIS validator — the only deterministic, machine-checkable layer

export type PricingBookForValidation = {
  hourly_rate: number | string
  apprentice_rate: number | string
  call_out_minimum: number | string
  default_markup_pct: number | string
}

export type GroundingFailure = {
  tier: 'good' | 'better' | 'best'
  lineIndex: number
  description: string
  unit: string
  unit_price_ex_gst: number
  expected: string
}

export type GroundingResult =
  | { valid: true }
  | { valid: false; failures: GroundingFailure[] }

export type CandidatePrices = {
  /** All raw + marked-up shared_materials.default_unit_price_ex_gst values */
  material: number[]
  /** All raw + marked-up shared_assemblies.default_unit_price_ex_gst values */
  assembly: number[]
}

/** Tolerance in dollars — Stripe stores cents; markups round; allow ±$0.50 */
const PRICE_TOLERANCE = 0.5

function n(v: number | string): number {
  return typeof v === 'string' ? parseFloat(v) : v
}

export function validateQuoteGrounding(
  draft: any,
  pricingBook: PricingBookForValidation,
  candidates: CandidatePrices,
): GroundingResult {
  // Inspection-required quotes don't carry line items to validate.
  if (draft?.needs_inspection === true) return { valid: true }

  const hourly = n(pricingBook.hourly_rate)
  const apprentice = n(pricingBook.apprentice_rate)
  const callOut = n(pricingBook.call_out_minimum)
  const markupPct = n(pricingBook.default_markup_pct)

  const within = (a: number, b: number) => Math.abs(a - b) <= PRICE_TOLERANCE
  const matchesAny = (price: number, list: number[]) => list.some((p) => within(p, price))

  const failures: GroundingFailure[] = []
  const TIERS = ['good', 'better', 'best'] as const

  for (const tierKey of TIERS) {
    const tier = draft?.[tierKey]
    if (!tier || !Array.isArray(tier.line_items)) continue

    for (let i = 0; i < tier.line_items.length; i++) {
      const li = tier.line_items[i]
      const price = Number(li?.unit_price_ex_gst)
      const description = String(li?.description ?? '(no description)')
      const unit = String(li?.unit ?? '?')

      if (!Number.isFinite(price)) {
        failures.push({
          tier: tierKey, lineIndex: i, description, unit,
          unit_price_ex_gst: price,
          expected: 'finite numeric unit_price_ex_gst',
        })
        continue
      }

      let valid = false
      let expected = ''

      if (unit === 'hr') {
        // Labour rates: hourly_rate or apprentice_rate exactly
        valid = within(price, hourly) || within(price, apprentice)
        expected = `pricing_book.hourly_rate ($${hourly}) or apprentice_rate ($${apprentice})`
      } else if (li?.source === 'callout' || (unit === 'each' && within(price, callOut))) {
        // Call-out — unit is 'each' but price matches call_out_minimum
        valid = within(price, callOut)
        expected = `pricing_book.call_out_minimum ($${callOut})`
      } else if (unit === 'each' || unit === 'lm') {
        // Materials or assemblies — raw or marked-up
        valid = matchesAny(price, candidates.material) || matchesAny(price, candidates.assembly)
        expected = `shared_materials/shared_assemblies (raw or × ${markupPct}% markup)`
      } else {
        valid = false
        expected = `recognised unit (hr / each / lm)`
      }

      if (!valid) {
        failures.push({
          tier: tierKey, lineIndex: i, description, unit,
          unit_price_ex_gst: price,
          expected,
        })
      }
    }
  }

  return failures.length === 0 ? { valid: true } : { valid: false, failures }
}

/**
 * Build the candidate-price arrays used by validateQuoteGrounding.
 * For each raw DB price, expands into multiple realistic markup variants
 * (10% to 40% in 5% steps, plus the tradie's configured default_markup_pct).
 * This range covers AU electrical industry-standard markups while still
 * rejecting genuinely hallucinated prices that fall outside it.
 */
export function buildCandidatePrices(
  rawMaterialPrices: Array<number | string | null | undefined>,
  rawAssemblyPrices: Array<number | string | null | undefined>,
  pricingBook: PricingBookForValidation,
): CandidatePrices {
  // AU electrical markup range — covers what a tradie might realistically
  // pass to apply_markup. Default markup_pct is included even if outside
  // the 10–40 band.
  const standardMarkups = new Set<number>([0, 10, 15, 20, 25, 28, 30, 35, 40])
  standardMarkups.add(n(pricingBook.default_markup_pct))

  const multipliers = Array.from(standardMarkups).map((pct) => 1 + pct / 100)

  const expand = (rows: Array<number | string | null | undefined>): number[] => {
    const out: number[] = []
    for (const v of rows) {
      const raw = Number(v)
      if (!Number.isFinite(raw)) continue
      for (const m of multipliers) {
        out.push(+(raw * m).toFixed(2))
      }
    }
    return out
  }

  return {
    material: expand(rawMaterialPrices),
    assembly: expand(rawAssemblyPrices),
  }
}
