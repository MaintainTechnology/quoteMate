import type { SupabaseClient } from '@supabase/supabase-js'
import { validOwnedQuoteBook } from '../quote/edit-authority'
import { parseTenantRoofingRateCard } from '../roofing/pricing-authority'
import { completePaintingRateCard } from '../painting/complete-rate-card'
import { parseSolarRateOverlay } from '../solar/rate-card-overlay'
import { hasCompleteSolarRateOverlay } from '../solar/complete-rate-card'

type Book = { id: string; tenant_id: string; trade: string | null; gst_registered?: boolean; overlays: Record<string,unknown> | null }

/** Read-only setup evidence. Generic SMS still also requires the independent,
 * release-bound synthetic workflow: owning a book does not certify every job's
 * catalogue coverage. Specialist checks reuse the estimator's complete cards.
 */
export async function tenantPricingReadiness(db: SupabaseClient, tenantId: string, trade: string, primaryTrade: string | null): Promise<boolean> {
  if (!tenantId || !['electrical','plumbing','roofing','painting','solar'].includes(trade)) return false
  try {
    const { data,error } = await db.from('pricing_book').select('id,tenant_id,trade,gst_registered,overlays')
      .eq('tenant_id',tenantId).abortSignal(AbortSignal.timeout(3000))
    if (error || !Array.isArray(data) || !data.length || data.some(row =>
      !row || row.tenant_id!==tenantId || typeof row.id!=='string' || !row.id)) return false
    const rows=data as Book[]
    if (trade==='electrical' || trade==='plumbing') {
      return validOwnedQuoteBook(rows.find(row => row.trade===trade) ?? null,tenantId,trade)
    }
    if (trade==='roofing') {
      // The production loader can select any complete owned roofing card.
      return rows.some(row => parseTenantRoofingRateCard(row.overlays?.roofing_rate_card)!==null)
    }
    if (trade==='painting') {
      const cardOf=(row: Book | undefined) => row?.overlays?.painting_rate_card ?? null
      const raw=cardOf(rows.find(row => row.trade==='painting')) ??
        (primaryTrade ? cardOf(rows.find(row => row.trade===primaryTrade)) : null) ??
        cardOf(rows.find(row => cardOf(row)!==null))
      return completePaintingRateCard(raw)!==undefined
    }
    // Mirrors the solar loader: use the solar row if present; otherwise the
    // first owned book. A malformed preferred row cannot borrow another card.
    const selected=rows.find(row => row.trade==='solar') ?? rows[0]
    const parsed=parseSolarRateOverlay(selected.overlays?.solar_rate_card)
    return parsed.ok && hasCompleteSolarRateOverlay(parsed.overlay)
  } catch { return false }
}
