import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: Request) {
  const payload = await req.json()

  // Vapi sends many event types — status-update, transcript, function-call,
  // hang, end-of-call-report. We only act on end-of-call-report.
  if (payload.message?.type !== 'end-of-call-report') {
    return Response.json({ ok: true, ignored: payload.message?.type })
  }

  const call = payload.message.call
  if (!call?.id) {
    console.error('[vapi/webhook] end-of-call-report had no call.id', payload.message)
    return Response.json({ ok: false, error: 'missing call.id' }, { status: 400 })
  }

  // Vapi sends durationSeconds as a float (e.g. 32.053). Our `duration_seconds`
  // column is `int`, so round before inserting.
  const durationSeconds =
    typeof payload.message.durationSeconds === 'number'
      ? Math.round(payload.message.durationSeconds)
      : null

  // Upsert (not insert) so Vapi retrying the same end-of-call event is idempotent.
  // The unique constraint on vapi_call_id otherwise fires on retry → null callRow.
  const { data: callRow, error } = await supabase
    .from('calls')
    .upsert(
      {
        vapi_call_id: call.id,
        caller_number: call.customer?.number ?? null,
        duration_seconds: durationSeconds,
        transcript: payload.message.transcript ?? null,
        recording_url: payload.message.recordingUrl ?? null,
        ended_at: new Date().toISOString(),
      },
      { onConflict: 'vapi_call_id' }
    )
    .select()
    .single()

  if (error || !callRow) {
    console.error('[vapi/webhook] failed to upsert call row:', {
      message: error?.message,
      code: error?.code,
      details: error?.details,
      hint: error?.hint,
      vapi_call_id: call.id,
    })
    return Response.json(
      { ok: false, error: error?.message ?? 'upsert returned no row' },
      { status: 500 }
    )
  }

  // Fire-and-forget hand-off to the Intake Engine. Don't await — Vapi expects
  // a fast response from the webhook, and a slow downstream call shouldn't
  // make Vapi mark the webhook as failed.
  fetch(`${process.env.APP_URL}/api/intake/structure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId: callRow.id }),
  }).catch((e) => {
    console.error('[vapi/webhook] failed to dispatch intake/structure:', e)
  })

  return Response.json({ ok: true, callId: callRow.id })
}
