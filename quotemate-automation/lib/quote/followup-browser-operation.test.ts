import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserFollowupOperations } from './followup-browser-operation'
import type { FollowupOperation } from './followup-operation-contract'

const tenant = randomUUID(), quote = randomUUID(), outbox = randomUUID(), event = randomUUID()
const jwt = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub, iss: 'https://fixture.clerk.accounts.dev' })).toString('base64url')}.signature`
let token: string | null, tenantId: string, entries: Map<string,string>, op: FollowupOperation | null
let losePost: boolean, malformedGet: boolean, beforeReturn: (() => void) | null
let posts: Record<string, unknown>[], reads: string[], prompt: ReturnType<typeof vi.fn<(message: string) => boolean>>
const payload = { quoteId: quote, text: 'Private customer follow-up', expectedRecipient: '+61411111111' }
const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) } }
const lock = async <T>(_key: string, task: () => Promise<T>) => task()
const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input)
  if (path === '/api/tenant/me') return Response.json({ tenant: { id: tenantId } })
  if (init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as Record<string,unknown>; posts.push(body)
    expect(entries.size).toBeGreaterThan(0)
    op = { ok: true, requestId: String(body.requestId), action: body.kind === 'note' ? 'note' : 'text', target: { kind: 'quote', id: quote },
      status: 'unknown', accepted: false, history: 'pending', eventId: null, outboxId: outbox, providerSid: null, message: 'Outcome unknown.' }
    if (losePost) throw new Error('Response lost after commit')
    beforeReturn?.()
    return Response.json(op)
  }
  reads.push(path)
  const requestId = new URL(path, 'https://fixture.test').searchParams.get('requestId')!
  if (malformedGet) return Response.json({ ok: true })
  return Response.json(op ?? { ok: true, requestId, action: 'text', target: { kind: 'quote', id: quote }, status: 'not_found', accepted: false,
    history: 'not_applicable', eventId: null, outboxId: null, providerSid: null, message: 'No saved operation.' })
})
const client = (signal?: AbortSignal) => createBrowserFollowupOperations({ getToken: async () => token, fetch: transport, storage, lock, confirm: prompt, signal })
beforeEach(() => {
  token = jwt('user_a'); tenantId = tenant; entries = new Map(); op = null; posts = []; reads = []
  losePost = false; malformedGet = false; beforeReturn = null; prompt = vi.fn(() => true); transport.mockClear()
})
function complete() {
  op = { ...op!, accepted: true, status: 'complete', history: 'complete', eventId: event, outboxId: outbox, providerSid: 'SM' + '1'.repeat(32), message: 'Provider accepted; history saved.' }
}
describe('browser follow-up opaque receipt and recovery', () => {
  it('stores an opaque durable receipt before POST, with no body, phone, token or tenant in storage', async () => {
    await client().submit('text', payload)
    const saved = [...entries.entries()].flat().join(' ')
    expect(saved).not.toContain(payload.text); expect(saved).not.toContain(payload.expectedRecipient)
    expect(saved).not.toContain(token!); expect(saved).not.toContain(tenant); expect(saved).not.toContain(quote)
    expect(posts[0].requestId).toBe(JSON.parse([...entries.values()][0]).requestId)
  })
  it('reopens via GET only after the POST response is lost', async () => {
    losePost = true; await expect(client().submit('text', payload)).rejects.toThrow('Response lost')
    expect((await client().recover('text', { quoteId: quote }))?.status).toBe('unknown')
    expect(posts).toHaveLength(1); expect(reads).toHaveLength(1)
  })
  it('explicit retry keeps the same request ID and first reads authoritative status', async () => {
    await client().submit('text', payload); await client().submit('text', payload)
    expect(posts).toHaveLength(2); expect(posts[0].requestId).toBe(posts[1].requestId); expect(reads).toHaveLength(1)
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('same saved request'))
  })
  it('rejects changed text while an unknown receipt exists', async () => {
    await client().submit('text', payload)
    await expect(client().submit('text', { ...payload, text: 'Replacement' })).rejects.toThrow('draft differs')
    expect(posts).toHaveLength(1); expect(entries.size).toBe(1)
  })
  it('never treats not_found as authorization to discard the saved request', async () => {
    await client().submit('text', payload); op = null
    const old = posts[0].requestId
    await client().submit('text', payload)
    expect(posts[1].requestId).toBe(old)
  })
  it('requires an explicit new action after terminal evidence, and cancellation preserves the draft/receipt', async () => {
    await client().submit('text', payload); complete(); prompt.mockReturnValue(false)
    await expect(client().submit('text', { ...payload, text: 'New private draft' })).rejects.toThrow('draft is unchanged')
    expect(posts).toHaveLength(1)
    prompt.mockReturnValue(true)
    await client().submit('text', { ...payload, text: 'New private draft' })
    expect(posts[1].requestId).not.toBe(posts[0].requestId)
  })
  it('blocks a malformed status response without changing the receipt or sending again', async () => {
    await client().submit('text', payload); const before = [...entries.values()][0]; malformedGet = true
    await expect(client().submit('text', payload)).rejects.toThrow('could not be verified')
    expect(posts).toHaveLength(1); expect([...entries.values()][0]).toBe(before)
  })
  it('does not overwrite a corrupted receipt', async () => {
    await client().submit('text', payload); const key = [...entries.keys()][0]; entries.set(key, '{"broken":true}')
    await expect(client().submit('text', payload)).rejects.toThrow('could not be read')
    expect(entries.get(key)).toBe('{"broken":true}'); expect(posts).toHaveLength(1)
  })
  it('fails before POST if durable storage rejects a receipt', async () => {
    const instance = createBrowserFollowupOperations({ getToken: async () => token, fetch: transport,
      storage: { ...storage, setItem: () => { throw new Error('Storage unavailable') } }, lock, confirm: prompt })
    await expect(instance.submit('text', payload)).rejects.toThrow('Storage unavailable'); expect(posts).toHaveLength(0)
  })
  it('keeps receipts isolated across accounts and never exposes a late prior-account response', async () => {
    beforeReturn = () => { token = jwt('user_b') }
    await expect(client().submit('text', payload)).rejects.toThrow('account changed')
    beforeReturn = null
    expect(await client().recover('text', { quoteId: quote })).toBeNull(); expect(reads).toHaveLength(0)
    token = jwt('user_a'); expect((await client().recover('text', { quoteId: quote }))?.status).toBe('unknown')
  })
  it('suppresses a late response when the same account moved to a different tenant', async () => {
    beforeReturn = () => { tenantId = randomUUID() }
    await expect(client().submit('text', payload)).rejects.toThrow('business changed')
    expect(entries.size).toBe(1)
  })
  it('aborts publication after unmount while retaining the operation identity', async () => {
    const controller = new AbortController(); beforeReturn = () => controller.abort()
    await expect(client(controller.signal).submit('text', payload)).rejects.toThrow()
    expect(entries.size).toBe(1)
  })
  it('rejects foreign target or incomplete accepted evidence in readback', async () => {
    await client().submit('text', payload); complete(); op!.target.id = randomUUID()
    await expect(client().recover('text', { quoteId: quote })).rejects.toThrow('could not be verified')
    op!.target.id = quote; op!.providerSid = null
    await expect(client().recover('text', { quoteId: quote })).rejects.toThrow('could not be verified')
  })
  it.each(['unknown', 'pending', 'not_found', 'failed'] as const)('rejects contradictory %s plus complete history without replacing an unknown receipt', async status => {
    await client().submit('text', payload); const before = [...entries.values()][0]
    op = { ...op!, status, history: 'complete', accepted: false, eventId: null, outboxId: null, providerSid: null }
    await expect(client().submit('text', payload)).rejects.toThrow('could not be verified')
    expect([...entries.values()][0]).toBe(before); expect(posts).toHaveLength(1); expect(prompt).not.toHaveBeenCalled()
  })
  it('rejects failed status with accepted evidence as permission to replace a receipt', async () => {
    await client().submit('text', payload); const before = [...entries.values()][0]; complete(); op!.status = 'failed'
    await expect(client().submit('text', payload)).rejects.toThrow('could not be verified')
    expect([...entries.values()][0]).toBe(before); expect(posts).toHaveLength(1)
  })
  it('canonicalizes uppercase browser targets for submit, receipt partition and recovery', async () => {
    await client().submit('text', { ...payload, quoteId: quote.toUpperCase() })
    expect((await client().recover('text', { quoteId: quote }))?.status).toBe('unknown')
    await client().submit('text', payload)
    expect(posts[1].requestId).toBe(posts[0].requestId); expect(entries.size).toBe(1)
  })
})
