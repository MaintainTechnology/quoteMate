// Owner-authenticated retry/resend for an already approved painting quote.
// First approval goes through the saved-snapshot review gate shared by all tools.
import { createClient } from '@supabase/supabase-js'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { sendPaintingQuoteToCustomer } from '@/lib/painting/release'
import { publicWebOrigin } from '@/lib/sms/public-origin'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import type { OutboundOptions } from '@/lib/sms/durable-outbox'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const owner = await resolveTenantRequest(supabase, req, 'id')
  if (!owner?.tenant?.id) return Response.json({ ok: false, error: 'Sign in as the owning tradie before sending.' }, { status: 401 })
  const tenantId = owner.tenant.id as string
  const { token } = await ctx.params
  if (!token || token.length < 8) return Response.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  let body: { resend?: unknown; requestId?: unknown } = {}
  try { body = await req.json() } catch { /* Empty body retains first-send retry contract. */ }
  const resend = body?.resend === true
  if (resend && (typeof body.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.requestId))) {
    return Response.json({ ok: false, error: 'A stable request ID is required to resend.' }, { status: 400 })
  }
  const { data: row, error } = await supabase.from('painting_measurements')
    .select('id,tenant_id,estimate_token,public_token,released_at,quote_sent_at')
    .eq('estimate_token', token).eq('tenant_id', tenantId).maybeSingle()
  if (error) return Response.json({ ok: false, error: 'Saved quote temporarily unavailable.' }, { status: 503 })
  if (!row || row.tenant_id !== tenantId) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  if (!row.released_at) {
    return Response.json({ ok: false, error: 'Review the saved quote before approving it.',
      reviewUrl: `/dashboard/quote-review?family=paint&id=${encodeURIComponent(row.id)}` }, { status: 409 })
  }
  if (row.quote_sent_at && !resend) {
    return Response.json({ ok: true, sent: true, alreadyAccepted: true, released_at: row.released_at, public_token: row.public_token })
  }
  if (!resend) {
    const { data: approvalIntent, error: intentError } = await supabase.from('sms_outbox')
      .select('id,payload').eq('tenant_id',tenantId).eq('delivery_key',`quote-release:paint:${row.id}`).maybeSingle()
    if (intentError) return Response.json({ok:false,error:'Delivery recovery temporarily unavailable.'},{status:503})
    if (approvalIntent) {
      const delivery = await dispatchQuoteMessage(approvalIntent.payload as OutboundOptions)
      return Response.json({ok:true,sent:delivery.ok,approved:true,outboxId:approvalIntent.id,released_at:row.released_at,public_token:row.public_token},
        {status:delivery.ok?200:202})
    }
  }
  const result = await sendPaintingQuoteToCustomer(supabase, { estimateToken: token, tenantId,
    appUrl: publicWebOrigin(), requestId: resend ? body.requestId as string : undefined })
  // Approval survives rejection and ambiguous acceptance. Recovery reuses the
  // durable intent; another click must not revoke a link the customer received.
  return Response.json({ ok: true, ...result, approved: true, released_at: row.released_at, public_token: row.public_token },
    { status: result.sent ? 200 : 202 })
}
