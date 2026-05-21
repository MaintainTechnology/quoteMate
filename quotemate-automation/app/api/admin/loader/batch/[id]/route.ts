// GET /api/admin/loader/batch/[id] — admin bulk loader: re-fetch a batch
// and its staged rows (the preview screen, spec §8 step 5).
//
// Admin-only. Read-only — touches no live table.

import { createClient } from '@supabase/supabase-js'
import { resolveAdminUserId } from '@/lib/admin-loader/route-auth'
import { loadBatch } from '@/lib/admin-loader/store'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const adminId = await resolveAdminUserId(supabase, req)
  if (!adminId) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await ctx.params
  const loaded = await loadBatch(supabase, id)
  if (!loaded.ok) {
    return Response.json({ error: loaded.error }, { status: 404 })
  }
  return Response.json({ ok: true, batch: loaded.batch })
}
