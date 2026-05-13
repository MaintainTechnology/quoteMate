// Tests for the Vapi assistant provisioning helper.
//
// Same shape as provision.test.ts for Twilio: env flag flip + mocked
// fetch. Keeps every test hermetic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { provisionVapiAssistant } from './provision'

const SAMPLE_TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

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
  delete process.env.APP_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(process.env, ORIGINAL_ENV)
})

describe('provisionVapiAssistant — stub mode', () => {
  it('returns a deterministic stub assistantId starting with "vapi-stub-"', async () => {
    const result = await provisionVapiAssistant({
      tenantId: SAMPLE_TENANT,
      businessName: 'Acme',
      trade: 'electrical',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stubbed).toBe(true)
    expect(result.assistantId.startsWith('vapi-stub-')).toBe(true)
  })

  it('embeds the tenant prefix so different tenants get different stubs', async () => {
    const a = await provisionVapiAssistant({
      tenantId: '11111111-aaaa-bbbb-cccc-dddddddddddd',
      businessName: 'A',
      trade: 'electrical',
    })
    const b = await provisionVapiAssistant({
      tenantId: '99999999-aaaa-bbbb-cccc-dddddddddddd',
      businessName: 'B',
      trade: 'plumbing',
    })
    if (!a.ok || !b.ok) throw new Error('both should be ok')
    expect(a.assistantId).not.toBe(b.assistantId)
  })

  it('does not call fetch when stubbed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await provisionVapiAssistant({
      tenantId: SAMPLE_TENANT,
      businessName: 'X',
      trade: 'electrical',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('provisionVapiAssistant — real-API mode', () => {
  beforeEach(() => {
    process.env.VAPI_PROVISIONING_ENABLED = 'true'
  })

  it('returns ok=false when VAPI_API_KEY is missing', async () => {
    const result = await provisionVapiAssistant({
      tenantId: SAMPLE_TENANT,
      businessName: 'X',
      trade: 'electrical',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/VAPI_API_KEY/)
    }
  })

  it('creates the assistant and returns the Vapi id on success', async () => {
    process.env.VAPI_API_KEY = 'vapi-test-key'
    let capturedBody: any = null
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/assistant') && init?.method === 'POST') {
        capturedBody = JSON.parse(init.body as string)
        return makeFetchResponse(201, { id: 'asst_test_123' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await provisionVapiAssistant({
      tenantId: SAMPLE_TENANT,
      businessName: 'Acme Sparkies',
      trade: 'electrical',
      phoneNumber: '+61412000000',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stubbed).toBe(false)
    if (result.stubbed === false) {
      expect(result.assistantId).toBe('asst_test_123')
    }
    expect(capturedBody?.metadata?.tenant_id).toBe(SAMPLE_TENANT)
    expect(capturedBody?.metadata?.trade).toBe('electrical')
    expect(typeof capturedBody?.firstMessage).toBe('string')
    expect(capturedBody?.firstMessage).toContain('Acme Sparkies')
  })

  it('returns ok=false with the Vapi error message when the API call fails', async () => {
    process.env.VAPI_API_KEY = 'vapi-test-key'
    const fetchMock = vi.fn(async () =>
      makeFetchResponse(401, { message: 'Unauthorized' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await provisionVapiAssistant({
      tenantId: SAMPLE_TENANT,
      businessName: 'X',
      trade: 'plumbing',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/Unauthorized/)
    }
  })

  it('returns ok=false when Vapi response has no id', async () => {
    process.env.VAPI_API_KEY = 'vapi-test-key'
    const fetchMock = vi.fn(async () =>
      makeFetchResponse(201, { someOtherField: 'value' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await provisionVapiAssistant({
      tenantId: SAMPLE_TENANT,
      businessName: 'X',
      trade: 'electrical',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/missing id/i)
    }
  })

  it('builds a plumbing-specific first message when trade=plumbing', async () => {
    process.env.VAPI_API_KEY = 'vapi-test-key'
    let capturedBody: any = null
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}')
      return makeFetchResponse(201, { id: 'asst_plumb' })
    })
    vi.stubGlobal('fetch', fetchMock)

    await provisionVapiAssistant({
      tenantId: SAMPLE_TENANT,
      businessName: 'Peppers Plumbing',
      trade: 'plumbing',
    })
    expect(capturedBody.firstMessage).toContain('plumbing')
    expect(capturedBody.metadata.trade).toBe('plumbing')
  })
})
