import type { SupabaseClient } from '@supabase/supabase-js'
import { genericQuoteReleased } from '@/lib/quote/customer-release'

/** A saved promoted draft has a token before the owner approves it. */
export async function approvedRoofPromotion(db: SupabaseClient, row: {
  tenant_id?: string | null; quote_share_token?: string | null; paid_at?: string | null
}, full = false): Promise<string | null> {
  if (full || row.paid_at || !row.tenant_id || !row.quote_share_token) return null
  const {data,error}=await db.from('quotes').select('share_token,tenant_id,status,customer_released_at,sent_at,paid_at')
    .eq('share_token',row.quote_share_token).eq('tenant_id',row.tenant_id).maybeSingle()
  if(error)throw new Error('Promoted roof quote temporarily unavailable')
  return data && data.tenant_id === row.tenant_id && genericQuoteReleased(data) ? data.share_token : null
}
