import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { currentSmsWork } from './durable-work'

/** Required form persistence must escape the conversational fallback. */
export class PaintingFormPersistenceError extends Error {}

/** One owned form per durable turn, including a lost response after insertion. */
export async function ensurePaintingFormRequest(args: {
  db: SupabaseClient; tenantId: string; conversationId: string; customerPhone: string
}): Promise<string> {
  const key = currentSmsWork()?.jobId
  if (!key) throw new PaintingFormPersistenceError('Painting form creation requires recoverable SMS work')
  const token = createHash('sha256').update(`paint-form:${args.tenantId}:${args.conversationId}:${key}`).digest('hex').slice(0, 32)
  try {
    const inserted = await args.db.from('painting_lead_requests').upsert({
      token, tenant_id: args.tenantId, conversation_id: args.conversationId,
      customer_phone: args.customerPhone, status: 'pending',
    }, { onConflict: 'token', ignoreDuplicates: true })
    if (inserted.error) throw new PaintingFormPersistenceError('Painting form could not be saved; retry required')
    const saved = await args.db.from('painting_lead_requests').select('token')
      .eq('token', token).eq('tenant_id', args.tenantId).eq('conversation_id', args.conversationId)
      .eq('customer_phone', args.customerPhone).maybeSingle()
    if (saved.error || !saved.data?.token) throw new PaintingFormPersistenceError('Saved painting form could not be confirmed; retry required')
    return String(saved.data.token)
  } catch (error) {
    if (error instanceof PaintingFormPersistenceError) throw error
    throw new PaintingFormPersistenceError(error instanceof Error ? error.message : 'Painting form persistence unavailable; retry required')
  }
}
