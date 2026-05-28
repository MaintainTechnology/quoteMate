// "Has a quote already been drafted on this conversation?"
//
// Drives THREE downstream gates inside the SMS inbound route:
//   • photo-request SMS — don't double-fire a photo link
//   • WP9 product-picker interlock — don't re-open product choice
//   • intake/structure handoff — don't draft a second quote
//
// Getting this wrong silently kills delivery. A FALSE positive (we
// think a quote was drafted when it wasn't) ghosts the customer with
// "quote on its way shortly" → no quote ever lands. A FALSE negative
// (we miss that a quote was drafted) duplicates the quote.
//
// The rule:
//   • mode === 'new'  → never inherit prior state (`prior` is a
//     DIFFERENT older conversation for this phone number).
//   • Otherwise the conversation IS being reused, and a quote was
//     drafted when ONE of these holds:
//       a. prior.intake_id is set — explicit ground truth that the
//          intake/quote handoff fired.
//       b. prior.status === 'structuring' — the handoff is in mid-flight
//          and intake_id may not be visible to this read yet.
//
// Status='done' is NOT a trigger by itself. The dialog also writes
// status='done' when the customer says "nothing for now bye"
// (decision.action='end_conversation'). Conflating that with a
// drafted quote was the 2026-05-28 production bug surfaced on
// Sparky convo 1c639179: dismissal → 5-min grace re-engagement →
// route silently treated the reused conversation as already-drafted
// → no photo SMS, no intake, no quote, customer ghosted.
//
// Pure + unit-tested so this rule can't silently regress again.
// Mirrors the lib/sms/inflight.ts pattern.

/** Minimal shape this rule needs from the prior sms_conversations row. */
export type QuoteAlreadyDraftedPrior = {
  status?: string | null
  /** Set ONLY when a quote/intake handoff actually happened. Null for
   *  inspection escalations and ended conversations. */
  intake_id?: string | null
} | null | undefined

export type ConversationMode = 'new' | 'reuse' | 'inflight'

/**
 * True when the prior conversation already produced (or is producing)
 * a quote — used to suppress photo/WP9/intake-handoff so we don't
 * double-fire. NEVER conflates "customer ended the chat" with "quote
 * was drafted" — only intake_id or status='structuring' counts.
 */
export function quoteAlreadyDrafted(
  mode: ConversationMode,
  prior: QuoteAlreadyDraftedPrior,
): boolean {
  if (mode === 'new') return false
  if (!prior) return false
  if (prior.intake_id) return true
  if (prior.status === 'structuring') return true
  return false
}
