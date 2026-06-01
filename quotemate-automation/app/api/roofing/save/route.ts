// POST /api/roofing/save — persist a confirmed multi-structure roofing
// measurement into public.roofing_measurements (one row per job, N
// structures in a jsonb array). Requires migration 081.
//
// Auth: same bearer-token pattern as the rest of the roofing surface.
// The denormalised summary columns (area, better-tier total, routing)
// are derived defensively from the supplied quote payload for fast list
// views; the full quote + structures are stored verbatim.

import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { SaveRoofMeasurementSchema } from '@/lib/roofing/request-schema'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function userAndTenantFromBearer(
  req: Request,
): Promise<{ userId: string; tenantId: string | null } | null> {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('owner_user_id', data.user.id)
    .maybeSingle()
  return { userId: data.user.id, tenantId: (tenant?.id as string | undefined) ?? null }
}

/** Read a nested value off an unknown payload without `any`. */
function readPath(obj: unknown, path: Array<string | number>): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (cur && typeof cur === 'object' && String(k) in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[String(k)]
    } else {
      return undefined
    }
  }
  return cur
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

export async function POST(req: Request) {
  const auth = await userAndTenantFromBearer(req)
  if (!auth) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  const parsed = SaveRoofMeasurementSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { address, provider, structures, quote, customer_name, customer_phone } = parsed.data

  const row = {
    tenant_id: auth.tenantId,
    created_by: auth.userId,
    address: address.address,
    postcode: address.postcode,
    state: address.state,
    provider,
    customer_name: customer_name ?? null,
    customer_phone: customer_phone ?? null,
    structure_count: structures.length,
    combined_area_m2: numOrNull(readPath(quote, ['combined', 'area_m2'])),
    combined_better_inc_gst: numOrNull(readPath(quote, ['combined', 'tiers', 1, 'inc_gst'])),
    routing: strOrNull(readPath(quote, ['routing', 'decision'])),
    structures,
    quote: quote ?? null,
    // Unguessable share token so the saved job has a customer-facing page
    // at /q/roof/[token] (same surface the SMS receptionist links to).
    public_token: randomBytes(16).toString('hex'),
  }

  const { data, error } = await supabase
    .from('roofing_measurements')
    .insert(row)
    .select('id, public_token')
    .single()

  if (error) {
    return Response.json(
      { ok: false, error: 'save_failed', detail: error.message },
      { status: 200 },
    )
  }

  return Response.json(
    { ok: true, id: data.id as string, public_token: data.public_token as string },
    { status: 200 },
  )
}

// GET /api/roofing/save — list THIS tenant's saved roofing jobs, newest
// first. Powers the "Saved roofing jobs" history in the dashboard Roof
// tab. Returns the denormalised summary columns only (the full quote
// lives on /q/roof/[public_token]).
export async function GET(req: Request) {
  const auth = await userAndTenantFromBearer(req)
  if (!auth) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let q = supabase
    .from('roofing_measurements')
    .select(
      'id, address, postcode, state, customer_name, structure_count, combined_area_m2, combined_better_inc_gst, routing, public_token, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(100)

  // Scope to the tenant; fall back to the saver when there's no tenant
  // (so a job still shows for whoever measured it).
  q = auth.tenantId ? q.eq('tenant_id', auth.tenantId) : q.eq('created_by', auth.userId)

  const { data, error } = await q
  if (error) {
    return Response.json({ ok: false, error: 'list_failed', detail: error.message }, { status: 200 })
  }
  return Response.json({ ok: true, jobs: data ?? [] }, { status: 200 })
}
