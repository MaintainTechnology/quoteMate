import { createClient } from '@supabase/supabase-js'
import { isCronAuthorised } from '@/lib/agents/cron'
import { publicWebOrigin } from '@/lib/sms/public-origin'
import { JOB_QUOTE_OPERATION_SCHEMA } from '@/lib/quote/public-schema'

export const dynamic = 'force-dynamic'
const contracts: Record<string, string> = {
  sms_work_jobs: 'id,service_key,owner_token,lease_until,checkpoint,sequence',
  sms_outbox: 'id,turn_id,status,provider_sid,attempt_token',
  sms_frontdesk_jobs: 'id',
  sms_human_tasks: 'id,tenant_id,resource_type,resource_id,status',
  sms_messages: 'id,delivery_status,outbox_id,turn_id',
  sms_conversations: 'id,processing_owner,quote_stage,quote_id,last_processed_work_sequence',
  intakes: 'id,sms_source_key',
  quote_pricing_versions: 'id,tenant_id,trade,pricing_book_id,content_hash,snapshot',
  job_quote_operations: JOB_QUOTE_OPERATION_SCHEMA,
  quotes: 'id,share_token,estimate_request_key,inspection_cause,quote_kind,parent_quote_id,customer_released_at,sent_at,pricing_book_version_id',
  roofing_measurements: 'id,public_token,released_at,source_request_key',
  painting_measurements: 'id,public_token,released_at,source_request_key',
  solar_estimates: 'id,public_token,confirmed_at,source_request_key',
  plan_extractions: 'id,share_token,released_at,sms_source_key',
  plan_upload_requests: 'id,input_sha256,analysis_work_id',
  aircon_recommendations: 'id,public_token,released_at',
  paint_runs: 'id,public_token,released_at,customer_phone',
}
/** Read-only schema probe. Liveness is separate; no model, quote or SMS is created. */
export async function GET(req: Request) {
  if (!isCronAuthorised(req)) return new Response('unauthorised', { status: 401 })
  let origin: string
  try { origin = publicWebOrigin() } catch { return Response.json({ ready: false, failure: 'public_origin' }, { status: 503 }) }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false }, global: { fetch: (input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(4000)}) },
  })
  const checks = await Promise.all(Object.entries(contracts).map(async ([table,columns])=>{
    try { const {error} = await db.from(table).select(columns).limit(0); return {table,ok:!error,code:error?.code ?? null} }
    catch { return {table,ok:false,code:'dependency_unavailable'} }
  }))
  for (const [name,rpc] of [
    ['owned_quote_revision_contract','sms_owned_quote_revision_contract'],
    ['commercial_quote_guard','sms_commercial_quote_guard_ready'],
    ['plan_quote_guard','sms_plan_quote_guard_ready'],
    ['quote_chain','sms_quote_chain_ready'],
  ]) {
    try {
      const { data, error } = await db.rpc(rpc)
      checks.push({ table: name, ok: !error && data === true, code: error?.code ?? null })
    } catch { checks.push({ table: name, ok: false, code: 'dependency_unavailable' }) }
  }
  const ready = checks.every(check=>check.ok)
  return Response.json({ ready, checks, publicOrigin: origin, requiredMigrations: [198,199,200,201,202,204,205,207,210,211,212,213,214,215,217,218,219,220,221],
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? 'unverified-local',
    workflowEvidence: 'Controlled tenant, service and provider workflow checks are separate release gates.' }, { status: ready ? 200 : 503 })
}
