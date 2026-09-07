// "Should the route fire the photo-upload SMS on this dialog turn?"
//
// Single source of truth for the photo-request gate. Used by the SMS
// inbound route to decide whether to dispatch the upload-link SMS in
// step 8b/8c. Pulled out as a pure module so the three-trigger logic
// (each with its own incident history) can be tested without spinning
// up the full route.
//
// THREE TRIGGERS — any one suffices, all subject to the negative gates:
//
//   1. sonnetRequestedPhoto: Sonnet set decision.request_photo_link=true
//      on the verification-handshake turn (Rule 10 in dialog.ts).
//   2. finishFallbackTrigger: decision.action === 'finish' on an easy-5
//      job and Sonnet didn't already trigger. Safety-net so we never
//      silently drop the photo SMS when the dialog wraps up.
//   3. wp9PickerTrigger: decision.offer_product_choice === true on an
//      easy-5 job. Added 2026-05-28 after Sparky convo 27f22f65 — when
//      the customer drops all info in turn 1, Sonnet jumps straight to
//      the WP9 product picker (action !== 'finish'), so neither of the
//      first two triggers fires and the photo SMS is silently skipped
//      even though Sonnet's wrap-up text promises one. Trigger #3
//      restores the link on those "all-info-in-turn-1" picker turns.
//
// NEGATIVE GATES — every one of these must hold or the photo is suppressed:
//
//   • photoRequestToken must be set (legacy conversations have none)
//   • !photoRequestAlreadySent (this conversation hasn't fired one yet)
//   • !freshIntakeId (intake was NOT created on this turn — photo went
//     with the prior draft, or there is no draft)
//   • !inflightContinuation (a quote is still drafting from a prior turn)
//   • action !== 'escalate_inspection' (going to $99 site visit, no photo)
//   • action !== 'end_conversation' (customer said bye, no photo)
//   • jobTypeIsEasy5 (only easy-5 quote types benefit from a photo)
//
// Returns { fire, reason } so the route logs WHY a photo did or didn't go.

export type PhotoRequestTriggerInput = {
  /** Truthy when the conversation has an upload token (every v6+ row). */
  photoRequestToken: string | null | undefined
  photoRequestAlreadySent: boolean
  /** Intake row was created on THIS turn (not a prior turn). */
  freshIntakeId: string | null | undefined
  inflightContinuation: boolean
  /** Sonnet's structured action — drives the finish-fallback path. */
  decisionAction: string | null | undefined
  /** Sonnet explicitly asked for the photo link on this turn. */
  sonnetRequestedPhoto: boolean
  /** Sonnet wants to open the WP9 product picker on this turn. */
  offerProductChoice: boolean
  /** Job is one of the easy-5 (auto-quoteable) types. */
  jobTypeIsEasy5: boolean
  /** The job's photo requirement is ALREADY satisfied — the customer has sent
   *  one, or has said they cannot (spec ev-charger-location-photo R9). Only EV
   *  charger sets this today; every other job type leaves it false and keeps
   *  the old behaviour exactly.
   *
   *  Without it the finish-fallback fires on the very turn the gate PASSES, so
   *  the customer who just sent a photo — or just told us they could not — is
   *  immediately asked for one again, contradicting R9's "never asked again in
   *  that conversation". */
  photoRequirementSatisfied?: boolean
  /** The customer EXPLICITLY asked for the link on this turn ("can you send
   *  the link", "didn't get it", "resend"). Defeats the two lifetime latches
   *  below — and only those two.
   *
   *  Why this exists: `photoRequestAlreadySent` and `freshIntakeId` are
   *  permanent for the life of a conversation, so once either flipped, the
   *  ONLY code path that can emit an /upload/ URL was unreachable forever.
   *  Meanwhile the dialog prompt reads a different flag and kept telling the
   *  model the link had not been sent, so it promised one on every subsequent
   *  turn and none was ever dispatched. Across production, 204 of 245 outbound
   *  messages mentioning a "link" carry no URL.
   *
   *  Scope is deliberately narrow: a customer asking for a link they were
   *  promised is always a legitimate re-send, but the remaining gates
   *  (no_token, escalate_inspection, end_conversation, job_type_not_easy5)
   *  stay absolute — each encodes a decision the customer's ask cannot
   *  override. */
  customerAskedForLink?: boolean
}

