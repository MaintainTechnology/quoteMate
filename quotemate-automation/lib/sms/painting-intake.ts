// ════════════════════════════════════════════════════════════════════
// SMS painting receptionist — pure intake state machine.
//
// Painting runs a self-contained property-data → area → price pipeline
// (lib/painting/*) that is NOT the electrical/plumbing intake→estimate
// flow, and is NOT the strict-grounding Opus estimator. So over SMS we
// gather the SAME inputs the dashboard "Paint estimate" form collects
// (app/dashboard/painting/page.tsx) with a deterministic question-asker
// rather than the elec/plumbing Sonnet dialog. Deterministic = unit-
// testable + can't drift the money path. This mirrors the roofing slice
// (lib/sms/roofing-intake.ts) one-for-one.
//
// The crux is plain-language mapping: a homeowner says "walls and
// ceilings", "two coats", "already painted, just tired", "single storey"
// — not 'walls'/'ceilings', 2, 'sound', 1. We map those words to the
// PaintInputs the estimate endpoint expects.
//
// We pre-empt the on-site inspection on exactly the customer-declarable
// triggers the deterministic pricer (lib/painting/pricing.ts
// requiresInspection) routes to inspection anyway — poor substrate,
// raked/cathedral ceilings, and 3+ storeys — so we don't waste a lookup
// and we set the right expectation early. The remaining inspection gates
// (no floor area found, pre-1970 exterior lead risk, low-confidence area)
// are provider-derived and fire at estimate time in the route.
//
// Floor area IS asked over SMS (form parity, 2026-08-05) — once, and it is
// optional: a plausible number (1–2000 m²) fills `manual_floor_area_m2`,
// anything else (including "not sure") records the skip as null and the
// estimate defaults to the "Other tools" path (Google Solar footprint →
// Geoscape / floor plan), so the address lookup supplies the area exactly
// as before. Tri-state: undefined = not asked yet, null = asked and
// skipped, number = customer-stated.
//
// PURE — no I/O, no SDK. Fully unit-tested.
// ════════════════════════════════════════════════════════════════════

// One shared vocabulary for the address handshake — the elongation-aware
// affirm and the "deny word OR negation cue" rejection test. Pure regex
// helpers, no roofing coupling (painting-receptionist already borrows
// extractStreetAddress from the same module).
import { isAffirmative as isAffirmativeStrict, rejectsReadBack } from './roofing-intake'
import type {
  CeilingHeight,
  PaintAddressInput,
  PaintCondition,
  PaintScope,
} from '@/lib/painting/types'
import type { EstimateRequest } from '@/lib/painting/request-schema'

export type AuState = PaintAddressInput['state']

/** Accumulated painting inputs gathered across SMS turns. Persisted on
 *  sms_conversations.painting_state (jsonb), decoupled from the
 *  electrical/plumbing conversation_state.slots and the roofing_state. */
export type PaintingSlots = {
  address?: string | null
  postcode?: string | null
  state?: AuState | null
  /** Customer confirmed the address we read back is correct. */
  address_confirmed?: boolean
  /** The exact address string that already passed the map check —
   *  screenConfirmAddress skips re-verifying it. */
  addr_verified?: string | null
  /** How many supplied addresses the map couldn't find. Bounded by
   *  MAX_ADDRESS_VERIFY_REJECTS, then we fall back to the plain
   *  read-back so an unmapped new estate can still push through. */
  addr_verify_misses?: number
  /** How many times the CUSTOMER rejected the read-back, and how many replies
   *  to it were neither yes nor no. Both ride in painting_state.jsonb and are
   *  bounded by MAX_ADDRESS_VERIFY_REJECTS — painting had NEITHER counter, so
   *  the bound could never fire on this trade even though the incident state
   *  was painting_state (specs/address-confirm-loop.md req 1 + 2). */
  addr_confirm_rejects?: number
  addr_confirm_misses?: number
  /** Which surfaces to paint — at least one once gathered. */
  scopes?: PaintScope[] | null
  coats?: 1 | 2 | 3 | null
  condition?: PaintCondition | null
  ceiling_height?: CeilingHeight | null
  storeys?: 1 | 2 | 3 | null
  /** Tri-state: undefined = not asked yet, then true / false once asked. */
  colour_change?: boolean
  /** Optional, asked once. Tri-state: undefined = not asked yet, null =
   *  asked and skipped (the address lookup supplies the area), number =
   *  customer-stated m². */
  manual_floor_area_m2?: number | null
}

