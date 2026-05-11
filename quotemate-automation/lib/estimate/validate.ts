// Database-grounding validator — runs after Opus emits a draft quote and
// before the quote is persisted. Walks every line_item and verifies that
// its unit_price_ex_gst is traceable to a real DB row × pricing_book
// derivation AND that the line description and the source row are in
// the same product category (downlights, GPOs, smoke alarms, etc).
//
// If any line item fails, the route handler downgrades the entire quote
// to inspection-required: tiers wiped to null, $199 site-visit fee becomes
// the only chargeable amount, customer is told "pricing not yet available".
//
// This is the fourth and last layer of defence against fabricated prices,
// on top of:
//   1. STRICT GROUNDING in the system prompt
//   2. NON-NEGOTIABLE RULES in the system prompt
//   3. Route-level forced null tiers when needs_inspection is true
//   4. THIS validator — the only deterministic, machine-checkable layer
//
// Updated 2026-05-06: previous version checked that the price existed in
// the DB but did not verify the SEMANTIC match between the line text and
// the source row. That allowed bugs like a "smoke alarm" line being
// priced from a "downlight" row at the same dollar amount × different
// markup. Now we require category overlap as well.

export type PricingBookForValidation = {
  hourly_rate: number | string
  apprentice_rate: number | string
  call_out_minimum: number | string
  default_markup_pct: number | string
  /** Minimum labour hours per priced tier — enforces "small job allowance".
   *  Optional for back-compat; defaults to 2.0 if not provided. */
  min_labour_hours?: number | string
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

/** A categorised candidate price — one entry per DB row × markup variant. */
export type CandidatePrice = {
  /** Marked-up dollar amount that a line item could legitimately quote. */
  price: number
  /** The original row's name, e.g. "Tri-colour LED downlight". */
  sourceName: string
  /** Category tags extracted from the source name. */
  categories: Set<Category>
}

export type CandidatePrices = {
  material: CandidatePrice[]
  assembly: CandidatePrice[]
}

/** Tolerance in dollars — Stripe stores cents; markups round; allow ±$0.50 */
const PRICE_TOLERANCE = 0.5

function n(v: number | string): number {
  return typeof v === 'string' ? parseFloat(v) : v
}

// ─────────────────────────────────────────────────────────────────
// Category extraction — keyword tags applied to both candidate rows
// and line descriptions. Validation passes only when at least one
// tag appears on both sides.
// ─────────────────────────────────────────────────────────────────

export type Category =
  // ── Electrical (v3) ─────────────────────────────
  | 'downlight'
  | 'gpo'
  | 'smoke_alarm'
  | 'fan'
  | 'outdoor_light'
  | 'rcbo'
  | 'oven_cooktop'
  | 'ev_charger'
  | 'switchboard'
  // ── Plumbing (v5 multi-trade) ──────────────────
  | 'drain'        // hand-rod / jet-blast clear of blocked drain
  | 'hot_water'    // HWS replacement (electric / gas / heat pump)
  | 'tap'          // tap repair, tap replace, mixer, washer
  | 'toilet'       // toilet suite install, cistern repair
  | 'cctv'         // CCTV drain camera inspection
  | 'gas'          // gas appliance connection, gas leak detection
  | 'prv'          // pressure reduction valve install
  // ── Shared ───────────────────────────────────────
  | 'sundry'       // disposal, terminals, fittings, seals, tape, etc.
  | 'general'

/** Extract category tags from arbitrary product-name or line-description text. */
export function categorise(text: string): Set<Category> {
  const t = (text ?? '').toLowerCase()
  const cats = new Set<Category>()

  // ── Electrical ──────────────────────────────────────────────────
  // Outdoor first — "outdoor IP-rated LED light" must beat the bare-LED rule.
  if (/\b(outdoor|exterior|deck|weatherproof|ip[-\s]?rated|garden|patio|wall\s*pack)\b/.test(t)) {
    cats.add('outdoor_light')
  }
  if (/\bdownlight/.test(t)) cats.add('downlight')
  if (/\b(gpo|power\s*point|socket|wall\s*outlet|\busb\s*out)/.test(t)) cats.add('gpo')
  if (/\bsmoke\s*alarm|\binterconnect(?:ed)?\s+alarm/.test(t)) cats.add('smoke_alarm')
  if (/\b(ceiling\s*fan|\bfan\b)/.test(t)) cats.add('fan')
  if (/\b(rcbo|safety\s*switch|safety\s*breaker|circuit\s*breaker)\b/.test(t)) cats.add('rcbo')
  if (/\b(oven|cooktop|stove|range\s*hood)\b/.test(t)) cats.add('oven_cooktop')
  if (/\b(ev\s*charger|electric\s*vehicle|wallbox)\b/.test(t)) cats.add('ev_charger')
  if (/\b(switchboard|switch\s*board|main\s*board|distribution\s*board)\b/.test(t)) {
    cats.add('switchboard')
  }

  // ── Plumbing (v5) ───────────────────────────────────────────────
  // CCTV first — "CCTV drain inspection" must beat the bare-drain rule.
  if (/\b(cctv|drain[-\s]?camera|camera\s*inspection)/.test(t)) cats.add('cctv')
  if (/\b(drain|blockage|blocked\s*pipe|jet[-\s]?blast(?:ing)?|hand[-\s]?rod(?:ding)?|jet[-\s]?clear)/.test(t)) {
    cats.add('drain')
  }
  if (/\b(hot\s*water|\bhws\b|heat\s*pump|continuous[-\s]?flow|storage\s*tank|water\s*heater)/.test(t)) {
    cats.add('hot_water')
  }
  if (/\b(tap[s]?\b|mixer|tap\s*washer|faucet|spout)/.test(t)) cats.add('tap')
  if (/\b(toilet|cistern|close[-\s]?coupled|wall[-\s]?faced|in[-\s]?wall\s*cistern|flush\s*valve|fill\s*valve)/.test(t)) {
    cats.add('toilet')
  }
  if (/\b(gas\s*(?:appliance|leak|fitting|cooktop|oven|line|supply|pipe|connection)|gas[-\s]?bayonet|\blpg\b)\b/.test(t)) {
    cats.add('gas')
  }
  if (/\b(pressure[-\s]?reduction\s*valve|\bprv\b|pressure\s*valve)/.test(t)) cats.add('prv')

  // ── Shared sundries (both trades) ───────────────────────────────
  if (/\b(sundries|sundry|terminals|consumables|miscellaneous|extras|disposal|removal\s*of\s*old|fittings\s*and\s*seals|pipe\s*tape|plumbing\s*sundries|teflon|ptfe)\b/.test(t)) {
    cats.add('sundry')
  }

  if (cats.size === 0) cats.add('general')
  return cats
}

/**
 * A line description and a candidate row "match categorically" when:
 *   - they share at least one specific tag (downlight ∩ downlight), OR
 *   - the line is purely 'general' AND the row is 'sundry' only — handles
 *     legitimate catch-all lines like "Disposal of old fittings" being
 *     priced from the Sundries row.
 */
function categoriesMatch(lineCats: Set<Category>, rowCats: Set<Category>): boolean {
  for (const lc of lineCats) {
    for (const rc of rowCats) {
      if (lc === rc) return true
    }
  }
  if (lineCats.has('general') && rowCats.size === 1 && rowCats.has('sundry')) return true
  return false
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
  const minLabourHours = pricingBook.min_labour_hours != null
    ? n(pricingBook.min_labour_hours)
    : 2.0

  const within = (a: number, b: number) => Math.abs(a - b) <= PRICE_TOLERANCE

  /** Candidate rows whose price matches `target` within tolerance. */
  const findMatches = (target: number, list: CandidatePrice[]) =>
    list.filter((c) => within(c.price, target))

  const failures: GroundingFailure[] = []
  const TIERS = ['good', 'better', 'best'] as const

  for (const tierKey of TIERS) {
    const tier = draft?.[tierKey]
    if (!tier || !Array.isArray(tier.line_items)) continue

    // Per-tier labour-hours minimum check. Sum every unit='hr' line.
    // If the tier has any line items at all but labour totals below
    // pricing_book.min_labour_hours, fail the tier — Opus has skipped
    // the small-job-allowance rule.
    const labourHours = tier.line_items
      .filter((li: any) => li?.unit === 'hr')
      .reduce((sum: number, li: any) => sum + (Number(li?.quantity) || 0), 0)
    if (tier.line_items.length > 0 && labourHours < minLabourHours - 0.05) {
      failures.push({
        tier: tierKey,
        lineIndex: -1,
        description: '(tier-level labour total)',
        unit: 'hr',
        unit_price_ex_gst: labourHours,
        expected: `at least ${minLabourHours} hr of labour per tier (got ${labourHours.toFixed(2)})`,
      })
    }

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
        // Labour rates: hourly_rate or apprentice_rate exactly. No semantic
        // category check — labour lines are intrinsically generic.
        valid = within(price, hourly) || within(price, apprentice)
        expected = `pricing_book.hourly_rate ($${hourly}) or apprentice_rate ($${apprentice})`
      } else if (li?.source === 'callout' || (unit === 'each' && within(price, callOut))) {
        // Call-out — unit is 'each' but price matches call_out_minimum.
        valid = within(price, callOut)
        expected = `pricing_book.call_out_minimum ($${callOut})`
      } else if (unit === 'each' || unit === 'lm') {
        // Materials or assemblies — price match AND category match required.
        const lineCats = categorise(description)
        const priceMatches = [
          ...findMatches(price, candidates.material),
          ...findMatches(price, candidates.assembly),
        ]

        if (priceMatches.length === 0) {
          valid = false
          expected = `shared_materials/shared_assemblies (raw or × ${markupPct}% markup)`
        } else {
          // Of the rows that match by price, do any also match by category?
          const semanticMatch = priceMatches.find((c) => categoriesMatch(lineCats, c.categories))
          if (semanticMatch) {
            valid = true
          } else {
            valid = false
            const lineCatList = Array.from(lineCats).join(',')
            const sourceList = priceMatches
              .map((c) => `"${c.sourceName}" [${Array.from(c.categories).join(',')}]`)
              .slice(0, 3)
              .join(' | ')
            expected = `price $${price} only exists in DB rows of a different category. Line categorised as [${lineCatList}], but matching rows are: ${sourceList}`
          }
        }
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
 * Build the candidate-price set used by validateQuoteGrounding.
 * For each raw DB row (name + price), expand into multiple realistic
 * markup variants (10% to 40% in 5% steps, plus the tradie's configured
 * default_markup_pct). Each variant carries the source row's name and
 * extracted category tags so semantic grounding can be enforced.
 */
export function buildCandidatePrices(
  rawMaterialRows: Array<{ name: string; price: number | string | null | undefined }>,
  rawAssemblyRows: Array<{ name: string; price: number | string | null | undefined }>,
  pricingBook: PricingBookForValidation,
): CandidatePrices {
  // STRICT MARKUP POLICY: only the tradie's configured default_markup_pct
  // is permitted (plus 0% raw, used when Opus quotes a base material as
  // a customer-supply line or when the assembly bakes the markup in).
  //
  // Rationale: previously we allowed [0, 10, 15, 20, 25, 28, 30, 35, 40]%
  // which gave Opus 9 valid prices per row — too much slack. With multiple
  // valid prices per row, the same intake on two calls could produce
  // different but still-valid quotes (e.g. $48 raw vs $48 × 1.30 = $62.40
  // vs $48 × 1.28 = $61.44). Tightening to exactly two values per row
  // forces convergence: same input → same output.
  //
  // To soften this and prevent edge-case rejections, also allow:
  //   - +5% drift on default markup (rounding tolerance)
  // The validator's $0.50 PRICE_TOLERANCE absorbs the rest.
  const defaultMarkup = n(pricingBook.default_markup_pct)
  const standardMarkups = new Set<number>([0, defaultMarkup])

  const multipliers = Array.from(standardMarkups).map((pct) => 1 + pct / 100)

  const expand = (rows: Array<{ name: string; price: number | string | null | undefined }>): CandidatePrice[] => {
    const out: CandidatePrice[] = []
    for (const row of rows) {
      const raw = Number(row.price)
      if (!Number.isFinite(raw)) continue
      const categories = categorise(row.name ?? '')
      for (const m of multipliers) {
        out.push({
          price: +(raw * m).toFixed(2),
          sourceName: row.name ?? '(unnamed)',
          categories,
        })
      }
    }
    return out
  }

  return {
    material: expand(rawMaterialRows),
    assembly: expand(rawAssemblyRows),
  }
}
