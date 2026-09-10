import { afterEach, beforeEach, describe,expect,it,vi } from 'vitest'
import twilio from 'twilio'
vi.mock('@/lib/sms/durable-outbox',()=>({recordDeliveryReceipt:vi.fn(async()=>true)}))
import { recordDeliveryReceipt } from '@/lib/sms/durable-outbox'
import { POST } from './route'
const url='https://quotemax.com.au/api/sms/status?outbox=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa&attempt=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const params={AccountSid:'AC'+'a'.repeat(32),MessageSid:'SM'+'b'.repeat(32),MessageStatus:'delivered',FutureProviderParameter:'preserve-for-signature'}
beforeEach(()=>{vi.stubEnv('PUBLIC_WEB_ORIGIN','https://quotemax.com.au');vi.stubEnv('TWILIO_AUTH_TOKEN','test-token');vi.stubEnv('TWILIO_ACCOUNT_SID',params.AccountSid);vi.mocked(recordDeliveryReceipt).mockClear()})
afterEach(()=>vi.unstubAllEnvs())
function request(signature?:string){return new Request(url,{method:'POST',body:new URLSearchParams(params),headers:signature?{'x-twilio-signature':signature}:{}})}
describe('provider delivery callback',()=>{
  it('validates the exact URL and every provider field before recording',async()=>{
    const signature=twilio.getExpectedTwilioSignature('test-token',url,params)
    expect((await POST(request(signature))).status).toBe(204)
    expect(recordDeliveryReceipt).toHaveBeenCalledWith(expect.objectContaining({sid:params.MessageSid,status:'delivered'}))
  })
  it('does not allow a forged receipt to mark a message delivered',async()=>{
    expect((await POST(request('forged'))).status).toBe(403)
    expect(recordDeliveryReceipt).not.toHaveBeenCalled()
  })
  it('returns failure when receipt storage fails, preserving a retry signal',async()=>{
    vi.mocked(recordDeliveryReceipt).mockRejectedValueOnce(new Error('db failed'))
    const signature=twilio.getExpectedTwilioSignature('test-token',url,params)
    expect((await POST(request(signature))).status).toBe(503)
  })
})
