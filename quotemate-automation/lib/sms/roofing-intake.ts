// ════════════════════════════════════════════════════════════════════
// SMS roofing receptionist — pure intake state machine.
//
// The roofing trade runs a self-contained measure→price pipeline
// (lib/roofing/*) that is NOT the electrical/plumbing intake→estimate
// flow. So over SMS we gather the SAME inputs the dashboard Roofing tab
// collects — address, material, pitch, intent (+ optional year) — with a
// deterministic question-asker rather than the elec/plumbing Sonnet
// dialog. Deterministic = unit-testable + can't drift the money path.
//
// Plain-language mapping is the crux: a homeowner says "tin roof" / "not
// too steep" / "whole roof needs doing", not "colorbond_trimdek" /
// "standard" / "full_reroof". We map those, and when a customer genuinely
// can't tell us the material or pitch we route to the on-site inspection
// rather than guessing a price — the same inspection-fallback discipline
// the rest of QuoteMate uses.
//
// PURE — no I/O, no SDK. Fully unit-tested.
// ════════════════════════════════════════════════════════════════════

import type {
  PitchBucket,
  RoofAddressInput,
  RoofJobIntent,
  RoofMaterial,
} from '@/lib/roofing/types'

export type AuState = RoofAddressInput['state']

/** Accumulated roofing inputs gathered across SMS turns. Persisted on
 *  sms_conversations.roofing_state (jsonb), decoupled from the
 *  electrical/plumbing conversation_state.slots. */
export type RoofingSlots = {
  address?: string | null
  postcode?: string | null
  state?: AuState | null
  /** Customer confirmed the address we read back is correct. */
  address_confirmed?: boolean
  material?: RoofMaterial | null
  pitch?: PitchBucket | null
  intent?: RoofJobIntent | null
  year_built?: number | null
}

/** Which input the receptionist is currently gathering. */
export type RoofingStep =
  | 'address'
  | 'confirm_address'
  | 'intent'
  | 'material'
  | 'pitch'
  | 'ready'
  | 'inspection'

const AU_STATES: readonly AuState[] = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT']

// ── Intent detection ──────────────────────────────────────────────────

const ROOFING_KEYWORDS = [
  're-roof', 'reroof', 're roof', 'roof replacement', 'replace the roof', 'new roof',
  'roofing', 'roof leak', 'leaking roof', 'roof repair', 'roof restoration',
  'gutter', 'downpipe', 'down pipe', 'ridge cap', 'ridge caps', 'valley iron',
  'roof flashing', 'whirlybird', 'whirly bird', 'colorbond roof', 'tile roof',
  'tiled roof', 'metal roof', 'eaves', 'fascia', 'sarking',
]

/**
 * PURE — does this message read like a roofing enquiry? Used to branch
 * the SMS receptionist into the roofing flow. Conservative: matches clear
 * roofing terms; bare "roof" only counts with a work verb nearby so
 * "the switch is near the roof" (electrical) doesn't trip it.
 */
export function looksLikeRoofingEnquiry(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  if (ROOFING_KEYWORDS.some((k) => t.includes(k))) return true
  // bare "roof" only when paired with an action/condition word
  if (/\broofs?\b/.test(t) && /\b(quote|estimate|replace|repair|fix|leak|redo|restore|paint|broken|cracked|old)\b/.test(t)) {
    return true
  }
  return false
}

// ── Plain-language mappers ────────────────────────────────────────────
// Each returns null when the answer is unrecognised (re-ask), or the
// sentinel 'unknown' enum value when the customer explicitly can't tell
// us (→ routes to inspection at readiness).

const UNSURE = /\b(not sure|unsure|no idea|dunno|don'?t know|do not know|no clue|couldn'?t say|hard to say)\b/

/** PURE — map a homeowner's words to a RoofMaterial (or null = re-ask). */
export function mapMaterial(text: string): RoofMaterial | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  if (UNSURE.test(t)) return 'unknown'
  // Asbestos-suspect first — safety wins over any metal/tile token.
  if (/\b(asbestos|fibro|cement sheet|super ?six|fibrolite|ac sheet)\b/.test(t)) return 'cement_sheet'
  if (/\b(klip-?lok|kliplok|standing seam|concealed fix)\b/.test(t)) return 'colorbond_kliplok'
  if (/\b(colorbond|colourbond|metal|tin|steel|corro|corrugated|zincalume|trimdek|custom orb)\b/.test(t)) return 'colorbond_trimdek'
  if (/\b(terracotta|terra ?cotta|clay tile|clay tiles)\b/.test(t)) return 'terracotta_tile'
  if (/\b(concrete tile|cement tile|concrete tiles)\b/.test(t)) return 'concrete_tile'
  // Generic "tiles" → concrete (the common AU default); document this.
  if (/\btiles?\b/.test(t)) return 'concrete_tile'
  return null
}