/** Which input the receptionist is currently gathering. */
export type PaintingStep =
  | 'address'
  | 'confirm_address'
  // Postcode + state, asked only when they weren't in the address line
  // (PaintAddressSchema requires a 4-digit postcode and an AU state).
  | 'location'
  | 'scopes'
  | 'coats'
  | 'condition'
  | 'ceiling_height'
  | 'storeys'
  // Optional floor-area ask (form parity) — after storeys, before
  // colour_change so the "Last one —" wording on colour_change stays true.
  | 'floor_area'
  | 'colour_change'
  | 'ready'
  | 'inspection'
  // ── Lifecycle states the route drives (Phase 2); not produced by
  //    nextPaintingStep, kept here so the persisted state column is typed.
  // The customer was offered the self-serve form link and we're waiting
  // to hear whether they'll use it or answer the questions here.
  | 'offer_form'
  // The customer chose the form link; the form POST produces the quote
  // out-of-band, and a later text switches them back to the questions.
  | 'await_form'
  // After an inspection route, waiting for the customer to confirm the
  // on-site visit.
  | 'await_booking'
  // Quote sent + confirmed; the thread stays warm for a follow-up.
  | 'quoted'
  // Conversation finished (cancelled or booked).
  | 'closed'

const AU_STATES: readonly AuState[] = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT']

// ── Intent detection ──────────────────────────────────────────────────

/**
 * PURE — does this message read like a painting enquiry? Used to branch
 * the SMS receptionist into the painting flow. We deliberately DON'T
 * poach a roofing repaint/restoration job: any message that mentions the
 * roof is left to the roofing receptionist (the route checks roofing
 * first), so "repaint the roof" → roofing, "repaint the house" → painting.
 */
export function looksLikePaintingEnquiry(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  // Roof work — even "paint the roof" — belongs to the roofing slice.
  if (/\broof/.test(t)) return false
  // Round 5 (live 2026-07-25, QM Sparky): "You do paint?" is a QUESTION, not a
  // job request, and it started a painting intake + form link. A bare question
  // about whether we offer painting is answered by the general dialog; only a
  // request ("quote my painting", "need my walls painted") engages the flow.
  // ONLY the bare capability question ("you do paint?", "do you do painting?")
  // is handed to the dialog to be answered. Deliberately narrow: a broader
  // "question without a target" rule dropped genuine leads such as "how much
  // for painting?" and "can you paint kitchen cupboards?", and on a warm quoted
  // thread it closed the conversation, losing an upsell.
  if (/^\s*(so\s+)?(do|does)?\s*(you|yous|u|ya)\s*(guys\s*)?(do|offer)?\s*(re-?)?paint\w*\s*\??\s*$/.test(t)) {
    return false
  }
  return /\bre-?paint(?:s|ing)?\b|\bpaints?\b|\bpainting\b|\bpainter\b|\bpainted\b|\bpaintwork\b|\bcoat of paint\b|\bfeature wall\b|\bunder-?coat\b/.test(
    t,
  )
}

// ── Affirmation / negation / unsure / stop ────────────────────────────

const AFFIRM = /\b(yes|yep|yeah|yup|correct|right|that'?s right|that'?s it|confirmed|sure|ok|okay|👍)\b/
const DENY = /\b(no|nope|nah|wrong|incorrect|not right|different)\b/
const UNSURE = /\b(not sure|unsure|no idea|dunno|don'?t know|do not know|no clue|couldn'?t say|hard to say|you (decide|choose|pick)|whatever you (reckon|recommend|think)|your call)\b/

export function isAffirmative(text: string): boolean {
  return AFFIRM.test((text ?? '').toLowerCase())
}
export function isNegative(text: string): boolean {
  return DENY.test((text ?? '').toLowerCase())
}

