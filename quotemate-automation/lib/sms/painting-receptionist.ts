// ════════════════════════════════════════════════════════════════════
// SMS painting receptionist — pure per-turn decision.
//
// Given the conversation's persisted painting state (gathered slots + the
// step we last asked about) plus the customer's new message, decide the
// turn:
//   • cancel     — customer asked to stop / cancel (checked FIRST).
//   • offer_form — opener: offer the self-serve form link FIRST. The route
//                  mints the per-request token and composes the message
//                  ("fill this in, or reply here and I'll ask a few
//                  questions").
//   • await_form — customer chose the form → acknowledge and wait. The
//                  form POST prepares a draft for painter review; a later
//                  text switches them to Q&A.
//   • ask        — fold the answer in, send the next question (dropdown
//                  options are inlined in the question text by the intake).
//   • estimate   — enough gathered cleanly → run estimatePainting + send.
//   • inspection — a customer-declared trigger (poor substrate / raked
//                  ceiling / 3+ storeys) forces an on-site visit.
//   • booking    — reply to "shall we book the inspection?". Terminal.
//   • passthrough— a warm 'quoted' thread got an unrelated message → hand
//                  it back to the general dialog (the route returns false).
//
// The route does the I/O (mint token, run estimate, persist, send SMS);
// this module is pure so the conversation logic is fully unit-tested.
// Mirrors lib/sms/roofing-receptionist.ts.
// ════════════════════════════════════════════════════════════════════

import {
  applyPaintingAnswer,
  isNegative,
  isStopRequest,
  looksLikePaintingEnquiry,
  nextPaintingStep,
  parseAuState,
  parsePostcode,
  type PaintingSlots,
  type PaintingStep,
} from './painting-intake'
// Generic AU-address detectors + the ONE shared yes/no vocabulary for the
// address handshake — pure, no roofing coupling (shared helpers).
import { extractStreetAddress, isAffirmative, rejectsReadBack } from './roofing-intake'
import { consumeAddressMiss, consumeAddressRejection } from './verify-address'

/** Persisted on sms_conversations.painting_state (jsonb), decoupled from
 *  the electrical/plumbing conversation_state.slots and the roofing_state. */
export type PaintingConversationState = {
  slots: PaintingSlots
  workflow_stage?: 'awaiting_review' | 'ready' | 'send_failed'
  /** The step we asked the customer about last turn (null on the opener). */
  last_step?: PaintingStep | null
  /** Token of the self-serve form request we minted (the unique-hash link). */
  pending_form_token?: string | null
  /** Token of the saved painting job awaiting / carrying the sent quote. */
  pending_quote_token?: string | null
  /** Trades the customer has explicitly refused in THIS conversation —
   *  mirrors RoofingConversationState.declined_trades. Set by the LLM
   *  receptionist; once 'painting' is here this receptionist never engages
   *  again on this thread. */
  declined_trades?: string[] | null
  /** Re-ask count for an unclear booking reply. Bounded at one. */
  booking_reask?: number | null
}

/** The gather steps a customer reply is folded into. */
const ANSWERABLE_STEPS: ReadonlySet<PaintingStep> = new Set<PaintingStep>([
  'address',
  'confirm_address',
  'location',
  'scopes',
  'coats',
  'condition',
  'ceiling_height',
  'storeys',
  'floor_area',
  'colour_change',
])

