// Minimum-charge floor (the "small job allowance").
//
// THE BUG THIS FIXES: pricing_book.min_labour_hours is a real business
// rule — a tradie won't roll a truck for 0.3 h. The grounding validator
// HARD-FAILS any priced tier whose labour totals below that floor, which
// downgrades an otherwise perfectly DB-priced small job (e.g. "replace
// one GPO") to a $99 inspection. That is the single biggest "it has a
// price but still wants an on-site visit" cause.
//
// THE FIX (deterministic, grounded, no fabrication, never undercharges):
// before validation, top each priced tier's labour UP TO the configured
// floor at the tradie's own hourly_rate. This applies the minimum charge
// the tradie already configured, instead of bouncing the job. It only
// ever ADDS legitimate labour at a validator-accepted rate — it cannot
// invent a material price or quote below the minimum.
//
// Safe fallbacks: if hourly_rate isn't a finite number we DO NOT touch
// the quote (no rate we can safely charge → behaviour unchanged, the
// validator will still inspection-route — no regression, no guess).
//
// Pure + unit-tested (min-labour.test.ts).

function n(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return parseFloat(v)
  return NaN
}
function money(x: number): number {
  return +x.toFixed(2)
}

type LineItem = {
  description?: string
  quantity?: number | string
  unit?: string
  unit_price_ex_gst?: number | string
  total_ex_gst?: number | string
  source?: string
}
type Tier = {
  label?: string
  subtotal_ex_gst?: number | string
  line_items?: LineItem[]
} | null

const TIERS = ['good', 'better', 'best'] as const
const LABOUR_EPSILON = 0.05

export interface MinLabourResult {
  draft: any
  /** Tiers whose labour was topped up to the floor (for logging). */
  adjustedTiers: string[]
}

/**
 * Top each priced tier's labour up to pricingBook.min_labour_hours at
 * pricingBook.hourly_rate. Returns the (possibly mutated) draft and the
 * list of tiers adjusted. Inspection-required / tier-less drafts and
 * already-compliant tiers are returned untouched.
 */
export function applyMinLabourFloor(draft: any, pricingBook: any): MinLabourResult {
  if (!draft || draft.needs_inspection === true) {
    return { draft, adjustedTiers: [] }
  }
  const minLabour = (() => {
    const m = n(pricingBook?.min_labour_hours)
    return Number.isFinite(m) ? m : 2.0
  })()
  const hourly = n(pricingBook?.hourly_rate)
  // No safe rate to charge → do nothing (no fabrication, no regression).
  if (!Number.isFinite(hourly) || hourly <= 0) {
    return { draft, adjustedTiers: [] }
  }

  const adjustedTiers: string[] = []

  for (const key of TIERS) {
    const tier = draft[key] as Tier
    if (!tier || !Array.isArray(tier.line_items) || tier.line_items.length === 0) continue

    const labourHrs = tier.line_items
      .filter((li) => li?.unit === 'hr')
      .reduce((s, li) => s + (Number(n(li?.quantity)) || 0), 0)

    if (labourHrs >= minLabour - LABOUR_EPSILON) continue // already meets the floor

    const deficit = money(minLabour - labourHrs)

    // Prefer to extend an existing hr line priced at the tradie's hourly
    // rate (keeps it grounded exactly as before). Else extend any hr line
    // (still a validator-accepted labour rate). Else add a new hr line at
    // hourly_rate.
    const priceMatch = (li: LineItem) => Math.abs(n(li?.unit_price_ex_gst) - hourly) <= 0.5
    let target = tier.line_items.find((li) => li?.unit === 'hr' && priceMatch(li))
    if (!target) target = tier.line_items.find((li) => li?.unit === 'hr')

    let addedCost: number
    if (target) {
      const newQty = money((Number(n(target.quantity)) || 0) + deficit)
      const unitPrice = n(target.unit_price_ex_gst)
      target.quantity = newQty
      target.total_ex_gst = money(newQty * unitPrice)
      addedCost = money(deficit * unitPrice)
    } else {
      const qty = money(minLabour - labourHrs) // labourHrs is 0 here in practice
      tier.line_items.push({
        description: 'Minimum site & setup labour',
        quantity: qty,
        unit: 'hr',
        unit_price_ex_gst: money(hourly),
        total_ex_gst: money(qty * hourly),
        source: 'labour',
      })
      addedCost = money(qty * hourly)
    }

    // Keep the tier subtotal consistent with the added labour.
    const prevSub = n(tier.subtotal_ex_gst)
    if (Number.isFinite(prevSub)) {
      tier.subtotal_ex_gst = money(prevSub + addedCost)
    } else {
      tier.subtotal_ex_gst = money(
        tier.line_items.reduce((s, li) => s + (Number(n(li?.total_ex_gst)) || 0), 0),
      )
    }

    adjustedTiers.push(key)
  }

  return { draft, adjustedTiers }
}
