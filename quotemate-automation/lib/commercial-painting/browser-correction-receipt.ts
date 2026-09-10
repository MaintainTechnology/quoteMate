import { z } from 'zod'
import { PaintSaveScopeSchema, type PaintSaveScope } from './browser-save-receipt'
import { PaintCorrectionId, PaintCorrectionInputSchema, PaintCorrectionRevision, PaintCorrectionStatusSchema,
  paintCorrectionRequestText, serialisePaintCorrection, type PaintCorrectionInput } from './correction-contract'

const CopySchema = z.object({ version: z.literal(1), scope: PaintSaveScopeSchema, runId: PaintCorrectionId,
  input: PaintCorrectionInputSchema, requestHash: PaintCorrectionRevision,
  labourRatePerHr: z.number().finite().positive().max(1000).nullable(),
  attempts: z.number().int().nonnegative(), rejected: z.boolean(),
}).strict()
export type PaintCorrectionCopy = z.infer<typeof CopySchema>
type Envelope = { key: CryptoKey; iv: Uint8Array<ArrayBuffer>; bytes: ArrayBuffer }
const DATABASE = 'quotemax.paint-correction.v1'
const scopeKey = (scope: PaintSaveScope) => JSON.stringify(PaintSaveScopeSchema.parse(scope))
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(new Error('Correction recovery storage is unavailable.'))
})
async function database() {
  const pending = indexedDB.open(DATABASE, 1)
  pending.onupgradeneeded = () => pending.result.createObjectStore('copies')
  return request(pending)
}
async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await database()
  try {
    const transaction = db.transaction('copies', mode)
    const finished = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(new Error('Correction recovery could not be committed.'))
    })
    const operation = request(action(transaction.objectStore('copies')))
    const [result] = await Promise.all([operation, finished])
    return result
  } finally { db.close() }
}
export async function paintCorrectionHash(input: PaintCorrectionInput) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(paintCorrectionRequestText(input)))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
/** Encrypted retained command, including its working copy. Unknown operations
 * have no expiry. A nonextractable AES key and ciphertext commit in one IndexedDB
 * transaction; Web Locks prevent another tab from replacing the pending copy.
 * Browser profile deletion still removes local recovery. No credentials stored. */
export function browserPaintCorrectionStore(scope: PaintSaveScope) {
  if (typeof window === 'undefined' || !navigator.locks || !crypto.subtle || !window.indexedDB)
    throw new Error('This browser cannot retain encrypted correction recovery.')
  const owner = scopeKey(scope), aad = new TextEncoder().encode(`${DATABASE}:${owner}`)
  const read = async (): Promise<PaintCorrectionCopy | null> => {
    const stored = await transact('readonly', store => store.get(owner)) as Envelope | undefined
    if (!stored) return null
    try {
      if (!(stored.bytes instanceof ArrayBuffer) || stored.bytes.byteLength > 32 * 1024 * 1024 || stored.key.extractable)
        throw new Error('Invalid envelope')
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv, additionalData: aad }, stored.key, stored.bytes)
      const copy = CopySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)))
      if (scopeKey(copy.scope) !== owner || copy.requestHash !== await paintCorrectionHash(copy.input)) throw new Error('Invalid scope or request')
      return copy
    } catch { throw new Error('The retained correction copy could not be read. It has been preserved.') }
  }
  const write = async (value: PaintCorrectionCopy) => {
    const copy = CopySchema.parse(value)
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12)), plain = new TextEncoder().encode(JSON.stringify(copy))
    if (plain.byteLength > 30 * 1024 * 1024) throw new Error('This correction copy is too large to retain safely.')
    const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain)
    await transact('readwrite', store => store.put({ key, iv, bytes }, owner))
    const retained = await read()
    if (!retained || JSON.stringify(retained) !== JSON.stringify(copy)) throw new Error('Correction recovery could not be verified. No request was started.')
    return retained
  }
  const same = (a: PaintCorrectionCopy | null, b: PaintCorrectionCopy) => a?.input.operationId === b.input.operationId && a?.requestHash === b.requestHash
  return {
    read,
    begin: (runId: string, input: PaintCorrectionInput, labourRatePerHr: number | null) => navigator.locks.request(`${DATABASE}:${owner}`, async () => {
      serialisePaintCorrection(input)
      if (await read()) throw new Error('Check the previous correction before saving another.')
      return write(CopySchema.parse({ version: 1, scope, runId, input, labourRatePerHr, requestHash: await paintCorrectionHash(input), attempts: 0, rejected: false }))
    }),
    markAttempt: (copy: PaintCorrectionCopy) => navigator.locks.request(`${DATABASE}:${owner}`, async () => {
      const retained = await read()
      if (!retained || !same(retained, copy) || retained.rejected) throw new Error('The retained correction changed. Check it again.')
      return write({ ...retained, attempts: retained.attempts + 1 })
    }),
    markInitialRejection: (copy: PaintCorrectionCopy) => navigator.locks.request(`${DATABASE}:${owner}`, async () => {
      const retained = await read()
      if (!retained || !same(retained, copy)) throw new Error('The retained correction changed. Check it again.')
      return retained.attempts === 1 ? write({ ...retained, rejected: true }) : retained
    }),
    complete: (copy: PaintCorrectionCopy) => navigator.locks.request(`${DATABASE}:${owner}`, async () => {
      const retained = await read()
      if (!retained) return // Another tab already verified this operation.
      if (retained.input.operationId !== copy.input.operationId || retained.requestHash !== copy.requestHash)
        throw new Error('The retained correction changed. Check it again.')
      await transact('readwrite', store => store.delete(owner))
      if (await read()) throw new Error('Correction recovery could not be cleared.')
    }),
  }
}
export function readBrowserPaintCorrectionStatus(body: unknown, copy: PaintCorrectionCopy) {
  const result = PaintCorrectionStatusSchema.parse(body)
  if (result.runId !== copy.runId || result.operationId !== copy.input.operationId || (result.status === 'applied' &&
    (result.requestHash !== copy.requestHash || result.expectedRevision !== copy.input.expectedRevision || result.extractionId !== copy.input.extractionId)))
    throw new Error('The correction result does not match the retained request.')
  return result
}
