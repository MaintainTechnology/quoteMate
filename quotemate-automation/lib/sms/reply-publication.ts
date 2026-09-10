import type { SupabaseClient } from '@supabase/supabase-js'
import type { DispatchResult } from './dispatch'

/** Durable delivery publishes its own accepted transcript atomically. Only
 * legacy injected dispatchers without an outbox need a compatibility write.
 */
export async function recordSmsReply(db: SupabaseClient, conversationId: string, body: string, result: DispatchResult) {
  if (result.outboxId) return
  if (!result.ok) throw new Error('Reply could not be durably queued')
  const { error } = await db.from('sms_messages').insert({ conversation_id: conversationId, direction: 'outbound', body,
    twilio_message_sid: result.sid, delivery_status: ['delivered','read'].includes(result.status) ? 'delivered' : 'accepted' })
  if (error) throw new Error('Accepted reply transcript could not be saved')
}