export type PaintingTurnDecision =
  // Opener — route mints the form token + composes the offer message.
  | { action: 'offer_form'; slots: PaintingSlots }
  // Customer opted for the form — acknowledge and wait for the submission.
  | { action: 'await_form'; slots: PaintingSlots; reply: string }
  // `handoff` — this ask is the END of the address handshake: the budget is
  // spent and the reply PROMISES the customer a human. The route must notify
  // the tradie on it, or we make a promise nobody hears
  // (specs/address-confirm-loop.md req 2).
  | { action: 'ask'; slots: PaintingSlots; step: PaintingStep; reply: string; handoff?: true }
  | { action: 'estimate'; slots: PaintingSlots }
  | { action: 'inspection'; slots: PaintingSlots; reason: string }
  | { action: 'cancel'; slots: PaintingSlots }
  | { action: 'booking'; slots: PaintingSlots; confirmed: boolean }
  // `close` mirrors the roofing decision: a genuine switch to another trade
  // closes the painting gather so the next message stays with the general
  // dialog. Absent/false leaves the gather resume-able.
  | { action: 'passthrough'; slots: PaintingSlots; close?: boolean }

const AWAIT_FORM_ACK =
  "Great — fill that in whenever you're ready. We'll prepare a draft for the painter to review before sending your quote. Or reply here and I'll ask a few quick questions instead."
// ponytail: the address re-ask wording moved to verify-address.ts
// (ADDRESS_REASK_REPLY) so the string and its budget live together.

