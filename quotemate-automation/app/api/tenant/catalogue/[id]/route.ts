// /api/tenant/catalogue/[id] — PATCH a single catalogue row (partial
// edits incl. the active on/off toggle) or DELETE it. Ownership enforced:
// the update/delete include .eq('tenant_id', tenant.id), so a wrong id
// silently affects zero rows and returns 404 — a tradie can never touch
// another tradie's catalogue. Mirrors /api/tenant/services/[id].

import { createClient } from '@supabase/supabase-js'
import { MaterialCataloguePatchSchema } from '@/lib/tenant/update-schema'

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

// ─── PATCH /api/tenant/catalogue/[id] ──────────────────────────────
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = MaterialCataloguePatchSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const fields: Record<string, unknown> = {}
  if (parsed.data.trade !== undefined) {
    const allowed = Array.isArray(tenant.trades) && tenant.trades.length > 0
      ? tenant.trades
      : tenant.trade
        ? [tenant.trade]
        : []
    if (!allowed.includes(parsed.data.trade)) {
      return Response.json({ error: 'trade_not_owned', allowed }, { status: 400 })
    }
    fields.trade = parsed.data.trade
  }
  if (parsed.data.category !== undefined) fields.category = parsed.data.category
  if (parsed.data.name !== undefined) fields.name = parsed.data.name
  if (parsed.data.brand !== undefined) fields.brand = emptyToNull(parsed.data.brand)
  if (parsed.data.range_series !== undefined) {
    fields.range_series = emptyToNull(parsed.data.range_series)
  }
  if (parsed.data.supplier !== undefined) fields.supplier = emptyToNull(parsed.data.supplier)
  if (parsed.data.unit !== undefined) {
    fields.unit = parsed.data.unit?.trim() || 'each'
  }
  if (parsed.data.unit_price_ex_gst !== undefined) {
    fields.unit_price_ex_gst = parsed.data.unit_price_ex_gst
  }
  if (parsed.data.customer_supply_price_ex_gst !== undefined) {
    fields.customer_supply_price_ex_gst =
      parsed.data.customer_supply_price_ex_gst == null
        ? null
        : parsed.data.customer_supply_price_ex_gst
  }
  if (parsed.data.tier_hint !== undefined) {
    fields.tier_hint = emptyToNull(parsed.data.tier_hint as string | undefined)
  }
  if (parsed.data.image_path !== undefined) {
    fields.image_path = emptyToNull(parsed.data.image_path)
  }
  if (parsed.data.active !== undefined) fields.active = parsed.data.active

  if (Object.keys(fields).length === 0) {
    return Response.json({ error: 'empty_update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('tenant_material_catalogue')
    .update(fields)
    .eq('id', id)
    .eq('tenant_id', tenant.id) // ownership guard
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json(
        { error: 'duplicate_name', message: 'You already have a catalogue item with this name.' },
        { status: 409 },
      )
    }
    if (error.code === 'PGRST116') {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, item: data })
}

// ─── DELETE /api/tenant/catalogue/[id] ─────────────────────────────
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 })
  }

  const { error, count } = await supabase
    .from('tenant_material_catalogue')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('tenant_id', tenant.id) // ownership guard

  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!count || count === 0) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  return Response.json({ ok: true, deleted: count })
}
