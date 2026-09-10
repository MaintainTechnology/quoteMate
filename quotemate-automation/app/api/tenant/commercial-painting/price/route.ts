// POST /api/tenant/commercial-painting/price — tenant-scoped (Bearer).
//
// Prices a CONFIRMED takeoff deterministically: paint_rates (shared
// defaults + tenant overrides) → resolvePaintRates → pricePaintTakeoff.
// No LLM anywhere on this path; unmatched lines come back unpriced.
// Persists priced_bom + priced_at on the extraction and advances the
// run to 'priced'.
//
// Body: { paintRunId: string, extractionId: string }
// (Prices the extraction's corrected_items when present, else items —
// the confirm step is the source of truth, same as electrical.)

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { calculatePaintPricing, paintLabourIntent, paintPricingRpcError, PaintPricingProofError, readPaintPricingSource } from '@/lib/commercial-painting/pricing-proof'
import { z } from 'zod'
import { normalisePaintPricedAt } from '@/lib/commercial-painting/saved-quote'
import { isDeepStrictEqual } from 'node:util'
import { PaintCorrectionId, PaintCorrectionRevision } from '@/lib/commercial-painting/correction-contract'
import { readPaintEditSnapshot } from '@/lib/commercial-painting/correction-operations'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = z.object({ paintRunId: PaintCorrectionId, extractionId: PaintCorrectionId, labourRatePerHr: z.unknown().optional(), expectedRevision: PaintCorrectionRevision.optional() }).safeParse(rawBody)
  if (!parsed.success) return Response.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  const { paintRunId, extractionId } = parsed.data
  let labour
  try { labour = paintLabourIntent(parsed.data.labourRatePerHr) }
  catch (error) { return Response.json({ ok: false, error: (error as PaintPricingProofError).code }, { status: 400 }) }

  const releasedResponse = () => Response.json({ ok: false, error: 'released_quote_immutable',
    detail: 'This tender has already been shared. Create a new tender to change its pricing; the existing quote remains available.' }, { status: 409 })
  const { data: run, error: runError } = await estimatorSupabase.from('paint_runs')
    .select('id,released_at').eq('id', paintRunId).eq('tenant_id', tenant.id).maybeSingle()
  if (runError) return Response.json({ ok: false, error: 'run_unavailable' }, { status: 503 })
  if (!run) return Response.json({ ok: false, error: 'run_not_found' }, { status: 404 })
  if (run.released_at) return releasedResponse()
  // The database guard serializes writes with approval. An early read alone
  // cannot prevent a release from racing the price calculation below.
  try {
    const guard = await estimatorSupabase.rpc('sms_commercial_quote_guard_ready')
      .abortSignal(AbortSignal.timeout(3000))
    if (guard.error || guard.data !== true) throw new Error('Published quote guard unavailable')
  } catch { return Response.json({ ok: false, error: 'quote_guard_unavailable' }, { status: 503 }) }

  try {
    const observed = parsed.data.expectedRevision ? await readPaintEditSnapshot(estimatorSupabase, tenant.id, paintRunId) : null
    if (observed && (observed.revision !== parsed.data.expectedRevision || observed.extractionId !== extractionId || observed.released))
      throw new PaintPricingProofError('correction_conflict', 409)
    const source = await readPaintPricingSource(estimatorSupabase, tenant.id, paintRunId, extractionId)
    // Tie the exact source passed to219 persistence to the editor's observed
    // snapshot. Another edit between the two reads cannot be silently priced.
    if (observed && (source.run.job_name !== observed.job_name || source.run.site_address !== observed.site_address ||
      !isDeepStrictEqual(source.extraction.items, observed.items) || !isDeepStrictEqual(source.extraction.corrected_items, observed.corrected_items)))
      throw new PaintPricingProofError('correction_conflict', 409)
    let calculation
    try { calculation = calculatePaintPricing(source, labour) }
    catch (error) {
      if (!(error instanceof PaintPricingProofError)) throw error
      // Clear only the source this request actually assessed. A late failure
      // cannot clear a different, newly corrected or repriced extraction.
      const cleared = await estimatorSupabase.rpc('persist_commercial_paint_pricing', {
        p_tenant_id: tenant.id, p_run_id: paintRunId, p_extraction_id: extractionId,
        p_source: source, p_proof: null, p_bom: null,
      }).abortSignal(AbortSignal.timeout(5000))
      if (cleared.error || cleared.data?.cleared !== true) throw paintPricingRpcError(cleared.error)
      throw error
    }
    const saved = await estimatorSupabase.rpc('persist_commercial_paint_pricing', {
      p_tenant_id: tenant.id, p_run_id: paintRunId, p_extraction_id: extractionId,
      p_source: source, p_proof: calculation.proof, p_bom: calculation.bom,
    }).abortSignal(AbortSignal.timeout(5000))
    if (saved.error || saved.data?.ok !== true || saved.data?.pricingProof !== calculation.proof.digest || !normalisePaintPricedAt(saved.data?.priced_at))
      throw paintPricingRpcError(saved.error)
    return Response.json({ ok: true, bom: calculation.bom, gst_registered: calculation.bom.gstRegistered,
      rateRows: source.rates.length, usesSeedDefaults: calculation.book.usesSeedDefaults,
      pricingProof: calculation.proof.digest, pricedAt: normalisePaintPricedAt(saved.data.priced_at), labourBasis: calculation.proof.labour })
  } catch (error) {
    const failure = error instanceof PaintPricingProofError ? error : new PaintPricingProofError('pricing_unavailable', 503)
    return Response.json({ ok: false, error: failure.code }, { status: failure.status })
  }
}
