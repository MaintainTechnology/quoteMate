// SMS painting receptionist — pure reply composer tests.

import { describe, expect, it } from 'vitest'
import {
  buildPaintingFormOffer,
  buildPaintingFormThankYou,
  buildPaintingHoldingSms,
  buildPaintingInspectionSms,
  buildPaintingQuoteSms,
  buildPaintingTradieNotification,
  composePaintingBooking,
  composePaintingCancel,
  fmtAud,
} from './painting-compose'
import type { PaintingEstimate, PaintingPriceTier } from '@/lib/painting/types'

function tier(tier: 'good' | 'better' | 'best', inc: number): PaintingPriceTier {
  return { tier, label: tier, ex_gst: inc / 1.1, inc_gst: inc, inc_gst_low: inc * 0.9, inc_gst_high: inc * 1.1, scope: '' }
}

function estimate(): PaintingEstimate {
  return {
    provider: 'mock',
    facts: {} as PaintingEstimate['facts'],
    measurement: {} as PaintingEstimate['measurement'],
    price: {
      confidence: 'medium',
      total_area_m2: 120,
      tiers: [tier('good', 3000), tier('better', 5000), tier('best', 7000)],
      loadings_applied: [],
      routing: { decision: 'tradie_review', reason: 'sign-off' },
    },
    warnings: [],
  } as unknown as PaintingEstimate
}

describe('buildPaintingFormOffer', () => {
  it('offers the form link first, with the reply-here fallback', () => {
    const msg = buildPaintingFormOffer({ firstName: 'Sam', formUrl: 'https://x.test/paint-request/abc123' })
    expect(msg).toContain('https://x.test/paint-request/abc123')
    expect(msg).toMatch(/reply here/i)
    expect(msg).toMatch(/Hi Sam/)
    expect(msg).toMatch(/painter to review before sending/)
    expect(msg).not.toMatch(/straight back|straight over|on.*way/)
  })
})

describe('buildPaintingQuoteSms', () => {
  it("defaults to the single recommended tier and lists it inc-GST with the quote link", () => {
    const msg = buildPaintingQuoteSms({ estimate: estimate(), address: '5 Smith St', quoteUrl: 'https://x.test/q/paint/tok' })
    expect(msg).toContain('$5,000') // Better / Standard tier
    expect(msg).not.toContain('$3,000')
    expect(msg).not.toContain('$7,000')
    expect(msg).toContain('https://x.test/q/paint/tok')
    expect(msg).toMatch(/~120 m²/)
    expect(msg).toMatch(/inc GST/i)
  })
  it('omits the pay link when token/appUrl are absent', () => {
    const msg = buildPaintingQuoteSms({ estimate: estimate(), address: '5 Smith St', quoteUrl: 'https://x.test/q/paint/tok' })
    expect(msg).not.toContain('/r/paint/')
  })
  it('lists all three tiers + the PDF link under good_better_best mode', () => {
    const msg = buildPaintingQuoteSms({
      estimate: estimate(),
      address: '5 Smith St',
      quoteUrl: 'https://x.test/q/paint/tok',
      pdfUrl: 'https://x.test/api/q/paint/tok/pdf',
      tierMode: 'good_better_best',
      token: 'tok',
      appUrl: 'https://x.test',
    })
    expect(msg).toContain('$3,000')
    expect(msg).toContain('$5,000')
    expect(msg).toContain('$7,000')
    expect(msg).toContain('https://x.test/api/q/paint/tok/pdf')
  })
  it('offers ONLY the $99 site visit — never a per-tier deposit link (spec painting-site-visit-first R4)', () => {
    const msg = buildPaintingQuoteSms({
      estimate: estimate(),
      address: '5 Smith St',
      quoteUrl: 'https://x.test/q/paint/tok',
      tierMode: 'good_better_best',
      token: 'tok',
      appUrl: 'https://x.test',
    })
    expect(msg).toContain('https://x.test/r/paint/tok/inspection')
    expect(msg).toContain('$99 refundable')
    expect(msg).not.toContain('/r/paint/tok/good')
    expect(msg).not.toContain('/r/paint/tok/better')
    expect(msg).not.toContain('/r/paint/tok/best')
    expect(msg).not.toMatch(/deposit/i)
  })
})

describe('buildPaintingInspectionSms', () => {
  it('states the reason and asks to book, no firm price', () => {
    const msg = buildPaintingInspectionSms({ firstName: 'Sam', address: '5 Smith St', reason: 'Surfaces are flaking.' })
    expect(msg).toContain('Surfaces are flaking.')
    expect(msg).toMatch(/Reply YES/i)
    expect(msg).not.toContain('$')
  })
})

describe('booking / cancel / thank-you', () => {
  it('confirms or defers the booking', () => {
    expect(composePaintingBooking('Sam', true)).toMatch(/in touch/i)
    expect(composePaintingBooking('Sam', false)).toMatch(/whenever you're ready/i)
  })
  it('closes politely on cancel', () => {
    expect(composePaintingCancel('Sam')).toMatch(/stopped there/i)
  })
  it('thank-you says the quote is on its way', () => {
    expect(buildPaintingFormThankYou({ firstName: 'Sam' })).toMatch(/needs to review the draft/i)
  })
})

describe('buildPaintingHoldingSms', () => {
  it('sets expectation without leaking a price', () => {
    const msg = buildPaintingHoldingSms({ firstName: 'Sam', businessName: 'Acme Painting' })
    expect(msg).toMatch(/Hi Sam/)
    expect(msg).toContain('Acme Painting')
    expect(msg).toMatch(/draft is saved.*awaiting review/i)
    expect(msg).not.toContain('$')
  })
  it('falls back to "your painter" with no business name', () => {
    expect(buildPaintingHoldingSms({})).toMatch(/awaiting review by your painter/i)
  })
})

describe('buildPaintingTradieNotification', () => {
  it('links the tradie to the review page with the estimate price', () => {
    const msg = buildPaintingTradieNotification({
      tradieFirstName: 'Jo',
      customerName: 'Sam',
      address: '5 Smith St',
      betterIncGst: 5000,
      reviewUrl: 'https://x.test/p/etok',
    })
    expect(msg).toContain('https://x.test/p/etok')
    expect(msg).toContain('5 Smith St')
    expect(msg).toContain('$5,000')
    expect(msg).toMatch(/review/i)
  })
})

describe('fmtAud', () => {
  it('renders whole-dollar AUD with no cents', () => {
    expect(fmtAud(5000)).toBe('$5,000')
    expect(fmtAud(1234.56)).toBe('$1,235')
  })
})
