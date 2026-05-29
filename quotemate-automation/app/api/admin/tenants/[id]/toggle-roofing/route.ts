// POST /api/admin/tenants/[id]/toggle-roofing — admin-gated, idempotent
// toggle of the 'roofing' trade for a tenant.
//
// Body: { enable: boolean } — true to add 'roofing' to trades[], false
// to remove it.
//
// Why this bypasses the v9 §10 activate flow:
//   • v9's /api/tenant/trades/activate depends on the
//     activate_trade_for_tenant() plpgsql function (mig 053-055), which
//     project memory flags as STAGING-ONLY — not on prod yet.
//   • This route does ONLY the trades[] mutation — no pricing_book seed,
//     no service_offerings seed. Roofing's deterministic pricing
//     pipeline doesn't need shared_assemblies enabled per tenant; the
//     pricing engine reads from the migration 080 seed + per-tenant
//     overlays on the SAME `pricing_book` row that already exists for
//     the tenant's primary trade.
//   • Therefore: just stamping `trades = trades || 'roofing'` is enough
//     for the dashboard's sidebar gate (tenantHasRoofingTrade) and the
//     roofing measurement tool to be reachable.
//
// When the v9 prod migration lands this route stays as the admin
// override; the §10 self-serve route becomes the tradie-facing path.

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { isAdminUser } from '@/lib/admin-loader/auth'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BodySchema = z.object({
  enable: z.boolean(),
})

async function adminUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return (await isAdminUser(supabase, data.user.id)) ? data.user.id : null
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const adminId = await adminUserId(req)
  if (!adminId) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }

  const { id: tenantId } = await ctx.params
  if (!tenantId || tenantId.length < 8) {
    return Response.json({ ok: false, error: 'bad_tenant_id' }, { status: 400 })
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'validation_failed', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  // Read current trades
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .select('id, business_name, trade, trades')
    .eq('id', tenantId)
    .maybeSingle()
  if (tErr) {
    return Response.json({ ok: false, error: tErr.message }, { status: 500 })
  }
  if (!tenant) {
    return Response.json({ ok: false, error: 'tenant_not_found' }, { status: 404 })
  }

  const current: string[] = Array.isArray(tenant.trades)
    ? (tenant.trades as string[])
    : tenant.trade
      ? [tenant.trade as string]
      : []
  const has = current.includes('roofing')

  let next: string[]
  if (parsed.data.enable) {
    if (has) next = current // already enabled — no-op
    else next = [...current, 'roofing']
  } else {
    if (!has) next = current // already disabled — no-op
    else {
      next = current.filter((t) => t !== 'roofing')
      // Guard: tenants.trades must remain non-empty (we don't strip the
      // last primary trade — a tenant with only roofing was never
      // intended in this admin shortcut).
      if (next.length === 0) {
        return Response.json(
          { ok: false, error: 'cannot_remove_last_trade' },
          { status: 400 },
        )
      }
    }
  }

  // Persist
  const { error: upErr } = await supabase
    .from('tenants')
    .update({ trades: next })
    .eq('id', tenantId)
  if (upErr) {
    return Response.json({ ok: false, error: upErr.message }, { status: 500 })
  }

  return Response.json({
    ok: true,
    tenantId,
    businessName: tenant.business_name ?? null,
    trades: next,
    wasNoop: current.length === next.length && current.every((t) => next.includes(t)),
  })
}
