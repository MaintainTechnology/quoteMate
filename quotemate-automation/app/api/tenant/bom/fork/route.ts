// /api/tenant/bom/fork — copy the shared baseline recipe for ONE job
// into this tenant's tenant_assembly_bom rows, so the tradie can edit
// it from the dashboard without typing every line from scratch.
//
// Spec (2026-05-20): "A job with no recipe here, I must have the ability
// to edit a saved recipe." The fork endpoint is what turns the read-only
// shared baseline into an editable tenant recipe. After it returns, the
// existing PATCH / DELETE / add-line endpoints take over normally.
//
// Idempotency: no-ops when the tenant already has at least one line for
// the assembly — we never silently merge into an existing custom recipe
// (could clobber the tradie's prior edits). The UI hides the button in
// that case, but this server-side guard is the source of truth.
//
// Trade scope: the assembly must belong to a trade this tenant runs (same
// pattern as the line-insert POST). Ownership: bearer token resolves to
// the tenant_id used for both the read and the writes.

import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function tenantFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, trade, trades')
    .eq('owner_user_id', data.user.id)
    .maybeSingle()
  if (!tenant) return null
  return tenant as { id: string; trade: string | null; trades: string[] | null }
}

function allowedTradesOf(tenant: { trade: string | null; trades: string[] | null }) {
  return Array.isArray(tenant.trades) && tenant.trades.length > 0
    ? tenant.trades
    : tenant.trade
      ? [tenant.trade]
      : []
}

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const assemblyId =
    typeof (body as { assembly_id?: unknown })?.assembly_id === 'string'
      ? ((body as { assembly_id: string }).assembly_id as string).trim()
      : ''
  if (!/^[0-9a-f-]{36}$/i.test(assemblyId)) {
    return Response.json({ error: 'invalid_assembly_id' }, { status: 400 })
  }

  // Assembly must exist + its trade must be one this tenant runs.
  const { data: asm } = await supabase
    .from('shared_assemblies')
    .select('id, trade')
    .eq('id', assemblyId)
    .maybeSingle()
  if (!asm) {
    return Response.json({ error: 'invalid_assembly' }, { status: 400 })
  }
  const allowed = allowedTradesOf(tenant)
  if (!allowed.includes(asm.trade as string)) {
    return Response.json({ error: 'assembly_trade_mismatch', allowed }, { status: 400 })
  }

  // Refuse to fork when the tenant already has lines for this assembly —
  // never silently merge into an existing custom recipe.
  const { count: existingCount, error: countErr } = await supabase
    .from('tenant_assembly_bom')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .eq('assembly_id', assemblyId)
  if (countErr) return Response.json({ error: countErr.message }, { status: 500 })
  if ((existingCount ?? 0) > 0) {
    return Response.json(
      {
        error: 'already_customised',
        message:
          'You already have a recipe for this job. Edit it directly instead of forking the baseline.',
      },
      { status: 409 },
    )
  }

  // Pull the shared baseline lines and stamp them with this tenant_id.
  const { data: baseline, error: bErr } = await supabase
    .from('shared_assembly_bom')
    .select('material_category, description, quantity, required, sort')
    .eq('assembly_id', assemblyId)
    .order('sort', { ascending: true })
  if (bErr) return Response.json({ error: bErr.message }, { status: 500 })

  if (!baseline || baseline.length === 0) {
    return Response.json(
      {
        error: 'no_baseline',
        message:
          "There's no standard baseline for this job yet. Add parts manually below.",
      },
      { status: 404 },
    )
  }

  const rows = baseline.map((r) => ({
    tenant_id: tenant.id,
    assembly_id: assemblyId,
    trade: asm.trade as string,
    material_category: r.material_category as string,
    description: (r.description as string | null) ?? null,
    quantity: Number(r.quantity),
    required: !!r.required,
    sort: Number(r.sort ?? 0),
  }))

  const { data: inserted, error: insErr } = await supabase
    .from('tenant_assembly_bom')
    .insert(rows)
    .select('*')

  if (insErr) {
    return Response.json({ error: insErr.message }, { status: 500 })
  }

  return Response.json({
    ok: true,
    forked: inserted?.length ?? 0,
    lines: inserted ?? [],
  })
}
