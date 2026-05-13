// /api/onboard/retry-provision — re-runs Twilio + Vapi provisioning for a
// tenant whose first activation persisted the tenant row but failed at
// the external provisioning step (most often: Twilio account not yet
// funded, no AU inventory, or transient API error).
//
// Auth: Bearer <supabase-access-token>, same pattern as /api/tenant/me.
// We resolve the tenant by owner_user_id rather than trusting a client-
// supplied tenant_id so users can only re-provision their own tenant.
//
// Idempotent: if the tenant already has both twilio_sms_number AND
// vapi_assistant_id we short-circuit with the current values. If only
// one is set, runProvisioning finishes the missing half.
//
// Successful response shape mirrors /api/onboard/activate so the client
// can treat the two endpoints interchangeably.

import { createClient } from '@supabase/supabase-js'
import { runProvisioning } from '@/lib/onboard/run-provisioning'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function userFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

export async function POST(req: Request) {
  const user = await userFromBearer(req)
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .select(
      'id, business_name, owner_first_name, owner_mobile, trade, twilio_sms_number, vapi_assistant_id, status',
    )
    .eq('owner_user_id', user.id)
    .maybeSingle()
  if (tErr) {
    return Response.json({ ok: false, error: tErr.message }, { status: 500 })
  }
  if (!tenant) {
    return Response.json({ ok: false, error: 'no_tenant' }, { status: 404 })
  }

  // Fast path: already fully provisioned, just echo the values.
  if (tenant.twilio_sms_number && tenant.vapi_assistant_id) {
    return Response.json({
      ok: true,
      tenantId: tenant.id,
      phoneNumber: tenant.twilio_sms_number,
      vapiAssistantId: tenant.vapi_assistant_id,
      alreadyProvisioned: true,
    })
  }

  const result = await runProvisioning(supabase, {
    tenantId: tenant.id,
    businessName: tenant.business_name,
    trade: (tenant.trade ?? 'electrical') as 'electrical' | 'plumbing',
    ownerFirstName: tenant.owner_first_name ?? 'mate',
    ownerMobile: tenant.owner_mobile ?? '',
    existing: {
      twilioSmsNumber: tenant.twilio_sms_number,
      vapiAssistantId: tenant.vapi_assistant_id,
    },
  })

  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        tenantId: tenant.id,
        phoneNumber: result.phoneNumber,
        vapiAssistantId: result.vapiAssistantId,
        error: result.error ?? 'provisioning_failed',
      },
      { status: 200 }, // 200 so the client UI can read the body without try/catch on res.ok
    )
  }

  return Response.json({
    ok: true,
    tenantId: tenant.id,
    phoneNumber: result.phoneNumber,
    vapiAssistantId: result.vapiAssistantId,
    stubbedTwilio: result.stubbedTwilio,
    stubbedVapi: result.stubbedVapi,
    warning: result.warning,
  })
}
