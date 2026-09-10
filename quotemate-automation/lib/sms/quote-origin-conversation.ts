import type { SupabaseClient } from '@supabase/supabase-js'
import type { QuoteFamily } from './quote-actions'

function phoneIdentity(value: unknown): string {
  if (typeof value !== 'string') return ''
  const digits = value.replace(/\D/g, '')
  return /^0\d{9}$/.test(digits) ? `61${digits.slice(1)}` : digits
}

/** Attach an owner-approved SMS to its proven originating conversation.
 * A phone match alone is never an origin: only saved resource review tasks,
 * generic quote/intake relations and plan upload requests can supply an ID.
 * Portal-only resources legitimately have no originating SMS conversation.
 */
export async function resolveQuoteOriginConversation(db: SupabaseClient, input: {
  tenantId: string; family: QuoteFamily; resourceId: string; intakeId?: unknown
  customerPhone: string; fromNumber: string | null | undefined
}): Promise<string | null> {
  const customer = phoneIdentity(input.customerPhone)
  const candidates = new Set<string>()
  const add = (id: unknown, phone: unknown) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !customer || phoneIdentity(phone) !== customer) {
      throw new Error('Quote origin customer relationship could not be verified')
    }
    candidates.add(id)
  }
  const tasks = await db.from('sms_human_tasks').select('conversation_id,customer_phone,request_key')
    .eq('tenant_id', input.tenantId).eq('resource_type', input.family).eq('resource_id', input.resourceId)
    .not('request_key', 'like', 'sms-correction:%')
    .not('conversation_id', 'is', null).limit(25)
  if (tasks.error || !Array.isArray(tasks.data) || tasks.data.length >= 25) throw new Error('Quote origin review relationship unavailable')
  for (const task of tasks.data) {
    // A correction can arrive in a later customer conversation. It is a
    // follow-up relationship, never evidence of where the quote was created.
    if (typeof task.request_key === 'string' && task.request_key.startsWith('sms-correction:')) continue
    add(task.conversation_id, task.customer_phone)
  }

  if (input.family === 'generic') {
    const relations = [`quote_id.eq.${input.resourceId}`]
    if (typeof input.intakeId === 'string' && /^[0-9a-f-]{36}$/i.test(input.intakeId)) relations.push(`intake_id.eq.${input.intakeId}`)
    const conversations = await db.from('sms_conversations').select('id,from_number')
      .eq('tenant_id', input.tenantId).or(relations.join(',')).limit(25)
    if (conversations.error || !Array.isArray(conversations.data) || conversations.data.length >= 25) throw new Error('Quote origin intake relationship unavailable')
    for (const conversation of conversations.data) add(conversation.id, conversation.from_number)
  } else if (input.family === 'plan') {
    const requests = await db.from('plan_upload_requests').select('sms_conversation_id,customer_phone')
      .eq('tenant_id', input.tenantId).eq('plan_extraction_id', input.resourceId).not('sms_conversation_id', 'is', null).limit(25)
    if (requests.error || !Array.isArray(requests.data) || requests.data.length >= 25) throw new Error('Quote origin upload relationship unavailable')
    for (const request of requests.data) add(request.sms_conversation_id, request.customer_phone)
  }
  if (!candidates.size) return null
  if (candidates.size !== 1) throw new Error('Quote origin conversation is ambiguous')
  const [id] = candidates
  const conversation = await db.from('sms_conversations').select('id,tenant_id,from_number,to_number')
    .eq('tenant_id', input.tenantId).eq('id', id).maybeSingle()
  if (conversation.error || !conversation.data || conversation.data.id !== id || conversation.data.tenant_id !== input.tenantId ||
      phoneIdentity(conversation.data.from_number) !== customer || !phoneIdentity(input.fromNumber) ||
      phoneIdentity(conversation.data.to_number) !== phoneIdentity(input.fromNumber)) {
    throw new Error('Quote origin conversation ownership could not be verified')
  }
  return id
}
