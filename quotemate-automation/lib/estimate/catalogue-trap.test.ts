// WP2 "trap" integration coverage — proves the lockstep is correct using
// the REAL validator (buildCandidatePrices + validateQuoteGrounding) and
// the REAL catalogue feed (catalogueCandidateRows). i.e. once
// lookupMaterial returns tenant catalogue rows, a branded tenant-priced
// line GROUNDS — and would be dumped to inspection WITHOUT the feed.

import { describe, expect, it } from 'vitest'
import { catalogueCandidateRows, type TenantMaterial } from './catalogue'
import { buildCandidatePrices, validateQuoteGrounding } from './validate'

const pricingBook = {
  hourly_rate: 110,
  apprentice_rate: 60,
  call_out_minimum: 150,
  default_markup_pct: 28,
  min_labour_hours: 2,
}

// Tenant catalogue: Clipsal Iconic GPO @ $40 ex-GST (we-supply),
// $20 ex-GST install-only when the customer supplies it.
const tenantRows: TenantMaterial[] = [
  {
    category: 'gpo',
    name: 'Clipsal Iconic GPO',
    brand: 'Clipsal',
    range_series: 'Iconic',
    unit_price_ex_gst: 40,
    customer_supply_price_ex_gst: 20,
    active: true,
  },
]

// A draft whose GOOD tier prices the branded GPO at the tradie's 28%
// markup ($40 → $51.20) plus a compliant 2 hr labour line.
function draftAt(unitPrice: number) {
  return {
    needs_inspection: false,
    good: {
      label: 'Standard',
      subtotal_ex_gst: unitPrice + 220,
      line_items: [
        { description: 'Clipsal Iconic GPO', unit: 'each', quantity: 1, unit_price_ex_gst: unitPrice, total_ex_gst: unitPrice },
        { description: 'Labour', unit: 'hr', quantity: 2, unit_price_ex_gst: 110, total_ex_gst: 220 },
      ],
    },
    better: null,
    best: null,
  }
}

describe('WP2 trap — branded tenant-priced line grounds with the catalogue feed', () => {
  it('GROUNDS when tenant catalogue rows are fed into the candidate set', () => {
    const candidates = buildCandidatePrices(
      [...catalogueCandidateRows(tenantRows)], // the trap-fix feed
      [],
      pricingBook,
    )
    const res = validateQuoteGrounding(draftAt(51.2), pricingBook, candidates)
    expect(res.valid).toBe(true)
  })

  it('would be DUMPED TO INSPECTION without the feed (proves the trap is real)', () => {
    const candidatesNoFeed = buildCandidatePrices([], [], pricingBook)
    const res = validateQuoteGrounding(draftAt(51.2), pricingBook, candidatesNoFeed)
    expect(res.valid).toBe(false)
  })

  it('customer-supply price variant ($20 raw) also grounds', () => {
    const candidates = buildCandidatePrices(
      [...catalogueCandidateRows(tenantRows)],
      [],
      pricingBook,
    )
    // 0% markup variant exists in buildCandidatePrices, so the raw
    // install-only price grounds for a customer-supplied line.
    const res = validateQuoteGrounding(draftAt(20), pricingBook, candidates)
    expect(res.valid).toBe(true)
  })
})
