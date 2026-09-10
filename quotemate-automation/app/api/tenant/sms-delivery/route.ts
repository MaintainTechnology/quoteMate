import { tenantFromBearer } from '@/lib/estimation/auth'
import { outboxDb } from '@/lib/sms/durable-outbox'
import { genericQuoteReleased, genericQuoteSendKey } from '@/lib/quote/customer-release'

export const runtime = 'nodejs'
export async function GET(request: Request): Promise<Response> {
  const tenant = await tenantFromBearer(request)
  if (!tenant) return Response.json({ error: 'unauthorised' }, { status: 401 })
  const url=new URL(request.url)
  const quoteId=url.searchParams.get('quoteId')?.toLowerCase()
  const requestId=url.searchParams.get('requestId') ?? undefined
  if (requestId && !quoteId) return Response.json({error:'quote_id_required'},{status:400})
  if (quoteId) {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(quoteId)) return Response.json({error:'invalid_quote_id'},{status:400})
    let key:string
    try {key=genericQuoteSendKey(quoteId,requestId)} catch {return Response.json({error:'invalid_request_id'},{status:400})}
    try {
      const db=outboxDb()
      const quote=await db.from('quotes').select('id,tenant_id,status,customer_released_at,sent_at,paid_at')
        .eq('id',quoteId).eq('tenant_id',tenant.id).maybeSingle()
      if(quote.error)return Response.json({error:'delivery_status_unavailable'},{status:503})
      if(!quote.data || quote.data.tenant_id !== tenant.id)return Response.json({error:'not_found'},{status:404})
      const result=await db.from('sms_outbox').select('id,status,provider_sid,provider_status,provider_error,requires_attention,attempts,created_at,updated_at')
        .eq('tenant_id',tenant.id).eq('delivery_key',key).maybeSingle()
      if(result.error)return Response.json({error:'delivery_status_unavailable'},{status:503})
      return Response.json({ok:true,quoteId,requestId:requestId ?? null,
        status:result.data?.status ?? 'not_found',outboxId:result.data?.id ?? null,
        approved:genericQuoteReleased(quote.data),quoteReleasedAt:quote.data.customer_released_at,
        quoteStatus:quote.data.status,message:result.data ?? null,
      },{headers:{'Cache-Control':'private, no-store'}})
    } catch {return Response.json({error:'delivery_status_unavailable'},{status:503})}
  }
  const { data, error } = await outboxDb().from('sms_outbox')
    .select('id,status,body,to_number,audience,provider_sid,provider_status,provider_error,requires_attention,attempts,created_at,updated_at')
    .eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(100)
  if (error) return Response.json({ error: 'delivery_status_unavailable' }, { status: 503 })
  return Response.json({ messages: data })
}
export async function POST(request: Request): Promise<Response> {
  const tenant = await tenantFromBearer(request)
  if (!tenant) return Response.json({ error: 'unauthorised' }, { status: 401 })
  let input: { id?: string }
  try { input = await request.json() } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }) }
  if (!/^[0-9a-f-]{36}$/i.test(input.id ?? '')) return Response.json({ error: 'invalid_id' }, { status: 400 })
  const { data, error } = await outboxDb().rpc('sms_outbox_retry', { p_id: input.id, p_tenant: tenant.id })
  if (error) return Response.json({ error: 'retry_unavailable' }, { status: 503 })
  if (!data) return Response.json({ error: 'This message cannot be retried until its delivery status is resolved, or the recipient has opted out.' }, { status: 409 })
  return Response.json({ ok: true, status: 'retry' })
}
