// Tests for the Twilio number provisioning helper.
//
// Strategy: every external call (`fetch`) is mocked via vi.stubGlobal so
// we never touch the network. Env flags are flipped per-test to exercise
// both the stub-mode path and the live-API path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { provisionTwilioNumber } from './provision'

const SAMPLE_TENANT = '11111111-2222-3333-4444-555555555555'

function makeFetchResponse(status: number, body: unknown): Response {
  // Minimal Response-ish shape that matches what the lib actually uses.
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as Response
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  // Reset env to a known baseline.
  delete process.env.TWILIO_PROVISIONING_ENABLED
  delete process.env.TWILIO_ACCOUNT_SID
  delete process.env.TWILIO_AUTH_TOKEN
  delete process.env.TWILIO_ADDRESS_SID
  delete process.env.TWILIO_BUNDLE_SID
  delete process.env.APP_URL
  delete process.env.NEXT_PUBLIC_APP_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(process.env, ORIGINAL_ENV)
})

describe('provisionTwilioNumber — stub mode (env flag off)', () => {
  it('returns a deterministic stub number with the +614820xxxxx shape', async () => {
    const result = await provisionTwilioNumber({
      tenantId: SAMPLE_TENANT,
      friendlyName: 'Acme',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect('stubbed' in result && result.stubbed).toBe(true)
    expect(result.phoneNumber).toMatch(/^\+614820\d{5}$/)
  })

  it('produces the same stub number on repeated calls for the same tenant', async () => {
    const a = await provisionTwilioNumber({ tenantId: SAMPLE_TENANT, friendlyName: 'A' })
    const b = await provisionTwilioNumber({ tenantId: SAMPLE_TENANT, friendlyName: 'B' })
    if (!a.ok || !b.ok) throw new Error('both should be ok')
    expect(a.phoneNumber).toBe(b.phoneNumber)
  })

  it('produces different stub numbers for different tenants', async () => {
    const a = await provisionTwilioNumber({
      tenantId: '11111111-1111-1111-1111-111111111111',
      friendlyName: 'A',
    })
    const b = await provisionTwilioNumber({
      tenantId: '22222222-2222-2222-2222-222222222222',
      friendlyName: 'B',
    })
    if (!a.ok || !b.ok) throw new Error('both should be ok')
    expect(a.phoneNumber).not.toBe(b.phoneNumber)
  })

  it('does not call fetch when stubbed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await provisionTwilioNumber({ tenantId: SAMPLE_TENANT, friendlyName: 'X' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('provisionTwilioNumber — real-API mode preconditions', () => {
  beforeEach(() => {
    process.env.TWILIO_PROVISIONING_ENABLED = 'true'
  })

  it('returns ok=false when TWILIO_ACCOUNT_SID is missing', async () => {
    const result = await provisionTwilioNumber({ tenantId: SAMPLE_TENANT, friendlyName: 'X' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/TWILIO_ACCOUNT_SID|AUTH_TOKEN/)
    }
  })

  it('returns ok=false when TWILIO_AUTH_TOKEN is missing', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest'
    const result = await provisionTwilioNumber({ tenantId: SAMPLE_TENANT, friendlyName: 'X' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/AUTH_TOKEN/)
    }
  })

  it('returns ok=false when APP_URL is missing (webhooks would dangle)', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest'
    process.env.TWILIO_AUTH_TOKEN = 'tokentest'
    const result = await provisionTwilioNumber({ tenantId: SAMPLE_TENANT, friendlyName: 'X' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/APP_URL|NEXT_PUBLIC_APP_URL/)
    }
  })

  it('returns ok=false when TWILIO_ADDRESS_SID is missing (AU numbers need an address)', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest'
    process.env.TWILIO_AUTH_TOKEN = 'tokentest'
    process.env.APP_URL = 'https://quote-mate-rho.vercel.app'
    const result = await provisionTwilioNumber({ tenantId: SAMPLE_TENANT, friendlyName: 'X' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/TWILIO_ADDRESS_SID/)
    }
  })
})

