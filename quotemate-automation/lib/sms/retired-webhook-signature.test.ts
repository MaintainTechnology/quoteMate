import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import twilio from 'twilio'
import type { SupabaseClient } from '@supabase/supabase-js'

const enqueue = vi.hoisted(() => vi.fn())
vi.mock('./durable-work', () => ({ enqueueSmsWork: enqueue }))
import { flagRetiredSmsWebhook } from './retired-webhook'

const signedUrl = 'https://quotemax.com.au/api/sms/inbound?migration=1'
const params = { MessageSid: 'SMtestreceipt', From: '+61400111222', To: '+61400999888', Body: 'Quote please & resend' }
function database() {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { id: 'tenant' }, error: null }) }
  return { from: vi.fn(() => query) } as unknown as SupabaseClient
}
function request(body = params, url = signedUrl, forwarded = false) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilio.getExpectedTwilioSignature('offline-test-token', signedUrl, params),
      ...(forwarded ? { 'x-forwarded-host': 'quotemax.com.au', 'x-forwarded-proto': 'https' } : {}),
    },
    body: new URLSearchParams(body),
  })
}
beforeEach(() => { vi.stubEnv('TWILIO_AUTH_TOKEN', 'offline-test-token'); enqueue.mockReset().mockResolvedValue({ id: 'recovery-id' }) })
afterEach(() => vi.unstubAllEnvs())

describe('retired webhook real provider signature boundary', () => {
  it('accepts a correctly signed receipt through the actual validator', async () => {
    const response = await flagRetiredSmsWebhook(request(), database())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ recoveryId: 'recovery-id' })
    expect(enqueue).toHaveBeenCalledOnce()
  })
  it('validates the original proxy URL including its query', async () => {
    const response = await flagRetiredSmsWebhook(request(params, 'http://internal:3000/api/sms/inbound?migration=1', true), database())
    expect(response.status).toBe(503)
    expect(enqueue).toHaveBeenCalledOnce()
  })
  it.each(['body', 'url'] as const)('rejects a tampered %s before database or queue writes', async (field) => {
    const db = database()
    const response = await flagRetiredSmsWebhook(field === 'body'
      ? request({ ...params, Body: 'changed message' })
      : request(params, 'https://quotemax.com.au/api/sms/inbound?migration=2'), db)
    expect(response.status).toBe(403)
    expect(db.from).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })
})
