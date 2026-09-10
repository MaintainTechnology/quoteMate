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
  extractStreetAddress,
  isAffirmative,
  isAmbiguousMetal,
  isNegative,
  isStopRequest,
  looksLikeRoofingEnquiry,
  isGreetingOnly,
  looksCommercial,
  mapIntent,
  namesOtherTrade,
  mapMaterial,
  mapPitch,
  nextRoofingStep,
  parseAuState,
  parsePostcode,
  parseYearBuilt,
  rejectsReadBack,
  type RoofingSlots,
  type RoofingStep,
} from './roofing-intake'
// The read-back wordings, the rejection budget and the re-ask copy all live
// with the module that COMPOSES them, so both trades share one vocabulary and
// one budget (specs/address-confirm-loop.md).
import {
  ADDRESS_REJECTED_REPLY,
  addressRecheckQuestion,
  consumeAddressRejection,
  isAddressReadBack,
} from './verify-address'
// Reused, not re-implemented: the "did they ask for the form?" predicate is
// pure text and trade-agnostic, and the two trades MUST agree on it — a
// second copy is a second vocabulary to drift.
import { customerWantsForm } from './painting-receptionist'

/** Persisted on sms_conversations.roofing_state (jsonb). */
export type RoofingConversationState = {
  slots: RoofingSlots
  workflow_stage?: 'awaiting_review' | 'ready' | 'send_failed'
  /** The step we asked the customer about last turn (null on the opener). */
  last_step?: RoofingStep | null
  /** Token of the saved roofing_measurements row this thread is parked on:
   *  awaiting the roof confirmation (confirm_roof), warm after a quote
   *  (quoted), or awaiting the booking reply (await_booking — kept since
   *  US-002 so the booking-confirm tradie notify can link the saved
   *  measurement). */
  pending_quote_token?: string | null
  /** Token of the self-serve quote-request form we offered on the opener —
   *  the `trade_lead_requests.token` behind /quote-request/<token>. Written
   *  by the route (it owns the mint); kept while the thread sits at
   *  offer_form / await_form so the customer's reply is understood in
   *  context. Mirrors PaintingConversationState.pending_form_token. */
  pending_form_token?: string | null
  /** measure_token of an UNMEASURED lead row (Geoscape holds no footprints for
   *  the address). Deliberately separate from pending_quote_token: that one
   *  stays null so no customer surface re-serves a measurement that doesn't
   *  exist, but the tradie's booking notify still needs a handle on the job —
   *  without it the alert linked the bare /dashboard. Tradie-facing only. */
  pending_lead_measure_token?: string | null
  /** How many structures were measured (so a numbered pick can be validated). */
  pending_structure_count?: number | null
  /** 1-based indices already sent to the customer (so "the others" can
   *  compute the complement on a warm 'quoted' thread). */
  last_served_structures?: number[] | null
  /** Trades the customer has explicitly refused in THIS conversation. Set
   *  by the LLM receptionist (lib/sms/llm-receptionist.ts). Once roofing is
   *  here the roofing receptionist never engages again on this thread —
   *  live 2026-07-25: "No i dont want a roofer" re-opened roofing because
   *  looksLikeRoofingEnquiry keyword-matched "roofer" with no negation
   *  model, and the roofing address was then asked three more times.
   *  Additive and ignored by the deterministic path, so turning the LLM
   *  flag off needs no migration and no cleanup. */
  declined_trades?: string[] | null
  /** How many times we have re-asked an unclear booking reply. Bounded at
   *  one: a second unclear answer is still a live lead and is confirmed
   *  rather than dropped (the 2026-07-23 lead-safety rule). */
  booking_reask?: number | null
}

const ANSWERABLE_STEPS: ReadonlySet<RoofingStep> = new Set<RoofingStep>([
  'address',
  'confirm_address',
  'intent',
  'material',
  'material_profile',
  'pitch',
])

export type RoofingTurnDecision =
  // Opener — the route mints the trade_lead_requests token and composes the
  // canonical three-line form offer (buildRoofingFormOffer).
  | { action: 'offer_form'; slots: RoofingSlots }
  // Customer asked for the form — acknowledge and stay put.
  | { action: 'await_form'; slots: RoofingSlots; reply: string }
  // `handoff` — this ask is the END of the address handshake: the budget is
  // spent and the reply PROMISES the customer a human. The route must notify
  // the tradie on it, or we make a promise nobody hears
  // (specs/address-confirm-loop.md req 2).
  | { action: 'ask'; slots: RoofingSlots; step: RoofingStep; reply: string; handoff?: true }
  | { action: 'measure'; slots: RoofingSlots }
  | { action: 'inspection'; slots: RoofingSlots; reason: string }
  // Serve the SAVED measurement for these 1-based structures (null = all).
  | { action: 'send_saved'; slots: RoofingSlots; structureChoices: number[] | null }
  | { action: 'reconfirm'; slots: RoofingSlots }
  | { action: 'cancel'; slots: RoofingSlots }
  | { action: 'booking'; slots: RoofingSlots; confirmed: boolean }
  // A warm 'quoted' thread got a message that is NOT a structure follow-up,
  // a stop, or a fresh roofing enquiry — hand it back to the general dialog
  // (the route returns false) so a new electrical/plumbing question is
  // handled normally instead of being trapped in roofing.
  // `close` (F6): a genuine topic switch to another trade — the route closes
  // the roofing_state so the next message stays with the general dialog instead
  // of re-grabbing roofing. Absent/false on an interrupt/question bail (resume-able).
  | { action: 'passthrough'; slots: RoofingSlots; close?: boolean }

/** Acknowledgement when the customer picks the form. Byte-identical to the
 *  shipped painting wording (painting-receptionist.ts AWAIT_FORM_ACK) — same
 *  standardisation argument as the opener, including its em dash. */
const AWAIT_FORM_ACK =
  "Fill that in whenever you're ready. Your details will be saved for the roofer to review. Or reply here and we can continue by text."
const WRONG_BUILDING_REPROMPT = ADDRESS_REJECTED_REPLY
/** Two wordings, not one: the second unrecognised address answer must not be
 *  answered with byte-identical copy (specs/address-confirm-loop.md req 5).
 *  missBudget('address') is 3, so a miss is only ever 1 or 2 here. */
const ADDRESS_RETRY = [
  "Sorry, I didn't catch a property address there. What's the address? Please include the street number, suburb and postcode.",
  'No worries. Just send the property address on its own, like: 12 Smith St, Surry Hills 2010.',
]
const addressRetry = (misses: number): string =>
  ADDRESS_RETRY[Math.min(Math.max(misses, 1), ADDRESS_RETRY.length) - 1]

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }

/**
 * PURE — parse a structure pick from the customer's reply (1-based),
 * validated against the number of structures offered. Accepts a bare
 * number ("2"), "#2", "number 2", or an ordinal ("the second"). Returns
 * null when there's no valid pick.
 */
