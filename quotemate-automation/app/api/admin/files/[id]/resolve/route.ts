// POST /api/admin/files/[id]/resolve — staff mark a document's comment thread
// resolved or re-open it (specs/files-tab.md R10). Body: { resolved: boolean }.
// Admin-gated; reaches any tenant's document.

import {
  adminFromBearer,
  getFileDocMeta,
  setThreadResolved,
  ThreadResolutionError,
} from '@/lib/filestore/comments'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await adminFromBearer(req)
  if (!admin) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await ctx.params
  const doc = await getFileDocMeta(id)
  if (!doc) return Response.json({ error: 'not_found' }, { status: 404 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const resolved = !!(body as { resolved?: unknown } | null)?.resolved
  try {
    const state = await setThreadResolved(id, resolved, 'admin', doc.tenant_id)
    return Response.json({ ok: true, ...state })
  } catch (error) {
    if (error instanceof ThreadResolutionError && error.code === 'not_found') {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    return Response.json({ error: 'thread_resolution_failed' }, { status: 503 })
  }
}
