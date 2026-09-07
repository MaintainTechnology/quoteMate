// Regression + coverage for the photo-request gate.
// Three triggers, seven negative gates. The Bug B regression case
// (2026-05-28, Sparky convo 27f22f65) is named explicitly so it
// can't sneak back in.

import { describe, expect, it } from 'vitest'
import {
  shouldSendPhotoRequest,
  customerAskedForPhotoLink,
  type PhotoRequestTriggerInput,
} from './photo-request-trigger'

// Baseline = every gate happy, no trigger set. Tests flip one knob.
function baseline(): PhotoRequestTriggerInput {
  return {
    photoRequestToken: 'token-abc',
    photoRequestAlreadySent: false,
    freshIntakeId: null,
    inflightContinuation: false,
    decisionAction: 'ask',
    sonnetRequestedPhoto: false,
    offerProductChoice: false,
    jobTypeIsEasy5: true,
  }
}

describe('shouldSendPhotoRequest — negative gates', () => {
  it('suppresses when no photoRequestToken (legacy conversation)', () => {
    const r = shouldSendPhotoRequest({ ...baseline(), photoRequestToken: null, sonnetRequestedPhoto: true })
    expect(r).toEqual({ fire: false, reason: 'no_token' })
  })

  it('suppresses when a photo SMS already fired this conversation', () => {
    const r = shouldSendPhotoRequest({ ...baseline(), photoRequestAlreadySent: true, sonnetRequestedPhoto: true })
    expect(r).toEqual({ fire: false, reason: 'already_sent' })
  })

  it('suppresses when an intake was created on THIS turn', () => {
    // The photo flow goes with the prior draft, not the just-created one.
    const r = shouldSendPhotoRequest({ ...baseline(), freshIntakeId: 'intake-1', sonnetRequestedPhoto: true })
    expect(r).toEqual({ fire: false, reason: 'fresh_intake_this_turn' })
  })

  it('suppresses on in-flight continuation', () => {
    const r = shouldSendPhotoRequest({ ...baseline(), inflightContinuation: true, sonnetRequestedPhoto: true })
    expect(r).toEqual({ fire: false, reason: 'inflight_continuation' })
  })

  it('suppresses when action=escalate_inspection (going to $99 site visit)', () => {
    const r = shouldSendPhotoRequest({ ...baseline(), decisionAction: 'escalate_inspection', sonnetRequestedPhoto: true })
    expect(r).toEqual({ fire: false, reason: 'escalate_inspection' })
  })

  it('suppresses when action=end_conversation (customer said bye)', () => {
    const r = shouldSendPhotoRequest({ ...baseline(), decisionAction: 'end_conversation', sonnetRequestedPhoto: true })
    expect(r).toEqual({ fire: false, reason: 'end_conversation' })
  })

  it('suppresses non-easy-5 job types even when Sonnet asks', () => {
    const r = shouldSendPhotoRequest({ ...baseline(), jobTypeIsEasy5: false, sonnetRequestedPhoto: true })
    expect(r).toEqual({ fire: false, reason: 'job_type_not_easy5' })
  })
})

describe('shouldSendPhotoRequest — triggers', () => {
  it('fires when Sonnet sets request_photo_link=true', () => {
    const r = shouldSendPhotoRequest({ ...baseline(), sonnetRequestedPhoto: true })
    expect(r).toEqual({ fire: true, reason: 'sonnet_requested' })
  })

  it('fires as a finish-fallback when action=finish on easy-5 job', () => {
    const r = shouldSendPhotoRequest({ ...baseline(), decisionAction: 'finish' })
    expect(r).toEqual({ fire: true, reason: 'finish_fallback' })
  })

  it('REGRESSION 2026-05-28 (Bug B): fires on WP9 picker turn when customer drops all info in turn 1', () => {
    // Sparky convo 27f22f65: customer's first SMS contained the whole
    // job ("Hey Mate I want to install electric storage hot water unit,
    // 315L, outside back wall, existing power"). Sonnet had no questions
    // to ask, so it returned offer_product_choice=true with action !=
    // 'finish'. The two original triggers both missed:
    //   • sonnetRequestedPhoto=false (Sonnet busy with picker)
    //   • finishFallbackTrigger=false (action != 'finish')
    // Result: photo SMS silently skipped, even though Sonnet's later
    // wrap-up text promised "Flicking you a photo link now". This third
    // trigger restores the link on these turns.
    const r = shouldSendPhotoRequest({
      ...baseline(),
      decisionAction: 'ask_product_options',
      offerProductChoice: true,
    })
    expect(r).toEqual({ fire: true, reason: 'wp9_picker' })
  })

  it('returns no_trigger when easy-5 + happy gates but no trigger fires', () => {
    // Baseline already has no trigger set.
    const r = shouldSendPhotoRequest(baseline())
    expect(r).toEqual({ fire: false, reason: 'no_trigger' })
  })
})