export function parseStructureChoice(inbound: string, count: number): number | null {
  const t = (inbound ?? '').toLowerCase()
  // The list we sent NAMES each building ("1) Main dwelling", "2) Secondary
  // structure 1"), so read those names back before falling to digits —
  // otherwise "Main dwelling" is unrecognised and we re-send the same list.
  // Checked first: "secondary structure 1" contains a digit that means
  // something different from a bare "1".
  const secondary = t.match(/secondary\s*(?:structure|building)?\s*#?(\d{1,2})/)
  if (secondary) {
    const n = Number(secondary[1]) + 1 // "secondary structure 1" is entry 2
    if (n >= 1 && n <= count) return n
  }
  // Bare "main" counts as a pick — the list we sent literally says
  // "1) Main dwelling" (live 2026-07-23: "Main" re-sent the identical
  // list). The lookahead keeps street names out: "the one on Main Road"
  // is an address correction, not a pick.
  if (/\bmain\b(?!\s*(?:st\b|street|rd\b|road|ave\b|av\b|avenue|dr\b|drive|hwy\b|highway|pde\b|parade|ln\b|lane|ct\b|court|cres\b|crescent|pl\b|place))/.test(t)) {
    return 1
  }
  // G7 (live 2026-07-25): "just the big one" re-sent the identical list. The
  // list is ordered largest-first with the dwelling at 1, so the size/house
  // words resolve to the primary; a named secondary resolves by label.
  // Gated to a SHORT, non-question reply: without that, "can you send that to
  // my home email instead?" read as a pick and fired a narrowed priced quote.
  const words = t.trim().split(/\s+/).filter(Boolean)
  const picky = !t.includes('?') && words.length <= 6
  if (picky) {
    if (/\b(big|biggest|large|largest|house|home|dwelling|primary)\b/.test(t)) return 1
    const SECONDARY_LABELS = ['shed', 'garage', 'carport', 'granny', 'outbuilding']
    if (count > 1 && SECONDARY_LABELS.some((w) => new RegExp(`\\b${w}\\b`).test(t))) return 2
  }
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

// Words that, after the pick tokens are removed, are "filler" — their
// presence doesn't make a message anything other than a structure pick.
const FOLLOWUP_FILLER =
  /\b(and|the|a|an|number|numbers|no|nos|just|only|please|pls|thanks|thx|ta|too|one|ones|of|me|my|give|send|do|it|its|yes|yep|ok|okay|okey|sure|for|i|id|want|wanna|need|can|could|would|you|get|us|actually|quote|quotes|breakdown|breakdowns|estimate|estimates|pricing|price|prices|about|what|hey|hi|see|show|them|those|these|also)\b/g
// Tokens that ARE a structure pick (numbers, ordinals, building words).
const PICK_TOKENS =
  /#?\d{1,2}|\b(first|second|third|fourth|fifth|all|both|everything|every|others?|rest|remaining|lot|buildings?|structures?|shed|garage|granny|flat|carport|outbuilding|dwelling)\b/g
// A clear structure/roof cue — makes any number a roofing pick even in a
// longer sentence ("give me breakdown for building 2 and 3").
const STRUCTURE_CUE =
  /\b(building|buildings|structure|structures|shed|garage|granny|carport|outbuilding|dwelling|breakdown|re-?roof|roofs?)\b/

/**
 * PURE — parse a MULTI-structure follow-up on a warm 'quoted' thread.
 * Returns 'all' (every structure), an array of 1-based indices, or null
 * when the message isn't a structure ask. `alreadyServed` lets "the
 * others / the rest" compute the complement of what was already sent.
 *
 * CONSERVATIVE on purpose: a bare number / quantifier is only treated as a
 * pick when the message is EITHER a "pure pick" (only pick tokens + filler
 * remain) OR carries an explicit structure cue. So "2 and 3" / "the others"
 * / "both" are picks, but "call me at 2" / "I have 2 dogs" / "both lights
 * please" are NOT — they pass through to the general dialog. This is what
 * stops a warm roofing thread from hijacking an unrelated reply.
 *   • "all" / "all of them" / "everything" / "both" → 'all'
 *   • "the others" / "the rest" / "remaining"       → complement
 *   • "2 and 3" / "2, 3" / "#2 #3" / "second and third" → [2,3]
 *   • "the shed" / "garage" (when >1 structure)     → secondary indices
 */
export function parseStructureFollowup(
  inbound: string,
  count: number,
  alreadyServed?: number[] | null,
): number[] | 'all' | null {
  const t = (inbound ?? '').toLowerCase().trim()
  if (!t || count < 1) return null

  // Gate: a clear structure cue, OR the message is essentially JUST a pick
  // (nothing left after removing pick tokens + filler + punctuation).
  const hasCue = STRUCTURE_CUE.test(t)
  const residue = t
    .replace(PICK_TOKENS, ' ')
    .replace(FOLLOWUP_FILLER, ' ')
    .replace(/[^a-z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const isPurePick = residue.length === 0
  if (!hasCue && !isPurePick) return null

  // "all" — bare "all"/"everything"/"both" are safe here because the gate
  // already rejected sentences with other content ("all good thanks").
  if (/\b(all|all of them|all of it|all of the|everything|all the buildings|all structures|both of them|both buildings|both)\b/.test(t)) {
    return 'all'
  }

  if (/\b(the others?|the rest|remaining|other ones?|other buildings?)\b/.test(t)) {
    const served = new Set(alreadyServed ?? [])
    const rest: number[] = []
    for (let i = 1; i <= count; i++) if (!served.has(i)) rest.push(i)
    return rest.length > 0 ? rest : null
  }

  const nums = new Set<number>()
  for (const mm of t.matchAll(/#?(\d{1,2})/g)) {
    const n = Number(mm[1])
    if (n >= 1 && n <= count) nums.add(n)
  }
  for (const [word, n] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(t) && n <= count) nums.add(n)
  }
  if (nums.size > 0) return [...nums].sort((a, b) => a - b)

  // A bare "shed" / "garage" maps to the secondary structures (2..count).
  if (count > 1 && /\b(shed|garage|granny flat|secondary|outbuilding|carport)\b/.test(t)) {
    const secondary: number[] = []
    for (let i = 2; i <= count; i++) secondary.push(i)
    return secondary
  }

  return null
}

/** How many unrecognised answers a step gets before we stop asking and
 *  route to the on-site inspection. Address gets one extra go: it's the
 *  one answer the customer can always fix by retyping, and the retry
 *  prompt spells out exactly what's needed. */
export function missBudget(step: RoofingStep): number {
  return step === 'address' ? 3 : 2
}

/** PURE — did the customer's answer actually land in the slot we asked
 *  about? A 'no' at confirm_address counts as landed: it's understood, and
 *  it clears the address so we re-ask for a new one. */
function answerLanded(before: RoofingSlots, after: RoofingSlots, step: RoofingStep): boolean {
  switch (step) {
    case 'address':
      return !!after.address
    case 'confirm_address':
      // A correction (new address) or a bare postcode is understood too —
      // it just isn't a "yes". Counting those as misses would spend the
      // budget while the customer is actively fixing the address.
      return (
        after.address_confirmed === true ||
        !after.address ||
        after.address !== before.address ||
        after.postcode !== before.postcode
      )
    case 'intent':
      return !!after.intent
    case 'material':
      // "It's Colorbond" landed even though it named no profile — we now ask
      // WHICH. Counting it as a miss would burn the budget on an answer we
      // actually understood.
      return !!after.material || after.metal_hint === true
    case 'material_profile':
      // Always resolves: a named profile, or 'unknown' → inspection.
      return !!after.material
    case 'pitch':
      return !!after.pitch
    default:
      return true
  }
}

/**
 * PURE — the structures to PERSIST as the confirmed selection when a quote
 * is sent. `null` choices mean the customer took all of them.
 *
 * This must be written to roofing_measurements.included_indices, not left
 * to the `?s=` link: resolveEffectiveIndices only ever NARROWS, falling
 * back to the main-dwelling-only default when included_indices is NULL, so
 * a bare link cannot express "all". Live 2026-07-22: a customer replied
 * YES to 3 buildings, the SMS quoted 2 of them at $115,117, and the linked
 * page showed the main dwelling alone at $69,652.
 */
export function confirmedIncludedIndices(
  structureChoices: number[] | null,
  totalStructures: number,
): number[] {
  if (structureChoices && structureChoices.length > 0) return [...structureChoices]
  return Array.from({ length: Math.max(0, totalStructures) }, (_, i) => i + 1)
}

// ── Cross-step intent detection ─────────────────────────────────────
// The voice agent reasons over the whole conversation every turn; this SMS
// step-machine used to parse ONLY the current step, so a mid-flow address
// change / topic switch / question fell through to the miss→inspection
// fallback (live 2026-07-24: a correction to 999 Archer St while on the
// intent step escalated to an inspection at the STALE 223 address).
const STREET_TYPE =
  /\b(st|street|rd|road|ave|av|avenue|dr|drive|hwy|highway|pde|parade|ln|lane|ct|court|cres|crescent|pl|place|blvd|boulevard|tce|terrace|way|cl|close|circuit|cct|esplanade|esp)\b/
const ADDRESS_CUE = /\b(address|addr)\b/
const CORRECTION_CUE =
  /\b(actually|instead|i meant|i mean|no i|no not|not the|change|changed|wrong|rather|meant to say)\b/
// NOTE: "as well" is deliberately excluded — it is idiomatic for enumerating
// answers ("walls as well as ceilings"), not a topic switch.
const TOPIC_SWITCH =
  /\b(also|another|different job|forget the|instead of the|while you.?re|whilst you.?re|one more thing)\b/
const INTERRUPT =
  /\b(wait|hold on|hang on|one sec|one moment|gimme a|give me a|hold up|stop for a|two secs|two seconds)\b/
const QUESTION_LEAD =
  /^\s*(what|why|how|when|where|which|who|did|do|does|can|could|will|would|is|are|have|has)\b/
// Gather steps that carry a distinct answer (excludes the confirm/profile
// sub-steps) — the out-of-order fold tests the message against these.
// Out-of-order fold considers only these non-address fields (address has its
// own precision-guarded fold in tryAddressFold; the raw address parser here
// would read "2 storeys" as an address).
const OUT_OF_ORDER_STEPS: readonly ('intent' | 'material' | 'pitch')[] = ['intent', 'material', 'pitch']
// Each out-of-order step's OWN target slot, so a fold is judged on that slot
// getting a new value.
const STEP_SLOT: Record<'intent' | 'material' | 'pitch', keyof RoofingSlots> = {
  intent: 'intent',
  material: 'material',
  pitch: 'pitch',
}

const normAddr = (a: string | null | undefined) => (a ?? '').toLowerCase().replace(/\W+/g, '')

/** PURE — a clear address ANYWHERE (a correction or an out-of-order answer),
 *  folded and marked for re-confirmation. High precision: the street-type
 *  test runs on the EXTRACTED address, not the whole message, so "no way to
 *  tell from 2 photos" (the word "way" is in the prefix, not the "2 photos"
 *  match) is NOT read as an address. Returns null when there is no address,
 *  the signal is weak, or it matches the address we already have. */
function tryAddressFold(inbound: string, slots: RoofingSlots): RoofingSlots | null {
  const addr = extractStreetAddress(inbound)
  if (!addr) return null
  const t = (inbound ?? '').toLowerCase()
  // Once the address is confirmed, a bare restatement inside a step answer
  // ("full reroof at 670 London Rd") is NOT a correction — it would clobber
  // the confirmed address with a degraded value and drop the real answer. So
  // a CONFIRMED address is only re-folded on an EXPLICIT correction cue
  // (ADDRESS_CUE or CORRECTION_CUE); while still gathering, a street signal
  // is enough (an out-of-order / volunteered address).
  const streetOnAddr = STREET_TYPE.test(addr.toLowerCase())
  const cue = ADDRESS_CUE.test(t) || CORRECTION_CUE.test(t)
  // A leading negation over a REAL street address is a correction ("no, 12
  // Smith Street"), even without the explicit cue words. Requiring the
  // street signal keeps "no way to tell from 2 photos" ("2 photos" has no
  // street type) from being read as an address.
  const negatedAddr = /^\s*(no|nope|nah|not)\b/.test(t) && streetOnAddr
  // A DIFFERENT full address (street signal AND a postcode) is an unambiguous
  // property change even without a cue word — B1 (live 2026-07-24 S7/S8): at
  // the intent step "ok now price 12 Smith Street Bondi NSW 2026" after 670
  // London Rd was confirmed was NOT folded, so the OLD address got measured.
  // The same-address guard below still blocks a bare/full restatement of the
  // confirmed address (mirrors the 'quoted'-step street+postcode reopen).
  const differentFullAddress = streetOnAddr && !!parsePostcode(inbound)
  const strong = slots.address_confirmed
    ? cue || negatedAddr || differentFullAddress
    : streetOnAddr || cue
  if (!strong) return null
  if (slots.address && normAddr(addr) === normAddr(slots.address)) return null
  const s: RoofingSlots = { ...slots, address: addr, address_confirmed: false }
  const pc = parsePostcode(inbound)
  if (pc) s.postcode = pc
  const st = parseAuState(inbound)
  if (st) s.state = st
  delete s.misses
  return s
}

/** PURE — a topic switch / interrupt / question that the step parser must
 *  NOT try to answer (a loose mapper would mis-commit "also fix a leaking
 *  tap" as a roof leak, or "is it colorbond?" as a material). Checked BEFORE
 *  the parse. A question on the address/confirm_address step is NOT a bail —
 *  re-reading the address back is the natural answer. */
function shouldBailToDialog(inbound: string, lastStep: RoofingStep): boolean {
  const t = (inbound ?? '').toLowerCase()
  const onAddressStep = lastStep === 'address' || lastStep === 'confirm_address'
  const isQuestion = inbound.includes('?') || QUESTION_LEAD.test(t)
  const questionBail = isQuestion && !onAddressStep
  // An INTERRUPT ("wait", "hold on") on the address / confirm_address step is a
  // self-correction, not a topic switch. B3 (live 2026-07-24 S9): "no wait yes"
  // bailed to the general LLM which then asked "quick one, what's your first
  // name?" instead of resolving the address confirmation.
  const interruptBail = INTERRUPT.test(t) && !onAddressStep
  return TOPIC_SWITCH.test(t) || interruptBail || questionBail
}

/** PURE — when the current step's answer did NOT land AND it wasn't an
 *  address / bail, fold a cue-gated correction of a non-address slot or an
 *  out-of-order answer to a not-yet-filled field. Returns the folded slots
 *  or null (fall through to the miss→inspection fallback). */
function crossStepFold(inbound: string, slots: RoofingSlots, lastStep: RoofingStep): RoofingSlots | null {
  const t = (inbound ?? '').toLowerCase()

  // A cue-gated correction of a non-address slot. The mappers are loose
  // (mapMaterial matches bare "tiles", mapIntent matches "cracked"), so a
  // correction word is REQUIRED before trusting them mid-flow.
  if (CORRECTION_CUE.test(t)) {
    const m = mapMaterial(inbound)
    if (m && m !== 'unknown' && m !== slots.material) {
      const s: RoofingSlots = { ...slots, material: m }
      delete s.misses
      delete s.metal_hint
      return s
    }
    const intent = mapIntent(inbound)
    if (intent && intent !== slots.intent) {
      const s: RoofingSlots = { ...slots, intent }
      delete s.misses
      return s
    }
  }

  // Out-of-order answer — a not-yet-asked, still-EMPTY field, answered
  // cleanly. Fold only when the message fills EXACTLY ONE other step's own
  // (currently empty) slot; ambiguous descriptive text ("the tiles are
  // cracked" → material AND intent) fills several and is left to the safe
  // fallback. Empty-only so a description at a later step never overwrites
  // an already-gathered slot (that path is the cue-gated correction above).
  // Address is deliberately excluded — it is handled by tryAddressFold with
  // its precision guard; the raw applyRoofingAnswer('address') parser here
  // would fold "2 storeys" as an address.
  const landed: RoofingSlots[] = []
  for (const step of OUT_OF_ORDER_STEPS) {
    if (step === lastStep) continue
    const key = STEP_SLOT[step]
    if (slots[key] != null) continue // empty-only: a set slot is a correction, not out-of-order
    const applied = applyRoofingAnswer(slots, step, inbound)
    if (applied[key] != null) landed.push(applied) // slot was empty, now filled

  }
  if (landed.length === 1) {
    const s = landed[0]
    delete s.misses
    return s
  }

  return null
}

/**
 * PURE — the customer's inbound to act on this turn. A rapid burst (several
 * inbounds arriving since our last outbound, coalesced by the route's
 * debounce) is joined so the engagement check AND the opener harvest see the
 * WHOLE burst, not just its last line. Live 2026-07-24: "can you do my roof" |
 * "670 London Road Chandler QLD 4155" | "its colorbond" engaged the general
 * LLM instead of roofing because only "its colorbond" was tested. Mirrors the
 * general dialog's own coalescing in app/api/sms/inbound/route.ts.
 */
export function latestInboundBurst(
  turns: ReadonlyArray<{ direction: string; body: string }>,
): string {
  let lastOut = -1
  for (let i = 0; i < turns.length; i++) if (turns[i].direction === 'outbound') lastOut = i
  const pending = turns
    .slice(lastOut + 1)
    .filter((t) => t.direction === 'inbound')
    .map((t) => t.body)
  if (pending.length > 1) return pending.join('\n')
  return pending[0] ?? [...turns].reverse().find((t) => t.direction === 'inbound')?.body ?? ''
}

/**
 * PURE — the two inputs a roofing turn needs from a (possibly coalesced)
 * burst: `engage` is the whole burst so a multi-message opener is seen by the
 * engagement check; `decision` is the whole burst ONLY on a cold start (so a
 * multi-message opener's address/material are harvested) but the NEWEST line
 * alone on an active flow. Live review 2026-07-24: feeding the burst to
 * advanceRoofing on an active flow let a stray digit in an earlier burst line
 * ("1 quick question") hijack a structure pick, and a deny token flip a
 * booking. A closed flow is a cold start (a fresh enquiry restarts).
 */
export function roofingTurnInput(
  prevLastStep: RoofingStep | null | undefined,
  turns: ReadonlyArray<{ direction: string; body: string }>,
): { engage: string; decision: string } {
  const burst = latestInboundBurst(turns)
  const lastLine = [...turns].reverse().find((t) => t.direction === 'inbound')?.body ?? ''
  const coldStart = !prevLastStep || prevLastStep === 'closed'
  // F4 (live 2026-07-24): a burst "opener | 670 London Rd | thanks" while
  // awaiting the address dropped the address because only the last line was
  // tested. When awaiting the address, harvest from the WHOLE burst; the
  // last-line-only rule still protects the pick/booking steps from a stray
  // digit/deny. The deeper webhook/leader-election race (60s inflight-lock
  // debt) is out of scope here.
  const awaitingAddress = prevLastStep === 'address' || prevLastStep === 'confirm_address'
  let decision = coldStart || awaitingAddress ? burst : lastLine
  // F4 recovery net (live 2026-07-24): the burst-race can leave the address in
  // an EARLIER inbound (behind our racy "what's the address?" ask), which
  // latestInboundBurst no longer sees. When awaiting the address and the chosen
  // input has none, recover the most recent address the customer sent that we
  // never READ BACK — so a read-back the customer rejected is not re-harvested.
  if (awaitingAddress && !extractStreetAddress(decision)) {
    const recovered = recoverDroppedAddress(turns)
    if (recovered) decision = recovered
  }
  return { engage: burst, decision }
}

/** An address the customer already saw us respond to — a confirm-step read-back
 *  (confirmAddressQuestion's two wordings) OR a geocoder "can't find it"
 *  rejection (addressNotFoundReply). The F4 recovery net skips these so it never
 *  re-harvests an address the customer rejected OR one the map already refused. */
/** PURE — the most recent inbound carrying a street address that was NEVER read
 *  back to the customer (so never confirmed/rejected). null when there is none.
 *  Recovers an address dropped by the burst/leader race without ever
 *  re-harvesting one the customer already rejected at confirm_address. */
function recoverDroppedAddress(
  turns: ReadonlyArray<{ direction: string; body: string }>,
): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.direction !== 'inbound' || !extractStreetAddress(t.body)) continue
    const readBack = turns
      .slice(i + 1)
      .some((o) => o.direction === 'outbound' && isAddressReadBack(o.body))
    if (!readBack) return t.body
  }
  return null
}

/**
 * PURE — advance the roofing conversation one turn.
 */
export function advanceRoofing(
  prev: RoofingConversationState | null | undefined,
  inbound: string,
  options: { formFirst?: boolean } = {},
): RoofingTurnDecision {
  const rawLastStep = prev?.last_step ?? null
  let slots: RoofingSlots = { ...(prev?.slots ?? {}) }

  // (1) Stop / cancel / opt-out — always honoured first, at any step.
  if (isStopRequest(inbound)) {
    return { action: 'cancel', slots }
  }

  // (2) Awaiting "shall we book the inspection?".
  if (rawLastStep === 'await_booking') {
    // Only an explicit decline closes the thread without notifying the
    // tradie. A question ("what does it cost?"), a proposed time ("Tuesday
    // works"), or anything unclear is a LIVE inspection lead — confirm it
    // so the tradie is notified and a human follows up. The old
    // `isAffirmative && !isNegative` dropped every non-"yes" reply with a
    // dismissive "text us whenever" and no notify (audit 2026-07-23).
    // isStopRequest is handled above, so a genuine opt-out never lands here.
    return { action: 'booking', slots, confirmed: !isNegative(inbound) }
  }

  // (3) Confirmation: replying to "is this your roof?".
  let restartFromConfirm = false
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
    // A CLEAR new address (street number + postcode) means the customer moved
    // to a DIFFERENT property — restart the gather instead of replaying "is
    // this your roof?" for the old measurement. Live 2026-07-24: a confirm_roof
    // reused from a previous session replayed its "3 buildings at 670 London
    // Road" list on a brand-new address. Checked BEFORE the pick parser so
    // "2 Smith St … 2026" isn't misread as structure 2; the postcode
    // requirement keeps a multi-pick ("2 and 3") and an affirmation with a
    // stray number ("yes, built 1990") OUT of the restart. After isNegative so
    // a plain "no" still re-asks.
    const newAddress = !!extractStreetAddress(inbound) && !!parsePostcode(inbound)
    if (newAddress) {
      restartFromConfirm = true
    } else {
      // MULTI-pick first, but ONLY when it names ≥2 structures: "2 and 3"
      // must serve both. The single-pick parser's digit regex grabs the
      // FIRST number, so running it first silently narrowed "2 and 3" to
      // structure 2 — the customer read the price as covering two buildings
      // (money bug, same class as the 2026-07-22 included_indices fix; the
      // warm 'quoted' step below already parsed multi-picks correctly).
      // Single-result parses still fall through to parseStructureChoice,
      // which alone knows "secondary structure 1" means ENTRY 2.
      const multi = parseStructureFollowup(inbound, count)
      if (count > 1 && Array.isArray(multi) && multi.length > 1) {
        return { action: 'send_saved', slots, structureChoices: multi }
      }
      const choice = parseStructureChoice(inbound, count)
      if (choice != null && count > 1) {
        return { action: 'send_saved', slots, structureChoices: [choice] }
      }
      // The confirm prompt offers "all" (and the page says so) — accept it.
      if (count > 1 && multi === 'all') {
        return { action: 'send_saved', slots, structureChoices: null }
      }
      // An affirmation WINS over a roofing keyword: "yeah do the re-roof" is a
      // YES, not a request to start over — serve the saved measurement.
      if (isAffirmative(inbound)) {
        return { action: 'send_saved', slots, structureChoices: null }
      }
      // Only now, once yes / picks have had their say, does a fresh roofing
      // enquiry with no postcode ("quote a new roof at 5 Green St") restart —
      // a keyword the confirm step would otherwise replay over.
      if (looksLikeRoofingEnquiry(inbound)) {
        restartFromConfirm = true
      } else {
        return { action: 'reconfirm', slots }
      }
    }
  }

  // (3.5) Warm 'quoted' thread — a quote was already sent. A structure
  // follow-up ("give me 2 and 3", "the others", "all of them") re-serves
  // the SAVED measurement; a fresh roofing enquiry reopens; anything else
  // is handed back to the general dialog (never trapped, never re-quoted).
  if (rawLastStep === 'quoted') {
    const count = prev?.pending_structure_count ?? 1
    const picks = parseStructureFollowup(inbound, count, prev?.last_served_structures ?? null)
    if (picks === 'all') return { action: 'send_saved', slots, structureChoices: null }
    if (picks && picks.length > 0) return { action: 'send_saved', slots, structureChoices: picks }
    // Not a structure ask. A fresh roofing enquiry OR a NEW address (street +
    // postcode) reopens the flow to quote that property; everything else goes
    // back to the general dialog. The new-address arm is the fix for live
    // 2026-07-24: after a 670 London Rd quote the customer sent "Ok can you
    // price 652 London Rd Chandler QLD 4155" — no roof keyword, so it passed to
    // the general LLM, which faked "pulling up the property details" and never
    // measured 652. The postcode requirement keeps a bare follow-up ("6
    // downlights") from reopening. Same signal as the confirm_roof restart.
    const newAddress = !!extractStreetAddress(inbound) && !!parsePostcode(inbound)
    // G10 (live 2026-07-25): a post-quote QUESTION ("does that price include the
    // gutters?") contains a roofing keyword, so it fell through to the reset and
    // RESTARTED the gather ("What's the property address?") on a customer who
    // already has a quote. A question is never a new job: hand it to the general
    // dialog, which answers it. Only a NEW address or a keyword enquiry that is
    // not a question reopens.
    // Only a question ABOUT the quote we just sent (anaphoric "that price",
    // "does that include…") passes through; "can you quote another re-roof" is
    // a genuine new job and still reopens.
    const lower = (inbound ?? '').toLowerCase()
    const isQuestion = inbound.includes('?') || QUESTION_LEAD.test(lower)
    // Anaphora ONLY. A bare include/cover arm swallowed genuine new jobs
    // ("can you quote a new roof, does that include gutters?") and the
    // passthrough CLOSES a quoted thread, killing the lead.
    const aboutSentQuote =
      /\b(that|this|it|the)\s+(price|quote|estimate|total|cost|figure|number)\b/.test(lower) ||
      /\bdoes\s+(that|this|it)\b/.test(lower)
    // A post-quote question that ASKS ABOUT US rather than requesting more work
    // is not a new job either. anaphora alone was too narrow: "Are you doing
    // roofing?" names a roofing keyword, carries no "that price" anaphora, and
    // so fell through to the reset and RESTARTED the gather on a customer who
    // already held a quote — then the LLM turned that reopened gather into a
    // fresh measurement (live 2026-08-07, QM Sparky, token 8b63913e).
    //
    // The separator is a NEW-JOB cue, not the question mark: "can you quote
    // another re-roof" and "how much for the garage?" ask for more work and
    // still reopen; "are you doing roofing?", "do you do roofing?" do not.
    const newJobCue =
      /\b(another|second|also|next|different|other|additional)\b/.test(lower) ||
      /\b(quote|price[sd]?|pricing|estimate|cost)\b/.test(lower) ||
      /\bhow much\b/.test(lower)
    const askingAboutUs = isQuestion && !newJobCue
    // A CORRECTION names the trade it is REJECTING, so it carries a roofing
    // keyword and reads as a fresh roofing enquiry. "Lets do painting its
    // painting not roofing mate" therefore reopened the gather (live
    // 2026-08-07, token 268266af). The front desk now routes that turn to
    // painting before we ever see it — this is the second line, so one router
    // slip cannot re-trap the customer in a trade they just refused.
    //
    // Strip ONLY the negated mention and re-test: if what remains is no longer
    // a roofing enquiry, the roof word was the thing being rejected. "no roof
    // leaks but I want a re-roof quote" still keeps "re-roof" and reopens.
    const roofNegationStripped = inbound.replace(
      /\b(?:not|no|isn'?t|aint|ain't)\s+(?:the\s+|a\s+)?roof\w*/gi,
      ' ',
    )
    const correctedAwayFromRoofing =
      roofNegationStripped !== inbound && !looksLikeRoofingEnquiry(roofNegationStripped)
    if (
      (!looksLikeRoofingEnquiry(inbound) && !newAddress) ||
      (isQuestion && aboutSentQuote && !newAddress) ||
      (askingAboutUs && !newAddress) ||
      (correctedAwayFromRoofing && !newAddress)
    ) {
      return { action: 'passthrough', slots }
    }
    // falls through to the reset below → gather a fresh roofing quote.
  }

  // (4) Closed/quoted flow — a fresh enquiry restarts from scratch. A
  // confirm_roof the customer abandoned for a new property (restartFromConfirm)
  // resets here too, then falls into the opener-harvest below.
  let lastStep: RoofingStep | null = rawLastStep
  if (rawLastStep === 'closed' || rawLastStep === 'quoted' || restartFromConfirm) {
    slots = {}
    lastStep = null
  }

  // (4.5) Replying to the form offer. An EXPLICIT form cue parks the thread
  // at await_form; anything else — including a decline that already carries
  // the address ("nah just ask, it's 12 Smith St Bondi 2026") — falls through
  // to the opener harvest below and starts the Q&A gather with whatever they
  // just told us, so nothing is asked for twice. Same rule as painting.
  // 'await_form' also falls through: a customer who texts instead of filling
  // the form is switched to Q&A.
  if (lastStep === 'offer_form' && customerWantsForm(inbound)) {
    return { action: 'await_form', slots, reply: AWAIT_FORM_ACK }
  }

  // (5) Gathering inputs. Adaptive, not a rigid script (2026-07-24):
  //   a. A clear address ANYWHERE wins first — even over an interrupt word
  //      ("wait, change it to 999 X St") — so a correction is never lost.
  //   b. A topic switch / interrupt / question then bails to the general LLM
  //      dialog BEFORE the loose parser can mis-commit it.
  //   c. Otherwise parse the step; a not-landed answer may still be a
  //      cue-gated correction or an out-of-order answer (crossStepFold).
  let nextSlots = slots
  if (lastStep && ANSWERABLE_STEPS.has(lastStep)) {
    const addrFold = tryAddressFold(inbound, slots)
    if (addrFold) {
      nextSlots = addrFold
    } else if (lastStep === 'confirm_address' && rejectsReadBack(inbound)) {
      // The customer rejected the read-back and gave us no replacement (a
      // correction carries a street address and was folded above). Consume it
      // through the SHARED budget so the handshake cannot run forever: live
      // 2026-08-07 four rejections in one thread changed nothing at all
      // (specs/address-confirm-loop.md).
      const r = consumeAddressRejection(slots)
      // `handoff` must survive: its reply tells the customer a human will
      // confirm the property, and the route fires the tradie notify on it.
      return {
        action: 'ask',
        slots: r.slots,
        step: r.step,
        reply: r.reply,
        ...(r.handoff ? { handoff: true as const } : {}),
      }
    } else if (namesOtherTrade(inbound)) {
      // Round 5 — the customer named another trade. Hand this TURN to the
      // general dialog without counting a miss, which is what fired a roofing
      // inspection for an electrical enquiry. Deliberately NOT a close: closing
      // wipes the gather (confirmed address included), and any false positive
      // would destroy a live lead. Leaving the state intact means a false
      // positive costs one turn, and the customer's next roofing answer resumes.
      return { action: 'passthrough', slots }
    } else if (isGreetingOnly(inbound) && lastStep !== 'confirm_address') {
      // A pleasantry is not an answer, but it is not a failed answer either —
      // re-ask the pending question without spending the miss budget.
      //
      // confirm_address is EXCLUDED: there the free re-ask is a verbatim
      // repeat of the read-back with no budget spent, which is exactly the
      // 2026-08-07 loop ("Hi Mate" answered with the same sentence). It falls
      // through to the miss path below, which re-asks in different words and
      // escalates (specs/address-confirm-loop.md req 4).
      const q = nextRoofingStep(slots)
      return q.step === 'ready' || q.step === 'inspection'
        ? { action: 'passthrough', slots }
        : { action: 'ask', slots, step: q.step, reply: q.question ?? '' }
    } else if (shouldBailToDialog(inbound, lastStep)) {
      // F6 — a genuine topic switch to another trade closes the gather; an
      // interrupt/question is resume-able, so it leaves the state alone.
      return { action: 'passthrough', slots, close: TOPIC_SWITCH.test((inbound ?? '').toLowerCase()) }
    } else {
      nextSlots = applyRoofingAnswer(slots, lastStep, inbound)

      // The answer didn't fit THIS step — it may still be a cue-gated correction
      // or an out-of-order answer to another (empty) field. Harvest it, but the
      // step we ASKED may STILL be unanswered afterward.
      if (!answerLanded(slots, nextSlots, lastStep)) {
        const fold = crossStepFold(inbound, slots, lastStep)
        if (fold) nextSlots = fold
      }

      if (answerLanded(slots, nextSlots, lastStep)) {
        // The asked step is answered — clear the counter so misses never
        // accumulate across steps (one bad material answer must not shorten the
        // pitch budget).
        delete nextSlots.misses
      } else {
        // F7/F13 (live 2026-07-24): the step we ASKED is STILL unanswered, even
        // if a fold harvested a DIFFERENT slot out of order. Count the miss so
        // we don't re-ask the identical question forever ("What do you need
        // done?" looped while the customer answered material/pitch); at the
        // budget, set the 'unknown' sentinel / route to inspection — the same
        // safe fallback the rest of the flow uses when it can't price.
        const misses = (slots.misses ?? 0) + 1
        if (misses >= missBudget(lastStep)) {
          delete nextSlots.misses
          if (lastStep === 'material') nextSlots.material = 'unknown'
          else if (lastStep === 'pitch') nextSlots.pitch = 'unknown'
          else if (lastStep === 'intent') nextSlots.intent = 'unknown'
          // Address is different: with no usable address there is nothing to
          // measure AND nothing to put on a job sheet, so hand the lead to the
          // tradie directly rather than pretending we can quote it.
          else {
            return {
              action: 'inspection',
              slots: nextSlots,
              reason: "we couldn't confirm the property address",
            }
          }
        } else {
          nextSlots = { ...nextSlots, misses }
          // An address answer that didn't parse as an address → clarify, don't
          // store junk (and don't silently re-send the same prompt).
          if (lastStep === 'address') {
            return { action: 'ask', slots: nextSlots, step: 'address', reply: addressRetry(misses) }
          }
          // Same rule at the read-back: re-ask in DIFFERENT words. Repeating
          // confirmAddressQuestion here is the loop itself.
          if (lastStep === 'confirm_address' && nextSlots.address) {
            return {
              action: 'ask',
              slots: nextSlots,
              step: 'confirm_address',
              reply: addressRecheckQuestion(nextSlots.address),
            }
          }
        }
      }
    }
  } else {
    // ── Harvest the OPENING message ──────────────────────────────────
    // We are not answering a question we asked, so read whatever the
    // customer volunteered. This branch used to take only the intent and
    // the build year, which is why an address given up front was asked
    // for a second time. Observed live (tenant "Ricardos Roofing"):
    //   CUSTOMER: "I am looking to get a new roof at 670 London road Chandler"
    //   BOT:      "Happy to sort a roofing quote for you. What's the
    //              property address, including suburb and postcode?"
    // Everything harvested here is still READ BACK once for confirmation
    // (address_confirmed stays false), so a mis-parse costs one "no",
    // never a wrong quote.
    if (!nextSlots.intent) {
      const intent = mapIntent(inbound)
      if (intent) nextSlots.intent = intent
    }
    if (!nextSlots.address) {
      const addr = extractStreetAddress(inbound)
      if (addr) {
        nextSlots.address = addr
        const pc = parsePostcode(inbound)
        if (pc) nextSlots.postcode = pc
        const st = parseAuState(inbound)
        if (st) nextSlots.state = st
        nextSlots.address_confirmed = false
      }
    }
    if (!nextSlots.material) {
      // Only a POSITIVE match counts. mapMaterial returns null for a bare
      // "Colorbond"/"metal" (profile unknown) and we mirror the material
      // step by recording the hint instead, so the profile question is
      // asked rather than a profile being guessed.
      const m = mapMaterial(inbound)
      if (m) nextSlots.material = m
      else if (isAmbiguousMetal(inbound)) nextSlots.metal_hint = true
    }
    if (!nextSlots.commercial && looksCommercial(inbound)) {
      // R5 — a commercial roof must not be auto-quoted on the residential card.
      nextSlots.commercial = true
    }
    if (!nextSlots.pitch) {
      // R1 (live 2026-07-25): a one-shot brief ("full reroof at 670 London Rd,
      // colorbond corrugated, standard pitch") had its pitch ignored and re-asked.
      const p = mapPitch(inbound)
      if (p) nextSlots.pitch = p
    }
    if (nextSlots.year_built == null) {
      const y = parseYearBuilt(inbound)
      if (y != null) nextSlots.year_built = y
    }
  }

  // ── The opener (spec: specs/generic-quote-request-form.md §4) ──────────
  // A FRESH enquiry — a cold thread, or one reset above by a fresh enquiry on
  // a closed / quoted / abandoned-confirm flow — is answered with the
  // self-serve form offer, not the address question. The route mints the
  // trade_lead_requests row and composes the three-line message.
  //
  // The harvest above still runs first and its slots ride along, so a one-shot
  // brief ("full reroof at 670 London Rd Chandler QLD 4155, colorbond
  // corrugated, standard pitch") is NOT thrown away: the moment the customer
  // replies anything other than "send the form", the gather resumes from an
  // already-complete brief and measures without re-asking a thing.
  if (lastStep === null && options.formFirst) return { action: 'offer_form', slots: nextSlots }

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
 *   inspection → park at await_booking (waiting for "yes book it").
 *                NOTE: this pure arm nulls pending_quote_token because the
 *                decision doesn't carry it; the ROUTE persists its own
 *                explicit state for the measure-path inspection park and
 *                KEEPS the token there (US-002 booking-notify link) — same
 *                route-owned-state carve-out as send_saved below.
 *   send_saved → quoted (WARM — a structure follow-up re-serves the saved
 *                measurement; the route preserves pending_quote_token +
 *                pending_structure_count, which this pure fn doesn't own)
 *   passthrough→ stays quoted (route returns false; no persist)
 *   cancel     → closed
 *   booking    → closed
 */
export function nextRoofingConversationState(
  decision: RoofingTurnDecision,
): RoofingConversationState {
  switch (decision.action) {
    case 'offer_form':
      // The ROUTE persists its own shape here — it owns the minted
      // pending_form_token, which this pure fn never sees. Same
      // route-owned-state carve-out as measure / send_saved.
      return { slots: decision.slots, last_step: 'offer_form', pending_quote_token: null, pending_structure_count: null }
    case 'await_form':
      return { slots: decision.slots, last_step: 'await_form' }
    case 'ask':
      return { slots: decision.slots, last_step: decision.step, pending_quote_token: null, pending_structure_count: null }
    case 'measure':
    case 'reconfirm':
      return { slots: decision.slots, last_step: 'confirm_roof' }
    case 'inspection':
      return { slots: decision.slots, last_step: 'await_booking', pending_quote_token: null, pending_structure_count: null }
    case 'send_saved':
      return { slots: decision.slots, last_step: 'quoted', last_served_structures: decision.structureChoices }
    case 'passthrough':
      return { slots: decision.slots, last_step: 'quoted' }
    case 'cancel':
    case 'booking':
      return { slots: decision.slots, last_step: 'closed', pending_quote_token: null, pending_structure_count: null }
  }
}

/** Idle beyond this and a parked roofing flow is stale. The route reuses a
 *  conversation for up to REUSE_OPEN_WINDOW_MS (4h); expiring the roofing flow
 *  at 1h means a customer who walked away starts fresh next time instead of
 *  resuming a measurement from a PREVIOUS session. Live 2026-07-24: a
 *  confirm_roof reused hours later replayed "3 buildings at 670 London Road"
 *  on the next "Hi Mate", then again on a new address, then on "Hey". */
export const ROOFING_STALE_IDLE_MS = 60 * 60 * 1000

/** ONLY these steps REPLAY a saved measurement on resume, so ONLY these go
 *  stale: confirm_roof re-sends "is this your roof? N buildings…", and the
 *  warm 'quoted' thread re-serves the saved quote on a structure follow-up.
 *  await_booking / await_form / mid-gather do NOT replay — resuming them is
 *  correct, and expiring await_booking would DROP a genuine late "yes book
 *  it" (no booking, no tradie notify), undoing the 2026-07-23 lead-safety
 *  hardening. So they are deliberately excluded. */
const ROOFING_STALE_REPLAY_STEPS: ReadonlySet<RoofingStep> = new Set<RoofingStep>([
  'confirm_roof',
  'quoted',
  // F8 (live 2026-07-24): a mid-gather flow resumed hours later measured the
  // STALE address ("223 Archer St" typed, 670 London Rd quoted). A half-finished
  // gather is stale too — expire it so the thread starts fresh. await_booking
  // stays EXCLUDED (a late "yes book it" must still book, per the note above);
  // ready/inspection/closed are terminal / transient.
  'address',
  'confirm_address',
  'intent',
  'material',
  'material_profile',
  'pitch',
])

/** PURE — a roofing flow parked on a stale-replay step (confirm_roof / quoted)
 *  and idle for longer than ROOFING_STALE_IDLE_MS is stale: return the closed
 *  state to persist (so the route handles the new message fresh), or null when
 *  there's nothing to expire (a non-replay step, closed/empty, or still within
 *  the window). `idleMs` is the age of the conversation's last activity,
 *  supplied by the route. Mirrors closeStaleRoofingState's closed shape. */
export function expireIdleRoofingState(
  prev: RoofingConversationState | null | undefined,
  idleMs: number,
): RoofingConversationState | null {
  const step = prev?.last_step ?? null
  if (!step || !ROOFING_STALE_REPLAY_STEPS.has(step)) return null
  if (idleMs < ROOFING_STALE_IDLE_MS) return null
  return {
    slots: {},
    last_step: 'closed',
    pending_quote_token: null,
    pending_structure_count: null,
    // A refusal outlives the gather it interrupted. Expiring the flow but
    // FORGETTING the refusal put the original bug straight back: the same
    // conversation (reusable for 4h) would keyword-match "roofer" in the
    // customer's next complaint and re-ask the address they already declined.
    ...(prev?.declined_trades ? { declined_trades: prev.declined_trades } : {}),
  }
}

/** PURE — US-006: the tenant just turned roofing OFF while this thread was
 *  mid-flow. Return the closed state to persist, or null when there's
 *  nothing to close. Without this, a conversation parked at confirm_roof /
 *  await_booking was orphaned: the general dialog inherited a warm
 *  roofing_state it cannot speak to, and re-enabling roofing later resumed
 *  a zombie flow (audit 2026-07-23). */
export function closeStaleRoofingState(
  prev: RoofingConversationState | null | undefined,
): RoofingConversationState | null {
  if (!isActiveRoofingFlow(prev)) return null
  return {
    slots: {},
    last_step: 'closed',
    pending_quote_token: null,
    pending_structure_count: null,
    // Same reasoning as expireIdleRoofingState — a refusal is not part of
    // the gather being closed.
    ...(prev?.declined_trades ? { declined_trades: prev.declined_trades } : {}),
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

/** PURE — must this turn run the DETERMINISTIC machine even when the LLM
 *  receptionist flag is on? Exactly the two turns painting pre-empts
 *  (paintingTurnIsDeterministic), for the same reason:
 *    • the opener — the canonical three-line form offer must go out on BOTH
 *      paths, or the two layers open differently and the spec's
 *      "byte-identical across trades" guarantee holds only when the flag is
 *      off. A model asked to greet does not mint a token;
 *    • an explicit "use the form" reply parked at offer_form — it must resolve
 *      to await_form with the standard acknowledgement.
 *  Everything else stays with whichever layer the flag picks. */
export function roofingTurnIsDeterministic(
  prev: RoofingConversationState | null | undefined,
  inbound: string,
): boolean {
  if (!isActiveRoofingFlow(prev)) return true
  return prev?.last_step === 'offer_form' && customerWantsForm(inbound)
}

/** PURE — should the roofing receptionist engage this turn?
 *
 *  Normally it engages when the thread is already an active roofing flow
 *  (mid-gather / awaiting a reply) OR the inbound reads like a fresh roofing
 *  enquiry. But when a follow-up pin is active on the thread — the tradie
 *  just chased a DIFFERENT quote (e.g. Ceiling Fans) — a stale roofing_state
 *  left on the shared phone thread must NOT resume: an affirmative reply to
 *  the follow-up ("Yes") would otherwise be hijacked into "how steep is the
 *  roof?". With a pin active, only a genuinely NEW roofing enquiry may
 *  engage; a stale-state resume falls through to the general dialog, which
 *  honours the pin. (Spec 2026-07-05 Part A2.) */
export function shouldEngageRoofing(
  prev: RoofingConversationState | null | undefined,
  inbound: string,
  followupPinActive: boolean,
  /** This tenant does roofing and NOTHING else (trades === ['roofing']).
   *  See the note below — for these tenants the keyword test is skipped. */
  roofingOnly = false,
  /** Phase: close the hijack class. True when the general dialog has already
   *  gathered a TRADE-SPECIFIC slot from this thread's transcript. Gates the
   *  KEYWORD arm only — see the note there. Defaults false so every existing
   *  caller and test behaves exactly as before. */
  generalMidGather = false,
): boolean {
  // A trade the customer has already turned down is never asked about
  // again in this conversation. Checked FIRST, ahead of every engage arm:
  // the refusal itself carries the roofing keyword ("no i dont want a
  // roofer"), so a later arm would otherwise re-open the very flow the
  // customer just declined (live 2026-07-25, QM Sparky).
  if ((prev?.declined_trades ?? []).includes('roofing')) return false
  const canResume = isActiveRoofingFlow(prev) && !followupPinActive
  if (canResume) return true
  // A FRESH KEYWORD MUST NOT OUTRANK A GATHER ALREADY IN PROGRESS.
  //
  // This is the structural half of the 2026-07-31 failure (conversation
  // b2625cbe, Atomic Electrical). The general dialog had gathered
  // count=16/room=patio/job_type=downlights from the transcript and asked
  // "what's the ceiling type — flat, raked, cathedral, or sheet metal?". The
  // customer answered "It's a 125mm insulated panel roofing", the bare
  // substring 'roofing' matched here, and this receptionist engaged COLD on an
  // electrical job — then kept the thread via canResume above for nine more
  // messages, telling an electrical customer a roofer would call.
  //
  // The vocabulary fix for that specific phrase shipped separately. It does not
  // close the class: four such patches are already recorded in roofing-intake.ts
  // (22, 24, 25 July, 3 August), each for a new word. Only this guard changes
  // the shape of the problem.
  //
  // SCOPED TO THIS ARM DELIBERATELY:
  //   · canResume above is untouched — a genuine roofing thread must still
  //     resume across turns.
  //   · the roofingOnly arm below is untouched — a roofing-only tenant has no
  //     other trade to route to and needs no keyword.
  //
  // THE TRADE-OFF, stated because it is real: a customer mid-electrical-gather
  // who genuinely adds "and can you quote my roof" now stays with the general
  // dialog instead of switching. That loses a roofing upsell on a live thread.
  // Accepted, because the alternative is what actually happened — quoting the
  // wrong trade, ignoring the customer four times, and offering a $99 roofing
  // inspection for a downlight job. A missed upsell is recoverable; that is not.
  if (!generalMidGather && looksLikeRoofingEnquiry(inbound)) return true
  // SINGLE-TRADE ROOFING TENANT — no keyword required.
  //
  // The keyword test exists to ROUTE BETWEEN trades on a cross-trade
  // tenant (Atomic Electrical does electrical + roofing, so "the downlight
  // flickers" must reach the electrical dialog). A roofing-only tenant has
  // nothing to route to: every customer who texts them wants a roof
  // quoted, and the only other handler is the electrical/plumbing dialog,
  // which will happily start an electrical intake for a roofing company.
  //
  // Observed live: "Bills roofing" (trades = ['roofing']) received "test
  // from owner" and the general dialog answered it. No keyword, so no
  // roofing receptionist, so no measurement — for a business that does
  // nothing but roofs. Openers like "hi", "how much for my place?" or "can
  // you help?" fail the same way.
  //
  // The pin still wins: if the tradie just chased a different quote on this
  // thread, let the general dialog honour it.
  return roofingOnly && !followupPinActive
}