// Checked FIRST on every turn so the customer can always bail. Bare "no"
// is NOT a stop (it's a valid confirm answer); explicit stop words and
// clear frustration are.
const STOP_RE = /\b(stop|cancel|cancelled|unsubscribe|quit|end this|end the|not interested|leave me alone|go away|never ?mind|forget it)\b/
const FRUSTRATION_RE = /\b(f+u+c+k+|f\*+ck|fck|stfu|piss off|bugger off|bullsh|shut up)\b/
// F11 (shared shape) — "stop"/"end" a leak is a roofing/plumbing outcome the
// customer wants, not a request to end the conversation. Carve it out first.
const STOP_OUTCOME = /\b(stop|end)\b(?:\s+\w+){0,3}\s+(leak\w*|drip\w*|water|rain\w*)\b/

/** PURE — true when the customer wants to stop / cancel / opt out. */
export function isStopRequest(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  if (STOP_OUTCOME.test(t)) return false
  return STOP_RE.test(t) || FRUSTRATION_RE.test(t)
}

// ── Address parsing ───────────────────────────────────────────────────

/** PURE — pull a 4-digit AU postcode if present. AU addresses end with
 *  the postcode, so when several 4-digit groups appear take the LAST. */
export function parsePostcode(text: string): string | null {
  const all = (text ?? '').match(/\b\d{4}\b/g)
  return all && all.length > 0 ? all[all.length - 1] : null
}

/** PURE — pull an AU state token if present. */
export function parseAuState(text: string): AuState | null {
  const up = (text ?? '').toUpperCase()
  for (const s of AU_STATES) {
    if (new RegExp(`\\b${s}\\b`).test(up)) return s
  }
  return null
}

// ── Plain-language mappers ────────────────────────────────────────────
// Each returns null when the answer is unrecognised (the next-step logic
// re-asks). For the low-stakes fields (coats, ceiling height, storeys) an
// explicit "not sure" maps to the form's own default so the customer is
// never dead-ended. Condition is NOT guessed — it drives the prep price
// and the `poor` inspection gate — so an unsure answer re-asks.

const STABLE_SCOPE_ORDER: readonly PaintScope[] = ['walls', 'ceilings', 'trim', 'exterior']

/** PURE — map a homeowner's words to the surfaces to paint (or null =
 *  re-ask). "inside"/"interior" alone means walls + ceilings; "everything"
 *  means all four. */
export function mapScopes(text: string): PaintScope[] | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  if (/\b(everything|all of it|all of them|the lot|the whole lot|all surfaces|all four)\b/.test(t)) {
    return [...STABLE_SCOPE_ORDER]
  }
  const set = new Set<PaintScope>()
  if (/\bwalls?\b/.test(t)) set.add('walls')
  if (/\bceilings?\b/.test(t)) set.add('ceilings')
  if (/\b(trim|skirting|skirtings|architraves?|doors?|door ?frames?)\b/.test(t)) set.add('trim')
  if (/\b(exterior|outside|outdoors?|external|facade|façade|render|weatherboards?|cladding|eaves)\b/.test(t)) {
    set.add('exterior')
  }
  // A bare "inside"/"interior" with no specific surface → the common
  // interior pair (walls + ceilings).
  if (set.size === 0 && /\b(interior|inside|indoors?|internal)\b/.test(t)) {
    set.add('walls')
    set.add('ceilings')
  }
  if (set.size === 0) return null
  return STABLE_SCOPE_ORDER.filter((s) => set.has(s))
}

/** PURE — map words to a coat count (or null = re-ask). "standard" and an
 *  unsure answer both map to 2 (the AU residential default + form default). */
export function mapCoats(text: string): 1 | 2 | 3 | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  if (/\b(3|three|triple|premium)\b/.test(t)) return 3
  if (/\b(2|two|double|couple|standard)\b/.test(t)) return 2
  if (/\b(1|one|single|just one|refresh|touch ?up|touch-?up)\b/.test(t)) return 1
  if (UNSURE.test(t)) return 2
  return null
}

/** PURE — map words to a substrate condition (or null = re-ask). `poor`
 *  (flaking / water damage / mould) wins over any other token because it
 *  forces inspection. Unsure → re-ask (we never guess the prep lever). */
