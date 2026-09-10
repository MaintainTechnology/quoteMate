import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { currentSmsWork } from './durable-work'
import { publicWebUrl } from './public-origin'

/** Stable token per durable turn survives a response lost after insertion. */
export async function ensureRoofingFormRequest(args: {
  db: SupabaseClient; tenantId: string; conversationId: string; customerPhone: string
}): Promise<string | null> {
  const key = currentSmsWork()?.jobId ?? args.conversationId
  const token = createHash('sha256').update(`roof-form:${args.tenantId}:${args.conversationId}:${key}`).digest('hex').slice(0,32)
  try {
    const inserted = await args.db.from('trade_lead_requests').upsert({
      token, trade: 'roofing', tenant_id: args.tenantId, conversation_id: args.conversationId,
      customer_phone: args.customerPhone, status:'pending',
    }, { onConflict:'token',ignoreDuplicates:true })
    if (inserted.error) return null
    const saved = await args.db.from('trade_lead_requests').select('token').eq('token',token)
      .eq('tenant_id',args.tenantId).eq('customer_phone',args.customerPhone).maybeSingle()
    return saved.error || !saved.data?.token ? null : String(saved.data.token)
  } catch { return null }
}

export function buildRoofingFormOffer(args: { firstName?: string | null; token: string }): string {
  const name=args.firstName?.trim().split(/\s+/)[0]
  return [
    `Hi${name ? ` ${name}` : ''}, happy to help with your roofing request.`,
    `You can send the details for the roofer to review using this form: ${publicWebUrl(`/quote-request/${args.token}`)}`,
    'Or reply here and I can ask a few questions by text.',
  ].join('\n')
}
