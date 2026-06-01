// MMS dispatch — sendSms MediaUrl plumbing + dispatchQuoteMessage media
// fallback. Stubs global fetch so no network is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendSms } from './twilio'
import { dispatchQuoteMessage } from './dispatch'

const ENV = { ...process.env }

function okResponse() {
  return new Response(JSON.stringify({ sid: 'SM_test', status: 'queued', to: '+61400000000', from: '+61481613464', body: 'x', error_code: null }), { status: 201 })
}
function twilioErrorResponse(code: number) {
  return new Response(JSON.stringify({ code, message: `twilio error ${code}` }), { status: 400 })
}

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = 'AC_test'
  process.env.TWILIO_AUTH_TOKEN = 'tok_test'
  process.env.TWILIO_PHONE_NUMBER = '+61481613464'
})
afterEach(() => {
  vi.unstubAllGlobals()
  process.env = { ...ENV }
})

/** Capture the URL-encoded request bodies fetch was called with. */
function bodyOf(call: unknown[]): string {
  const init = call[1] as { body?: string } | undefined
  return init?.body ?? ''
}

describe('sendSms — MediaUrl plumbing', () => {
  it('attaches a single MediaUrl to the Twilio request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const r = await sendSms({ to: '+61400000000', text: 'hi', mediaUrl: 'https://img.example/roof.png' })
    expect(r.ok).toBe(true)
    const body = bodyOf(fetchMock.mock.calls[0])
    expect(body).toContain('MediaUrl=')
    expect(decodeURIComponent(body)).toContain('https://img.example/roof.png')
  })

  it('attaches multiple MediaUrls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await sendSms({ to: '+61400000000', text: 'hi', mediaUrl: ['https://a/1.png', 'https://a/2.png'] })
    const body = decodeURIComponent(bodyOf(fetchMock.mock.calls[0]))
    expect(body.match(/MediaUrl=/g) ?? []).toHaveLength(2)
  })

  it('sends a plain SMS (no MediaUrl) when none provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    await sendSms({ to: '+61400000000', text: 'hi' })
    expect(bodyOf(fetchMock.mock.calls[0])).not.toContain('MediaUrl')
  })
})

describe('dispatchQuoteMessage — MMS with text-only fallback', () => {
  it('delivers an MMS and flags mms:true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const r = await dispatchQuoteMessage({ to: '+61400000000', text: 'roof quote https://q/abc', mediaUrl: 'https://img/roof.png' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.channel).toBe('sms')
      expect(r.mms).toBe(true)
      expect(r.mediaDropped).toBe(false)
    }
  })

  it('falls back to a plain SMS (link intact) when the MMS attempt fails', async () => {
    // First call carries MediaUrl → fail with non-retryable 12300.
    // Second call (no media) → succeed.
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body?: string }) => {
      const body = init?.body ?? ''
      if (body.includes('MediaUrl')) return Promise.resolve(twilioErrorResponse(12300))
      return Promise.resolve(okResponse())
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await dispatchQuoteMessage({ to: '+61400000000', text: 'roof quote https://q/abc', mediaUrl: 'https://img/roof.png' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.mediaDropped).toBe(true)
      expect(r.mms).toBe(false)
    }
    // The fallback send must NOT carry MediaUrl but must keep the link.
    const fallbackBody = decodeURIComponent(bodyOf(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]))
    expect(fallbackBody).not.toContain('MediaUrl')
    expect(fallbackBody).toContain('https://q/abc')
  })
})
