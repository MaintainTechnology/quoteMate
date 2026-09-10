import { estimatorSupabase, tenantFromBearer } from '@/lib/estimation/auth'
import { PaintCorrectionId, PaintCorrectionInputSchema } from '@/lib/commercial-painting/correction-contract'
import { applyPaintCorrection, paintCorrectionFailure, readPaintCorrectionBody, readPaintCorrectionOperation, readPaintEditSnapshot } from '@/lib/commercial-painting/correction-operations'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(request)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401, headers })
  const id = PaintCorrectionId.safeParse((await context.params).id)
  const query = new URL(request.url).searchParams
  if ([...query.keys()].some(key => key !== 'operationId') || query.getAll('operationId').length > 1)
    return Response.json({ ok: false, error: 'invalid_request' }, { status: 400, headers })
  const rawOperation = query.get('operationId')
  const operation = rawOperation === null ? null : PaintCorrectionId.safeParse(rawOperation)
  if (!id.success || (operation && !operation.success)) return Response.json({ ok: false, error: 'invalid_request' }, { status: 400, headers })
  try {
    if (operation?.success) return Response.json(await readPaintCorrectionOperation(estimatorSupabase, tenant.id, id.data, operation.data), { headers })
    return Response.json({ ok: true, snapshot: await readPaintEditSnapshot(estimatorSupabase, tenant.id, id.data) }, { headers })
  } catch (error) { return paintCorrectionFailure(error) }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(request)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401, headers })
  const id = PaintCorrectionId.safeParse((await context.params).id)
  if ([...new URL(request.url).searchParams].length) return Response.json({ ok: false, error: 'invalid_request' }, { status: 400, headers })
  let body: unknown
  try { body = await readPaintCorrectionBody(request) } catch (error) { return paintCorrectionFailure(error) }
  const input = PaintCorrectionInputSchema.safeParse(body)
  if (!id.success || !input.success) return Response.json({ ok: false, error: 'invalid_correction' }, { status: 400, headers })
  try { return Response.json(await applyPaintCorrection(estimatorSupabase, tenant.id, id.data, input.data), { headers }) }
  catch (error) { return paintCorrectionFailure(error) }
}