export type PhotoRequestTriggerOutcome =
  | { fire: true; reason: 'sonnet_requested' | 'finish_fallback' | 'wp9_picker' }
  | {
      fire: false
      reason:
        | 'no_token'
        | 'already_sent'
        | 'fresh_intake_this_turn'
        | 'inflight_continuation'
        | 'escalate_inspection'
        | 'end_conversation'
        | 'job_type_not_easy5'
        | 'photo_requirement_satisfied'
        | 'no_trigger'
    }

/**
 * Did the customer just ask for the upload link, or say they never got it?
 *
 * PURE, and deliberately narrow. It only ever RE-SENDS a link the customer was
 * already promised, so a false positive costs one extra SMS carrying a real,
 * working URL — while a false negative leaves them stuck exactly as the
 * reported thread was. It is not a general intent classifier and must not
 * become one: broad matching here would re-fire the photo request on ordinary
 * conversation and undo the gates it sits in front of.
 *
 * Matches the shapes customers actually used in production: "can you give me
 * the link", "didnt received the link", "resend", "send it again", "link
 * doesn't work". Requires an explicit link/photo reference so a bare "again"
 * or "didn't get it" about something else does not trigger.
 */
export function customerAskedForPhotoLink(text: string | null | undefined): boolean {
  const s = (text ?? '').toLowerCase().trim()
  if (!s) return false
  // Must be about a link/upload/photo at all.
  if (!/\b(link|url|upload|photo|picture|pic)\b/.test(s)) return false
  return (
    // asking for it
    /\b(send|resend|re-send|give|share|text|sms)\b/.test(s) ||
    // never arrived / broken — covers "didnt received the link" (sic)
    /\b(didn'?t|dint|never|no|not|haven'?t|havent|can'?t|cant|couldn'?t|doesn'?t|doesnt|don'?t|dont|won'?t|wont)\b[^.?!]{0,24}\b(get|got|receiv\w*|see|find|open|work\w*|load\w*|arriv\w*|come|came)\b/.test(s) ||
    /\b(where|missing|broken|expired|dead|invalid)\b/.test(s) ||
    /\bagain\b/.test(s)
  )
}

export function shouldSendPhotoRequest(
  input: PhotoRequestTriggerInput,
): PhotoRequestTriggerOutcome {
  // Negative gates first — these are absolute suppressions.
  if (!input.photoRequestToken) return { fire: false, reason: 'no_token' }
  // These two are LIFETIME latches, so an explicit re-ask is the one thing
  // allowed past them — otherwise "can you send the link again" is structurally
  // unanswerable and the model is left promising a link the sender can never
  // emit. Everything below stays absolute.
  if (input.photoRequestAlreadySent && !input.customerAskedForLink) {
    return { fire: false, reason: 'already_sent' }
  }
  if (input.freshIntakeId && !input.customerAskedForLink) {
    return { fire: false, reason: 'fresh_intake_this_turn' }
  }
  if (input.inflightContinuation) return { fire: false, reason: 'inflight_continuation' }
  if (input.decisionAction === 'escalate_inspection') return { fire: false, reason: 'escalate_inspection' }
  if (input.decisionAction === 'end_conversation') return { fire: false, reason: 'end_conversation' }
  if (!input.jobTypeIsEasy5) return { fire: false, reason: 'job_type_not_easy5' }
  // Already have what we asked for (or a decline) — asking again is noise, and
  // for EV it directly contradicts R9. Sits with the other absolute
  // suppressions so it beats every trigger below, including finish_fallback.
  if (input.photoRequirementSatisfied) {
    return { fire: false, reason: 'photo_requirement_satisfied' }
  }

  // Triggers — any one fires the photo, in priority order so audit
  // logs name the highest-signal trigger when multiple are true.
  if (input.sonnetRequestedPhoto) return { fire: true, reason: 'sonnet_requested' }
  if (input.decisionAction === 'finish') return { fire: true, reason: 'finish_fallback' }
  if (input.offerProductChoice) return { fire: true, reason: 'wp9_picker' }

  return { fire: false, reason: 'no_trigger' }
}
