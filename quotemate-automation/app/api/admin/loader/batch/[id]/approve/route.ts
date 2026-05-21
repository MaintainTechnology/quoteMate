// POST /api/admin/loader/batch/[id]/approve — admin bulk loader: commit a
// staged batch into the live tables (spec §8 step 8).
//
// Admin-only. Delegates to the commit_import_batch SQL function (migration
// 052) — one atomic transaction, INSERT/UPDATE only. The function is
// idempotent on an already-committed batch.
//
// §9 rule 6 — re-pricing confirmation: if the batch contains ANY UPDATE row
// (an UPDATE re-prices / re-scopes a live shared service), Approve requires
// an explicit { "confirmReprice": true } in the body. A NEW-only batch
// needs no confirmation.

import { createClient } from '@supabase/supabase-js'
import { resolveAdminUserId } from '@/lib/admin-loader/route-auth'
import { loadBatch } from '@/lib/admin-loader/store'

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

  let body: { confirmReprice?: boolean } = {}
  try {
    body = (await req.json()) as { confirmReprice?: boolean }
  } catch {
    // No body is fine for a NEW-only batch.
  }

  const loaded = await loadBatch(supabase, id)
  if (!loaded.ok) {
    return Response.json({ error: loaded.error }, { status: 404 })
  }
  if (loaded.batch.status !== 'staged') {
    return Response.json(
      {
        error: 'not_staged',
        message: `Batch is "${loaded.batch.status}" — only a staged batch can be approved.`,
      },
      { status: 409 },
    )
  }

  const updateRows = loaded.batch.rows.filter((r) => r.row_class === 'UPDATE')
  if (updateRows.length > 0 && body.confirmReprice !== true) {
    return Response.json(
      {
        error: 'reprice_confirmation_required',
        message: `This batch updates ${updateRows.length} existing service(s) — re-confirm to re-price live services.`,
        updateCount: updateRows.length,
      },
      { status: 409 },
    )
  }

  const { data, error } = await supabase.rpc('commit_import_batch', {
    p_batch_id: id,
  })
  if (error) {
    // commit_import_batch raises for a bad state / vanished UPDATE target —
    // a conflict, not a server fault.
    return Response.json(
      { error: 'commit_failed', message: error.message },
      { status: 409 },
    )
  }
  return Response.json({ ok: true, result: data })
}
