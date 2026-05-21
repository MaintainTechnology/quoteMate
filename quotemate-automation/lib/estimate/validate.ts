// Database-grounding validator — runs after Opus emits a draft quote and
// before the quote is persisted. Walks every line_item and verifies that
// its unit_price_ex_gst is traceable to a real DB row × pricing_book
// derivation AND that the line description and the source row are in
// the same product category (downlights, GPOs, smoke alarms, etc).
//
// If any line item fails, the route handler downgrades the entire quote
// to inspection-required: tiers wiped to null, $99 site-visit fee becomes
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

// Grounding categories are the SINGLE SOURCE OF TRUTH in ./categories
// (also consumed by the custom-service Zod schema + the dashboard form).
// Re-exported so existing `import { type Category } from './validate'`
// callers keep working unchanged.
import { isCategory, type Category } from './categories'
export type { Category } from './categories'

export type PricingBookForValidation = {
  hourly_rate: number | string
  apprentice_rate: number | string
  /** Optional senior tradie rate — when set, the validator accepts it as
   *  a valid labour price alongside hourly_rate + apprentice_rate. Without
   *  this, Opus-picked senior-tier labour silently fails grounding. */
  senior_rate?: number | string | null
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

// `Category` is imported + re-exported from ./categories above — that
// array is the single source of truth (validator + Zod schema + form).
// To add a category, add ONE line there; categorise() below then needs a
// matching keyword regex (and a collision-guard test) for the LINE side.

/** Extract category tags from arbitrary product-name or line-description text. */
export function categorise(text: string): Set<Category> {
  const t = (text ?? '').toLowerCase()
  const cats = new Set<Category>()

  // ── Electrical ──────────────────────────────────────────────────
  // Outdoor first — "outdoor IP-rated LED light" must beat the bare-LED rule.
  // Floodlights / security-sensor lights are unambiguously outdoor — fold
  // them into outdoor_light so "Install motion sensor flood light" (mig
  // 021) and the line Opus writes for it share a tag.
  if (/\b(outdoor|exterior|deck|weatherproof|ip[-\s]?rated|garden|patio|wall\s*pack|flood\s*light|floodlight)\b/.test(t)) {
    cats.add('outdoor_light')
  }
  if (/\bdownlight/.test(t)) cats.add('downlight')
  if (/\b(gpo|power\s*point|socket|wall\s*outlet|\busb\s*out)/.test(t)) cats.add('gpo')
  // smoke_alarm: "smoke alarm" / "interconnected alarm" / "240V alarm" /
  // "hardwire ... alarm" / "alarm install" / "alarm replacement" — broader
  // pattern so Opus's "Install kit ... terminate each alarm" line lands in
  // the smoke_alarm bucket (caught in 2026-05-15 E4 stress test where the
  // line was mis-categorised as [general] and the matching $40.80 row
  // existed only in [smoke_alarm], causing all 3 tiers to fail grounding).
  if (/\bsmoke\s*alarm|\binterconnect(?:ed)?\s+alarm|\b240v\s*alarm|\bhardwire[ds]?\b.*\balarm|\balarm\s+(?:install|replace|terminate|hardwire|kit)/.test(t)) cats.add('smoke_alarm')
  if (/\b(ceiling\s*fan|\bfan\b)/.test(t)) cats.add('fan')
  if (/\b(rcbo|safety\s*switch|safety\s*breaker|circuit\s*breaker)\b/.test(t)) cats.add('rcbo')
  if (/\b(oven|cooktop|stove|range\s*hood)\b/.test(t)) cats.add('oven_cooktop')
  if (/\b(ev\s*charger|electric\s*vehicle|wallbox)\b/.test(t)) cats.add('ev_charger')
  if (/\b(switchboard|switch\s*board|main\s*board|distribution\s*board)\b/.test(t)) {
    cats.add('switchboard')
  }
  // ── Electrical catalogue extras (migration 021) — tight keywords so
  //    they can't false-match an existing category. ─────────────────
  if (/\b(fault[-\s]?find(?:ing)?|diagnostic|diagnose)\b/.test(t)) cats.add('fault_find')
  if (/\b(led\s*strip|strip\s*light(?:ing)?|cove\s*light(?:ing)?)\b/.test(t)) cats.add('strip_light')
  // security/surveillance camera — deliberately NOT bare "cctv" (that is
  // the plumbing drain-camera tag below; keeping them distinct stops an
  // electrical camera price grounding a plumbing CCTV line).
  if (/\b(security\s*camera|surveillance\s*camera|cctv\s*camera)\b/.test(t)) cats.add('security_camera')
  if (/\b(doorbell|door\s*bell|intercom)\b/.test(t)) cats.add('doorbell_intercom')

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
  // ── Plumbing catalogue extras (migration 021) — tight keywords. ──
  if (/\bdish\s*washer\b/.test(t)) cats.add('dishwasher')
  if (/\b(rain\s*water\s*tank|rainwater\s*tank)\b/.test(t)) cats.add('rainwater_tank')
  if (/\b(water\s*filter|filtration|whole[-\s]?house\s*(?:water\s*)?filter)\b/.test(t)) {
    cats.add('water_filter')
  }
  // leak DETECTION only — "gas leak" stays in the gas tag above, never here.
  if (/\bleak\s*detect(?:ion|or)?\b/.test(t)) cats.add('leak_detection')
  if (/\b(shower\s*head|showerhead|shower\s*rose)\b/.test(t)) cats.add('shower')

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
  const senior =
    pricingBook.senior_rate != null && pricingBook.senior_rate !== ''
      ? n(pricingBook.senior_rate)
      : null
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
        // Labour rates: hourly_rate, apprentice_rate, OR senior_rate when
        // configured. No semantic category check — labour lines are
        // intrinsically generic. Adding senior_rate fixes the case where
        // Opus picks the senior tier for the "Best" option and the
        // entire quote was being downgraded for what is the right call.
        valid =
          within(price, hourly) ||
          within(price, apprentice) ||
          (senior !== null && within(price, senior))
        expected = senior !== null
          ? `pricing_book.hourly_rate ($${hourly}), apprentice_rate ($${apprentice}), or senior_rate ($${senior})`
          : `pricing_book.hourly_rate ($${hourly}) or apprentice_rate ($${apprentice})`
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

/** Raw DB row fed into the candidate builder. `category`, when set, is an
 *  EXPLICIT validator category carried on the row itself
 *  (shared_assemblies.category / tenant_custom_assemblies.category,
 *  migration 029). It is ADDED to the name-derived tags, never replaces
 *  them — so the column can only ever make grounding recognise the
 *  CORRECT category for a row whose name the regex misses; it can never
 *  remove a tag and regress a row that already grounds today. */
export type RawCandidateRow = {
  name: string
  price: number | string | null | undefined
  category?: string | null
}


/**
 * Build the candidate-price set used by validateQuoteGrounding.
 * For each raw DB row (name + price), expand into multiple realistic
 * markup variants (10% to 40% in 5% steps, plus the tradie's configured
 * default_markup_pct). Each variant carries the source row's name and
 * extracted category tags so semantic grounding can be enforced.
 */
export function buildCandidatePrices(
  rawMaterialRows: RawCandidateRow[],
  rawAssemblyRows: RawCandidateRow[],
  pricingBook: PricingBookForValidation,
): CandidatePrices {
  // MARKUP POLICY (relaxed 2026-05-13):
  // Accept the tradie's configured default_markup_pct PLUS a ±5pp band
  // PLUS 0% raw (used when Opus quotes a base material as a customer-
  // supply line or when the assembly already bakes the markup in).
  //
  // History: an earlier version allowed [0, 10, 15, 20, 25, 28, 30, 35, 40]%
  // — too much slack. Then it was tightened to exactly [0, default] which
  // killed clean plumbing quotes when Opus rounded its way to 20% on a
  // 15%-configured book (Wall-faced toilet at $580: 15% = $667 vs 20% =
  // $696, $29 over the $0.50 PRICE_TOLERANCE → every material line fails
  // → entire quote downgraded to inspection).
  //
  // ±5pp drift is the sweet spot: forgiving enough that Opus rounding /
  // anchor bias on the AU plumbing 20% standard still validates against
  // a 15%-configured book, strict enough that 30%-tradie prices can't
  // sneak through on a 15%-tradie's book (those differ by 15pp).
  const defaultMarkup = n(pricingBook.default_markup_pct)
  const MARKUP_DRIFT_PP = 5
  const standardMarkups = new Set<number>([
    0,
    Math.max(0, defaultMarkup - MARKUP_DRIFT_PP),
    defaultMarkup,
    defaultMarkup + MARKUP_DRIFT_PP,
  ])

  const multipliers = Array.from(standardMarkups).map((pct) => 1 + pct / 100)

  const expand = (rows: RawCandidateRow[]): CandidatePrice[] => {
    const out: CandidatePrice[] = []
    for (const row of rows) {
      const raw = Number(row.price)
      if (!Number.isFinite(raw) || raw <= 0) continue
      const categories = categorise(row.name ?? '')
      // Migration 029: fold in the row's EXPLICIT category (additive —
      // never drops a name-derived tag, so a row that grounds today keeps
      // grounding; this only ADDS the correct tag for names the regex
      // misses, e.g. "Install whole-house water filter").
      if (isCategory(row.category)) categories.add(row.category)
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
