import { z } from 'zod'

export const PaintSaveScopeSchema = z.object({
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  tenantId: z.string().uuid(),
}).strict()
export type PaintSaveScope = z.infer<typeof PaintSaveScopeSchema>
export const PaintSavePassSchema = z.object({
  paintRunId: z.string().uuid(), extractionId: z.string().uuid(),
  pricingProof: z.string().regex(/^[a-f0-9]{64}$/),
  // Preserve the server's microsecond pass identity; Date truncates it.
  pricedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
}).strict()
export type PaintSavePass = z.infer<typeof PaintSavePassSchema>
const ReceiptSchema = z.object({ version: z.literal(1), scope: PaintSaveScopeSchema, pass: PaintSavePassSchema }).strict()
export type PaintSaveReceipt = z.infer<typeof ReceiptSchema>
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type LockPort = <T>(key: string, work: () => T) => Promise<T>
const PREFIX = 'quotemax.paint-save.v1.'

export function paintSaveReceiptKey(scope: PaintSaveScope) {
  const parsed = PaintSaveScopeSchema.parse(scope)
  return `${PREFIX}${parsed.userId}.${parsed.tenantId}`
}
export function samePaintSavePass(a: PaintSavePass, b: PaintSavePass) {
  return a.paintRunId === b.paintRunId && a.extractionId === b.extractionId && a.pricingProof === b.pricingProof && a.pricedAt === b.pricedAt
}
export function samePaintSaveScope(a: PaintSaveScope, b: PaintSaveScope) {
  return a.userId === b.userId && a.tenantId === b.tenantId
}

/** Opaque operation receipts have no expiry: an unknown server result remains
 * recoverable across reloads and sign-out. Customer fields and credentials are
 * never written here. Web Locks prevent two tabs from replacing a pending pass. */
export function createPaintSaveReceiptStore(scope: PaintSaveScope, storage: StoragePort, lock: LockPort) {
  const owner = PaintSaveScopeSchema.parse(scope)
  const key = paintSaveReceiptKey(owner)
  const read = (): PaintSaveReceipt | null => {
    const raw = storage.getItem(key)
    if (raw === null) return null
    let parsed: PaintSaveReceipt
    try { parsed = ReceiptSchema.parse(JSON.parse(raw)) } catch { throw new Error('Saved quote recovery data could not be read. It has been retained.') }
    if (!samePaintSaveScope(parsed.scope, owner)) throw new Error('Saved quote recovery belongs to another account.')
    return parsed
  }
  return {
    read,
    begin: (pass: PaintSavePass) => lock(key, () => {
      if (read()) throw new Error('Check the previous quote save before starting another.')
      const receipt = ReceiptSchema.parse({ version: 1, scope: owner, pass })
      storage.setItem(key, JSON.stringify(receipt))
      const retained = read()
      if (!retained || !samePaintSavePass(retained.pass, receipt.pass)) throw new Error('Quote recovery could not be stored. No save was started.')
      return receipt
    }),
    complete: (pass: PaintSavePass) => lock(key, () => {
      const retained = read()
      if (!retained || !samePaintSavePass(retained.pass, pass)) throw new Error('The pending quote save changed. Check its status again.')
      storage.removeItem(key)
      if (storage.getItem(key) !== null) throw new Error('The saved result was verified, but recovery storage could not be cleared.')
    }),
  }
}
export function browserPaintSaveReceiptStore(scope: PaintSaveScope) {
  if (typeof window === 'undefined' || !navigator.locks) throw new Error('This browser cannot protect quote recovery across tabs. Use a browser with Web Locks support.')
  return createPaintSaveReceiptStore(scope, window.localStorage, (key, work) => navigator.locks.request(key, work))
}

const SavedSchema = PaintSavePassSchema.extend({ ok: z.literal(true), quoteId: z.string().uuid(),
  shareToken: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/), quoteViewUrl: z.string(), pdfUrl: z.string().nullable(),
  delivery: z.object({ attempted: z.literal(false) }),
}).strip()
export type SavedPaintResult = z.infer<typeof SavedSchema>
export function readSavedPaintResult(body: unknown, pass: PaintSavePass): SavedPaintResult {
  const result = SavedSchema.parse(body)
  if (!samePaintSavePass(result, pass) || result.quoteViewUrl !== `/q/${result.shareToken}` ||
    (result.pdfUrl !== null && result.pdfUrl !== `/api/q/${result.shareToken}/pdf`)) {
    throw new Error('The returned quote does not match the reviewed pricing pass.')
  }
  return result
}
export function readPaintRecoveryResult(body: unknown, pass: PaintSavePass): SavedPaintResult | null {
  const status = z.object({ status: z.enum(['saved', 'not_found']) }).parse(body).status
  if (status === 'saved') return readSavedPaintResult(body, pass)
  const result = PaintSavePassSchema.extend({ ok: z.literal(true), status: z.literal('not_found') }).parse(body)
  if (!samePaintSavePass(result, pass)) throw new Error('The returned status does not match the pending quote save.')
  return null
}
