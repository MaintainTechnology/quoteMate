// Mig 142 — per-feature tier presentation mode in the customer quote SMS.
// Proves buildQuoteSms / buildQuoteUpdatedSms list only the tier(s) the
// resolved mode surfaces, and that omitting the mode preserves the legacy
// all-tiers behaviour (back-compat for callers / the parity fixture).

import { describe, expect, it } from 'vitest'
import { buildQuoteSms, buildQuoteUpdatedSms } from './templates'

const intake = {
  job_type: 'downlights',
  caller: { name: 'Mike Smith' },
  scope: { item_count: 5, description: '5 LED downlights in kitchen' },
}

// good $600→$660, better $800→$880, best $1100→$1210 (incGst = round(ex*1.1)).
const baseQuote = {
  good: { label: 'Standard LED', subtotal_ex_gst: 600, line_items: [] },
  better: { label: 'Tri-colour LED', subtotal_ex_gst: 800, line_items: [] },
  best: { label: 'Smart dimmable LED', subtotal_ex_gst: 1100, line_items: [] },
  selected_tier: 'better' as const,
  scope_of_works: 'Replace 5 existing halogen downlights with new LED fittings in kitchen.',
  scope_short: '5 LED downlights in kitchen',
  assumptions: [],
  estimated_timeframe: 'Half day',
  needs_inspection: false,
  inspection_reason: null,
  quote_view_url: 'https://www.quotemax.com.au/q/abc123',
  pay_links: { good: 'g', better: 'b', best: 'x' },
  deposit_pct: 30,
}

describe('buildQuoteSms — tier mode (mig 142/146)', () => {
  it('omitting tierMode now defaults to single price (mig 146 platform default)', () => {
    const body = buildQuoteSms(intake, baseQuote)
    // The internal fallback flipped from 'good_better_best' to 'single',
    // matching the PDF + quote page: one option = the recommended tier, no
    // Good/Better/Best list for a caller that doesn't thread a mode.
    expect(body).toMatch(/YOUR OPTION/)
    expect(body).not.toMatch(/\bOPTIONS\b/)
    expect(body).toMatch(/BETTER: \$880/)
    expect(body).not.toMatch(/GOOD:/)
    expect(body).not.toMatch(/BEST:/)
    expect(body).not.toMatch(/\(recommended\)/)
  })

  it("single mode shows ONE price (the recommended tier) under 'YOUR OPTION'", () => {
    const body = buildQuoteSms(intake, baseQuote, { tierMode: 'single' })
    expect(body).toMatch(/YOUR OPTION/)
    expect(body).not.toMatch(/\bOPTIONS\b/) // not "2 OPTIONS" / "3 OPTIONS"
    expect(body).toMatch(/BETTER: \$880/)
    expect(body).not.toMatch(/GOOD:/)
    expect(body).not.toMatch(/BEST:/)
    // No "(recommended)" badge when it's the only option shown.
    expect(body).not.toMatch(/\(recommended\)/)
  })

  it("forced 'good' mode shows only the Good option", () => {
    const body = buildQuoteSms(intake, baseQuote, { tierMode: 'good' })
    expect(body).toMatch(/YOUR OPTION/)
    expect(body).toMatch(/GOOD: \$660/)
    expect(body).not.toMatch(/BETTER:/)
    expect(body).not.toMatch(/BEST:/)
  })

  it("explicit 'good_better_best' shows all three with the 3 OPTIONS header + recommended badge", () => {
    const body = buildQuoteSms(intake, baseQuote, { tierMode: 'good_better_best' })
    expect(body).toMatch(/3 OPTIONS/)
    expect(body).toMatch(/GOOD: \$660/)
    expect(body).toMatch(/BETTER: \$880/)
    expect(body).toMatch(/BEST: \$1,?210/)
    // recommended tier still flagged when more than one option shows.
    expect(body).toMatch(/BETTER: \$880\.00 \(recommended\)/)
  })
})

describe('buildQuoteUpdatedSms — tier mode (mig 142)', () => {
  it('single mode lists one tier in the revised-quote SMS too', () => {
    const body = buildQuoteUpdatedSms(intake, baseQuote, { tierMode: 'single' })
    expect(body).toMatch(/YOUR OPTION/)
    expect(body).toMatch(/BETTER: \$880/)
    expect(body).not.toMatch(/GOOD:/)
    expect(body).not.toMatch(/BEST:/)
  })
})
