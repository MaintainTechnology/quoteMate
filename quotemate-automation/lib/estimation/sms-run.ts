// The SMS estimator's async analysis pipeline (migration 104).
//
// Claimed by the durable platform worker once the PDF is
// stored and the plan_upload_requests row is 'analysing'. Reuses the exact
// dashboard estimator pieces — runExtraction (lib/estimation/extract),
// priceTakeoff + loadElectricalPricingContext (the same grounded pricer the
// /api/tenant/estimator/price route uses) — no forked extraction path.
//
//   download plan.pdf → runExtraction → plan_extractions (+share_token)
//   → auto-price → priced_bom → Gotenberg report.pdf (best-effort)
//   → durable tradie review task → request complete → awaiting-approval SMS
//
// Failures remain in the request and durable work recovery queue. Saved model
// results and the unique extraction are reused after process loss.

import { createClient } from '@supabase/supabase-js'
import { randomBytes, createHash } from 'node:crypto'
import { runExtraction, type ExtractionItem } from './extract'
import type { PricedBom } from './price'
import { loadElectricalPricingContext, priceElectricalTakeoff } from './pricing-context'
import { buildPlanReportHtml } from './report-html'
import { loadTenantBranding } from '@/lib/pdf/branding'
import { planResultsUrl } from '@/lib/sms/plan-estimation'
import { downloadPlanPdf, uploadPlanPdf } from '@/lib/storage/plan-pdf'
import { renderPdfFromHtml, gotenbergConfigured } from '@/lib/pdf/gotenberg'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { enqueueOutbound } from '@/lib/sms/durable-outbox'
import { persistHumanHandoff } from '@/lib/sms/human-handoff'
import { assertSmsWorkOwnership, currentSmsWork, smsWorkCheckpoint, withFencedSmsClient } from '@/lib/sms/durable-work'

const supabase = withFencedSmsClient(createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
))

type RequestRow = {
  id: string
  token: string
  tenant_id: string
  sms_conversation_id: string | null
  customer_phone: string
  twilio_number: string | null
  status: string
  plan_upload_id: string | null
  plan_extraction_id?: string | null
  input_sha256?: string | null
  analysis_work_id?: string | null
}

async function updateRequest(req: RequestRow, patch: Record<string, unknown>) {
  let query = supabase
    .from('plan_upload_requests')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', req.id)
  if (req.input_sha256) query=query.eq('input_sha256',req.input_sha256)
  const {data,error}=await query.select('id').maybeSingle()
  if (error || !data) throw new Error('Plan request progress could not be saved')
}

/** Best-effort first name for the SMS greeting. */
async function customerFirstName(phone: string, tenantId: string): Promise<string | null> {
  const { data } = await supabase
    .from('customers')
    .select('first_name')
    .eq('phone_number', phone)
    .eq('tenant_id', tenantId)
    .limit(1)
    .maybeSingle()
  return (data?.first_name as string | null) ?? null
}

/** Queue a customer status update from the number that received this request. */
async function smsCustomer(req: RequestRow, body: string) {
  if (!req.twilio_number) throw new Error('Plan request tenant sender missing')
  const result = await dispatchQuoteMessage({
    to: req.customer_phone,
    text: body,
    from: req.twilio_number,
    tenantId: req.tenant_id,
    conversationId: req.sms_conversation_id,
    deliveryKey: `plan:${req.id}:${createHash('sha256').update(body).digest('hex')}`,
  })
  if (result.ok) {
    console.log('[sms-run] customer message sent', {
      requestId: req.id,
      channel: result.channel,
      mms: 'mms' in result ? result.mms : false,
      mediaDropped: 'mediaDropped' in result ? result.mediaDropped : false,
    })
    if (req.sms_conversation_id && !result.outboxId) {
      await supabase.from('sms_messages').insert({
        conversation_id: req.sms_conversation_id,
        direction: 'outbound',
        body,
        twilio_message_sid: result.sid,
      })
      await supabase
        .from('sms_conversations')
        .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', req.sms_conversation_id)
    }
  } else {
    console.error('[sms-run] customer message failed', { requestId: req.id, ...result.smsAttempt })
  }
  return result
}

