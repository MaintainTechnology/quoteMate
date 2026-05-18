// Book-first / pay-last funnel decisions (WP6 reorder).
//
// Old flow: quote → pay deposit → pick a time.  John's call: paying
// before booking is bad UX; the deposit must be the LAST step.
//
// New flow: quote → pick a time (held on the quote) → pay deposit →
// booking confirmed. This is enforced at the pay short-link layer so it
// covers BOTH the on-page tier buttons AND the pay links already sitting
// in 138 customers' SMS threads ("force book-first for all").
//
// Pure + unit-tested (booking.test.ts) so the funnel order can't silently
// regress. No DB / Stripe / Next here.

import { BOOKING_STATE, type BookingState } from './hold'

export type PayRedirectKind =
  /** Already paid — send to the thank-you / confirmed page. */
  | 'paid'
  /** Not paid and no slot chosen yet — must pick a time FIRST. */
  | 'book'
  /** Slot already chosen, not paid — deposit is the final step → Stripe. */
  | 'stripe'

export type PayRedirectInput = {
  paid: boolean
  scheduledAt: string | null | undefined
  /** Stripe metadata tier. The $199 'inspection' deposit is a booking
   *  FEE to even get a site visit — it legitimately stays pay-first and
   *  is therefore never routed through book-first. */
  tier: string
}

/**
 * Where should /r/<token>/<tier> send the customer?
 *
 *  inspection            → 'stripe' (pay-first preserved; out of scope)
 *  already paid          → 'paid'
 *  not paid, no slot      → 'book'   (the flip: choose a time first)
 *  not paid, slot chosen  → 'stripe' (deposit is now the last step)
 */
export function payRedirectTarget(input: PayRedirectInput): PayRedirectKind {
  if (input.tier === 'inspection') return 'stripe'
  if (input.paid) return 'paid'
  if (!input.scheduledAt) return 'book'
  return 'stripe'
}

/**
 * Booking state once the deposit is paid (the last step).
 *  • a slot was chosen before paying → 'booked' (confirmed, terminal)
 *  • paid with no slot (legacy SMS link / no slots published) →
 *    'reserved' — the /paid page then prompts them to pick a time.
 */
export function bookingStateOnPaid(
  scheduledAt: string | null | undefined,
): BookingState {
  return scheduledAt ? BOOKING_STATE.BOOKED : BOOKING_STATE.RESERVED
}

/** True when paying should finalise a confirmed booking (slot already
 *  chosen). Drives the webhook: accepted + booked + prune slot + send
 *  the confirmation SMS. */
export function shouldFinaliseBookingOnPaid(
  scheduledAt: string | null | undefined,
): boolean {
  return !!scheduledAt
}
