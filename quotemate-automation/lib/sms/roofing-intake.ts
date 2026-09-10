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
// the rest of QuoteMax uses.
//
// PURE — no I/O, no SDK. Fully unit-tested.
// ════════════════════════════════════════════════════════════════════

import type {
  PitchBucket,
  RoofAddressInput,
  RoofJobIntent,
  RoofMaterial,
} from '@/lib/roofing/types'
// Reuse the pricer's canonical degrees→bucket boundaries rather than
// restating them here — one source of truth for what "25 degrees" means.
import { pitchBucketFromDegrees } from '@/lib/roofing/pricing'

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
  /** The exact address string that already passed the map check —
   *  screenConfirmAddress skips re-verifying it. */
  addr_verified?: string | null
  /** How many supplied addresses the map couldn't find. Bounded by
   *  MAX_ADDRESS_VERIFY_REJECTS, then we fall back to the plain
   *  read-back so an unmapped new estate can still push through. */
  addr_verify_misses?: number
  /** How many times the CUSTOMER rejected the read-back. Different event,
   *  different counter: addr_verify_misses counts the MAP failing to find
   *  an address, and neither the customer's "no" nor this budget was ever
   *  counted before (specs/address-confirm-loop.md). */
  addr_confirm_rejects?: number
  /** How many replies to the read-back were neither yes nor no ("Hi Mate").
   *  See consumeAddressMiss — a verbatim re-ask is the loop itself. */
  addr_confirm_misses?: number
  material?: RoofMaterial | null
  pitch?: PitchBucket | null
  intent?: RoofJobIntent | null
  year_built?: number | null
  /** Customer said "metal"/"Colorbond" without naming a profile — we
   *  understood the answer, we just need to know WHICH. Drives the
   *  'material_profile' follow-up; cleared once the profile lands. */
  metal_hint?: boolean
  /** R5 — the customer named a COMMERCIAL property (warehouse, factory,
   *  strata, apartment block). The residential rate card and per-building
   *  measure do not apply, so the job routes to an on-site inspection
   *  instead of auto-sending a firm price. */
  commercial?: boolean
  /** Consecutive unrecognised answers to the step we're currently asking.
   *  Bounded by the receptionist so a reply we can't map routes to the
   *  on-site inspection instead of re-asking the same question forever.
   *  Cleared the moment an answer lands. */
  misses?: number
}

/** Which input the receptionist is currently gathering. */
export type RoofingStep =
  // Opener — the self-serve quote-request form has been offered and we are
  // waiting to hear whether they want it or would rather answer here
  // (spec: specs/generic-quote-request-form.md §4).
  | 'offer_form'
  // Customer chose the form — acknowledged and waiting for the submission.
  // A later text switches them to Q&A.
  | 'await_form'
  | 'address'
  | 'confirm_address'
  | 'intent'
  | 'material'
  // Follow-up when the material answer was generic metal: which profile?
  | 'material_profile'
  | 'pitch'
  | 'ready'
  | 'inspection'
  // After measuring we send the roof photo and wait for the customer to
  // confirm it's the right building (or pick among several / say none).
  | 'confirm_roof'
  // After an inspection route, waiting for the customer to confirm they
  // want the on-site visit booked.
  | 'await_booking'
  // Quote sent + confirmed, but the thread stays WARM: a structure
  // follow-up ("give me 2 and 3", "the shed", "all of them") re-serves the
  // SAVED measurement without re-measuring, and an unrelated message is
  // handed back to the general dialog (never trapped, never re-quoted).
  | 'quoted'
  // Conversation finished (cancelled or booked). Only a fresh roofing
  // enquiry reopens it; an unrelated message never re-quotes.
  | 'closed'

const AU_STATES: readonly AuState[] = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT']

// ── Intent detection ──────────────────────────────────────────────────

