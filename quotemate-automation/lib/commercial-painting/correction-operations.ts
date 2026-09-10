import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PaintCorrectionInputSchema, PaintCorrectionOutcomeSchema, PaintCorrectionStatusSchema,
  PaintEditSnapshotSchema, paintCorrectionRequestText, PAINT_CORRECTION_BODY_LIMIT, type PaintCorrectionInput } from './correction-contract'

export class PaintCorrectionError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code) }
}
// Bound allocation below the hosting platform ingress limit before JSON.parse.
export async function readPaintCorrectionBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length'))
  if (Number.isFinite(length) && length > PAINT_CORRECTION_BODY_LIMIT) throw new PaintCorrectionError('payload_too_large', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new PaintCorrectionError('invalid_json', 400)
  const decoder = new TextDecoder('utf-8', { fatal: true }); const chunks: string[] = []; let size = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new PaintCorrectionError('request_timeout', 408)), 15000) })
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline])
      if (part.done) break
      size += part.value.byteLength
      if (size > PAINT_CORRECTION_BODY_LIMIT) throw new PaintCorrectionError('payload_too_large', 413)
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return JSON.parse(chunks.join(''))
  } catch (error) { throw error instanceof PaintCorrectionError ? error : new PaintCorrectionError('invalid_json', 400) }
  finally { clearTimeout(timeout); void reader.cancel().catch(() => {}); reader.releaseLock() }
}
function rpcFailure(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'PC001') throw new PaintCorrectionError('correction_conflict', 409)
  if (code === 'PC002') throw new PaintCorrectionError('correction_operation_reused', 409)
  if (code === 'PC003') throw new PaintCorrectionError('invalid_correction', 400)
  if (code === 'PC004') throw new PaintCorrectionError('not_found', 404)
  if (code === 'QM001') throw new PaintCorrectionError('released_quote_immutable', 409)
  throw new PaintCorrectionError('correction_outcome_unconfirmed', 503)
}
export async function readPaintEditSnapshot(db: SupabaseClient, tenantId: string, runId: string) {
  const result = await db.rpc('commercial_paint_edit_snapshot', { p_tenant_id: tenantId, p_run_id: runId }).abortSignal(AbortSignal.timeout(5000))
  if (result.error) rpcFailure(result.error)
  if (!result.data) throw new PaintCorrectionError('not_found', 404)
  const parsed = PaintEditSnapshotSchema.safeParse(result.data)
  if (!parsed.success || parsed.data.runId !== runId.toLowerCase()) throw new PaintCorrectionError('correction_read_unavailable', 503)
  return parsed.data
}
export async function readPaintCorrectionOperation(db: SupabaseClient, tenantId: string, runId: string, operationId: string) {
  const result = await db.rpc('commercial_paint_correction_status', { p_tenant_id: tenantId, p_run_id: runId, p_operation_id: operationId }).abortSignal(AbortSignal.timeout(5000))
  if (result.error) rpcFailure(result.error)
  const parsed = PaintCorrectionStatusSchema.safeParse(result.data)
  if (!parsed.success || parsed.data.runId !== runId.toLowerCase() || parsed.data.operationId !== operationId.toLowerCase())
    throw new PaintCorrectionError('correction_read_unavailable', 503)
  return parsed.data
}
export async function applyPaintCorrection(db: SupabaseClient, tenantId: string, runId: string, raw: PaintCorrectionInput) {
  const input = PaintCorrectionInputSchema.parse(raw)
  const requestHash = createHash('sha256').update(paintCorrectionRequestText(input)).digest('hex')
  const { operationId, expectedRevision, extractionId, ...changes } = input
  const result = await db.rpc('apply_commercial_paint_correction', { p_tenant_id: tenantId, p_run_id: runId,
    p_operation_id: operationId, p_expected_revision: expectedRevision, p_extraction_id: extractionId,
    p_request_hash: requestHash, p_changes: changes }).abortSignal(AbortSignal.timeout(8000))
  if (result.error) rpcFailure(result.error)
  const parsed = PaintCorrectionOutcomeSchema.safeParse(result.data)
  if (!parsed.success || parsed.data.runId !== runId.toLowerCase() || parsed.data.operationId !== operationId ||
    parsed.data.extractionId !== extractionId || parsed.data.expectedRevision !== expectedRevision || parsed.data.requestHash !== requestHash)
    throw new PaintCorrectionError('correction_outcome_unconfirmed', 503)
  return parsed.data
}
export function paintCorrectionFailure(error: unknown) {
  const failure = error instanceof PaintCorrectionError ? error : new PaintCorrectionError('correction_outcome_unconfirmed', 503)
  return Response.json({ ok: false, error: failure.code }, { status: failure.status, headers: { 'Cache-Control': 'private, no-store' } })
}