describe('shouldSendPhotoRequest — trigger priority', () => {
  it('Sonnet-requested wins over finish-fallback when both true', () => {
    // Audit-log clarity: name the highest-signal trigger first.
    const r = shouldSendPhotoRequest({
      ...baseline(),
      decisionAction: 'finish',
      sonnetRequestedPhoto: true,
    })
    expect(r).toEqual({ fire: true, reason: 'sonnet_requested' })
  })

  it('Sonnet-requested wins over wp9_picker when both true', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      offerProductChoice: true,
      sonnetRequestedPhoto: true,
    })
    expect(r).toEqual({ fire: true, reason: 'sonnet_requested' })
  })

  it('finish-fallback wins over wp9_picker when both true', () => {
    // Theoretical — Sonnet usually returns one OR the other, but defend
    // the ordering anyway so future changes don't reshuffle reasons.
    const r = shouldSendPhotoRequest({
      ...baseline(),
      decisionAction: 'finish',
      offerProductChoice: true,
    })
    expect(r).toEqual({ fire: true, reason: 'finish_fallback' })
  })
})

describe('shouldSendPhotoRequest — negative gates beat triggers', () => {
  it('escalate_inspection beats every trigger', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      decisionAction: 'escalate_inspection',
      sonnetRequestedPhoto: true,
      offerProductChoice: true,
    })
    expect(r).toEqual({ fire: false, reason: 'escalate_inspection' })
  })

  it('already_sent beats wp9_picker (no double-fire on re-engagement)', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      photoRequestAlreadySent: true,
      offerProductChoice: true,
    })
    expect(r).toEqual({ fire: false, reason: 'already_sent' })
  })
})

// ── Customer re-ask defeats the two LIFETIME latches ────────────────────
//
// Live evidence: 204 of 245 outbound SMS mentioning a "link" carried no URL,
// across 136 conversations and all five active tenants. `already_sent` and
// `fresh_intake_this_turn` are permanent for the life of a conversation, so
// once either flipped, the only code able to emit an /upload/ URL was
// unreachable — while the dialog prompt read a DIFFERENT flag and kept telling
// the model the link had not been sent. So it promised one every turn and none
// was dispatched. Reported thread: Sparky convo 473735ae, 2026-09-07, where the
// customer asked three times and was ultimately pushed to a $99 site visit for
// want of a photo he could never upload.
describe('shouldSendPhotoRequest — customer explicitly asks for the link', () => {
  it('re-sends after already_sent when the customer asks', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      photoRequestAlreadySent: true,
      customerAskedForLink: true,
      sonnetRequestedPhoto: true,
    })
    expect(r).toEqual({ fire: true, reason: 'sonnet_requested' })
  })

  it('re-sends once an intake exists when the customer asks', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      freshIntakeId: 'intake-1',
      customerAskedForLink: true,
      sonnetRequestedPhoto: true,
    })
    expect(r).toEqual({ fire: true, reason: 'sonnet_requested' })
  })

  it('re-sends when BOTH lifetime latches are set (the reported thread)', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      photoRequestAlreadySent: true,
      freshIntakeId: 'intake-1',
      customerAskedForLink: true,
      sonnetRequestedPhoto: true,
    })
    expect(r).toEqual({ fire: true, reason: 'sonnet_requested' })
  })

  it('still needs a token — asking cannot conjure one', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      photoRequestToken: null,
      customerAskedForLink: true,
      sonnetRequestedPhoto: true,
    })
    expect(r).toEqual({ fire: false, reason: 'no_token' })
  })

  it('does NOT override the inspection route', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      decisionAction: 'escalate_inspection',
      customerAskedForLink: true,
      sonnetRequestedPhoto: true,
    })
    expect(r).toEqual({ fire: false, reason: 'escalate_inspection' })
  })

  it('does NOT override end_conversation', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      decisionAction: 'end_conversation',
      customerAskedForLink: true,
      sonnetRequestedPhoto: true,
    })
    expect(r).toEqual({ fire: false, reason: 'end_conversation' })
  })

  it('does NOT override an ineligible job type', () => {
    const r = shouldSendPhotoRequest({
      ...baseline(),
      jobTypeIsEasy5: false,
      customerAskedForLink: true,
      sonnetRequestedPhoto: true,
    })
    expect(r).toEqual({ fire: false, reason: 'job_type_not_easy5' })
  })

  it('asking alone is not a trigger — something must still request the photo', () => {
    const r = shouldSendPhotoRequest({ ...baseline(), customerAskedForLink: true })
    expect(r).toEqual({ fire: false, reason: 'no_trigger' })
  })
})

describe('customerAskedForPhotoLink', () => {
  // Verbatim from the reported production thread.
  it.each([
    'Can you give me the link',
    'Didnt received the link',
    "Didn't get the link",
    'can you resend the link please',
    'send the link again',
    'the link doesnt work',
    'where is the link',
    'that link is broken',
    'never got the photo link',
    'can you text me the upload link',
  ])('matches %j', (s) => {
    expect(customerAskedForPhotoLink(s)).toBe(true)
  })

  // Must NOT re-fire on ordinary conversation — a false positive here re-sends
  // a photo request mid-dialog for no reason.
  it.each([
    'Yes that&apos;s right',
    'About 8 metres',
    'Single phase, plenty of spare ways',
    'can you send someone out next week',
    'didnt get a chance to look yet',
    'send me the quote again',
    '',
    null,
    undefined,
  ])('does not match %j', (s) => {
    expect(customerAskedForPhotoLink(s as string | null | undefined)).toBe(false)
  })
})
