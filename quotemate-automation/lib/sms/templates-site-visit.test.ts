// Spec elec-plumb-site-visit-first R5 — the customer quote SMS for the two
// trades whose only payment is the flat $99 refundable site visit.
//
// The contract, asserted from both sides: the tier PRICES survive (they are
// information, and dropping them would turn a priced quote into a blind
// $99 ask), while every per-tier deposit amount and pay link goes, replaced
// by ONE $99 line. Any other trade — and any caller that doesn't thread a
// trade — keeps today's deposit shape untouched.

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
  pay_links: {
    good: 'https://www.quotemax.com.au/r/abc123/good',
    better: 'https://www.quotemax.com.au/r/abc123/better',
    best: 'https://www.quotemax.com.au/r/abc123/best',
    inspection: 'https://www.quotemax.com.au/r/abc123/inspection',
  },
  deposit_pct: 30,
}

describe.each(['electrical', 'plumbing'])('buildQuoteSms — %s ($99 site visit)', (trade) => {
  const body = buildQuoteSms(intake, baseQuote, { trade, tierMode: 'good_better_best' })

  it('keeps every tier PRICE', () => {
    expect(body).toMatch(/GOOD: \$660/)
    expect(body).toMatch(/BETTER: \$880/)
    expect(body).toMatch(/BEST: \$1,?210/)
  })

  it('drops the per-tier deposit amount', () => {
    expect(body).not.toMatch(/\(deposit \$/)
    expect(body).not.toMatch(/deposit to confirm/)
  })

  it('drops every per-tier pay link', () => {
    expect(body).not.toContain('Tap to pay:')
    expect(body).not.toContain('/r/abc123/good')
    expect(body).not.toContain('/r/abc123/better')
    expect(body).not.toContain('/r/abc123/best')
  })

  it('carries exactly ONE $99 refundable site-visit line, with the inspection link', () => {
    expect(body).toContain(
      'Tap to lock in your site visit ($99 refundable, credited toward your final quote):',
    )
    expect(body).toContain('https://www.quotemax.com.au/r/abc123/inspection')
    expect(body.match(/\$99 refundable/g)).toHaveLength(1)
  })

  it('still links the quote page and keeps the scope line', () => {
    expect(body).toContain('View full quote: https://www.quotemax.com.au/q/abc123')
    expect(body).toContain('SCOPE:')
  })

  it('does not ask them to "confirm a tier"', () => {
    expect(body).not.toContain('confirm a tier')
  })
})

describe('buildQuoteSms — site-visit fallbacks and the price hold', () => {
  it('falls back to the call-us line when no inspection link could be built', () => {
    const body = buildQuoteSms(
      intake,
      { ...baseQuote, pay_links: { good: 'g', better: 'b', best: 'x' } },
      { trade: 'electrical' },
    )
    expect(body).toContain(
      'Call us back to lock in a site visit ($99 refundable, credited toward your final quote).',
    )
    expect(body).not.toContain('Tap to pay:')
  })

  it('suppresses the "lock in a tier" price-hold line (the $99 has no hold)', () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const body = buildQuoteSms(
      intake,
      { ...baseQuote, price_hold_until: future },
      { trade: 'plumbing' },
    )
    expect(body).not.toContain('lock in a tier to secure it')
    expect(body).not.toContain('Price held until')
  })
})

describe('buildQuoteUpdatedSms — the revised-quote message follows the same rule', () => {
  it('keeps prices, drops deposits + tier links, adds the $99 line', () => {
    const body = buildQuoteUpdatedSms(intake, baseQuote, {
      trade: 'electrical',
      tierMode: 'good_better_best',
    })
    expect(body).toMatch(/BETTER: \$880/)
    expect(body).not.toMatch(/\(deposit \$/)
    expect(body).not.toContain('Tap to pay:')
    expect(body).toContain('$99 refundable')
    expect(body).toContain('https://www.quotemax.com.au/r/abc123/inspection')
  })
})

describe('every other trade keeps the deposit shape (the allowlist fails open)', () => {
  for (const trade of ['solar', 'commercial_painting', 'roofing', undefined, null]) {
    it(`trade ${JSON.stringify(trade)} still prints deposits + per-tier pay links`, () => {
      const body = buildQuoteSms(intake, baseQuote, { trade, tierMode: 'single' })
      expect(body).toMatch(/BETTER: \$880\.00 \(deposit \$264\.00\)/)
      expect(body).toContain('Tap to pay: https://www.quotemax.com.au/r/abc123/better')
      expect(body).not.toContain('$99 refundable')
      expect(body).toContain('confirm a tier')
    })
  }
})

describe('genuinely inspection-routed rows are untouched by the trade gate', () => {
  it('an electrical needs_inspection quote keeps buildInspectionQuoteSms verbatim', () => {
    const withTrade = buildQuoteSms(
      intake,
      { ...baseQuote, needs_inspection: true, inspection_reason: 'Switchboard age unknown.' },
      { trade: 'electrical' },
    )
    const withoutTrade = buildQuoteSms(intake, {
      ...baseQuote,
      needs_inspection: true,
      inspection_reason: 'Switchboard age unknown.',
    })
    expect(withTrade).toBe(withoutTrade)
    // No fabricated tier prices on an inspection-routed row, exactly as before.
    expect(withTrade).not.toMatch(/BETTER: \$880/)
  })
})
