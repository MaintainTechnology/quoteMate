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
import { buildPhotoRequestSms } from '@/lib/sms/templates'

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
function guessFirstName(turns: ConversationTurn[]): string | undefined {
  const inbound = turns.filter(t => t.direction === 'inbound')
  for (const t of inbound) {
    const trimmed = t.body.trim()
    // 1-3 words, only letters + spaces + hyphens (Anne-Marie OK), no digits
    if (
      /^[A-Za-z][A-Za-z\- ]{0,30}$/.test(trimmed) &&
      trimmed.split(/\s+/).length <= 3 &&
      !/^(hi|hey|yo|ok|okay|yes|yeah|nope|no|cheers|ta|bondi|sydney|melbourne)$/i.test(trimmed)
    ) {
      return trimmed.split(/\s+/)[0]
    }
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
      return new Response('ok (duplicate ignored)', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
  }

  console.log('[sms/inbound] step 3 — looking up conversation', { fromNumber })
  // 3. Find an open conversation with this customer, or create one.
  const { data: existing, error: lookupErr } = await supabase
    .from('sms_conversations')
    .select('*')
    .eq('from_number', fromNumber)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lookupErr) {
    console.error('[sms/inbound] conversation lookup failed', lookupErr)
    return new Response('DB error', { status: 500 })
  }

  let conversation = existing
  if (!conversation) {
    // Generate a photo-upload token at creation time. Voice agent does the
    // same on the calls row; this keeps the /upload/[token] surface
    // identical regardless of source. Token is 32 hex chars (128 bits)
    // — unguessable, partial-unique enforced at the DB level (migration 005).
    const photoToken = randomBytes(16).toString('hex')
    const { data: created, error: createErr } = await supabase
      .from('sms_conversations')
      .insert({
        from_number: fromNumber,
        to_number: toNumber,
        status: 'open',
        photo_request_token: photoToken,
      })
      .select()
      .single()
    if (createErr || !created) {
      console.error('[sms/inbound] conversation create failed', createErr)
      return new Response('DB error', { status: 500 })
    }
    conversation = created
  }

  // 4a. If this is an MMS, fetch the media from Twilio and upload to our
  //     intake-photos bucket BEFORE persisting the inbound row, so the
  //     resulting signed URLs land on the same row.
  let inboundPhotoUrls: string[] = []
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
  })
  if (insertErr) {
    if (insertErr.code === '23505') {
      console.warn('[sms/inbound] race lost — duplicate MessageSid landed concurrently', {
        messageSid,
        conversationId: conversation.id,
      })
      return new Response('ok (duplicate ignored)', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    console.error('[sms/inbound] inbound persist failed', insertErr)
    return new Response('DB error', { status: 500 })
  }

  // ─────── Fast-ack the webhook ───────
  // Everything below — Haiku call, Twilio outbound, conversation update,
  // intake handoff — runs after the 200 is returned. This keeps the
  // webhook latency under ~500ms regardless of how long Haiku takes,
  // which eliminates the duplicate-reply class of bug entirely.
  const conversationId = conversation.id
  const initialAssumptions = (conversation.assumptions_made as string[] | null) ?? []
  const initialTurnCount = conversation.turn_count
  // Photo-request state — passed into after() so we can decide whether
  // to fire the upload-link SMS (parallel to Haiku's reply, only on the
  // first turn that identifies an easy-5 job_type, never twice).
  const photoRequestToken = conversation.photo_request_token as string | null
  const photoRequestAlreadySent = !!conversation.photo_request_sent_at

  after(async () => {
    try {
      console.log('[sms/inbound:after] step 5 — loading conversation history', { conversationId })
      // 5. Load the full message history (oldest first) — including the inbound
      //    we just persisted, so the agent sees the customer's latest message
      //    as the most recent turn.
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

      console.log('[sms/inbound:after] step 6 — calling Haiku dialog agent', {
        turnCount: turns.length,
        inboundCount,
      })
      // 6. Ask Haiku what to do next — ask | finish | escalate_inspection.
      let decision: Awaited<ReturnType<typeof decideNextTurn>>
      try {
        decision = await decideNextTurn({ history: turns, inboundCount })
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
      const shouldSendPhotoRequest =
        photoRequestToken &&
        !photoRequestAlreadySent &&
        EASY_5_JOB_TYPES.has(decision.job_type_guess) &&
        decision.action !== 'escalate_inspection'

      if (shouldSendPhotoRequest) {
        console.log('[sms/inbound:after] step 8b — dispatching photo-request SMS', {
          conversationId,
          jobType: decision.job_type_guess,
        })
        try {
          const appUrl = process.env.APP_URL ?? 'https://quote-mate-rho.vercel.app'
          const uploadUrl = `${appUrl}/upload/${photoRequestToken}`
          // Customer's first name is best-effort — Opus will recover it from
          // the transcript later regardless. Pull from the most recent
          // inbound turn that looks like a name (1-3 words, mostly letters)
          // OR fall back to a generic greeting.
          const firstName = guessFirstName(turns)
          const photoBody = buildPhotoRequestSms({ firstName, uploadUrl })
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
      const newStatus =
        decision.action === 'finish' ? 'structuring'
      : decision.action === 'escalate_inspection' ? 'done'
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
      if (decision.action === 'finish') {
        console.log('[sms/inbound:after] step 10 — firing intake/structure handoff', { conversationId })
        fetch(`${process.env.APP_URL}/api/intake/structure`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId,
            sourceChannel: 'sms',
          }),
        }).catch(e => console.error('[sms/inbound:after] intake handoff failed', e))
      }
    } catch (e: any) {
      console.error('[sms/inbound:after] UNHANDLED in after()', {
        message: e?.message,
        name: e?.name,
        stack: e?.stack?.split('\n').slice(0, 6).join('\n'),
      })
    }
  })

  console.log('[sms/inbound] step 11 — returning 200 OK (work continues in after())')
  return new Response('ok', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })
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
