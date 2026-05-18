// WP6 reorder regression coverage — book first, pay LAST.
//
// Locks the funnel order so a future change can't silently put payment
// back before booking, and so the $199 inspection fee stays pay-first.

import { describe, expect, it } from 'vitest'
import { BOOKING_STATE } from './hold'
import {
  bookingStateOnPaid,
  payRedirectTarget,
  resolveGoogleBookingUrl,
  shouldFinaliseBookingOnPaid,
} from './booking'

describe('payRedirectTarget — the flip', () => {
  it('not paid + no slot → book first (the whole point)', () => {
    expect(
      payRedirectTarget({ paid: false, scheduledAt: null, tier: 'better' }),
    ).toBe('book')
    expect(
      payRedirectTarget({ paid: false, scheduledAt: undefined, tier: 'good' }),
    ).toBe('book')
  })

  it('not paid + slot already chosen → Stripe (deposit is the last step)', () => {
    expect(
      payRedirectTarget({
        paid: false,
        scheduledAt: '2026-05-20T03:00:00.000Z',
        tier: 'best',
      }),
    ).toBe('stripe')
  })

  it('already paid → thank-you/confirmed page (never re-charge)', () => {
    expect(
      payRedirectTarget({ paid: true, scheduledAt: null, tier: 'better' }),
    ).toBe('paid')
    expect(
      payRedirectTarget({
        paid: true,
        scheduledAt: '2026-05-20T03:00:00.000Z',
        tier: 'good',
      }),
    ).toBe('paid')
  })

  it('inspection $199 stays pay-first regardless of slot/paid state', () => {
    expect(
      payRedirectTarget({ paid: false, scheduledAt: null, tier: 'inspection' }),
    ).toBe('stripe')
    expect(
      payRedirectTarget({
        paid: false,
        scheduledAt: '2026-05-20T03:00:00.000Z',
        tier: 'inspection',
      }),
    ).toBe('stripe')
  })
})

describe('bookingStateOnPaid', () => {
  it('slot chosen before paying → booked (confirmed)', () => {
    expect(bookingStateOnPaid('2026-05-20T03:00:00.000Z')).toBe(
      BOOKING_STATE.BOOKED,
    )
  })
  it('paid with no slot (legacy/no slots) → reserved (prompt to book)', () => {
    expect(bookingStateOnPaid(null)).toBe(BOOKING_STATE.RESERVED)
    expect(bookingStateOnPaid(undefined)).toBe(BOOKING_STATE.RESERVED)
  })
})

describe('shouldFinaliseBookingOnPaid', () => {
  it('finalises only when a slot was chosen pre-payment', () => {
    expect(shouldFinaliseBookingOnPaid('2026-05-20T03:00:00.000Z')).toBe(true)
    expect(shouldFinaliseBookingOnPaid(null)).toBe(false)
    expect(shouldFinaliseBookingOnPaid(undefined)).toBe(false)
  })
})

describe('resolveGoogleBookingUrl — off-platform link safety', () => {
  it('accepts a real https Google Appointment link', () => {
    expect(
      resolveGoogleBookingUrl('https://calendar.app.google/ispmShod4UYbCJ7r8'),
    ).toBe('https://calendar.app.google/ispmShod4UYbCJ7r8')
  })

  it('trims surrounding whitespace', () => {
    expect(
      resolveGoogleBookingUrl('  https://calendar.app.google/abc  '),
    ).toBe('https://calendar.app.google/abc')
  })

  it('returns null when unset / blank (option just does not render)', () => {
    expect(resolveGoogleBookingUrl(null)).toBeNull()
    expect(resolveGoogleBookingUrl(undefined)).toBeNull()
    expect(resolveGoogleBookingUrl('')).toBeNull()
    expect(resolveGoogleBookingUrl('   ')).toBeNull()
  })

  it('rejects non-https / non-URL values (never renders an unsafe link)', () => {
    expect(resolveGoogleBookingUrl('http://calendar.app.google/x')).toBeNull()
    expect(resolveGoogleBookingUrl('calendar.app.google/x')).toBeNull()
    expect(resolveGoogleBookingUrl('javascript:alert(1)')).toBeNull()
    expect(resolveGoogleBookingUrl('not a url')).toBeNull()
  })
})
