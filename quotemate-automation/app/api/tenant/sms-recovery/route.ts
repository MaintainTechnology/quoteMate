import { createClient } from '@supabase/supabase-js'
import { resolveTenantRequest } from '@/lib/tenant/from-request'

export const dynamic = 'force-dynamic'
function database() { return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }) }
export async function GET(req: Request) {
  const db = database()
  const tenant = (await resolveTenantRequest(db, req, 'id'))?.tenant
  if (!tenant?.id) return Response.json({ error: 'unauthorised' }, { status: 401 })
  const [jobs, tasks] = await Promise.all([
    db.from('sms_work_jobs').select('id,kind,service_key,status,attempts,created_at,updated_at,last_error').eq('tenant_id', tenant.id)
      .in('status', ['pending','running','retry','failed']).order('created_at',{ascending:false}).limit(100),
    db.from('sms_human_tasks').select('id,trade,reason,resource_type,resource_id,status,customer_phone,notification_error,created_at')
      .eq('tenant_id',tenant.id).neq('status','resolved').order('created_at',{ascending:false}).limit(100),
  ])
  if (jobs.error || tasks.error) return Response.json({ error: 'Enquiry recovery is temporarily unavailable' }, { status: 503 })
  return Response.json({ jobs: jobs.data, tasks: tasks.data })
}
export async function POST(req: Request) {
  const db = database()
  const tenant = (await resolveTenantRequest(db, req, 'id'))?.tenant
  if (!tenant?.id) return Response.json({ error: 'unauthorised' }, { status: 401 })
  const body = await req.json().catch(()=>null)
  if (!body || typeof body.id !== 'string') return Response.json({ error: 'Choose an enquiry' }, { status: 400 })
  if (body.action === 'retry') {
    const { data, error } = await db.from('sms_work_jobs').update({ status: 'retry', attempts: 0, available_at: new Date().toISOString(),
      owner_token: null, lease_until: null, last_error: 'Retry requested by authenticated tenant owner', updated_at: new Date().toISOString() })
      .eq('id', body.id).eq('tenant_id',tenant.id).eq('status','failed').neq('service_key','retired-platform').select('id').maybeSingle()
    if (error) return Response.json({ error: 'Retry could not be saved' }, { status: 503 })
    if (!data) return Response.json({ error: 'This enquiry is not a failed job belonging to your account' }, { status: 409 })
    return Response.json({ ok: true, stage: 'retry' })
  }
  if (body.action === 'resolve') {
    const { data,error } = await db.from('sms_human_tasks').update({ status:'resolved',updated_at:new Date().toISOString() })
      .eq('id',body.id).eq('tenant_id',tenant.id).select('id').maybeSingle()
    if (error) return Response.json({error:'Task could not be updated'},{status:503})
    if (!data) return Response.json({error:'Task not found'},{status:404})
    return Response.json({ok:true})
  }
  return Response.json({ error: 'Unknown recovery action' }, { status: 400 })
}
