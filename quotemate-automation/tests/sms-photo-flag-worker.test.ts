import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { durableAfter, runSmsWorkBatch, withFencedSmsClient, type SmsWorkJob } from '@/lib/sms/durable-work'

// Actual Supabase query builders, fenced client and worker; only HTTP responses
// are fixtures. This isolates the ignored PATCH response in the photo callback.
describe('photo one-shot flag at the actual durable worker boundary', () => {
  it.each(['returned-error', 'transport-error'] as const)('retries an ignored %s before completing, then saves the flag', async (failure) => {
    const id = '11111111-1111-4111-8111-111111111111'
    const owner = '22222222-2222-4222-8222-222222222222'
    const conversationId = '33333333-3333-4333-8333-333333333333'
    const job: SmsWorkJob = { id, sequence: 1, work_key: 'inbound:SM-photo-flag', kind: 'inbound',
      serial_key: 'customer:photo', turn_id: id, tenant_id: null, owner_token: owner,
      status: 'running', attempts: 1, checkpoint: {}, result: null,
      payload: { url: 'https://offline-engine.invalid/api/sms/inbound', headers: {}, body: 'photo' } }
    const finishes: Record<string, unknown>[] = []
    const writes: Record<string, unknown>[] = []
    const requests: string[] = []
    let rejectWrite = true
    let savedAt: string | null = null
    const client = createClient('https://offline-database.invalid', 'fixture-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        expect(url.origin).toBe('https://offline-database.invalid')
        requests.push(`${init?.method} ${url.pathname}`)
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        if (url.pathname === '/rest/v1/rpc/claim_sms_work') return Response.json([job])
        if (url.pathname === '/rest/v1/rpc/assert_sms_work_owner') return Response.json(true)
        if (url.pathname === '/rest/v1/rpc/finish_sms_work') { finishes.push(body); return Response.json(true) }
        expect(url.pathname).toBe('/rest/v1/sms_conversations')
        expect(init?.method).toBe('PATCH')
        expect(url.searchParams.get('id')).toBe(`eq.${conversationId}`)
        expect(body).toMatchObject({ sms_work_id: id, sms_work_owner: owner, photo_request_sent_at: expect.any(String) })
        writes.push(body)
        if (rejectWrite) {
          if (failure === 'transport-error') throw new Error('Offline injected photo flag connection loss')
          return Response.json({ code: '08006', message: 'Offline injected photo flag failure' }, { status: 503 })
        }
        savedAt = String(body.photo_request_sent_at)
        return new Response(null, { status: 204 })
      } },
    })
    const fenced = withFencedSmsClient(client)
    const handler = async () => {
      durableAfter(async () => {
        // Same callback shape as the accepted photo branch: deliberately ignore
        // the returned PostgREST error, leaving the real fence to catch it.
        await fenced.from('sms_conversations').update({ photo_request_sent_at: '2026-09-09T00:00:00.000Z' }).eq('id', conversationId)
      })
      return Response.json({ ok: true })
    }
    expect(await runSmsWorkBatch({ inbound: handler }, { db: client, limit: 1 })).toEqual([{ id, ok: false }])
    expect(savedAt).toBeNull()
    expect(finishes).toHaveLength(1)
    expect(finishes[0]).toMatchObject({ p_id: id, p_owner: owner, p_error: expect.stringContaining('sms_conversations') })
    expect(finishes[0]).not.toHaveProperty('p_result')
    rejectWrite = false
    expect(await runSmsWorkBatch({ inbound: handler }, { db: client, limit: 1 })).toEqual([{ id, ok: true }])
    expect(savedAt).toBe('2026-09-09T00:00:00.000Z')
    expect(writes).toHaveLength(2)
    expect(finishes).toHaveLength(2)
    expect(finishes[1]).toMatchObject({ p_id: id, p_owner: owner, p_result: { status: 200, body: '{"ok":true}' } })
    expect(finishes[1]).not.toHaveProperty('p_error')
    expect(requests.filter(request => request === 'PATCH /rest/v1/sms_conversations')).toHaveLength(2)
  })
})
