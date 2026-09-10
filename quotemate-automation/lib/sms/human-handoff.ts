import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchQuoteMessage } from './dispatch'
import { publicWebOrigin } from './public-origin'

/** A customer-facing promise is allowed only AFTER this task exists.
 * Notification failure keeps the task open and visible for operator recovery.
 */
export async function persistHumanHandoff(args: {
  supabase: SupabaseClient; tenantId: string; customerPhone: string; requestKey: string
  conversationId?: string; trade: string; reason: string; resourceType?: string; resourceId?: string
  baseUrl?: string
}): Promise<{ id: string; notified: boolean }> {
  const payload = { tenant_id: args.tenantId, customer_phone: args.customerPhone,
    conversation_id: args.conversationId ?? null, request_key: args.requestKey,
    trade: args.trade, reason: args.reason, resource_type: args.resourceType ?? null, resource_id: args.resourceId ?? null }
  const { error: insertError } = await args.supabase.from('sms_human_tasks')
    .upsert(payload, { onConflict: 'tenant_id,request_key', ignoreDuplicates: true })
  if (insertError) throw new Error('Could not persist review task')
  const { data: task, error } = await args.supabase.from('sms_human_tasks').select('id,status')
    .eq('tenant_id', args.tenantId).eq('request_key', args.requestKey).single()
  if (error || !task?.id) throw new Error('Could not confirm saved review task')
  if (task.status === 'notified' || task.status === 'resolved') return { id: task.id, notified: true }
  const { data: tenant, error: tenantError } = await args.supabase.from('tenants')
    .select('owner_mobile,twilio_sms_number').eq('id', args.tenantId).single()
  let notified = false
  let failure = tenantError || !tenant?.owner_mobile ? 'Owner contact unavailable' : null
  if (!failure) {
    try {
      const result = await dispatchQuoteMessage({
        to: tenant!.owner_mobile, from: tenant!.twilio_sms_number ?? undefined, audience: 'tradie',
        tenantId: args.tenantId, deliveryKey: `human-task:${task.id}:notify`,
        text: `${args.trade} customer request needs your review: ${args.reason.slice(0, 220)}. Customer ${args.customerPhone}. Open ${publicWebOrigin({ ...process.env, APP_URL: args.baseUrl ?? process.env.APP_URL })}/dashboard/sms-recovery`,
      })
      notified = result.ok
      if (!notified) failure = 'Owner notification not accepted; task remains open'
    } catch { failure = 'Owner notification unavailable; task remains open' }
  }
  const { data: updated, error: updateError } = await args.supabase.from('sms_human_tasks').update({
    status: notified ? 'notified' : 'open', notification_error: failure,
    notified_at: notified ? new Date().toISOString() : null, updated_at: new Date().toISOString(),
  }).eq('id', task.id).eq('tenant_id', args.tenantId).eq('status', 'open').select('id,status').maybeSingle()
  if (updateError) throw new Error('Could not persist review notification status')
  if (updated?.id) return { id: updated.id, notified: updated.status === 'notified' }
  // The owner may resolve the task while carrier acknowledgement is in flight.
  // Preserve that terminal state and confirm the row still exists before success.
  const latest = await args.supabase.from('sms_human_tasks').select('id,status')
    .eq('id', task.id).eq('tenant_id', args.tenantId).single()
  if (latest.error || !latest.data?.id) throw new Error('Could not confirm review task after concurrent update')
  return { id: latest.data.id, notified: ['notified', 'resolved'].includes(latest.data.status) }
}
