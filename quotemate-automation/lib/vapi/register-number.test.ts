// Tests for registerNumberWithVapi — the link that ties the purchased
// Twilio number to the just-created Vapi assistant.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerNumberWithVapi } from './register-number'

function makeFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as Response
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  delete process.env.VAPI_PROVISIONING_ENABLED
  delete process.env.VAPI_API_KEY
  delete process.env.TWILIO_ACCOUNT_SID
  delete process.env.TWILIO_AUTH_TOKEN
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(process.env, ORIGINAL_ENV)
})

describe('registerNumberWithVapi — stub mode', () => {
  it('returns stubbed=true when env flag is off', async () => {
    const result = await registerNumberWithVapi({
      phoneNumber: '+61412000000',
      assistantId: 'asst_x',
      name: 'X',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect('stubbed' in result && result.stubbed).toBe(true)
  })

  it('does not call fetch when stubbed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await registerNumberWithVapi({
      phoneNumber: '+61412000000',
      assistantId: 'asst_x',
      name: 'X',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('registerNumberWithVapi — real-API mode', () => {
  beforeEach(() => {
    process.env.VAPI_PROVISIONING_ENABLED = 'true'
  })

  it('returns ok=false when VAPI_API_KEY missing', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest'
    process.env.TWILIO_AUTH_TOKEN = 'tokentest'
    const result = await registerNumberWithVapi({
      phoneNumber: '+61412000000',
      assistantId: 'asst_x',
      name: 'X',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/VAPI_API_KEY/)
    }
  })

  it('returns ok=false when Twilio creds missing (Vapi needs them to relay)', async () => {
    process.env.VAPI_API_KEY = 'vapi-test'
    const result = await registerNumberWithVapi({
      phoneNumber: '+61412000000',
      assistantId: 'asst_x',
      name: 'X',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/TWILIO_ACCOUNT_SID|AUTH_TOKEN/)
    }
  })

  it('posts the assistantId + number to /phone-number and returns the id', async () => {
    process.env.VAPI_API_KEY = 'vapi-test'
    process.env.TWILIO_ACCOUNT_SID = 'ACtest'
    process.env.TWILIO_AUTH_TOKEN = 'tokentest'

    let capturedBody: any = null
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/phone-number') && init?.method === 'POST') {
        capturedBody = JSON.parse(init.body as string)
        return makeFetchResponse(201, { id: 'pn_test_123' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await registerNumberWithVapi({
      phoneNumber: '+61412345678',
      assistantId: 'asst_abc',
      name: 'Acme — QuoteMate',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect('stubbed' in result && result.stubbed === false).toBe(true)
    if ('stubbed' in result && result.stubbed === false) {
      expect(result.vapiPhoneNumberId).toBe('pn_test_123')
    }
    expect(capturedBody.number).toBe('+61412345678')
    expect(capturedBody.assistantId).toBe('asst_abc')
    expect(capturedBody.provider).toBe('twilio')
    expect(capturedBody.twilioAccountSid).toBe('ACtest')
  })

  it('returns ok=false with API message on Vapi failure', async () => {
    process.env.VAPI_API_KEY = 'vapi-test'
    process.env.TWILIO_ACCOUNT_SID = 'ACtest'
    process.env.TWILIO_AUTH_TOKEN = 'tokentest'

    const fetchMock = vi.fn(async () =>
      makeFetchResponse(400, { message: 'Number already registered' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await registerNumberWithVapi({
      phoneNumber: '+61412345678',
      assistantId: 'asst_abc',
      name: 'X',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/already registered/)
    }
  })
})