// The customer is replying to the form offer. We only treat it as "use the
// form" on an EXPLICIT form cue; a decline, or anything ambiguous, starts
// the question-by-question flow (the spec's fallback). A bare "yes" is left
// to Q&A — it's safer to start asking than to assume they want the link.
const FORM_YES = /\b(form|link|fill|online|web ?form|send (it|the form|me the form)|i'?ll (do|use|fill)|use the (form|link))\b/
const FORM_NO = /\b(no|nah|nope|just ask|ask me|answer here|do it here|here|questions?|prefer|rather|over (the )?(phone|text)|by text|quicker|skip|don'?t (bother|want))\b/

/** PURE — did the customer opt to use the self-serve form? Explicit form
 *  cue and not a decline. Anything else → fall back to Q&A. */
export function customerWantsForm(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  if (FORM_NO.test(t)) return false
  return FORM_YES.test(t)
}

/** PURE — must this turn run the DETERMINISTIC machine even when the LLM
 *  receptionist flag is on? Two turns are pre-empted (spec 2026-08-05):
 *    • the opener (no active painting flow) — the form-offer opener
 *      (buildPaintingFormOffer: form link + "or just reply here") must go
 *      out on both paths, so the two layers open identically;
 *    • an explicit "use the form" reply parked at offer_form — it must
 *      resolve to await_form with the standard acknowledgement.
 *  Everything else stays with whichever layer the flag picks. */
export function paintingTurnIsDeterministic(
  prev: PaintingConversationState | null | undefined,
  inbound: string,
): boolean {
  if (!isActivePaintingFlow(prev)) return true
  return prev?.last_step === 'offer_form' && customerWantsForm(inbound)
}

/** PURE — opportunistically capture an address from a message that wasn't
 *  a direct answer to the address question (e.g. a customer who declines
 *  the form by just giving their address). Leaves slots untouched when the
 *  message doesn't parse as an address. */
function captureOpeningAddress(slots: PaintingSlots, inbound: string): PaintingSlots {
  if (slots.address) return slots
  const next = applyPaintingAnswer(slots, 'address', inbound)
  return next.address ? next : slots
}

/**
 * PURE — did this reply CHANGE a slot that drives the inspection decision?
 * Only `storeys` (3+) and `condition` (poor) route to an inspection, so only
 * those two can un-route it. Returns the corrected slots, or null when nothing
 * inspection-relevant moved — which keeps a question or a proposed time a live
 * lead rather than turning every unclear reply into a re-gather.
 */
function correctInspectionSlot(slots: PaintingSlots, inbound: string): PaintingSlots | null {
  // "the condition is sound not poor" names BOTH values, and the mapper would
  // take the wrong one. Drop the negated clause so the kept value wins.
  const text = inbound.replace(/\bnot\s+\w+/gi, ' ')
  let next = slots
  for (const field of ['storeys', 'condition'] as const) {
    const applied = applyPaintingAnswer(next, field, text)
    // A correction must produce a value AND differ from what we already had.
    if (applied[field] != null && applied[field] !== next[field]) next = applied
  }
  return next === slots ? null : next
}

/** PURE — turn the gathered slots into the next ask/estimate/inspection. */
function fromNextStep(slots: PaintingSlots): PaintingTurnDecision {
  const next = nextPaintingStep(slots)
  if (next.step === 'ready') return { action: 'estimate', slots }
  if (next.step === 'inspection') {
    return { action: 'inspection', slots, reason: next.reason ?? 'an on-site inspection is needed' }
  }
  return { action: 'ask', slots, step: next.step, reply: next.question ?? '' }
}

/**
 * PURE — advance the painting conversation one turn.
 */
export function advancePainting(
  prev: PaintingConversationState | null | undefined,
  inbound: string,
): PaintingTurnDecision {
  const lastStep = prev?.last_step ?? null
  let slots: PaintingSlots = { ...(prev?.slots ?? {}) }

  // (1) Stop / cancel / opt-out — always honoured first, at any step.
  if (isStopRequest(inbound)) {
    return { action: 'cancel', slots }
  }

  // (2) Awaiting "shall we book the inspection?".
  // Only an explicit decline closes without notifying the tradie; a
  // question or a proposed time is a LIVE lead (same single-shot drop the
  // roofing receptionist had — audit 2026-07-23). isStopRequest is handled
  // above, so a genuine opt-out never reaches here.
  if (lastStep === 'await_booking') {
    // ...but a CORRECTION to the slot that caused the inspection is not
    // consent — it removes the reason for the visit. Live 2026-08-05: "3"
    // storeys routed to inspection, the customer replied "Oh sorry its 1
    // storey only", and because that is not a decline it was read as "yes,
    // book it". The correction was discarded and a painter was promised for a
    // job that no longer needed a site visit. Re-price instead.
    const corrected = correctInspectionSlot(slots, inbound)
    if (corrected) return fromNextStep(corrected)
    return { action: 'booking', slots, confirmed: !isNegative(inbound) }
  }

  // (3) Reply to the form offer — use the form, or start the questions.
  if (lastStep === 'offer_form') {
    if (customerWantsForm(inbound)) {
      return { action: 'await_form', slots, reply: AWAIT_FORM_ACK }
    }
    // Declined / answering here → start Q&A. Capture an address if the
    // reply already contains one ("nah just ask — it's 12 Smith St…").
    return fromNextStep(captureOpeningAddress(slots, inbound))
  }

  // (4) They were sent the form but are now texting — switch to Q&A.
  if (lastStep === 'await_form') {
    return fromNextStep(captureOpeningAddress(slots, inbound))
  }

  // (5) Warm 'quoted' thread — a quote was already sent. Only a fresh
  // painting enquiry reopens (re-offering the form); anything else is
  // handed back to the general dialog (never trapped, never re-quoted).
  if (lastStep === 'quoted') {
    if (!looksLikePaintingEnquiry(inbound)) return { action: 'passthrough', slots }
    return { action: 'offer_form', slots: {} }
  }

  // (6) Opener / closed — offer the form FIRST when this reads like a
  // painting enquiry. (The route only routes painting messages here, but
  // guard anyway.)
  if (lastStep === null || lastStep === 'closed') {
    if (looksLikePaintingEnquiry(inbound)) return { action: 'offer_form', slots: {} }
    return { action: 'passthrough', slots }
  }

  // (7) Gathering inputs — adaptive, mirroring the roofing receptionist
  // (2026-07-24): a clear address anywhere wins first (even over an interrupt
  // word), then a topic switch / interrupt / question bails to the general
  // dialog BEFORE a loose parser can mis-commit it, then the step is parsed.
  if (ANSWERABLE_STEPS.has(lastStep)) {
    const before = slots
    const t = (inbound ?? '').toLowerCase()

    // 1. A clear address ANYWHERE → confirm the NEW address. The street-type
    //    test runs on the EXTRACTED address (not the whole message), so "no way
    //    to tell" isn't a street. Once the address is CONFIRMED, only an
    //    explicit correction cue re-folds it — a bare restatement in a step
    //    answer ("walls and ceilings at 22 New Rd") must NOT clobber it. Runs
    //    on the ORIGINAL slots so "no it's 22 New Rd" on confirm_address folds
    //    the new address instead of clearing + re-asking.
    const addr = extractStreetAddress(inbound)
    const streetOnAddr = X_STREET_TYPE.test((addr ?? '').toLowerCase())
    const cue = X_ADDRESS_CUE.test(t) || X_CORRECTION_CUE.test(t)
    // Leading negation over a REAL street address is a correction; the
    // street-signal requirement stops "no way to tell" reading as a street.
    const negatedAddr = /^\s*(no|nope|nah|not)\b/.test(t) && streetOnAddr
    const addrStrong = before.address_confirmed ? cue || negatedAddr : streetOnAddr || cue
    if (addr && addrStrong && (!before.address || xNormAddr(addr) !== xNormAddr(before.address))) {
      const s: PaintingSlots = { ...before, address: addr, address_confirmed: false }
      const pc = parsePostcode(inbound)
      if (pc) s.postcode = pc
      const st = parseAuState(inbound)
      if (st) s.state = st
      return fromNextStep(s)
    }

    // 1b. The customer REJECTED the read-back and gave no replacement (a
    //     correction carries a street address and was folded above). Consume
    //     it through the SHARED budget, exactly as roofing-receptionist.ts
    //     does. Painting had no customer-rejection budget at all, so the bound
    //     could never fire on the trade the incident actually happened on —
    //     each rejection cleared the address, we re-asked, forever, and nobody
    //     was ever handed the lead (specs/address-confirm-loop.md req 1 + 2).
    if (lastStep === 'confirm_address' && !isAffirmative(inbound) && rejectsReadBack(inbound)) {
      const r = consumeAddressRejection(before)
      return {
        action: 'ask',
        slots: r.slots,
        step: r.step,
        reply: r.reply,
        ...(r.handoff ? { handoff: true as const } : {}),
      }
    }

    // 2. Bail to the general LLM dialog BEFORE the parse for:
    //    - a question (a mappable keyword would otherwise be committed);
    //    - a topic switch / interrupt on any NON-enumerable step. The
    //      'scopes' step is excluded here because "also"/"as well" are
    //      idiomatic scope enumerators ("walls, also the doors") — it is
    //      bailed AFTER the parse instead (step 4). Pre-parsing the other
    //      steps matters because some parsers (colour_change) commit an
    //      answer for ANY message, so a post-parse "changedNothing" gate
    //      would be dead there.
    const isQuestion = inbound.includes('?') || X_QUESTION_LEAD.test(t)
    const isSwitch = X_TOPIC_SWITCH.test(t) || X_INTERRUPT.test(t)
    if (
      (isQuestion && lastStep !== 'address' && lastStep !== 'confirm_address') ||
      (isSwitch && lastStep !== 'scopes')
    ) {
      return { action: 'passthrough', slots: before }
    }

    // 3. Parse the current step.
    slots = applyPaintingAnswer(slots, lastStep, inbound)
    // An address answer that didn't parse → clarify, don't store junk. Routed
    // through the SHARED budget: this single string had no bound and no second
    // wording, so two unparseable answers in a row got byte-identical replies
    // forever (specs/address-confirm-loop.md req 4 + req 5).
    if (lastStep === 'address' && !slots.address) {
      const m = consumeAddressMiss(slots)
      return {
        action: 'ask',
        slots: m.slots,
        step: m.step,
        reply: m.reply,
        ...(m.handoff ? { handoff: true as const } : {}),
      }
    }

    // The read-back was answered with NEITHER a yes nor a no ("Hi Mate").
    // Falling through here lets nextPaintingStep recompose the identical
    // read-back off `!address_confirmed` alone, with no budget spent — which
    // is message #3 of the incident transcript. Re-ask in DIFFERENT words and
    // bound it (specs/address-confirm-loop.md req 4).
    if (lastStep === 'confirm_address' && slots.address && !slots.address_confirmed) {
      const m = consumeAddressMiss(slots)
      return {
        action: 'ask',
        slots: m.slots,
        step: m.step,
        reply: m.reply,
        ...(m.handoff ? { handoff: true as const } : {}),
      }
    }

    // 4. scopes only: a topic switch / interrupt that did NOT land as a scope
    //    is a bail. Post-parse so an enumeration that DOES land is kept;
    //    mapScopes returns null on a non-scope, so changedNothing is reliable.
    if (lastStep === 'scopes' && isSwitch) {
      const changedNothing = JSON.stringify(before) === JSON.stringify(slots)
      if (changedNothing) return { action: 'passthrough', slots: before }
    }
  }

  return fromNextStep(slots)
}

// Cross-step detectors — twin of the set in lib/sms/roofing-receptionist.ts;
// duplicated (small, pure regex) to keep each money-path self-contained
// rather than coupling both to a shared module.
const X_STREET_TYPE =
  /\b(st|street|rd|road|ave|av|avenue|dr|drive|hwy|highway|pde|parade|ln|lane|ct|court|cres|crescent|pl|place|blvd|boulevard|tce|terrace|way|cl|close|circuit|cct|esplanade|esp)\b/
const X_ADDRESS_CUE = /\b(address|addr)\b/
const X_CORRECTION_CUE =
  /\b(actually|instead|i meant|i mean|no i|no not|not the|change|changed|wrong|rather|meant to say)\b/
// "as well" is deliberately excluded — idiomatic for enumerating scopes
// ("walls as well as ceilings"), not a topic switch.
const X_TOPIC_SWITCH =
  /\b(also|another|different job|forget the|instead of the|while you.?re|whilst you.?re|one more thing)\b/
const X_INTERRUPT =
  /\b(wait|hold on|hang on|one sec|one moment|gimme a|give me a|hold up|stop for a|two secs|two seconds)\b/
const X_QUESTION_LEAD =
  /^\s*(what|why|how|when|where|which|who|did|do|does|can|could|will|would|is|are|have|has)\b/
const xNormAddr = (a: string | null | undefined) => (a ?? '').toLowerCase().replace(/\W+/g, '')

/**
 * PURE — the painting_state to persist after a turn. The route augments
 * the 'offer_form' result with the minted form token and the 'estimate'
 * result with the saved quote token (it owns those).
 *   offer_form → park at offer_form
 *   await_form → park at await_form
 *   ask        → park at the asked step
 *   estimate   → quoted (route may override to await_booking if the
 *                estimate itself routes to inspection)
 *   inspection → await_booking (waiting for "yes, book it")
 *   booking    → closed
 *   cancel     → closed
 *   passthrough→ stays quoted (route returns false; no persist)
 */
export function nextPaintingConversationState(
  decision: PaintingTurnDecision,
): PaintingConversationState {
  switch (decision.action) {
    case 'offer_form':
      return { slots: decision.slots, last_step: 'offer_form' }
    case 'await_form':
      return { slots: decision.slots, last_step: 'await_form' }
    case 'ask':
      return { slots: decision.slots, last_step: decision.step }
    case 'estimate':
      return { slots: decision.slots, last_step: 'quoted' }
    case 'inspection':
      return { slots: decision.slots, last_step: 'await_booking' }
    case 'passthrough':
      return { slots: decision.slots, last_step: 'quoted' }
    case 'cancel':
    case 'booking':
      return { slots: decision.slots, last_step: 'closed', pending_form_token: null, pending_quote_token: null }
  }
}

/** PURE — is this an ACTIVE painting flow (mid-gather or awaiting a reply),
 *  as opposed to closed/empty? The route uses this to decide whether to
 *  keep handling the thread as painting. */
export function isActivePaintingFlow(prev: PaintingConversationState | null | undefined): boolean {
  if (!prev || !prev.slots) return false
  const step = prev.last_step ?? null
  return step !== null && step !== 'closed'
}

/** Idle beyond this and a parked painting flow is stale — same reasoning as
 *  ROOFING_STALE_IDLE_MS (a reused conversation must not resume a painting
 *  session the customer walked away from hours ago). */
export const PAINTING_STALE_IDLE_MS = 60 * 60 * 1000

/** Only the warm 'quoted' thread re-serves on resume, so only it goes stale.
 *  await_form (customer filling the self-serve form — expected to be idle),
 *  await_booking (awaiting "yes book it") and mid-gather must survive idle so
 *  a genuine late reply still lands. Mirrors ROOFING_STALE_REPLAY_STEPS. */
const PAINTING_STALE_REPLAY_STEPS: ReadonlySet<PaintingStep> = new Set<PaintingStep>(['quoted'])

/** PURE — a painting flow parked on a stale-replay step ('quoted') and idle for
 *  longer than PAINTING_STALE_IDLE_MS is stale: return the closed state to
 *  persist, or null when there's nothing to expire. `idleMs` is the age of the
 *  conversation's last activity, supplied by the route. */
export function expireIdlePaintingState(
  prev: PaintingConversationState | null | undefined,
  idleMs: number,
): PaintingConversationState | null {
  const step = prev?.last_step ?? null
  if (!step || !PAINTING_STALE_REPLAY_STEPS.has(step)) return null
  if (idleMs < PAINTING_STALE_IDLE_MS) return null
  return {
    slots: {},
    last_step: 'closed',
    pending_form_token: null,
    pending_quote_token: null,
    // A refusal outlives the gather it interrupted — see the roofing twin.
    ...(prev?.declined_trades ? { declined_trades: prev.declined_trades } : {}),
  }
}

/** PURE — should the painting receptionist engage this turn?
 *
 *  Mirror of shouldEngageRoofing: normally engages on an active painting
 *  flow OR a fresh painting enquiry, but when a follow-up pin is active on
 *  the thread (the tradie chased a DIFFERENT quote), a stale painting_state
 *  must NOT resume — only a genuinely new painting enquiry may engage.
 *  (Spec 2026-07-05 Part A2.) */
export function shouldEngagePainting(
  prev: PaintingConversationState | null | undefined,
  inbound: string,
  followupPinActive: boolean,
  /** True when the general dialog has already gathered a TRADE-SPECIFIC slot
   *  from this thread's transcript. Gates the fresh-enquiry arm only. Defaults
   *  false so every existing caller and test is unchanged. */
  generalMidGather = false,
): boolean {
  // Same rule as shouldEngageRoofing: a trade the customer already turned
  // down is never re-opened in this conversation, and the refusal itself
  // usually carries the trade's own keyword.
  if ((prev?.declined_trades ?? []).includes('painting')) return false
  const canResume = isActivePaintingFlow(prev) && !followupPinActive
  // A FRESH KEYWORD MUST NOT OUTRANK A GATHER ALREADY IN PROGRESS.
  //
  // The same structural hole shouldEngageRoofing had, and worse on this side:
  // there is no namesOtherTrade equivalent here, so once painting engages on a
  // live electrical thread there is NO escape hatch at all — the customer's
  // corrections are parsed as failed painting answers.
  //
  // Scoped to this arm only: canResume is untouched, so a genuine painting
  // thread still resumes across turns.
  const isNewEnquiry = !generalMidGather && looksLikePaintingEnquiry(inbound)
  return canResume || isNewEnquiry
}
