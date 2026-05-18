// POST /api/tenant/followups/call
//
// Click-to-call bridge. We ring the TRADIE's own mobile first; when they
// answer, Twilio fetches our signed bridge TwiML which dials the customer
// with caller-ID = the tenant's provisioned Twilio number. The customer
// sees the business calling, never the VA's personal phone.
//
// Destination is resolved server-side from quoteId. The bridge URL is
// HMAC-signed (lib/twilio/voice) so the public TwiML endpoint can't be
// abused to dial arbitrary numbers.

import { createClient } from '@supabase/supabase-js'
import { resolveFollowupTarget } from '@/lib/quote/followup-contact'
import { normaliseAuMobile } from '@/lib/phone/au'
import { friendlyCallError } from '@/lib/sms/twilio-error'
import { placeBridgeCall, signBridge } from '@/lib/twilio/voice'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const E164 = /^\+\d{8,15}$/

async function tenantFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, business_name, twilio_voice_number, owner_mobile')
    .eq('owner_user_id', data.user.id)
    .maybeSingle()
  return (
    (tenant as {
      id: string
      business_name: string
      twilio_voice_number: string | null
      owner_mobile: string | null
    } | null) ?? null
  )
}

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: { quoteId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const quoteId = typeof body.quoteId === 'string' ? body.quoteId : null
  if (!quoteId) {
    return Response.json({ ok: false, error: 'quoteId is required' }, { status: 400 })
  }

  // Caller-ID = tenant's provisioned Twilio number (must be E.164).
  const callerId = (tenant.twilio_voice_number ?? '').trim()
  if (!E164.test(callerId)) {
    return Response.json(
      { ok: false, code: 'NO_VOICE_NUMBER', message: friendlyCallError('NO_VOICE_NUMBER') },
      { status: 409 },
    )
  }
  // First leg rings the tradie's own mobile.
  const tradieE164 = normaliseAuMobile(tenant.owner_mobile)
  if (!tradieE164) {
    return Response.json(
      { ok: false, code: 'NO_TRADIE_NUMBER', message: friendlyCallError('NO_TRADIE_NUMBER') },
      { status: 409 },
    )
  }

  const target = await resolveFollowupTarget(supabase, quoteId, tenant.id)
  if (!target.ok) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }
  const customerE164 = normaliseAuMobile(target.phone)
  if (!customerE164) {
    return Response.json(
      {
        ok: false,
        code: 'BAD_NUMBER',
        message: "We don't have a valid Australian mobile on file for this customer.",
      },
      { status: 422 },
    )
  }

  const secret = process.env.TWILIO_AUTH_TOKEN
  const appUrl = process.env.APP_URL
  if (!secret || !appUrl) {
    return Response.json(
      { ok: false, code: 'NO_CREDS', message: friendlyCallError('NO_CREDS') },
      { status: 500 },
    )
  }

  const sig = signBridge(customerE164, callerId, secret)
  const twimlUrl =
    `${appUrl.replace(/\/$/, '')}/api/twilio/voice/followup-bridge` +
    `?to=${encodeURIComponent(customerE164)}` +
    `&cid=${encodeURIComponent(callerId)}` +
    `&sig=${sig}`

  const result = await placeBridgeCall({
    toTradieE164: tradieE164,
    fromTenantNumberE164: callerId,
    twimlUrl,
  })

  if (!result.ok) {
    console.error('[followups/call] bridge failed', {
      quoteId,
      tenant_id: tenant.id,
      code: result.code,
      reason: result.reason,
    })
    return Response.json(
      { ok: false, code: result.code, message: friendlyCallError(result.code, result.reason) },
      { status: 502 },
    )
  }

  // The tradie's phone is now ringing; when they answer it bridges to the
  // customer. Nothing to log yet — call status lands via Twilio later if
  // we wire status callbacks (out of scope here).
  return Response.json({ ok: true, callSid: result.sid })
}