/** PURE — map a homeowner's words to a PitchBucket (or null = re-ask). */
export function mapPitch(text: string): PitchBucket | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  if (UNSURE.test(t)) return 'unknown'
  if (/\b(very steep|really steep|super steep|extremely steep|near vertical)\b/.test(t)) return 'very_steep'
  if (/\b(steep|sharp|high pitch|high-pitched)\b/.test(t)) return 'steep'
  if (/\b(flat|low|low pitch|low-pitched|shallow|barely|gentle|skillion)\b/.test(t)) return 'shallow'
  if (/\b(standard|normal|average|medium|regular|typical|usual|moderate)\b/.test(t)) return 'standard'
  return null
}

/** PURE — map a homeowner's words to a RoofJobIntent (or null = re-ask). */
export function mapIntent(text: string): RoofJobIntent | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  if (/\b(re-?roof|whole roof|entire roof|full roof|new roof|replace.*roof|roof.*replace|all of it)\b/.test(t)) return 'full_reroof'
  if (/\b(leak|leaking|water coming|dripping)\b/.test(t)) return 'leak_trace'
  if (/\b(gutters?|downpipes?|down ?pipes?)\b/.test(t)) return 'gutter_replace'
  if (/\b(ridges?|caps?|repoint|rebed)\b/.test(t)) return 'ridge_cap'
  if (/\b(flashings?)\b/.test(t)) return 'flashing_repair'
  if (/\b(repairs?|patch|fix|broken|cracked|damaged|missing|few tiles)\b/.test(t)) return 'patch_repair'
  return null
}

/** PURE — extract an explicit build year (1850-2100) or a decade ("1980s"
 *  → 1980). Relative ages ("about 30 years old") are NOT inferred (no
 *  clock dependency) — returns null so the optional slot is just skipped. */
export function parseYearBuilt(text: string): number | null {
  const t = (text ?? '').toLowerCase()
  const decade = t.match(/\b(18|19|20)(\d0)s\b/)
  if (decade) {
    const y = Number(`${decade[1]}${decade[2]}`)
    if (y >= 1850 && y <= 2100) return y
  }
  const m = t.match(/\b(18|19|20)\d{2}\b/)
  if (m) {
    const y = Number(m[0])
    if (y >= 1850 && y <= 2100) return y
  }
  return null
}

/** PURE — pull a 4-digit AU postcode if present. AU addresses end with
 *  the postcode, so when several 4-digit groups appear (e.g. a build year
 *  earlier in the line) take the LAST one. */
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

// ── Affirmation / negation for the address-confirm step ──────────────

const AFFIRM = /\b(yes|yep|yeah|yup|correct|right|that'?s right|that'?s it|confirmed|sure|ok|okay|👍)\b/
const DENY = /\b(no|nope|nah|wrong|incorrect|not right|different)\b/

export function isAffirmative(text: string): boolean {
  return AFFIRM.test((text ?? '').toLowerCase())
}
export function isNegative(text: string): boolean {
  return DENY.test((text ?? '').toLowerCase())
}

// ── Apply a customer answer for a given step ──────────────────────────

/**
 * PURE — fold a customer message into the slots, interpreting it for the
 * step we just asked about. Unrecognised answers leave the slot unset so
 * the next-step logic re-asks. Returns a NEW slots object (no mutation).
 */
