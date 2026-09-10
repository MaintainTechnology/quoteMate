import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { outboxDb, processOutbound, recoverOutbound, type OutboxRow } from './durable-outbox'

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://outbox-database.invalid')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'offline-test-key')
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://quotemax.com.au')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function untilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  if (!signal) return new Promise(() => {})
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

describe('actual Supabase outbox client cancellation', () => {
  it('ends a hung recovery query at four seconds without SDK retries, allowing the next poll', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal)
      return untilAborted(init?.signal)
    })
    vi.stubGlobal('fetch', fetcher)
    const transport = vi.fn()
    const started = Date.now()
    await expect(recoverOutbound(transport)).rejects.toThrow('Outbox recovery database unavailable')
    expect(Date.now() - started).toBeGreaterThanOrEqual(3500)
    expect(signals[0]?.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(transport).not.toHaveBeenCalled()

    fetcher.mockImplementation(async () => Response.json([]))
    await expect(recoverOutbound(transport)).resolves.toEqual({ attempted: 0, reconciled: 0 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  }, 12000)

  it('retains the caller abort signal through the real SDK RPC', async () => {
    let entered!: (signal: AbortSignal) => void
    const fetchStarted = new Promise<AbortSignal>(resolve => { entered = resolve })
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      entered(init!.signal!)
      return untilAborted(init?.signal)
    })
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const request = Promise.resolve(outboxDb().rpc('sms_outbox_claim', { p_id: 'saved-intent' }).abortSignal(controller.signal))
    const fetchSignal = await fetchStarted
    controller.abort(new DOMException('Caller cancelled', 'AbortError'))
    const result = await request
    expect(result.error).toBeTruthy()
    expect(fetchSignal.aborted).toBe(true)
    expect(fetchSignal.reason).toBe(controller.signal.reason)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('preserves ambiguity and the saved intent when finishing an accepted send hangs', async () => {
    const row = { id: 'saved-intent', status: 'pending', payload: { to: '+61400000001', text: 'Saved quote' } } as OutboxRow
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/rpc/sms_outbox_claim')) return Promise.resolve(Response.json(row))
      expect(String(input)).toContain('/rpc/sms_outbox_finish')
      return untilAborted(init?.signal)
    })
    vi.stubGlobal('fetch', fetcher)
    const transport = vi.fn(async () => ({ ok: true as const, channel: 'sms' as const, sid: 'SMaccepted', status: 'queued' }))
    const result = await processOutbound(row, transport)
    expect(result).toMatchObject({ ok: false, outboxId: row.id, smsAttempt: { code: 'AMBIGUOUS' } })
    expect(transport).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(2)
  }, 12000)
})
