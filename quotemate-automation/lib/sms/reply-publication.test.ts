import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DispatchResult } from './dispatch'
import { recordSmsReply } from './reply-publication'
describe('single transcript publisher across route reply branches',()=>{
  const client=()=>{const insert=vi.fn(async()=>({error:null}));return {db:{from:()=>({insert})} as unknown as SupabaseClient,insert}}
  it.each(['accepted','delivered','failed','unknown','retry'])('does not duplicate the outbox publication for %s',async(status)=>{
    const {db,insert}=client();await recordSmsReply(db,'c','reply',{ok:['accepted','delivered'].includes(status),status,outboxId:'out-1'} as DispatchResult)
    expect(insert).not.toHaveBeenCalled()
  })
  it('never represents an unsaved failed attempt as ordinary conversation',async()=>{
    const {db,insert}=client();await expect(recordSmsReply(db,'c','reply',{ok:false,smsAttempt:{code:'DB',reason:'down'},smsAttempts:0})).rejects.toThrow('durably queued');expect(insert).not.toHaveBeenCalled()
  })
  it('keeps accepted legacy adapter replies with actual provider evidence',async()=>{
    const {db,insert}=client();await recordSmsReply(db,'c','reply',{ok:true,channel:'sms',sid:'SM1',status:'delivered'})
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({body:'reply',twilio_message_sid:'SM1',delivery_status:'delivered'}))
  })
})
