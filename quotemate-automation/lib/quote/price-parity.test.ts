// Cross-surface price parity (spec customer-quote-five-sections R9) — the
// regression net for the whole pricing-inconsistency table. One fixture
// quote; the page's money derivation, the customer SMS text, the customer
// PDF html and the Stripe charge maths must all agree on the total, the
// deposit, and the discounted total. Before the shared money module these
// four surfaces disagreed on GST conditionality (P1), discount order
// (P4/P5), and display-vs-charge precision (P8) — any reintroduced fork
// fails here.
//
// The fixture is a ROOFING quote and now says so: spec
// elec-plumb-site-visit-first (2026-08-06) retired the tier deposit from
// electrical + plumbing, so `trade: 'roofing'` is what keeps this a real
// deposit-parity test — and doubles as proof that roofing rows on the shared
// `quotes` builder still print (and charge) a per-tier deposit.

import { describe, expect, it } from 'vitest'
import {
  depositCents,
  displayDeposit,
  displayIncGst,
  dollars,
  totalIncGstCents,
} from './money'
import { buildQuoteSms } from '@/lib/sms/templates'
import { renderQuoteTiersHtml } from './report-html'

const EX = 20000 // ex-GST subtotal (the roofing e2e fixture's Better tier)
const DEPOSIT_PCT = 30

const tier = (label: string, ex: number) => ({
  label,
  subtotal_ex_gst: ex,
  line_items: [
    {
      unit: 'sqm',
      quantity: 200,
      description: `${label} — colorbond re-roof.`,
      unit_price_ex_gst: Number((ex / 200).toFixed(2)),
      total_ex_gst: ex,
    },
  ],
})

const intake = {
  job_type: 'other',
  caller: { name: 'Jon' },
  scope: { item_count: 1 },
}

function quoteFixture(appliedDiscountPct: number) {
  return {
    good: null,
    better: tier('Recommended re-roof', EX),
    best: null,
    selected_tier: 'better' as const,
    scope_of_works: 'Full colorbond re-roof over approximately 200 m2.',
    assumptions: [],
    estimated_timeframe: null,
    deposit_pct: DEPOSIT_PCT,
    pay_links: { better: 'https://example.com/r/tok/better' },
    applied_discount_pct: appliedDiscountPct,
    gst_registered: true,
  }
}

describe.each([
  ['no discount', 0],
  ['10% early-booking discount applied', 10],
])('price parity — %s', (_label, discountPct) => {
  const money = { discountPct, gstRegistered: true }
  const incCents = totalIncGstCents(EX, money)
  const pageTotal = displayIncGst(EX, money) // what /q/[token] renders
  const pageDeposit = displayDeposit(EX, DEPOSIT_PCT, money)! // page + SMS deposit
  const stripeUnitAmount = depositCents(incCents, DEPOSIT_PCT) // what checkout.ts charges

  it('page display is the whole-dollar view of the cents Stripe derives from', () => {
    expect(pageTotal).toBe(dollars(incCents))
    expect(pageDeposit).toBe(dollars(stripeUnitAmount))
  })

  it('the customer SMS prints the same total and deposit (P6)', () => {
    const sms = buildQuoteSms(
      intake,
      quoteFixture(discountPct) as unknown as Parameters<typeof buildQuoteSms>[1],
      { tierMode: 'single', trade: 'roofing' },
    )
    expect(sms).toContain(discountPct ? 'BETTER: $19,800.00' : 'BETTER: $22,000.00')
    expect(sms).toContain(discountPct ? '(deposit $5,940.00)' : '(deposit $6,600.00)')
  })

  it('the customer PDF prints the same headline price (P7)', () => {
    const html = renderQuoteTiersHtml({
      good: null,
      better: tier('Recommended re-roof', EX),
      best: null,
      selectedTier: 'better',
      appliedDiscountPct: discountPct,
      gstRegistered: true,
    })
    expect(html).toContain(`$${pageTotal.toLocaleString('en-AU')}`)
    if (discountPct > 0) expect(html).toContain(`${discountPct}% off applied`)
  })

  it('Stripe charges the deposit % of the SAME inc-GST cents (P5/P8)', () => {
    expect(stripeUnitAmount).toBe(Math.round((incCents * DEPOSIT_PCT) / 100))
    // The advertised deposit and the charged deposit are the same number in
    // whole dollars — no more cents drift between display and charge.
    expect(Math.abs(stripeUnitAmount / 100 - pageDeposit)).toBeLessThan(0.5)
  })
})

describe('price parity — non-GST-registered tradie (P1)', () => {
  it('no surface adds 10% for an unregistered tradie', () => {
    const money = { discountPct: 0, gstRegistered: false }
    expect(displayIncGst(EX, money)).toBe(EX)

    const q = { ...quoteFixture(0), gst_registered: false }
    const sms = buildQuoteSms(intake, q as unknown as Parameters<typeof buildQuoteSms>[1], {
      tierMode: 'single',
      trade: 'roofing',
    })
    expect(sms).toContain('BETTER: $20,000.00')
    expect(sms).toContain('No GST')
    expect(sms).not.toContain('inc 10% GST')

    const html = renderQuoteTiersHtml({
      good: null,
      better: tier('Recommended re-roof', EX),
      best: null,
      selectedTier: 'better',
      appliedDiscountPct: 0,
      gstRegistered: false,
    })
    expect(html).toContain(`$${EX.toLocaleString('en-AU')}`)
  })
})
