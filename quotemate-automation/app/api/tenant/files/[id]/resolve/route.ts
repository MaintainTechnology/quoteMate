// POST /api/tenant/files/[id]/resolve — mark the document's comment thread
// resolved or re-open it (specs/files-tab.md R9). Body: { resolved: boolean }.
// The document must belong to the authenticated tenant (else 404).

import {
  tenantFromBearer,
  getFileDocMeta,
  setThreadResolved,
  ThreadResolutionError,
} from '@/lib/filestore/comments'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const doc = await getFileDocMeta(id)
  if (!doc || doc.tenant_id !== tenant.id) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof (body as { resolved?: unknown }).resolved !== 'boolean') {
    return Response.json({ error: 'resolved must be a boolean' }, { status: 400 })
  }
  const resolved = (body as { resolved: boolean }).resolved
  try {
    const state = await setThreadResolved(id, resolved, 'tenant', tenant.id)
    return Response.json({ ok: true, ...state })
  } catch (error) {
    if (error instanceof ThreadResolutionError && error.code === 'not_found') {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    return Response.json({ error: 'thread_resolution_failed' }, { status: 503 })
  }
}
