// POST /api/admin/loader/batch/[id]/rollback — admin bulk loader: revert a
// committed batch (spec §9 rule 9, §11).
//
// Admin-only. Delegates to the rollback_import_batch SQL function (migration
// 052): restores every UPDATE's before-values and deletes every INSERT, in
// one atomic transaction. The function raises if the batch is not committed
// or if §9 rule 17 blocks it (a committed row now has downstream usage) —
// both surface to the caller as a 409.

import { createClient } from '@supabase/supabase-js'
import { resolveAdminUserId } from '@/lib/admin-loader/route-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const adminId = await resolveAdminUserId(supabase, req)
  if (!adminId) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await ctx.params

  const { data, error } = await supabase.rpc('rollback_import_batch', {
    p_batch_id: id,
  })
  if (error) {
    // rollback_import_batch raises for a non-committed batch or a §17
    // downstream-usage block — a conflict the admin must resolve, not a
    // server fault.
    return Response.json(
      { error: 'rollback_blocked', message: error.message },
      { status: 409 },
    )
  }
  return Response.json({ ok: true, result: data })
}
