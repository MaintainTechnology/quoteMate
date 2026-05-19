// /api/tenant/bom — tenant-owned bills of materials (the editable
// "recipe book", migration 031).
//   GET  → the jobs this tradie can build recipes for + their lines
//   POST → add a recipe line to a job
//
// Ownership enforced exactly like /api/tenant/catalogue: every query is
// scoped to the bearer's tenant, so a tradie only ever sees/edits their
// own recipes and can only attach lines to jobs in trades they run.

import { createClient } from '@supabase/supabase-js'
import { TenantBomLineSchema } from '@/lib/tenant/update-schema'

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

function emptyToNull(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null
  const t = String(v).trim()
  return t === '' ? null : t
}

function allowedTradesOf(tenant: { trade: string | null; trades: string[] | null }) {
  return Array.isArray(tenant.trades) && tenant.trades.length > 0
    ? tenant.trades
    : tenant.trade
      ? [tenant.trade]
      : []
}

// ─── GET /api/tenant/bom ───────────────────────────────────────────
export async function GET(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const trades = allowedTradesOf(tenant)

  let aq = supabase
    .from('shared_assemblies')
    .select('id, name, trade')
    .order('trade', { ascending: true })
    .order('name', { ascending: true })
  if (trades.length > 0) aq = aq.in('trade', trades)
  const { data: assemblies, error: aErr } = await aq
  if (aErr) return Response.json({ error: aErr.message }, { status: 500 })

  const { data: lines, error: lErr } = await supabase
    .from('tenant_assembly_bom')
    .select('*')
    .eq('tenant_id', tenant.id)
    .order('assembly_id', { ascending: true })
    .order('sort', { ascending: true })
  if (lErr) return Response.json({ error: lErr.message }, { status: 500 })

  return Response.json({
    ok: true,
    assemblies: assemblies ?? [],
    lines: lines ?? [],
  })
}

// ─── POST /api/tenant/bom ──────────────────────────────────────────
export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = TenantBomLineSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const allowed = allowedTradesOf(tenant)
  if (!allowed.includes(parsed.data.trade)) {
    return Response.json({ error: 'trade_not_owned', allowed }, { status: 400 })
  }

  // The job must exist and its trade must match the line's trade AND be
  // a trade this tradie runs (can't build recipes for jobs they don't do).
  const { data: asm } = await supabase
    .from('shared_assemblies')
    .select('id, trade')
    .eq('id', parsed.data.assembly_id)
    .maybeSingle()
  if (!asm) {
    return Response.json({ error: 'invalid_assembly' }, { status: 400 })
  }
  if (asm.trade !== parsed.data.trade || !allowed.includes(asm.trade as string)) {
    return Response.json({ error: 'assembly_trade_mismatch' }, { status: 400 })
  }

  const row = {
    tenant_id: tenant.id,
    assembly_id: parsed.data.assembly_id,
    trade: parsed.data.trade,
    material_category: parsed.data.material_category,
    description: emptyToNull(parsed.data.description),
    quantity: parsed.data.quantity,
    required: parsed.data.required ?? true,
    sort: parsed.data.sort ?? 0,
  }

  const { data, error } = await supabase
    .from('tenant_assembly_bom')
    .insert(row)
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json(
        {
          error: 'duplicate_line',
          message: 'This job already has a recipe line for that material category.',
        },
        { status: 409 },
      )
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, line: data })
}
