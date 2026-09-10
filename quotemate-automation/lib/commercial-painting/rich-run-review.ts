import { isDeepStrictEqual } from 'node:util'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parsePaintPricingSource, readPaintPricingSource, verifyPaintPricing } from './pricing-proof'
import { normalisePaintPricedAt } from './saved-quote'

type Run = Record<string, unknown>
/** Unreleased approvals require today's source. A released price is historical;
 * its original source/proof must still match its immutable stored content. */
export async function readRichPaintReview(db: SupabaseClient, tenantId: string, run: Run) {
  const runId = String(run.id)
  let query = db.from('plan_extractions').select('id,tenant_id,paint_run_id,trade,items,corrected_items,priced_bom,priced_at,paint_pricing_proof,created_at')
    .eq('tenant_id', tenantId).eq('paint_run_id', runId)
  if (run.released_at) query = query.not('priced_bom', 'is', null).order('priced_at', { ascending: false })
  else query = query.order('created_at', { ascending: false })
  const result = await query.order('id', { ascending: false }).limit(1).maybeSingle()
  if (result.error) throw new Error('Tender pricing unavailable')
  const extraction = result.data
  const content = extraction?.priced_bom && typeof extraction.priced_bom === 'object' ? extraction.priced_bom as Run : {}
  if (!extraction?.id || !extraction.paint_pricing_proof || !extraction.priced_bom || extraction.trade !== 'commercial_painting')
    return { content, binding: null }
  try {
    const timestamp = normalisePaintPricedAt(extraction.priced_at)
    if (!timestamp) return { content, binding: null }
    const proof = extraction.paint_pricing_proof as { source?: unknown; digest?: unknown }
    const source = run.released_at
      ? parsePaintPricingSource(proof.source, tenantId, runId, extraction.id)
      : await readPaintPricingSource(db, tenantId, runId, extraction.id)
    if (source.run.job_name !== (run.job_name ?? null) || source.run.site_address !== (run.site_address ?? null) ||
      !isDeepStrictEqual(source.extraction.items, extraction.items) || !isDeepStrictEqual(source.extraction.corrected_items, extraction.corrected_items))
      return { content, binding: null }
    const verified = verifyPaintPricing(source, extraction.paint_pricing_proof, extraction.priced_bom, proof.digest)
    return { content: verified.bom as unknown as Run,
      binding: { extractionId: extraction.id, pricedAt: timestamp, proof: verified.proof } }
  } catch { return { content, binding: null } }
}