export function mapCondition(text: string): PaintCondition | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  if (/\b(poor|flaking|flaky|peeling|peel|water ?damage|water-?damaged|mould|mouldy|mold|rotten|rotting|crumbling|bubbling|blistering|bad shape|terrible|falling apart)\b/.test(t)) {
    return 'poor'
  }
  if (/\b(bare|new|unpainted|never ?painted|not ?painted|raw|fresh plaster|new plaster|new render|render|needs? prim|primer|undercoat needed)\b/.test(t)) {
    return 'bare'
  }
  if (/\b(minor|small patch|some patch|bit of patch|light patch|patching|nail holes?|hairline|few cracks|small cracks|a few marks)\b/.test(t)) {
    return 'minor'
  }
  if (/\b(sound|good|fine|great|ok|okay|solid|decent|already ?painted|previously ?painted|existing paint|just a repaint|just tired|nothing wrong|no issues)\b/.test(t)) {
    return 'sound'
  }
  return null
}

/**
 * PURE — pull a stated ceiling height in METRES from a freeform reply, or
 * null when there's no usable number. Handles metres ("3.2m", "3.2 m",
 * "2.7 metres", or a bare decimal "3.2"), millimetres ("2700mm" or a bare
 * 4-digit "2700"), and centimetres ("270 cm"). A bare 1–2 digit integer
 * with NO unit (e.g. "high, 2nd floor", "9ft") is deliberately ignored —
 * it's too ambiguous to be a height — and falls through to the keyword path.
 * Only a plausible residential band (1.9–6 m) is returned.
 */
export function parseCeilingMetres(text: string): number | null {
  const t = (text ?? '').toLowerCase()
  // Scan EVERY numeric token (global flag) rather than anchoring on the first —
  // a customer may volunteer an unrelated leading number ("2nd floor 2.7m",
  // "4000 sqft place, ceilings 2.7m"), and the genuine height is the token
  // carrying a unit, not the first digit run. We collect two tiers of
  // candidates and prefer the explicit-unit one.
  const re = /(\d+(?:[.,]\d+)?)\s*(mm|millimet\w*|cm|centimet\w*|m\b|met\w*)?/g
  const plausible = (v: number) => Number.isFinite(v) && v >= 1.9 && v <= 6
  const withUnit: number[] = []
  const noUnit: number[] = []

  for (const m of t.matchAll(re)) {
    const raw = m[1]
    const unit = m[2] ?? ''
    const hasDecimal = /[.,]/.test(raw)
    const n = Number(raw.replace(',', '.'))
    if (!Number.isFinite(n) || n <= 0) continue

    if (unit.startsWith('mm') || unit.startsWith('millim')) {
      if (plausible(n / 1000)) withUnit.push(n / 1000)
    } else if (unit.startsWith('cm') || unit.startsWith('centim')) {
      if (plausible(n / 100)) withUnit.push(n / 100)
    } else if (unit.startsWith('m')) {
      // "m" / "metre(s)" / "meter(s)"
      if (plausible(n)) withUnit.push(n)
    } else if (hasDecimal) {
      // No unit but a decimal like "3.2" → a weaker (unit-less) metres candidate.
      if (plausible(n)) noUnit.push(n)
    } else if (n >= 1000 && n <= 6000) {
      // No unit, a bare 4-digit like "2700" → millimetres (weaker candidate).
      if (plausible(n / 1000)) noUnit.push(n / 1000)
    }
    // A bare 1–3 digit integer with no unit (e.g. "2nd", "9ft" → "9") is too
    // ambiguous to be a height and is skipped.
  }

  // An explicit-unit height wins over a unit-less number anywhere in the reply.
  if (withUnit.length > 0) return withUnit[0]
  if (noUnit.length > 0) return noUnit[0]
  return null
}

/** PURE — map words OR a stated number to a ceiling-height bucket (or null
 *  = re-ask). `raked` (cathedral / sloped / void) and `extra_high` (~3 m+
 *  flat) both force inspection. A stated number is authoritative and is
 *  banded: <2.55 m standard, 2.55–2.95 m high, ≥2.95 m extra_high. Unsure →
 *  standard. */
