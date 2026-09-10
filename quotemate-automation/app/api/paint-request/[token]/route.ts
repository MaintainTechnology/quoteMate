// Public self-serve painting form — the per-request unique-hash link the SMS
// receptionist offers first (/paint-request/[token]). Token =
// painting_lead_requests.token.
//
//   GET  → form context (business name + whether it's already submitted).
//   POST → validate the painting inputs, run the estimate + save the job,
//          persist a tradie review task, and text the saved draft's status.
//          Only an authenticated tradie can approve sharing the quote.
//
// No auth: the unguessable token IS the capability, exactly like the public
// quote pages. One-shot: a submitted link can't be re-run.

import { createClient } from '@supabase/supabase-js'
import { EstimateRequestSchema } from '@/lib/painting/request-schema'
import { estimateAndDispatchPainting } from '@/lib/sms/painting-estimate-dispatch'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60 // the estimate runs a provider lookup

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const APP_BASE_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.quotemax.com.au'
).replace(/\/$/, '')

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const { data: lead, error: lookupError } = await supabase
    .from('painting_lead_requests')
    .select('token, tenant_id, status')
    .eq('token', token)
    .maybeSingle()
  if (lookupError) return Response.json({ ok: false, error: 'Form temporarily unavailable' }, { status: 503 })
  if (!lead) {
    return Response.json({ ok: false, error: 'Invalid or expired link' }, { status: 404 })
  }
  let businessName: string | null = null
  if (lead.tenant_id) {
    const { data: t } = await supabase
      .from('tenants')
      .select('business_name')
      .eq('id', lead.tenant_id)
      .maybeSingle()
    businessName = (t?.business_name as string | undefined) ?? null
  }
  return Response.json({ ok: true, status: lead.status as string, business_name: businessName })
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  const { data: lead, error: lookupError } = await supabase
    .from('painting_lead_requests')
    .select('token, tenant_id, conversation_id, customer_phone, status')
    .eq('token', token)
    .maybeSingle()
  if (lookupError) return Response.json({ ok: false, error: 'Form temporarily unavailable' }, { status: 503 })
  if (!lead) {
    return Response.json({ ok: false, error: 'Invalid or expired link' }, { status: 404 })
  }
  if ((lead.status as string) === 'submitted') {
    return Response.json({ ok: false, error: 'already_submitted' }, { status: 409 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = EstimateRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const tenantId = (lead.tenant_id as string | null) ?? null
  const customerPhone = (lead.customer_phone as string | null) ?? null

  if (!tenantId || !customerPhone) return Response.json({ ok: false, error: 'Customer and tenant are required' }, { status: 422 })
  const { data: tenant, error: tenantError } = await supabase.from('tenants').select('twilio_sms_number').eq('id',tenantId).maybeSingle()
  if (tenantError || !tenant?.twilio_sms_number) return Response.json({ ok: false, error: 'Messaging setup unavailable' }, { status: 503 })
  const i = parsed.data.inputs
  const convId = (lead.conversation_id as string | null) ?? undefined
  const result = await estimateAndDispatchPainting({ supabase, tenantId, customerPhone, conversationId: convId,
    firstName: null, baseUrl: APP_BASE_URL, requestKey: `paint-form:${token}`,
    slots: { address: parsed.data.address.address, postcode: parsed.data.address.postcode, state: parsed.data.address.state,
      address_confirmed: true, scopes: i.scopes, coats: i.coats, condition: i.condition,
      ceiling_height: i.ceiling_height, storeys: i.storeys ?? 1, colour_change: i.colour_change,
      manual_floor_area_m2: i.manual_floor_area_m2 ?? null },
    sendReply: async (text) => dispatchQuoteMessage({ tenantId,conversationId:convId,
      to:customerPhone,from:tenant.twilio_sms_number,audience:'customer',text,deliveryKey:`paint-form:${token}:status` }),
  })
  if (!result.ok) return Response.json({ ok:false,error:'estimate_failed',reason:result.reason },{status:502})
  if (convId) {
    const updated = await supabase.from('sms_conversations').update({painting_state:result.state,updated_at:new Date().toISOString()}).eq('id',convId)
    if (updated.error) return Response.json({ok:false,error:'Conversation state unavailable; request saved'},{status:503})
  }
  const submitted = await supabase.from('painting_lead_requests').update({status:'submitted',submitted_at:new Date().toISOString(),quote_token:result.token}).eq('token',token)
  if (submitted.error) return Response.json({ok:false,error:'Submission state unavailable; retry the same form'},{status:503})
  return Response.json({ok:true,inspection:result.inspection,stage:'awaiting_review',texted:false})
}
