// POST /api/tenant/estimator/price — indicative pricing for a take-off.
//
// Body: { items: Array<{ type: string; count: number }>, extractionId?: string }
// Loads the tenant's adopted electrical assemblies and pricing book,
// then prices deterministically (grounded — no LLM, no free-form prices).
// Items with no catalogue match come back UNMATCHED, not guessed.
// When extractionId is supplied the computed BOM is persisted onto that run
// (plan_extractions.priced_bom/priced_at, tenant-scoped) so it survives reload.

import { tenantFromBearer, estimatorSupabase as supabase } from '@/lib/estimation/auth'
import type { TakeoffItem } from '@/lib/estimation/price'
import { ElectricalPricingError, loadElectricalPricingContext, priceElectricalTakeoff } from '@/lib/estimation/pricing-context'
import { provisionSessionStore } from '@/lib/filestore/provision'
import { electricalEstimateSummaryText } from '@/lib/filestore/estimate-summary'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const rawItems = (body as Record<string, unknown>)?.items
  if (!Array.isArray(rawItems)) {
    return Response.json({ ok: false, error: 'items must be an array' }, { status: 400 })
  }
  if (rawItems.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true
    const type = item.type ?? item.item ?? item.name
    return typeof type !== 'string' || !type.trim() || !Number.isSafeInteger(item.count) || item.count < 0
  })) {
    return Response.json({ ok: false, code: 'invalid_takeoff', error: 'Every item needs a type and a finite non-negative whole-number count.' }, { status: 400 })
  }
  const items: TakeoffItem[] = rawItems
    .map((r): TakeoffItem => {
      const item: TakeoffItem = {
        type: String(r.type ?? r.item ?? r.name ?? '').trim(),
        count: r.count,
      }
      // Take-off provenance → priced-line audit trace.
      if (r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low') {
        item.confidence = r.confidence
      }
      if (r.note != null && String(r.note).trim()) item.note = String(r.note)
      return item
    })

  const rawExtractionId = (body as Record<string, unknown>)?.extractionId
  const extractionId = typeof rawExtractionId === 'string' && rawExtractionId.trim() ? rawExtractionId.trim() : null
  if (extractionId) {
    try {
      const guard = await supabase.rpc('sms_plan_quote_guard_ready').abortSignal(AbortSignal.timeout(3000))
      if (guard.error || guard.data !== true) throw new Error('Plan release guard unavailable')
    } catch {
      return Response.json({ ok: false, code: 'plan_release_guard_unavailable', error: 'Plan pricing is temporarily unavailable. Please retry.' }, { status: 503 })
    }
    const { data: existing, error: readError } = await supabase.from('plan_extractions')
      .select('id, released_at').eq('id', extractionId).eq('tenant_id', tenant.id).eq('trade', 'electrical').abortSignal(AbortSignal.timeout(3000)).maybeSingle()
    if (readError) return Response.json({ ok: false, error: 'Plan could not be loaded. Please retry.' }, { status: 503 })
    if (!existing) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
    if (existing.released_at) return Response.json({ ok: false, code: 'released_quote_immutable',
      error: 'This plan has already been released. Start a new plan or revision for changed quantities or prices.' }, { status: 409 })
  }

  // Assemblies + pricing book via the shared loader (also used by the SMS
  // estimator pipeline — one pricing path, no fork).
  let context
  let bom
  try {
    context = await loadElectricalPricingContext(supabase, tenant.id)
    bom = priceElectricalTakeoff(items, context)
  } catch (error) {
    if (error instanceof ElectricalPricingError) {
      return Response.json({ ok: false, code: error.code, error: error.message }, { status: error.status })
    }
    return Response.json({ ok: false, code: 'pricing_unavailable', error: 'Pricing could not be loaded. Please retry.' }, { status: 503 })
  }

  // Incomplete pricing is an owner review preview, not a customer-priceable
  // persisted BOM. Keep unmatched rows available for explicit service adoption.
  let persisted = false
  if (extractionId && bom.pricingComplete) {
    const pricedAt = new Date().toISOString()
    const { data: saved, error } = await supabase
      .from('plan_extractions')
      .update({ priced_bom: bom, priced_at: pricedAt, updated_at: pricedAt })
      .eq('id', extractionId)
      .eq('tenant_id', tenant.id)
      .eq('trade', 'electrical') // shared table — never write an electrical BOM onto a paint extraction
      .select('id')
      .maybeSingle()
    if (error) {
      if (error.code === 'QM001') return Response.json({ ok: false, code: 'released_quote_immutable',
        error: 'This plan has already been released. Start a new plan or revision for changed quantities or prices.' }, { status: 409 })
      return Response.json({ ok: false, code: 'pricing_save_failed', error: 'Pricing could not be saved. Please retry.' }, { status: 503 })
    }
    if (!saved) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
    }
    persisted = Boolean(saved)

    // Index the priced result as a readable summary into this run's persistent
    // store so the estimator chatbot can explain the numbers. The dashboard
    // electrical flow renders no result PDF, so this text IS the result doc.
    // Named per pricing pass so a re-price indexes the fresh result.
    if (persisted) {
      provisionSessionStore({
        estimator: 'electrical',
        sessionId: extractionId,
        documents: [
          {
            name: `electrical-estimate-summary-${pricedAt.replace(/[:.]/g, '-')}.txt`,
            bytes: Buffer.from(electricalEstimateSummaryText(bom, { pricedAt }), 'utf8'),
            mime: 'text/plain',
          },
        ],
      })
    }
  }

  return Response.json({ ok: true, bom, catalogueSize: context.assemblies.length, pricingBookSource: context.bookSource, pricingComplete: bom.pricingComplete, persisted })
}
