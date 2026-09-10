import type { SupabaseClient } from '@supabase/supabase-js'

export type QuoteCreditSettlement = {
  status: 'settled' | 'not_required' | 'pending' | 'review_required'
  reason: string
  outbox_id?: string
  quote_id?: string
}
function parse(value: unknown, quoteId: string): QuoteCreditSettlement | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (!['settled', 'not_required', 'pending', 'review_required'].includes(String(row.status)) ||
    typeof row.reason !== 'string' || (row.quote_id !== undefined && row.quote_id !== quoteId) ||
    (row.status === 'settled' && row.quote_id !== quoteId)) return null
  return { status: row.status as QuoteCreditSettlement['status'], reason: row.reason,
    ...(typeof row.outbox_id === 'string' ? { outbox_id: row.outbox_id } : {}),
    ...(typeof row.quote_id === 'string' ? { quote_id: row.quote_id } : {}) }
}

/** Reconcile the accepted durable intent; an earlier request's amount cannot
 * directly mark today's quote paid. The same SQL handles worker acceptance. */
export async function settleFinalQuoteCredit(db: SupabaseClient, input: {
  quoteId: string; tenantId: string; outboxId: string | null
}): Promise<QuoteCreditSettlement> {
  const pending: QuoteCreditSettlement = { status: 'pending', reason: 'credit_settlement_unconfirmed' }
  if (!input.outboxId) return pending
  try {
    const { data, error } = await db.rpc('settle_final_quote_credit', {
      p_outbox_id: input.outboxId, p_tenant_id: input.tenantId,
    })
    if (error) return pending
    return parse(data, input.quoteId) ?? pending
  } catch { return pending }
}

/** Read-only owner status; opening a quote never performs accounting writes. */
export async function readQuoteCreditSettlement(db: SupabaseClient, quoteId: string, tenantId: string): Promise<QuoteCreditSettlement | null> {
  const { data, error } = await db.from('quote_credit_settlements')
    .select('outbox_id,quote_id,tenant_id,status,reason').eq('quote_id', quoteId).eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false }).order('outbox_id', { ascending: false }).limit(1).maybeSingle()
  if (error || (data && (data.tenant_id !== tenantId || data.quote_id !== quoteId))) throw new Error('Credit settlement read unavailable')
  if (!data) return null
  const result = parse(data, quoteId)
  if (!result) throw new Error('Credit settlement read unavailable')
  return result
}
