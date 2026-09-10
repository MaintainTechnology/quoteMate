import type { SupabaseClient } from '@supabase/supabase-js'
import { updateSmsDeliveryContext } from './delivery-context'
import { dispatchQuoteMessage } from './dispatch'
import { persistHumanHandoff } from './human-handoff'
import { attributeSmsWorkTenant } from './durable-work'

/** Replay never recalculates a saved price or changes an authorised lifecycle.
 * Missing conversation projection and review task/status intents are recovered.
 */
export async function resumeSavedSmsQuote(db: SupabaseClient, quoteId: string, intakeId: string) {
  const { data: quote, error } = await db.from('quotes').select('id,tenant_id,status,share_token,customer_released_at')
    .eq('id',quoteId).eq('intake_id',intakeId).single()
  if (error || !quote?.id) throw new Error('Saved quote recovery lookup unavailable')
  await attributeSmsWorkTenant(quote.tenant_id)
  const {data: conversation,error: conversationError} = await db.from('sms_conversations').select('id,from_number,quote_id,quote_stage,status')
    .eq('intake_id',intakeId).eq('tenant_id',quote.tenant_id).maybeSingle()
  if (conversationError) throw new Error('Saved quote conversation lookup unavailable')
  // Quote persistence is the authority after a crash before link-back. Repair
  // only this owned conversation's missing projection; never replace a later
  // quote or move a released/terminal conversation back into review.
  if (conversation && (!conversation.quote_id || conversation.quote_id === quote.id)) {
    const stage = quote.customer_released_at ? 'approved'
      : ['draft','awaiting_tradie_approval'].includes(quote.status) ? 'awaiting_review' : quote.status
    const terminalStages = new Set(['approved','sent','accepted','paid','booked','expired','cancelled','declined','completed'])
    const patch: Record<string, unknown> = {}
    if (!conversation.quote_id) patch.quote_id = quote.id
    if (!terminalStages.has(conversation.quote_stage) && conversation.quote_stage !== stage) patch.quote_stage = stage
    if (['open','structuring'].includes(conversation.status) && !terminalStages.has(conversation.quote_stage)) patch.status = 'done'
    if (Object.keys(patch).length) {
      let repair = db.from('sms_conversations').update(patch).eq('id',conversation.id)
        .eq('tenant_id',quote.tenant_id).eq('intake_id',intakeId)
      for (const column of ['quote_id','quote_stage','status'] as const) {
        repair = conversation[column] == null ? repair.is(column,null) : repair.eq(column,conversation[column])
      }
      const { error: repairError } = await repair
      if (repairError) throw new Error('Saved quote conversation recovery unavailable')
    }
  }
  if (quote.customer_released_at) return { quoteId: quote.id, stage: 'approved' }
  if (!['draft','awaiting_tradie_approval'].includes(quote.status)) return { quoteId: quote.id, stage: quote.status }
  if (quote.status === 'draft') {
    const { data: held,error: holdError } = await db.from('quotes').update({status:'awaiting_tradie_approval'})
      .eq('id',quote.id).eq('status','draft').is('customer_released_at',null).select('id').maybeSingle()
    if (holdError) throw new Error('Saved draft review state unavailable')
    if (!held) return {quoteId:quote.id,stage:'updated_by_owner'}
  }
  const {data:intake,error:intakeError} = await db.from('intakes').select('caller,call_id,trade').eq('id',intakeId).single()
  if (intakeError || !intake) throw new Error('Saved quote customer lookup unavailable')
  let phone = conversation?.from_number ?? intake.caller?.phone ?? null
  if (!phone && intake.call_id) {
    const call = await db.from('calls').select('caller_number').eq('id',intake.call_id).eq('tenant_id',quote.tenant_id).maybeSingle()
    if (call.error) throw new Error('Saved quote call lookup unavailable')
    phone = call.data?.caller_number ?? null
  }
  updateSmsDeliveryContext({tenantId:quote.tenant_id,conversationId:conversation?.id ?? null})
  if (!quote.tenant_id || !phone) throw new Error('Saved quote needs tenant/customer contact recovery')
  await persistHumanHandoff({supabase:db,tenantId:quote.tenant_id,customerPhone:phone,conversationId:conversation?.id,
    requestKey:`quote:${quote.id}:review`,trade:intake.trade ?? 'general',reason:'Review the saved draft before sending it to the customer',resourceType:'generic',resourceId:quote.id})
  const tenant = await db.from('tenants').select('twilio_sms_number').eq('id',quote.tenant_id).single()
  if (tenant.error || !tenant.data?.twilio_sms_number) throw new Error('Saved quote sender unavailable')
  const result = await dispatchQuoteMessage({to:phone,from:tenant.data.twilio_sms_number,tenantId:quote.tenant_id,
    conversationId:conversation?.id,deliveryKey:`quote:${quote.id}:review-status`,
    text:'Your draft is saved and awaiting tradie review. No quote has been sent yet. You can reply here to check its status.'})
  if (!result.ok && !result.outboxId) throw new Error('Saved quote review status could not be queued')
  return {quoteId:quote.id,stage:'awaiting_review'}
}