export function applyRoofingAnswer(
  slots: RoofingSlots,
  step: RoofingStep,
  message: string,
): RoofingSlots {
  const next: RoofingSlots = { ...slots }
  const msg = message ?? ''

  switch (step) {
    case 'address': {
      const trimmed = msg.trim()
      if (trimmed.length >= 5) {
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
      if (isAffirmative(msg) && !isNegative(msg)) {
        next.address_confirmed = true
      } else if (isNegative(msg)) {
        // Customer says it's wrong — clear so we re-ask the address.
        next.address = null
        next.postcode = null
        next.state = null
        next.address_confirmed = false
      }
      break
    }
    case 'intent': {
      const v = mapIntent(msg)
      if (v) next.intent = v
      break
    }
    case 'material': {
      const v = mapMaterial(msg)
      if (v) next.material = v
      break
    }
    case 'pitch': {
      const v = mapPitch(msg)
      if (v) next.pitch = v
      break
    }
    default:
      break
  }

  // Year is opportunistic — grab it from any turn that mentions one.
  if (next.year_built == null) {
    const y = parseYearBuilt(msg)
    if (y != null) next.year_built = y
  }

  return next
}

// ── Readiness + inspection ────────────────────────────────────────────

/**
 * PURE — can we price, do we need more answers, or must we inspect?
 *   inspection: material is cement_sheet/unknown, or pitch is
 *               very_steep/unknown (the deterministic pricer would route
 *               these to inspection anyway — we surface it earlier).
 *   need_more:  a required slot (confirmed address, intent, material,
 *               pitch) is still missing.
 *   ready:      enough to run measureAndPriceRoofs.
 */
export function roofingReadiness(slots: RoofingSlots): 'ready' | 'need_more' | 'inspection' {
  if (!slots.address || !slots.address_confirmed) return 'need_more'
  if (!slots.intent) return 'need_more'
  if (!slots.material) return 'need_more'
  if (!slots.pitch) return 'need_more'
  if (slots.material === 'cement_sheet' || slots.material === 'unknown') return 'inspection'
  if (slots.pitch === 'very_steep' || slots.pitch === 'unknown') return 'inspection'
  return 'ready'
}

const QUESTIONS: Record<Exclude<RoofingStep, 'ready' | 'inspection'>, string> = {
  address: "Happy to sort a roofing quote for you. What's the property address (including suburb & postcode)?",
  confirm_address: '', // filled dynamically with the address read-back
  intent: 'What do you need done — a full re-roof, a repair/patch, a leak traced, or gutters/downpipes?',
  material: "What's the roof made of? (e.g. Colorbond/metal, concrete or terracotta tiles, or fibro/cement sheet)",
  pitch: 'Roughly how steep is the roof — flat-ish, standard, or steep?',
}

/**
 * PURE — the next step + the question to send. When everything required
 * is gathered, returns 'ready' (price now) or 'inspection' (book the
 * on-site inspection instead of quoting).
 */
export function nextRoofingStep(slots: RoofingSlots): {
  step: RoofingStep
  question?: string
  reason?: string
} {
  if (!slots.address) return { step: 'address', question: QUESTIONS.address }
  if (!slots.address_confirmed) {
    return {
      step: 'confirm_address',
      question: `Just to confirm — the property is "${slots.address}". Is that right? (yes/no)`,
    }
  }
  if (!slots.intent) return { step: 'intent', question: QUESTIONS.intent }
  if (!slots.material) return { step: 'material', question: QUESTIONS.material }
  if (!slots.pitch) return { step: 'pitch', question: QUESTIONS.pitch }

  const readiness = roofingReadiness(slots)
  if (readiness === 'inspection') {
    const why =
      slots.material === 'cement_sheet'
        ? 'cement-sheet/fibro roofs may contain asbestos'
        : slots.material === 'unknown'
          ? "we couldn't confirm the roof material"
          : 'the roof pitch is steep or unknown'
    return { step: 'inspection', reason: why }
  }
  return { step: 'ready' }
}

/** PURE — convert the gathered slots into the RoofAddressInput +
 *  RoofUserInputs the roofing pipeline expects. Returns null when not
 *  ready (missing required fields). */
export function toRoofingRequest(slots: RoofingSlots): {
  address: RoofAddressInput
  inputs: { material: RoofMaterial; pitch: PitchBucket; intent: RoofJobIntent; building_year_built: number | null }
} | null {
  if (!slots.address || !slots.material || !slots.pitch || !slots.intent) return null
  return {
    address: {
      address: slots.address,
      postcode: slots.postcode ?? '',
      state: slots.state ?? 'NSW',
    },
    inputs: {
      material: slots.material,
      pitch: slots.pitch,
      intent: slots.intent,
      building_year_built: slots.year_built ?? null,
    },
  }
}
