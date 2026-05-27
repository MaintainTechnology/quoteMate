// GET /api/tenant/catalogue/coverage — A4 shared-vs-tenant diff endpoint.
//
// Read-only. Returns the catalogue COVERAGE report for the authed tenant:
// per-trade rollup of how many shared_materials categories the tenant has
// at least one row in vs how many they don't, plus shared_count and
// tenant_count per category so the dashboard's COVERAGE panel can render
// "you have 1 of 4 hws_electric — 3 missing" lines.
//
// The actual computation is in lib/dashboard/coverage.ts (pure, unit-
// tested). This route just resolves the tenant from the bearer token,
// queries the two source tables (scoped to the tenant's trades), and
// hands the rows to computeCoverage.
//
// Bearer-authed + tenant-scoped, mirrors /api/supplier-catalogue and
// /api/tenant/catalogue. Service-role read on shared_materials is fine —
// it's a global library (RLS-on but service-role bypasses) and the
// .in('trade', trades) clamp scopes the payload to what the tradie does.

import { createClient } from '@supabase/supabase-js'
import {
  computeCoverage,
  type SharedMaterialRow,
  type TenantMaterialRow,
} from '@/lib/dashboard/coverage'

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

function tradesOf(tenant: { trade: string | null; trades: string[] | null }): string[] {
  return Array.isArray(tenant.trades) && tenant.trades.length > 0
    ? tenant.trades
    : tenant.trade
      ? [tenant.trade]
      : []
}

export async function GET(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const trades = tradesOf(tenant)
  if (trades.length === 0) {
    return Response.json({
      ok: true,
      trades_active: [],
      by_trade: [],
    })
  }

  // Shared library — every (trade, category) the global catalogue stocks
  // for the tenant's trade(s). We only need trade + category to compute
  // coverage; ignore prices, brands, etc.
  const { data: shared, error: sErr } = await supabase
    .from('shared_materials')
    .select('trade, category')
    .in('trade', trades)
  if (sErr) return Response.json({ error: sErr.message }, { status: 500 })

  // Tenant overlay — every active row this tenant has stocked.
  const { data: tenantRows, error: tErr } = await supabase
    .from('tenant_material_catalogue')
    .select('trade, category, active')
    .eq('tenant_id', tenant.id)
  if (tErr) return Response.json({ error: tErr.message }, { status: 500 })

  const report = computeCoverage(
    trades,
    (shared ?? []) as SharedMaterialRow[],
    (tenantRows ?? []) as TenantMaterialRow[],
  )

  return Response.json({
    ok: true,
    ...report,
  })
}