export async function runSmsPlanAnalysis(requestId: string, inputHash?: string): Promise<void> {
  const { data: req, error: requestError } = await supabase
    .from('plan_upload_requests')
    .select('id, token, tenant_id, sms_conversation_id, customer_phone, twilio_number, status, plan_upload_id, plan_extraction_id, input_sha256, analysis_work_id')
    .eq('id', requestId)
    .maybeSingle<RequestRow>()
  if (requestError || !req) throw new Error('Saved plan request unavailable')
  if (inputHash && (req.input_sha256!==inputHash || req.analysis_work_id!==currentSmsWork()?.jobId)) throw new Error('Plan input version or work ownership mismatch')
  if (req.status === 'complete') return // idempotent re-fire
  if (!req.plan_upload_id) throw new Error('Plan request has no saved upload')
  try {

  const [{ data: upload }, { data: tenant }, firstName] = await Promise.all([
    supabase
      .from('plan_uploads')
      .select('id, filename, sheet_hint, pdf_path')
      .eq('id', req.plan_upload_id)
      .maybeSingle(),
    supabase.from('tenants').select('business_name').eq('id', req.tenant_id).maybeSingle(),
    customerFirstName(req.customer_phone, req.tenant_id),
  ])
  const businessName = (tenant?.business_name as string | undefined) ?? 'Your tradie'
  const branding = await loadTenantBranding(supabase, req.tenant_id, 'electrical')

  if (!upload?.pdf_path) throw new Error('Stored PDF missing')
  const sourceKey=`plan:${req.id}:${req.input_sha256 ?? req.plan_upload_id}`
  const saved=await smsWorkCheckpoint('plan:saved-extraction',async()=>{
    const existing=await supabase.from('plan_extractions').select('*')
      .eq('sms_source_key',sourceKey).eq('tenant_id',req.tenant_id).maybeSingle()
    if (existing.error) throw new Error('Could not read saved plan extraction')
    if (existing.data) return existing.data
    if(req.plan_extraction_id){
      const legacy=await supabase.from('plan_extractions').select('*').eq('id',req.plan_extraction_id)
        .eq('tenant_id',req.tenant_id).eq('plan_upload_id',req.plan_upload_id).maybeSingle()
      if(legacy.error || !legacy.data) throw new Error('Previously saved plan extraction unavailable')
      return legacy.data
    }
    const model=await smsWorkCheckpoint('plan:model',async()=>{
      const pdf=await downloadPlanPdf(upload.pdf_path as string)
      await assertSmsWorkOwnership()
      const result=await runExtraction({pdf,sheetHint:(upload.sheet_hint as string|null)??''})
      if (!result.parsed) throw new Error('Model returned no readable take-off')
      return result
    })
    if (!model.parsed) throw new Error('Saved model result is unreadable')
    const {error}=await supabase.from('plan_extractions').upsert({
      sms_source_key:sourceKey,plan_upload_id:req.plan_upload_id,tenant_id:req.tenant_id,
      items:model.parsed.items,sheets_used:model.parsed.sheets_used,overall_note:model.parsed.overall_note||null,
      model:model.model,runtime_seconds:model.runtimeSeconds,share_token:randomBytes(16).toString('hex'),
    },{onConflict:'sms_source_key',ignoreDuplicates:true})
    if (error) throw new Error('Could not save plan extraction')
    const confirmed=await supabase.from('plan_extractions').select('*')
      .eq('sms_source_key',sourceKey).eq('tenant_id',req.tenant_id).single()
    if (confirmed.error || !confirmed.data) throw new Error('Could not confirm saved plan extraction')
    return confirmed.data
  })
  const shareToken=saved.share_token as string
  const extractionId = saved.id as string
  const extraction={parsed:{items:saved.items as ExtractionItem[],sheets_used:saved.sheets_used as string[],overall_note:saved.overall_note as string}}

  // 3. Auto-price through the shared grounded pricer (identical math + data
  //    path to the dashboard's price route).
  const bom=await smsWorkCheckpoint('plan:pricing',async()=>{
  let bom: PricedBom | null = (saved.priced_bom as PricedBom|null)??null
  if (bom || req.plan_extraction_id) return bom
  try {
    const context = await loadElectricalPricingContext(supabase, req.tenant_id)
    const priced = priceElectricalTakeoff(extraction.parsed.items, context)
    // Partial or empty take-offs cannot supply a customer price. Preserve the
    // counts-only outcome until positive-count items have complete owned prices.
    if (!priced.pricingComplete) throw new Error('tenant_pricing_required: incomplete electrical take-off')
    const { data: pricedRun, error: priceError } = await supabase
      .from('plan_extractions')
      .update({ priced_bom: priced, priced_at: new Date().toISOString() })
      .eq('id', extractionId)
      .eq('tenant_id', req.tenant_id)
      .eq('trade', 'electrical')
      .select('id')
      .maybeSingle()
    if (priceError || !pricedRun) throw new Error('Electrical pricing could not be saved')
    bom = priced
  } catch (e) {
    // Pricing is additive — a counts-only result is still a valid outcome.
    console.error('[sms-run] auto-price failed (continuing counts-only)', {
      requestId,
      message: e instanceof Error ? e.message : String(e),
    })
  }
  return bom
  })

  // 4. Gotenberg report PDF (best-effort — the web results page is the
  //    primary surface; the PDF is the traditional-document bonus).
  const reportPath=await smsWorkCheckpoint('plan:report',async()=>{
  let reportPath: string | null = (saved.report_pdf_path as string|null)??null
  if (reportPath) return reportPath
  if (gotenbergConfigured()) {
    try {
      const html = buildPlanReportHtml({
        businessName: branding.businessName,
        branding,
        filename: (upload.filename as string) ?? 'plan.pdf',
        items: extraction.parsed.items as ExtractionItem[],
        sheetsUsed: extraction.parsed.sheets_used,
        overallNote: extraction.parsed.overall_note,
        bom,
      })
      const reportPdf = await renderPdfFromHtml(html)
      reportPath = await uploadPlanPdf({ requestId: `${req.id}/${req.input_sha256 ?? req.plan_upload_id}`, kind: 'report', data: reportPdf })
      const {error:reportError}=await supabase
        .from('plan_extractions')
        .update({ report_pdf_path: reportPath })
        .eq('id', extractionId)
        .eq('tenant_id', req.tenant_id)
      if (reportError) throw new Error('Could not save plan report')
    } catch (e) {
      console.error('[sms-run] report PDF failed (continuing without)', {
        requestId,
        message: e instanceof Error ? e.message : String(e),
      })
      reportPath = null
    }
  } else {
    console.warn('[sms-run] GOTENBERG_URL not set — skipping report PDF')
  }
  return reportPath
  })

  // Save owner review before promising it. Priced reports remain internal until
  // explicit approval; even a signed storage URL would bypass the public gate.
  await persistHumanHandoff({
    supabase, tenantId: req.tenant_id, customerPhone: req.customer_phone,
    conversationId: req.sms_conversation_id ?? undefined,
    requestKey: `plan:${extractionId}:review`, trade: 'electrical',
    reason: 'Plan take-off is ready for review and approval', resourceType: 'plan', resourceId: extractionId,
  })
  const lineCount = extraction.parsed.items.length
  const deviceCount = extraction.parsed.items.reduce((sum, it) => sum + it.count, 0)
  const body = await smsWorkCheckpoint('plan:customer-body',async()=>`${firstName ? `Hi ${firstName}, your` : 'Your'} plan take-off has been saved for ${businessName} to review and approve. Your quote is awaiting approval: ${planResultsUrl(shareToken)}`)
  // Queue before marking complete: a process loss cannot skip the result notification.
  if (!req.twilio_number) throw new Error('Plan request tenant sender missing')
  await enqueueOutbound({ to: req.customer_phone, from: req.twilio_number,
    text: body, tenantId: req.tenant_id, conversationId: req.sms_conversation_id,
    deliveryKey: `plan:${req.id}:${createHash('sha256').update(body).digest('hex')}` })
  await updateRequest(req, { status: 'complete', error: null, plan_extraction_id: extractionId })
  await smsCustomer(req, body)
  console.log('[sms-run] complete', { requestId, extractionId, lineCount, deviceCount, priced: !!bom, report: !!reportPath })
  } catch(error) {
    await updateRequest(req,{status:'failed',error:(error instanceof Error?error.message:String(error)).slice(0,500)})
    throw error
  }
}