export function mapCeilingHeight(text: string): CeilingHeight | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  // Raked / cathedral SHAPE always wins — a sloped 4 m ceiling is still raked.
  if (/\b(raked|cathedral|vaulted|sloped|sloping|void|double[- ]?height|skillion ceiling)\b/.test(t)) {
    return 'raked'
  }
  // A stated number is authoritative: band it. This is what fixes "3.2m"
  // (and any value above the 2.7 m "high" bucket) instead of re-asking.
  const metres = parseCeilingMetres(t)
  if (metres != null) {
    if (metres < 2.55) return 'standard'
    if (metres < 2.95) return 'high'
    return 'extra_high'
  }
  // Word-only answers.
  if (/\b(high|tall|queenslander|period|9 ?ft|10 ?ft)\b/.test(t)) return 'high'
  if (/\b(standard|normal|regular|average|usual|typical|low|8 ?ft)\b/.test(t)) return 'standard'
  if (UNSURE.test(t)) return 'standard'
  return null
}

/** PURE — map words to a storey count (or null = re-ask). 3 forces
 *  inspection. Unsure → 1 (the common AU residential case + form default). */
export function mapStoreys(text: string): 1 | 2 | 3 | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  if (/\b(3|three|triple|3\+|more than (2|two))\b/.test(t)) return 3
  if (/\b(2|two|double|upstairs|two[- ]?storey|double[- ]?storey)\b/.test(t)) return 2
  if (/\b(1|one|single|single[- ]?storey|one[- ]?storey|ground floor|one level|single level)\b/.test(t)) return 1
  if (UNSURE.test(t)) return 1
  return null
}

/** PURE — pull an approximate floor area in m² from a freeform reply, or
 *  null when there's no usable number. Accepts "180", "180m2", "180 sqm",
 *  "about 180". Only a plausible residential band (1–2000 m²) is returned;
 *  the step is optional, so anything else — including "not sure" — is a
 *  skip (null), never a re-ask. */
export function parseFloorAreaM2(text: string): number | null {
  const m = (text ?? '').match(/\d+(?:[.,]\d+)?/)
  if (!m) return null
  const n = Number(m[0].replace(',', '.'))
  if (!Number.isFinite(n) || n < 1 || n > 2000) return null
  return n
}

/** PURE — map a yes/no to whether the customer is changing colour. We
 *  check the "no / same colour / keeping it" side first so "not changing
 *  the colour" reads as false. Anything ambiguous defaults to false (the
 *  form's unchecked default — colour change is a small +10% prep loading
 *  the tradie can add at review). */
export function mapColourChange(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (/\b(no|nope|nah|not|same|keeping|keep|stay|staying|unchanged|matching|match)\b/.test(t)) return false
  if (/\b(yes|yep|yeah|yup|chang(e|ing)|different|new colou?r|darker|lighter|going)\b/.test(t)) return true
  return false
}

// ── Apply a customer answer for a given step ──────────────────────────

/**
 * PURE — fold a customer message into the slots, interpreting it for the
 * step we just asked about. Unrecognised answers leave the slot unset so
 * the next-step logic re-asks. Returns a NEW slots object (no mutation).
 */
