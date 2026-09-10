import type { estimatorSupabase } from '@/lib/estimation/auth'

type PricingClient = typeof estimatorSupabase

export type CommercialPaintPricingBook = {
  id: string
  gst_registered: boolean
}

async function findBookForTrade(
  db: PricingClient,
  tenantId: string,
  trade: string,
): Promise<CommercialPaintPricingBook | null> {
  const { data, error } = await db
    .from('pricing_book')
    .select('id, tenant_id, trade, gst_registered')
    .eq('tenant_id', tenantId)
    .eq('trade', trade)
    .maybeSingle()
  if (error) throw new Error('Commercial painting tax basis unavailable')
  if (!data || data.tenant_id !== tenantId || data.trade !== trade || typeof data.gst_registered !== 'boolean') return null
  return { id: data.id, gst_registered: data.gst_registered }
}

export async function findCommercialPaintPricingBook(
  db: PricingClient,
  tenant: { id: string; trade?: string | null },
): Promise<CommercialPaintPricingBook | null> {
  return findBookForTrade(db, tenant.id, 'commercial_painting')
}