const ROOFING_KEYWORDS = [
  're-roof', 'reroof', 're roof', 'roof replacement', 'replace the roof', 'new roof',
  'roofing', 'roof leak', 'leaking roof', 'roof repair', 'roof restoration',
  'gutter', 'downpipe', 'down pipe', 'ridge cap', 'ridge caps', 'valley iron',
  'roof flashing', 'whirlybird', 'whirly bird', 'colorbond roof', 'tile roof',
  'tiled roof', 'metal roof', 'eaves', 'fascia', 'sarking',
  // "roofer" is a tradesperson noun — unlike bare "roof" it is never
  // incidental, so it needs no accompanying work verb. "Need a roofer" and
  // "roofer?" both reached the electrical dialog before 2026-07-22.
  'roofer',
  // "do my/the/our/your roof" is inherently a roofing job, but "do" is not in
  // ROOFING_WORK (only "do you do"), so "can you do my roof" fell to the
  // electrical dialog (live 2026-07-24, scenario E). These phrases are
  // unambiguous — an electrical/plumbing enquiry never says "do my roof".
  'do my roof', 'do the roof', 'do our roof', 'do your roof',
  // G6 — roof-SPECIFIC emergency phrasing. Bare "storm"/"tree"/"urgent" is NOT
  // used: on a cross-trade tenant "storm last night, my switchboard is wet and
  // the aerial on the roof is bent" would hijack an electrical job.
  'through the roof', 'roof collapsed', 'roof caved',
]

/** PURE — the customer is naming a DIFFERENT trade, so the roofing/painting
 *  gather must hand off instead of parsing it (or counting it as a failed
 *  answer). Live 2026-07-25 (QM Sparky): "How about electrical" and "No im
 *  asking electrical" were each counted as a failed intent answer, and two
 *  misses fired a ROOFING inspection for an ELECTRICAL enquiry. Roof words are
 *  excluded so "gutters" or "re-roof" never reads as another trade. */
// Deliberately ONLY unambiguous trade nouns. Earlier drafts included solar,
// tap, toilet, drain, downlight and hot water: all of those appear in ordinary
// roofing answers ("need the solar taken off and new sheets on", "water coming
// through around the downlights"), and treating them as a trade switch threw
// away a live gather. A roof word still wins outright.
const OTHER_TRADE =
  /\b(electrical|electrician|sparky|plumber|plumbing|aircon|air ?con|split system|signage)\b/

/** Fittings that belong to another trade but DO turn up in ordinary roofing
 *  answers — the reason the comment above refuses to list them outright.
 *
 *  The distinction that comment misses: "water coming through around the
 *  downlights" is roofing because it names WATER, not because it names a
 *  downlight. "New downlights" carries no roofing context at all. So these
 *  count as a trade switch only when nothing in the message suggests a roof
 *  problem — exactly the shape looksLikeRoofingEnquiry already uses for bare
 *  "roof" (a noun alone is not a job).
 *
 *  Live 2026-08-03, Atomix: after the thread was hijacked, "New downlights."
 *  and "No I need new downlights" were each counted as a FAILED roofing
 *  answer, and two misses fire the inspection fallback. The clearest possible
 *  correction, sent twice, could not get out. */
const SOFT_OTHER_TRADE =
  /\b(downlight\w*|down light\w*|gpo\w*|power ?point\w*|switchboard\w*|safety switch\w*|light fitting\w*|ceiling fan\w*)\b/

/** Wording that makes a message a ROOF problem even when it names another
 *  trade's fitting. Water is the giveaway: a leak is described by where it
 *  comes out, which is often a light. */
const ROOF_PROBLEM_CONTEXT =
  /\b(water|leak\w*|drip\w*|stain\w*|damp|wet|rain\w*|through|pouring|coming in)\b/

export function namesOtherTrade(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  // `\b(?:re-?)?roof` also catches the unhyphenated "reroof" (a \broof guard
  // missed it, so the most on-topic answer possible looked like another trade).
  if (/\b(?:re-?)?roof|gutter|downpipe|eaves|fascia|ridge cap|sarking/.test(t)) return false
  if (OTHER_TRADE.test(t)) return true
  return SOFT_OTHER_TRADE.test(t) && !ROOF_PROBLEM_CONTEXT.test(t)
}

/** PURE — a bare greeting / pleasantry. It is not an answer to the step we
 *  asked, but it is not a failed answer either: counting it burns the miss
 *  budget toward the inspection fallback (live 2026-07-25: "Hi there mate!"). */