export function applyPaintingAnswer(
  slots: PaintingSlots,
  step: PaintingStep,
  message: string,
): PaintingSlots {
  const next: PaintingSlots = { ...slots }
  const msg = message ?? ''

  switch (step) {
    case 'address': {
      const trimmed = msg.trim()
      // Accept only something that actually looks like an address: a
      // street number plus text, and not a stop/cancel sentence.
      if (trimmed.length >= 6 && /\d/.test(trimmed) && !isStopRequest(trimmed)) {
        next.address = trimmed
        const pc = parsePostcode(trimmed)
        if (pc) next.postcode = pc
        const st = parseAuState(trimmed)
        if (st) next.state = st
        next.address_confirmed = false
      }
      break
    }
    case 'confirm_address': {
      // ONE vocabulary for "did they say no", shared with roofing and with the
      // rejection budget. Painting's local isNegative is a bare DENY word
      // list: it reads neither "Noooo" nor "that isn't it" as a refusal, so a
      // rejection the budget WOULD have consumed left the address in place and
      // the read-back went out again (specs/address-confirm-loop.md req 1).
      const negated = rejectsReadBack(msg)
      if (isAffirmativeStrict(msg) && !negated) {
        next.address_confirmed = true
        delete next.addr_confirm_misses
      } else if (negated) {
        // Customer says it's wrong — clear so we re-ask the address.
        // addr_verified goes too: it exists to let screenConfirmAddress SKIP
        // the map check for that exact string, so keeping it re-blesses the
        // address they just refused (verify-address.ts:627).
        next.address = null
        next.postcode = null
        next.state = null
        next.addr_verified = null
        next.address_confirmed = false
      }
      break
    }
    case 'location': {
      const pc = parsePostcode(msg)
      if (pc) next.postcode = pc
      const st = parseAuState(msg)
      if (st) next.state = st
      break
    }
    case 'scopes': {
      const v = mapScopes(msg)
      if (v) next.scopes = v
      break
    }
    case 'coats': {
      const v = mapCoats(msg)
      if (v != null) next.coats = v
      break
    }
    case 'condition': {
      const v = mapCondition(msg)
      if (v) next.condition = v
      break
    }
    case 'ceiling_height': {
      const v = mapCeilingHeight(msg)
      if (v) next.ceiling_height = v
      break
    }
    case 'storeys': {
      const v = mapStoreys(msg)
      if (v != null) next.storeys = v
      break
    }
    case 'floor_area': {
      // Asked exactly once; a non-number (including "not sure") records the
      // skip as null so the address lookup supplies the area.
      next.manual_floor_area_m2 = parseFloorAreaM2(msg)
      break
    }
    case 'colour_change': {
      // Asked exactly once; any non-affirmative answer is a safe `false`.
      next.colour_change = mapColourChange(msg)
      break
    }
    default:
      break
  }

  return next
}

// ── Readiness + inspection ────────────────────────────────────────────

/**
 * PURE — can we price, do we need more answers, or must we inspect?
 *   need_more:  a required slot is still missing.
 *   inspection: a customer-declared trigger the pricer routes to
 *               inspection anyway — poor substrate, raked ceiling, or 3+
 *               storeys.
 *   ready:      enough to run the painting estimate.
 * Mirrors roofingReadiness: required slots are checked in gathering order
 * first, then the inspection triggers, then ready.
 */
export function paintingReadiness(slots: PaintingSlots): 'ready' | 'need_more' | 'inspection' {
  if (!slots.address || !slots.address_confirmed) return 'need_more'
  if (!slots.postcode || !slots.state) return 'need_more'
  if (!slots.scopes || slots.scopes.length === 0) return 'need_more'
  if (slots.coats == null) return 'need_more'
  if (slots.condition == null) return 'need_more'
  if (slots.ceiling_height == null) return 'need_more'
  if (slots.storeys == null) return 'need_more'
  // === undefined, NOT == null: null means asked-and-skipped (complete).
  if (slots.manual_floor_area_m2 === undefined) return 'need_more'
  if (slots.colour_change == null) return 'need_more'
  if (slots.condition === 'poor') return 'inspection'
  if (slots.ceiling_height === 'raked') return 'inspection'
  if (slots.ceiling_height === 'extra_high') return 'inspection'
  if (slots.storeys === 3) return 'inspection'
  return 'ready'
}

const QUESTIONS: Record<
  Exclude<
    PaintingStep,
    'confirm_address' | 'ready' | 'inspection' | 'offer_form' | 'await_form' | 'await_booking' | 'quoted' | 'closed'
  >,
  string
