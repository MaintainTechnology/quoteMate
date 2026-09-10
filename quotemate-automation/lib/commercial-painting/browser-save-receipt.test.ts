import { describe, expect, it, vi } from 'vitest'
import { createPaintSaveReceiptStore, paintSaveReceiptKey, readPaintRecoveryResult, readSavedPaintResult, type PaintSavePass } from './browser-save-receipt'

const scope = { userId: 'user_a', tenantId: '10000000-0000-4000-8000-000000000001' }
const pass: PaintSavePass = { paintRunId: '20000000-0000-4000-8000-000000000001', extractionId: '30000000-0000-4000-8000-000000000001', pricingProof: 'a'.repeat(64), pricedAt: '2026-09-09T10:00:00.000001Z' }
const saved = { ok: true, status: 'saved', ...pass, quoteId: '40000000-0000-4000-8000-000000000001', shareToken: 'saved_quote_token', quoteViewUrl: '/q/saved_quote_token', pdfUrl: '/api/q/saved_quote_token/pdf', delivery: { attempted: false }, alreadySaved: true }
function fixture() {
  const values = new Map<string, string>()
  const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }) }
  let tail: Promise<unknown> = Promise.resolve()
  const lock = <T>(_key: string, work: () => T): Promise<T> => { const next = tail.then(work); tail = next.catch(() => undefined); return next }
  const store = createPaintSaveReceiptStore(scope, storage, lock)
  return { values, storage, lock, store }
}
describe('opaque browser painting save recovery', () => {
  it('reopens the exact microsecond pass with no customer data, credentials or expiry', async () => {
    const f = fixture(); await f.store.begin(pass)
    expect(createPaintSaveReceiptStore(scope, f.storage, f.lock).read()).toEqual({ version: 1, scope, pass })
    expect([...f.values.values()][0]).toBe(JSON.stringify({ version: 1, scope, pass }))
    expect(f.store.read()?.pass.pricedAt).toBe('2026-09-09T10:00:00.000001Z')
  })
  it('isolates accounts and tenants and rejects forged persisted scope', async () => {
    const f = fixture(); await f.store.begin(pass)
    expect(createPaintSaveReceiptStore({ ...scope, userId: 'user_b' }, f.storage, f.lock).read()).toBeNull()
    const other = { ...scope, tenantId: '10000000-0000-4000-8000-000000000002' }
    expect(createPaintSaveReceiptStore(other, f.storage, f.lock).read()).toBeNull()
    f.values.set(paintSaveReceiptKey(other), [...f.values.values()][0])
    expect(() => createPaintSaveReceiptStore(other, f.storage, f.lock).read()).toThrow('another account')
  })
  it('preserves corruption and prevents a new write', async () => {
    const f = fixture(); f.values.set(paintSaveReceiptKey(scope), '{broken')
    await expect(f.store.begin(pass)).rejects.toThrow('retained')
    expect(f.values.get(paintSaveReceiptKey(scope))).toBe('{broken')
    expect(f.storage.setItem).not.toHaveBeenCalled()
  })
  it('does not overwrite an unknown older pass when another calculation is ready', async () => {
    const f = fixture(); await f.store.begin(pass)
    await expect(f.store.begin({ ...pass, pricedAt: '2026-09-09T10:00:00.000002Z' })).rejects.toThrow('previous')
    expect(f.store.read()?.pass).toEqual(pass)
  })
  it('serializes claims from two browser contexts', async () => {
    const f = fixture(); const second = createPaintSaveReceiptStore(scope, f.storage, f.lock)
    const results = await Promise.allSettled([f.store.begin(pass), second.begin({ ...pass, pricingProof: 'b'.repeat(64) })])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(f.store.read()?.pass).toEqual(pass)
  })
  it('fails closed for denied writes and silently dropped storage writes', async () => {
    const f = fixture(); f.storage.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    await expect(f.store.begin(pass)).rejects.toThrow('quota')
    f.storage.setItem.mockImplementationOnce(() => undefined)
    await expect(f.store.begin(pass)).rejects.toThrow('No save was started')
  })
  it('retains a committed receipt when its storage acknowledgement is lost', async () => {
    const f = fixture(); f.storage.setItem.mockImplementationOnce((key, value) => { f.values.set(key, value); throw new Error('ack lost') })
    await expect(f.store.begin(pass)).rejects.toThrow('ack lost')
    expect(f.store.read()?.pass).toEqual(pass)
  })
  it('clears only the same verified pass and detects failed removal', async () => {
    const f = fixture(); await f.store.begin(pass)
    await expect(f.store.complete({ ...pass, pricedAt: '2026-09-09T10:00:00.000002Z' })).rejects.toThrow('changed')
    f.storage.removeItem.mockImplementationOnce(() => undefined)
    await expect(f.store.complete(pass)).rejects.toThrow('could not be cleared')
    expect(f.store.read()?.pass).toEqual(pass)
    await f.store.complete(pass); expect(f.store.read()).toBeNull()
  })
  it('rejects customer fields in a persisted operation identity', async () => {
    const f = fixture(); await expect(f.store.begin({ ...pass, customerPhone: '0400000000' } as PaintSavePass)).rejects.toThrow()
    expect(f.storage.setItem).not.toHaveBeenCalled()
  })
  it('requires exact pass identity, quiet delivery and owned relative quote URLs', () => {
    expect(readSavedPaintResult(saved, pass).quoteId).toBe(saved.quoteId)
    for (const bad of [{ ...saved, pricingProof: 'b'.repeat(64) }, { ...saved, pricedAt: '2026-09-09T10:00:00.000000Z' },
      { ...saved, quoteViewUrl: 'https://other.invalid' }, { ...saved, pdfUrl: '//other.invalid/pdf' }, { ...saved, delivery: { attempted: true } }]) {
      expect(() => readSavedPaintResult(bad, pass)).toThrow()
    }
  })
  it('treats not_found as pending and refuses missing/foreign/ambiguous responses', () => {
    expect(readPaintRecoveryResult({ ok: true, status: 'not_found', ...pass }, pass)).toBeNull()
    expect(readPaintRecoveryResult(saved, pass)?.quoteId).toBe(saved.quoteId)
    for (const bad of [{ ok: true }, { ...saved, status: 'unknown' }, { ok: true, status: 'not_found', ...pass, extractionId: '30000000-0000-4000-8000-000000000002' }]) expect(() => readPaintRecoveryResult(bad, pass)).toThrow()
  })
})
