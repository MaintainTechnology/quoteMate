// /api/tenant/services/[id] — operate on a specific tenant-owned
// custom assembly. PATCH for partial edits, DELETE to remove.
//
// All operations enforce ownership: even with the row's id, a tradie
// cannot touch another tradie's custom service (the supabase update /
// delete includes `.eq('tenant_id', tenant.id)` so a wrong id silently
// affects zero rows and returns a 404).

import { createClient } from '@supabase/supabase-js'
import { CustomServicePatchSchema } from '@/lib/tenant/update-schema'

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

// ─── PATCH /api/tenant/services/[id] ───────────────────────────────
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

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

  const parsed = CustomServicePatchSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  // Build a partial update payload — only include fields the client sent.
  // Normalises empty strings on optional text fields to null so the DB
  // doesn't accumulate stray ''. Numeric fields pass through as-is.
  const fields: Record<string, unknown> = {}
  if (parsed.data.trade !== undefined) {
    // If the tradie is moving the row to a different trade, verify they
    // own that trade too. Same check as POST.
    const allowedTrades = Array.isArray(tenant.trades) && tenant.trades.length > 0
      ? tenant.trades
      : tenant.trade
        ? [tenant.trade]
        : []
    if (!allowedTrades.includes(parsed.data.trade)) {
      return Response.json(
        { error: 'trade_not_owned', allowed: allowedTrades },
        { status: 400 },
      )
    }
    fields.trade = parsed.data.trade
  }
  if (parsed.data.category !== undefined) {
    fields.category = emptyToNull(parsed.data.category)
  }
  if (parsed.data.name !== undefined) fields.name = parsed.data.name
  if (parsed.data.description !== undefined) {
    fields.description = emptyToNull(parsed.data.description)
  }
  if (parsed.data.default_unit !== undefined) {
    fields.default_unit = parsed.data.default_unit?.trim() || 'each'
  }
  if (parsed.data.default_unit_price_ex_gst !== undefined) {
    fields.default_unit_price_ex_gst = parsed.data.default_unit_price_ex_gst
  }
  if (parsed.data.default_labour_hours !== undefined) {
    fields.default_labour_hours = parsed.data.default_labour_hours
  }
  if (parsed.data.default_exclusions !== undefined) {
    fields.default_exclusions = emptyToNull(parsed.data.default_exclusions)
  }
  if (parsed.data.always_inspection !== undefined) {
    fields.always_inspection = parsed.data.always_inspection
  }
  if (parsed.data.inspection_triggers !== undefined) {
    fields.inspection_triggers = parsed.data.inspection_triggers
  }
  if (parsed.data.enabled !== undefined) fields.enabled = parsed.data.enabled

  if (Object.keys(fields).length === 0) {
    return Response.json({ error: 'empty_update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('tenant_custom_assemblies')
    .update(fields)
    .eq('id', id)
    .eq('tenant_id', tenant.id) // ownership guard
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505') {
      return Response.json(
        { error: 'duplicate_name', message: 'You already have a service with this name.' },
        { status: 409 },
      )
    }
    // PGRST116: "Cannot coerce the result to a single JSON object" —
    // happens when the row doesn't exist (or isn't owned by this tenant).
    if (error.code === 'PGRST116') {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, service: data })
}

// ─── DELETE /api/tenant/services/[id] ──────────────────────────────
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 })
  }

  const { error, count } = await supabase
    .from('tenant_custom_assemblies')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('tenant_id', tenant.id) // ownership guard

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
  if (!count || count === 0) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  return Response.json({ ok: true, deleted: count })
}

function emptyToNull(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null
  const trimmed = String(v).trim()
  return trimmed === '' ? null : trimmed
}
