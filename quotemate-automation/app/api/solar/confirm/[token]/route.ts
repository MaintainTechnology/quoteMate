// Legacy confirmation URL now leads the owning tradie to the shared saved-quote
// review. Existing approvals stay valid; first release is atomic with its outbox.
import { createClient } from '@supabase/supabase-js'
import { resolveTenantRequest } from '@/lib/tenant/from-request'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  if (!token || token.length < 8) return Response.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const auth = await resolveTenantRequest(db, req, 'id')
  const tenantId = auth?.tenant?.id
  if (typeof tenantId !== 'string') return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const { data: row, error } = await db.from('solar_estimates').select('id,tenant_id,confirmed_at')
    .eq('public_token', token).eq('tenant_id', tenantId).maybeSingle()
  if (error) return Response.json({ ok: false, error: 'quote_unavailable' }, { status: 503 })
  if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  if (row.confirmed_at) return Response.json({ ok: true, confirmed_at: row.confirmed_at, alreadyApproved: true })
  return Response.json({ ok: false, error: 'review_required',
    reviewUrl: `/dashboard/quote-review?family=solar&id=${row.id}` }, { status: 409 })
}
