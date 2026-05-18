// POST /api/tenant/followups/text
//
// VA composes a follow-up SMS in the dashboard modal → it is sent from
// the TENANT's provisioned Twilio number to the customer (never the VA's
// personal phone). On success the message is logged into the customer's
// SMS conversation so a reply re-engages the AI dialog automatically
// (the inbound webhook matches by from_number → continues the thread).
//
// Auth mirrors /api/tenant/followups. Destination is resolved server-side
// from the quoteId (see lib/quote/followup-contact) — never trusted from
// the request body.

import { createClient } from '@supabase/supabase-js'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { resolveFollowupTarget } from '@/lib/quote/followup-contact'
import { normaliseAuMobile } from '@/lib/phone/au'
import { friendlyTwilioError } from '@/lib/sms/twilio-error'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const MAX_LEN = 640 // ~4 SMS segments — generous, still bounded

async function tenantFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, business_name, twilio_sms_number')
    .eq('owner_user_id', data.user.id)
    .maybeSingle()
  return (tenant as { id: string; business_name: string; twilio_sms_number: string | null } | null) ?? null
}

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: { quoteId?: unknown; text?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const quoteId = typeof body.quoteId === 'string' ? body.quoteId : null
  const text =
    typeof body.text === 'string' ? body.text.trim().slice(0, MAX_LEN) : ''
  if (!quoteId) {
    return Response.json({ ok: false, error: 'quoteId is required' }, { status: 400 })
  }
  if (!text) {
    return Response.json(
      { ok: false, code: 'EMPTY', message: 'Type a message before sending.' },
      { status: 400 },
    )
  }

  // No SMS sender provisioned for this tenant → clear, actionable 409.
  if (!tenant.twilio_sms_number) {
    return Response.json(
      {
        ok: false,
        code: 'NO_FROM',
        message: friendlyTwilioError('NO_FROM'),
      },
      { status: 409 },
    )
  }

  const target = await resolveFollowupTarget(supabase, quoteId, tenant.id)
  if (!target.ok) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const toE164 = normaliseAuMobile(target.phone)
  if (!toE164) {
    return Response.json(
      {
        ok: false,
        code: 'BAD_NUMBER',
        message: "We don't have a valid Australian mobile on file for this customer.",
      },
      { status: 422 },
    )
  }

  const result = await dispatchQuoteMessage({
    to: toE164,
    text,
    from: tenant.twilio_sms_number,
  })

  if (!result.ok) {
    const code = result.smsAttempt?.code
    console.error('[followups/text] send failed', {
      quoteId,
      tenant_id: tenant.id,
      sms_code: code,
      wa_code: result.waAttempt?.code,
    })
    return Response.json(
      {
        ok: false,
        code,
        message: friendlyTwilioError(code, result.smsAttempt?.reason),
      },
      { status: 502 },
    )
  }

  // ── Best-effort: thread into the customer's SMS conversation so a
  //    reply re-engages the AI (inbound matches by from_number) and the
  //    dashboard Chats history stays continuous. Never fail the send
  //    response because logging hiccuped. ──
  try {
    const { data: prior } = await supabase
      .from('sms_conversations')
      .select('id')
      .eq('from_number', toE164)
      .eq('tenant_id', tenant.id)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    let conversationId = prior?.id as string | undefined
    const nowIso = new Date().toISOString()
    if (conversationId) {
      await supabase
        .from('sms_conversations')
        .update({ status: 'open', last_message_at: nowIso, updated_at: nowIso })
        .eq('id', conversationId)
    } else {
      const { data: created } = await supabase
        .from('sms_conversations')
        .insert({
          from_number: toE164,
          to_number: tenant.twilio_sms_number,
          tenant_id: tenant.id,
          conversation_type: 'customer_quote',
          status: 'open',
          last_message_at: nowIso,
        })
        .select('id')
        .single()
      conversationId = created?.id as string | undefined
    }
    if (conversationId) {
      await supabase.from('sms_messages').insert({
        conversation_id: conversationId,
        direction: 'outbound',
        body: text,
        twilio_message_sid: result.sid,
      })
    }
  } catch (e) {
    console.error('[followups/text] thread-logging failed (send still OK)', e)
  }

  return Response.json({ ok: true, channel: result.channel, sid: result.sid })
}