> = {
  address: "Happy to sort a painting quote for you. What's the property address, including suburb and postcode?",
  location: 'Thanks. What postcode and state is that? For example 4151 QLD.',
  scopes:
    'Which surfaces would you like painted? Reply with any that apply: interior walls, ceilings, trim (skirting / architraves), or exterior.',
  coats: 'How many coats would you like? Reply 1 for a refresh, 2 for standard, or 3 for premium.',
  condition:
    'What condition are the surfaces in? Reply: sound (already painted), minor (small patching), bare (new or unpainted), or poor (flaking or damage).',
  ceiling_height:
    'How high are the ceilings? Reply: standard (about 2.4 m), high (about 2.7 m, Queenslander or period), or raked (cathedral or sloped) — or just tell me the height, e.g. 3.2 m.',
  storeys: 'How many storeys is the property? Reply: single, double, or 3 or more.',
  floor_area:
    "If you know the approximate floor area in square metres, reply with the number — or say 'not sure' and I'll measure it from the property footprint.",
  colour_change: 'Last one — are you changing the colour, for example light to dark? Reply yes or no.',
}

/**
 * PURE — the next step + the question to send. Short-circuits to
 * 'inspection' the moment a customer-declared trigger appears (poor
 * substrate, raked ceiling, 3+ storeys), so we don't keep asking. When
 * everything required is gathered cleanly, returns 'ready'.
 */
export function nextPaintingStep(slots: PaintingSlots): {
  step: PaintingStep
  question?: string
  reason?: string
} {
  if (!slots.address) return { step: 'address', question: QUESTIONS.address }
  if (!slots.address_confirmed) {
    return {
      step: 'confirm_address',
      question: `Just to confirm, the property is "${slots.address}". Is that right? Reply yes or no.`,
    }
  }
  if (!slots.postcode || !slots.state) return { step: 'location', question: QUESTIONS.location }
  if (!slots.scopes || slots.scopes.length === 0) return { step: 'scopes', question: QUESTIONS.scopes }
  if (slots.coats == null) return { step: 'coats', question: QUESTIONS.coats }

  if (slots.condition == null) return { step: 'condition', question: QUESTIONS.condition }
  if (slots.condition === 'poor') {
    return { step: 'inspection', reason: 'the surfaces are flaking or damaged, so the prep needs an on-site look before pricing' }
  }

  if (slots.ceiling_height == null) return { step: 'ceiling_height', question: QUESTIONS.ceiling_height }
  if (slots.ceiling_height === 'raked') {
    return { step: 'inspection', reason: 'raked or cathedral ceilings need an on-site measure' }
  }
  if (slots.ceiling_height === 'extra_high') {
    return { step: 'inspection', reason: 'ceilings above about 2.7 m need an on-site measure for the extra wall area and access' }
  }

  if (slots.storeys == null) return { step: 'storeys', question: QUESTIONS.storeys }
  if (slots.storeys === 3) {
    return { step: 'inspection', reason: 'three or more storeys need an on-site access check' }
  }

  // Optional, asked once: === undefined means not asked yet; null means the
  // customer skipped it ("not sure") and the address lookup supplies the area.
  if (slots.manual_floor_area_m2 === undefined) {
    return { step: 'floor_area', question: QUESTIONS.floor_area }
  }

  if (slots.colour_change == null) return { step: 'colour_change', question: QUESTIONS.colour_change }

  return { step: 'ready' }
}

/**
 * PURE — convert the gathered slots into the EstimateRequest the painting
 * estimate endpoint expects. Returns null when not ready (missing required
 * fields). The estimate runs the Google Solar footprint lookup (→ Geoscape
 * / floor plan as those land).
 */
export function toPaintingRequest(slots: PaintingSlots): EstimateRequest | null {
  if (!slots.address || !slots.postcode || !slots.state) return null
  if (!slots.scopes || slots.scopes.length === 0) return null
  if (
    slots.coats == null ||
    slots.condition == null ||
    slots.ceiling_height == null ||
    slots.storeys == null ||
    slots.colour_change == null
  ) {
    return null
  }
  return {
    address: {
      address: slots.address,
      postcode: slots.postcode,
      state: slots.state,
    },
    inputs: {
      scopes: slots.scopes,
      coats: slots.coats,
      condition: slots.condition,
      ceiling_height: slots.ceiling_height,
      colour_change: slots.colour_change,
      storeys: slots.storeys,
      manual_floor_area_m2: slots.manual_floor_area_m2 ?? null,
    },
  }
}
