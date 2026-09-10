// GET   /api/tenant/estimator/extract/[id] — one run (extraction + its upload
//       + any persisted priced BOM) for the full-view run page.
// PATCH /api/tenant/estimator/extract/[id] — save the tradie's corrected counts.
//
// PATCH body: { corrected_items: Array<{ type; symbol?; count; confidence?; note?; locations? }> }
// The optional audit fields (confidence, zone-tally note, per-symbol pin
// locations) are retained so the plan-overlay + pricing trace survive a save.
// Saving corrections clears the persisted priced BOM — it was computed from the
// old counts; re-pricing is deterministic and one click.
// Scoped to the authed tenant; a mismatched id/tenant returns 404.

import { tenantFromBearer, estimatorSupabase as supabase } from '@/lib/estimation/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Location = { page: number; x: number; y: number }
type CorrectedItem = {
  type: string
  symbol: string
  count: number
  confidence?: 'high' | 'medium' | 'low'
  note?: string
  locations?: Location[]
}

function cleanLocations(input: unknown): Location[] {
  if (!Array.isArray(input)) return []
  const out: Location[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const page = Math.round(Number(r.page))
    const x = Number(r.x)
    const y = Number(r.y)
    if (!Number.isFinite(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({ page, x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)) })
  }
  return out
}

function cleanCorrected(input: unknown): CorrectedItem[] | null {
  if (!Array.isArray(input)) return null
  const out: CorrectedItem[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const type = String(r.type ?? r.item ?? r.name ?? '').trim()
    if (!type) continue
    const count = Number(r.count)
    const locations = cleanLocations(r.locations)
    out.push({
      type,
      symbol: r.symbol != null ? String(r.symbol) : '',
      count: Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0,
      ...(r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low'
        ? { confidence: r.confidence }
        : {}),
      ...(r.note != null && String(r.note).trim() ? { note: String(r.note).slice(0, 2000) } : {}),
      ...(locations.length > 0 ? { locations } : {}),
    })
  }
  return out
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  // Scoped to trade='electrical' as well as the tenant: `plan_extractions` is
  // shared with Commercial Painting (trade='commercial_painting'), and this is
  // the electrical Estimator's run page — a paint extraction id must 404 here
  // rather than render through the electrical viewer.
  const { data, error } = await supabase
    .from('plan_extractions')
    .select(
      'id, plan_upload_id, items, corrected_items, sheets_used, overall_note, model, runtime_seconds, priced_bom, priced_at, created_at, updated_at, plan_uploads(filename, sheet_hint, created_at)',
    )
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .eq('trade', 'electrical')
    .maybeSingle()

  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  if (!data) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  return Response.json({ ok: true, run: data })
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const corrected = cleanCorrected((body as Record<string, unknown>)?.corrected_items)
  if (corrected === null) {
    return Response.json({ ok: false, error: 'corrected_items must be an array' }, { status: 400 })
  }

  try {
    const guard = await supabase.rpc('sms_plan_quote_guard_ready').abortSignal(AbortSignal.timeout(3000))
    if (guard.error || guard.data !== true) throw new Error('Plan release guard unavailable')
  } catch {
    return Response.json({ ok: false, code: 'plan_release_guard_unavailable', error: 'Plan editing is temporarily unavailable. Please retry.' }, { status: 503 })
  }
  const { data: existing, error: readError } = await supabase.from('plan_extractions')
    .select('id, released_at').eq('id', id).eq('tenant_id', tenant.id).eq('trade', 'electrical').abortSignal(AbortSignal.timeout(3000)).maybeSingle()
  if (readError) return Response.json({ ok: false, error: 'Plan could not be loaded. Please retry.' }, { status: 503 })
  if (!existing) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  if (existing.released_at) return Response.json({ ok: false, code: 'released_quote_immutable',
    error: 'This plan has already been released. Start a new plan or revision for changed quantities or prices.' }, { status: 409 })

  const { data, error } = await supabase
    .from('plan_extractions')
    .update({ corrected_items: corrected, priced_bom: null, priced_at: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .eq('trade', 'electrical') // never let electrical-shaped corrections land on a paint extraction
    .select('id')
    .maybeSingle()

  if (error?.code === 'QM001') return Response.json({ ok: false, code: 'released_quote_immutable',
    error: 'This plan has already been released. Start a new plan or revision for changed quantities or prices.' }, { status: 409 })
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  if (!data) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })

  return Response.json({ ok: true, savedCount: corrected.length })
}
