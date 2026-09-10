// Ambiguous transport acceptance must resolve as a structured failure without duplicate sends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./durable-outbox', () => ({ dispatchDurably: (opts: object, send: (opts: object) => unknown) => send(opts) }))
import { dispatchQuoteMessage } from './dispatch'

const ENV = { ...process.env }

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = 'AC_test'
  process.env.TWILIO_AUTH_TOKEN = 'tok_test'
  process.env.TWILIO_PHONE_NUMBER = '+61481613464'
  process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  process.env = { ...ENV }
})

function okResponse() {
  return new Response(
    JSON.stringify({ sid: 'SM_ok', status: 'queued', to: '+61400000000', from: '+61481613464', body: 'x', error_code: null }),
    { status: 201 },
  )
}

describe('dispatchQuoteMessage — throw guard (never throws)', () => {
  it('treats a thrown AbortError as ambiguous and does not duplicate the send', async () => {
    const abort = () => {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      throw e
    }
    // First fetch throws AbortError; the retry succeeds.
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(abort)
      .mockResolvedValue(okResponse())
    vi.stubGlobal('fetch', fetchMock)

    const r = await dispatchQuoteMessage({ to: '+61400000000', text: 'quote https://q/abc' })
    expect(r).toMatchObject({ ok:false, smsAttempt:{code:'AMBIGUOUS'}, smsAttempts:1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  }, 15000)

  it('returns a DispatchFail (does not throw) when SMS throws every attempt and WhatsApp also throws', async () => {
    const boom = () => {
      const e = new Error('socket hang up')
      e.name = 'AbortError'
      throw e
    }
    const fetchMock = vi.fn().mockImplementation(boom)
    vi.stubGlobal('fetch', fetchMock)

    // Must RESOLVE to a fail, never reject.
    const r = await dispatchQuoteMessage({ to: '+61400000000', text: 'quote https://q/abc' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // SMS retried (AbortError is retryable) and WhatsApp was attempted.
      expect(r.smsAttempts).toBe(1)
      expect(r.waAttempt).toBeUndefined()
    }
  }, 15000)
})
