// ════════════════════════════════════════════════════════════════════
// SMS roofing receptionist — pure per-turn decision.
//
// Given the conversation's persisted roofing state (gathered slots, the
// step we last asked about, any pending measured quote awaiting
// confirmation) plus the customer's new message, decide the turn:
//   • cancel     — customer asked to stop / cancel (checked FIRST).
//   • ask        — fold the answer in, send the next question.
//   • measure    — enough gathered → run measureAndPriceRoofs, then send
//                  the roof image link and ask "is this your roof?".
//   • inspection — gathered but material/pitch forces an on-site visit.
//   • send_saved — customer confirmed the building → send the saved quote
//                  (optionally for one picked structure). Terminal.
//   • reconfirm  — reply to the photo wasn't clear → re-ask.
//   • booking    — reply to "shall we book the inspection?". Terminal.
//
// Once a flow is closed (quote sent / cancelled / booked), an unrelated
// message never re-quotes; only a fresh roofing enquiry reopens it.
//
// The route does the I/O (measure, persist, SMS); this module is pure so
// the conversation logic is fully unit-tested.
// ════════════════════════════════════════════════════════════════════

import {
  applyRoofingAnswer,
  isAffirmative,
  isNegative,
  isStopRequest,
  mapIntent,
  nextRoofingStep,
  parseYearBuilt,
  type RoofingSlots,
  type RoofingStep,
} from './roofing-intake'

/** Persisted on sms_conversations.roofing_state (jsonb). */
export type RoofingConversationState = {
  slots: RoofingSlots
  /** The step we asked the customer about last turn (null on the opener). */
  last_step?: RoofingStep | null
  /** Token of the saved roofing_measurements row awaiting confirmation. */
  pending_quote_token?: string | null
  /** How many structures were measured (so a numbered pick can be validated). */
  pending_structure_count?: number | null
}

const ANSWERABLE_STEPS: ReadonlySet<RoofingStep> = new Set<RoofingStep>([
  'address',
  'confirm_address',
  'intent',
  'material',
  'pitch',
])

export type RoofingTurnDecision =
  | { action: 'ask'; slots: RoofingSlots; step: RoofingStep; reply: string }
  | { action: 'measure'; slots: RoofingSlots }
  | { action: 'inspection'; slots: RoofingSlots; reason: string }
  | { action: 'send_saved'; slots: RoofingSlots; structureChoice: number | null }
  | { action: 'reconfirm'; slots: RoofingSlots }
  | { action: 'cancel'; slots: RoofingSlots }
  | { action: 'booking'; slots: RoofingSlots; confirmed: boolean }

const WRONG_BUILDING_REPROMPT =
  "No worries. What's the correct property address, with suburb and postcode?"
const ADDRESS_RETRY =
  "Sorry, I didn't catch a property address there. What's the address? Please include the street number, suburb and postcode."

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }

/**
 * PURE — parse a structure pick from the customer's reply (1-based),
 * validated against the number of structures offered. Accepts a bare
 * number ("2"), "#2", "number 2", or an ordinal ("the second"). Returns
 * null when there's no valid pick.
 */
export function parseStructureChoice(inbound: string, count: number): number | null {
  const t = (inbound ?? '').toLowerCase()
  for (const [word, n] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(t) && n <= count) return n
  }
  const m = t.match(/\b#?(\d{1,2})\b/)
  if (m) {
    const n = Number(m[1])
    if (n >= 1 && n <= count) return n
  }
  return null
}

/**
 * PURE — advance the roofing conversation one turn.
 */
