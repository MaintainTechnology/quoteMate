import { z } from 'zod'
// Below the hosting platform's 4.5 MB function request/response ceiling.
export const PAINT_CORRECTION_BODY_LIMIT = 4_000_000
export class PaintCorrectionSizeError extends Error {
  constructor() { super('These corrections exceed the 4 MB request limit. Reduce the takeoff or note lengths before saving. Your edits remain in this editor.') }
}
export function serialisePaintCorrection(input: PaintCorrectionInput) {
  const text = JSON.stringify(PaintCorrectionInputSchema.parse(input))
  if (new TextEncoder().encode(text).byteLength > PAINT_CORRECTION_BODY_LIMIT) throw new PaintCorrectionSizeError()
  return text
}

export const PaintCorrectionId = z.string().uuid().transform(value => value.toLowerCase())
export const PaintCorrectionRevision = z.string().regex(/^[a-f0-9]{64}$/)
export const PaintCorrectionItemSchema = z.object({
  surface: z.string().trim().min(1).max(200), room: z.string().trim().max(120),
  substrate: z.string().trim().max(120), system: z.enum(['spray_matt', 'flat', 'low_sheen', 'semi_gloss']),
  unit: z.enum(['m2', 'item']), quantity: z.number().finite().nonnegative(), coats: z.number().int().min(1).max(4),
  height_m: z.number().finite().positive().lt(30).optional(), confidence: z.enum(['high', 'medium', 'low']),
  source: z.enum(['plan', 'measurements', 'both', 'manual']), delta_pct: z.number().finite().optional(),
  separate_price: z.boolean().optional(), excluded: z.boolean().optional(), note: z.string().max(400).optional(),
}).strict()
const fields = {
  job_name: z.string().trim().max(200).nullable().optional(), site_address: z.string().trim().max(300).nullable().optional(),
  corrected_items: z.array(PaintCorrectionItemSchema).min(1).max(5000).optional(),
}
export const PaintCorrectionFieldsSchema = z.object(fields).strict().refine(value => Object.keys(value).length > 0)
export const PaintCorrectionInputSchema = z.object({ operationId: PaintCorrectionId, expectedRevision: PaintCorrectionRevision,
  extractionId: PaintCorrectionId.nullable(), ...fields }).strict().refine(value =>
  value.job_name !== undefined || value.site_address !== undefined || value.corrected_items !== undefined)
  .refine(value => value.corrected_items === undefined || value.extractionId !== null)
export type PaintCorrectionInput = z.infer<typeof PaintCorrectionInputSchema>
export const PaintEditSnapshotSchema = z.object({ runId: PaintCorrectionId, extractionId: PaintCorrectionId.nullable(),
  revision: PaintCorrectionRevision, job_name: z.string().nullable(), site_address: z.string().nullable(),
  items: z.array(z.unknown()), corrected_items: z.array(z.unknown()).nullable(), released: z.boolean(),
}).strict()
export type PaintEditSnapshot = z.infer<typeof PaintEditSnapshotSchema>
export const PaintCorrectionOutcomeSchema = z.object({ ok: z.literal(true), status: z.literal('applied'),
  runId: PaintCorrectionId, operationId: PaintCorrectionId, extractionId: PaintCorrectionId.nullable(),
  expectedRevision: PaintCorrectionRevision, requestHash: PaintCorrectionRevision, revision: PaintCorrectionRevision,
}).strict()
export type PaintCorrectionOutcome = z.infer<typeof PaintCorrectionOutcomeSchema>
export const PaintCorrectionStatusSchema = z.union([PaintCorrectionOutcomeSchema,
  z.object({ ok: z.literal(true), status: z.literal('not_found'), runId: PaintCorrectionId, operationId: PaintCorrectionId }).strict()])

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)])) : value
/** Canonical request identity shared with the browser; row order stays meaningful. */
export function paintCorrectionRequestText(input: PaintCorrectionInput) {
  return JSON.stringify(canonical(PaintCorrectionInputSchema.parse(input)))
}
/** Two independently read resources must describe the same displayed source
 * before an earlier pricing pass can be associated with the newer snapshot. */
export function paintEditSnapshotMatchesView(snapshot: PaintEditSnapshot, run: unknown, extraction: unknown) {
  const r = z.object({ id: PaintCorrectionId, job_name: z.string().nullable(), site_address: z.string().nullable() }).safeParse(run)
  const e = z.object({ id: PaintCorrectionId, items: z.array(z.unknown()), corrected_items: z.array(z.unknown()).nullable() }).safeParse(extraction)
  return r.success && e.success && r.data.id === snapshot.runId && e.data.id === snapshot.extractionId &&
    r.data.job_name === snapshot.job_name && r.data.site_address === snapshot.site_address &&
    JSON.stringify(canonical(e.data.items)) === JSON.stringify(canonical(snapshot.items)) &&
    JSON.stringify(canonical(e.data.corrected_items)) === JSON.stringify(canonical(snapshot.corrected_items))
}
