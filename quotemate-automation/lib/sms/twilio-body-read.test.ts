import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sendSms } from './twilio'

// Phase 6 review fix: a body-read failure AFTER Twilio returns a Response must
// not be reported as a retryable NETWORK failure — otherwise the retry layer
// resends an already-delivered SMS (duplicate customer text). See twilio.ts
// res.text() guard.

const ENV = {
  TWILIO_ACCOUNT_SID: 'AC_test',
  TWILIO_AUTH_TOKEN: 'tok_test',
  TWILIO_PHONE_NUMBER: '+61480000000',
}

function fakeRes(status: number, textImpl: () => Promise<string>): Response {
  return { ok: status >= 200 && status < 300, status, text: textImpl } as unknown as Response
}

describe('postTwilioMessage — defensive body read (Phase 6 R46 review fix)', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    Object.assign(process.env, ENV)
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('treats a 2xx with an unreadable body as ACCEPTED (no resend signal)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeRes(201, () => Promise.reject(new Error('terminated: aborted'))),
    ) as unknown as typeof fetch
    const r = await sendSms({ to: '+61400000000', text: 'hi' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.status).toBe('accepted')
  })

  it('does NOT classify a 2xx body-read failure as the retryable NETWORK code', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeRes(200, () => Promise.reject(new Error('headers timeout'))),
    ) as unknown as typeof fetch
    const r = await sendSms({ to: '+61400000000', text: 'hi' })
    expect(r.ok).toBe(true) // ok:true can never be retried as a failed send
  })

  it('classifies a 4xx with an unreadable body as a terminal status code (not NETWORK)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeRes(400, () => Promise.reject(new Error('boom'))),
    ) as unknown as typeof fetch
    const r = await sendSms({ to: '+61400000000', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('400')
      expect(r.code).not.toBe('NETWORK')
    }
  })

  it('quarantines a 5xx with an unreadable body because provider acceptance is unknown', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeRes(503, () => Promise.reject(new Error('boom'))),
    ) as unknown as typeof fetch
    const r = await sendSms({ to: '+61400000000', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('AMBIGUOUS')
  })

  it('still returns the real sid on a normal 2xx with a readable JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeRes(201, () => Promise.resolve(JSON.stringify({ sid: 'SM123', status: 'queued', to: '+61400000000' }))),
    ) as unknown as typeof fetch
    const r = await sendSms({ to: '+61400000000', text: 'hi' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sid).toBe('SM123')
  })

  it('a pre-Response fetch throw cannot prove the request never reached the provider', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch
    const r = await sendSms({ to: '+61400000000', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('AMBIGUOUS')
  })
})
