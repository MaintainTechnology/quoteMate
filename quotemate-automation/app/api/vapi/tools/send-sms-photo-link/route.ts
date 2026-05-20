// Vapi server-side tool: `send_sms_photo_link`.
//
// Invoked by the receptionist (Jeff) DURING a live call when it asks the
// customer for photos — e.g. "send a photo of the switchboard". Vapi POSTs
// a tool-call payload to this URL; we send the SMS, then return a short
// natural-language string the model can speak back to the caller.
//
// Idempotent + dedupe-safe:
//   • Upserts the calls row by vapi_call_id (creates it if the call hasn't
//     ended yet — the end-of-call webhook later upserts again, preserving
//     fields we set here because it doesn't include them in its payload).
//   • If `photo_request_sent_at` is already set, returns success WITHOUT
//     re-sending. The model can call the tool multiple times in the same
//     conversation (one per photo subject) and the customer still gets
//     exactly one SMS.
//   • If SMS dispatch fails, photo_request_sent_at is left null so the
//     post-call dispatcher in /api/intake/structure picks up the slack.
//     The tool returns a degraded message the model relays to the caller.

import { createClient } from '@supabase/supabase-js'
import { pipelineLog } from '@/lib/log/pipeline'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { buildPhotoRequestSms } from '@/lib/sms/templates'
import { generateShareToken } from '@/lib/stripe/checkout'

export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// Vapi's tool-calls payload exposes the call info + the array of tool
// invocations the model just made. We only care about extracting the
// toolCallId (to echo back) and the call.id + customer.number to operate on.
type VapiToolCall = { id?: string; toolCallId?: string; function?: { name?: string; arguments?: unknown } }

type VapiToolPayload = {
  message?: {
    type?: string
    toolCallList?: VapiToolCall[]
    toolCalls?: VapiToolCall[]
    call?: {
      id?: string
      customer?: { number?: string }
    }
  }
}

function pickToolCallId(payload: VapiToolPayload): string | null {
  const list = payload.message?.toolCallList ?? payload.message?.toolCalls ?? []
  if (list.length === 0) return null
  return list[0].toolCallId ?? list[0].id ?? null
}

function vapiResult(toolCallId: string | null, result: string) {
  // Vapi's expected response shape for server-side tools.
  return Response.json({
    results: [{ toolCallId: toolCallId ?? 'unknown', result }],
  })
}

// User-facing degraded message the model speaks to the customer when SMS
// can't be sent right now. Falls back to the post-call SMS pathway.
const DEGRADED_RESULT =
  "Photo link couldn't go through right now — the customer will receive it by SMS as soon as the call ends."

const ALREADY_SENT_RESULT =
  "Photo link has already been texted to the customer — they should check their messages."

const SUCCESS_RESULT =
  "Photo link sent — the customer will get an SMS in a few seconds with a tap-to-upload page."

export async function POST(req: Request) {
  const log = pipelineLog('webhook')
  log.step('vapi tool-call: send_sms_photo_link')

  let payload: VapiToolPayload
  try {
    payload = (await req.json()) as VapiToolPayload
  } catch (e) {
    log.err('failed to parse Vapi payload', e)
    return vapiResult(null, DEGRADED_RESULT)
  }

  const toolCallId = pickToolCallId(payload)
  const vapiCallId = payload.message?.call?.id
  const callerNumber = payload.message?.call?.customer?.number ?? null

  if (!vapiCallId) {
    log.err('tool-call missing call.id', null, { has_payload: !!payload.message })
    return vapiResult(toolCallId, DEGRADED_RESULT)
  }
  if (!callerNumber) {
    log.err('tool-call missing customer.number', null, { vapi_call_id: vapiCallId })
    return vapiResult(toolCallId, DEGRADED_RESULT)
  }

  // Upsert the calls row mid-call. Idempotent on vapi_call_id (unique).
  // We deliberately do NOT include transcript / duration / recording_url
  // here — the end-of-call webhook will upsert those later. Likewise we
  // only set photo_request_token if this is the first invocation (the
  // upsert payload omits it on subsequent calls so we don't clobber a
  // previously-issued one — see the find-or-create logic below).

  const { data: existing } = await supabase
    .from('calls')
    .select('id, caller_number, photo_request_token, photo_request_sent_at')
    .eq('vapi_call_id', vapiCallId)
    .maybeSingle()

  if (existing?.photo_request_sent_at) {
    log.ok('photo SMS already sent earlier in this call — skipping', {
      vapi_call_id: vapiCallId,
      sent_at: existing.photo_request_sent_at,
    })
    return vapiResult(toolCallId, ALREADY_SENT_RESULT)
  }

  // Determine the token to put in the SMS. If we have an existing one
  // (from a prior partial state), reuse it; otherwise generate a new one.
  const photoRequestToken = existing?.photo_request_token ?? generateShareToken()

  // Insert-or-update the row so downstream readers can find it.
  const { data: callRow, error: upsertErr } = await supabase
    .from('calls')
    .upsert(
      {
        vapi_call_id: vapiCallId,
        caller_number: callerNumber,
        photo_request_token: photoRequestToken,
      },
      { onConflict: 'vapi_call_id' },
    )
    .select('id')
    .single()

  if (upsertErr || !callRow) {
    log.err('calls upsert failed', upsertErr?.message, { vapi_call_id: vapiCallId })
    return vapiResult(toolCallId, DEGRADED_RESULT)
  }

  // Build + send the SMS using the same template the post-call path uses.
  // First name is unknown mid-call (we haven't structured the intake yet),
  // so the template falls back to "Hi there".
  const appUrl = process.env.APP_URL ?? 'https://quote-mate-rho.vercel.app'
  const uploadUrl = `${appUrl}/upload/${photoRequestToken}`
  const text = buildPhotoRequestSms({ uploadUrl })

  log.step('dispatching in-call photo SMS', { to: callerNumber, call_id: callRow.id })
  const result = await dispatchQuoteMessage({ to: callerNumber, text })

  if (!result.ok) {
    // Don't set photo_request_sent_at — let the post-call fallback retry.
    log.err('in-call photo SMS failed — leaving photo_request_sent_at null for post-call fallback', null, {
      sms_code: result.smsAttempt.code,
      sms_reason: result.smsAttempt.reason,
      wa_code: result.waAttempt?.code,
      wa_reason: result.waAttempt?.reason,
    })
    return vapiResult(toolCallId, DEGRADED_RESULT)
  }

  await supabase
    .from('calls')
    .update({ photo_request_sent_at: new Date().toISOString() })
    .eq('id', callRow.id)

  log.done('in-call photo SMS dispatched', {
    channel: result.channel,
    sid: result.sid,
    call_id: callRow.id,
  })
  return vapiResult(toolCallId, SUCCESS_RESULT)
}
