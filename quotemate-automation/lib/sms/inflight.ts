// When should an inbound SMS get the canned "just wrapping up your
// quote" hold-on (and skip the AI entirely)?
//
// Bug this fixes: `sms_conversations.status='done'` is OVERLOADED. It is
// set when:
//   • a quote was drafted + the quote SMS is being sent  → genuinely "in
//     flight", a hold-on is correct for ~60s
//   • the AI escalated to a $199 inspection              → NO quote exists
//   • the customer ended the conversation                → NO quote exists
//
// The old rule treated EVERY `done` conversation < 60s old as in-flight,
// so a customer who got an inspection offer and immediately asked another
// question received "just wrapping up that quote now, should be with you
// in a minute" — for a quote that does not exist — and the AI was skipped,
// so it never even evaluated their next message (or any service toggle).
//
// Fix: a `done` conversation only has a real quote SMS in transit when it
// actually produced one, i.e. it has an `intake_id` (set by the
// intake/quote handoff). Inspection escalations and ended conversations
// have no intake_id, so a follow-up message falls through to the normal
// AI path instead of the bogus hold-on.
//
// Pure + unit-tested (inflight.test.ts) so this rule can't silently
// regress again.

/** A `structuring` conversation older than this is stuck/failed — treat
 *  as new rather than holding the customer on a quote that never lands. */
export const STRUCTURING_INFLIGHT_MAX_MS = 5 * 60 * 1000

/** Window after a real quote is drafted during which the quote SMS is
 *  still in transit and a hold-on reply is appropriate. */
export const DONE_INFLIGHT_WINDOW_MS = 60 * 1000

/** Minimal shape needed from the prior sms_conversations row. */
export type InflightPrior = {
  status?: string | null
  /** Set ONLY when a quote/intake handoff actually happened. Null for
   *  inspection escalations and ended conversations. */
  intake_id?: string | null
} | null | undefined

/**
 * True when the next inbound should get the canned hold-on and skip the
 * AI because a quote really is being produced right now.
 *
 *  • status 'structuring' (and < 5 min old) → a quote is mid-draft.
 *  • status 'done' WITH an intake_id (and < 60 s old) → the quote SMS is
 *    in transit.
 *  • status 'done' WITHOUT an intake_id → inspection escalation or ended
 *    conversation: NOT in-flight, let the AI handle the next message.
 */
export function isQuoteInflight(prior: InflightPrior, ageMs: number): boolean {
  if (!prior) return false
  if (prior.status === 'structuring' && ageMs < STRUCTURING_INFLIGHT_MAX_MS) {
    return true
  }
  if (
    prior.status === 'done' &&
    !!prior.intake_id &&
    ageMs < DONE_INFLIGHT_WINDOW_MS
  ) {
    return true
  }
  return false
}