describe('provisionTwilioNumber — real-API mode end-to-end (mocked fetch)', () => {
  beforeEach(() => {
    process.env.TWILIO_PROVISIONING_ENABLED = 'true'
    process.env.TWILIO_ACCOUNT_SID = 'ACtest'
    process.env.TWILIO_AUTH_TOKEN = 'tokentest'
    process.env.TWILIO_ADDRESS_SID = 'ADtest'
    process.env.APP_URL = 'https://quote-mate-rho.vercel.app'
  })

  it('walks the search order, purchases the first available number, and wires the webhooks', async () => {
    const purchasedNumber = '+61412345678'
    const callLog: { url: string; method: string; body?: string }[] = []

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      callLog.push({
        url,
        method: (init?.method as string) ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      // First attempt: Mobile + fax search → 0 results → continue
      if (url.includes('AvailablePhoneNumbers/AU/Mobile') && url.includes('FaxEnabled=true')) {
        return makeFetchResponse(200, { available_phone_numbers: [] })
      }
      // Second attempt: Local + fax search → 0 results → continue
      if (url.includes('AvailablePhoneNumbers/AU/Local') && url.includes('FaxEnabled=true')) {
        return makeFetchResponse(200, { available_phone_numbers: [] })
      }
      // Third attempt: Mobile (no fax) search → number found
      if (url.includes('AvailablePhoneNumbers/AU/Mobile')) {
        return makeFetchResponse(200, {
          available_phone_numbers: [{ phone_number: purchasedNumber }],
        })
      }
      // Purchase call after the third search succeeds
      if (url.includes('IncomingPhoneNumbers.json') && init?.method === 'POST') {
        return makeFetchResponse(201, {
          sid: 'PN-test-sid',
          phone_number: purchasedNumber,
          capabilities: { voice: true, sms: true, mms: true, fax: false },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await provisionTwilioNumber({
      tenantId: SAMPLE_TENANT,
      friendlyName: 'Acme — QuoteMate',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect('stubbed' in result && result.stubbed).toBe(false)
    if ('stubbed' in result && result.stubbed === false) {
      expect(result.phoneNumber).toBe(purchasedNumber)
      expect(result.twilioSid).toBe('PN-test-sid')
      expect(result.numberType).toBe('Mobile')
      expect(result.capabilities.fax).toBe(false)
      expect(result.faxAvailable).toBe(false)
    }

    // Confirm the purchase call attached the AddressSid + wired both webhooks
    const purchase = callLog.find((c) => c.method === 'POST')
    expect(purchase).toBeTruthy()
    expect(purchase!.body).toContain('AddressSid=ADtest')
    expect(purchase!.body).toContain('SmsUrl=')
    expect(purchase!.body).toContain('VoiceUrl=')
    expect(purchase!.body).toContain('api.vapi.ai%2Ftwilio%2Finbound_call')
    expect(purchase!.body).toContain('%2Fapi%2Fsms%2Finbound')
    expect(purchase!.body).toContain('FriendlyName=Acme')
  })

  it('returns ok=false with diagnostic when no AU number is available across all fallbacks', async () => {
    const fetchMock = vi.fn(async () =>
      makeFetchResponse(200, { available_phone_numbers: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await provisionTwilioNumber({
      tenantId: SAMPLE_TENANT,
      friendlyName: 'X',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/Could not provision an AU number/i)
      expect(result.reason).toMatch(/0 results/)
    }
    // Four search attempts: Mobile+fax, Local+fax, Mobile, Local
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('returns ok=false with Twilio error message when purchase fails (non-regulatory)', async () => {
    const purchasedNumber = '+61412345678'
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('AvailablePhoneNumbers')) {
        return makeFetchResponse(200, {
          available_phone_numbers: [{ phone_number: purchasedNumber }],
        })
      }
      if (url.includes('IncomingPhoneNumbers.json') && init?.method === 'POST') {
        return makeFetchResponse(403, {
          code: 20003,
          message: 'Authentication Error - No credentials provided',
        })
      }
      throw new Error('unexpected fetch')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await provisionTwilioNumber({
      tenantId: SAMPLE_TENANT,
      friendlyName: 'X',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/Authentication Error/i)
      expect(result.code).toBe('20003')
    }
  })
})
