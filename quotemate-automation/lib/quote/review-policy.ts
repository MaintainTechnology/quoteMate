// Tradie review-before-send policy — pure module (unit-tested in
// review-policy.test.ts). Decides whether a freshly drafted quote
// should auto-send to the customer or wait for the tradie's approval.
//
// Three policies (mig 078 enum):
//   • auto_send              — quote goes straight to the customer
//                              (today's default behaviour, set at
//                              migration time on every existing row)
//   • always_review          — every quote waits for tradie approval
//                              regardless of value
//   • review_over_threshold  — quotes whose total_inc_gst >= the
//                              configured threshold wait; smaller
//                              quotes auto-send
//
// Pure: no DB, no Stripe, no Next runtime — safe to import from
// server components, API routes, SMS templates, and tests alike.
// Mirrors the lib/quote/display.ts shape so callers know the pattern.

export type ReviewPolicy = 'auto_send' | 'always_review' | 'review_over_threshold';

export const REVIEW_POLICIES: readonly ReviewPolicy[] = [
  'auto_send',
  'always_review',
  'review_over_threshold',
] as const;

/**
 * Type guard / sanitiser for unknown inputs (DB rows pre-migration,
 * form values, API payloads). Returns `fallback` (default 'auto_send')
 * when the value isn't one of the valid policies.
 */
export function asReviewPolicy(
  v: unknown,
  fallback: ReviewPolicy = 'auto_send',
): ReviewPolicy {
  if (v === 'auto_send' || v === 'always_review' || v === 'review_over_threshold') {
    return v;
  }
  return fallback;
}

export interface ShouldHoldInput {
  /** Tenant's configured policy from pricing_book.review_policy. */
  policy?: string | null;
  /** Tenant's configured dollar threshold (inc-GST) from
   *  pricing_book.review_threshold_inc_gst. Only meaningful when
   *  policy === 'review_over_threshold'. */
  threshold?: number | string | null;
  /** The quote's headline total in inc-GST dollars. */
  totalIncGst?: number | string | null;
  /**
   * The quote was already routed to the $99 inspection path (validator
   * downgrade, gas HWS, missing tenant_id, etc.). Inspection quotes
   * are by definition "we need eyes on" — the tradie reviewing the
   * inspection-booking SMS adds friction without any pricing
   * decision to weigh in on. Treat as auto-send so the customer
   * isn't ghosted on a routine inspection booking.
   */
  isInspection?: boolean;
}

/**
 * Decide whether to hold a freshly drafted quote for the tradie's
 * approval before sending the customer SMS.
 *
 * Returns:
 *   { hold: false, reason: ... }  → send the customer SMS now
 *                                   (today's behaviour preserved)
 *   { hold: true, reason: ... }   → set status='awaiting_tradie_approval',
 *                                   notify the tradie, do NOT send the
 *                                   customer SMS until approval lands
 *
 * Pure: input → decision. No I/O. Safe to call from estimator dispatch,
 * tests, or audit scripts.
 */
export function shouldHoldForReview(
  input: ShouldHoldInput,
): { hold: boolean; reason: string } {
  const policy = asReviewPolicy(input.policy);

  // Inspection quotes bypass the gate — see ShouldHoldInput docs.
  if (input.isInspection === true) {
    return { hold: false, reason: 'inspection_route_bypasses_gate' };
  }

  if (policy === 'auto_send') {
    return { hold: false, reason: 'tenant_policy_auto_send' };
  }
  if (policy === 'always_review') {
    // No bypass. The radio button says "every quote waits for your
    // approval" — that promise is inviolable. A customer tapping a
    // product in the WP9 mid-chat picker selects a variant; it is
    // NOT a price commitment (the customer hasn't seen the final
    // number yet). Letting that signal silently flip off the tradie's
    // explicit guardrail was the original behaviour and was wrong.
    // Tradies who want a value-based gate use review_over_threshold.
    return { hold: true, reason: 'tenant_policy_always_review' };
  }
  // review_over_threshold — pure dollar comparison.
  const total = toFiniteNumber(input.totalIncGst);
  const threshold = toFiniteNumber(input.threshold);
  if (total === null) {
    // Unparseable total → hold defensively. Tradies would rather review
    // a quote with a weird total than send a wrong number to a customer.
    return { hold: true, reason: 'unparseable_total_defensive_hold' };
  }
  if (threshold === null || threshold <= 0) {
    // Misconfigured threshold (zero or unparseable). The dashboard form
    // will not allow this for review_over_threshold, but legacy rows
    // pre-migration may carry 0. Treat as auto-send so nothing breaks.
    return { hold: false, reason: 'threshold_misconfigured_default_send' };
  }
  if (total >= threshold) {
    return { hold: true, reason: `total_${total}_at_or_over_threshold_${threshold}` };
  }
  return { hold: false, reason: `total_${total}_under_threshold_${threshold}` };
}

function toFiniteNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}