// NOTE ok/okay/sure/cool/great/sweet/"no worries" are deliberately EXCLUDED:
// they are AFFIRM tokens, and matching them here swallowed a valid "ok" at
// confirm_address into an unbounded re-ask loop (no miss is counted, so it
// never escalated) plus a live map lookup every turn.
const GREETING_ONLY =
  /^\s*(hi|hey|hello|yo|gday|g'day|good (morning|afternoon|evening)|hi there|hey there|thanks|thank you|cheers)\b[\s!.,]*(mate|guys|team|there)?[\s!.,]*$/
export function isGreetingOnly(text: string): boolean {
  const t = (text ?? '').toLowerCase().trim()
  if (isAffirmative(t) || isNegative(t)) return false
  return GREETING_ONLY.test(t)
}

/** PURE — R5: the customer named a COMMERCIAL property. Residential pricing and
 *  the per-building measure do not apply, so these route on site. */
const COMMERCIAL_RE =
  /\b(warehouse|factory|industrial|commercial|strata|body corporate|apartment block|unit block|shopping cent(?:re|er)|office block|childcare|school|church|hangar)\b/
export function looksCommercial(text: string): boolean {
  return COMMERCIAL_RE.test((text ?? '').toLowerCase())
}

/** A "roof" that is a LOCATION, not the job. These are electrical/plumbing
 *  sentences ("the downlight near the roof cavity flickers") and must never
 *  open a roofing quote no matter what other words they carry. Checked
 *  first, so widening the verb list below can't leak into other trades. */
const NOT_ROOFING = /\broof\s?(cavity|space|void)\b|\bin the roof\b|\bunder the roof\b/

/** A ceiling/roof MATERIAL named on its own — the answer to "what's the ceiling
 *  type?", not a request for roofing work. Checked only when no work or problem
 *  word is present (see looksLikeRoofingEnquiry), so a real complaint that
 *  names the material still engages. */
const CEILING_MATERIAL =
  /\b(insulated panel|panel roofing|sheet metal roofing|sheet roofing|metal sheeting)\b/

/** F14 — an explicit paint job is a PAINTING enquiry, not roofing, even when it
 *  names the shared parts (gutter/eaves/fascia). But a ROOF-SPECIFIC term keeps
 *  it roofing even if paint is mentioned ("roof needs repainting and gutters
 *  rusted"). ROOF_SPECIFIC deliberately excludes gutter/eaves/fascia (shared
 *  with painting) and mirrors the painting slice's own `\broof` exclusion, so a
 *  roof+paint message is never refused by BOTH receptionists. Live 2026-07-24:
 *  "quote painting my gutters, eaves and fascia" ran a roofing measure. */
const PAINT_ENQUIRY = /\b(?:re)?paint\w*\b/
const ROOF_SPECIFIC =
  /\broof\w*\b|\bre-?roof\w*\b|\bridge ?caps?\b|\bvalley iron\b|\bwhirly ?bird\b|\bsarking\b|\bdown ?pipe\b/

/** Work the customer might want done, as STEMS.
 *
 *  These were exact words until 2026-07-22, which is why "Can you quoted my
 *  roof." fell through to the electrical dialog — `\bquote\b` cannot match
 *  "quoted". Same class of bug as the one already fixed in mapIntent below
 *  (see its NOTE about `replac\w*`); it was never back-ported here. */
const ROOFING_WORK =
  /\b(quot\w*|estimat\w*|price[sd]?|pricing|cost\w*|how much|replac\w*|repair\w*|fix\w*|leak\w*|redo|redone|restor\w*|paint\w*|inspect\w*|broken|cracked|damaged|old|new|done|doing|need\w*|want\w*|look\w* at|sort\w* out|do you do|collaps\w*|cav(?:e|ing) in|caved in|fall\w* in|fell in|sag\w+|hole|holes|blew off|blown off)\b/

/**
 * PURE — does this message read like a roofing enquiry? Used to branch
 * the SMS receptionist into the roofing flow. Conservative: matches clear
 * roofing terms; bare "roof"/"roofs" only counts with a work word nearby so
 * "the switch is near the roof" (electrical) doesn't trip it.
 */
export function looksLikeRoofingEnquiry(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  if (NOT_ROOFING.test(t)) return false
  // A CEILING MATERIAL is not a roofing enquiry.
  //
  // Live 2026-08-03, Atomix (electrical + roofing): a customer asked for 16
  // downlights, the electrical dialog asked "what's the ceiling type out there
  // — flat, raked, cathedral, or sheet metal?", and they answered "it's a
  // 125mm insulated panel roofing". The bare substring 'roofing' in
  // ROOFING_KEYWORDS matched, the roofing receptionist took the thread, and
  // the customer's next two messages — "New downlights." and "No I need new
  // downlights" — were counted as failed roofing answers, which fired a $99
  // ROOFING inspection for an electrical job. Answering our own question is
  // what broke it.
  //
  // Gated on there being no work/problem word, so a genuine roof complaint
  // that happens to name the material still engages: "water leaking through
  // the panel roofing" keeps `leak`, so it stays roofing. Same shape as the
  // bare-"roof" rule below — a material alone is a noun, not a job.
  if (CEILING_MATERIAL.test(t) && !ROOFING_WORK.test(t)) return false
  // F14 — explicit paint job with NO roof-specific term is painting.
  if (PAINT_ENQUIRY.test(t) && !ROOF_SPECIFIC.test(t)) return false
  if (ROOFING_KEYWORDS.some((k) => t.includes(k))) return true
  // bare "roof" only when paired with an action/condition word
  if (/\broofs?\b/.test(t) && ROOFING_WORK.test(t)) return true
  return false
}

// ── Plain-language mappers ────────────────────────────────────────────
// Each returns null when the answer is unrecognised (re-ask), or the
// sentinel 'unknown' enum value when the customer explicitly can't tell
// us (→ routes to inspection at readiness).

const UNSURE = /\b(not sure|unsure|no idea|dunno|don'?t know|do not know|no clue|couldn'?t say|hard to say)\b/

/** Metal named generically, with no profile. */
// "Colorblind" is what phone autocorrect makes of "Colorbond", and "color
// bond" is the spaced spelling. Neither matched on 2026-07-22, so two
// consecutive misses forced a perfectly ordinary metal roof to inspection.
const GENERIC_METAL =
  /\bcolou?r[\s-]?bond\b|\bcolou?r[\s-]?blind\b|\b(metal|tin|steel|zincalume)\b/
// ── Profile vocabularies ─────────────────────────────────────────────
// ONE source of truth per profile, shared by mapMaterial() and
// NAMED_PROFILE. They used to be written out twice, which is exactly how
// they drifted from the question we ask: QUESTIONS.material_profile calls
// Corrugated "the classic wavy sheets" and Trimdek "flat panels with
// square ribs", but neither "classic", "wavy", "flat panel" nor "square
// rib" mapped to anything. A customer who answered with the word the bot
// itself taught them got material='unknown' and was pushed to an on-site
// inspection (observed live 2026-07-22). Any word used in a QUESTION must
// appear in the matching vocabulary below.
const CORRUGATED_WORDS =
  'corro|corrugated|custom ?orb|iron|galv|galvanised|galvanized|classic|wavy|wave|ripple[ds]?'
const TRIMDEK_WORDS = 'trimdek|trim ?dek|flat panel[s]?|square rib[s]?'
const KLIPLOK_WORDS = 'klip-?lok|kliplok|standing seam|concealed fix'
const SPANDEK_WORDS = 'spandek|span ?deck'

const CORRUGATED = new RegExp(`\\b(${CORRUGATED_WORDS})\\b`)
const TRIMDEK = new RegExp(`\\b(${TRIMDEK_WORDS})\\b`)
const KLIPLOK = new RegExp(`\\b(${KLIPLOK_WORDS})\\b`)
const SPANDEK = new RegExp(`\\b(${SPANDEK_WORDS})\\b`)

/** Any answer that DOES pin the profile down. */
const NAMED_PROFILE = new RegExp(
  `\\b(${[CORRUGATED_WORDS, TRIMDEK_WORDS, KLIPLOK_WORDS, SPANDEK_WORDS].join('|')})\\b`,
)

/**
 * PURE — did the customer say "it's metal" without saying WHICH metal?
 * Corrugated and Trimdek are priced differently ($90 vs $95/m²) and look
 * nothing alike on a roof, so this gets a targeted follow-up rather than a
 * guess. False for tiles, fibro, "not sure", and any named profile.
 */
export function isAmbiguousMetal(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  if (UNSURE.test(t)) return false
  return GENERIC_METAL.test(t) && !NAMED_PROFILE.test(t)
}

/** PURE — map a homeowner's words to a RoofMaterial (or null = re-ask). */
export function mapMaterial(text: string): RoofMaterial | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  if (UNSURE.test(t)) return 'unknown'
  // Asbestos-suspect first — safety wins over any metal/tile token.
  if (/\b(asbestos|fibro|cement sheet|super ?six|fibrolite|ac sheet)\b/.test(t)) return 'cement_sheet'
  // Materials we do NOT price (not in ROOF_MATERIALS). Reading them as
  // 'unknown' routes the job to an on-site inspection — the honest answer.
  // Guessing the nearest priced material would quote the wrong roof.
  if (/\b(slate|shingles?|asphalt|shake|thatch|polycarbonate|fibreglass)\b/.test(t)) return 'unknown'
  if (KLIPLOK.test(t)) return 'colorbond_kliplok'
  if (SPANDEK.test(t)) return 'colorbond_spandek'
  // "Iron" / "galv" is AU vernacular for corrugated metal sheet — by far
  // the most common way a homeowner names this roof. "Classic" / "wavy"
  // are the words OUR OWN profile question uses to describe it.
  if (CORRUGATED.test(t)) return 'colorbond_corrugated'
  if (TRIMDEK.test(t)) return 'colorbond_trimdek'
  // A bare "Colorbond" / "metal" / "tin" names NO profile. This used to
  // return Trimdek, quoting a roof the customer never described (and the
  // SMS twin of the dashboard bug where a tradie's Corrugated came back as
  // Trimdek). Return null so the receptionist asks WHICH profile.
  if (GENERIC_METAL.test(t)) return null
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
  // An explicit angle is the most precise answer a homeowner can give —
  // classify it with the pricer's own boundaries.
  const deg = t.match(/(\d{1,2}(?:\.\d+)?)\s*(?:°|deg\b|degs\b|degree|degrees)/)
  if (deg) return pitchBucketFromDegrees(Number(deg[1]))
  // "Not too steep" means standard — check the negation BEFORE the steep
  // stem below, or the bare word wins and we price fall protection twice.
  if (/\bnot\s+(too\s+|that\s+|very\s+|so\s+|really\s+)?steep\w*/.test(t)) return 'standard'
  if (/\b(very|really|super|extremely)\s+steep\w*|\bnear vertical\b/.test(t)) return 'very_steep'
  // Stem, not `\bsteep\b` — "steeper"/"steeply" must not fall through to
  // the standard rule below and match the "normal" in "steeper than
  // normal", which priced a steep roof at the standard rate.
  if (/\bsteep\w*|\bsharp\b|\bhigh[- ]?pitch/.test(t)) return 'steep'
  if (/\b(flat|low|low pitch|low-pitched|shallow|barely|gentle|skillion)\b/.test(t)) return 'shallow'
  if (/\b(standard|normal|average|medium|regular|typical|usual|moderate)\b/.test(t)) return 'standard'
  return null
}