export function advanceRoofing(
  prev: RoofingConversationState | null | undefined,
  inbound: string,
): RoofingTurnDecision {
  const rawLastStep = prev?.last_step ?? null
  let slots: RoofingSlots = { ...(prev?.slots ?? {}) }

  // (1) Stop / cancel / opt-out — always honoured first, at any step.
  if (isStopRequest(inbound)) {
    return { action: 'cancel', slots }
  }

  // (2) Awaiting "shall we book the inspection?".
  if (rawLastStep === 'await_booking') {
    return { action: 'booking', slots, confirmed: isAffirmative(inbound) && !isNegative(inbound) }
  }

  // (3) Confirmation: replying to "is this your roof?".
  if (rawLastStep === 'confirm_roof') {
    const count = prev?.pending_structure_count ?? 1
    if (isNegative(inbound)) {
      const reset: RoofingSlots = {
        ...slots,
        address: null,
        postcode: null,
        state: null,
        address_confirmed: false,
      }
      return { action: 'ask', slots: reset, step: 'address', reply: WRONG_BUILDING_REPROMPT }
    }
    const choice = parseStructureChoice(inbound, count)
    if (choice != null && count > 1) {
      return { action: 'send_saved', slots, structureChoice: choice }
    }
    if (isAffirmative(inbound)) {
      return { action: 'send_saved', slots, structureChoice: null }
    }
    return { action: 'reconfirm', slots }
  }

  // (4) Closed flow — a fresh enquiry restarts from scratch.
  let lastStep: RoofingStep | null = rawLastStep
  if (rawLastStep === 'closed') {
    slots = {}
    lastStep = null
  }

  // (5) Gathering inputs.
  let nextSlots = slots
  if (lastStep && ANSWERABLE_STEPS.has(lastStep)) {
    nextSlots = applyRoofingAnswer(slots, lastStep, inbound)
    // An address answer that didn't parse as an address → clarify, don't
    // store junk (and don't silently re-send the same prompt).
    if (lastStep === 'address' && !nextSlots.address) {
      return { action: 'ask', slots: nextSlots, step: 'address', reply: ADDRESS_RETRY }
    }
  } else {
    if (!nextSlots.intent) {
      const intent = mapIntent(inbound)
      if (intent) nextSlots.intent = intent
    }
    if (nextSlots.year_built == null) {
      const y = parseYearBuilt(inbound)
      if (y != null) nextSlots.year_built = y
    }
  }

  const next = nextRoofingStep(nextSlots)
  if (next.step === 'ready') return { action: 'measure', slots: nextSlots }
  if (next.step === 'inspection') {
    return { action: 'inspection', slots: nextSlots, reason: next.reason ?? 'on-site inspection required' }
  }
  return { action: 'ask', slots: nextSlots, step: next.step, reply: next.question ?? '' }
}

/**
 * PURE — the roofing_state to persist after a turn. The route augments
 * the 'measure' result with the saved quote token + structure count (it
 * owns those), and preserves them on 'reconfirm'.
 *   ask        → park at the asked step
 *   measure    → park at confirm_roof
 *   reconfirm  → stay at confirm_roof
 *   inspection → park at await_booking (waiting for "yes book it")
 *   send_saved → closed (quote delivered)
 *   cancel     → closed
 *   booking    → closed
 */
export function nextRoofingConversationState(
  decision: RoofingTurnDecision,
): RoofingConversationState {
  switch (decision.action) {
    case 'ask':
      return { slots: decision.slots, last_step: decision.step, pending_quote_token: null, pending_structure_count: null }
    case 'measure':
    case 'reconfirm':
      return { slots: decision.slots, last_step: 'confirm_roof' }
    case 'inspection':
      return { slots: decision.slots, last_step: 'await_booking', pending_quote_token: null, pending_structure_count: null }
    case 'send_saved':
    case 'cancel':
    case 'booking':
      return { slots: decision.slots, last_step: 'closed', pending_quote_token: null, pending_structure_count: null }
  }
}

/** PURE — is this conversation an ACTIVE roofing flow (mid-gather or
 *  awaiting a reply), as opposed to closed/empty? The route uses this to
 *  decide whether to keep handling the thread as roofing. */
export function isActiveRoofingFlow(prev: RoofingConversationState | null | undefined): boolean {
  if (!prev || !prev.slots) return false
  const step = prev.last_step ?? null
  return step !== null && step !== 'closed'
}
