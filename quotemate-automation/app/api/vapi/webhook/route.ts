import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { pipelineLog } from '@/lib/log/pipeline'
import { generateShareToken } from '@/lib/stripe/checkout'
import { withRetry } from '@/lib/util/retry'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { buildQuoteFailureSms } from '@/lib/sms/templates'

export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Calls with transcripts shorter than this are treated as hangups before
// any usable content was captured — webhook returns 200 to Vapi but does
// not dispatch the chain. Both the photo-request SMS and the quote-with-
// pay-links SMS are suppressed in this branch.
const MIN_TRANSCRIPT_CHARS = 50

export async function POST(req: Request) {
  const log = pipelineLog('webhook')
  log.step('received')

  const payload = await req.json()

  // Vapi sends many event types — status-update, transcript, function-call,
  // hang, end-of-call-report. We only act on end-of-call-report.
  if (payload.message?.type !== 'end-of-call-report') {
    log.ok('event ignored — not end-of-call-report', { event_type: payload.message?.type })
    return Response.json({ ok: true, ignored: payload.message?.type })
  }

  const call = payload.message.call
  if (!call?.id) {
    log.err('end-of-call-report missing call.id')
    return Response.json({ ok: false, error: 'missing call.id' }, { status: 400 })
  }

  // Vapi sends durationSeconds as a float (e.g. 32.053). Our `duration_seconds`
  // column is `int`, so round before inserting.
  const durationSeconds =
    typeof payload.message.durationSeconds === 'number'
      ? Math.round(payload.message.durationSeconds)
      : null

  const transcript = payload.message.transcript ?? null
  const transcriptChars = transcript?.length ?? 0

  // v6 multi-tenant voice routing: identify which tenant owns this call
  // so the downstream pipeline (intake/structure → estimate/draft) uses
  // the right pricing book, posts back to the right tradie, and dispatch
  // SMS from the right number. Two resolution paths in priority order:
  //
  //   1. assistant.metadata.tenant_id — set by lib/vapi/provision.ts when
  //      a fresh tenant's assistant is created. This is the cheapest +
  //      most reliable path.
  //   2. Fallback: assistantId → tenants.vapi_assistant_id lookup. Covers
  //      legacy assistants that pre-date the metadata change.
  //
  // null is acceptable (legacy pre-v6 calls route via the pilot pricing
  // book, same as the SMS-side fallback).
  let tenantId: string | null = null
  const metaTenantId = (call.assistant?.metadata as { tenant_id?: string } | null)?.tenant_id
  if (metaTenantId) {
    tenantId = metaTenantId
  } else if (call.assistantId) {
    const { data: t } = await supabase
      .from('tenants')
      .select('id')
      .eq('vapi_assistant_id', call.assistantId)
      .maybeSingle()
    tenantId = (t?.id as string | null) ?? null
  }

  log.step('upserting calls row', {
    vapi_call_id: call.id,
    caller_number: call.customer?.number ?? 'null',
    transcript_chars: transcriptChars,
    duration_s: durationSeconds ?? 'null',
    tenant_id: tenantId,
    tenant_resolved_from: metaTenantId ? 'metadata' : tenantId ? 'assistant_lookup' : 'none',
  })

  // Upsert (not insert) so Vapi retrying the same end-of-call event is idempotent.
  // The unique constraint on vapi_call_id otherwise fires on retry → null callRow.
  const { data: callRow, error } = await supabase
    .from('calls')
    .upsert(
      {
        vapi_call_id: call.id,
        caller_number: call.customer?.number ?? null,
        duration_seconds: durationSeconds,
        transcript,
        recording_url: payload.message.recordingUrl ?? null,
        ended_at: new Date().toISOString(),
        // Stamp tenant_id so intake/structure (voice path) picks it up
        // and propagates it forward to intakes + quotes.
        tenant_id: tenantId,
      },
      { onConflict: 'vapi_call_id' }
    )
    .select()
    .single()

  if (error || !callRow) {
    log.err('upsert failed', error?.message, { code: error?.code, hint: error?.hint })
    return Response.json(
      { ok: false, error: error?.message ?? 'upsert returned no row' },
      { status: 500 }
    )
  }

  log.ok('calls row upserted', { call_id: callRow.id })

  // Early-skip gate: caller hung up before saying anything meaningful.
  // Skip the entire chain — no SMS, no estimation, no photo prompt.
  if (transcriptChars < MIN_TRANSCRIPT_CHARS) {
    log.ok('transcript too short — skipping chain entirely (no SMS, no estimation)', {
      chars: transcriptChars,
      threshold: MIN_TRANSCRIPT_CHARS,
    })
    log.done('webhook handler done — chain skipped (empty call)', { call_id: callRow.id })
    return Response.json({ ok: true, callId: callRow.id, skipped: 'transcript_too_short' })
  }

  // Generate a one-shot upload token + persist on the call IF NOT ALREADY SET.
  // The in-call `send_sms_photo_link` tool may have created the row mid-call
  // and set its own token + already SMS'd it to the customer. Overwriting
  // here would break the link the customer is about to tap.
  if (!callRow.photo_request_token) {
    const photoRequestToken = generateShareToken()
    await supabase
      .from('calls')
      .update({ photo_request_token: photoRequestToken })
      .eq('id', callRow.id)
    log.ok('photo_request_token generated', { token: photoRequestToken.slice(0, 8) + '…' })
  } else {
    log.ok('photo_request_token already set by in-call tool — preserving', {
      token: callRow.photo_request_token.slice(0, 8) + '…',
    })
  }

  // Dispatch to /api/intake/structure. The intake handler now owns BOTH
  // the photo-request SMS (suppressed when intake quality is empty) and
  // the dispatch to /api/estimate/draft (also suppressed when empty).
  // Webhook used to fire the photo SMS itself; that was moved to keep the
  // gate centralised — a single decision point per call.
  after(async () => {
    const dispatch = pipelineLog('webhook', callRow.id)
    dispatch.step('dispatching to /api/intake/structure (with retry)')
    // Wrapped in withRetry — the entire quote pipeline depends on this
    // POST landing. Silent failure = customer never gets a quote.
    // 3 attempts, 2s/4s backoff, runs in after() so doesn't block webhook ack.
    try {
      await withRetry(
        async () => {
          const res = await fetch(`${process.env.APP_URL}/api/intake/structure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callId: callRow.id }),
          })
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
          }
          return res
        },
        {
          maxAttempts: 3,
          baseDelayMs: 2000,
          onAttemptFailed: (err, attempt, willRetry) => {
            const msg = err instanceof Error ? err.message : String(err)
            const tag = willRetry ? 'retrying' : 'EXHAUSTED'
            dispatch.err(`intake handoff attempt ${attempt}/3 — ${tag}`, msg.slice(0, 200))
          },
        }
      )
      dispatch.ok('intake/structure dispatched')
    } catch (e: any) {
      dispatch.err('intake handoff EXHAUSTED — sending failure SMS to caller', e?.message ?? String(e), { call_id: callRow.id })
      // NEVER leave the caller silent. Send a fallback SMS so they know
      // to expect a callback rather than wondering if their call vanished.
      try {
        const callerNumber = (callRow as { caller_number?: string | null }).caller_number ?? null
        if (!callerNumber) {
          dispatch.err('cannot send failure SMS — no caller_number on call row', null, { call_id: callRow.id })
        } else {
          const failureBody = buildQuoteFailureSms({})
          const failureDispatch = await dispatchQuoteMessage({ to: callerNumber, text: failureBody })
          if (failureDispatch.ok) {
            dispatch.ok('failure SMS dispatched to caller', {
              channel: failureDispatch.channel,
              sid: failureDispatch.sid,
            })
          } else {
            dispatch.err('failure SMS to caller FAILED on both channels', null, {
              sms_code: failureDispatch.smsAttempt.code,
              wa_code: failureDispatch.waAttempt?.code,
            })
          }
        }
      } catch (notifyErr) {
        dispatch.err('failure SMS to caller threw', notifyErr, { call_id: callRow.id })
      }
    }
  })

  log.done('webhook handler done', { call_id: callRow.id })
  return Response.json({ ok: true, callId: callRow.id })
}
