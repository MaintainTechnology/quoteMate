// /api/tenant/services — tenant-owned custom assemblies (migration 023).
//
// POST → create a new custom assembly for the authed tradie.
// GET  → not needed; /api/tenant/me already returns custom rows merged
//        into the services list. Kept here for direct API consumers
//        and easier curl-based testing.
//
// PATCH/DELETE for a specific row live in ./[id]/route.ts.
//
// Auth: same Bearer-token pattern as /api/tenant/me.

import { createClient } from '@supabase/supabase-js'
import { CustomServiceSchema } from '@/lib/tenant/update-schema'

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

// ─── GET /api/tenant/services ──────────────────────────────────────
export async function GET(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('tenant_custom_assemblies')
    .select('*')
    .eq('tenant_id', tenant.id)
    .order('trade')
    .order('name')

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
  return Response.json({ custom_services: data ?? [] })
}

// ─── POST /api/tenant/services ─────────────────────────────────────
export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = CustomServiceSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  // Block tradies from creating services in a trade they don't operate
  // in. A two-trade tenant can create in either; a one-trade tenant is
  // pinned. Anything else is a misconfigured form submission.
  const allowedTrades = Array.isArray(tenant.trades) && tenant.trades.length > 0
    ? tenant.trades
    : tenant.trade
      ? [tenant.trade]
      : []
  if (!allowedTrades.includes(parsed.data.trade)) {
    return Response.json(
      { error: `trade_not_owned`, allowed: allowedTrades },
      { status: 400 },
    )
  }

  const row = {
    tenant_id: tenant.id,
    trade: parsed.data.trade,
    // Explicit grounding category (migration 029). '' / omitted → null →
    // validator falls back to name regex.
    category: emptyToNull(parsed.data.category),
    name: parsed.data.name,
    description: emptyToNull(parsed.data.description),
    default_unit: parsed.data.default_unit?.trim() || 'each',
    default_unit_price_ex_gst: parsed.data.default_unit_price_ex_gst,
    default_labour_hours: parsed.data.default_labour_hours ?? 0,
    default_exclusions: emptyToNull(parsed.data.default_exclusions),
    always_inspection: parsed.data.always_inspection ?? false,
    inspection_triggers: parsed.data.inspection_triggers ?? [],
    enabled: parsed.data.enabled ?? true,
  }

  const { data, error } = await supabase
    .from('tenant_custom_assemblies')
    .insert(row)
    .select('*')
    .single()

  if (error) {
    // Surface the unique-name violation as a friendly 409 so the
    // dashboard form can highlight the name field.
    if (error.code === '23505') {
      return Response.json(
        { error: 'duplicate_name', message: 'You already have a service with this name.' },
        { status: 409 },
      )
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, service: data })
}

function emptyToNull(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null
  const trimmed = String(v).trim()
  return trimmed === '' ? null : trimmed
}
