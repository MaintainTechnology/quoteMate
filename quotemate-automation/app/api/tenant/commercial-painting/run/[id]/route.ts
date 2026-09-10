// GET   /api/tenant/commercial-painting/run/[id] — full run detail:
//       paint_run + its uploads + the latest extraction (items,
//       corrected_items, flags, priced bom). The tab's resume/refresh
//       source of truth.
// PATCH — save the tradie's confirmed takeoff (corrected_items).
//       Clears priced_bom/priced_at: edits invalidate pricing (same
//       contract as the electrical estimator).

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PaintCorrectionId, PaintCorrectionItemSchema } from '@/lib/commercial-painting/correction-contract'
import { applyPaintCorrection, paintCorrectionFailure, PaintCorrectionError, readPaintCorrectionBody, readPaintEditSnapshot } from '@/lib/commercial-painting/correction-operations'
import { normalisePaintPricedAt } from '@/lib/commercial-painting/saved-quote'

export const dynamic = 'force-dynamic'

async function loadRun(tenantId: string, runId: string) {
  const { data: run } = await estimatorSupabase
    .from('paint_runs')
    .select('id, job_name, site_address, status, status_note, created_at, updated_at, released_at')
    .eq('id', runId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  return run
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  const { id } = await ctx.params

  const run = await loadRun(tenant.id, id)
  if (!run) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })

  const [uploadResult, extractionResult] = await Promise.all([
    estimatorSupabase
      .from('plan_uploads')
      .select('id, filename, doc_type, size_bytes, created_at')
      .eq('paint_run_id', id)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: true }),
    estimatorSupabase
      .from('plan_extractions')
      .select('id, items, corrected_items, sheets_used, overall_note, model, runtime_seconds, priced_bom, priced_at, paint_pricing_proof, created_at')
      .eq('paint_run_id', id)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1),
  ])
  if (uploadResult.error || extractionResult.error) return Response.json({ ok: false, error: 'run_detail_unavailable' }, { status: 503 })
  const uploads = uploadResult.data
  const extractions = extractionResult.data
  const extraction = extractions?.[0] ?? null
  const pricedAt = normalisePaintPricedAt(extraction?.priced_at)
  const pricingProof = (extraction?.paint_pricing_proof as { digest?: unknown } | null)?.digest

  return Response.json({
    ok: true,
    run,
    uploads: uploads ?? [],
    extraction: extraction ? { ...extraction, pricing_review: pricedAt && typeof pricingProof === 'string' && /^[a-f0-9]{64}$/.test(pricingProof)
      ? { pricedAt, pricingProof } : null } : null,
  })
}

/** Legacy payload adapter. Full caller-observed CAS uses /corrections. */
const LegacyCorrectionSchema = z.object({
  extractionId: PaintCorrectionId.optional(),
  job_name: z.string().trim().max(200).nullable().optional(),
  site_address: z.string().trim().max(300).nullable().optional(),
  corrected_items: z.array(PaintCorrectionItemSchema).min(1).max(5000).optional(),
}).strict().refine(value => value.job_name !== undefined || value.site_address !== undefined || value.corrected_items !== undefined)
  .refine(value => value.corrected_items === undefined || value.extractionId !== undefined)

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  const id = PaintCorrectionId.safeParse((await ctx.params).id)
  let body: unknown
  try { body = await readPaintCorrectionBody(req) } catch (error) { return paintCorrectionFailure(error) }
  const parsed = LegacyCorrectionSchema.safeParse(body)
  if (!id.success || !parsed.success) return Response.json({ ok: false, error: 'invalid_correction' }, { status: 400 })
  try {
    const snapshot = await readPaintEditSnapshot(estimatorSupabase, tenant.id, id.data)
    const { extractionId, ...changes } = parsed.data
    if (extractionId && extractionId !== snapshot.extractionId) throw new PaintCorrectionError('correction_conflict', 409)
    const outcome = await applyPaintCorrection(estimatorSupabase, tenant.id, id.data, { ...changes,
      operationId: randomUUID(), expectedRevision: snapshot.revision, extractionId: snapshot.extractionId })
    return Response.json({ ok: true, savedItems: changes.corrected_items?.length ?? 0, revision: outcome.revision },
      { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return paintCorrectionFailure(error) }
}
