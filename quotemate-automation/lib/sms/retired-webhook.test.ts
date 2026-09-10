import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const h=vi.hoisted(()=>({validate:vi.fn(),enqueue:vi.fn()}))
vi.mock('./twilio-validator',()=>({parseTwilioForm:(body:string)=>Object.fromEntries(new URLSearchParams(body)),validateTwilioSignature:h.validate}))
vi.mock('./durable-work',()=>({enqueueSmsWork:h.enqueue}))
import { flagRetiredSmsWebhook } from './retired-webhook'
function database(error:unknown=null){const b={select:()=>b,eq:()=>b,maybeSingle:async()=>({data:{id:'tenant-1'},error})};return {from:vi.fn(()=>b)} as unknown as SupabaseClient}
const request=()=>new Request('https://quotemax.com.au/api/sms/inbound',{method:'POST',headers:{'x-twilio-signature':'signed','authorization':'never-persist-me'},body:'MessageSid=SM123&From=%2B61400111222&To=%2B61400999888&Body=Quote+please'})
beforeEach(()=>{vi.clearAllMocks();h.validate.mockReturnValue(true);h.enqueue.mockResolvedValue({id:'work-1'})})
describe('retired webhook operational signal',()=>{
  it('rejects invalid signatures before database IO',async()=>{h.validate.mockReturnValue(false);const db=database();expect((await flagRetiredSmsWebhook(request(),db)).status).toBe(403);expect(db.from).not.toHaveBeenCalled();expect(h.enqueue).not.toHaveBeenCalled()})
  it('durably records the signed receipt with its tenant, without persisting request credentials',async()=>{
    const result=await flagRetiredSmsWebhook(request(),database());expect(result.status).toBe(503);expect(await result.json()).toMatchObject({recoveryId:'work-1'})
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({key:'retired:+61400999888:SM123',tenantId:'tenant-1',serviceKey:'retired-platform',payload:expect.objectContaining({headers:{'content-type':'application/x-www-form-urlencoded'}})}),expect.anything())
  })
  it('never returns a success ACK when recovery persistence is down',async()=>{h.enqueue.mockRejectedValue(new Error('database down'));const result=await flagRetiredSmsWebhook(request(),database());expect(result.status).toBe(503);expect(await result.json()).not.toHaveProperty('recoveryId')})
})
