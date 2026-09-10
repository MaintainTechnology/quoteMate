// The final-quote SMS (spec post-visit-money-sequence R9/R14).
//
// The single most important assertion in this file is the NEGATIVE one: a
// final quote must never carry an `/inspection` link. The child row shares
// its parent's electrical intake, so every trade-only gate in the SMS builder
// would otherwise fire on it and text the customer a second $99 site visit
// for a job that has already been visited — and paying it would claim the
// row's only paid_at slot and permanently block the deposit.

import { describe, it, expect } from 'vitest'
import { buildQuoteSms } from './templates'

const intake = {
  job_type: 'ev_charger',
  caller: { name: 'Dana Whitfield' },
  scope: { item_count: 1 },
}

/** A final row: one confirmed price in `good`, 50% deposit (Jon's EV rate). */
function finalQuote(subtotalExGst: number, depositPct = 50) {
  return {
    good: { label: 'Final quote', subtotal_ex_gst: subtotalExGst },
    better: null,
    best: null,
    selected_tier: 'good' as const,
    deposit_pct: depositPct,
    needs_inspection: false,
    scope_of_works: 'Supply and install a 7kW single-phase EV charger.',
    assumptions: [],
    estimated_timeframe: 'one day',
    gst_registered: true,
    quote_view_url: 'https://app.test/q/tok-final',
    pdf_url: 'https://app.test/q/tok-final/pdf',
    pay_links: { deposit: 'https://app.test/r/tok-final/deposit' },
  }
}

const opts = {
  trade: 'electrical',
  quoteKind: 'final' as const,
  businessName: 'Statewide Electrical',
}

describe('buildQuoteSms — quoteKind: final', () => {
  // $5,000 ex-GST → $5,500 inc GST. 50% = $2,750, less the $99 credit =
  // $2,651 deposit, + 2% fee = $2,704.02. Balance = $2,750.00.
  const body = buildQuoteSms(intake, finalQuote(5000), opts)

  it('never offers a second site visit', () => {
    expect(body).not.toContain('/inspection')
    expect(body).not.toContain('site visit ($99 refundable')
    expect(body.toLowerCase()).not.toContain('lock in your site visit')
  })

  it('leads with the confirmed price, inc GST', () => {
    expect(body).toContain('Your final quote for 1 EV charger from Statewide Electrical')
    expect(body).toContain('$5,500.00 inc GST')
  })

  it('shows the deposit, the $99 credit and the platform fee', () => {
    expect(body).toContain('Accept with a 50% deposit')
    expect(body).toContain('$2,750.00') // gross deposit before the credit
    expect(body).toContain('less your $99 site-visit credit')
    expect(body).toContain('2% platform fee')
    expect(body).toContain('$2,704.02') // what they actually pay, including cents
  })

  it('links the deposit short-link and the balance to come', () => {
    expect(body).toContain('https://app.test/r/tok-final/deposit')
    expect(body).toContain('Balance $2,750.00 is requested on completion')
  })

  it('says tap, never reply — replies land at the external receptionist', () => {
    expect(body.toLowerCase()).toContain('tap to pay')
    expect(body.toLowerCase()).not.toContain('reply yes')
  })

  it('carries the view + PDF links and signs off as the tradie', () => {
    expect(body).toContain('View quote: https://app.test/q/tok-final')
    expect(body).toContain('PDF copy: https://app.test/q/tok-final/pdf')
    expect(body.trimEnd().endsWith('- Statewide Electrical')).toBe(true)
  })

  it('is GSM-7 safe — no smart quotes, dashes or emoji', () => {
    expect(body).toMatch(/^[\x20-\x7E\n]*$/)
  })
})

describe('buildQuoteSms — the R8 zero-deposit variant', () => {
  // A $150 inc-GST job at 50% = $75 deposit, which the $99 already covers.
  const body = buildQuoteSms(intake, finalQuote(136.36), opts)

  it('says the site visit covers it instead of asking for $0', () => {
    expect(body).toContain('site visit covers the deposit')
    expect(body).toContain('nothing to pay now')
    expect(body).not.toContain('Accept with a 50% deposit')
  })

  it('offers no deposit link when there is nothing to charge', () => {
    expect(body).not.toContain('/r/tok-final/deposit')
  })

  it('still names the balance owed on completion', () => {
    expect(body).toContain('Balance $51.00 on completion')
  })
})

describe('buildQuoteSms — initial rows are untouched', () => {
  it('still sends electrical customers the $99 site-visit line', () => {
    const body = buildQuoteSms(
      intake,
      {
        ...finalQuote(5000, 30),
        pay_links: { inspection: 'https://app.test/r/tok-init/inspection' },
      },
      { trade: 'electrical' },
    )
    expect(body).toContain('/r/tok-init/inspection')
    expect(body).toContain('$99 refundable')
    expect(body).not.toContain('site-visit credit +')
  })
})
