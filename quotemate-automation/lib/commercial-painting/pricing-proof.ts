import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyLabourRateOverride, resolvePaintRates } from './rates'
import { assessPaintPricingAuthority, pricePaintTakeoff } from './price'
import { MAX_LABOUR_RATE_PER_HR, type PaintRateRow, type PaintTakeoffItem } from './types'

const ownedId = z.string().uuid()
const SourceSchema = z.object({
  version: z.literal(1),
  run: z.object({ id: ownedId, tenant_id: ownedId, job_name: z.string().nullable(), site_address: z.string().nullable() }).strict(),
  extraction: z.object({ id: ownedId, tenant_id: ownedId, paint_run_id: ownedId,
    items: z.array(z.unknown()), corrected_items: z.array(z.unknown()).nullable() }).strict(),
  rates: z.array(z.record(z.string(), z.unknown())),
  pricing_book: z.object({ id: ownedId, tenant_id: ownedId, trade: z.literal('commercial_painting'), gst_registered: z.boolean() }).strict().nullable(),
}).strict()
export type PaintPricingSource = z.infer<typeof SourceSchema>
const LabourSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('tenant'), ratePerHr: z.null() }).strict(),
  z.object({ mode: z.literal('override'), ratePerHr: z.number().finite().positive().max(MAX_LABOUR_RATE_PER_HR) }).strict(),
])
const ProofSchema = z.object({ version: z.literal(1), algorithm: z.literal('commercial-paint-v1'),
  digest: z.string().regex(/^[a-f0-9]{64}$/), source: SourceSchema, labour: LabourSchema }).strict()
export type PaintPricingProof = z.infer<typeof ProofSchema>

export class PaintPricingProofError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code) }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
function asStored<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

/** Only omission/null means use the tenant rate; invalid supplied input never
 * silently changes a caller's request into inherited pricing. */
export function paintLabourIntent(value: unknown): PaintPricingProof['labour'] {
  if (value === undefined || value === null) return { mode: 'tenant', ratePerHr: null }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_LABOUR_RATE_PER_HR)
    throw new PaintPricingProofError('invalid_labour_rate', 400)
  const rounded = Math.round(value * 100) / 100
  if (rounded <= 0) throw new PaintPricingProofError('invalid_labour_rate', 400)
  return { mode: 'override', ratePerHr: rounded }
}

export function parsePaintPricingSource(raw: unknown, tenantId: string, runId: string, extractionId: string): PaintPricingSource {
  const parsed = SourceSchema.safeParse(raw)
  if (!parsed.success) throw new PaintPricingProofError('pricing_source_unavailable', 503)
  const source = parsed.data
  if (source.run.id !== runId.toLowerCase() || source.run.tenant_id !== tenantId.toLowerCase() ||
      source.extraction.id !== extractionId.toLowerCase() || source.extraction.paint_run_id !== source.run.id ||
      source.extraction.tenant_id !== source.run.tenant_id ||
      (source.pricing_book && source.pricing_book.tenant_id !== source.run.tenant_id) ||
      source.rates.some(row => row.tenant_id !== null && row.tenant_id !== source.run.tenant_id))
    throw new PaintPricingProofError('pricing_source_unavailable', 503)
  return source
}

export async function readPaintPricingSource(db: SupabaseClient, tenantId: string, runId: string, extractionId: string) {
  const { data, error } = await db.rpc('commercial_paint_pricing_source', {
    p_tenant_id: tenantId, p_run_id: runId, p_extraction_id: extractionId,
  }).abortSignal(AbortSignal.timeout(5000))
  if (error || !data) throw new PaintPricingProofError('pricing_source_unavailable', 503)
  return parsePaintPricingSource(data, tenantId, runId, extractionId)
}

export function calculatePaintPricing(source: PaintPricingSource, labour: PaintPricingProof['labour']) {
  const raw = source.extraction.corrected_items ?? source.extraction.items
  if (!Array.isArray(raw) || raw.length === 0) throw new PaintPricingProofError('no_items', 422)
  for (const value of raw) {
    const item = value as Partial<PaintTakeoffItem> | null
    if (!item || typeof item !== 'object' || typeof item.surface !== 'string' || typeof item.room !== 'string' ||
        typeof item.system !== 'string' || (item.unit !== 'm2' && item.unit !== 'item') ||
        typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity < 0 ||
        typeof item.coats !== 'number' || !Number.isFinite(item.coats) || item.coats < 1 || item.coats > 4 ||
        (item.height_m !== undefined && (typeof item.height_m !== 'number' || !Number.isFinite(item.height_m) || item.height_m <= 0 || item.height_m >= 30)))
      throw new PaintPricingProofError('invalid_takeoff', 422)
  }
  const book = applyLabourRateOverride(resolvePaintRates(source.rates as PaintRateRow[]), labour.ratePerHr)
  const bom = asStored(pricePaintTakeoff(raw as PaintTakeoffItem[], book, { gstRegistered: source.pricing_book?.gst_registered === true }))
  const authority = assessPaintPricingAuthority(bom, book, source.pricing_book !== null)
  if (!authority.ok) throw new PaintPricingProofError(authority.error, 422)
  if (!Number.isFinite(bom.totalIncGst) || bom.totalIncGst <= 0 || !Number.isFinite(bom.subtotalExGst) || bom.subtotalExGst <= 0)
    throw new PaintPricingProofError('invalid_pricing', 422)
  const input = { version: 1 as const, algorithm: 'commercial-paint-v1' as const, source: asStored(source), labour }
  return { bom, proof: { ...input, digest: digest(input) } satisfies PaintPricingProof, book }
}

/** Recalculate with the recorded intent, including the underlying tenant rate
 * in the snapshot even when the owner deliberately overrode it. */
export function verifyPaintPricing(source: PaintPricingSource, rawProof: unknown, storedBom: unknown, expectedDigest: unknown) {
  const parsed = ProofSchema.safeParse(rawProof)
  if (!parsed.success) throw new PaintPricingProofError('pricing_proof_required')
  if (typeof expectedDigest !== 'string' || expectedDigest !== parsed.data.digest)
    throw new PaintPricingProofError('pricing_review_required')
  const result = calculatePaintPricing(source, parsed.data.labour)
  if (result.proof.digest !== parsed.data.digest || !isDeepStrictEqual(result.proof, parsed.data) ||
      !isDeepStrictEqual(result.bom, storedBom)) throw new PaintPricingProofError('pricing_changed')
  return result
}

export function paintPricingRpcError(error: unknown): PaintPricingProofError {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'QM001') return new PaintPricingProofError('released_quote_immutable')
  if (code === 'QP001') return new PaintPricingProofError('pricing_changed')
  if (code === 'QP002') return new PaintPricingProofError('pricing_review_required')
  if (code === 'QP003') return new PaintPricingProofError('saved_quote_unverifiable')
  return new PaintPricingProofError('pricing_persist_unconfirmed', 503)
}