/** PURE — map a homeowner's words to a RoofJobIntent (or null = re-ask). */
export function mapIntent(text: string): RoofJobIntent | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  // NOTE: match verb STEMS (replac\w*), never `…replace\b`. A trailing \b
  // cannot match "replacement" / "replacing", which is exactly how "Roof
  // replacement" read as unrecognised and re-asked the same question.
  // re-roof / reroof / "re roof" — voice STT commonly splits it with a space,
  // which the hyphen-only form used to miss (a full-re-roof call then dropped
  // its intent and got re-asked by text).
  if (/\bre[-\s]?roof/.test(t)) return 'full_reroof'
  if (/\b(whole|entire|full|new)\s+roof/.test(t)) return 'full_reroof'
  if (/\broofs?\s+replac\w*/.test(t)) return 'full_reroof' // "roof replacement"
  if (/\breplac\w*\s+(the\s+|my\s+|our\s+|that\s+|existing\s+)*roof/.test(t)) return 'full_reroof'
  if (/\b(all of it|replace it all|the lot|whole thing|whole lot)\b/.test(t)) return 'full_reroof'
  if (/\b(leak|leaking|water coming|dripping)\b/.test(t)) return 'leak_trace'
  if (/\b(gutters?|downpipes?|down ?pipes?)\b/.test(t)) return 'gutter_replace'
  if (/\b(ridges?|caps?|repoint|rebed)\b/.test(t)) return 'ridge_cap'
  if (/\b(flashings?)\b/.test(t)) return 'flashing_repair'
  if (/\b(repairs?|patch|fix|broken|cracked|damaged|missing|few tiles)\b/.test(t)) return 'patch_repair'
  // Bare "replacement" with no other cue — checked LAST so "gutter
  // replacement" has already been claimed by the gutter rule above.
  if (/\breplac\w*/.test(t)) return 'full_reroof'
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
// F15c — a negation cue BEYOND the DENY vocabulary. "not quite right" / "isn't
// right" / "not sure" carry an affirm token (right/sure) but NO deny token, so
// at confirm_address they wrongly confirmed and measured the wrong roof (live
// 2026-07-24). Consulted only to BLOCK a confirm and re-ask, so it can never
// cause a wrong confirm.
// Explicit negations/contractions only — a bare `n'?t\b` suffix wrongly matched
// the trailing "nt" of ordinary confirm words (apartment/front/point).
const NEGATION_CUE =
  /\bnot\b|\bcannot\b|\bnever\b|\b(?:is|are|was|were|do|does|did|ca|could|wo|would|should|has|have|had|ai|must|need|sha)n['’]?t\b/

/** PURE — the customer is rejecting what we just read back: a deny word OR a
 *  negation cue ("that's not it"). One vocabulary, so the state machine and
 *  the rejection budget cannot disagree about what a "no" is. */
export function rejectsReadBack(msg: string): boolean {
  return isNegative(msg) || NEGATION_CUE.test((msg ?? '').toLowerCase())
}

/**
 * Collapse an EMPHATIC elongation before matching: "Noooo" -> "No",
 * "yesss" -> "yes", "nahhh" -> "nah".
 *
 * People stretch a word precisely when they mean it hardest, and \b(no)\b never
 * matched "Noooo". Live 2026-08-07 (QM Sparky, Jeff): at confirm_address the
 * customer answered "NO", "No", then "Noooo". The elongated one parsed as
 * NEITHER affirm nor deny, so nothing cleared the address — and because
 * address_confirmed was already true from the earlier turn, nextRoofingStep
 * went straight to 'ready' and MEASURED the roof the customer had just
 * rejected three times.
 *
 * Runs of 3+ are collapsed to one character, so ordinary doubles are untouched
 * ("all", "correct", "address" all survive); only a deliberate stretch is
 * normalised.
 */
function deEmphasise(text: string): string {
  return (text ?? '').toLowerCase().replace(/([a-z])\1{2,}/g, '$1')
}

export function isAffirmative(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  return AFFIRM.test(t) || AFFIRM.test(deEmphasise(t))
}
export function isNegative(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  return DENY.test(t) || DENY.test(deEmphasise(t))
}

// U5c ("no wait yes" should confirm) was attempted and REVERTED. Three
// independent adversarial reviews each proved that every minimal last-signal /
// strong-flip heuristic false-CONFIRMS a real rejection on the wrong-roof money
// path — a negated weak affirm ("no that isn't correct") or a trailing
// agreement tag ("that's wrong, yeah") is indistinguishable from a genuine flip
// ("no wait yes") by token position alone. The confirm_address branch below
// keeps the proven-safe baseline (isAffirmative && !isNegative); "no wait yes"
// safely re-asks. Doing it correctly needs a real intent classifier, not a
// regex — logged as deferred in specs/sms-roofing-u1-u5.md.

// ── Stop / cancel / opt-out ──────────────────────────────────────────
// Checked FIRST on every turn so the customer can always bail. Bare "no"
// is NOT a stop (it's a valid confirm answer); explicit stop words and
// clear frustration are.
const STOP_RE = /\b(stop|cancel|cancelled|unsubscribe|quit|end this|end the|not interested|leave me alone|go away|never ?mind|forget it)\b/
const FRUSTRATION_RE = /\b(f+u+c+k+|f\*+ck|fck|stfu|piss off|bugger off|bullsh|shut up)\b/
// F11 — "stop"/"end" a LEAK is a roofing outcome the customer wants, not a
// request to end the conversation. Live 2026-07-24: "will the old roof stop
// leaking after this?" cancelled the thread. Carve it out before the opt-out
// check (a genuine opt-out reads "stop", "stop texting me", "let's cancel now").
const STOP_OUTCOME = /\b(stop|end)\b(?:\s+\w+){0,3}\s+(leak\w*|drip\w*|water|rain\w*)\b/

/** PURE — true when the customer wants to stop / cancel / opt out. */
export function isStopRequest(text: string): boolean {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return false
  if (STOP_OUTCOME.test(t)) return false
  return STOP_RE.test(t) || FRUSTRATION_RE.test(t)
}

/**
 * PURE — pull the usable street address out of a reply.
 *
 * Customers label their answer ("Address is 31 greens rd coorparoo", "it's
 * at 670 London Rd"), and that prefix used to be stored verbatim and handed
 * to the geocoder, which then found nothing. Take everything from the first
 * street number onward.
 *
 * The street number is also the validity test. "Address above postcode
 * 4151" carries a postcode but no street number, so it is NOT an address —
 * it was accepted as one on 2026-07-22 and poisoned the whole conversation.
 * Returns null when there's nothing addressable, so the caller re-asks.
 */
export function extractStreetAddress(text: string): string | null {
  // SMS bodies wrap — the match regex's `.` stops at \n, so a two-line
  // address lost everything after the first line. Live 2026-07-23:
  // "15 schfofieod\nDrive" was stored (and confirmed, and measured) as
  // "15 schfofieod". Collapse all whitespace before matching.
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!t || isStopRequest(t)) return null
  // G1 (live 2026-07-25) — prefer the number that BEGINS a plausible street
  // (number + name + a street type/suburb word), so a spurious leading number
  // does not become the street number: "$1 at 670 London Road Chandler" used to
  // extract "1 at 670 London Road…". Falls back to the first number + name.
  const street =
    t.match(/\d[\d/\-a-zA-Z]*\s+[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*)*\s+(?:st|street|rd|road|ave|av|avenue|dr|drive|hwy|highway|pde|parade|ln|lane|ct|court|cres|crescent|pl|place|blvd|boulevard|tce|terrace|way|cl|close|circuit|cct|esplanade|esp)\b.*/i)
  // A street number is digits (optionally 12a, 5/12, 1-3) followed by the
  // street name. A trailing postcode alone can never match.
  const m = street ?? t.match(/\d[\d/\-a-zA-Z]*\s+[A-Za-z].*/)
  if (!m) return null
  // G9 (live 2026-07-27) — an injection payload was stored as the address and
  // echoed verbatim in a customer SMS, carrying it into the job sheet and the
  // dashboard. No real AU address contains ; < or >, so stop there. Apostrophes
  // (O'Connor), slashes (3/50), commas, dots and hyphens are all kept.
  const addr = m[0].split(/[;<>]/)[0].trim().replace(/[\s,'"`]+$/, '').replace(/\s+/g, ' ')
  return addr.length >= 6 ? addr : null
}

/**
 * PURE — carry an address the GENERAL dialog already collected into a
 * roofing flow that is starting cold.
 *
 * The roofing receptionist keeps its own slots (roofing_state), separate
 * from the dialog's (conversation_state). When roofing engages mid-thread
 * — because the opening message missed the detector and only a later one
 * matched — it starts from empty and asks for the address again. Live
 * 2026-07-22 a customer gave "1434 NUMINBAH Road Chillingham NSW 2484",
 * confirmed it, answered the job question, and was then asked for the
 * very same address a second time and made to confirm it twice.
 *
 * CALLER MUST NOT PASS from_memory VALUES. Only values the customer
 * stated in THIS conversation are safe to seed. A from_memory slot comes
 * from the customers row, is keyed on phone number alone, and can hold a
 * suburb from an unrelated earlier job — seeding one here would silently
 * quote the wrong building.
 *
 * `address_confirmed` is deliberately left false: the customer confirmed
 * this address to the dialog, not to us, so we still read it back exactly
 * once before measuring.
 */
export function seedRoofingSlots(
  prev: RoofingSlots,
  general: { address?: string | null; suburb?: string | null } | null | undefined,
): RoofingSlots {
  if (prev.address) return prev
  if (!general) return prev
  const combined = [general.address, general.suburb].filter(Boolean).join(', ')
  const addr = extractStreetAddress(combined)
  if (!addr) return prev
  return {
    ...prev,
    address: addr,
    postcode: parsePostcode(combined),
    state: parseAuState(combined),
    address_confirmed: false,
  }
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
      const addr = extractStreetAddress(msg)
      if (addr) {
        next.address = addr
        const pc = parsePostcode(msg)
        if (pc) next.postcode = pc
        const st = parseAuState(msg)
        if (st) next.state = st
        next.address_confirmed = false
      }
      break
    }
    case 'confirm_address': {
      // A bare postcode COMPLETES the address we read back rather than
      // answering the question — "4151" used to be discarded entirely.
      const barePostcode = msg.trim().match(/^(\d{4})$/)
      if (barePostcode && next.address) {
        next.postcode = barePostcode[1]
        if (!next.address.includes(barePostcode[1])) {
          next.address = `${next.address} ${barePostcode[1]}`
        }
        break
      }
      // A reply carrying a NEW street address is a CORRECTION, not a
      // yes/no. Checked before the affirm/deny test so "Address is 31
      // greens rd coorparoo" replaces the wrong read-back instead of
      // reading as neither and re-asking the identical question.
      const corrected = extractStreetAddress(msg)
      if (corrected && corrected !== next.address) {
        next.address = corrected
        next.postcode = parsePostcode(msg)
        next.state = parseAuState(msg)
        next.address_confirmed = false
        break
      }
      // F15c — a negation cue (deny word OR "not/isn't/n't …") blocks the
      // confirm and re-asks; a plain affirm with no negation still confirms.
      const negated = rejectsReadBack(msg)
      if (isAffirmative(msg) && !negated) {
        next.address_confirmed = true
      } else if (negated) {
        // Customer says it's wrong / unsure — clear so we re-ask the address.
        // addr_verified goes too: it exists to let screenConfirmAddress skip
        // the map check for that exact string, so keeping it re-blesses the
        // address they just refused.
        next.address = null
        next.postcode = null
        next.state = null
        next.addr_verified = null
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
      if (v) {
        next.material = v
        next.metal_hint = false
      } else if (isAmbiguousMetal(msg)) {
        // Understood ("it's metal") but under-specified — ask which profile.
        next.metal_hint = true
      }
      break
    }
    case 'material_profile': {
      const v = mapMaterial(msg)
      if (v) {
        next.material = v
        next.metal_hint = false
      } else {
        // Second go and still no profile named. Never guess between two
        // differently-priced sheets — look at it on site.
        next.material = 'unknown'
        next.metal_hint = false
      }
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

const QUESTIONS: Record<
  Exclude<
    RoofingStep,
    | 'ready'
    | 'inspection'
    | 'confirm_roof'
    | 'await_booking'
    | 'quoted'
    | 'closed'
    // The form-offer opener and its acknowledgement are composed, not
    // gather questions — see buildRoofingFormOffer / AWAIT_FORM_ACK.
    | 'offer_form'
    | 'await_form'
  >,
  string
> = {
  address: "Happy to sort a roofing quote for you. What's the property address, including suburb and postcode?",
  confirm_address: '', // filled dynamically with the address read-back
  intent: 'What do you need done? A full re-roof, a repair or patch, a leak traced, or gutters and downpipes?',
  material: "What's the roof made of? For example Colorbond or metal, concrete or terracotta tiles, or fibro / cement sheet.",
  material_profile:
    'Righto — which Colorbond profile is it? Corrugated (the classic wavy sheets) or Trimdek (flat panels with square ribs)? If you\'re not sure, just say so and we\'ll check it on site.',
  pitch: 'Roughly how steep is the roof? Flat, standard, or steep?',
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
      question: `Just to confirm, the property is "${slots.address}". Is that right? Reply yes or no.`,
    }
  }
  // R5 — a commercial property never gets an auto-sent residential firm price.
  if (slots.commercial) {
    return { step: 'inspection', reason: 'commercial roofs are quoted on site' }
  }
  if (!slots.intent) return { step: 'intent', question: QUESTIONS.intent }
  // The pricer has no rule for an unknown intent — it would silently price
  // whatever the tiers default to. Route it on site instead.
  if (slots.intent === 'unknown') {
    return { step: 'inspection', reason: "we couldn't confirm what work is needed" }
  }

  // Material gate: short-circuit to inspection the moment we learn it's
  // asbestos-suspect or unknown; no point asking pitch in that case.
  if (slots.material === 'cement_sheet') {
    return { step: 'inspection', reason: 'cement sheet or fibro roofs may contain asbestos' }
  }
  if (slots.material === 'unknown') {
    return { step: 'inspection', reason: "we couldn't confirm the roof material" }
  }
  // They told us it's metal but not which profile — ask that, not the
  // generic question again.
  if (!slots.material && slots.metal_hint) {
    return { step: 'material_profile', question: QUESTIONS.material_profile }
  }
  if (!slots.material) return { step: 'material', question: QUESTIONS.material }

  // Pitch gate: same idea for steep or unknown pitch.
  if (slots.pitch === 'very_steep' || slots.pitch === 'unknown') {
    return { step: 'inspection', reason: 'the roof pitch is steep or unknown' }
  }
  if (!slots.pitch) return { step: 'pitch', question: QUESTIONS.pitch }

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
