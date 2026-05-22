// Is a quote genuinely being drafted right now for this conversation?
// When true the inbound is an "in-flight continuation" — the dialog still
// runs (the customer is never blocked) but the route skips the intake
// handoff / status write / photo gate so this turn cannot collide with
// the in-progress draft. See app/api/sms/inbound/route.ts.
//
// In-flight === status 'structuring' ONLY. `structuring` is the transient
// status the conversation carries from the intake handoff until the draft
// pipeline completes (~50s later) — that, and only that, is the window
// where a second handoff would tangle the pipeline.
//
// Why NOT `status='done'` anymore (bug fixed 2026-05-22): a `done`
// conversation has already finished drafting — `intake_id` is set, the
// quote exists. The route's `hasExistingIntake` guard already prevents a
// re-draft and keeps status correct, and the customer SHOULD get a normal
// dialog reply. The old `done` + intake_id + `ageMs < 60s` branch keyed
// the 60s "quote SMS in transit" window off `last_message_at` — but EVERY
// message (including the bot's own replies) resets `last_message_at`, so
// once a conversation had ever produced a quote, every quick customer
// reply falsely registered as "in flight" and got the canned hold-on.
// That made a post-quote conversation oscillate between dialog turns and
// bogus hold-ons. `structuring` is a real status transition, so it has no
// such reset problem.
//
// Pure + unit-tested (inflight.test.ts) so this rule can't silently
// regress again.

/** A `structuring` conversation older than this is stuck/failed — treat
 *  as no longer in-flight rather than holding the customer on a quote
 *  that never lands. */
export const STRUCTURING_INFLIGHT_MAX_MS = 5 * 60 * 1000

/** Minimal shape needed from the prior sms_conversations row. */
export type InflightPrior = {
  status?: string | null
  /** Set ONLY when a quote/intake handoff actually happened. Null for
   *  inspection escalations and ended conversations. */
  intake_id?: string | null
} | null | undefined

/**
 * True when a quote is genuinely mid-draft for this conversation:
 * status 'structuring' and less than 5 minutes old. A `done` conversation
 * is NOT in-flight — its draft has finished and the route's
 * `hasExistingIntake` guard owns the don't-re-draft behaviour.
 */
export function isQuoteInflight(prior: InflightPrior, ageMs: number): boolean {
  if (!prior) return false
  return prior.status === 'structuring' && ageMs < STRUCTURING_INFLIGHT_MAX_MS
}
