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
        | 'no_trigger'
    }

export function shouldSendPhotoRequest(
  input: PhotoRequestTriggerInput,
): PhotoRequestTriggerOutcome {
  // Negative gates first — these are absolute suppressions.
  if (!input.photoRequestToken) return { fire: false, reason: 'no_token' }
  if (input.photoRequestAlreadySent) return { fire: false, reason: 'already_sent' }
  if (input.freshIntakeId) return { fire: false, reason: 'fresh_intake_this_turn' }
  if (input.inflightContinuation) return { fire: false, reason: 'inflight_continuation' }
  if (input.decisionAction === 'escalate_inspection') return { fire: false, reason: 'escalate_inspection' }
  if (input.decisionAction === 'end_conversation') return { fire: false, reason: 'end_conversation' }
  if (!input.jobTypeIsEasy5) return { fire: false, reason: 'job_type_not_easy5' }

  // Triggers — any one fires the photo, in priority order so audit
  // logs name the highest-signal trigger when multiple are true.
  if (input.sonnetRequestedPhoto) return { fire: true, reason: 'sonnet_requested' }
  if (input.decisionAction === 'finish') return { fire: true, reason: 'finish_fallback' }
  if (input.offerProductChoice) return { fire: true, reason: 'wp9_picker' }

  return { fire: false, reason: 'no_trigger' }
}
