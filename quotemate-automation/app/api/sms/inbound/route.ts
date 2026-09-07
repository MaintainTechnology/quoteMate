// ─────────────────────────────────────────────────────────────────────
// SMS Agent — Phase 2 (the AI brain).
// Validates Twilio signature, persists inbound, asks the Sonnet dialog
// agent (lib/sms/dialog.ts) what to do next, sends the reply via the
// shared dispatcher (SMS-first / WhatsApp-fallback), persists outbound,
// updates conversation status + assumptions, and on `finish` fires a
// fire-and-forget handoff to /api/intake/structure.
// Phase 1 plumbing (signature validation, dispatcher, hardening) is
// preserved verbatim — the only swap is STATIC_REPLY → decideNextTurn.
// ─────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { randomBytes } from 'node:crypto'
import {
  validateTwilioSignature,
  parseTwilioForm,
} from '@/lib/sms/twilio-validator'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { decideNextTurn, type ConversationTurn } from '@/lib/sms/dialog'
import { toRoofingRequest, seedRoofingSlots, isStopRequest, isNegative, isAffirmative, rejectsReadBack, extractStreetAddress } from '@/lib/sms/roofing-intake'
import { screenConfirmAddress, verifyAuAddress, gateUnverifiedProfileAddress, lastOutboundAskedAddress, consumeAddressRejection } from '@/lib/sms/verify-address'
import {
  advanceRoofing,
  confirmedIncludedIndices,
  shouldEngageRoofing,
  closeStaleRoofingState,
  expireIdleRoofingState,
  roofingTurnInput,
  isActiveRoofingFlow,
  type RoofingConversationState,
} from '@/lib/sms/roofing-receptionist'
import { generalDialogIsMidGather } from '@/lib/sms/general-gather'
import {
  applySolarToTiers,
  buildRoofingReplyMessage,
  composeBookingMessage,
  composeCancelMessage,
  composeConfirmMessage,
  composeInspectionReasonMessage,
  composeMeasureUnavailableMessage,
  shouldSendRoofInspectionMessage,
  narrowQuoteToStructures,
} from '@/lib/sms/roofing-compose'
import {
  llmReceptionistEnabled,
  buildTenantFacts,
  composeDeflect,
  roofingTurnViaLlm,
  paintingTurnViaLlm,
  type TenantFacts,
  type TurnCarry,
} from '@/lib/sms/llm-receptionist'
import { enforceDialogGrounding, composeInspectionOffer } from '@/lib/sms/dialog-grounding'
import { rulesAsText } from '@/lib/sms/assumptions'
import { asQuoteTierMode, type QuoteTierMode } from '@/lib/quote/tier-visibility'
import { ensureRoofQuotePdf, roofQuotePdfUrl, signQuotePdfUrl } from '@/lib/quote/pdf'
import { quotePdfMmsEnabled } from '@/lib/sms/send-quote-pdf'
import {
  notifyRoofingTradie,
  roofingBookingDetailsUrl,
  type RoofingNotifyKind,
} from '@/lib/sms/roofing-notify'
import { archiveAndIngestQuote } from '@/lib/filestore/ingest-quote'
import { buildQuoteKbText } from '@/lib/filestore/minimize'
import {
  measureAndDispatchRoofing,
  sendRoofPhotoMms,
  ROOFING_APP_BASE_URL,
} from '@/lib/sms/roofing-measure-dispatch'
import { newMeasurementTokens } from '@/lib/roofing/tokens'
import { generateRoofAfterImage } from '@/lib/roofing/roof-after'
import { tenantHasRoofingTrade, tenantIsRoofingOnly } from '@/lib/roofing/tenant'
import { tenantHasFeature } from '@/lib/features/catalog'
import type { MultiRoofQuote } from '@/lib/roofing/types'
import {
  advancePainting,
  shouldEngagePainting,
  expireIdlePaintingState,
  isActivePaintingFlow,
  paintingTurnIsDeterministic,
  type PaintingConversationState,
} from '@/lib/sms/painting-receptionist'
import {
  buildPaintingFormOffer,
  buildPaintingInspectionSms,
  composePaintingBooking,
  composePaintingCancel,
} from '@/lib/sms/painting-compose'
import { estimateAndDispatchPainting } from '@/lib/sms/painting-estimate-dispatch'
import {
  formatActiveFollowupContext,
  parseFollowupQuoteContext,
  isFollowupContextActive,
} from '@/lib/sms/followup-context'
import { buildGpoInspectionOverride } from '@/lib/sms/gpo-guard'
import {
  resolveEnabledSharedAssembliesForDialog,
  type ServiceOfferingScopeRow,
  type SharedAssemblyScopeRow,
} from '@/lib/sms/service-scope'
import { isQuoteInflight } from '@/lib/sms/inflight'
import { quoteAlreadyDrafted as computeQuoteAlreadyDrafted } from '@/lib/sms/quote-already-drafted'
import {
  shouldSendPhotoRequest as computeShouldSendPhotoRequest,
  customerAskedForPhotoLink,
} from '@/lib/sms/photo-request-trigger'
import { stripLinkPromise } from '@/lib/sms/dialog-grounding'
import {
  evaluateQuoteReadiness,
  clarifyingEnforcementEnabled,
  clarifyingTurnCap,
  decideClarifyGate,
  photoDeclined,
} from '@/lib/sms/quote-readiness'
import { extractAndStoreMmsPhotos } from '@/lib/sms/mms'
import { buildPhotoRequestSms, buildQuoteFailureSms } from '@/lib/sms/templates'
import { withRetry } from '@/lib/util/retry'
import {
  findOrCreateCustomer,
  formatCustomerContext,
  writeCustomerCorrections,
  type CustomerProfile,
} from '@/lib/customers/lookup'
import { customerMemoryAllowed, stripCustomerMemory } from '@/lib/customers/memory-scope'
import {
  extractSlots,
  mergeSlotUpdates,
  normaliseState,
  PERSISTENT_PROFILE_SLOTS,
  seedStateFromKnownFields,
  type ConversationState,
  type PersistentProfileSlot,
} from '@/lib/sms/extract-slots'
import { classifyIntent } from '@/lib/sms/intent'
import { createOrGetActiveIntent } from '@/lib/onboard/intent-tokens'
import { checkInvitationCode } from '@/lib/onboard/invitation-codes'
import {
  buildTradieWelcomeSms,
  buildTradieIntentStillOpenSms,
} from '@/lib/sms/templates'
import { sendSms } from '@/lib/sms/twilio'
import {
  applyChoiceSelection,
  selectProductOptions,
  buildProductOptionsSms,
  buildChoiceHoldSms,
  categoryForJobType,
  productChoiceAllowedForSupply,
  weatherproofAdvisory,
  type ProductChoiceState,
} from '@/lib/sms/product-options'
import type { TenantMaterial } from '@/lib/estimate/catalogue'
import { deriveTradeFromJobType } from '@/lib/intake/schema'
import { recordTrace } from '@/lib/log/trace'
import {
  getDeliveryKnobs,
  retryWithBackoff,
  logSendOutcome,
  adaptiveDebounceMs,
  dedupeConsecutiveReply,
  type PipelineLoggerLike,
} from '@/lib/sms/send-reliability'
import {
  decideSidDedup,
  classifyInboundInsert,
  decideConversationUpsert,
  arrivalTimestampsFromTurns,
  hasUnrepliedInbound,
  throwIfDispatchFailed,
  sideEffectsAllowed,
  isNearMaxDuration,
  isGlobalOptOut,
  OPT_OUT_CONFIRMATION,
} from '@/lib/sms/inbound-helpers'

// R42/R44/R46/R49 — SMS delivery knobs resolved once at module load. These
// are env-tunable (SMS_MAX_DURATION / SMS_DEBOUNCE_MS / SMS_SEND_*) with safe
// defaults + clamps; see lib/sms/send-reliability.ts. maxDuration MUST be a
// static module export (Next.js reads it at build/route-registration time, not
// per-request), so we derive it here rather than inside the handler.
const DELIVERY_KNOBS = getDeliveryKnobs(process.env)

// Lightweight pipeline-logger shim for logSendOutcome — the inbound route logs
// via console (no pipelineLog() instance threaded through here), so we adapt
// console to the PipelineLoggerLike shape the helper expects.
const sendLogger: PipelineLoggerLike = {
  ok: (event, data) => console.log(`[sms/inbound:send] ${event}`, data ?? {}),
  err: (event, error, data) => console.error(`[sms/inbound:send] ${event}`, { error: error instanceof Error ? error.message : error, ...(data ?? {}) }),
  step: (event, data) => console.log(`[sms/inbound:send] ${event}`, data ?? {}),
}

// WP9 — mid-conversation product options. Every WP9 block in this route
// is wrapped in this flag; OFF (default) ⇒ byte-identical behaviour.
const WP9_ENABLED = process.env.WP9_PRODUCT_OPTIONS === '1'

// SMS roofing receptionist — gathers roofing inputs over SMS, runs the
// roofing measure/price pipeline, and replies with an MMS (roof image +
// quote-page link).
//
// This env flag is now only the NO-TENANT fallback (dev shared number, or
// an inbound whose destination maps to no tenant). When the destination
// DOES resolve to a tenant, the gate is that tenant's own `trades[]` —
// i.e. the roofing toggle the tradie/admin flips in account settings is
// what turns the SMS roofing receptionist on for their number. Before
// 2026-07-22 this was a deployment-global flag that never read
// tenants.trades at all, so enabling roofing on an account did nothing
// for SMS. Requires migration 085 (sms_conversations.roofing_state +
// roofing_measurements.public_token).
const SMS_ROOFING_ENABLED = process.env.SMS_ROOFING_ENABLED === '1'

// SMS painting receptionist — gathers residential painting inputs over SMS
// (offering the self-serve form link first), runs the deterministic painting
// estimate, and replies with the G/B/B quote link. Flag-gated; OFF (default)
// ⇒ byte-identical behaviour. Requires migration 154 (sms_conversations
// .painting_state + painting_lead_requests).
const SMS_PAINTING_ENABLED = process.env.SMS_PAINTING_ENABLED === '1'

// Defined in lib/sms/roofing-measure-dispatch.ts (imported above) so the
// voice handover builds byte-identical /q/roof links.

// Twilio webhook ack. We send the real customer reply via the REST API
// inside after() — never as TwiML in the webhook response — so this
// endpoint must return an EMPTY <Response/> document. If the body is
// non-TwiML text (e.g. "ok"), Twilio's messaging webhook will treat it
// as a reply and SMS it back to the customer, producing a phantom "ok"
// bubble before the agent's actual greeting. Empty TwiML = no auto-reply.
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>'
function ackTwiml() {
  return new Response(TWIML_EMPTY, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

/** Pull an invitation code from a registration text. Accepts
 *  "JOIN <code>" / "join <code>" or a bare hyphenated code token.
 *  Returns the upper-cased code or null. */
function parseJoinCode(body: string): string | null {
  const trimmed = (body ?? '').trim()
  const m = trimmed.match(/^\s*join\s+([A-Za-z0-9-]{3,60})\s*$/i)
  if (m) return m[1].toUpperCase()
  // Bare single-token code (no spaces) that looks like our format.
  if (/^[A-Za-z0-9]{2,8}(-[A-Za-z0-9]+){1,4}$/.test(trimmed)) return trimmed.toUpperCase()
  return null
}

// SMS-auto-quoteable jobs benefit from a photo before Opus drafts the
// quote. Out-of-scope jobs go straight to inspection so a photo prompt
// would be off-message. v5 multi-trade: union of electrical easy-5 +
// plumbing easy-5.
const EASY_5_JOB_TYPES = new Set([
  // electrical
  'downlights',
  'power_points',
  'ceiling_fans',
  'smoke_alarms',
  'outdoor_lighting',
  // plumbing (v5)
  'blocked_drain',
  'hot_water',
  'tap_repair',
  'tap_replace',
  'toilet_repair',
  'toilet_replace',
])

// Job types allowed to be sent the photo-upload link. A SUPERSET of the easy-5
// (spec ev-charger-location-photo R7): EV charger needs a photo of the spot the
// charger is going, but it must NOT join EASY_5_JOB_TYPES itself — that set
// also drives assumption rules and quoting behaviour, and EV has its own.
const PHOTO_ELIGIBLE_JOB_TYPES = new Set([...EASY_5_JOB_TYPES, 'ev_charger'])

// Best-effort first-name guess from a customer's SMS turn. Used only
// for the photo-request SMS greeting — Opus does the authoritative
// extraction in structureIntake later. We look for a turn that's 1-3
// words, mostly letters, no digits (so "6 downlights" or "Bondi" don't
// match as names). Returns null if we can't be confident.
// Words that look like names but aren't — common answers to dialog questions
// that match the "1-3 words, letters only" shape. Anything matching these in
// any position (case-insensitive, individual word level) disqualifies the
// turn as a name candidate.
const NON_NAME_WORDS = new Set([
  // greetings / acks
  'hi', 'hey', 'yo', 'ok', 'okay', 'yes', 'yeah', 'nope', 'no',
  'cheers', 'ta', 'thanks', 'thank', 'sure', 'please',
  // suburbs / cities
  'bondi', 'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide',
  'hobart', 'darwin', 'canberra', 'newcastle', 'gold', 'coast',
  // colours / lighting answers
  'warm', 'cool', 'white', 'black', 'colour', 'color', 'tri',
  'tricolour', 'tricolor', 'dimmable', 'smart', 'standard', 'led',
  // ceiling / wall / access answers
  'flat', 'raked', 'high', 'plaster', 'brick', 'concrete', 'tile',
  'access', 'available', 'roof', 'ceiling',
  // roofing answers — "Thanks Colorblind." went out to a live customer on
  // 2026-07-22 because an autocorrected material answer shape-matched a name.
  'colorbond', 'colourbond', 'colorblind', 'colourblind', 'bond',
  'trimdek', 'corrugated', 'corro', 'spandek', 'kliplok', 'zincalume',
  'terracotta', 'tiles', 'iron', 'galv', 'galvanised', 'fibro', 'asbestos',
  'slate', 'shingles', 'steep', 'steeper', 'shallow', 'skillion', 'pitch',
  'reroof', 'gutters', 'downpipes', 'dwelling', 'shed', 'garage', 'address',
  // scope / yes-no answers
  'replacing', 'replace', 'existing', 'new', 'install', 'indoor',
  'outdoor', 'fitted', 'wired', 'wiring', 'flat',
  // ── Trade-specific terms (plumbing) — added 2026-05-13 ──────────
  // A customer answering "LPG bottle" to a gas-type question was being
  // mis-extracted as first_name="LPG" by guessFirstName(), producing
  // a photo SMS that opened with "LPG, photos help us…" instead of
  // "James, photos help us…". Block every plumbing fixture / fuel /
  // location word that could shape-match a one-or-two-word name.
  'gas', 'lpg', 'electric', 'natural', 'bottle', 'mains',
  'hot', 'water', 'hws', 'heat', 'pump', 'storage', 'continuous',
  'flow', 'instant', 'instantaneous', 'tankless',
  'blocked', 'drain', 'pipe', 'leak', 'leaking', 'dripping',
  'toilet', 'cistern', 'tap', 'taps', 'mixer', 'faucet', 'spout',
  'washer', 'kitchen', 'bathroom', 'ensuite', 'laundry', 'garage',
  'shower', 'basin', 'bath',
  // ── Trade-specific terms (electrical) ─────────────────────────────
  'downlight', 'downlights', 'gpo', 'gpos', 'powerpoint', 'powerpoints',
  'socket', 'sockets', 'outlet', 'outlets', 'fan', 'fans',
  'alarm', 'alarms', 'smoke', 'switchboard', 'switch', 'board',
  'rcbo', 'rcd', 'oven', 'cooktop', 'stove', 'rangehood',
  'wifi', 'wi-fi',
])

// Best-effort first-name guess from prior customer turns. We iterate
// Migration 032 — normalise a row's clarifying_questions jsonb into a
// clean string[] (or null). Postgres jsonb arrives as a parsed JS value
// via supabase-js; we defensively handle array / null / undefined / a
// stray JSON string, drop blanks, and trim. null when there's nothing
// usable → the dialog falls back to universal name+suburb+scope only.
function normaliseQuestions(v: unknown): string[] | null {
  let arr: unknown = v
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr) } catch { return null }
  }
  if (!Array.isArray(arr)) return null
  const out = arr
    .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    .map((q) => q.trim())
  return out.length > 0 ? out : null
}

// NEWEST → OLDEST so the most recent legitimate name candidate wins —
// otherwise an early answer like "Warm White" gets picked before the
// customer's actual name later in the dialog. Returns null if nothing
// looks like a name.
function guessFirstName(turns: ConversationTurn[]): string | undefined {
  const inbound = turns.filter(t => t.direction === 'inbound')
  // Iterate in REVERSE so most recent inbound is checked first.
  for (let i = inbound.length - 1; i >= 0; i--) {
    const trimmed = inbound[i].body.trim()
    // 1-3 words, only letters + spaces + hyphens (Anne-Marie OK), no digits.
    if (
      !/^[A-Za-z][A-Za-z\- ]{0,30}$/.test(trimmed) ||
      trimmed.split(/\s+/).length > 3
    ) continue
    // Disqualify if ANY word is in the non-name list — catches "Warm White",
    // "Flat Plaster", "Cool White", "tri colour" etc. that would otherwise
    // shape-match a name.
    const words = trimmed.toLowerCase().split(/\s+/)
    if (words.some(w => NON_NAME_WORDS.has(w))) continue
    return trimmed.split(/\s+/)[0]
  }
  return undefined
}

// Allow the after() block enough time for the full SMS pipeline:
// slot extraction (Sonnet 4.6) + dialog (Sonnet 4.6) + possibly intake
// structure (Opus 4.7) + estimator draft (Opus + RAG + tools) + image
// gen + Twilio dispatch + DB writes. Worst-case "finish" turn ran ~200s
// in stress tests; 60s killed it mid-pipeline (returning power users
// with slot-extraction retries cleared the budget before step 6).
// Vercel Pro serverless cap = 300s; Fluid Compute = 800s. The inline
// path still returns TwiML in <500ms so Twilio is happy regardless.
//
// R42 — sourced from getDeliveryKnobs (env SMS_MAX_DURATION, default 300,
// clamped to [5,800]) so the budget can be raised toward the Fluid-Compute
// ceiling without a code change when the worst-case dialog+intake+estimate+
// dispatch pipeline approaches the cap. The after() block also self-monitors
// via isNearMaxDuration and emits an `after_near_max_duration` alert; that
// alert firing repeatedly is the signal that a TRUE offload (durable queue /
// QStash worker) — not just a bigger cap — is required, since a serverless
// function can never exceed 800s. See the FLAGGED note in the task report.
// Next requires route-segment configs to be STATICALLY-ANALYZABLE LITERALS —
// a computed value (getDeliveryKnobs().maxDurationSec) is silently ignored
// ("Invalid segment configuration export"). So the function budget is a literal
// here (300s = the platform default ceiling; raise to up to 800 on Vercel
// Pro/Fluid by editing this literal). The env knob (SMS_MAX_DURATION) still
// drives the runtime near-timeout self-monitor + debounce/retry tuning below.
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// Graceful fallback if the dialog agent throws — the customer still gets
// a reply rather than silence.
/**
 * Personalised fallback reply for when the dialog Sonnet call throws
 * (Anthropic 5xx, timeout, schema-validation rejection, etc.). Static
 * "we'll get back to you shortly" was confusing for returning customers
 * who'd just given their name + scope — they'd say "hi" and get a
 * bland brush-off. Now we acknowledge whatever we DID extract this
 * turn (name + job context) so the customer knows we're tracking them
 * even when the AI brain crashed.
 */
function buildDialogFallbackReply(opts: {
  firstName?: string | null
  jobType?: string | null
}): string {
  const first = (opts.firstName ?? '').split(' ')[0] || ''
  const jt = opts.jobType ?? null
  const namePart = first ? ` ${first}` : ''
  // Map a known job_type into a short customer-facing phrase.
  const jobPhrase = (() => {
    if (!jt || jt === 'unknown' || jt === 'other') return null
    if (jt === 'downlights') return 'the downlights'
    if (jt === 'power_points') return 'the GPOs / power points'
    if (jt === 'ceiling_fans') return 'the fans'
    if (jt === 'smoke_alarms') return 'the smoke alarms'
    if (jt === 'outdoor_lighting') return 'the outdoor lights'
    if (jt === 'blocked_drain') return 'the blocked drain'
    if (jt === 'hot_water') return 'the hot water system'
    if (jt === 'tap_repair' || jt === 'tap_replace') return 'the tap work'
    if (jt === 'toilet_repair' || jt === 'toilet_replace') return 'the toilet job'
    return null
  })()
  if (jobPhrase) {
    return `Cheers${namePart} - we've got ${jobPhrase} noted and our system hit a quick snag on this turn. Give us a minute and we'll be back to confirm.`
  }
  return first
    ? `Cheers ${first} - hit a quick snag on this turn. Give us a moment and we'll be right back.`
    : "Thanks - we'll be right back to confirm details, just a quick snag on our end."
}

/**
 * Phase 1b — the MUST-ASK rules for a job type, used to ground the legitimate
 * spec numbers a real question contains (e.g. the 600 mm wet-area clearance).
 * Returns '' for a job type that has no rules rather than throwing, so an
 * unmapped guess can never break a turn.
 */
function safeRulesAsText(jobType: string): string {
  try {
    return rulesAsText(jobType as Parameters<typeof rulesAsText>[0]) ?? ''
  } catch {
    return ''
  }
}

