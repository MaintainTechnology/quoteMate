// /api/tenant/catalogue — WP2 operator materials catalogue
// (tenant_material_catalogue, migration 028).
//   GET  → list this tenant's catalogue rows
//   POST → create a row
//
// Mirrors /api/tenant/services for auth + ownership. Every query is
// scoped to the bearer's tenant, so a tradie can only ever see/create
// their own catalogue rows.

import { createClient } from '@supabase/supabase-js'
import { MaterialCatalogueSchema } from '@/lib/tenant/update-schema'

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

// ─── GET /api/tenant/catalogue ─────────────────────────────────────
export async function GET(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('tenant_material_catalogue')
    .select('*')
    .eq('tenant_id', tenant.id)
    .order('trade', { ascending: true })
    .order('category', { ascending: true })
    .order('name', { ascending: true })

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true, catalogue: data ?? [] })
}

// ─── POST /api/tenant/catalogue ────────────────────────────────────
export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = MaterialCatalogueSchema.safeParse(body)
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

  const row = {
    tenant_id: tenant.id,
    trade: parsed.data.trade,
    category: parsed.data.category,
    name: parsed.data.name,
    brand: emptyToNull(parsed.data.brand),
    range_series: emptyToNull(parsed.data.range_series),
    supplier: emptyToNull(parsed.data.supplier),
    unit: parsed.data.unit?.trim() || 'each',
    unit_price_ex_gst: parsed.data.unit_price_ex_gst,
    customer_supply_price_ex_gst:
      parsed.data.customer_supply_price_ex_gst == null
        ? null
        : parsed.data.customer_supply_price_ex_gst,
    tier_hint: emptyToNull(parsed.data.tier_hint as string | undefined),
    image_path: emptyToNull(parsed.data.image_path),
    active: parsed.data.active ?? true,
  }

  const { data, error } = await supabase
    .from('tenant_material_catalogue')
    .insert(row)
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json(
        {
          error: 'duplicate_name',
          message: 'You already have a catalogue item with this name in this trade.',
        },
        { status: 409 },
      )
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, item: data })
}
