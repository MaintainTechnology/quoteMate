// Store immutable input, then atomically persist upload metadata and a platform
// work receipt before acknowledging. The scheduled worker owns model execution.
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { uploadPlanPdf } from '@/lib/storage/plan-pdf'
import { internalWorkPayload } from '@/lib/sms/durable-work'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60
const MAX_PDF_BYTES = 32 * 1024 * 1024
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const { data: request, error } = await supabase.from('plan_upload_requests')
    .select('id,tenant_id,status,expires_at').eq('token',token).maybeSingle()
  if (error) return Response.json({ok:false,error:'Upload service is temporarily unavailable. Please retry.'},{status:503})
  if (!request) return Response.json({ok:false,error:'Invalid or expired link'},{status:404})
  if (new Date(request.expires_at).getTime()<Date.now()) return Response.json({ok:false,error:'This link has expired — text us for a fresh one'},{status:410})
  if (request.status==='complete') return Response.json({ok:true,alreadyDone:true})
  let form: FormData
  try { form=await req.formData() } catch { return Response.json({ok:false,error:'Bad request'},{status:400}) }
  const file=form.get('pdf')
  if (!(file instanceof File)) return Response.json({ok:false,error:'No PDF in upload'},{status:400})
  if (file.type && file.type!=='application/pdf') return Response.json({ok:false,error:'File must be a PDF'},{status:400})
  if (file.size>MAX_PDF_BYTES) return Response.json({ok:false,error:'PDF too large; maximum 32 MB'},{status:413})
  const bytes=new Uint8Array(await file.arrayBuffer())
  if (Buffer.from(bytes.subarray(0,5)).toString()!=='%PDF-') return Response.json({ok:false,error:'File must contain a PDF'},{status:400})
  const inputHash=createHash('sha256').update(bytes).digest('hex')
  let pdfPath: string
  try { pdfPath=await uploadPlanPdf({requestId:`${request.id}/${inputHash}`,kind:'plan',data:bytes}) }
  catch { return Response.json({ok:false,error:'Storage write failed — try again'},{status:503}) }
  const result=await supabase.rpc('submit_sms_plan',{
    p_request:request.id,p_hash:inputHash,p_filename:file.name||'plan.pdf',p_size:file.size,p_path:pdfPath,
    p_payload:internalWorkPayload('/internal/plan-analysis',{requestId:request.id,inputHash}),
  })
  if (result.error || !result.data?.id) {
    const conflict=result.error?.code==='55000'
    return Response.json({ok:false,error:conflict?'A plan is already saved for this link. Its progress is available to your tradie.':'Your upload could not be queued. Please retry.'},{status:conflict?409:503})
  }
  if (result.data.status==='failed') return Response.json({ok:false,jobId:result.data.id,error:'Your saved plan needs your tradie’s attention. Please contact them.'},{status:409})
  return Response.json({ok:true,jobId:result.data.id,stage:result.data.status},{status:202})
}