// ─────────────────────────────────────────────────────────────────────
// SMS roofing receptionist — deterministic per-turn handler.
//
// Returns true when it handled the turn (the caller then returns from
// after() and skips the electrical/plumbing Sonnet dialog). Only engages
// when SMS_ROOFING_ENABLED and either the conversation is already a
// roofing flow or an inbound looks like a roofing enquiry. All pure
// decision logic lives in lib/sms/roofing-{intake,receptionist,compose};
// this does the I/O (measure, persist, dispatch).
// ─────────────────────────────────────────────────────────────────────
async function handleRoofingTurn(args: {
  conversationId: string
  roofingStateRaw: unknown
  /** Closes the hijack class: true when the general dialog already gathered
   *  a trade-specific slot from this thread. Gates the KEYWORD arm only. */
  generalMidGather: boolean
  turns: ConversationTurn[]
  toNumber: string
  fromNumber: string
  tenantId: string | null
  /** tenants.trade — picks the pricing_book row the roofing rate card sits
   *  on. Same argument /api/roofing/save passes, so SMS and the dashboard
   *  resolve the SAME card. A cross-trade tenant keeps its roofing card on
   *  its primary-trade row (e.g. Atomic Electrical's sits on 'electrical'),
   *  so passing a literal 'roofing' here would miss it. */
  tenantTrade: string | null
  firstName: string | null
  followupPinActive: boolean
  /** Tenant does roofing and nothing else — engage without needing a
   *  roofing keyword, since there is no other trade to route to. */
  roofingOnly: boolean
  /** Address the GENERAL dialog already collected in THIS conversation, so
   *  a mid-thread roofing engage doesn't re-ask it. The caller must strip
   *  from_memory slots first — see seedRoofingSlots. */
  generalAddress?: { address?: string | null; suburb?: string | null } | null
  /** Grounded tenant facts for the LLM receptionist (business name, owner
   *  first name, trades, state). Absent ⇒ the LLM path cannot run. */
  tenantFacts?: TenantFacts | null
}): Promise<boolean> {
  const { conversationId, turns, toNumber, fromNumber, tenantId, tenantTrade, firstName, followupPinActive } = args
  const prevStateRaw = (args.roofingStateRaw ?? null) as RoofingConversationState | null
  // Seed only a COLD flow (no roofing slots yet). An in-progress roofing
  // conversation owns its own address and must never be overwritten.
  const prevState: RoofingConversationState | null = prevStateRaw
    ? { ...prevStateRaw, slots: seedRoofingSlots(prevStateRaw.slots ?? {}, args.generalAddress) }
    : (args.generalAddress
        ? { slots: seedRoofingSlots({}, args.generalAddress), last_step: null }
        : null)

  // P3 — a rapid burst (all inbounds since our last outbound) is coalesced so
  // the ENGAGEMENT check sees the whole burst (a multi-message opener like "can
  // you do my roof" | "670 London Road…" | "its colorbond" engaged the general
  // LLM because only the last line was tested). The DECISION input, though, is
  // the whole burst only on a cold start (harvest the opener's address) and the
  // NEWEST line alone on an active flow — so a stray digit or deny token in an
  // earlier burst line can't hijack a structure pick or flip a booking.
  const { engage, decision: decisionInput } = roofingTurnInput(prevState?.last_step, turns)

  // Engage only if we're in an ACTIVE roofing flow (mid-gather / awaiting
  // a reply), or THIS message reads like a roofing enquiry. A closed flow
  // (quote sent / cancelled / booked) is NOT active, so an unrelated
  // follow-up never re-quotes — only a fresh roofing enquiry reopens it.
  // When a follow-up pin is active the thread was just chased about a
  // DIFFERENT quote, so a stale roofing_state must not resume — only a
  // genuinely new roofing enquiry may engage (spec 2026-07-05 Part A2).
  if (
    !shouldEngageRoofing(prevState, engage, followupPinActive, args.roofingOnly, args.generalMidGather)
  )
    return false

  // ── The conversation layer. Flag OFF (the default) ⇒ exactly the call
  // this route has always made, and not one extra token spent. Flag ON ⇒
  // Sonnet 5 decides the turn and picks a tool, and ANY failure — a throw,
  // a timeout, an unusable shape, or a figure the model invented — returns
  // the deterministic decision for this turn instead. The I/O below is
  // untouched either way, which is what keeps every price coming out of
  // measureAndPriceRoofs + the roofing composer.
  const useLlm = !!args.tenantFacts && llmReceptionistEnabled(tenantId)
  const turn = useLlm
    ? await roofingTurnViaLlm({
        prev: prevState,
        inbound: decisionInput,
        history: turns,
        facts: args.tenantFacts as TenantFacts,
      })
    : null
  if (turn) {
    console.log('[sms/inbound:roofing] LLM receptionist turn', {
      conversationId,
      source: turn.source,
      action: turn.decision.action,
    })
  }
  let decision = turn ? turn.decision : advanceRoofing(prevState, decisionInput)
  const carry: TurnCarry = turn?.carry ?? {}

  // ── Re-measure guard on an already-quoted thread ──────────────────────
  //
  // advanceRoofing's warm-'quoted' arm (roofing-receptionist.ts (3.5)) is the
  // rule that decides whether a post-quote message is a structure follow-up, a
  // NEW address, a question about the quote we just sent, or a genuine new job
  // — and hands everything else back with 'passthrough'. That arm is only
  // reachable on the deterministic path. With the LLM driving (the default)
  // NOTHING enforced it, because the line above takes turn.decision verbatim.
  //
  // Live 2026-08-07 (QM Sparky, Jeff, 12 Smith St). On a 'quoted' thread the
  // model answered "Lets just do texting", "Lets do painting its painting not
  // roofing mate" and "Are you doing roofing?" by MEASURING: a Geoscape call, a
  // new roofing_measurements row and a fresh quote SMS on every one. Four rows
  // for one property (0e188f7a, 118d90fc, 268266af, 8b63913e) and the customer
  // never reached painting.
  //
  // Deciding to SPEND — an external measure call, a minted row, another quote
  // text — is not a conversational judgement, so it is not the model's to make.
  // Same rule as prices: the model picks words, a deterministic path authorises
  // the action. The LLM keeps every other decision on this turn.
  // The trigger is SAME PROPERTY, not last_step. Three separate mapRoofingTool
  // arms reach measure — ask_for_detail, verify_address and
  // measure_and_price_roof — because nextRoofingStep() is slot-only and never
  // sees last_step, so a thread whose brief is already complete reports 'ready'
  // forever. Keying on last_step==='quoted' missed the transcript's 3rd and 4th
  // mints, which fired from 'confirm_roof' (the state a re-measure leaves).
  //
  // Measured across every state this thread passed through, advanceRoofing
  // returns measure/inspection for NONE of these turns — so deferring to it
  // cannot lose a legitimate measurement. A DIFFERENT address is untouched:
  // pricing a second property is a real job and must still measure, which is
  // also what keeps this from dead-locking a re-gather.
  const normAddr = (a: unknown): string =>
    typeof a === 'string' ? a.toLowerCase().replace(/[^a-z0-9]+/g, '') : ''
  const measuredAddr = normAddr(prevState?.slots?.address)
  const targetAddr = normAddr((decision as { slots?: { address?: string } }).slots?.address)
  const sameProperty = !!prevState?.pending_quote_token && !!measuredAddr && measuredAddr === targetAddr

  if (turn && sameProperty && (decision.action === 'measure' || decision.action === 'inspection')) {
    const deterministic = advanceRoofing(prevState, decisionInput)
    if (deterministic.action !== 'measure' && deterministic.action !== 'inspection') {
      console.warn('[sms/inbound:roofing] LLM re-measured a property this thread already holds — deterministic decision wins', {
        conversationId,
        llmAction: decision.action,
        deterministicAction: deterministic.action,
        lastStep: prevState?.last_step ?? null,
        inbound: decisionInput.slice(0, 80),
      })
      decision = deterministic
    }
  }

  // ── "No" at confirm_address must ALWAYS clear the address ─────────────
  //
  // The route re-runs screenConfirmAddress for EVERY turn whose step is
  // confirm_address (see the ask arm below), which regenerates the read-back
  // "Just to confirm, the property is X. Is that right?". So if the model keeps
  // answering a rejection with another confirm_address ask carrying the SAME
  // address, the customer is asked the identical question forever with no miss
  // budget spent and no way out.
  //
  // Live 2026-08-07 (QM Sparky, Jeff): "NO" -> "No" -> "Noooo" -> "No", each
  // answered with the same read-back for 12 Smith St. advanceRoofing gets this
  // right — a negative clears slots.address and returns step 'address' — but
  // that arm is unreachable while the LLM drives.
  //
  // Whether a rejection clears the rejected value is not a conversational
  // judgement; it is the loop's only exit. The model keeps every other turn.
  //
  // ⚠ Keyed on the TRANSCRIPT, not on last_step. The second incident that day
  // had the read-back going out with last_step at 'closed', so this guard —
  // and every other consumer of a rejection — was dead code
  // (specs/address-confirm-loop.md). lastOutboundAskedAddress cannot be stale:
  // it reads what we actually sent.
  //
  // ⚠ And it does NOT delegate the decision back to advanceRoofing. That is
  // step-keyed too: on the incident state it "agreed" only because last_step
  // 'closed' makes it reset the whole gather, and on a stale mid-gather step
  // it would not agree at all. consumeAddressRejection IS the shared budget —
  // call it directly, and skip only when this turn already spent it (the
  // counter is the evidence; nothing else moves it).
  const askedAddressLastTurn =
    prevState?.last_step === 'confirm_address' || lastOutboundAskedAddress(turns)
  const rejectionConsumed =
    (decision.slots.addr_confirm_rejects ?? 0) > (prevState?.slots?.addr_confirm_rejects ?? 0)
  if (
    askedAddressLastTurn &&
    !rejectionConsumed &&
    !isAffirmative(decisionInput) &&
    rejectsReadBack(decisionInput) &&
    !extractStreetAddress(decisionInput) &&
    decision.action !== 'passthrough' &&
    decision.action !== 'cancel'
  ) {
    console.warn('[sms/inbound:roofing] a rejection of the address read-back was not consumed — forcing the shared budget', {
      conversationId,
      llmAction: decision.action,
      llmStep: 'step' in decision ? decision.step : null,
      lastStep: prevState?.last_step ?? null,
      inbound: decisionInput.slice(0, 80),
    })
    const r = consumeAddressRejection(decision.slots)
    decision = {
      action: 'ask',
      slots: r.slots,
      step: r.step,
      reply: r.reply,
      ...(r.handoff ? { handoff: true as const } : {}),
    }
  }

  // Reply FROM the number the customer texted (the tradie's own
  // provisioned number) — same as every other reply in this route. Never
  // the shared/office number, or the customer sees a stranger's number.
  const replyFrom = toNumber
  // The newest thing we already said. Updated as we send, because one turn can
  // send more than once (quote + follow-up).
  let lastSent = turns.filter((t) => t.direction === 'outbound').at(-1)?.body ?? null
  const sendReply = async (text: string, mediaUrl?: string) => {
    // ── Never the same message twice in a row (spec req 5) ──────────────
    // The backstop, not the fix: every known cause is closed upstream, and
    // this is what makes the NEXT variant of the bug visible instead of
    // silent. Prefixed rather than dropped — a customer who gets nothing is
    // worse off than one who gets an apology with the question.
    const { body, repeated } = dedupeConsecutiveReply(text, lastSent)
    if (repeated) {
      console.error('[sms/inbound:roofing] composed a byte-identical repeat reply - see specs/address-confirm-loop.md', {
        conversationId,
        body: text.slice(0, 120),
      })
    }
    lastSent = body
    const res = await dispatchQuoteMessage({ to: fromNumber, text: body, from: replyFrom, mediaUrl })
    // supabase-js RESOLVES {data, error} on failure — a bare await here made
    // a failed insert invisible, and the repeat backstop above reads this
    // history on the next turn.
    const { error: logError } = await supabase.from('sms_messages').insert({
      conversation_id: conversationId,
      direction: 'outbound',
      body,
    })
    if (logError) {
      console.error('[sms/inbound:roofing] outbound sms_messages insert failed', logError)
    }
    return res
  }
  const persist = async (state: RoofingConversationState, status: 'open' | 'done') => {
    try {
      // declined_trades / booking_reask are conversation-scoped memory, not
      // per-step state: every branch below writes its own explicit shape
      // (several of them reset slots to {}), so without carrying these
      // forward a refusal would be forgotten the moment the flow closed —
      // which is the bug this exists to fix. `carry` (this turn) wins over
      // the previous value; both are absent on the deterministic path, so
      // the flag-OFF write is byte-identical to before.
      const merged: RoofingConversationState = {
        ...(prevState?.declined_trades ? { declined_trades: prevState.declined_trades } : {}),
        ...(prevState?.booking_reask != null ? { booking_reask: prevState.booking_reask } : {}),
        ...(prevState?.pending_lead_measure_token
          ? { pending_lead_measure_token: prevState.pending_lead_measure_token }
          : {}),
        ...state,
        ...carry,
      }
      // booking_reask counts re-asks of ONE booking question. Carrying it
      // past that question would let a later enquiry in the same thread
      // auto-confirm on its FIRST unclear reply.
      if (merged.last_step !== 'await_booking') delete merged.booking_reask
      // Same scope for the lead handle: it names the job THIS booking question
      // is about. A re-ask must keep it (the tradie notify fires on the turn
      // after), anything past await_booking must not.
      if (merged.last_step !== 'await_booking') delete merged.pending_lead_measure_token
      // supabase-js RESOLVES {data, error} on failure — it does not throw, so
      // the try/catch below never saw a rejected write. Every bound this flow
      // owns (addr_confirm_rejects, misses, booking_reask) rides in this jsonb:
      // a silently-dropped update restarts every counter at zero next turn,
      // which is precisely how a bounded loop keeps not ending
      // (specs/address-confirm-loop.md).
      const { error: persistError } = await supabase
        .from('sms_conversations')
        .update({ roofing_state: merged, status, last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', conversationId)
      if (persistError) {
        console.error('[sms/inbound:roofing] roofing_state persist FAILED - counters will restart next turn', {
          conversationId,
          lastStep: merged.last_step ?? null,
          error: persistError,
        })
      }
    } catch (e) {
      console.warn('[sms/inbound:roofing] roofing_state persist failed (migration 085?)', e)
    }
  }
  const baseUrl = ROOFING_APP_BASE_URL
  // US-002 — tell the tradie a roofing lead just happened (quote delivered /
  // inspection booked). Best-effort, never blocks or breaks the customer
  // send: before this, roofing leads landed in the DB and nobody was told.
  const notifyTradie = async (
    kind: RoofingNotifyKind,
    address: string,
    betterIncGst: number | null,
    quoteUrl: string,
    question?: string,
  ) => {
    try {
      const { data: t } = tenantId
        ? await supabase
            .from('tenants')
            .select('owner_mobile, owner_first_name, twilio_sms_number')
            .eq('id', tenantId)
            .maybeSingle()
        : { data: null }
      const row = (t as {
        owner_mobile?: string | null
        owner_first_name?: string | null
        twilio_sms_number?: string | null
      } | null) ?? null
      await notifyRoofingTradie({
        kind,
        tenant: {
          owner_mobile: row?.owner_mobile ?? null,
          owner_first_name: row?.owner_first_name ?? null,
          twilio_sms_number: row?.twilio_sms_number ?? null,
        },
        customerName: firstName,
        customerPhone: fromNumber,
        address,
        betterIncGst,
        quoteUrl,
        question,
        dispatch: (o) => dispatchQuoteMessage({ to: o.to, text: o.text, from: o.from, audience: 'tradie', tenantId }),
      })
    } catch (e) {
      console.warn('[sms/inbound:roofing] tradie notify failed (non-fatal)', e)
    }
  }
  const loadPending = async (token: string | null) => {
    if (!token) return null
    const { data } = await supabase
      .from('roofing_measurements')
      .select('address, quote')
      .eq('public_token', token)
      .maybeSingle()
    const quote = (data?.quote ?? null) as MultiRoofQuote | null
    if (!data || !quote) return null
    return { address: (data.address as string) ?? '', quote, token }
  }

  // ── Passthrough → hand the turn to the general LLM dialog (return false).
  // Two cases, distinguished by the state we came from:
  //   • Warm 'quoted' thread: CLOSE the roofing thread so the warm window
  //     ends here — otherwise a later number in an interleaved electrical
  //     chat ("how many?" → "2") would be hijacked as a structure pick.
  //   • Mid-GATHER bail (a topic switch / interrupt / question, 2026-07-24):
  //     do NOT close — leave the gather state so the customer's next
  //     roofing answer resumes exactly where they left off (the general
  //     dialog handles just this one turn). Closing here would silently
  //     discard everything gathered so far.
  if (decision.action === 'passthrough') {
    // F6 — a genuine topic switch to another trade (decision.close) closes the
    // roofing gather so the next message stays with the general dialog instead
    // of bouncing back to the roofing intent. A warm 'quoted' thread also closes.
    // An interrupt/question bail leaves the gather intact (resume-able).
    if (decision.close || prevState?.last_step === 'quoted') {
      await persist({ slots: {}, last_step: 'closed', pending_quote_token: null, pending_structure_count: null }, 'open')
    }
    return false
  }

  // ── Customer asked to stop / cancel — close politely; no re-quote. ──
  if (decision.action === 'cancel') {
    await sendReply(composeCancelMessage(firstName))
    await persist({ slots: {}, last_step: 'closed', pending_quote_token: null, pending_structure_count: null }, 'done')
    return true
  }

  // ── Customer replied to "shall we book the inspection?". ──
  if (decision.action === 'booking') {
    await sendReply(composeBookingMessage(firstName, decision.confirmed))
    await persist({ slots: decision.slots, last_step: 'closed', pending_quote_token: null, pending_structure_count: null }, 'done')
    // US-002 — a confirmed inspection is a live lead; tell the tradie.
    if (decision.confirmed) {
      await notifyTradie(
        'inspection_booked',
        decision.slots.address ?? 'address not captured',
        null,
        // Preference order (and why) lives with the pure helper.
        roofingBookingDetailsUrl(baseUrl, {
          leadMeasureToken: prevState?.pending_lead_measure_token,
          publicToken: prevState?.pending_quote_token,
        }),
      )
    }
    return true
  }

  // ── Still gathering inputs — ask the next question. ──
  if (decision.action === 'ask') {
    let askSlots = decision.slots
    let askStep = decision.step
    let askReply = decision.reply
    // Map-check the address BEFORE reading it back — the read-back alone
    // can't catch a suburb that doesn't exist ("safety each"). Corrected
    // or not-found addresses revise the slots/step/reply; an unavailable
    // API keeps the plain read-back.
    //
    // Skipped only when the turn is ANSWERING something rather than asking
    // for the address. screenConfirmAddress returns a reply for every
    // successful verification, so on a deflect/answer turn parked at
    // confirm_address it would overwrite the answer with the read-back.
    //
    // Any turn that actually ASKS confirm_address must screen it, whichever
    // value the model picked: skipping it left the address unverified and
    // unstamped, which is what let the confirm question repeat forever
    // (live 2026-07-27).
    const answeringTurn = turn?.tool === 'answer_business_question' || turn?.tool === 'deflect_and_notify'
    if (decision.step === 'confirm_address' && !answeringTurn) {
      const screened = await screenConfirmAddress(decision.slots)
      askSlots = screened.slots
      if (screened.step) askStep = screened.step
      if (screened.reply) askReply = screened.reply
      // Every attempt failed the map check. We will not measure an address
      // the register cannot confirm, so the lead goes to a human instead of
      // looping — park it the same way a routed inspection parks, and tell
      // the tradie there is someone waiting.
      if (screened.handoff) {
        await persist({ slots: askSlots, last_step: 'await_booking', pending_quote_token: null, pending_structure_count: null }, 'open')
        await sendReply(askReply)
        await notifyTradie(
          'question_asked',
          decision.slots.address ?? 'address not captured',
          null,
          `${baseUrl}/dashboard`,
          `Could not match this address on the map: "${decision.slots.address ?? ''}"`,
        )
        return true
      }
    }
    // Nulling the pending measurement is right when the ask MOVES the
    // customer (a new gather step means the old measurement is stale). It is
    // wrong when the ask HOLDS them where they were — a question answered at
    // confirm_roof, or a booking re-ask — because the token is the only
    // handle on a measured, priced job. Losing it stranded the customer on
    // "Sorry, I lost track of that one" and restarted the address gather.
    // Gated on the LLM path (`turn`), not merely on the step comparison.
    // advanceRoofing re-asks the same gather step often, so the comparison
    // alone is reachable with the flag off; gating on `turn` makes the
    // flag-off write byte-identical by construction rather than by an
    // argument about which states can hold a token.
    const holdsPending = !!turn && askStep === prevState?.last_step
    await persist({
      slots: askSlots,
      last_step: askStep,
      pending_quote_token: holdsPending ? (prevState?.pending_quote_token ?? null) : null,
      pending_structure_count: holdsPending ? (prevState?.pending_structure_count ?? null) : null,
    }, 'open')
    await sendReply(askReply)
    // The LLM receptionist just told the customer we'd check something and
    // come back to them. That promise is only honest if a human hears about
    // it, so the deflect and this alert ship as a pair.
    //
    // `decision.handoff` is the same promise from the other direction: the
    // address rejection budget is spent and addressHandoffReply() has just
    // told the customer one of the team will confirm the property. Until now
    // that flag was dropped by every consumer and NOBODY was told
    // (specs/address-confirm-loop.md req 2). The screen's own handoff notifies
    // above; this is the customer-rejection twin, which never reaches it
    // because its step is 'await_booking', not 'confirm_address'.
    if (turn?.notify === 'question_asked' || decision.handoff) {
      await notifyTradie(
        'question_asked',
        decision.slots.address ?? 'address not captured',
        null,
        `${baseUrl}/dashboard`,
        decisionInput,
      )
    }
    return true
  }

  // ── Customer is replying to "is this your roof?" ──
  if (decision.action === 'reconfirm' || decision.action === 'send_saved') {
    const pending = await loadPending(prevState?.pending_quote_token ?? null)
    if (pending) {
      // Plain SMS (no MMS attachment) — AU long-code MMS delivery is
      // unreliable. The roof image + map live on the linked page.
      const quoteUrl = `${baseUrl}/q/roof/${pending.token}`
      if (decision.action === 'reconfirm') {
        await sendReply(composeConfirmMessage({ quote: pending.quote, address: pending.address, quoteUrl, firstName }))
        await persist({ slots: decision.slots, last_step: 'confirm_roof', pending_quote_token: pending.token, pending_structure_count: prevState?.pending_structure_count ?? pending.quote.structures.length }, 'open')
        return true
      }
      // send_saved — confirmed; send the (optionally narrowed) estimate.
      // null choices = all structures; otherwise narrow to the picks.
      const indices = decision.structureChoices
      const totalStructures = prevState?.pending_structure_count ?? pending.quote.structures.length
      const finalQuote = narrowQuoteToStructures(pending.quote, indices)
      // Append ?s= so the page shows exactly the structures we quoted; the
      // bare URL (all) needs no param.
      const servedUrl = indices && indices.length > 0
        ? `${quoteUrl}?s=${indices.join(',')}`
        : quoteUrl
      // Stamp the customer's confirmation so the page flips from the
      // price-free picker to the priced view. A single pick narrows the
      // page; a multi-pick / "all" leaves confirmed_structure null.
      //
      // included_indices carries the ACTUAL confirmed set. The ?s= link
      // alone cannot: resolveEffectiveIndices only ever narrows, and with
      // included_indices NULL it falls back to main-dwelling-only — so a
      // customer who replied YES to 3 buildings got an SMS quoting 2 of
      // them and a page showing 1 (live 2026-07-22, $115,117 vs $69,652).
      const confirmedIndices = confirmedIncludedIndices(indices, totalStructures)
      await supabase
        .from('roofing_measurements')
        .update({
          confirmed_at: new Date().toISOString(),
          confirmed_structure: indices && indices.length === 1 ? indices[0] : null,
          included_indices: confirmedIndices,
        })
        .eq('public_token', pending.token)
      // Migration 105 — Gotenberg quote PDF for the priced roofing
      // estimate. Best-effort (never blocks the SMS); regenerated here so
      // a narrowed structure-subset quote renders the narrowed numbers.
      // The PDF link goes in the body; the document itself rides along as
      // a best-effort MMS (dispatch falls back to plain SMS on rejection).
      let roofPdfUrl: string | null = null
      let roofPdfMedia: string | undefined
      if (finalQuote.routing.decision !== 'inspection_required') {
        // RC-4 — regenerate:true so a second confirmed send ("give me 2 and 3")
        // overwrites the cached PDF with THIS finalQuote; the -v5 path marker
        // would otherwise short-circuit and attach the first pick's PDF while
        // the SMS body shows the new one. Mirrors the electrical/plumbing send.
        const roofPdfPath = await ensureRoofQuotePdf(pending.token, {
          quote: finalQuote,
          regenerate: true,
        })
        if (roofPdfPath) {
          roofPdfUrl = roofQuotePdfUrl(pending.token)
          // Attach the PDF as MMS media ONLY where MMS is known to work.
          // On an AU long code without MMS, Twilio accepts the send, the
          // status sticks at 'sent' and the whole estimate — body included
          // — never reaches the handset. The body's "PDF copy:" link makes
          // the attachment redundant anyway. See quotePdfMmsEnabled().
          if (quotePdfMmsEnabled()) {
            try {
              roofPdfMedia = await signQuotePdfUrl(roofPdfPath, 60 * 60)
            } catch {
              roofPdfMedia = undefined
            }
          }
        }
      }
      // Mig 142 — roofing tier presentation mode for this tenant (single-price
      // tradies get one option in the estimate SMS, not all three tiers).
      // US-009 (audit 2026-07-23): the no-tenant default must be the SAME
      // canonical default the quote page uses (asQuoteTierMode(null) →
      // 'single'); it was hardcoded 'good_better_best', so a shared-number
      // SMS showed three tiers while the linked page rendered one.
      let roofingTierMode: QuoteTierMode = asQuoteTierMode(null)
      if (tenantId) {
        const { data: rb } = await supabase
          .from('pricing_book')
          .select('quote_tier_mode')
          .eq('tenant_id', tenantId)
          .eq('trade', 'roofing')
          .maybeSingle()
        roofingTierMode = asQuoteTierMode(
          (rb as { quote_tier_mode?: string | null } | null)?.quote_tier_mode ?? null,
        )
      }
      await sendReply(
        buildRoofingReplyMessage({ quote: finalQuote, address: pending.address, quoteUrl: servedUrl, firstName, pdfUrl: roofPdfUrl, tierMode: roofingTierMode }),
        roofPdfMedia,
      )
      // The persisted step must FOLLOW THE MESSAGE just sent. An
      // inspection-only send ends "Reply YES and we'll book a time that
      // suits you" — parking it 'quoted' made that YES a structure-pick
      // miss → passthrough to the electrical LLM, which improvised a fake
      // "you're all booked in" and ran an electrical intake on the roofing
      // thread (live 2026-07-23, "15 schfofieod"). await_booking mirrors
      // the measure-path inspection park below, keyed on the SAME
      // predicate the composer used so message and state can't drift. A
      // priced send stays WARM 'quoted': a follow-up like "give me 2 and
      // 3" / "the others" re-serves the SAVED measurement.
      const inspectionOnly = shouldSendRoofInspectionMessage(finalQuote)
      await persist({
        slots: decision.slots,
        last_step: inspectionOnly ? 'await_booking' : 'quoted',
        pending_quote_token: pending.token,
        pending_structure_count: totalStructures,
        last_served_structures: confirmedIndices,
      }, 'open')
      // US-002 — the quote just went to the customer; tell the tradie,
      // with the same solar-inclusive better total the dashboard shows.
      // NOT on an inspection-only send: its combined better tier is $0, so
      // this fired "roofing quote sent at $0 inc GST" while the customer
      // read an indicative $32k range. The booking arm sends the real
      // 'inspection_booked' notify when the customer confirms — the same
      // contract as the measure-path inspection park.
      if (!inspectionOnly) {
        await notifyTradie(
          'quote_sent',
          pending.address,
          applySolarToTiers(finalQuote.combined.tiers, finalQuote.solar ?? null)[1]?.inc_gst ?? null,
          servedUrl,
        )
      }
      // Per-tenant file-store ingest (best-effort, never blocks the send).
      // Archive the priced roofing quote PDF + minimized KB markdown.
      // Skipped for inspection-routed quotes (no priced doc to ingest).
      if (finalQuote.routing.decision !== 'inspection_required') {
        try {
          const fullDocPath = await ensureRoofQuotePdf(pending.token, { quote: finalQuote })
          if (fullDocPath) {
            const { markdown, contentHash } = buildQuoteKbText({
              quote: { estimate: finalQuote, routing_decision: finalQuote.routing.decision },
              trade: 'roofing',
            })
            await archiveAndIngestQuote({
              tenantId,
              sourceKind: 'quote',
              sourceId: pending.token,
              trade: 'roofing',
              fullDocPath,
              kbText: markdown,
              contentHash,
            })
          }
        } catch { /* best-effort */ }
      }
      // Pre-warm the AI "after re-roof" preview now (best-effort) so it's
      // cached by the time the customer opens the link. We're inside the
      // webhook's after() with a 300s budget and the SMS is already sent,
      // so this never delays the customer. Skipped for inspection-routed
      // quotes (the page doesn't show the preview there).
      if (finalQuote.routing.decision !== 'inspection_required') {
        try { await generateRoofAfterImage(pending.token) } catch { /* non-fatal */ }
      }
      return true
    }
    // Lost the pending quote — restart gathering.
    await sendReply("Sorry, I lost track of that one. What's the property address, with suburb and postcode?")
    await persist({ slots: {}, last_step: 'address' }, 'open')
    return true
  }

  // ── inspection routed by the BRIEF, not by a failed measurement. ──
  // nextRoofingStep short-circuits to inspection the moment it learns the
  // material is asbestos-suspect/unknown or the job is unclear — before
  // it ever asks pitch. That leaves the slots incomplete, so
  // toRoofingRequest() below returns null and we never attempt a measure.
  // Handled here so we say what actually happened: until 2026-07-22 this
  // fell through to composeMeasureUnavailableMessage and told the
  // customer "I couldn't pull an automatic measurement for <address>",
  // which was untrue and discarded the real reason.
  if (decision.action === 'inspection' && !toRoofingRequest(decision.slots)) {
    const addr = decision.slots.address ?? 'your property'
    await sendReply(composeInspectionReasonMessage(firstName, addr, decision.reason))
    await persist(
      { slots: decision.slots, last_step: 'await_booking', pending_quote_token: null, pending_structure_count: null },
      'open',
    )
    return true
  }

  // ── measure / inspection — run the roofing pipeline, save the job. ──
  // The sequence itself (rate card → measure → save → photo MMS → confirm
  // SMS) lives in lib/sms/roofing-measure-dispatch.ts so the VOICE path
  // runs the identical one after a call. A failure falls through to the
  // unavailable path below, exactly as it did inline.
  const reqInput = toRoofingRequest(decision.slots)
  if (reqInput) {
    const dispatched = await measureAndDispatchRoofing({
      supabase,
      tenantId,
      tenantTrade,
      conversationId,
      customerPhone: fromNumber,
      replyFrom,
      firstName,
      baseUrl,
      slots: decision.slots,
      isInspection: decision.action === 'inspection',
      inspectionReason: decision.action === 'inspection' ? decision.reason : undefined,
      sendReply,
    })
    if (dispatched.ok) {
      await persist(dispatched.state, 'open')
      return true
    }
  }

  // Fallback — the automatic measurement was unavailable (provider down /
  // transient error) despite a complete brief. DON'T dead-end the customer:
  // route to the on-site inspection so the lead is never lost. Park at
  // await_booking (status 'open') so a "yes" books it via the existing
  // booking flow — the same safe path a measured inspection-routed job
  // takes. Previously this closed the thread with a "we'll confirm your
  // quote shortly" message that created no measurement, no booking, and no
  // tradie alert — a black hole the customer never heard back from.
  const leadAddress = reqInput?.address.address ?? decision.slots.address ?? null
  const fallbackAddress = leadAddress ?? 'your property'

  // A complete brief we COULDN'T measure is still a real lead, and until
  // 2026-07-23 nothing was written here at all — so the job never reached
  // the tradie's roofing queue (which lists roofing_measurements rows). The
  // customer was promised an on-site inspection while the tradie was given
  // no job to arrange it on. Live case: 223 Archer St, Gumdale, where
  // Geoscape resolves the address but holds ZERO building footprints for
  // it, so no measurement is possible at any time — not a transient outage.
  //
  // Best-effort and fully guarded: this fallback's contract is "always
  // reply, always park", and a throw here runs inside after(), which would
  // swallow the customer's reply — the exact black hole it exists to
  // prevent. pending_quote_token stays null deliberately: /q/roof/[token]
  // is headlined "Your roof, measured", which this lead is not.
  // Kept so the booking notify can link the tradie at THIS job (/m/<measure>)
  // rather than the bare dashboard. Set only after a confirmed insert —
  // supabase-js resolves {data,error} on failure rather than throwing, so a
  // bare await here would hand the tradie a link to a row that never landed.
  let leadMeasureToken: string | null = null
  if (leadAddress) {
    try {
      const leadTokens = newMeasurementTokens()
      const { error: leadErr } = await supabase.from('roofing_measurements').insert({
        tenant_id: tenantId,
        address: leadAddress,
        postcode: reqInput?.address.postcode || decision.slots.postcode || null,
        state: reqInput?.address.state ?? decision.slots.state ?? null,
        customer_name: firstName,
        customer_phone: fromNumber,
        structure_count: 0,
        structures: [],
        combined_area_m2: null,
        routing: 'inspection_required',
        quote: null,
        ...leadTokens,
      })
      if (leadErr) {
        console.warn('[sms/inbound:roofing] unmeasured lead insert failed (non-fatal)', leadErr)
      } else {
        leadMeasureToken = leadTokens.measure_token
      }
    } catch (e) {
      console.warn('[sms/inbound:roofing] unmeasured lead insert threw (non-fatal)', e)
    }
  }

  await sendReply(composeMeasureUnavailableMessage(firstName, fallbackAddress))
  await persist({
    slots: decision.slots,
    last_step: 'await_booking',
    pending_quote_token: null,
    pending_lead_measure_token: leadMeasureToken,
    pending_structure_count: null,
  }, 'open')
  return true
}

// ─────────────────────────────────────────────────────────────────────
// SMS painting receptionist — deterministic per-turn handler.
//
// Returns true when it handled the turn (the caller then returns from
// after() and skips the electrical/plumbing Sonnet dialog). Only engages
// when SMS_PAINTING_ENABLED and either the conversation is already a
// painting flow or an inbound looks like a painting enquiry. All pure
// decision logic lives in lib/sms/painting-{intake,receptionist,compose};
// this does the I/O (mint the form token, run the estimate, persist,
// dispatch). Mirrors handleRoofingTurn.
// ─────────────────────────────────────────────────────────────────────
async function handlePaintingTurn(args: {
  conversationId: string
  paintingStateRaw: unknown
  /** Closes the hijack class: true when the general dialog already gathered
   *  a trade-specific slot from this thread. Gates the fresh-enquiry arm. */
  generalMidGather: boolean
  turns: ConversationTurn[]
  toNumber: string
  fromNumber: string
  tenantId: string | null
  firstName: string | null
  followupPinActive: boolean
  /** Grounded tenant facts for the LLM receptionist. Absent ⇒ it can't run. */
  tenantFacts?: TenantFacts | null
}): Promise<boolean> {
  const { conversationId, turns, toNumber, fromNumber, tenantId, firstName, followupPinActive } = args
  const prevState = (args.paintingStateRaw ?? null) as PaintingConversationState | null

  const latestInbound =
    [...turns].reverse().find((t) => t.direction === 'inbound')?.body ?? ''

  // Engage only if we're in an ACTIVE painting flow (mid-gather / awaiting a
  // reply), or THIS message reads like a painting enquiry. A closed flow is
  // NOT active, so an unrelated follow-up never re-quotes. When a follow-up
  // pin is active a stale painting_state must not resume — only a genuinely
  // new painting enquiry may engage (spec 2026-07-05 Part A2).
  if (!shouldEngagePainting(prevState, latestInbound, followupPinActive, args.generalMidGather))
    return false

  // Same conversation layer as the roofing handler: flag OFF ⇒ the
  // deterministic call this route has always made; flag ON ⇒ Sonnet 5 picks
  // the tool and any failure falls back to that same call for this turn.
  // Two turns pre-empt the model regardless of the flag (spec 2026-08-05):
  // the opener (so the form-offer opener with BOTH paths always goes out)
  // and an explicit "use the form" reply parked at offer_form.
  const useLlm =
    !paintingTurnIsDeterministic(prevState, latestInbound) &&
    !!args.tenantFacts &&
    llmReceptionistEnabled(tenantId)
  const turn = useLlm
    ? await paintingTurnViaLlm({
        prev: prevState,
        inbound: latestInbound,
        history: turns,
        facts: args.tenantFacts as TenantFacts,
      })
    : null
  if (turn) {
    console.log('[sms/inbound:painting] LLM receptionist turn', {
      conversationId,
      source: turn.source,
      action: turn.decision.action,
    })
  }
  let decision = turn ? turn.decision : advancePainting(prevState, latestInbound)

  // ── Re-estimate guard on an already-quoted thread ─────────────────────
  //
  // Same defect class the roofing handler above carried (fixed 2026-08-07):
  // advancePainting's warm-'quoted' arm hands a post-quote message back with
  // 'passthrough' unless it reads like a genuine new painting enquiry, but that
  // arm is only reachable on the deterministic path. With the LLM driving (the
  // default) the line above takes turn.decision verbatim, so nothing enforced
  // it — and 'estimate' runs the pricing engine and texts another quote.
  //
  // Roofing's version of this minted FOUR measurement rows for one property in
  // eight minutes while the customer was trying to switch trades. Deciding to
  // SPEND is not a conversational judgement, so it is not the model's to make.
  // Keyed on SAME PROPERTY rather than last_step, for the reason roofing's
  // twin documents: the step a re-estimate leaves is not 'quoted', so a
  // last_step trigger misses every mint after the first. A DIFFERENT address is
  // untouched — a second property is a real job and must still be estimated.
  const normPaintAddr = (a: unknown): string =>
    typeof a === 'string' ? a.toLowerCase().replace(/[^a-z0-9]+/g, '') : ''
  const quotedAddr = normPaintAddr(prevState?.slots?.address)
  const targetPaintAddr = normPaintAddr((decision as { slots?: { address?: string } }).slots?.address)
  const samePaintProperty =
    !!prevState?.pending_quote_token && !!quotedAddr && quotedAddr === targetPaintAddr

  if (turn && samePaintProperty && (decision.action === 'estimate' || decision.action === 'inspection')) {
    const deterministic = advancePainting(prevState, latestInbound)
    if (deterministic.action !== 'estimate' && deterministic.action !== 'inspection') {
      console.warn('[sms/inbound:painting] LLM re-estimated a property this thread already holds — deterministic decision wins', {
        conversationId,
        llmAction: decision.action,
        deterministicAction: deterministic.action,
        lastStep: prevState?.last_step ?? null,
        inbound: latestInbound.slice(0, 80),
      })
      decision = deterministic
    }
  }
  const carry: TurnCarry = turn?.carry ?? {}

  // ── An answer to the address read-back is never discarded ─────────────
  //
  // The roofing handler's twin guard (see it for the full reasoning). Ported
  // because the incident state was painting_state.last_step = 'coats': the
  // trade that actually looped is this one, and it had no guard at all.
  //
  // ⚠ Keyed on the TRANSCRIPT, not on last_step, and it consumes the rejection
  // ITSELF rather than asking advancePainting to agree — advancePainting is
  // step-keyed, and on 'coats' it answers `ask/scopes` with the address still
  // set, so a guard that waited for its agreement was dead code on the exact
  // state the spec documents.
  const askedAddressLastTurn =
    prevState?.last_step === 'confirm_address' || lastOutboundAskedAddress(turns)
  const rejectionConsumed =
    (decision.slots.addr_confirm_rejects ?? 0) > (prevState?.slots?.addr_confirm_rejects ?? 0)
  if (
    askedAddressLastTurn &&
    !rejectionConsumed &&
    !isAffirmative(latestInbound) &&
    rejectsReadBack(latestInbound) &&
    !extractStreetAddress(latestInbound) &&
    decision.action !== 'passthrough' &&
    decision.action !== 'cancel'
  ) {
    console.warn('[sms/inbound:painting] a rejection of the address read-back was not consumed — forcing the shared budget', {
      conversationId,
      llmAction: decision.action,
      llmStep: 'step' in decision ? decision.step : null,
      lastStep: prevState?.last_step ?? null,
      inbound: latestInbound.slice(0, 80),
    })
    const r = consumeAddressRejection(decision.slots)
    decision = {
      action: 'ask',
      slots: r.slots,
      step: r.step,
      reply: r.reply,
      ...(r.handoff ? { handoff: true as const } : {}),
    }
  }

  const replyFrom = toNumber
  // The newest thing we already said. Updated as we send, because one turn can
  // send more than once (quote + follow-up).
  let lastSent = turns.filter((t) => t.direction === 'outbound').at(-1)?.body ?? null
  const sendReply = async (text: string, mediaUrl?: string) => {
    // ── Never the same message twice in a row (spec req 5) ──────────────
    // The backstop, not the fix: every known cause is closed upstream, and
    // this is what makes the NEXT variant of the bug visible instead of
    // silent. Prefixed rather than dropped — a customer who gets nothing is
    // worse off than one who gets an apology with the question.
    const { body, repeated } = dedupeConsecutiveReply(text, lastSent)
    if (repeated) {
      console.error('[sms/inbound:painting] composed a byte-identical repeat reply - see specs/address-confirm-loop.md', {
        conversationId,
        body: text.slice(0, 120),
      })
    }
    lastSent = body
    const res = await dispatchQuoteMessage({ to: fromNumber, text: body, from: replyFrom, mediaUrl })
    // supabase-js RESOLVES {data, error} on failure — a bare await here made
    // a failed insert invisible, and the repeat backstop above reads this
    // history on the next turn.
    const { error: logError } = await supabase.from('sms_messages').insert({
      conversation_id: conversationId,
      direction: 'outbound',
      body,
    })
    if (logError) {
      console.error('[sms/inbound:painting] outbound sms_messages insert failed', logError)
    }
    return res
  }
  const persist = async (state: PaintingConversationState, status: 'open' | 'done') => {
    try {
      // Conversation-scoped memory survives every branch's explicit state
      // write — see the roofing persist for why. Both fields are absent on
      // the deterministic path, so the flag-OFF write is unchanged.
      const merged: PaintingConversationState = {
        ...(prevState?.declined_trades ? { declined_trades: prevState.declined_trades } : {}),
        ...(prevState?.booking_reask != null ? { booking_reask: prevState.booking_reask } : {}),
        ...state,
        ...carry,
      }
      // booking_reask counts re-asks of ONE booking question. Carrying it
      // past that question would let a later enquiry in the same thread
      // auto-confirm on its FIRST unclear reply.
      if (merged.last_step !== 'await_booking') delete merged.booking_reask
      // supabase-js RESOLVES {data, error} on failure — it does not throw, so
      // the try/catch below never saw a rejected write. Every bound this flow
      // owns (addr_confirm_rejects, addr_confirm_misses, addr_verify_misses,
      // booking_reask) rides in this jsonb: a silently-dropped update restarts
      // every counter at zero next turn, which is precisely how a bounded loop
      // keeps not ending (specs/address-confirm-loop.md).
      const { error: persistError } = await supabase
        .from('sms_conversations')
        .update({ painting_state: merged, status, last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', conversationId)
      if (persistError) {
        console.error('[sms/inbound:painting] painting_state persist FAILED - counters will restart next turn', {
          conversationId,
          lastStep: merged.last_step ?? null,
          error: persistError,
        })
      }
    } catch (e) {
      console.warn('[sms/inbound:painting] painting_state persist failed (migration 154?)', e)
    }
  }
  const baseUrl = ROOFING_APP_BASE_URL
  // The deflect ("I'll check with <owner> and come back to you") is only
  // honest if a human is actually told. The roofing handler has its own
  // notifyTradie closure; painting had none, so the promise was made and
  // nobody heard about it. The 'question_asked' alert carries no roofing
  // wording, so it serves both trades.
  const notifyUnansweredQuestion = async (question: string) => {
    try {
      const { data: t } = tenantId
        ? await supabase
            .from('tenants')
            .select('owner_mobile, owner_first_name, twilio_sms_number')
            .eq('id', tenantId)
            .maybeSingle()
        : { data: null }
      const row = (t as {
        owner_mobile?: string | null
        owner_first_name?: string | null
        twilio_sms_number?: string | null
      } | null) ?? null
      await notifyRoofingTradie({
        kind: 'question_asked',
        tenant: {
          owner_mobile: row?.owner_mobile ?? null,
          owner_first_name: row?.owner_first_name ?? null,
          twilio_sms_number: row?.twilio_sms_number ?? null,
        },
        customerName: firstName,
        customerPhone: fromNumber,
        address: decision.slots.address ?? 'address not captured',
        betterIncGst: null,
        quoteUrl: `${baseUrl}/dashboard`,
        question,
        dispatch: (o) => dispatchQuoteMessage({ to: o.to, text: o.text, from: o.from, audience: 'tradie', tenantId }),
      })
    } catch (e) {
      console.warn('[sms/inbound:painting] unanswered-question notify failed (non-fatal)', e)
    }
  }

  /** Tell the painter a site visit was just booked. Same shape as the roofing
   *  handler's notify, with the trade word set so the painter is not told
   *  about a "roofing" inspection. Never throws — a notify failure must not
   *  cost the customer their reply. */
  const notifyPaintingInspectionBooked = async (address: string) => {
    try {
      const { data: t } = tenantId
        ? await supabase
            .from('tenants')
            .select('owner_mobile, owner_first_name, twilio_sms_number')
            .eq('id', tenantId)
            .maybeSingle()
        : { data: null }
      const row = (t as {
        owner_mobile?: string | null
        owner_first_name?: string | null
        twilio_sms_number?: string | null
      } | null) ?? null
      await notifyRoofingTradie({
        kind: 'inspection_booked',
        tenant: {
          owner_mobile: row?.owner_mobile ?? null,
          owner_first_name: row?.owner_first_name ?? null,
          twilio_sms_number: row?.twilio_sms_number ?? null,
        },
        customerName: firstName,
        customerPhone: fromNumber,
        address,
        betterIncGst: null,
        quoteUrl: `${baseUrl}/dashboard`,
        tradeLabel: 'painting',
        dispatch: (o) => dispatchQuoteMessage({ to: o.to, text: o.text, from: o.from, audience: 'tradie', tenantId }),
      })
    } catch (e) {
      console.warn('[sms/inbound:painting] inspection-booked notify failed (non-fatal)', e)
    }
  }

  // ── Passthrough → hand the turn to the general LLM dialog (return false).
  // Warm 'quoted' thread: CLOSE (end the warm window). Mid-GATHER bail (a
  // topic switch / interrupt / question, 2026-07-24): do NOT close — leave
  // the gather state so the customer's next painting answer resumes where
  // they left off; closing would silently discard everything gathered.
  if (decision.action === 'passthrough') {
    // `close` — a genuine switch to another trade (LLM path). Mirrors the
    // roofing handler: closing here is also what persists the refusal, so
    // the declined trade is remembered instead of re-opening next message.
    if (decision.close || prevState?.last_step === 'quoted') {
      await persist({ slots: {}, last_step: 'closed', pending_form_token: null, pending_quote_token: null }, 'open')
    }
    return false
  }

  // ── Customer asked to stop / cancel. ──
  if (decision.action === 'cancel') {
    await sendReply(composePaintingCancel(firstName))
    await persist({ slots: {}, last_step: 'closed', pending_form_token: null, pending_quote_token: null }, 'done')
    return true
  }

  // ── Customer replied to "shall we book the inspection?". ──
  if (decision.action === 'booking') {
    await sendReply(composePaintingBooking(firstName, decision.confirmed))
    await persist({ slots: decision.slots, last_step: 'closed', pending_form_token: null, pending_quote_token: null }, 'done')
    // A booked painting inspection is a live lead. Roofing tells the tradie
    // (the 'booking' branch above); painting closed the thread and told
    // NOBODY, so every "a painter will be in touch shortly" was a promise made
    // to no one and the lead died silently (live 2026-08-05).
    if (decision.confirmed) {
      await notifyPaintingInspectionBooked(decision.slots.address ?? 'address not captured')
    }
    return true
  }

  // ── Opener — offer the self-serve form link FIRST (unique per request). ──
  if (decision.action === 'offer_form') {
    const token = randomBytes(16).toString('hex')
    try {
      await supabase.from('painting_lead_requests').insert({
        token,
        tenant_id: tenantId,
        conversation_id: conversationId,
        customer_phone: fromNumber,
        status: 'pending',
      })
    } catch (e) {
      console.warn('[sms/inbound:painting] lead request insert failed (migration 154?)', e)
    }
    const formUrl = `${baseUrl}/paint-request/${token}`
    await sendReply(buildPaintingFormOffer({ firstName, formUrl }))
    await persist({ slots: {}, last_step: 'offer_form', pending_form_token: token, pending_quote_token: null }, 'open')
    return true
  }

  // ── Customer chose the form — acknowledge and wait for the submission. ──
  if (decision.action === 'await_form') {
    await sendReply(decision.reply)
    await persist({ slots: decision.slots, last_step: 'await_form' }, 'open')
    return true
  }

  // ── Still gathering inputs — ask the next question (options inlined). ──
  if (decision.action === 'ask') {
    let askSlots = decision.slots
    let askStep = decision.step
    let askReply = decision.reply
    // Same map check as the roofing confirm — see screenConfirmAddress, and
    // the same skip when this turn is a question rather than an address.
    const answeringTurn = turn?.tool === 'answer_business_question' || turn?.tool === 'deflect_and_notify'
    if (decision.step === 'confirm_address' && !answeringTurn) {
      const screened = await screenConfirmAddress(decision.slots)
      askSlots = screened.slots
      if (screened.step) askStep = screened.step
      if (screened.reply) askReply = screened.reply
      // Same as roofing: an address the register cannot confirm goes to a
      // human rather than being measured or looped on.
      if (screened.handoff) {
        await persist({ slots: askSlots, last_step: 'await_booking', pending_form_token: null, pending_quote_token: null }, 'open')
        await sendReply(askReply)
        await notifyUnansweredQuestion(`Could not match this address on the map: "${decision.slots.address ?? ''}"`)
        return true
      }
    }
    // Mirrors the roofing ask branch: a turn that HOLDS the customer where
    // they were keeps the tokens that identify their job. LLM path only —
    // the deterministic write below is left exactly as it was.
    const holdsPending = !!turn && askStep === prevState?.last_step
    await persist(
      holdsPending
        ? {
            slots: askSlots,
            last_step: askStep,
            pending_form_token: prevState?.pending_form_token ?? null,
            pending_quote_token: prevState?.pending_quote_token ?? null,
          }
        : { slots: askSlots, last_step: askStep },
      'open',
    )
    await sendReply(askReply)
    // See the roofing twin: `decision.handoff` means addressHandoffReply() has
    // just promised the customer a human, and until now nobody was told.
    if (turn?.notify === 'question_asked' || decision.handoff) {
      await notifyUnansweredQuestion(
        decision.handoff
          ? `Could not confirm the property address with this customer: "${latestInbound.slice(0, 120)}"`
          : latestInbound,
      )
    }
    return true
  }

  // ── Gather-triggered inspection (poor / raked / 3+ storeys) — no price. ──
  if (decision.action === 'inspection') {
    const address = decision.slots.address ?? 'your property'
    await sendReply(buildPaintingInspectionSms({ firstName, address, reason: decision.reason }))
    await persist({ slots: decision.slots, last_step: 'await_booking', pending_form_token: null, pending_quote_token: null }, 'open')
    return true
  }

  // ── Enough gathered cleanly — run the estimate, save it, send the quote. ──
  if (decision.action === 'estimate') {
    // The sequence (estimate → save → hold/inspection message → tradie
    // notify) lives in lib/sms/painting-estimate-dispatch.ts so the VOICE
    // path runs the identical one after a call.
    const dispatched = await estimateAndDispatchPainting({
      supabase,
      tenantId,
      customerPhone: fromNumber,
      firstName,
      baseUrl,
      slots: decision.slots,
      sendReply,
    })
    if (dispatched.ok) {
      await persist(dispatched.state, 'open')
      return true
    }
    // Couldn't estimate (provider down / missing fields) — fall back.
    await sendReply("Thanks, we've got your painting details. Our team will confirm your quote shortly.")
    await persist({ slots: decision.slots, last_step: 'closed', pending_form_token: null, pending_quote_token: null }, 'done')
    return true
  }

  return false
}

// ─────────────────────────────────────────────────────────────────────────
// RETIRED 2026-08-05 — the in-app SMS receptionist is OFF.
//
// Every tenant-owned number now points at the Front Desk service, which
// identifies tenant + trade and forwards the turn to that trade's own
// receptionist (qm-front-desk → qm-<trade>-receptionist on Railway). Verified
// by real SMS on Ricardos Roofing and Atomic Electrical before this switch.
//
// DISABLED BY DEFAULT, deliberately. An env-var-to-disable would have left the
// old receptionist live until someone set a dashboard variable, so a moment of
// dual-brain overlap — two systems able to answer the same customer — would
// have depended on a manual step. Default-off makes the retirement atomic with
// the deploy.
//
// The code is retained, not deleted, because it is the rollback path. To bring
// it back: set SMS_RECEPTIONIST_ENABLED=1 in Vercel, then repoint the numbers
// (previous values recorded at cutover). Both steps are needed — the flag alone
// changes nothing while Twilio is pointed elsewhere.
//
// The ack below is a 200 with empty TwiML on purpose. A 4xx/5xx would make
// Twilio retry every stray inbound on a schedule, and a stray here means a
// misconfigured number, not a transient fault — retrying cannot fix it. The
// error-level log is the alarm.
// ─────────────────────────────────────────────────────────────────────────
const RECEPTIONIST_ENABLED = process.env.SMS_RECEPTIONIST_ENABLED === '1'

const RETIRED_ACK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

export async function POST(req: Request) {
 if (!RECEPTIONIST_ENABLED) {
   // Read the body only to name the number in the log — nothing is processed,
   // no reply is sent, no row is written.
   let to = 'unknown'
   let from = 'unknown'
   try {
     const p = parseTwilioForm(await req.text())
     to = p.To ?? 'unknown'
     from = p.From ?? 'unknown'
   } catch { /* body shape is irrelevant here */ }
   console.error('[sms/inbound] RETIRED — in-app receptionist is disabled; this number should point at the Front Desk', {
     to,
     from: from.slice(0, 8) + '…',
     expected_webhook: 'https://qm-front-desk-production.up.railway.app/api/sms/inbound',
   })
   return new Response(RETIRED_ACK, { status: 200, headers: { 'content-type': 'text/xml' } })
 }
 try {
  console.log('[sms/inbound] step 1 — reading body')
  // 1. Read raw body (needed for both signature check and field parsing).
  const rawBody = await req.text()
  const params = parseTwilioForm(rawBody)

  // 2. Verify the request really came from Twilio.
  // Reconstruct the URL from forwarded headers so the signature math matches
  // what the original requester (Twilio or our simulator) signed against.
  // On Vercel, req.url can reflect an internal deployment URL while the
  // original request hit the production alias — the forwarded headers
  // preserve the original.
  const signature = req.headers.get('x-twilio-signature')
  const reqUrl = new URL(req.url)
  const forwardedHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? 'https'
  const url = forwardedHost
    ? `${forwardedProto}://${forwardedHost}${reqUrl.pathname}${reqUrl.search}`
    : reqUrl.toString()

  if (!validateTwilioSignature(signature, url, params)) {
    console.warn('[sms/inbound] rejected — bad Twilio signature', {
      url,
      reqUrl: req.url,
      forwardedHost: req.headers.get('x-forwarded-host'),
      forwardedProto: req.headers.get('x-forwarded-proto'),
      host: req.headers.get('host'),
      hasSignature: !!signature,
      hasAuthToken: !!process.env.TWILIO_AUTH_TOKEN,
      authTokenLen: process.env.TWILIO_AUTH_TOKEN?.length ?? 0,
      paramsKeys: Object.keys(params).sort(),
    })
    return new Response('Invalid signature', { status: 403 })
  }

  const fromNumber = params.From
  const toNumber = params.To
  const messageSid = params.MessageSid ?? null

  // A MEDIA-ONLY message is not an empty message. Twilio posts Body as an empty
  // string when the customer attaches a photo and types nothing — which is the
  // single most natural reply to "send us a photo of the spot". Treating that as
  // a missing field 400'd the webhook here, ~480 lines before NumMedia is read
  // and the media is fetched: no storage object, no sms_messages row, no reply,
  // and Twilio retrying into the same 400. The EV photo gate then looked for a
  // photo that had been thrown away at the door (spec
  // ev-charger-location-photo R6). A synthetic body keeps the transcript, the
  // dedupe key and the LLM turn all working on text.
  const inboundNumMedia = Number.parseInt(params.NumMedia ?? '0', 10)
  const inboundHasMedia = Number.isFinite(inboundNumMedia) && inboundNumMedia > 0
  const inboundRawBody = (params.Body ?? '').trim()
  const inboundBody = inboundRawBody || (inboundHasMedia ? '[photo]' : '')

  if (!fromNumber || !toNumber || !inboundBody) {
    return new Response('Missing required Twilio fields', { status: 400 })
  }

  // ─────── Tenant routing (v6 multi-tenant) ───────
  // Look up which registered tradie owns the destination number the
  // customer texted. New conversations get this tenant_id stamped so
  // downstream (estimator, etc.) can scope by tenant.
  // Fail-soft: no tenant match → null → existing pipeline uses the
  // legacy single pricing_book (back-compat for pre-v6 conversations).
  const { tenantByDestinationSms, isTransactableTenantStatus } = await import('@/lib/tenant/lookup')
  const tenant = await tenantByDestinationSms(supabase, toNumber)
  if (tenant) {
    console.log('[sms/inbound] step 2a — tenant resolved by destination number', {
      tenantId: tenant.id,
      businessName: tenant.business_name,
      trade: tenant.trade,
      status: tenant.status,
    })
    // US-001 (audit 2026-07-23): status was logged but never GATED — a
    // suspended/onboarding tenant's number kept quoting. A non-active
    // tenant's line behaves like a disconnected number: ack Twilio (so it
    // doesn't retry) and do nothing else — no customer row, no AI reply.
    if (!isTransactableTenantStatus(tenant.status)) {
      console.warn('[sms/inbound] step 2a — tenant not active; dropping inbound', {
        tenantId: tenant.id,
        status: tenant.status,
      })
      return ackTwiml()
    }
  } else {
    // Spec quote-pdf-logo-fix R5 — the destination number maps to no tenant
    // (e.g. the shared dev number). Expected, but warn-level so the resulting
    // null tenant_id (→ logo-less PDF) is traceable. Fail-soft below.
    console.warn('[sms/inbound] step 2a — no tenant match for destination', {
      toNumber,
      note: 'falling back to legacy single-pricing-book pipeline (quote PDF will have no logo)',
    })
  }

  // ─────── Customer memory lookup ───────
  // Look up (or stub-create) the customer record for this phone number.
  // Used downstream to: pre-populate the dialog with known fields so
  // returning customers don't get re-asked their name/suburb, and to
  // link the conversation back to a customer for cross-channel history.
  // Fail-soft: returns null on DB error, all downstream code handles null.
  const customerRaw: CustomerProfile | null = await findOrCreateCustomer(fromNumber, 'sms', tenant?.id ?? null)
  // US-004 (audit 2026-07-23): the customers row is globally unique by phone
  // and shared by every tenant this number ever texts. When it belongs to a
  // DIFFERENT tenant, withhold the remembered profile at the single point
  // every downstream read flows from — tenant B must not greet tenant A's
  // customer by name with A's history in the prompt. Identity (id/phone)
  // is kept so intake/quote linking still works.
  const memoryOk = customerMemoryAllowed(customerRaw?.tenant_id ?? null, tenant?.id ?? null)
  const customer: CustomerProfile | null = memoryOk ? customerRaw : stripCustomerMemory(customerRaw)
  if (customer) {
    console.log('[sms/inbound] step 2 — customer resolved', {
      customerId: customer.id,
      hasName: !!customer.first_name,
      hasSuburb: !!customer.suburb,
      totalQuotes: customer.total_quotes,
      memoryScoped: !memoryOk,
    })
  }

  // ─────── Idempotency guard ───────
  // Twilio may retry the webhook (timeout, fallback URL config, etc.).
  // Without this, a retry would persist a duplicate inbound row, run
  // Sonnet again, and dispatch another reply. We dedupe on MessageSid —
  // if we've already persisted an inbound row for this SID, ack with
  // 200 immediately and bail. SMS-without-SID (extremely rare) falls
  // through to normal processing rather than failing closed.
  // R47 — the skip-vs-process decision is extracted to decideSidDedup
  // (pure + unit-tested) so the idempotency contract can't silently regress.
  if (messageSid) {
    const { data: existingMsg } = await supabase
      .from('sms_messages')
      .select('id, conversation_id')
      .eq('twilio_message_sid', messageSid)
      .eq('direction', 'inbound')
      .maybeSingle()
    const dedup = decideSidDedup(messageSid, existingMsg)
    if (dedup.action === 'skip_duplicate') {
      console.warn('[sms/inbound] duplicate MessageSid — ignoring retry', {
        messageSid,
        existingMessageId: dedup.existingId,
        conversationId: existingMsg?.conversation_id,
      })
      return ackTwiml()
    }
  }

  // ─────── Plan-estimation short-circuit (migration 104) ───────
  // Tenants with the Account-tab "SMS electrical estimation" toggle ON:
  // when the inbound text asks for a plan take-off ("can you quote my
  // electrical plan?"), reply with a tokenised upload link and skip the
  // normal quote dialog. Everything else falls through untouched.
  if (tenant?.sms_estimator_enabled) {
    const { maybeHandlePlanEstimation } = await import('@/lib/sms/plan-estimation')
    const handled = await maybeHandlePlanEstimation({
      supabase,
      tenant,
      fromNumber,
      toNumber,
      inboundBody,
      messageSid,
      customerFirstName: customer?.first_name ?? null,
    })
    if (handled) return ackTwiml()
  }

  // ─────── Tradie-registration short-circuit (v6) ───────
  // When the destination number has no tenant match (e.g. the shared
  // QuoteMax admin number), check if the inbound message is a tradie
  // wanting to sign up. If so, branch to a slimmer flow: generate a
  // signup token, send a link, persist the conversation as
  // 'tradie_registration'. Customer-quote flow is untouched.
  //
  // Skip this if:
  //   (a) The destination resolved to a tenant — this is a customer
  //       texting a specific tradie, not the admin number.
  //   (b) There's already a recent conversation for this from_number
  //       that's a customer_quote in progress — don't hijack it.
  if (!tenant) {
    const tradieBranch = await maybeHandleTradieRegistration({
      fromNumber,
      toNumber,
      inboundBody,
      messageSid,
    })
    if (tradieBranch) return tradieBranch
  }

  console.log('[sms/inbound] step 3 — completion-aware conversation lookup', { fromNumber })
  // 3. Smart conversation re-engagement.
  //
  // Find the MOST RECENT conversation for this from_number (any status).
  // Then decide one of three modes:
  //
  //   INFLIGHT: a previous quote is being drafted/just-sent right now.
  //             We send a canned hold-on message and skip Sonnet entirely.
  //   REUSE:    the prior conversation is mid-flow OR a recently-done quote
  //             is in the 5-min add-on grace window. Continue the dialog.
  //   NEW:      no prior or prior is too old/stale. Create a new row;
  //             customerHistoryHint = 'first_time' or 'returning'.
  //
  // Window thresholds (don't change without updating the comment).
  // STRUCTURING_INFLIGHT_MAX_MS + the in-flight rule itself live in
  // lib/sms/inflight.ts (pure + unit-tested). A `done` conversation
  // within REUSE_DONE_GRACE_MS is REUSED so the dialog continues the
  // thread — no separate "quote in transit" sub-window (that 60s window
  // keyed off last_message_at and oscillated; removed 2026-05-22).
  const REUSE_DONE_GRACE_MS         = 5 * 60 * 1000  // 5min after done = add-on grace
  const REUSE_OPEN_WINDOW_MS        = 4 * 60 * 60 * 1000  // 4h on open = pause-and-resume

  // Prior-conversation lookup is scoped by BOTH from_number AND the
  // tenant (or to_number when no tenant resolved). This prevents
  // cross-tenant bleed: a customer who texts Peppers Plumbing for a
  // hot-water job and later texts Sparky for downlights must NOT reuse
  // the plumbing conversation — that would drag job_type='hot_water',
  // location slots, etc. across tenants and the AI would reply with
  // wildly mixed context ("downlights not hot water — six in the
  // garage" instead of fresh dialog).
  //
  // Pre-v6 conversations have tenant_id=NULL; for the rare case where
  // the destination resolves to no tenant (e.g. the admin number), we
  // scope by to_number instead so threads on the admin number don't
  // bleed into per-tradie conversations either.
  const priorQuery = supabase
    .from('sms_conversations')
    .select('*')
    .eq('from_number', fromNumber)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
  const { data: prior, error: lookupErr } = await (
    tenant
      ? priorQuery.eq('tenant_id', tenant.id)
      : priorQuery.eq('to_number', toNumber)
  ).maybeSingle()

  if (lookupErr) {
    console.error('[sms/inbound] conversation lookup failed', lookupErr)
    return new Response('DB error', { status: 500 })
  }

  type CustomerHistoryHint = 'first_time' | 'returning' | 'continuing'
  type LookupMode = 'inflight' | 'reuse' | 'new'
  let customerHistoryHint: CustomerHistoryHint
  let conversation: typeof prior
  let mode: LookupMode

  const ageMs = prior?.last_message_at
    ? Date.now() - new Date(prior.last_message_at as string).getTime()
    : Infinity

  // ── Mode classification ───────────────────────────────────────────
  // Order matters — first matching rule wins.
  // 'done' is overloaded (quote-sent / inspection-escalated / ended).
  // isQuoteInflight only holds the customer when a quote was ACTUALLY
  // produced (intake_id set) — so an inspection escalation or ended
  // chat no longer triggers the bogus "wrapping up your quote" reply
  // that skipped the AI and blocked service-toggle testing.
  const isInflight = isQuoteInflight(prior, ageMs)
  const isReuseOpenLike = !!prior && !isInflight && (
    (prior.status === 'open' && ageMs < REUSE_OPEN_WINDOW_MS)
    || (prior.status === 'structuring' && ageMs < REUSE_OPEN_WINDOW_MS)
  )
  // A `done` conversation within the 5-min grace is REUSED — the dialog
  // continues the thread. No lower bound: a quote-just-finished message
  // is handled by the dialog + the hasExistingIntake guard, not a canned
  // hold-on (that bogus 60s sub-window was the oscillation bug).
  const isReuseDoneGrace = !!prior && !isInflight && (
    prior.status === 'done' && ageMs < REUSE_DONE_GRACE_MS
  )

  if (isInflight) {
    mode = 'inflight'
    conversation = prior!
    customerHistoryHint = 'continuing'  // unused in inflight path; canned message bypasses Sonnet
    console.log('[sms/inbound] step 3 — INFLIGHT (canned hold-on path)', {
      conversationId: conversation.id,
      priorStatus: conversation.status,
      ageSeconds: Math.round(ageMs / 1000),
    })
  } else if (isReuseOpenLike || isReuseDoneGrace) {
    mode = 'reuse'
    conversation = prior!
    customerHistoryHint = 'continuing'
    console.log('[sms/inbound] step 3 — REUSE prior conversation', {
      conversationId: conversation.id,
      priorStatus: conversation.status,
      ageSeconds: Math.round(ageMs / 1000),
      reason: isReuseOpenLike ? 'open/structuring within window' : 'done within grace',
    })

    // One-time backfill for legacy rows created before migration 012.
    // If conversation_state is empty AND we have customer fields, seed it
    // now so per-turn extraction has a starting point. Without this,
    // legacy in-flight conversations would never benefit from slot tracking
    // until they ended and a new conversation started.
    const existingState = normaliseState(conversation.conversation_state)
    const hasNoState = Object.keys(existingState.slots).length === 0
    const customerHasFields = !!(customer?.first_name || customer?.suburb)
    if (hasNoState && customerHasFields) {
      const seeded = seedStateFromKnownFields({
        first_name: customer?.first_name ?? null,
        suburb: customer?.suburb ?? null,
        address: customer?.address ?? null,
        email: customer?.email ?? null,
      })
      await supabase
        .from('sms_conversations')
        .update({ conversation_state: seeded, updated_at: new Date().toISOString() })
        .eq('id', conversation.id)
      conversation = { ...conversation, conversation_state: seeded }
      console.log('[sms/inbound] step 3 — backfilled empty conversation_state from customer record', {
        conversationId: conversation.id,
        seededFields: Object.keys(seeded.slots),
      })
    }

    // Photo-state freshness check — fixes the "second-quote photo bleed" bug.
    //
    // When we re-engage a conversation that's been idle long enough that the
    // customer is plausibly starting a new job (not just adding to a current
    // upload session), wipe the stale photo buffer + photo_request_sent_at
    // so the new request gets its own clean photo cycle. Without this, the
    // 2nd quote silently inherits the 1st quote's photos and skips the
    // photo-request SMS because photo_request_sent_at is already set.
    //
    // Threshold: 15 minutes of idle. Anything shorter and the customer is
    // probably mid-upload or mid-thought; anything longer and we treat the
    // re-engagement as a new session.
    const PHOTO_RESET_IDLE_MS = 15 * 60 * 1000
    const hasStalePhotoState = !!(conversation.photo_request_sent_at)
      && ageMs >= PHOTO_RESET_IDLE_MS
    if (hasStalePhotoState) {
      const photoToken = randomBytes(16).toString('hex')
      await supabase
        .from('sms_conversations')
        .update({
          photo_request_token: photoToken,    // fresh token = fresh upload bucket
          photo_request_sent_at: null,
          photos_completed_at: null,
          photo_urls: [],
          photo_paths: [],
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversation.id)
      conversation = {
        ...conversation,
        photo_request_token: photoToken,
        photo_request_sent_at: null,
        photos_completed_at: null,
        photo_urls: [],
        photo_paths: [],
      }
      console.log('[sms/inbound] step 3 — reset stale photo state on reused conversation', {
        conversationId: conversation.id,
        idleMinutes: Math.round(ageMs / 60000),
      })
    }

    // Roofing/painting session freshness — same idea as the photo reset above.
    // The route reuses a conversation for up to REUSE_OPEN_WINDOW_MS (4h), so a
    // roofing/painting flow parked at confirm_roof / await_booking / quoted /
    // await_form and left idle for hours would RESUME and replay a measurement
    // from the previous session. Live 2026-07-24 (QM Sparky): a confirm_roof
    // reused hours later re-sent "3 buildings at 670 London Road" on the next
    // "Hi Mate", then again on a new address, then on "Hey" — the agent stuck
    // replaying stale data. Expire the parked flow so the new message starts
    // clean. Best-effort; the pure helpers own the "is it stale?" decision.
    const convRec = conversation as Record<string, unknown>
    const staleRoof = expireIdleRoofingState(
      (convRec.roofing_state ?? null) as RoofingConversationState | null,
      ageMs,
    )
    if (staleRoof) {
      await supabase
        .from('sms_conversations')
        .update({ roofing_state: staleRoof, updated_at: new Date().toISOString() })
        .eq('id', conversation.id)
      convRec.roofing_state = staleRoof
      console.log('[sms/inbound] step 3 — expired idle roofing_state on reused conversation', {
        conversationId: conversation.id,
        idleMinutes: Math.round(ageMs / 60000),
      })
    }
    const stalePaint = expireIdlePaintingState(
      (convRec.painting_state ?? null) as PaintingConversationState | null,
      ageMs,
    )
    if (stalePaint) {
      await supabase
        .from('sms_conversations')
        .update({ painting_state: stalePaint, updated_at: new Date().toISOString() })
        .eq('id', conversation.id)
      convRec.painting_state = stalePaint
      console.log('[sms/inbound] step 3 — expired idle painting_state on reused conversation', {
        conversationId: conversation.id,
        idleMinutes: Math.round(ageMs / 60000),
      })
    }

    // For done-grace reuse, flip status back to 'open' so the dialog appends
    // normally. We don't flip 'structuring' (it's mid-flight, leave it).
    if (conversation.status === 'done' && isReuseDoneGrace) {
      await supabase
        .from('sms_conversations')
        .update({ status: 'open', updated_at: new Date().toISOString() })
        .eq('id', conversation.id)
      conversation = { ...conversation, status: 'open' }
      console.log('[sms/inbound] step 3 — reopened done conversation (grace window)', {
        conversationId: conversation.id,
      })
    }
  } else {
    // Create a new conversation. Either there was no prior, or the prior
    // is past all reuse windows (abandoned 4h+ open, stuck 5min+ structuring,
    // or done >5min ago = returning customer for a new request).
    mode = 'new'
    const photoToken = randomBytes(16).toString('hex')
    // Pre-seed conversation_state from the customers row. Any field present
    // is marked source='from_memory' so the slot extractor + dialog know it
    // came from storage. If the customer corrects it later, mergeSlotUpdates
    // flips the source to 'customer_corrected', the scrub bails, AND the
    // eager write-back below propagates the change to the customers row.
    const initialState = seedStateFromKnownFields({
      first_name: customer?.first_name ?? null,
      suburb: customer?.suburb ?? null,
      address: customer?.address ?? null,
      email: customer?.email ?? null,
    })
    // R43 — idempotent create. Two webhooks for a brand-new from_number can
    // both reach this NEW branch within the same instant; a plain INSERT then
    // produces TWO active conversations, each wins its OWN per-row lock, and
    // BOTH run the dialog (duplicate replies / split-brain). Migration 122
    // adds a partial unique index (at most one ACTIVE customer_quote
    // conversation per (from_number, to_number)) and the RPC
    // create_sms_conversation_idempotent, which does a predicate-qualified
    // `ON CONFLICT DO NOTHING` (supabase-js's .upsert can't infer a PARTIAL
    // index — verified: a bare column-list ON CONFLICT is rejected) and, on a
    // lost race, RETURNS the existing active row. Either way the caller adopts
    // ONE canonical conversation; the loser persists its inbound there and the
    // per-conversation lock coalesces the two webhooks onto a single turn.
    // The adopt-which-row decision is in decideConversationUpsert (tested).
    let created: typeof prior = null
    // The RPC resolves win-vs-lost-race server-side and always returns the
    // canonical row as `created`, so raceWinner stays null here; it remains a
    // parameter to decideConversationUpsert (the single tested adoption gate)
    // for the legacy/edge case where only an existing row is available.
    const raceWinner: typeof prior = null
    const { data: rpcRow, error: rpcErr } = await supabase.rpc(
      'create_sms_conversation_idempotent',
      {
        p_from_number: fromNumber,
        p_to_number: toNumber,
        p_status: 'open',
        p_customer_id: customer?.id ?? null,
        // v6 multi-tenant: stamp the conversation with the tenant whose
        // destination number was texted. Null for legacy pre-v6 traffic.
        p_tenant_id: tenant?.id ?? null,
        p_photo_request_token: photoToken,
        p_conversation_state: initialState,
      },
    )
    // supabase.rpc returns the SETOF/composite row; normalise array|object.
    const rpcConversation = Array.isArray(rpcRow) ? rpcRow[0] : rpcRow
    // Back-compat: if migration 122 hasn't been applied yet (function missing
    // → PGRST202 / 42883), fall through to the legacy plain insert so the
    // route keeps working un-hardened rather than failing the customer.
    const rpcFnMissing =
      !!rpcErr &&
      ((rpcErr as { code?: string }).code === 'PGRST202' ||
        (rpcErr as { code?: string }).code === '42883' ||
        /function .*create_sms_conversation_idempotent.* does not exist/i.test(rpcErr.message ?? ''))
    if (rpcErr && !rpcFnMissing) {
      console.error('[sms/inbound] idempotent conversation create RPC failed', rpcErr)
      return new Response('DB error', { status: 500 })
    }
    if (rpcFnMissing) {
      // ALERTABLE (Phase 6 review fix): the route is running WITHOUT migration
      // 122's idempotent-create RPC, so two concurrent first-messages can each
      // create an active conversation → split-brain duplicate replies. This is
      // fail-open for availability, but an operator must apply migration 122 to
      // close the window — page on this, don't bury it as a warning.
      console.error('[sms/inbound][ALERT] migration 122 RPC missing — using un-hardened plain insert; split-brain duplicate-reply risk until 122 is applied', {
        code: (rpcErr as { code?: string }).code,
        remediation: 'run scripts/run-migration-122.mjs against this environment',
      })
      const { data: legacyCreated, error: legacyErr } = await supabase
        .from('sms_conversations')
        .insert({
          from_number: fromNumber,
          to_number: toNumber,
          status: 'open',
          customer_id: customer?.id ?? null,
          tenant_id: tenant?.id ?? null,
          photo_request_token: photoToken,
          conversation_state: initialState,
        })
        .select()
        .single()
      if (legacyErr || !legacyCreated) {
        console.error('[sms/inbound] conversation create failed', legacyErr)
        return new Response('DB error', { status: 500 })
      }
      created = legacyCreated
    } else {
      // The RPC already resolves win-vs-lost-race internally, so the row it
      // returns is always the canonical one. We still route it through
      // decideConversationUpsert for a single, tested adoption decision +
      // structured logging of the lost-race branch.
      created = rpcConversation ?? null
    }
    const upsertDecision = decideConversationUpsert(created, raceWinner)
    if (upsertDecision.action === 'fail') {
      console.error('[sms/inbound] conversation create failed — no row returned', {
        fromNumber,
        toNumber,
      })
      return new Response('DB error', { status: 500 })
    }
    conversation = created ?? raceWinner!
    customerHistoryHint = prior ? 'returning' : 'first_time'
    console.log('[sms/inbound] step 3 — NEW conversation', {
      conversationId: conversation.id,
      customerHistoryHint,
      priorAgeHours: prior ? Math.round(ageMs / 3600000 * 10) / 10 : null,
      priorStatus: prior?.status ?? null,
    })
  }

  // 4a. If this is an MMS, fetch the media from Twilio and upload to our
  //     intake-photos bucket BEFORE persisting the inbound row, so the
  //     resulting signed URLs + permanent paths land on the same row.
  let inboundPhotoUrls: string[] = []
  let inboundPhotoPaths: string[] = []
  const numMedia = parseInt(params.NumMedia ?? '0', 10)
  if (Number.isFinite(numMedia) && numMedia > 0) {
    console.log('[sms/inbound] step 4a — extracting MMS attachments', {
      numMedia,
      conversationId: conversation.id,
    })
    try {
      const result = await extractAndStoreMmsPhotos({
        conversationId: conversation.id,
        params,
      })
      inboundPhotoUrls = result.signedUrls
      inboundPhotoPaths = result.paths
      const failed = result.attempts.filter(a => !a.ok)
      if (failed.length) {
        console.warn('[sms/inbound] step 4a — some MMS attachments failed', {
          ok: result.signedUrls.length,
          failed: failed.length,
          reasons: failed.map(f => 'reason' in f ? f.reason : 'unknown'),
        })
      } else {
        console.log('[sms/inbound] step 4a — MMS attachments stored', {
          count: result.signedUrls.length,
        })
      }
    } catch (e) {
      console.error('[sms/inbound] step 4a — MMS extraction threw', e)
    }
  }

  console.log('[sms/inbound] step 4 — persisting inbound', {
    conversationId: conversation.id,
    photoCount: inboundPhotoUrls.length,
  })
  // Phase 7 — structured trace for the inbound boundary. Fire-and-forget
  // DB write; failures are silently swallowed by recordTrace().
  void recordTrace(supabase, {
    step: 'sms_inbound',
    status: 'ok',
    message: `inbound SMS persisted (conversation_id=${conversation.id})`,
    inputs: {
      from_number: fromNumber,
      to_number: toNumber,
      body_length: inboundBody.length,
      photo_count: inboundPhotoUrls.length,
      message_sid: messageSid,
    },
    decisions: {
      tenant_id: tenant?.id ?? null,
      conversation_id: conversation.id,
      conversation_status_before: conversation.status,
      customer_history: customerHistoryHint,
    },
    tenant_id: tenant?.id ?? null,
    sms_conversation_id: conversation.id,
  })
  // 4. Persist the inbound message — including any MMS photo URLs we
  //    just stored. After this point everything is moved into after()
  //    so we can ack Twilio with 200 quickly and prevent timeout-driven
  //    retries (which would otherwise produce duplicate replies).
  //
  // The application-layer idempotency check above catches almost all
  // retries; the unique partial index created in migration 004 catches
  // the racy window where two retries arrive within the same millisecond.
  // PostgreSQL error 23505 = unique_violation → ack as duplicate.
  const { error: insertErr } = await supabase.from('sms_messages').insert({
    conversation_id: conversation.id,
    direction: 'inbound',
    body: inboundBody,
    twilio_message_sid: messageSid,
    photo_urls: inboundPhotoUrls,
    photo_paths: inboundPhotoPaths,
  })
  // R47 — the 23505-vs-real-error classification is extracted to
  // classifyInboundInsert (tested) so the same-millisecond retry race (caught
  // by migration 004's unique partial index) is always acked as a duplicate
  // and never mistaken for a generic DB failure.
  const insertOutcome = classifyInboundInsert(insertErr)
  if (insertOutcome.action === 'ack_duplicate') {
    console.warn('[sms/inbound] race lost — duplicate MessageSid landed concurrently', {
      messageSid,
      conversationId: conversation.id,
    })
    return ackTwiml()
  }
  if (insertOutcome.action === 'db_error') {
    console.error('[sms/inbound] inbound persist failed', insertErr)
    return new Response('DB error', { status: 500 })
  }

  // ─────── Per-conversation lock claim ───────
  // Atomically try to claim "I'm the leader who'll prepare the next reply
  // for this conversation". If the row's processing_until is NULL or in
  // the past, we win the lock; otherwise another webhook is already
  // running Sonnet for this customer and we should bail without sending
  // a duplicate reply. The follower's inbound message is already persisted
  // (above) so the leader will see it when it loads conversation history.
  //
  // R43 ORDERING (persist-before-lock): the inbound INSERT above runs BEFORE
  // this lock claim deliberately. A webhook that loses the lock has ALREADY
  // persisted its inbound row, so the leader picks it up in the post-debounce
  // history read — no inbound is ever left unprocessed. Combined with the
  // migration-122 idempotent create, two concurrent first-messages now
  // converge on ONE conversation row and ONE leader instead of split-brain.
  //
  // Lock auto-expires after 60s in case a function crashes mid-flow —
  // a customer is never permanently blocked.
  const LOCK_DURATION_MS = 60 * 1000
  const lockUntilIso = new Date(Date.now() + LOCK_DURATION_MS).toISOString()
  const nowIso = new Date().toISOString()

  const { data: lockedRow, error: lockErr } = await supabase
    .from('sms_conversations')
    .update({ processing_until: lockUntilIso })
    .eq('id', conversation.id)
    .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
    .select()
    .maybeSingle()

  // Distinguish three outcomes:
  //   1. lockErr set         → DB / schema problem. FAIL OPEN — process the
  //                            message without dedup. Customer reply is more
  //                            important than risking an occasional duplicate.
  //                            Common case: migration 007 not yet applied →
  //                            'processing_until' column missing → PGRST204.
  //   2. lockedRow set       → we acquired the lock cleanly, proceed.
  //   3. lockedRow null + no err → another webhook holds the lock. Coalesce.
  const lockInfraBroken = !!lockErr
  if (lockInfraBroken) {
    console.error('[sms/inbound] lock claim threw — FAILING OPEN (processing without dedup)', {
      conversationId: conversation.id,
      code: (lockErr as { code?: string } | null)?.code,
      message: lockErr?.message,
      hint: 'If code=PGRST204 the migration 007_sms_conversation_locking.sql has not been applied — run scripts/run-conversation-locking-migration.mjs',
    })
  } else if (!lockedRow) {
    // Real coalesce — lock infra is working AND another webhook holds it.
    // Our message is persisted; the leader's debounce window will pick it up.
    console.log('[sms/inbound] coalesced — leader holds the lock; bailing without dispatch', {
      conversationId: conversation.id,
    })
    return ackTwiml()
  }

  // ─────── Fast-ack the webhook ───────
  // Everything below — Sonnet call, Twilio outbound, conversation update,
  // intake handoff — runs after the 200 is returned. This keeps the
  // webhook latency under ~500ms regardless of how long Sonnet takes.
  const conversationId = conversation.id
  const initialAssumptions = (conversation.assumptions_made as string[] | null) ?? []
  const initialTurnCount = conversation.turn_count
  // Capture pre-reuse quote state. When a conversation is reused under
  // the done-grace path (status='done' for 60s-5min before the customer
  // texts back), the route flips status to 'open' so the dialog can
  // append normally. But "status was done before we reopened it" is the
  // ground-truth signal that a quote was ALREADY drafted on this
  // conversation. Capturing it as a closure variable lets the after()
  // guard refuse to re-fire intake/quote even if the freshly-queried
  // intake_id is somehow racy or stale.
  const priorIntakeId = (conversation.intake_id as string | null) ?? null
  // Decision pulled out to lib/sms/quote-already-drafted.ts so the rule
  // is testable + can't silently regress. The 2026-05-28 prod incident
  // (Sparky convo 1c639179) showed why: the old inline rule conflated
  // "customer said bye → status=done" with "quote was drafted → status
  // =done", silently killing photo SMS + WP9 + intake handoff on
  // re-engagement after a dismissal. See that module's docstring + tests.
  const quoteAlreadyDrafted = computeQuoteAlreadyDrafted(mode, prior)
  // Slot state captured at request entry. Inside after() we run the slot
  // extractor against the customer's latest inbound and merge any updates
  // back into this state, then persist + pass into the dialog Sonnet call.
  const initialConversationState: ConversationState = normaliseState(conversation.conversation_state)
  // Photo-request state — passed into after() so we can decide whether
  // to fire the upload-link SMS (parallel to Sonnet's reply, only on the
  // first turn that identifies an easy-5 job_type, never twice).
  const photoRequestToken = conversation.photo_request_token as string | null
  const photoRequestAlreadySent = !!conversation.photo_request_sent_at
  // Customer-history hint flows into the dialog agent so it picks the
  // right opener: full intro / welcome-back / no greeting.
  const customerHistory = customerHistoryHint
  // Lookup mode controls the after() flow.
  const lookupMode = mode
  // 'inflight' means the customer texted again while their quote is still
  // being drafted. The dialog STILL runs (so they can answer questions,
  // decline photos, chat — never blocked), but as a CONTINUATION turn:
  // the route skips the photo gate, the WP9 product-choice interlock, the
  // status write, and the intake handoff, so this turn can never collide
  // with — or duplicate — the quote already drafting in the background.
  // The dialog also gets the quoteInProgress directive so it never tries
  // a second verification handshake / handoff.
  const inflightContinuation = lookupMode === 'inflight'
  // Photo-link hint flows into Sonnet. Sonnet owns the timing decision
  // via decision.request_photo_link (see lib/sms/dialog.ts Rule 10).
  //   - already_sent:   photo SMS fired in an earlier turn, don't repeat
  //   - pending:        photo not yet sent and token exists; Sonnet
  //                     decides the right turn to fire it (typically
  //                     after all qualifying questions are answered,
  //                     combined with the verification handshake)
  //   - not_applicable: no token / legacy conversation
  const photoLinkHint: 'already_sent' | 'pending' | 'not_applicable' =
    photoRequestAlreadySent ? 'already_sent'
      : photoRequestToken ? 'pending'
      : 'not_applicable'

  after(async () => {
    // R42 — wall-clock at after() entry so we can detect (via isNearMaxDuration)
    // when the heavy pipeline is approaching the maxDuration budget and emit the
    // after_near_max_duration alert before sends get cut off mid-flight.
    const afterStartedAt = Date.now()
    // When we read the authoritative history. Any inbound newer than this was
    // never processed by us — the orphan-drain check in `finally` needs it, so
    // it is declared out here rather than inside the try.
    let historyReadAt: string | null = null
    try {
      // ─────── In-flight continuation ───────
      // The customer texted while their PREVIOUS quote is still being
      // drafted (status='structuring') or just dispatched (status='done'
      // < 60s old). Previously this short-circuited to a canned hold-on
      // and skipped the dialog — which blocked the customer from
      // answering questions or chatting and made quoting feel synchronous.
      // Now the dialog runs normally (see `inflightContinuation`): the
      // customer is never blocked. The collision guards — skip the photo
      // gate, WP9, the status write and the intake handoff — live at
      // their respective sites below, so this turn can never spawn a
      // second draft or clobber the in-flight quote's status.

      // ─────── Debounce window (R44 — adaptive) ───────
      // Wait to let any rapid-fire follow-up messages land before we read
      // history + run Sonnet. Customer firing "Hey there" + "Hi there" within
      // ~1s lands both in DB; we then call Sonnet ONCE with both in history and
      // reply ONCE. The follow-up webhook fails to claim the lock and bails
      // (its message is already persisted — so nothing is dropped).
      //
      // R44 — the window is no longer a fixed 1500ms. We first read the
      // arrival timestamps of the current un-replied inbound burst and let
      // adaptiveDebounceMs size the wait: a lone text replies promptly (base
      // window), while a fast burst EXTENDS the wait (capped at ~4× base) so a
      // trailing text isn't missed. Crucially this only sets a WAIT — every
      // queued inbound is still read in the full history load below AFTER the
      // wait, so coalescing never drops a message even when the leader read
      // history "first" (the post-wait read is the authoritative one).
      const { data: burstRows } = await supabase
        .from('sms_messages')
        .select('direction, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
      const debounceMs = adaptiveDebounceMs(
        arrivalTimestampsFromTurns(burstRows),
        DELIVERY_KNOBS,
      )
      console.log('[sms/inbound:after] step 5 — adaptive debounce', {
        conversationId,
        debounceMs,
        baseMs: DELIVERY_KNOBS.debounceMs,
        burstInbounds: arrivalTimestampsFromTurns(burstRows).length,
      })
      if (debounceMs > 0) await new Promise(r => setTimeout(r, debounceMs))

      console.log('[sms/inbound:after] step 5 — loading conversation history (post-debounce)', { conversationId })
      // 5. Load the full message history (oldest first) — including the inbound
      //    we just persisted AND any rapid-fire messages that landed during
      //    the debounce window. This read happens AFTER the adaptive wait so
      //    every queued inbound is included (R44: no message dropped).
      //    supabase-js RESOLVES {data, error} on failure. An unchecked read
      //    here is not merely a missing log: `turns` becomes [], so
      //    lastOutboundAskedAddress() reads "we never asked for an address"
      //    and dedupeConsecutiveReply() has no previous outbound to compare —
      //    both new backstops switch themselves off, silently, on every turn
      //    (specs/address-confirm-loop.md).
      const { data: historyRows, error: historyError } = await supabase
        .from('sms_messages')
        .select('direction, body, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
      if (historyError) {
        console.error('[sms/inbound:after] sms_messages history read FAILED - transcript-keyed guards are blind this turn', {
          conversationId,
          error: historyError,
        })
      }

      historyReadAt = new Date().toISOString()
      const turns: ConversationTurn[] = (historyRows ?? []).map(m => ({
        direction: m.direction as 'inbound' | 'outbound',
        body: m.body,
      }))
      const inboundCount = turns.filter(t => t.direction === 'inbound').length

      // US-003 (audit 2026-07-23) — a standard Twilio opt-out keyword as the
      // whole message ends the thread on EVERY conversation type, not just
      // inside the roofing/painting receptionists.
      //
      // Review follow-up (2026-07-23): Twilio's DEFAULT opt-out handling
      // covers US/CA long codes and toll-free — NOT the AU long codes this
      // stack sends from. So the carrier has not blocked the number and
      // silence here would be the exact failure mode the dispatch-retry
      // commits exist to prevent. We confirm once (best-effort — if some
      // upstream filter HAS blocked the number the send just fails), then
      // close. roofing_state is only written when there is actually an
      // active roofing flow to close (flag-off threads stay byte-identical).
      const lastInboundBody =
        [...turns].reverse().find(t => t.direction === 'inbound')?.body ?? ''
      if (isGlobalOptOut(lastInboundBody)) {
        console.log('[sms/inbound:after] opt-out keyword — confirming once and closing', { conversationId })
        try {
          const res = await dispatchQuoteMessage({ to: fromNumber, from: toNumber, text: OPT_OUT_CONFIRMATION })
          if (res.ok) {
            await supabase.from('sms_messages').insert({
              conversation_id: conversationId,
              direction: 'outbound',
              body: OPT_OUT_CONFIRMATION,
            })
          }
        } catch (e) {
          console.warn('[sms/inbound:after] opt-out confirmation not sent (non-fatal)', e)
        }
        try {
          const staleRoofing = closeStaleRoofingState(
            ((conversation as Record<string, unknown>).roofing_state ?? null) as RoofingConversationState | null,
          )
          await supabase
            .from('sms_conversations')
            .update({
              status: 'done',
              ...(staleRoofing ? { roofing_state: staleRoofing } : {}),
              updated_at: new Date().toISOString(),
            })
            .eq('id', conversationId)
        } catch (e) {
          console.warn('[sms/inbound:after] opt-out close failed (non-fatal)', e)
        }
        return
      }

      // Is a follow-up pin active on this thread? The tradie may have just
      // chased a DIFFERENT quote (e.g. Ceiling Fans) on the customer's
      // shared phone thread, which can carry stale roofing_state /
      // painting_state from an earlier trade enquiry. Read the pin ONCE,
      // before the deterministic receptionists, so a stale trade flow can't
      // hijack a follow-up reply ("Yes" → "how steep is the roof?"). The pin
      // lives in the followup_quote column (immune to slot-merge) and is
      // already on the `conversation` row (loaded with select('*')).
      // (Spec 2026-07-05 Part A2.)
      const followupPinActive = isFollowupContextActive(
        parseFollowupQuoteContext((conversation as Record<string, unknown>).followup_quote),
        Date.now(),
      )

      // ─────── SMS roofing receptionist (per-tenant) ───────
      // A roofing enquiry (or an in-progress roofing thread) is handled by
      // the deterministic roofing receptionist instead of the
      // electrical/plumbing Sonnet dialog: gather inputs → run the roofing
      // measure/price pipeline → reply with the MMS + quote link.
      //
      // Gate = the tenant's OWN roofing toggle (tenants.trades[]), which is
      // what /api/tenant/trades/{activate,reconcile}, the admin customers
      // page and plan grants all write. Every provisioned number therefore
      // runs the same roofing receptionist the moment roofing is enabled on
      // its account — no deploy, no env change. The env flag survives only
      // for inbounds that map to NO tenant (dev shared number).
      // Grounded facts the LLM receptionist may state. Built from the
      // tenant row and NOTHING else — contact details and credentials are
      // not copied, so they cannot be surfaced no matter what is asked.
      const tenantFacts: TenantFacts | null = tenant
        ? buildTenantFacts({
            business_name: tenant.business_name,
            owner_first_name: tenant.owner_first_name,
            trades: tenant.trades,
            state: tenant.state,
          })
        : null

      const roofingEnabled = tenant
        ? tenantHasRoofingTrade(tenant.trades)
        : SMS_ROOFING_ENABLED
      if (roofingEnabled && !inflightContinuation) {
        try {
          const handledRoofing = await handleRoofingTurn({
            conversationId,
            roofingStateRaw: (conversation as Record<string, unknown>).roofing_state,
            // The PREVIOUS turn's state: extractSlots runs AFTER the
            // receptionists, so this is the gather as it stood when the
            // customer sent this message.
            generalMidGather: generalDialogIsMidGather(
              (conversation as Record<string, unknown>).conversation_state,
            ),
            turns,
            toNumber,
            fromNumber,
            tenantId: tenant?.id ?? null,
            tenantTrade: tenant?.trade ?? null,
            // NO guessFirstName here: every receptionist turn answers a
            // closed-ended question we asked, which is exactly the shape
            // the heuristic can't tell from a name — live 2026-07-23 it
            // greeted the customer "Hi Classic" (a Colorbond profile)
            // then "Hi Main" (a building pick). Dialog-gathered name
            // first, tenant-scoped CRM name second, else nameless.
            firstName: initialConversationState.slots.first_name ?? customer?.first_name ?? null,
            followupPinActive,
            roofingOnly: tenantIsRoofingOnly(tenant?.trades),
            // Hand over ONLY what the customer said in this conversation.
            // A from_memory slot is pre-seeded from the customers row,
            // which is keyed on phone number alone and can hold a suburb
            // from an unrelated earlier job — that is the same stale data
            // behind the "Got it, Chillingham not Chandler" reply, and
            // seeding it here would quote the wrong building outright.
            generalAddress: {
              address:
                initialConversationState.sources.address === 'from_memory'
                  ? null
                  : initialConversationState.slots.address,
              suburb:
                initialConversationState.sources.suburb === 'from_memory'
                  ? null
                  : initialConversationState.slots.suburb,
            },
            tenantFacts,
          })
          if (handledRoofing) {
            console.log('[sms/inbound:after] handled by roofing receptionist', { conversationId })
            return
          }
        } catch (e) {
          console.error('[sms/inbound:after] roofing receptionist threw — falling through to standard dialog', e)
        }
      } else if (!roofingEnabled) {
        // US-006 (audit 2026-07-23) — roofing was just turned OFF for this
        // tenant while the thread was mid-flow. Close the stale
        // roofing_state so the general dialog doesn't inherit a warm
        // roofing thread it can't speak to, and a later re-enable doesn't
        // resume a zombie flow. Best-effort.
        const staleClosed = closeStaleRoofingState(
          ((conversation as Record<string, unknown>).roofing_state ?? null) as RoofingConversationState | null,
        )
        if (staleClosed) {
          console.log('[sms/inbound:after] roofing disabled mid-thread — closing stale roofing_state', { conversationId })
          try {
            await supabase
              .from('sms_conversations')
              .update({ roofing_state: staleClosed, updated_at: new Date().toISOString() })
              .eq('id', conversationId)
          } catch (e) {
            console.warn('[sms/inbound:after] stale roofing_state close failed (non-fatal)', e)
          }
        }
      }

      // ─────── SMS painting receptionist (flag-gated) ───────
      // When enabled, a painting enquiry (or an in-progress painting thread)
      // is handled by the deterministic painting receptionist instead of the
      // electrical/plumbing Sonnet dialog: offer the self-serve form link
      // first → otherwise gather inputs question-by-question → run the
      // painting estimate → reply with the G/B/B quote link.
      // Same per-tenant gate as roofing above: the tenant's own painting
      // toggle in trades[] decides, and the env flag is only the
      // no-tenant fallback.
      const paintingEnabled = tenant
        ? tenantHasFeature(tenant.trades, 'painting')
        : SMS_PAINTING_ENABLED
      if (paintingEnabled && !inflightContinuation) {
        try {
          const handledPainting = await handlePaintingTurn({
            conversationId,
            paintingStateRaw: (conversation as Record<string, unknown>).painting_state,
            generalMidGather: generalDialogIsMidGather(
              (conversation as Record<string, unknown>).conversation_state,
            ),
            turns,
            toNumber,
            fromNumber,
            tenantId: tenant?.id ?? null,
            // Same rule as the roofing receptionist above — never guess a
            // name from answers to our own gathering questions.
            firstName: initialConversationState.slots.first_name ?? customer?.first_name ?? null,
            followupPinActive,
            tenantFacts,
          })
          if (handledPainting) {
            console.log('[sms/inbound:after] handled by painting receptionist', { conversationId })
            return
          }
        } catch (e) {
          console.error('[sms/inbound:after] painting receptionist threw — falling through to standard dialog', e)
        }
      }

      // ─────── WP9 CAPTURE — record a pending product pick ───────
      // If we offered the customer 2 products last turn and this inbound
      // is their pick ("1" / "2" / a product name), record it on the
      // dedicated product_choice column (immune to the slot-merge
      // wholesale overwrite — same reasoning as the followup_quote
      // column, migration 030/035). We then REWRITE what the dialog
      // sees for this turn into a natural sentence so it acknowledges
      // and moves on — no extra SMS, no short-circuit. Best-effort and
      // fully flag-gated: OFF ⇒ this block is skipped entirely.
      if (WP9_ENABLED) {
        try {
          const { data: pcRow } = await supabase
            .from('sms_conversations')
            .select('product_choice')
            .eq('id', conversationId)
            .maybeSingle()
          const pending = (pcRow?.product_choice ?? null) as ProductChoiceState | null
          if (pending && pending.status === 'pending') {
            const choiceAllowed = productChoiceAllowedForSupply(
              pending.category,
              initialConversationState.slots.supplied_by as string | undefined,
            )
            if (!choiceAllowed) {
              const { error: clearChoiceError } = await supabase
                .from('sms_conversations')
                .update({ product_choice: null, updated_at: new Date().toISOString() })
                .eq('id', conversationId)
              if (clearChoiceError) throw clearChoiceError
              console.log('[sms/inbound:after] WP9 CAPTURE — cleared EV unit choice for customer-supplied charger', {
                conversationId,
              })
            } else {
              const lastInbound = [...turns].reverse().find((t) => t.direction === 'inbound')
              const reply = lastInbound?.body ?? ''
              const next = applyChoiceSelection(pending, { reply })
              if (next && next.status === 'chosen' && next.chosen_catalogue_id) {
                await supabase
                  .from('sms_conversations')
                  .update({ product_choice: next, updated_at: new Date().toISOString() })
                  .eq('id', conversationId)
                // Make the dialog acknowledge the pick naturally instead
                // of being confused by a bare "1".
                if (lastInbound) {
                  lastInbound.body = `I'd like the ${next.chosen_name}, thanks.`
                }
                console.log('[sms/inbound:after] WP9 CAPTURE — product choice recorded', {
                  conversationId,
                  chosen: next.chosen_name,
                  catalogueId: next.chosen_catalogue_id,
                })
              } else if (next && next.status === 'declined') {
                // Customer opted OUT of catalogue options. Resolve the
                // choice with no chosen product and rewrite the turn so
                // the dialog reads a clear "standard quote" intent and
                // proceeds to finish — the estimator then does a
                // conventional Good/Better/Best from the base assemblies.
                await supabase
                  .from('sms_conversations')
                  .update({ product_choice: next, updated_at: new Date().toISOString() })
                  .eq('id', conversationId)
                if (lastInbound) {
                  lastInbound.body =
                    'No catalogue options for me thanks — just do me a standard quote.'
                }
                console.log('[sms/inbound:after] WP9 CAPTURE — customer declined catalogue options (conventional GBB)', {
                  conversationId,
                })
              }
            }
          }
        } catch (e: any) {
          console.warn('[sms/inbound:after] WP9 CAPTURE skipped (non-fatal)', {
            conversationId,
            error: e?.message ?? String(e),
          })
        }
      }

      // ─────── Slot extraction (PR-B step 4) ───────
      // Run a tiny Sonnet NLU pass against the latest inbound and merge
      // structured updates into conversation_state. Catches customer
      // corrections in real time — without this, "Chandler" arrives as
      // plain text in sms_messages and nothing tracks the change, so the
      // dialog Sonnet has to re-derive every turn (and sometimes drops it).
      // Fail-open: extraction failure leaves the dialog running on stale state.
      let conversationState: ConversationState = initialConversationState
      try {
        // Rapid-fire debounce coalescing: when a customer fires multiple
        // SMS in <1.5s (e.g. "Hi", "I need 6 downlights", "in the lounge"),
        // the 1.5s debounce window collects ALL of them into the
        // sms_messages table before this slot-extractor turn runs. The
        // dialog Sonnet already sees them as separate history entries, but
        // the slot extractor used to receive ONLY the last inbound's body
        // — so the first two messages' context was silently dropped.
        //
        // Concat every inbound that landed AFTER the most recent outbound
        // (i.e. every message in this batch the agent hasn't responded to
        // yet) and feed them to the extractor as a single combined turn.
        const lastOutboundIdx = (() => {
          for (let i = turns.length - 1; i >= 0; i--) {
            if (turns[i].direction === 'outbound') return i
          }
          return -1
        })()
        const pendingInbounds = turns
          .slice(lastOutboundIdx + 1)
          .filter(t => t.direction === 'inbound')
          .map(t => t.body)
        const lastInbound = pendingInbounds.length > 1
          ? pendingInbounds.join('\n---\n')
          : pendingInbounds[0] ?? turns.filter(t => t.direction === 'inbound').at(-1)?.body ?? ''
        const lastOutbound = turns.filter(t => t.direction === 'outbound').at(-1)?.body ?? null
        if (pendingInbounds.length > 1) {
          console.log('[sms/inbound:after] coalescing rapid-fire inbounds for slot extraction', {
            pendingCount: pendingInbounds.length,
            chars: lastInbound.length,
          })
        }
        const extraction = await extractSlots({
          state: conversationState,
          lastAgentMessage: lastOutbound,
          customerMessage: lastInbound,
          // v6 multi-tenant: tell the extractor what trades this
          // specific tradie offers so a wrong-trade job_type never
          // pollutes conversation_state. Empty/undefined falls back
          // to permissive extraction for legacy pre-v6 traffic.
          tenantTrades: tenant?.trades,
        })
        const updateKeys = Object.keys(extraction.updates).filter(
          k => extraction.updates[k as keyof typeof extraction.updates] !== null
            && extraction.updates[k as keyof typeof extraction.updates] !== undefined,
        )
        if (updateKeys.length > 0) {
          const next = mergeSlotUpdates(conversationState, extraction.updates)
          if (next.last_extracted_at !== conversationState.last_extracted_at) {
            await supabase
              .from('sms_conversations')
              .update({ conversation_state: next, updated_at: new Date().toISOString() })
              .eq('id', conversationId)
            conversationState = next
            console.log('[sms/inbound:after] slots extracted + merged', {
              updates: updateKeys,
              sources: next.sources,
              reasoning: extraction.reasoning,
            })

            // ─────── Eager profile write-back ───────
            // When the customer corrects a persistent profile slot (name,
            // suburb, address, email) — either implicitly ("Chandler" when
            // we had Coorparoo) or explicitly ("update my address to X") —
            // persist the change to the customers row immediately. Don't
            // wait for finish: the change should survive an early exit
            // (end_conversation, escalate_inspection) and be available to
            // every future conversation from this number.
            if (customer?.id) {
              const correctedProfileSlots = PERSISTENT_PROFILE_SLOTS.filter(
                k => updateKeys.includes(k) && next.sources[k] === 'customer_corrected',
              )
              if (correctedProfileSlots.length > 0) {
                const fields: Record<PersistentProfileSlot, string | null> = {
                  first_name: null, suburb: null, address: null, email: null,
                }
                for (const k of correctedProfileSlots) {
                  fields[k] = (next.slots[k] as string | undefined) ?? null
                }
                // P1 — never remember an address the map check refuses. Verify
                // the corrected street address (with its suburb) and drop both
                // when not_found, so a bogus "45 Wimbledon Crescent, Faketon"
                // can't become the customer's stored address and resurface next
                // conversation. Best-effort: a map outage keeps today's write.
                let gatedFields = fields
                if (fields.address) {
                  // Verify the FULL address: a correction may carry only the
                  // street ("update my address to 12 Archer St") while the
                  // suburb sits in the merged state — verifying the bare street
                  // would false-not_found and drop a valid address.
                  const suburbForCheck = fields.suburb ?? (next.slots.suburb as string | undefined) ?? null
                  const line = [fields.address, suburbForCheck].filter(Boolean).join(', ')
                  const v = await verifyAuAddress(line)
                  const outcome =
                    v.outcome === 'match' ? 'match' : v.outcome === 'not_found' ? 'not_found' : 'unavailable'
                  gatedFields = gateUnverifiedProfileAddress(fields, outcome)
                  if (gatedFields.address == null && fields.address != null) {
                    console.log('[sms/inbound:after] dropped unverified corrected address from memory', {
                      conversationId,
                      customerId: customer.id,
                      refused: line,
                    })
                  }
                }
                console.log('[sms/inbound:after] eager profile write-back triggered', {
                  conversationId,
                  customerId: customer.id,
                  fields: correctedProfileSlots,
                })
                try {
                  await writeCustomerCorrections({
                    customerId: customer.id,
                    tenantId: tenant?.id ?? null,
                    fields: gatedFields,
                  })
                } catch (e: any) {
                  console.warn('[sms/inbound:after] eager write-back threw - non-fatal, finish-time backfill will retry', {
                    message: e?.message,
                  })
                }
              }
            }
          }
        } else {
          console.log('[sms/inbound:after] no slot updates this turn', {
            reasoning: extraction.reasoning,
          })
        }
      } catch (e: any) {
        // Surface ENOUGH context to diagnose the failure without re-running:
        //   - which conversation (so we can correlate with stored state)
        //   - which inbound message triggered it (the customer text)
        //   - what slots were ALREADY in conversationState (so we know
        //     what stale data Sonnet is about to see)
        //   - the actual error class + first stack frame
        // Without this the only signal was "slot extraction failed" with
        // no way to tell if it was a 5s Sonnet timeout, a Zod parse error
        // on a malformed extraction response, or a Supabase write failure.
        const lastInbound = turns.filter(t => t.direction === 'inbound').at(-1)?.body ?? ''
        console.error('[sms/inbound:after] slot extraction FAILED - continuing with stale state', {
          conversationId,
          fromNumber,
          tenantId: tenant?.id ?? null,
          inboundChars: lastInbound.length,
          inboundPreview: lastInbound.slice(0, 80),
          staleStateSlots: Object.keys(conversationState.slots ?? {}),
          staleStateSources: conversationState.sources ?? {},
          error_message: e?.message,
          error_name: e?.name,
          first_stack_frame: e?.stack?.split('\n')[1]?.trim(),
        })
      }

      // A correction such as "I already have the charger" can arrive after
      // an EV product offer. Clear the persisted choice immediately so a
      // stale pending/chosen unit cannot leak into this or the next quote.
      if (
        WP9_ENABLED &&
        !productChoiceAllowedForSupply(
          conversationState.slots.job_type as string | undefined,
          conversationState.slots.supplied_by as string | undefined,
        )
      ) {
        const { error: clearEvChoiceError } = await supabase
          .from('sms_conversations')
          .update({ product_choice: null, updated_at: new Date().toISOString() })
          .eq('id', conversationId)
        if (clearEvChoiceError) {
          console.warn('[sms/inbound:after] failed to clear EV unit choice after customer-supply correction', {
            conversationId,
            error: clearEvChoiceError.message,
          })
        } else {
          console.log('[sms/inbound:after] cleared EV unit choice after customer-supply correction', {
            conversationId,
          })
        }
      }

      console.log('[sms/inbound:after] step 6 — calling Sonnet dialog agent', {
        turnCount: turns.length,
        inboundCount,
        customerHistory,
        photoLink: photoLinkHint,
        // Surface state knowledge so we can audit in prod logs whether the
        // dialog is being driven by stored slots vs raw transcript.
        stateSlots: Object.keys(conversationState.slots),
        stateSources: conversationState.sources,
        customerHydrated: !!customer,
        customerHasName: !!customer?.first_name,
        customerHasSuburb: !!customer?.suburb,
        customerTotalQuotes: customer?.total_quotes ?? 0,
      })
      // 6. Ask Sonnet what to do next — ask | finish | escalate_inspection.
      // customerHistory drives Rule 9 (opener logic): first_time → full intro,
      // returning → "welcome back", continuing → no greeting.
      // photoLink drives Rule 10 (photo heads-up): will_send_now → tell the
      // customer a link is coming; already_sent → don't repeat.
      // ─── Tenant custom services (migration 023) ───────────────────
      // The dialog's built-in scope only knows the hardcoded easy-5 per
      // trade. Without the tradie's OWN enabled custom services in the
      // prompt, the agent refuses them ("we're plumbers only, dishwasher
      // installs are outside what we do") even though the tradie added
      // and enabled "Install dishwasher" on the dashboard. We fetch only
      // enabled rows so a turned-off toggle genuinely removes the service
      // from what the AI will take. Fail-soft: a DB hiccup here must
      // never block the customer's reply — fall back to no custom block
      // (legacy behaviour) and log.
      let customAssemblies:
        | Array<{
            name: string
            description: string | null
            always_inspection: boolean
            category?: string | null
            clarifying_questions?: string[] | null
          }>
        | undefined
      if (tenant?.id) {
        const { data: caRows, error: caErr } = await supabase
          .from('tenant_custom_assemblies')
          // select('*') (not an explicit list) so a pre-032 prod without
          // the clarifying_questions column can't error → null scope.
          .select('*')
          .eq('tenant_id', tenant.id)
          .eq('enabled', true)
          .order('trade')
          .order('name')
        if (caErr) {
          console.warn('[sms/inbound:after] custom-services fetch failed — continuing without custom scope', {
            tenantId: tenant.id,
            message: caErr.message,
          })
        } else if (caRows && caRows.length > 0) {
          customAssemblies = caRows.map((r) => ({
            name: r.name as string,
            description: (r.description as string | null) ?? null,
            always_inspection: !!r.always_inspection,
            category: (r.category as string | null) ?? null,
            clarifying_questions: normaliseQuestions(
              (r as Record<string, unknown>).clarifying_questions,
            ),
          }))
          console.log('[sms/inbound:after] custom services in dialog scope', {
            tenantId: tenant.id,
            count: customAssemblies.length,
            autoQuote: customAssemblies.filter((c) => !c.always_inspection).length,
            inspectionOnly: customAssemblies.filter((c) => c.always_inspection).length,
          })
        }
      }

      // ─── Tenant ENABLED catalogue extras (the toggle ↔ AI sync) ──────
      // The dialog only knew the hardcoded easy-5 + custom services, so
      // toggling a SHARED catalogue extra ON (e.g. "Install dishwasher",
      // "Hardwire induction cooktop") in the Services tab had ZERO effect
      // on what the AI would take — the exact bug Jon hit. We now also
      // feed in the tenant's enabled catalogue EXTRAS (the migration-021
      // opt-in services, default_enabled=false). Core easy-5 rows
      // (default_enabled=true) are skipped — they're already in the
      // system prompt, listing them again just bloats it. Turning an
      // extra OFF removes it here, so the toggle genuinely controls the
      // AI. Fail-soft + merged into the same in-scope list the
      // authoritative dialog directive renders.
      // 2026-05: now resolves every shared service using the dashboard
      // enabled rule (tenant offering wins, otherwise default_enabled),
      // so default-on priced rows with questions do not fall to $99.
      if (tenant?.id) {
        try {
          const tTrades: string[] =
            Array.isArray(tenant.trades) && tenant.trades.length > 0
              ? tenant.trades
              : tenant.trade
                ? [tenant.trade]
                : []
          if (tTrades.length > 0) {
            const [sharedRes, offeringRes] = await Promise.all([
              supabase
                .from('shared_assemblies')
                .select('*')
                .in('trade', tTrades)
                .order('trade')
                .order('name'),
              supabase
                .from('tenant_service_offerings')
                .select('assembly_id, enabled')
                .eq('tenant_id', tenant.id),
            ])
            const extras = resolveEnabledSharedAssembliesForDialog(
              (sharedRes.data ?? []) as SharedAssemblyScopeRow[],
              (offeringRes.data ?? []) as ServiceOfferingScopeRow[],
            )
            if (extras && extras.length > 0) {
              const seen = new Set(
                (customAssemblies ?? []).map((c) => c.name.trim().toLowerCase()),
              )
              const mapped = extras
                .map((r) => ({
                  name: r.name as string,
                  description: (r.description as string | null) ?? null,
                  always_inspection: false,
                  category: (r.category as string | null) ?? null,
                  clarifying_questions: normaliseQuestions(
                    (r as Record<string, unknown>).clarifying_questions,
                  ),
                }))
                .filter((r) => {
                  const k = r.name.trim().toLowerCase()
                  if (seen.has(k)) return false
                  seen.add(k)
                  return true
                })
              if (mapped.length > 0) {
                customAssemblies = [...(customAssemblies ?? []), ...mapped]
                console.log('[sms/inbound:after] enabled shared services in dialog scope', {
                  tenantId: tenant.id,
                  count: mapped.length,
                  names: mapped.map((m) => m.name),
                })
              }
            }
          }
        } catch (e) {
          console.warn('[sms/inbound:after] catalogue-extras fetch failed — continuing without them', {
            tenantId: tenant.id,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      } else {
        // ─── No-tenant fallback (Cluster A fix, 2026-05-20) ───────────
        // When the destination number doesn't map to a tenant (the dev
        // shared SMS number, or any unmapped traffic), feed the FULL
        // shared catalogue to the dialog as in-scope. Without this, every
        // migration-021 extra (LED strip, security camera, doorbell,
        // garbage disposal, rainwater tank, water filter) falls through
        // Rule 4/6 as out_of_scope because the dialog only sees the
        // hardcoded easy-5 in its system prompt.
        // resolveEnabledSharedAssembliesForDialog with assumeAllEnabled
        // still filters out the hardcoded easy-5 (no duplication).
        try {
          const { data: sharedRes } = await supabase
            .from('shared_assemblies')
            .select('*')
            .order('trade')
            .order('name')
          const extras = resolveEnabledSharedAssembliesForDialog(
            (sharedRes ?? []) as SharedAssemblyScopeRow[],
            [],
            { assumeAllEnabled: true },
          )
          if (extras && extras.length > 0) {
            const mapped = extras.map((r) => ({
              name: r.name as string,
              description: (r.description as string | null) ?? null,
              always_inspection: false,
              category: (r.category as string | null) ?? null,
              clarifying_questions: normaliseQuestions(
                (r as Record<string, unknown>).clarifying_questions,
              ),
            }))
            customAssemblies = [...(customAssemblies ?? []), ...mapped]
            console.log('[sms/inbound:after] no tenant — full catalogue fallback', {
              count: mapped.length,
            })
          }
        } catch (e) {
          console.warn('[sms/inbound:after] no-tenant catalogue fetch failed — continuing without it', {
            message: e instanceof Error ? e.message : String(e),
          })
        }
      }

      // ─── Tenant DECLINED services (toggle OFF → polite "we don't do
      // that", NOT the $99 inspection fallback) ──────────────────────
      // Mirrors the /api/tenant/me resolution: a catalogue service is OFF
      // when an explicit tenant_service_offerings row says enabled=false
      // OR there is no row and shared_assemblies.default_enabled is false;
      // disabled tenant_custom_assemblies count too. Without feeding these
      // in, an OFF electrical extra like "Hardwire oven" falls through to
      // the hardcoded Rule 4/6 ("oven/cooktop -> $99 inspection") and the
      // customer gets sold a paid inspection for work the tradie doesn't
      // do. Names only; names already in the ENABLED list above are
      // dropped (enabled wins). Fail-soft: a DB hiccup here must never
      // block the customer's reply.
      let declinedServices: string[] | undefined
      if (tenant?.id) {
        try {
          const tTrades: string[] =
            Array.isArray(tenant.trades) && tenant.trades.length > 0
              ? tenant.trades
              : tenant.trade
                ? [tenant.trade]
                : []
          if (tTrades.length > 0) {
            const [sharedRes, offeringRes, disabledCustomRes] = await Promise.all([
              supabase
                .from('shared_assemblies')
                .select('id, name, default_enabled')
                .in('trade', tTrades),
              supabase
                .from('tenant_service_offerings')
                .select('assembly_id, enabled')
                .eq('tenant_id', tenant.id),
              supabase
                .from('tenant_custom_assemblies')
                .select('name')
                .eq('tenant_id', tenant.id)
                .eq('enabled', false)
                .in('trade', tTrades),
            ])
            const offeringMap = new Map<string, boolean>(
              (offeringRes.data ?? []).map((o) => [
                o.assembly_id as string,
                o.enabled as boolean,
              ]),
            )
            const sharedOff = (sharedRes.data ?? [])
              .filter((a) => {
                const id = a.id as string
                const resolved = offeringMap.has(id)
                  ? (offeringMap.get(id) as boolean)
                  : ((a.default_enabled as boolean | null) ?? true)
                return resolved === false
              })
              .map((a) => a.name as string)
            const customOff = (disabledCustomRes.data ?? []).map(
              (a) => a.name as string,
            )
            // Drop anything already offered — `customAssemblies` holds the
            // ENABLED catalogue-extra + custom names fed to the dialog
            // above, and that block wins any name collision.
            const enabledNames = new Set(
              (customAssemblies ?? []).map((c) => c.name.trim().toLowerCase()),
            )
            const seen = new Set<string>()
            const merged = [...sharedOff, ...customOff].filter((n) => {
              const k = n.trim().toLowerCase()
              if (!k || enabledNames.has(k) || seen.has(k)) return false
              seen.add(k)
              return true
            })
            if (merged.length > 0) {
              declinedServices = merged
              console.log('[sms/inbound:after] declined services in dialog scope', {
                tenantId: tenant.id,
                count: merged.length,
              })
            }
          }
        } catch (e) {
          console.warn('[sms/inbound:after] declined-services fetch failed — continuing without them', {
            tenantId: tenant.id,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      }

      // Follow-up quote pin — read the DEDICATED followup_quote column
      // (migration 030), NOT conversation_state. The slot-merge writes
      // replace conversation_state wholesale, so a pin stashed there got
      // wiped on the first reply; this column is immune to that and the
      // pin survives the whole conversation, bounded by its own
      // expires_at. Best-effort — never blocks the turn.
      let followupCtxBlock = ''
      try {
        const { data: convFresh } = await supabase
          .from('sms_conversations')
          .select('followup_quote')
          .eq('id', conversation.id)
          .maybeSingle()
        followupCtxBlock = formatActiveFollowupContext(
          (convFresh as { followup_quote?: unknown } | null)?.followup_quote,
          Date.now(),
        )
      } catch (e) {
        console.warn(
          '[sms/inbound:after] follow-up context read failed — continuing',
          { message: e instanceof Error ? e.message : String(e) },
        )
      }

      let decision: Awaited<ReturnType<typeof decideNextTurn>>
      try {
        decision = await decideNextTurn({
          history: turns,
          inboundCount,
          customerHistory,
          photoLink: photoLinkHint,
          // Tenant's own enabled custom services (dishwasher install,
          // garbage disposal, etc.) — makes them in-scope so the dialog
          // quotes/inspects them instead of refusing as wrong-trade.
          customAssemblies,
          // Services the tradie switched OFF — produce a polite "we don't
          // do that" + pivot instead of the hardcoded $99-inspection
          // fallback for OFF catalogue extras like "Hardwire oven".
          declinedServices,
          // PR-B: per-conversation slot state is the new source of truth.
          // The dialog prompt + deterministic scrub both read from this.
          conversationState,
          // v6 multi-tenant trade scope — tells Sonnet WHICH trades this
          // specific tenant offers so it can't accidentally take a job
          // the tradie doesn't actually do. Pre-v6 / unmapped destinations
          // (tenant=null) get the permissive "both trades" fallback.
          tenantTrades: tenant?.trades,
          // Legacy memory injections — kept for backwards compat. The
          // dialog prefers conversationState when it has slots; these are
          // fallbacks for callers that haven't migrated yet.
          customerContext: formatCustomerContext(customer),
          // Pins which quote a vague reply ("resend the quote") refers to
          // when this inbound is a reply to a manual follow-up.
          followupContext: followupCtxBlock,
          knownFields: customer ? {
            firstName: customer.first_name,
            suburb: customer.suburb,
          } : undefined,
          // In-flight continuation — a quote is already drafting in the
          // background. The dialog stays conversational but must not run
          // a second verification handshake / handoff.
          quoteInProgress: inflightContinuation,
        })
        console.log('[sms/inbound:after] step 6 — decision', {
          action: decision.action,
          job_type_guess: decision.job_type_guess,
          ready_for_intake: decision.ready_for_intake,
          assumptions: decision.assumptions_made.length,
        })
      } catch (err: any) {
        console.error('[sms/inbound:after] dialog agent failed', {
          message: err?.message,
          name: err?.name,
        })
        // Use whatever the slot extractor already merged into state
        // (name from this turn or earlier, job_type if guessed) so the
        // fallback acknowledges the customer's context rather than
        // brushing them off with a generic "we'll get back to you".
        const fallbackFirst =
          (conversationState.slots.first_name as string | undefined) ||
          (customer?.first_name as string | undefined) ||
          null
        const fallbackJob =
          (conversationState.slots.job_type as string | undefined) || null
        decision = {
          action: 'ask',
          job_type_guess: 'unknown',
          reply_to_send: buildDialogFallbackReply({
            firstName: fallbackFirst,
            jobType: fallbackJob,
          }),
          assumptions_made: [],
          ready_for_intake: false,
          request_photo_link: false,
          offer_product_choice: false,
          reason_for_escalation: null,
        }
      }

      // ─── PROGRAMMATIC RULE 5/6 GUARD (belt-and-braces) ────────────────
      // Even with strict EXCEPTION wording in the system prompt, Sonnet
      // will occasionally skip the name / suburb questions for returning
      // customers with empty profiles — the "welcome back" context biases
      // the model toward "we already know them". This deterministic
      // guard catches that and overrides the reply to FORCE the missing
      // universal must-ask question.
      //
      // The downstream intake quality gate already safety-nets this via
      // the recovery flow, but that adds an extra round-trip after
      // 'finish'. Catching it earlier in the dialog turn keeps the
      // conversation tight and means the customer never reaches finish
      // with a degenerate intake in the first place.
      //
      // Trigger conditions (all must hold):
      //   - Sonnet isn't escalating or ending the conversation
      //   - We have a job_type identified (we're past Rule 4)
      //   - The required field isn't already known (transcript slots OR
      //     customer record)
      //   - We haven't asked this question yet (no loop)
      // GPO false-positive guard.
      //
      // Root case from 2026-05-19: "Can I get two Powerpoints" ->
      // "Ensuite" was escalated to "$99 inspection" because the prompt
      // listed "bathroom" as a power_points inspection trigger and Sonnet
      // reasonably mapped ensuite -> bathroom. That happens before DB
      // service toggles or pricing get a say. Keep obvious GPO jobs in
      // the quote dialog unless the customer explicitly says there is no
      // nearby power, a new switchboard circuit/run, outdoor/weatherproof
      // work, old wiring, or a too-close wet-area location.
      // Phase 1b — snapshot the model's own words BEFORE any deterministic
      // override replaces them, so the grounding guard below can tell model
      // text (must be checked) from route-composed text (already trusted).
      const modelReplyBeforeOverrides = decision.reply_to_send

      const gpoOverride = buildGpoInspectionOverride({
        decision,
        turns,
        jobTypeFromState: conversationState.slots.job_type as string | undefined,
      })
      if (gpoOverride) {
        console.warn('[sms/inbound:after] GPO inspection false-positive override', {
          conversationId,
          reason: gpoOverride.reason,
          originalReason: decision.reason_for_escalation,
          originalReplyPreview: decision.reply_to_send.slice(0, 120),
        })
        decision = {
          ...decision,
          action: 'ask',
          job_type_guess: 'power_points',
          reply_to_send: gpoOverride.reply,
          ready_for_intake: false,
          request_photo_link: false,
          offer_product_choice: false,
          reason_for_escalation: null,
        }
      }

      const slotFirstName = (conversationState.slots.first_name as string | undefined) ?? undefined
      const slotSuburb = (conversationState.slots.suburb as string | undefined) ?? undefined
      const slotJobType = (conversationState.slots.job_type as string | undefined) ?? undefined

      const haveNameSignal = !!slotFirstName || !!customer?.first_name
      const haveSuburbSignal = !!slotSuburb || !!customer?.suburb
      const jobTypeIdentified =
        decision.job_type_guess !== 'unknown' || !!slotJobType

      const agentAlreadyAskedName = turns.some(
        (t) => t.direction === 'outbound' &&
          /(first name|what'?s your name|grab your (first )?name|your name\?)/i.test(t.body),
      )
      const agentAlreadyAskedSuburb = turns.some(
        (t) => t.direction === 'outbound' &&
          /(what suburb|suburb is the job|suburb'?s the job|what suburb's)/i.test(t.body),
      )

      // BUG D fix: if Sonnet's CURRENT reply (this turn) is already asking
      // for the name or suburb, the guard should stand down. Without this
      // check, the guard overwrites Sonnet's correct first-time intro
      // ("G'day, thanks for messaging QuoteMax, I'm the AI quoting
      // assistant. What's your first name?") with the bare guard text
      // ("No worries - quick one, what's your first name?"), losing the
      // personalised greeting on turn 1.
      const currentReplyAsksForName =
        /(first name|what'?s your name|grab your (first )?name|your name\?)/i.test(decision.reply_to_send)
      const currentReplyAsksForSuburb =
        /(what suburb|suburb is the job|suburb'?s the job|what suburb's|what'?s the suburb)/i.test(decision.reply_to_send)

      // BUG D fix part 2 (extended 2026-05-14): scan EVERY inbound turn
      // for an inline name / suburb statement that the slot extractor
      // may have missed. Customers introduce themselves on turn 1
      // ("Hi I'm Sam from Bondi") and the agent picks the name up
      // verbatim in its reply, but on later turns the customer's
      // shorter reply has no name in it. If we only scanned the latest
      // inbound, the guard would fire on turn 3 and re-ask "what's
      // your first name?" even though Sam was clearly stated on turn 1.
      // Scanning the full inbound history fixes the regression
      // (electric HWS stress test, 2026-05-14).
      const allInboundText = turns
        .filter((t) => t.direction === 'inbound')
        .map((t) => t.body)
        .join('\n')
      const inlineNameMatch =
        allInboundText.match(/\b(?:i'?m|name'?s|name is|this is)\s+([A-Z][a-z]+)\b/i) ||
        allInboundText.match(/\b([A-Z][a-z]{1,30})\s+(?:in|from|at)\s+[A-Z][a-z]+/) ||
        allInboundText.match(/\b([A-Z][a-z]{1,30})\s+here\b/i)
      const inlineNameInTranscript = !!inlineNameMatch
      const inlineSuburbMatch =
        allInboundText.match(/\b(?:in|from|at)\s+([A-Z][a-z]{2,30})\b/)
      const inlineSuburbInTranscript = !!inlineSuburbMatch

      const isDialogSteering =
        decision.action !== 'escalate_inspection' &&
        decision.action !== 'end_conversation'

      const shouldForceName =
        isDialogSteering &&
        jobTypeIdentified &&
        !haveNameSignal &&
        !inlineNameInTranscript &&         // BUG D fix part 2
        !agentAlreadyAskedName &&
        !currentReplyAsksForName            // BUG D fix part 1

      const shouldForceSuburb =
        isDialogSteering &&
        jobTypeIdentified &&
        haveNameSignal &&        // Rule 5 → Rule 6 ordering
        !haveSuburbSignal &&
        !inlineSuburbInTranscript &&        // BUG D fix part 2
        !agentAlreadyAskedSuburb &&
        !currentReplyAsksForSuburb          // BUG D fix part 1

      if (shouldForceName) {
        console.warn('[sms/inbound:after] RULE 5 GUARD — Sonnet skipped name question; overriding', {
          conversationId,
          originalAction: decision.action,
          originalReplyPreview: decision.reply_to_send.slice(0, 80),
        })
        decision = {
          ...decision,
          action: 'ask',
          ready_for_intake: false,
          request_photo_link: false,
          reply_to_send: "No worries - quick one, what's your first name?",
        }
      } else if (shouldForceSuburb) {
        console.warn('[sms/inbound:after] RULE 6 GUARD — Sonnet skipped suburb question; overriding', {
          conversationId,
          originalAction: decision.action,
          originalReplyPreview: decision.reply_to_send.slice(0, 80),
        })
        const nameForAck = slotFirstName ?? customer?.first_name ?? ''
        decision = {
          ...decision,
          action: 'ask',
          ready_for_intake: false,
          request_photo_link: false,
          reply_to_send: nameForAck
            ? `Cheers ${nameForAck} - and what suburb's the job in?`
            : "Cheers - and what suburb's the job in?",
        }
      }

      // ─── Phase 1b — nothing ungrounded leaves this branch ────────────────
      // Roofing has discarded ungrounded model turns since llm-receptionist
      // shipped; the electrical/generic branch never did, and the prompt
      // actively taught the model to write dollar amounts. Two steps:
      //   1. If the model chose to escalate, the ROUTE composes the fee line.
      //      The offer could never satisfy the guard (money is refused before
      //      any grounding lookup), so guarding it would bail every escalation.
      //   2. Otherwise, check whatever text the model still owns.
      // A deterministic override upstream (GPO / Rule 5 / Rule 6) is trusted
      // and skips both.
      {
        const replyIsModelAuthored = decision.reply_to_send === modelReplyBeforeOverrides
        const slotFirst =
          (conversationState.slots.first_name as string | undefined) ??
          customer?.first_name ??
          null
        const slotJob =
          (decision.job_type_guess !== 'unknown' ? decision.job_type_guess : null) ??
          (conversationState.slots.job_type as string | undefined) ??
          null

        if (replyIsModelAuthored && decision.action === 'escalate_inspection') {
          decision = {
            ...decision,
            reply_to_send: composeInspectionOffer(slotJob, slotFirst, tenant?.trades ?? undefined),
          }
        } else if (replyIsModelAuthored) {
          // Tool-produced context ONLY. Prior outbound bodies are deliberately
          // excluded: on this branch they are unguarded model text, so seeding
          // them would launder one hallucinated figure into permanent authority.
          // The MUST-ASK rules text carries the legitimate spec numbers (the
          // 600 mm wet-area clearance) so a real question is not mistaken for
          // an invented figure.
          const authoritative = [
            JSON.stringify(conversationState.slots ?? {}),
            JSON.stringify(buildTenantFacts(tenant ?? null)),
            ...(slotJob ? [safeRulesAsText(slotJob)] : []),
            ...(customAssemblies ?? []).map((s) => s.name ?? ''),
            // Spec ev-charger-location-photo R11 — the MUST-ASK question TEXT,
            // not just the service name. These questions are tool-produced (a
            // DB row, or the code-side EV floor), and one of them offers
            // distances. Without them here, a model rephrasing "how far is the
            // charger spot from the switchboard" with "5-10 m" trips
            // assertGroundedReply's >=10 figure rule and the customer gets the
            // snag fallback instead of a question.
            ...(customAssemblies ?? []).flatMap((s) => s.clarifying_questions ?? []),
            // The follow-up block is tool-produced (formatActiveFollowupContext
            // reads quote_followup_events) and carries the REAL quote link the
            // prompt tells the model to resend. Without it, a correct
            // "here's your quote" reply is rejected as an ungrounded link and
            // the customer gets the snag fallback instead of their quote.
            followupCtxBlock,
          ].filter((s) => s.length > 0)

          const grounding = enforceDialogGrounding({
            decision,
            authoritative,
            conversational: turns
              .filter((t) => t.direction === 'inbound')
              .map((t) => t.body),
            fallbackReply: buildDialogFallbackReply({
              firstName: slotFirst,
              jobType: slotJob,
            }),
            modelAuthored: true,
          })
          if (!grounding.grounded) {
            console.warn('[sms/inbound:after] Phase 1b — ungrounded reply discarded', {
              conversationId,
              reason: grounding.reason,
              discardedPreview: decision.reply_to_send.slice(0, 140),
            })
            decision = { ...decision, reply_to_send: grounding.decision.reply_to_send }
          }
        }
      }

      // Quote-already-drafted guard (moved up before step 7 so we can decide
      // message ordering before dispatching anything).
      //
      // When a customer texts back after their quote has been sent
      // ("Thanks!", "Sounds good", "Can I add a fan?"), the
      // sms_conversation is reused under the 5-min done-grace window and
      // Sonnet runs fresh. Without this check, Sonnet — having no memory
      // that intake/quote already ran — frequently reasons action='finish'
      // again on the courtesy reply, which triggers a DUPLICATE intake
      // and a DUPLICATE quote draft (with slightly different tier picks
      // since the estimator is non-deterministic). The customer ends up
      // with two photo links and two different quotes in the same SMS
      // thread. Same root cause makes photo_request_sent_at-cleared
      // conversations re-fire the photo link.
      //
      // Guard: if the conversation already has intake_id linked, suppress
      // BOTH the photo-request dispatch AND the intake-handoff fire,
      // regardless of what Sonnet decided. Sonnet's reply text still goes
      // out (dispatched at step 7 below) so the customer gets a
      // courtesy response, but the side effects don't fire twice.
      // Multi-quote-per-conversation (genuine add-ons) is a future feature
      // — for v1 the SOP is the tradie handles add-ons manually.
      // Two-signal duplicate guard:
      //   1. Fresh DB read of conversation.intake_id (catches the common case)
      //   2. Pre-reuse status snapshot captured at request entry, BEFORE
      //      the reuse-done-grace path flipped status back to 'open'. If
      //      prior.status was 'done' or 'structuring' when we picked up
      //      this inbound, a quote pipeline had already been triggered
      //      and we should never re-fire — even in a race where the
      //      DB read returns a stale null.
      // Either signal is sufficient. Both must be true for normal flow.
      const { data: convoState } = await supabase
        .from('sms_conversations')
        .select('intake_id, roofing_state, painting_state')
        .eq('id', conversationId)
        .maybeSingle()
      const freshIntakeId = (convoState?.intake_id as string | null) ?? null
      const hasExistingIntake = !!freshIntakeId || quoteAlreadyDrafted
      // Spec ev-charger-location-photo R9 — set by the readiness block below,
      // read by the photo-request trigger in step 8b. Declared here so the two
      // are in the same scope; false for every non-EV job.
      let evPhotoRequirementSatisfied = false
      // Third duplicate/misroute signal: is this thread owned by another trade?
      // Read off the SAME fresh row rather than a second round trip.
      //
      // Use the EXISTING tested predicates, not a hand-rolled `last_step != null`.
      // `'closed'` is a VALUE of last_step, not its absence, and it is written on
      // the sanctioned trade-switch path — roofing persists `last_step:'closed'`
      // then returns false to hand the turn to the general dialog (route.ts:632).
      // Step 10 is therefore reached almost exclusively AFTER roofing declined,
      // so treating 'closed' as active would suppress the very handoffs this
      // block exists to make: a customer switching from re-roof to downlights
      // mid-thread would get the dialog's "I'll get that quote over" and then no
      // quote, permanently, for the life of the conversation row.
      const otherTradeActive =
        isActiveRoofingFlow(convoState?.roofing_state as RoofingConversationState | null) ||
        isActivePaintingFlow(convoState?.painting_state as PaintingConversationState | null)
      if (hasExistingIntake) {
        console.log(
          '[sms/inbound:after] quote already drafted on this conversation — suppressing photo + handoff',
          {
            conversationId,
            freshIntakeId,
            priorIntakeId,
            priorStatusBeforeReopen: prior?.status,
            quoteAlreadyDrafted,
          },
        )
      }
      // Log the trade suppression too. Without this the handoff can be skipped
      // with no trace at all, which is indistinguishable from a crash when you
      // are staring at a customer who never got their quote.
      if (otherTradeActive) {
        console.log(
          '[sms/inbound:after] another trade owns this thread — suppressing electrical/plumbing handoff',
          {
            conversationId,
            roofingStep: (convoState?.roofing_state as RoofingConversationState | null)?.last_step ?? null,
            paintingStep: (convoState?.painting_state as PaintingConversationState | null)?.last_step ?? null,
          },
        )
      }

      // Deterministic quote-readiness gate. Sonnet can decide action='finish',
      // but money-path handoff only proceeds when the slot state carries the
      // price-critical facts for this job. If a required fact is missing, turn
      // the finish into one more SMS question before any photo, product-choice,
      // or intake/estimate side effect can fire.
      if (!hasExistingIntake && decision.action === 'finish') {
        // Spec ev-charger-location-photo R6 — does this conversation already
        // hold a customer photo? Either channel counts: an inbound MMS
        // (sms_messages.photo_paths) or the upload link
        // (sms_conversations.photo_paths). Best-effort: losing this read must
        // downgrade to "ask for a photo", never fail the turn.
        //
        // The job-type test MUST match the one evaluateQuoteReadiness uses
        // (lib/sms/quote-readiness.ts jobType()): the persisted slot WINS over
        // this turn's guess. Keying only on decision.job_type_guess meant any
        // turn where the sticky slot said ev_charger but the model guessed
        // something else evaluated the EV gate with hasPhoto=false, re-asking a
        // customer who had already sent their photo.
        const evJobType =
          String(conversationState.slots?.job_type ?? decision.job_type_guess ?? '') ===
          'ev_charger'
        let hasPhoto = false
        if (evJobType) {
          // Scoped to THIS job, not the whole thread. One sms_conversations row
          // is reused across jobs, so an unscoped read let a photo sent for a
          // previous downlights job silently satisfy the EV requirement for a
          // returning customer — exactly what the photo reset at the top of this
          // route exists to prevent. photo_request_sent_at is that reset's own
          // boundary marker, so reuse it as the session floor.
          const sessionFloor = (conversation.photo_request_sent_at as string | null) ?? null
          try {
            const convoQ = supabase
              .from('sms_conversations')
              .select('photo_paths')
              .eq('id', conversationId)
              .maybeSingle<{ photo_paths: string[] | null }>()
            let msgQ = supabase
              .from('sms_messages')
              .select('photo_paths')
              .eq('conversation_id', conversationId)
            if (sessionFloor) msgQ = msgQ.gte('created_at', sessionFloor)
            const [convo, msgs] = await Promise.all([convoQ, msgQ])
            // supabase-js RESOLVES {data,error}; it does not throw, so the
            // try/catch alone would let a failed read look like "no photo".
            if (convo.error || msgs.error) {
              console.error('[sms/inbound:after] EV photo lookup errored (non-fatal)', {
                conversationId,
                convoError: convo.error?.message ?? null,
                msgsError: msgs.error?.message ?? null,
              })
            }
            hasPhoto =
              (convo.data?.photo_paths?.length ?? 0) > 0 ||
              (msgs.data ?? []).some(
                (m) => ((m as { photo_paths?: string[] | null }).photo_paths?.length ?? 0) > 0,
              )
          } catch (e) {
            console.error('[sms/inbound:after] EV photo lookup failed (non-fatal)', {
              conversationId,
              error: e instanceof Error ? e.message : String(e),
            })
          }
        }
        // Hoisted for step 8b: once the requirement is met (a photo, or a
        // decline) the photo-request SMS must be suppressed, or the
        // finish-fallback texts an upload link to someone who just satisfied it.
        evPhotoRequirementSatisfied = evJobType && (hasPhoto || photoDeclined(turns))
        const readiness = evaluateQuoteReadiness({
          action: decision.action,
          jobTypeGuess: decision.job_type_guess,
          conversationState,
          knownFirstName: customer?.first_name ?? null,
          knownSuburb: customer?.suburb ?? null,
          history: turns,
          services: customAssemblies,
          hasPhoto,
        })
        const priorClarifyCount = Number(
          (conversationState as Record<string, unknown>).clarify_gate_count ?? 0,
        )
        // R19 — only consecutive NO-PROGRESS turns count toward the cap. Compare
        // this turn's missing required facts against the prior turn's snapshot;
        // if the set shrank, the customer answered something → progress → reset.
        const priorMissing = Array.isArray(
          (conversationState as Record<string, unknown>).clarify_missing,
        )
          ? ((conversationState as Record<string, unknown>).clarify_missing as string[])
          : []
        const currentMissing = readiness.missing.map((m) => m.code)
        // Progress = the outstanding set CHANGED, not merely shrank (spec
        // ev-charger-location-photo R4). Service questions are asked one at a
        // time, so answering one swaps 'service_question:0' for
        // 'service_question:1' — same length, real progress. Comparing lengths
        // alone counted that as a stalled turn and marched a cooperative
        // customer to the cap.
        const sameSet =
          currentMissing.length === priorMissing.length &&
          currentMissing.every((c) => priorMissing.includes(c))
        const madeProgress = priorMissing.length > 0 && !sameSet
        if (!readiness.ready) {
          // R24 safety valve — gate the deterministic override behind the
          // kill-switch flag and a clarifying-turn cap so it can be disabled
          // instantly and can never loop a customer forever.
          const gate = decideClarifyGate({
            priorCount: priorClarifyCount,
            enforcementEnabled: clarifyingEnforcementEnabled(),
            cap: clarifyingTurnCap(),
            madeProgress,
          })
          console.warn('[sms/inbound:after] quote-readiness gate blocked finish', {
            conversationId,
            missing: currentMissing,
            firstReason: readiness.missing[0]?.reason ?? null,
            gateMode: gate.mode,
            clarifyCount: gate.count,
            madeProgress,
            cap: clarifyingTurnCap(),
          })
          if (gate.mode === 'allow') {
            // Kill switch ON (SMS_ENFORCE_CLARIFYING_QUESTIONS disabled):
            // leave the model's finish untouched.
          } else if (gate.mode === 'escalate') {
            // Cap reached — stop re-asking; route to the $99 inspection
            // rather than trap the customer in a MUST-ASK loop.
            decision = {
              ...decision,
              action: 'escalate_inspection',
              ready_for_intake: false,
              request_photo_link: false,
              offer_product_choice: false,
              reply_to_send:
                "No worries - to quote this one accurately we'll need a quick on-site look. Want me to book a $99 inspection? It's credited toward the job if you go ahead.",
            }
          } else {
            // gate.mode === 'ask' — block finish, ask one more question.
            //
            // Spec ev-charger-location-photo R6/R7 — when the thing we are
            // blocked on IS the photo, the upload link has to travel with the
            // ask. Blanket-clearing request_photo_link here falsified all three
            // photo triggers (photo-request-trigger.ts fires on
            // sonnetRequestedPhoto / finish / offerProductChoice), so on the one
            // turn the customer is told a photo is required they were given no
            // way to send one, and MMS was the only channel left.
            const blockedOnEvPhoto = readiness.missing.some((m) => m.code === 'ev_photo')
            decision = {
              ...decision,
              action: 'ask',
              ready_for_intake: false,
              request_photo_link: blockedOnEvPhoto,
              offer_product_choice: false,
              reply_to_send: readiness.reply ?? 'Quick one before I quote it - can you confirm the missing detail?',
            }
          }
          // Persist the consecutive-blocked counter + the missing-fact snapshot
          // on conversation_state so the cap + R19 progress check survive across
          // turns (conversationUpdate below does not write conversation_state).
          if (gate.mode !== 'allow') {
            const nextState = {
              ...conversationState,
              clarify_gate_count: gate.count,
              clarify_missing: currentMissing,
            }
            conversationState = nextState
            await supabase
              .from('sms_conversations')
              .update({ conversation_state: nextState, updated_at: new Date().toISOString() })
              .eq('id', conversationId)
          }
        } else if (priorClarifyCount !== 0 || priorMissing.length > 0) {
          // Readiness satisfied — reset the cap counter + missing snapshot so a
          // later, unrelated missing-fact run starts fresh.
          const nextState = { ...conversationState, clarify_gate_count: 0, clarify_missing: [] }
          conversationState = nextState
          await supabase
            .from('sms_conversations')
            .update({ conversation_state: nextState, updated_at: new Date().toISOString() })
            .eq('id', conversationId)
        }
      }

      // 8b. Photo-request SMS gate — computed early so we can send the photo
      // link BEFORE the quote confirmation (correct UX order).
      //
      // Decision pulled out to lib/sms/photo-request-trigger.ts so the
      // three-trigger composition (Sonnet flag / finish-fallback / WP9
      // picker) and its seven negative gates are unit-tested and can't
      // silently regress. See that module's docstring for incident
      // history including the 2026-05-28 Bug B fix (Sparky convo
      // 27f22f65 — "all info in turn 1" picker turns).
      // The customer explicitly asking for the link is the one thing allowed
      // past the two LIFETIME latches (already_sent / fresh_intake_this_turn).
      // Without this, "can you send the link again" is structurally
      // unanswerable: the sender is latched shut for the rest of the
      // conversation while the prompt keeps telling the model the link has not
      // gone out, so it promises one every turn and none is ever dispatched.
      const askedForLink = customerAskedForPhotoLink(
        turns.filter((t) => t.direction === 'inbound').at(-1)?.body ?? '',
      )
      const photoTrigger = computeShouldSendPhotoRequest({
        photoRequestToken,
        photoRequestAlreadySent,
        freshIntakeId,
        inflightContinuation,
        decisionAction: decision.action,
        sonnetRequestedPhoto: decision.request_photo_link === true || askedForLink,
        offerProductChoice: decision.offer_product_choice === true,
        customerAskedForLink: askedForLink,
        // "is this job type allowed a photo request" — the easy-5 plus EV (R7).
        // Prefer the STICKY slot over this turn's guess: on a bare "can you
        // send the link" the model has no job to guess from and returns
        // 'unknown', which would fail this gate and suppress the re-send. Same
        // fallback the EV readiness gate already uses ~180 lines above.
        jobTypeIsEasy5: PHOTO_ELIGIBLE_JOB_TYPES.has(
          String(conversationState.slots?.job_type ?? decision.job_type_guess ?? ''),
        ),
        // R9 — never re-ask once the customer has sent one or told us they
        // cannot. Only EV sets this; every other job keeps the old behaviour.
        photoRequirementSatisfied: evPhotoRequirementSatisfied,
      })
      const shouldSendPhotoRequest = photoTrigger.fire
      // Never ship a reply that promises a link when no link is going out.
      // This is the only point where both facts are in scope: the drafted
      // reply text, and the gate's decision. The reply and the photo SMS are
      // dispatched separately and neither has ever checked the other, which is
      // how 204 of 245 "link" messages went out carrying no URL.
      //
      // Strips the promise; deliberately does NOT append the URL — that would
      // bypass every negative gate above, each with its own incident history.
      if (!shouldSendPhotoRequest && decision.reply_to_send) {
        const cleaned = stripLinkPromise(decision.reply_to_send)
        if (cleaned !== decision.reply_to_send) {
          console.warn('[sms/inbound:after] stripped an unbacked link promise from the reply', {
            conversationId,
            gateReason: photoTrigger.reason,
          })
          decision = { ...decision, reply_to_send: cleaned }
        }
      }
      if (!shouldSendPhotoRequest) {
        console.log('[sms/inbound:after] step 8b — photo-request SMS skipped', {
          conversationId,
          reason: photoTrigger.reason,
        })
      } else {
        console.log('[sms/inbound:after] step 8b — photo-request SMS will fire', {
          conversationId,
          trigger: photoTrigger.reason,
        })
      }

      // Ordering rules — two cases, both keep a 2s carrier gap on AU
      // long codes so the pair never visibly reorders on the customer's
      // phone:
      //   • action === 'finish'    →  photo link FIRST, then the short
      //     "quote on its way" reply. Sending the finish line first
      //     would have the customer reading "your quote is coming" and
      //     then getting asked for photos out of nowhere.
      //   • action !== 'finish' (verification handshake, Sonnet set
      //     request_photo_link=true) →  reply FIRST, then photo link.
      //     Sonnet's reply on this turn says "I'll flick you a photo
      //     link in a sec for ..." — the link MUST arrive after that
      //     reply for the wording to match. Photo-first here produced
      //     the visible bug surfaced 2026-05-28 (link arrived before
      //     the message that promised it).
      //
      // The actual dispatch is shared between both placements via the
      // local helper below.
      const photoBeforeReply = decision.action === 'finish'

      const dispatchPhotoRequestSms = async () => {
        try {
          const appUrl = process.env.APP_URL ?? 'https://www.quotemax.com.au'
          const uploadUrl = `${appUrl}/upload/${photoRequestToken}`
          // Priority order (authoritative → best-effort):
          //   1. conversation_state.slots.first_name (this turn's extracted + merged name)
          //   2. customer.first_name (stable DB record)
          //   3. guessFirstName(turns) — heuristic; only trusted when 1 & 2 are empty
          const firstName =
            (conversationState.slots.first_name as string | undefined) ||
            (customer?.first_name as string | undefined) ||
            guessFirstName(turns) ||
            undefined
          const photoBody = buildPhotoRequestSms({ firstName, uploadUrl, source: 'sms', jobType: decision.job_type_guess })
          const photoDispatch = await dispatchQuoteMessage({
            to: fromNumber,
            from: toNumber,
            text: photoBody,
          })
          if (photoDispatch.ok) {
            console.log('[sms/inbound:after] step 8b — photo-request SMS sent', {
              channel: photoDispatch.channel,
              sid: photoDispatch.sid,
            })
            await supabase.from('sms_messages').insert({
              conversation_id: conversationId,
              direction: 'outbound',
              body: photoDispatch.channel === 'whatsapp'
                ? `[WhatsApp fallback] ${photoBody}`
                : photoBody,
              twilio_message_sid: photoDispatch.sid,
            })
            await supabase
              .from('sms_conversations')
              .update({ photo_request_sent_at: new Date().toISOString() })
              .eq('id', conversationId)
          } else {
            console.error('[sms/inbound:after] step 8b — photo-request SMS failed', {
              smsAttempt: photoDispatch.smsAttempt,
              waAttempt: photoDispatch.waAttempt,
            })
          }
        } catch (e: any) {
          console.error('[sms/inbound:after] step 8b — photo-request SMS threw', {
            message: e?.message,
            name: e?.name,
          })
        }
      }

      if (shouldSendPhotoRequest && photoBeforeReply) {
        console.log('[sms/inbound:after] step 8b — dispatching photo-request SMS BEFORE finish reply', {
          conversationId,
          jobType: decision.job_type_guess,
        })
        await dispatchPhotoRequestSms()
        // 2s gap before the finish reply so AU long-code carrier
        // doesn't reorder the two messages.
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      // ─────── WP9 OFFER + INTERLOCK — 2 real product options mid-chat ──
      // The model offers via decision.offer_product_choice, OR — the
      // interlock — we force the offer at the LAST safe moment (the turn
      // it would finish) so the pick always happens BEFORE the quote is
      // built. While a choice is pending, wp9HoldingForChoice suppresses
      // the finish handoff + keeps the conversation open so the reply
      // ("1"/"2") is captured and actually drives the quote + preview.
      // One-shot (skips if a choice already exists). Fully flag-gated +
      // best-effort: OFF ⇒ skipped entirely; no catalogue/<2 options ⇒
      // no pending choice ⇒ no hold ⇒ normal finish (zero regression).
      let wp9HoldingForChoice = false
      // How many options were offered (1 or 2). Threads through to the
      // hold-SMS phrasing so single-product flows don't say "reply 1 or 2".
      let wp9HoldingOptionCount = 0
      if (
        WP9_ENABLED &&
        (decision.offer_product_choice === true || decision.action === 'finish') &&
        !hasExistingIntake &&
        // In-flight continuation — never open a product-choice interlock
        // against a quote that's already drafting.
        !inflightContinuation &&
        decision.action !== 'escalate_inspection' &&
        decision.action !== 'end_conversation' &&
        tenant?.id
      ) {
        try {
          const { data: existing } = await supabase
            .from('sms_conversations')
            .select('product_choice')
            .eq('id', conversationId)
            .maybeSingle()
          const already = (existing?.product_choice ?? null) as ProductChoiceState | null
          const productJobType =
            (conversationState.slots.job_type as string | undefined) ?? decision.job_type_guess
          const choiceAllowed = productChoiceAllowedForSupply(
            productJobType,
            conversationState.slots.supplied_by as string | undefined,
          )
          const category = categoryForJobType(productJobType)
          if (!choiceAllowed) {
            if (already) {
              const { error: clearChoiceError } = await supabase
                .from('sms_conversations')
                .update({ product_choice: null, updated_at: new Date().toISOString() })
                .eq('id', conversationId)
              if (clearChoiceError) throw clearChoiceError
            }
            console.log('[sms/inbound:after] WP9 OFFER — skipped EV unit for customer-supplied charger', {
              conversationId,
            })
          } else if (already) {
            // Pending = customer hasn't picked yet → keep holding the
            // quote. Chosen = let the normal finish flow proceed.
            if (already.status === 'pending') {
              wp9HoldingForChoice = true
              wp9HoldingOptionCount = Array.isArray(already.options) ? already.options.length : 0
            }
            console.log('[sms/inbound:after] WP9 OFFER — choice already exists, skipping', {
              conversationId,
              status: already.status,
            })
          } else if (!category) {
            console.log('[sms/inbound:after] WP9 OFFER — no catalogue category for job type, skipping', {
              jobType: productJobType,
            })
          } else {
            const { data: catRows } = await supabase
              .from('tenant_material_catalogue')
              .select(
                'id, category, name, brand, range_series, unit_price_ex_gst, image_path, description, tier_hint, is_preferred, active, properties, trade',
              )
              .eq('tenant_id', tenant.id)
              .eq('active', true)
            const options = selectProductOptions(
              (catRows ?? []) as TenantMaterial[],
              category,
              {
                requestedSpecs:
                  (conversationState.slots.requested_specs as
                    | Record<string, string>
                    | undefined) ?? null,
                trade: deriveTradeFromJobType(decision.job_type_guess),
              },
            )
            if (!options) {
              console.log('[sms/inbound:after] WP9 OFFER — no catalogue products for this category, skipping', {
                conversationId,
                category,
              })
            } else {
              const token = randomBytes(16).toString('hex')
              const choiceState: ProductChoiceState = {
                category,
                trade: deriveTradeFromJobType(decision.job_type_guess),
                token,
                status: 'pending',
                options,
                offered_at: new Date().toISOString(),
              }
              await supabase
                .from('sms_conversations')
                .update({ product_choice: choiceState, updated_at: new Date().toISOString() })
                .eq('id', conversationId)
              // Just offered → hold the quote until the customer picks.
              wp9HoldingForChoice = true
              wp9HoldingOptionCount = options.length
              const appUrl = process.env.APP_URL ?? 'https://www.quotemax.com.au'
              const chooseUrl = `${appUrl}/q/choose/${token}`
              let optionsBody = buildProductOptionsSms(options, chooseUrl, category)
              // External / weather-exposed install with no weatherproof
              // product in the catalogue → flag it so the sparky confirms
              // the right (IP-rated) unit rather than fitting an indoor one.
              const wpAdvisory = weatherproofAdvisory(
                (catRows ?? []) as TenantMaterial[],
                category,
                (conversationState.slots.requested_specs as Record<string, string> | undefined) ?? null,
                deriveTradeFromJobType(decision.job_type_guess),
              )
              if (wpAdvisory.required && !wpAdvisory.available) {
                optionsBody +=
                  "\nNote: this looks like an outdoor spot, so it needs a weatherproof unit. The sparky will confirm the right one before booking."
                console.log('[sms/inbound:after] WP9 OFFER — weatherproof flagged (no IP-rated product in catalogue)', {
                  conversationId,
                  category,
                })
              }
              const offerDispatch = await dispatchQuoteMessage({
                to: fromNumber,
                from: toNumber,
                text: optionsBody,
              })
              if (offerDispatch.ok) {
                await supabase.from('sms_messages').insert({
                  conversation_id: conversationId,
                  direction: 'outbound',
                  body:
                    offerDispatch.channel === 'whatsapp'
                      ? `[WhatsApp fallback] ${optionsBody}`
                      : optionsBody,
                  twilio_message_sid: offerDispatch.sid,
                })
                console.log('[sms/inbound:after] WP9 OFFER — options SMS sent', {
                  conversationId,
                  category,
                  channel: offerDispatch.channel,
                })
                // 2s gap so the options message lands before the dialog
                // reply (same carrier-ordering fix as the photo link).
                await new Promise((resolve) => setTimeout(resolve, 2000))
              } else {
                console.error('[sms/inbound:after] WP9 OFFER — options SMS failed', {
                  conversationId,
                })
              }
            }
          }
        } catch (e: any) {
          console.warn('[sms/inbound:after] WP9 OFFER skipped (non-fatal)', {
            conversationId,
            error: e?.message ?? String(e),
          })
        }
      }

      // WP9 INTERLOCK — while a product choice is pending, the customer
      // must NOT be told "quote on its way" (it isn't — it's held). Swap
      // the dialog reply for a short pick-prompt. The options SMS (with
      // the photo link) already went out just above.
      if (wp9HoldingForChoice) {
        decision = {
          ...decision,
          reply_to_send: buildChoiceHoldSms(wp9HoldingOptionCount),
        }
        console.log('[sms/inbound:after] WP9 — holding quote for pending product choice', {
          conversationId,
          optionCount: wp9HoldingOptionCount,
        })
      }

      // Step 7: quote confirmation (or any dialog reply). Fires after the
      // photo link when shouldSendPhotoRequest is true, immediately otherwise.
      console.log('[sms/inbound:after] step 7 — dispatching reply (SMS-first, WhatsApp fallback)')
      // R46-inbound — the AI-reply send is the customer-facing payload of the
      // whole turn, yet it had NO outer retry: it relied solely on dispatch.ts's
      // code-based retry, which does NOT treat a thrown/aborted fetch
      // (AbortError / TimeoutError on Vercel terminating an in-flight request,
      // undici headersTimeout) as a first-class retryable class. Unlike the
      // intake handoff below — where an aborted fetch is INTENTIONALLY
      // non-retried because the server may still complete the pipeline and a
      // retry would duplicate the quote — re-sending an SMS reply is idempotent
      // at the dialog layer (a duplicate reply is benign vs. customer silence),
      // so here we DO retry transient aborts/timeouts/network/429/5xx via the
      // shared retryWithBackoff. throwIfDispatchFailed converts dispatch's
      // returned {ok:false, smsAttempt} into a classifiable throw; terminal
      // carrier codes (21610 STOP, etc.) are not retried. Every outcome is
      // logged via logSendOutcome in an alertable shape.
      const replySendStartedAt = Date.now()
      const replyOutcome = await retryWithBackoff(
        async () => {
          const r = await dispatchQuoteMessage({
            to: fromNumber,
            from: toNumber,
            text: decision.reply_to_send,
          })
          // Throw on a failed result so retryWithBackoff classifies + retries
          // transient failures (abort/timeout/network/429/5xx); a successful
          // result passes through unchanged.
          return throwIfDispatchFailed(r)
        },
        {
          retries: DELIVERY_KNOBS.sendRetries,
          baseDelayMs: DELIVERY_KNOBS.sendBaseDelayMs,
          maxDelayMs: DELIVERY_KNOBS.sendMaxDelayMs,
          onRetry: (err, nextAttempt, delayMs) =>
            console.warn('[sms/inbound:after] step 7 — reply send retrying', {
              conversationId,
              nextAttempt,
              delayMs,
              error: err instanceof Error ? err.message : String(err),
            }),
        },
      )
      // Recover the dispatch-shaped result for the unchanged downstream code.
      // On success retryWithBackoff returns the original DispatchOk; on terminal
      // failure we synthesise a DispatchFail from the thrown DispatchFailedError
      // so the existing `dispatch.ok === false` branch (recordTrace err) runs.
      const replySendError: unknown = replyOutcome.ok ? undefined : replyOutcome.error
      const dispatch = replyOutcome.ok
        ? replyOutcome.value
        : ({
            ok: false as const,
            smsAttempt: {
              code: (replySendError as { code?: string })?.code ?? 'UNKNOWN',
              reason: (replySendError as Error)?.message ?? 'reply dispatch failed',
            },
            smsAttempts: replyOutcome.attempts,
            waAttempt: (replySendError as { waCode?: string | null })?.waCode != null
              ? { code: String((replySendError as { waCode?: string | null }).waCode), reason: 'whatsapp fallback failed' }
              : undefined,
          })
      logSendOutcome(sendLogger, {
        sendType: 'customer_reply',
        status: dispatch.ok ? (dispatch.channel === 'whatsapp' ? 'fallback' : 'ok') : 'failed',
        attempts: replyOutcome.attempts,
        latencyMs: Date.now() - replySendStartedAt,
        channel: dispatch.ok ? dispatch.channel : null,
        error: replySendError,
      })

      let outboundSid: string | null = null
      let outboundChannel: 'sms' | 'whatsapp' | null = null

      if (dispatch.ok) {
        outboundSid = dispatch.sid
        outboundChannel = dispatch.channel
        console.log('[sms/inbound:after] step 7 — dispatch OK', {
          channel: outboundChannel,
          sid: outboundSid,
          smsFallbackReason: dispatch.smsAttempt?.reason,
        })
        void recordTrace(supabase, {
          step: 'dispatch',
          status: 'ok',
          message: `outbound ${outboundChannel} sent (sid=${outboundSid})`,
          outputs: {
            channel: outboundChannel,
            sid: outboundSid,
            reply_length: (decision.reply_to_send ?? '').length,
            sms_fallback_reason: dispatch.smsAttempt?.reason ?? null,
          },
          decisions: {
            decision_action: decision.action,
            decision_job_type: decision.job_type_guess ?? null,
            ready_for_intake: decision.ready_for_intake ?? null,
          },
          tenant_id: tenant?.id ?? null,
          sms_conversation_id: conversationId,
        })
      } else {
        console.error('[sms/inbound:after] step 7 — dispatch failed (both channels)', {
          smsAttempt: dispatch.smsAttempt,
          waAttempt: dispatch.waAttempt,
        })
        void recordTrace(supabase, {
          step: 'dispatch',
          status: 'err',
          message: 'outbound dispatch FAILED on both SMS and WhatsApp channels',
          outputs: {
            sms_attempt: dispatch.smsAttempt,
            wa_attempt: dispatch.waAttempt,
          },
          decisions: { route: 'failed' },
          tenant_id: tenant?.id ?? null,
          sms_conversation_id: conversationId,
        })
      }

      console.log('[sms/inbound:after] step 8 — persisting outbound', { channel: outboundChannel })
      await supabase.from('sms_messages').insert({
        conversation_id: conversationId,
        direction: 'outbound',
        body: outboundChannel === 'whatsapp'
          ? `[WhatsApp fallback] ${decision.reply_to_send}`
          : decision.reply_to_send,
        twilio_message_sid: outboundSid,
      })

      // 8c. Photo-link AFTER the verification-handshake reply (the
      // counterpart to 8b). Sonnet's reply on this turn says "I'll
      // flick you a photo link in a sec for..."; firing the link 2s
      // after the reply makes that wording read correctly on the
      // customer's phone. See the photoBeforeReply comment above for
      // why this is gated on action !== 'finish'.
      if (shouldSendPhotoRequest && !photoBeforeReply) {
        // 2s gap so the reply lands first on AU long-code carriers.
        await new Promise(resolve => setTimeout(resolve, 2000))
        console.log('[sms/inbound:after] step 8c — dispatching photo-request SMS AFTER verification reply', {
          conversationId,
          jobType: decision.job_type_guess,
        })
        await dispatchPhotoRequestSms()
      }

      // 9. Update conversation: bump turn_count, merge assumptions, set status
      //    based on the dialog agent's decision.
      //    end_conversation: customer wrapped up gracefully without booking.
      //    Status='done', NO intake handoff, NO recovery SMS, NO photo SMS.
      //    Flowing through to step 10 below intake fires only on action='finish'.
      //
      // hasExistingIntake override: when a quote was already drafted on
      // this conversation, the customer's follow-up is a courtesy /
      // thank-you (or an add-on we'll handle manually in v1). Never flip
      // back to 'structuring' — that's what would re-fire intake/quote.
      const newStatus =
        // WP9 INTERLOCK: a pending choice must keep the conversation
        // OPEN so the customer's "1"/"2" reply is processed next turn
        // (not swallowed by the done / in-flight guards) and the quote
        // is NOT marked structuring before they've picked.
        wp9HoldingForChoice ? 'open'
      : hasExistingIntake ? 'done'
      : decision.action === 'finish' ? 'structuring'
      : decision.action === 'escalate_inspection' ? 'done'
      : decision.action === 'end_conversation' ? 'done'
      : 'open'

      const mergedAssumptions = [
        ...initialAssumptions,
        ...decision.assumptions_made,
      ]

      // In-flight continuation: a quote is already drafting on this row,
      // and the draft pipeline (intake/structure) owns `status` +
      // `intake_id`. This turn must NOT write `status` — doing so could
      // clobber the draft's structuring->done transition mid-flight.
      // Everything else (turn_count, assumptions, timestamps) updates
      // normally.
      const conversationUpdate: Record<string, unknown> = {
        turn_count: initialTurnCount + 1,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        assumptions_made: mergedAssumptions,
      }
      if (!inflightContinuation) conversationUpdate.status = newStatus

      console.log('[sms/inbound:after] step 9 — updating conversation', {
        newStatus: inflightContinuation
          ? '(unchanged — in-flight continuation)'
          : newStatus,
        mergedAssumptionsCount: mergedAssumptions.length,
      })
      await supabase
        .from('sms_conversations')
        .update(conversationUpdate)
        .eq('id', conversationId)

      // 10. If the dialog finished, hand off to the existing intake pipeline.
      // Wrapped in withRetry — the customer already got their dialog reply,
      // but the quote depends entirely on this POST landing successfully.
      // Silent failure here = no quote ever drafted = lost customer.
      // 3 attempts, 2s/4s backoff. Runs inside after() so customer doesn't wait.
      //
      // hasExistingIntake guard: a quote was already drafted on this
      // conversation — Sonnet occasionally re-reasons 'finish' on courtesy
      // replies ("Thanks!") which would otherwise produce duplicate
      // quotes. Skip the handoff entirely in that case.
      // inflightContinuation guard: a quote is already drafting on this
      // conversation. Even if the dialog (mis)reasons 'finish' on a
      // continuation turn, NEVER fire a second handoff — that is the
      // exact duplicate-quote collision the in-flight window prevents.
      // R47 — the four-signal "is the money path allowed to fire this turn?"
      // rule is extracted to sideEffectsAllowed (tested) so the intake handoff
      // and any future irreversible side effect share one definition and a
      // duplicate-fired after() can't double-run the handoff.
      if (
        sideEffectsAllowed({
          decisionIsFinish: decision.action === 'finish',
          hasExistingIntake,
          wp9HoldingForChoice,
          inflightContinuation,
          otherTradeActive,
        })
      ) {
        console.log('[sms/inbound:after] step 10 — firing intake/structure handoff', { conversationId })
        try {
          await withRetry(
            async () => {
              const res = await fetch(`${process.env.APP_URL}/api/intake/structure`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  // Internal self-call — /api/estimate/draft and /api/intake/structure are
                  // guarded by isCronAuthorised, which is fail-closed in production.
                  Authorization: `Bearer ${process.env.CRON_SECRET}`,
                },
                body: JSON.stringify({ conversationId, sourceChannel: 'sms' }),
              })
              if (!res.ok) {
                throw new Error(`intake/structure HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
              }
            },
            {
              maxAttempts: 3,
              baseDelayMs: 2000,
              // 2026-05-19 "bug zapper" fix part 2 — do NOT retry on a
              // fetch that aborted/timed out on the CLIENT side. When the
              // outbound fetch is aborted (Vercel terminating a long
              // in-flight request, undici headersTimeout, etc.), the
              // intake/structure SERVER may still be running and will
              // complete the full pipeline (Opus + dispatch + DB writes).
              // A retry then triggers a second complete pipeline run —
              // duplicate intake row, duplicate recovery SMS. Belt: the
              // intake/structure route now also enforces idempotency by
              // conversation_id, but treating timeouts as non-retriable
              // here means we don't even attempt the duplicate work.
              shouldRetry: (err) => {
                const msg = err instanceof Error ? err.message : String(err)
                const name = err instanceof Error ? err.name : ''
                const looksLikeAbort =
                  name === 'AbortError' ||
                  name === 'TimeoutError' ||
                  /aborted|timeout|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|fetch failed/i.test(msg)
                return !looksLikeAbort
              },
              onAttemptFailed: (err, attempt, willRetry) => {
                const msg = err instanceof Error ? err.message : String(err)
                const tag = willRetry ? 'retrying' : 'EXHAUSTED'
                console.warn(`[sms/inbound:after] intake handoff attempt ${attempt}/3 failed — ${tag}`, msg.slice(0, 200))
              },
            }
          )
        } catch (e: any) {
          // All retry attempts failed. NEVER leave the customer silent —
          // send a fallback "we hit a snag" SMS so they know to expect a
          // callback rather than wondering if the AI ignored them. Reopen
          // the conversation status so any reply they send doesn't fall
          // into the in-flight short-circuit.
          console.error('[sms/inbound:after] intake handoff EXHAUSTED — sending failure SMS', {
            conversationId,
            error: e?.message ?? String(e),
          })
          try {
            // Best-effort first-name lookup. Try the dialog transcript first,
            // then the customer record (returning customers skip re-stating
            // their name in conversation when we already have it stored).
            // Opus would have extracted it later, but we don't get that
            // chance here — the intake handoff already failed.
            // Same authoritative-first priority as the photo SMS above.
            // Failure SMS must use the customer's REAL name, not a stray
            // word that shape-matched as a name in an earlier turn.
            const failureFirstName =
              (conversationState.slots.first_name as string | undefined) ||
              (customer?.first_name as string | undefined) ||
              guessFirstName(turns) ||
              undefined
            const failureBody = buildQuoteFailureSms({ firstName: failureFirstName, jobType: decision.job_type_guess })
            const failureDispatch = await dispatchQuoteMessage({
              to: fromNumber,
              from: toNumber,
              text: failureBody,
            })
            await supabase.from('sms_messages').insert({
              conversation_id: conversationId,
              direction: 'outbound',
              body: failureDispatch.ok && failureDispatch.channel === 'whatsapp'
                ? `[WhatsApp fallback] ${failureBody}`
                : failureBody,
              twilio_message_sid: failureDispatch.ok ? failureDispatch.sid : null,
            })
            // Flip status back to 'open' so the customer can re-engage
            // without hitting the in-flight canned hold-on rule.
            await supabase
              .from('sms_conversations')
              .update({
                status: 'open',
                updated_at: new Date().toISOString(),
              })
              .eq('id', conversationId)
            console.log('[sms/inbound:after] failure SMS dispatched + status reopened', {
              conversationId,
              dispatchOk: failureDispatch.ok,
            })
          } catch (notifyErr: any) {
            console.error('[sms/inbound:after] failure SMS itself failed — customer will be silent', {
              conversationId,
              error: notifyErr?.message ?? String(notifyErr),
            })
          }
        }
      }

      // R42 — budget self-monitor. If the pipeline (dialog + intake + estimate
      // + all sends) has consumed most of the maxDuration budget by the time we
      // reach the end of after(), emit the alertable after_near_max_duration
      // status. Repeated firing is the operational signal that raising
      // SMS_MAX_DURATION is no longer enough and a true offload (durable queue)
      // is needed — a serverless function cannot exceed the 800s hard ceiling.
      const afterElapsedMs = Date.now() - afterStartedAt
      if (isNearMaxDuration(afterElapsedMs, DELIVERY_KNOBS.maxDurationSec)) {
        logSendOutcome(sendLogger, {
          sendType: 'customer_reply',
          status: 'after_near_max_duration',
          attempts: 0,
          latencyMs: afterElapsedMs,
          error: `after() used ${Math.round(afterElapsedMs / 1000)}s of ${DELIVERY_KNOBS.maxDurationSec}s budget`,
        })
      }
    } catch (e: any) {
      console.error('[sms/inbound:after] UNHANDLED in after()', {
        message: e?.message,
        name: e?.name,
        stack: e?.stack?.split('\n').slice(0, 6).join('\n'),
      })
    } finally {
      // ─────── Post-quote orphan drain (round 4, live 2026-07-25) ───────
      // We hold the lock for the WHOLE pipeline (measure + sends + PDF can run
      // ~90s) but read history near the START. A follow-up landing in that
      // window loses its lock claim and bails, and we never saw it — so nobody
      // ever replies. Live: a price objection, a clarifying question and a
      // second-property request after a quote all got total silence.
      //
      // Before releasing the lock (so no second webhook can race us), check for
      // an inbound we never answered and serve it: re-run the roofing turn, and
      // if the state machine hands it back (a question / objection it will not
      // answer) send one honest acknowledgement. ONE pass, never re-drafts a
      // quote, and every failure is swallowed so the lock is always released.
      try {
        // Deliberately an ACKNOWLEDGEMENT ONLY — it never re-runs the roofing
        // state machine. Re-running it here would re-enter the measure/quote
        // pipeline outside the roofingEnabled / inflight guards and, because
        // the 60s lock has usually EXPIRED by the end of a ~90s run, could race
        // a second webhook into a duplicate measurement, duplicate priced SMS
        // and a second mintable quote link. One honest ack invites the customer
        // to resend, and that next turn is processed normally under a fresh lock.
        const { data: drainRows } = await supabase
          .from('sms_messages')
          .select('direction, body, created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true })
        if (hasUnrepliedInbound(drainRows ?? [], historyReadAt)) {
          // Only ack while we PROVABLY still hold the lock: a 90s pipeline
          // outruns the 60s lock, and once it lapses another webhook owns the
          // conversation and will reply itself.
          const { data: lockNow } = await supabase
            .from('sms_conversations')
            .select('processing_until, roofing_state')
            .eq('id', conversationId)
            .maybeSingle()
          const lockRow = lockNow as { processing_until?: string | null; roofing_state?: unknown } | null
          const stillOwnLock = !!lockRow?.processing_until && new Date(lockRow.processing_until) > new Date()
          const drainStep = (lockRow?.roofing_state as RoofingConversationState | null)?.last_step ?? null
          const roofingActive = !!drainStep && drainStep !== 'closed'
          const lastInbound = [...(drainRows ?? [])].reverse().find(m => m.direction === 'inbound')?.body ?? ''
          // Never reply to an opt-out, and never start work we cannot finish.
          const optedOut = isStopRequest(lastInbound) || isGlobalOptOut(lastInbound)
          const outOfBudget = isNearMaxDuration(Date.now() - afterStartedAt, DELIVERY_KNOBS.maxDurationSec)
          console.log('[sms/inbound:after] orphaned follow-up detected before lock release', {
            conversationId, roofingStep: drainStep, roofingActive, stillOwnLock, optedOut, outOfBudget,
          })
          if (roofingActive && stillOwnLock && !optedOut && !outOfBudget) {
            const ack =
              "Thanks, I've passed that to the roofer and they'll come back to you shortly. If you'd like another property quoted, just send the address."
            await dispatchQuoteMessage({ to: fromNumber, text: ack, from: toNumber })
            await supabase.from('sms_messages').insert({
              conversation_id: conversationId,
              direction: 'outbound',
              body: ack,
            })
            console.log('[sms/inbound:after] orphaned follow-up acknowledged', { conversationId })
          }
        }
      } catch (drainErr: any) {
        console.warn('[sms/inbound:after] orphan drain failed (non-fatal)', {
          conversationId,
          message: drainErr?.message ?? String(drainErr),
        })
      }

      // ─────── Release the per-conversation lock ───────
      // Always runs — whether the work succeeded, threw, or was downgraded
      // to the fallback. Clearing processing_until lets the next inbound
      // SMS (which may be sitting in DB after a failed lock claim) be
      // processed by the next webhook for this customer.
      //
      // If the column doesn't exist (migration 007 unapplied), this update
      // returns an error which we log but DO NOT throw on — fail-open is
      // already in effect upstream so the customer has been served.
      try {
        const { error: releaseErr } = await supabase
          .from('sms_conversations')
          .update({ processing_until: null })
          .eq('id', conversationId)
        if (releaseErr) {
          console.warn('[sms/inbound:after] lock release returned error (will auto-expire in 60s)', {
            conversationId,
            code: (releaseErr as { code?: string }).code,
            message: releaseErr.message,
          })
        } else {
          console.log('[sms/inbound:after] lock released', { conversationId })
        }
      } catch (releaseErr: any) {
        console.error('[sms/inbound:after] lock release threw (will auto-expire in 60s)', {
          conversationId,
          error: releaseErr?.message ?? String(releaseErr),
        })
      }
    }
  })

  console.log('[sms/inbound] step 11 — returning empty TwiML ack (work continues in after())')
  return ackTwiml()
 } catch (err: any) {
  console.error('[sms/inbound] UNHANDLED error', {
    message: err?.message,
    name: err?.name,
    stack: err?.stack?.split('\n').slice(0, 8).join('\n'),
  })
  return new Response(
    JSON.stringify({ error: err?.message ?? String(err) }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  )
 }
}

// ════════════════════════════════════════════════════════════════════
// SMS-initiated tradie onboarding (v6 SMS flow).
//
// Runs BEFORE the customer-quote conversation pipeline when there's no
// tenant match on the destination number. Decides whether to short-
// circuit into the registration flow based on:
//
//   • Is there already a recent tradie_registration conversation for
//     this from_number?            → resend the link
//   • Does the inbound message match the tradie-intent regex?
//                                  → start a new tradie_registration
//   • Otherwise                    → return null, let the normal
//                                    customer-quote flow take over.
// ════════════════════════════════════════════════════════════════════
async function maybeHandleTradieRegistration(args: {
  fromNumber: string
  toNumber: string
  inboundBody: string
  messageSid: string | null
}): Promise<Response | null> {
  // 1. Check for an in-flight tradie-registration conversation first.
  const REGISTRATION_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000  // 24h
  const { data: priorTradie } = await supabase
    .from('sms_conversations')
    .select('id, conversation_type, last_message_at, status')
    .eq('from_number', args.fromNumber)
    .eq('conversation_type', 'tradie_registration')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  // US-003 review follow-up (2026-07-23): this branch short-circuits BEFORE
  // the after() opt-out check, so a bare STOP inside the 24h registration
  // window used to be adopted as a registration reply and answered with the
  // signup link — the one message an opted-out prospect must not get.
  // Honour it here: close the thread, send nothing, ack Twilio.
  if (priorTradie && isGlobalOptOut(args.inboundBody)) {
    console.log('[sms/inbound] tradie-registration opt-out — closing thread, no reply', {
      conversationId: priorTradie.id,
    })
    try {
      await supabase
        .from('sms_conversations')
        .update({ status: 'done', updated_at: new Date().toISOString() })
        .eq('id', priorTradie.id)
    } catch (e) {
      console.warn('[sms/inbound] registration opt-out close failed (non-fatal)', e)
    }
    return ackTwiml()
  }

  const reusePriorTradieThread =
    priorTradie &&
    priorTradie.last_message_at &&
    Date.now() - new Date(priorTradie.last_message_at).getTime() < REGISTRATION_REUSE_WINDOW_MS &&
    priorTradie.status !== 'converted'

  // 2. Detect intent on the current message. Async because the hybrid
  //    classifier may fall back to Sonnet for messages that don't match
  //    the regex strong-phrase lists. Total latency budget ≤ ~400ms.
  const classification = await classifyIntent(args.inboundBody)
  const hasJoinCode = parseJoinCode(args.inboundBody) !== null
  const isTradieIntent = classification.intent === 'tradie_registration' || hasJoinCode

  // Skip the branch entirely if neither path is triggered.
  if (!reusePriorTradieThread && !isTradieIntent) {
    return null
  }

  console.log('[sms/inbound] tradie registration branch', {
    fromNumber: args.fromNumber,
    reusedThread: !!reusePriorTradieThread,
    classification,
  })

  // 3. Get or create the conversation row.
  let conversationId: string
  if (reusePriorTradieThread) {
    conversationId = priorTradie.id
  } else {
    const { data: created, error: createErr } = await supabase
      .from('sms_conversations')
      .insert({
        from_number: args.fromNumber,
        to_number: args.toNumber,
        status: 'open',
        conversation_type: 'tradie_registration',
      })
      .select('id')
      .single()
    if (createErr || !created) {
      console.error('[sms/inbound] tradie conversation create failed', createErr)
      return new Response('DB error', { status: 500 })
    }
    conversationId = created.id
  }

  // 4. Persist the inbound message.
  await supabase.from('sms_messages').insert({
    conversation_id: conversationId,
    direction: 'inbound',
    body: args.inboundBody,
    twilio_message_sid: args.messageSid,
  })

  // ── Invitation-code gate (SMS path) ──────────────────────────
  // Fresh registrations must include a valid code (CTA: "JOIN <code>").
  // A returning tradie re-texting an in-flight thread is already past
  // the gate, so a missing code on the reuse path is allowed through.
  const smsCode = parseJoinCode(args.inboundBody)
  if (smsCode) {
    const smsCodeCheck = await checkInvitationCode(supabase, smsCode)
    if (!smsCodeCheck.ok) {
      after(() => sendSms({ to: args.fromNumber, from: args.toNumber, text: smsCodeCheck.message }))
      return ackTwiml()
    }
  } else if (!reusePriorTradieThread) {
    after(() =>
      sendSms({
        to: args.fromNumber,
        from: args.toNumber,
        text: 'Welcome to QuoteMax! To start, reply with your invitation code, e.g. JOIN YOUR-CODE',
      }),
    )
    return ackTwiml()
  }

  // 5. Get-or-create the active signup intent for this mobile.
  const intent = await createOrGetActiveIntent(supabase, {
    owner_mobile: args.fromNumber,
    sms_conversation_id: conversationId,
  })
  if ('error' in intent) {
    console.error('[sms/inbound] tradie intent creation failed', intent.error)
    return new Response('Intent error', { status: 500 })
  }

  // 6. Build the SMS body. Welcome on first-touch, reminder on re-text.
  const appUrl = process.env.APP_URL ?? 'https://quote-mate-rho.vercel.app'
  const body = intent.reused
    ? buildTradieIntentStillOpenSms({ appUrl, token: intent.token, code: smsCode ?? undefined })
    : buildTradieWelcomeSms({ appUrl, token: intent.token, code: smsCode ?? undefined })

  // 7. Dispatch the outbound SMS in after() so we ack Twilio fast.
  after(async () => {
    try {
      const result = await sendSms({
        to: args.fromNumber,
        from: args.toNumber,
        text: body,
      })
      if (result.ok) {
        await supabase.from('sms_messages').insert({
          conversation_id: conversationId,
          direction: 'outbound',
          body,
          twilio_message_sid: result.sid,
        })
        await supabase
          .from('sms_conversations')
          .update({
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', conversationId)
      } else {
        console.error('[sms/inbound] tradie outbound SMS failed', {
          conversationId,
          code: result.code,
          reason: result.reason,
        })
      }
    } catch (e: any) {
      console.error('[sms/inbound] tradie outbound SMS threw', {
        conversationId,
        message: e?.message ?? String(e),
      })
    }
  })

  return ackTwiml()
}
