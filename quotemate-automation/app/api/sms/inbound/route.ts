// ─────────────────────────────────────────────────────────────────────
// SMS Agent — Phase 2 (the AI brain).
// Validates Twilio signature, persists inbound, asks the Haiku dialog
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
import { formatActiveFollowupContext } from '@/lib/sms/followup-context'
import { isQuoteInflight, DONE_INFLIGHT_WINDOW_MS } from '@/lib/sms/inflight'
import { extractAndStoreMmsPhotos } from '@/lib/sms/mms'
import { buildPhotoRequestSms, buildQuoteInFlightSms, buildQuoteFailureSms } from '@/lib/sms/templates'
import { withRetry } from '@/lib/util/retry'
import {
  findOrCreateCustomer,
  formatCustomerContext,
  writeCustomerCorrections,
  type CustomerProfile,
} from '@/lib/customers/lookup'
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
import {
  buildTradieWelcomeSms,
  buildTradieIntentStillOpenSms,
} from '@/lib/sms/templates'
import { sendSms } from '@/lib/sms/twilio'

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

// Allow the after() block enough time for Haiku + Twilio + DB writes.
// Vercel Hobby = 60s ceiling; Pro = 300s. The inline path returns 200
// in <500ms so Twilio is happy regardless.
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// Graceful fallback if the dialog agent throws — the customer still gets
// a reply rather than silence.
/**
 * Personalised fallback reply for when the dialog Haiku call throws
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

export async function POST(req: Request) {
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
  const inboundBody = (params.Body ?? '').trim()
  const messageSid = params.MessageSid ?? null

  if (!fromNumber || !toNumber || !inboundBody) {
    return new Response('Missing required Twilio fields', { status: 400 })
  }

  // ─────── Tenant routing (v6 multi-tenant) ───────
  // Look up which registered tradie owns the destination number the
  // customer texted. New conversations get this tenant_id stamped so
  // downstream (estimator, etc.) can scope by tenant.
  // Fail-soft: no tenant match → null → existing pipeline uses the
  // legacy single pricing_book (back-compat for pre-v6 conversations).
  const { tenantByDestinationSms } = await import('@/lib/tenant/lookup')
  const tenant = await tenantByDestinationSms(supabase, toNumber)
  if (tenant) {
    console.log('[sms/inbound] step 2a — tenant resolved by destination number', {
      tenantId: tenant.id,
      businessName: tenant.business_name,
      trade: tenant.trade,
      status: tenant.status,
    })
  } else {
    console.log('[sms/inbound] step 2a — no tenant match for destination', {
      toNumber,
      note: 'falling back to legacy single-pricing-book pipeline',
    })
  }

  // ─────── Customer memory lookup ───────
  // Look up (or stub-create) the customer record for this phone number.
  // Used downstream to: pre-populate the dialog with known fields so
  // returning customers don't get re-asked their name/suburb, and to
  // link the conversation back to a customer for cross-channel history.
  // Fail-soft: returns null on DB error, all downstream code handles null.
  const customer: CustomerProfile | null = await findOrCreateCustomer(fromNumber, 'sms')
  if (customer) {
    console.log('[sms/inbound] step 2 — customer resolved', {
      customerId: customer.id,
      hasName: !!customer.first_name,
      hasSuburb: !!customer.suburb,
      totalQuotes: customer.total_quotes,
    })
  }

  // ─────── Idempotency guard ───────
  // Twilio may retry the webhook (timeout, fallback URL config, etc.).
  // Without this, a retry would persist a duplicate inbound row, run
  // Haiku again, and dispatch another reply. We dedupe on MessageSid —
  // if we've already persisted an inbound row for this SID, ack with
  // 200 immediately and bail. SMS-without-SID (extremely rare) falls
  // through to normal processing rather than failing closed.
  if (messageSid) {
    const { data: existingMsg } = await supabase
      .from('sms_messages')
      .select('id, conversation_id')
      .eq('twilio_message_sid', messageSid)
      .eq('direction', 'inbound')
      .maybeSingle()
    if (existingMsg) {
      console.warn('[sms/inbound] duplicate MessageSid — ignoring retry', {
        messageSid,
        existingMessageId: existingMsg.id,
        conversationId: existingMsg.conversation_id,
      })
      return ackTwiml()
    }
  }

  // ─────── Tradie-registration short-circuit (v6) ───────
  // When the destination number has no tenant match (e.g. the shared
  // QuoteMate admin number), check if the inbound message is a tradie
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
  //             We send a canned hold-on message and skip Haiku entirely.
  //   REUSE:    the prior conversation is mid-flow OR a recently-done quote
  //             is in the 5-min add-on grace window. Continue the dialog.
  //   NEW:      no prior or prior is too old/stale. Create a new row;
  //             customerHistoryHint = 'first_time' or 'returning'.
  //
  // Window thresholds (don't change without updating the comment).
  // STRUCTURING_INFLIGHT_MAX_MS + DONE_INFLIGHT_WINDOW_MS + the in-flight
  // rule itself now live in lib/sms/inflight.ts (pure + unit-tested) so
  // the "done means a quote is in transit" bug can't silently regress.
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
  const isReuseDoneGrace = !!prior && !isInflight && (
    prior.status === 'done' && ageMs >= DONE_INFLIGHT_WINDOW_MS && ageMs < REUSE_DONE_GRACE_MS
  )

  if (isInflight) {
    mode = 'inflight'
    conversation = prior!
    customerHistoryHint = 'continuing'  // unused in inflight path; canned message bypasses Haiku
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
    const { data: created, error: createErr } = await supabase
      .from('sms_conversations')
      .insert({
        from_number: fromNumber,
        to_number: toNumber,
        status: 'open',
        customer_id: customer?.id ?? null,
        // v6 multi-tenant: stamp the conversation with the tenant whose
        // destination number was texted. Null for legacy pre-v6 traffic.
        tenant_id: tenant?.id ?? null,
        photo_request_token: photoToken,
        conversation_state: initialState,
      })
      .select()
      .single()
    if (createErr || !created) {
      console.error('[sms/inbound] conversation create failed', createErr)
      return new Response('DB error', { status: 500 })
    }
    conversation = created
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
  if (insertErr) {
    if (insertErr.code === '23505') {
      console.warn('[sms/inbound] race lost — duplicate MessageSid landed concurrently', {
        messageSid,
        conversationId: conversation.id,
      })
      return ackTwiml()
    }
    console.error('[sms/inbound] inbound persist failed', insertErr)
    return new Response('DB error', { status: 500 })
  }

  // ─────── Per-conversation lock claim ───────
  // Atomically try to claim "I'm the leader who'll prepare the next reply
  // for this conversation". If the row's processing_until is NULL or in
  // the past, we win the lock; otherwise another webhook is already
  // running Haiku for this customer and we should bail without sending
  // a duplicate reply. The follower's inbound message is already persisted
  // (above) so the leader will see it when it loads conversation history.
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
  // Everything below — Haiku call, Twilio outbound, conversation update,
  // intake handoff — runs after the 200 is returned. This keeps the
  // webhook latency under ~500ms regardless of how long Haiku takes.
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
  // CRITICAL: only inherit quote-already-drafted status from `prior` when
  // we are REUSING the prior conversation row. In mode='new', `prior` is
  // a DIFFERENT (older) conversation for the same phone number; treating
  // its status as ours would force every new conversation to status='done'
  // (via the hasExistingIntake override below) and trigger spurious
  // INFLIGHT canned hold-ons on subsequent inbound turns. Caught while
  // stress-testing: a fresh conversation after yesterday's done quote
  // was getting "just finalising the quote we were working on" canned
  // replies on every other turn.
  const quoteAlreadyDrafted =
    mode !== 'new' && (
      !!priorIntakeId || prior?.status === 'done' || prior?.status === 'structuring'
    )
  // Slot state captured at request entry. Inside after() we run the slot
  // extractor against the customer's latest inbound and merge any updates
  // back into this state, then persist + pass into the dialog Haiku call.
  const initialConversationState: ConversationState = normaliseState(conversation.conversation_state)
  // Photo-request state — passed into after() so we can decide whether
  // to fire the upload-link SMS (parallel to Haiku's reply, only on the
  // first turn that identifies an easy-5 job_type, never twice).
  const photoRequestToken = conversation.photo_request_token as string | null
  const photoRequestAlreadySent = !!conversation.photo_request_sent_at
  // Customer-history hint flows into the dialog agent so it picks the
  // right opener: full intro / welcome-back / no greeting.
  const customerHistory = customerHistoryHint
  // Lookup mode controls the after() flow — when 'inflight', we skip
  // Haiku/status-update/intake-handoff entirely and just send a canned
  // hold-on message so the customer doesn't get a bungled "new job"
  // reply while the previous quote is still being drafted.
  const lookupMode = mode
  // Photo-link hint flows into Haiku. Haiku owns the timing decision
  // via decision.request_photo_link (see lib/sms/dialog.ts Rule 10).
  //   - already_sent:   photo SMS fired in an earlier turn, don't repeat
  //   - pending:        photo not yet sent and token exists; Haiku
  //                     decides the right turn to fire it (typically
  //                     after all qualifying questions are answered,
  //                     combined with the verification handshake)
  //   - not_applicable: no token / legacy conversation
  const photoLinkHint: 'already_sent' | 'pending' | 'not_applicable' =
    photoRequestAlreadySent ? 'already_sent'
      : photoRequestToken ? 'pending'
      : 'not_applicable'

  after(async () => {
    try {
      // ─────── In-flight short-circuit ───────
      // The customer texted while their PREVIOUS quote is being drafted
      // (status='structuring') or just finished and dispatched (status='done'
      // < 60s old). Send a canned hold-on message — bypasses Haiku entirely
      // so we don't accidentally treat new work as an add-on to a quote
      // that's already locked-in. The customer's new message is preserved
      // in sms_messages; when they re-engage post-quote, the dialog picks
      // up normally via the 5-min done-grace REUSE rule.
      if (lookupMode === 'inflight') {
        console.log('[sms/inbound:after] INFLIGHT — sending canned hold-on, skipping Haiku', {
          conversationId,
        })
        const holdOnText = buildQuoteInFlightSms()
        const holdOnDispatch = await dispatchQuoteMessage({
          to: fromNumber,
          from: toNumber,
          text: holdOnText,
        })
        if (holdOnDispatch.ok) {
          console.log('[sms/inbound:after] INFLIGHT — hold-on SMS sent', {
            channel: holdOnDispatch.channel,
            sid: holdOnDispatch.sid,
          })
        } else {
          console.error('[sms/inbound:after] INFLIGHT — hold-on SMS failed (both channels)', {
            smsAttempt: holdOnDispatch.smsAttempt,
            waAttempt: holdOnDispatch.waAttempt,
          })
        }
        // Persist the canned outbound so it appears in conversation history.
        // We tag it with the actual Twilio SID when dispatch succeeded.
        await supabase.from('sms_messages').insert({
          conversation_id: conversationId,
          direction: 'outbound',
          body: holdOnDispatch.ok && holdOnDispatch.channel === 'whatsapp'
            ? `[WhatsApp fallback] ${holdOnText}`
            : holdOnText,
          twilio_message_sid: holdOnDispatch.ok ? holdOnDispatch.sid : null,
        })
        // Update only the activity timestamp — DO NOT change status, DO NOT
        // bump turn_count semantically (this isn't a real dialog turn), and
        // critically DO NOT fire the intake-handoff (the previous quote is
        // already running — we don't want a second one).
        await supabase
          .from('sms_conversations')
          .update({
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', conversationId)
        // Done — finally block will release the lock.
        return
      }

      // ─────── Debounce window ───────
      // Wait briefly to let any rapid-fire follow-up messages land before we
      // read history + run Haiku. Customer firing "Hey there" + "Hi there"
      // within ~1s lands both in DB; we then call Haiku ONCE with both in
      // history and reply ONCE. The follow-up webhook fails to claim the
      // lock and bails (its message is already persisted).
      const DEBOUNCE_MS = 1500
      await new Promise(r => setTimeout(r, DEBOUNCE_MS))

      console.log('[sms/inbound:after] step 5 — loading conversation history (post-debounce)', { conversationId })
      // 5. Load the full message history (oldest first) — including the inbound
      //    we just persisted AND any rapid-fire messages that landed during
      //    the debounce window.
      const { data: historyRows } = await supabase
        .from('sms_messages')
        .select('direction, body, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })

      const turns: ConversationTurn[] = (historyRows ?? []).map(m => ({
        direction: m.direction as 'inbound' | 'outbound',
        body: m.body,
      }))
      const inboundCount = turns.filter(t => t.direction === 'inbound').length

      // ─────── Slot extraction (PR-B step 4) ───────
      // Run a tiny Haiku NLU pass against the latest inbound and merge
      // structured updates into conversation_state. Catches customer
      // corrections in real time — without this, "Chandler" arrives as
      // plain text in sms_messages and nothing tracks the change, so the
      // dialog Haiku has to re-derive every turn (and sometimes drops it).
      // Fail-open: extraction failure leaves the dialog running on stale state.
      let conversationState: ConversationState = initialConversationState
      try {
        // Rapid-fire debounce coalescing: when a customer fires multiple
        // SMS in <1.5s (e.g. "Hi", "I need 6 downlights", "in the lounge"),
        // the 1.5s debounce window collects ALL of them into the
        // sms_messages table before this slot-extractor turn runs. The
        // dialog Haiku already sees them as separate history entries, but
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
                console.log('[sms/inbound:after] eager profile write-back triggered', {
                  conversationId,
                  customerId: customer.id,
                  fields: correctedProfileSlots,
                })
                try {
                  await writeCustomerCorrections({
                    customerId: customer.id,
                    fields,
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
        //     what stale data Haiku is about to see)
        //   - the actual error class + first stack frame
        // Without this the only signal was "slot extraction failed" with
        // no way to tell if it was a 5s Haiku timeout, a Zod parse error
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

      console.log('[sms/inbound:after] step 6 — calling Haiku dialog agent', {
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
      // 6. Ask Haiku what to do next — ask | finish | escalate_inspection.
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
        | Array<{ name: string; description: string | null; always_inspection: boolean }>
        | undefined
      if (tenant?.id) {
        const { data: caRows, error: caErr } = await supabase
          .from('tenant_custom_assemblies')
          .select('name, description, always_inspection')
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
      if (tenant?.id) {
        try {
          const { data: offerings } = await supabase
            .from('tenant_service_offerings')
            .select('assembly_id')
            .eq('tenant_id', tenant.id)
            .eq('enabled', true)
          const enabledIds = (offerings ?? [])
            .map((o) => o.assembly_id as string | null)
            .filter((id): id is string => !!id)
          if (enabledIds.length > 0) {
            const { data: extras } = await supabase
              .from('shared_assemblies')
              .select('name, description, trade, default_enabled')
              .in('id', enabledIds)
              .eq('default_enabled', false)
              .order('trade')
              .order('name')
            if (extras && extras.length > 0) {
              const seen = new Set(
                (customAssemblies ?? []).map((c) => c.name.trim().toLowerCase()),
              )
              const mapped = extras
                .map((r) => ({
                  name: r.name as string,
                  description: (r.description as string | null) ?? null,
                  always_inspection: false,
                }))
                .filter((r) => {
                  const k = r.name.trim().toLowerCase()
                  if (seen.has(k)) return false
                  seen.add(k)
                  return true
                })
              if (mapped.length > 0) {
                customAssemblies = [...(customAssemblies ?? []), ...mapped]
                console.log('[sms/inbound:after] enabled catalogue extras in dialog scope', {
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
      }

      // ─── Tenant DECLINED services (toggle OFF → polite "we don't do
      // that", NOT the $199 inspection fallback) ──────────────────────
      // Mirrors the /api/tenant/me resolution: a catalogue service is OFF
      // when an explicit tenant_service_offerings row says enabled=false
      // OR there is no row and shared_assemblies.default_enabled is false;
      // disabled tenant_custom_assemblies count too. Without feeding these
      // in, an OFF electrical extra like "Hardwire oven" falls through to
      // the hardcoded Rule 4/6 ("oven/cooktop -> $199 inspection") and the
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
          // do that" + pivot instead of the hardcoded $199-inspection
          // fallback for OFF catalogue extras like "Hardwire oven".
          declinedServices,
          // PR-B: per-conversation slot state is the new source of truth.
          // The dialog prompt + deterministic scrub both read from this.
          conversationState,
          // v6 multi-tenant trade scope — tells Haiku WHICH trades this
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
          action: 'escalate_inspection',
          job_type_guess: 'unknown',
          reply_to_send: buildDialogFallbackReply({
            firstName: fallbackFirst,
            jobType: fallbackJob,
          }),
          assumptions_made: [],
          ready_for_intake: false,
          request_photo_link: false,
          reason_for_escalation: 'dialog agent error',
        }
      }

      // ─── PROGRAMMATIC RULE 5/6 GUARD (belt-and-braces) ────────────────
      // Even with strict EXCEPTION wording in the system prompt, Haiku
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
      //   - Haiku isn't escalating or ending the conversation
      //   - We have a job_type identified (we're past Rule 4)
      //   - The required field isn't already known (transcript slots OR
      //     customer record)
      //   - We haven't asked this question yet (no loop)
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

      // BUG D fix: if Haiku's CURRENT reply (this turn) is already asking
      // for the name or suburb, the guard should stand down. Without this
      // check, the guard overwrites Haiku's correct first-time intro
      // ("G'day, thanks for messaging QuoteMate, I'm the AI quoting
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
        console.warn('[sms/inbound:after] RULE 5 GUARD — Haiku skipped name question; overriding', {
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
        console.warn('[sms/inbound:after] RULE 6 GUARD — Haiku skipped suburb question; overriding', {
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

      // Quote-already-drafted guard (moved up before step 7 so we can decide
      // message ordering before dispatching anything).
      //
      // When a customer texts back after their quote has been sent
      // ("Thanks!", "Sounds good", "Can I add a fan?"), the
      // sms_conversation is reused under the 5-min done-grace window and
      // Haiku runs fresh. Without this check, Haiku — having no memory
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
      // regardless of what Haiku decided. Haiku's reply text still goes
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
        .select('intake_id')
        .eq('id', conversationId)
        .maybeSingle()
      const freshIntakeId = (convoState?.intake_id as string | null) ?? null
      const hasExistingIntake = !!freshIntakeId || quoteAlreadyDrafted
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

      // 8b. Photo-request SMS gate — computed early so we can send the photo
      // link BEFORE the quote confirmation (correct UX order).
      // Photo SMS firing is Haiku-driven via decision.request_photo_link.
      // Haiku sets it true on the verification handshake turn (after all
      // qualifying questions are answered). Safety-net: if Haiku reaches
      // action='finish' on an easy-5 job without setting request_photo_link,
      // fire on finish so we never silently drop the photo flow.
      //
      // BUG E fix: gate by EASY_5_JOB_TYPES regardless of Haiku's flag —
      // plumbing jobs (blocked_drain, hot_water, etc.) don't benefit from
      // customer photos, so we never send a photo link for them even if
      // Haiku tries to set request_photo_link=true.
      const haikuRequestedPhoto = decision.request_photo_link === true
      const finishFallbackTrigger =
        decision.action === 'finish' &&
        EASY_5_JOB_TYPES.has(decision.job_type_guess)
      const jobTypeQualifiesForPhoto =
        EASY_5_JOB_TYPES.has(decision.job_type_guess)
      const shouldSendPhotoRequest =
        photoRequestToken &&
        !photoRequestAlreadySent &&
        !hasExistingIntake &&
        decision.action !== 'escalate_inspection' &&
        decision.action !== 'end_conversation' &&
        jobTypeQualifiesForPhoto &&
        (haikuRequestedPhoto || finishFallbackTrigger)

      // Ordering fix: photo link goes FIRST, then "quote on its way" with a
      // 2s carrier-ordering gap. Previously the confirmation fired first and
      // the photo link arrived 2.5s later — customers read "quote on its way"
      // then immediately got asked to send photos, which made no sense.
      // New order: photo → 2s gap → confirmation.
      if (shouldSendPhotoRequest) {
        console.log('[sms/inbound:after] step 8b — dispatching photo-request SMS (before quote confirmation)', {
          conversationId,
          jobType: decision.job_type_guess,
        })
        try {
          const appUrl = process.env.APP_URL ?? 'https://quote-mate-rho.vercel.app'
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
        // 2s gap before the quote confirmation so AU long-code carrier
        // doesn't reorder the two messages.
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      // Step 7: quote confirmation (or any dialog reply). Fires after the
      // photo link when shouldSendPhotoRequest is true, immediately otherwise.
      console.log('[sms/inbound:after] step 7 — dispatching reply (SMS-first, WhatsApp fallback)')
      const dispatch = await dispatchQuoteMessage({
        to: fromNumber,
        from: toNumber,
        text: decision.reply_to_send,
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
      } else {
        console.error('[sms/inbound:after] step 7 — dispatch failed (both channels)', {
          smsAttempt: dispatch.smsAttempt,
          waAttempt: dispatch.waAttempt,
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
        hasExistingIntake ? 'done'
      : decision.action === 'finish' ? 'structuring'
      : decision.action === 'escalate_inspection' ? 'done'
      : decision.action === 'end_conversation' ? 'done'
      : 'open'

      const mergedAssumptions = [
        ...initialAssumptions,
        ...decision.assumptions_made,
      ]

      console.log('[sms/inbound:after] step 9 — updating conversation', {
        newStatus,
        mergedAssumptionsCount: mergedAssumptions.length,
      })
      await supabase
        .from('sms_conversations')
        .update({
          turn_count: initialTurnCount + 1,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          assumptions_made: mergedAssumptions,
          status: newStatus,
        })
        .eq('id', conversationId)

      // 10. If the dialog finished, hand off to the existing intake pipeline.
      // Wrapped in withRetry — the customer already got their dialog reply,
      // but the quote depends entirely on this POST landing successfully.
      // Silent failure here = no quote ever drafted = lost customer.
      // 3 attempts, 2s/4s backoff. Runs inside after() so customer doesn't wait.
      //
      // hasExistingIntake guard: a quote was already drafted on this
      // conversation — Haiku occasionally re-reasons 'finish' on courtesy
      // replies ("Thanks!") which would otherwise produce duplicate
      // quotes. Skip the handoff entirely in that case.
      if (decision.action === 'finish' && !hasExistingIntake) {
        console.log('[sms/inbound:after] step 10 — firing intake/structure handoff', { conversationId })
        try {
          await withRetry(
            async () => {
              const res = await fetch(`${process.env.APP_URL}/api/intake/structure`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conversationId, sourceChannel: 'sms' }),
              })
              if (!res.ok) {
                throw new Error(`intake/structure HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
              }
            },
            {
              maxAttempts: 3,
              baseDelayMs: 2000,
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
    } catch (e: any) {
      console.error('[sms/inbound:after] UNHANDLED in after()', {
        message: e?.message,
        name: e?.name,
        stack: e?.stack?.split('\n').slice(0, 6).join('\n'),
      })
    } finally {
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

  const reusePriorTradieThread =
    priorTradie &&
    priorTradie.last_message_at &&
    Date.now() - new Date(priorTradie.last_message_at).getTime() < REGISTRATION_REUSE_WINDOW_MS &&
    priorTradie.status !== 'converted'

  // 2. Detect intent on the current message. Async because the hybrid
  //    classifier may fall back to Haiku for messages that don't match
  //    the regex strong-phrase lists. Total latency budget ≤ ~400ms.
  const classification = await classifyIntent(args.inboundBody)
  const isTradieIntent = classification.intent === 'tradie_registration'

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
    ? buildTradieIntentStillOpenSms({ appUrl, token: intent.token })
    : buildTradieWelcomeSms({ appUrl, token: intent.token })

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
