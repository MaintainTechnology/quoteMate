// GET /api/admin/tenants — admin-gated list of tenants for the
// roofing-activation panel on /admin.
//
// Returns minimal fields: id, business_name, state, trades[], status,
// created_at. The /admin UI uses this to render a one-click toggle to
// enable/disable the roofing trade per tenant.

import { createClient } from '@supabase/supabase-js'
import { isAdminUser } from '@/lib/admin-loader/auth'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function adminUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const isAdmin = await isAdminUser(supabase, data.user.id)
  return isAdmin ? data.user.id : null
}

export async function GET(req: Request) {
  const adminId = await adminUserId(req)
  if (!adminId) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }

  const { data, error } = await supabase
    .from('tenants')
    .select('id, business_name, state, trade, trades, status, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  const tenants = (data ?? []).map((t) => ({
    id: t.id as string,
    businessName: (t.business_name as string | null) ?? null,
    state: (t.state as string | null) ?? null,
    trade: (t.trade as string | null) ?? null,
    trades: Array.isArray(t.trades) ? (t.trades as string[]) : [],
    status: (t.status as string | null) ?? null,
    createdAt: t.created_at as string | null,
  }))

  return Response.json({ ok: true, tenants })
}
