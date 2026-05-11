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

// Easy-5 jobs benefit from a photo (visual ceiling/wall/access detail)
// before Opus drafts the quote. Out-of-scope jobs go straight to
// inspection so a photo prompt would be off-message.
const EASY_5_JOB_TYPES = new Set([
  'downlights',
  'power_points',
  'ceiling_fans',
  'smoke_alarms',
  'outdoor_lighting',
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
const DIALOG_FALLBACK_REPLY =
  "Thanks — we'll get back to you shortly to confirm details."

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
  // Window thresholds (don't change without updating the comment):
  const STRUCTURING_INFLIGHT_MAX_MS = 5 * 60 * 1000  // structuring beyond 5min = stuck/failed → treat as new
  const DONE_INFLIGHT_WINDOW_MS     = 60 * 1000      // 60s after done = quote SMS in transit
  const REUSE_DONE_GRACE_MS         = 5 * 60 * 1000  // 5min after done = add-on grace
  const REUSE_OPEN_WINDOW_MS        = 4 * 60 * 60 * 1000  // 4h on open = pause-and-resume

  const { data: prior, error: lookupErr } = await supabase
    .from('sms_conversations')
    .select('*')
    .eq('from_number', fromNumber)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

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
  const isInflight = !!prior && (
    (prior.status === 'structuring' && ageMs < STRUCTURING_INFLIGHT_MAX_MS)
    || (prior.status === 'done' && ageMs < DONE_INFLIGHT_WINDOW_MS)
  )
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
        const lastInbound = turns.filter(t => t.direction === 'inbound').at(-1)?.body ?? ''
        const lastOutbound = turns.filter(t => t.direction === 'outbound').at(-1)?.body ?? null
        const extraction = await extractSlots({
          state: conversationState,
          lastAgentMessage: lastOutbound,
          customerMessage: lastInbound,
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
        console.warn('[sms/inbound:after] slot extraction failed - continuing with stale state', {
          message: e?.message,
          name: e?.name,
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
      let decision: Awaited<ReturnType<typeof decideNextTurn>>
      try {
        decision = await decideNextTurn({
          history: turns,
          inboundCount,
          customerHistory,
          photoLink: photoLinkHint,
          // PR-B: per-conversation slot state is the new source of truth.
          // The dialog prompt + deterministic scrub both read from this.
          conversationState,
          // Legacy memory injections — kept for backwards compat. The
          // dialog prefers conversationState when it has slots; these are
          // fallbacks for callers that haven't migrated yet.
          customerContext: formatCustomerContext(customer),
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
        decision = {
          action: 'escalate_inspection',
          job_type_guess: 'unknown',
          reply_to_send: DIALOG_FALLBACK_REPLY,
          assumptions_made: [],
          ready_for_intake: false,
          request_photo_link: false,
          reason_for_escalation: 'dialog agent error',
        }
      }

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

      // 8b. Photo-request SMS (parity with voice agent's send_sms_photo_link).
      // Fire ONCE per conversation, the first turn that identifies an
      // easy-5 job_type AND we haven't already sent the link. We send it
      // as a separate SMS rather than appending to Haiku's reply so the
      // 320-char dialog cap stays clean and the upload-link message is
      // visually distinct in the customer's thread.
      // Photo SMS firing is now Haiku-driven via decision.request_photo_link.
      // Haiku sets it true on the appropriate turn (typically the verification
      // handshake, after all qualifying questions are answered). The route no
      // longer auto-fires on first job_type identification — that was the bug
      // where the photo link arrived on turn 2 before customers gave their name.
      //
      // Safety-net fallback: if Haiku reaches action='finish' on an easy-5 job
      // without ever setting request_photo_link, fire the photo SMS on finish
      // so we don't drop the photo flow entirely. Better late than never.
      const haikuRequestedPhoto = decision.request_photo_link === true
      const finishFallbackTrigger =
        decision.action === 'finish' &&
        EASY_5_JOB_TYPES.has(decision.job_type_guess)
      const shouldSendPhotoRequest =
        photoRequestToken &&
        !photoRequestAlreadySent &&
        decision.action !== 'escalate_inspection' &&
        decision.action !== 'end_conversation' &&
        (haikuRequestedPhoto || finishFallbackTrigger)

      if (shouldSendPhotoRequest) {
        console.log('[sms/inbound:after] step 8b — dispatching photo-request SMS', {
          conversationId,
          jobType: decision.job_type_guess,
        })
        // Brief delay before firing the photo SMS so it doesn't race the
        // verification-handshake SMS we just sent in step 7. AU long codes
        // can reorder messages sent <2s apart on the carrier side, which
        // led to the customer seeing the photo link BEFORE the handshake
        // message that announced it. 2.5s is enough headroom for reliable
        // ordering without being a noticeable typing pause.
        await new Promise(resolve => setTimeout(resolve, 2500))
        try {
          const appUrl = process.env.APP_URL ?? 'https://quote-mate-rho.vercel.app'
          const uploadUrl = `${appUrl}/upload/${photoRequestToken}`
          // Customer's first name is best-effort — Opus will recover it from
          // the transcript later regardless. Pull from the most recent
          // inbound turn that looks like a name (1-3 words, mostly letters);
          // if the transcript doesn't have one (returning-customer flows skip
          // re-asking the name when we already know it), fall back to the
          // customer record. Last resort: generic greeting.
          const firstName = guessFirstName(turns) ?? customer?.first_name ?? undefined
          const photoBody = buildPhotoRequestSms({ firstName, uploadUrl, source: 'sms' })
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
            // Persist as an outbound row so the agent's history reflects it.
            await supabase.from('sms_messages').insert({
              conversation_id: conversationId,
              direction: 'outbound',
              body: photoDispatch.channel === 'whatsapp'
                ? `[WhatsApp fallback] ${photoBody}`
                : photoBody,
              twilio_message_sid: photoDispatch.sid,
            })
            // Stamp the conversation so we don't double-send on a later turn.
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

      // 9. Update conversation: bump turn_count, merge assumptions, set status
      //    based on the dialog agent's decision.
      //    end_conversation: customer wrapped up gracefully without booking.
      //    Status='done', NO intake handoff, NO recovery SMS, NO photo SMS.
      //    Flowing through to step 10 below intake fires only on action='finish'.
      const newStatus =
        decision.action === 'finish' ? 'structuring'
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
      if (decision.action === 'finish') {
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
            const failureFirstName = guessFirstName(turns) ?? customer?.first_name ?? undefined
            const failureBody = buildQuoteFailureSms({ firstName: failureFirstName })
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
