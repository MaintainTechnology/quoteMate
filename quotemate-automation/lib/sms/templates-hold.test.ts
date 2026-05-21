// WP6 — SMS price-hold line coverage (runs under `npm test`, which
// resolves the @/ alias unlike the bare-node parity script).
//
// Also locks in the no-regression invariant: when price_hold_until is
// absent (legacy quotes + the SMS-parity fixture), buildQuoteSms output
// is byte-identical to before — the hold line is purely additive.

import { describe, expect, it } from 'vitest'
import { buildQuoteSms, buildQuoteInFlightSms } from './templates'

const intake = {
  job_type: 'downlights',
  caller: { name: 'Mike Smith' },
  scope: { item_count: 5, description: '5 LED downlights in kitchen' },
}

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
  quote_view_url: 'https://quote-mate-rho.vercel.app/q/abc123',
  pay_links: { good: 'g', better: 'b', best: 'x' },
  deposit_pct: 30,
}

describe('buildQuoteSms — WP6 price-hold line', () => {
  it('omits the hold line entirely when price_hold_until is absent (no parity regression)', () => {
    const body = buildQuoteSms(intake, baseQuote)
    expect(body).not.toMatch(/Price held until/)
    expect(body).not.toMatch(/this price expired/)
    expect(body).toMatch(/- QuoteMate$/)
  })

  it('adds a "Price held until" line for a future hold, before the sign-off', () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    const body = buildQuoteSms(intake, { ...baseQuote, price_hold_until: future })
    expect(body).toMatch(/Price held until .+ - lock in a tier to secure it\./)
    expect(body).toMatch(/- QuoteMate$/)
    expect(body.indexOf('Price held until')).toBeLessThan(body.indexOf('- QuoteMate'))
  })

  it('adds an expiry warning when the hold has passed', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const body = buildQuoteSms(intake, { ...baseQuote, price_hold_until: past })
    expect(body).toMatch(/Heads up: this price expired .+ - reply for a fresh quote\./)
  })

  it('stays GSM-7 safe (ASCII only) with the hold line present', () => {
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    const body = buildQuoteSms(intake, { ...baseQuote, price_hold_until: future })
    expect(/[^\x20-\x7E\n]/.test(body)).toBe(false)
  })

  it('ignores an unparseable price_hold_until (no line, no throw)', () => {
    const body = buildQuoteSms(intake, { ...baseQuote, price_hold_until: 'not-a-date' })
    expect(body).not.toMatch(/Price held until/)
    expect(body).toMatch(/- QuoteMate$/)
  })
})

// Fixture double-count regression (reported 2026-05-21): tierComponents
// must report the number of FIXTURES, not the sum of every unit='each'
// line. A product-options quote carries a separate product line AND a
// per-fixture install-kit line, both unit='each' at the same qty — summing
// them showed "12 fittings" for a 6-downlight job.
describe('buildQuoteSms — fixture count never double-counts', () => {
  const sixDownlights = {
    job_type: 'downlights',
    caller: { name: 'Jon' },
    scope: { item_count: 6, description: '6 warm white downlights' },
  }
  const productQuote = {
    ...baseQuote,
    good: {
      label: 'Black Fireflies',
      subtotal_ex_gst: 996.48,
      line_items: [
        { description: 'Black Fireflies', unit: 'each', quantity: 6, unit_price_ex_gst: 69, total_ex_gst: 414 },
        { description: 'Install kit — cut hole, terminate, fit fixture and test', unit: 'each', quantity: 6, unit_price_ex_gst: 38.08, total_ex_gst: 228.48 },
        { description: 'Electrician labour', unit: 'hr', quantity: 2.4, unit_price_ex_gst: 118, total_ex_gst: 283.2 },
        { description: 'Site visit + setup time', unit: 'hr', quantity: 0.6, unit_price_ex_gst: 118, total_ex_gst: 70.8 },
      ],
    },
    better: null,
    best: null,
    selected_tier: 'good' as const,
  }

  it('reports 6 fittings (item_count), not 12 (product + install-kit lines)', () => {
    const body = buildQuoteSms(sixDownlights, productQuote)
    expect(body).toMatch(/6 fittings/)
    expect(body).not.toMatch(/12 fittings/)
  })

  it('falls back to the MAX each-line qty, never the sum, when item_count is absent', () => {
    const noCount = { job_type: 'downlights', caller: { name: 'Jon' }, scope: { description: '6 downlights' } }
    const body = buildQuoteSms(noCount, productQuote)
    expect(body).toMatch(/6 fittings/)
    expect(body).not.toMatch(/12 fittings/)
  })
})

// 2026-05-19 "bug zapper" fix part 3: the INFLIGHT canned hold-on used to
// promise "your quote's nearly ready (about a minute away)" — a phrase
// dialog.ts strips elsewhere because it's frequently a lie (recovery flow
// leftover intake_ids, add-on flows, etc.). Lock in the no-time-claim and
// no-stalling-phrase invariants so the regression can't quietly come back.
describe('buildQuoteInFlightSms — no false time claims', () => {
  it('never promises a specific time ("nearly ready", "a minute", "under a minute")', () => {
    // Sample many times since the function picks a variant at random.
    for (let i = 0; i < 50; i++) {
      const body = buildQuoteInFlightSms()
      expect(body).not.toMatch(/nearly ready/i)
      expect(body).not.toMatch(/a minute/i)
      expect(body).not.toMatch(/under a minute/i)
      expect(body).not.toMatch(/about a minute/i)
      expect(body).not.toMatch(/seconds? away/i)
      expect(body).not.toMatch(/in a minute/i)
    }
  })

  it('stays GSM-7 safe and inside one SMS segment (<=160 chars)', () => {
    for (let i = 0; i < 50; i++) {
      const body = buildQuoteInFlightSms()
      expect(/[^\x20-\x7E\n]/.test(body)).toBe(false)
      expect(body.length).toBeLessThanOrEqual(160)
    }
  })

  it('still acknowledges the quote is in progress (no silent / empty reply)', () => {
    for (let i = 0; i < 50; i++) {
      const body = buildQuoteInFlightSms()
      expect(body.trim().length).toBeGreaterThan(20)
      // Must signal "we're still working" without claiming completion timing.
      expect(body).toMatch(/quote|working|pulling|works/i)
    }
  })
})
