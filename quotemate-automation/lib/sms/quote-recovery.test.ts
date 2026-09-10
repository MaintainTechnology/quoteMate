import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const h=vi.hoisted(()=>({handoff:vi.fn(),dispatch:vi.fn(),context:vi.fn()}))
vi.mock('./human-handoff',()=>({persistHumanHandoff:h.handoff}))
vi.mock('./dispatch',()=>({dispatchQuoteMessage:h.dispatch}))
vi.mock('./delivery-context',()=>({updateSmsDeliveryContext:h.context}))
import { resumeSavedSmsQuote } from './quote-recovery'

function database(rows: Array<{data: unknown; error?: unknown}>) {
  const operations: Array<{table:string; filters:unknown[]; update?:unknown}> = []
  const db={from:(table:string)=>{
    const record={table,filters:[] as unknown[],update:undefined as unknown};operations.push(record)
    const b={select:()=>b,eq:(...args:unknown[])=>{record.filters.push(args);return b},single:()=>b,maybeSingle:()=>b,
      is:(...args:unknown[])=>{record.filters.push(args);return b},
      update:(value:unknown)=>{record.update=value;return b},then:(resolve:(value:unknown)=>unknown)=>Promise.resolve(rows.shift() ?? {data:null,error:null}).then(resolve)}
    return b
  }} as unknown as SupabaseClient
  return {db,operations}
}
const quote={id:'quote-1',tenant_id:'tenant-1',status:'awaiting_tradie_approval',share_token:'saved-token'}
beforeEach(()=>{vi.clearAllMocks();h.handoff.mockResolvedValue({id:'task-1',notified:true});h.dispatch.mockResolvedValue({ok:true,outboxId:'out-1'})})
describe('saved quote replay',()=>{
  it('does not request approval again while an already approved send is pending recovery',async()=>{
    const {db}=database([{data:{...quote,customer_released_at:'2026-09-08'}}])
    expect(await resumeSavedSmsQuote(db,quote.id,'intake-1')).toEqual({quoteId:quote.id,stage:'approved'})
    expect(h.handoff).not.toHaveBeenCalled();expect(h.dispatch).not.toHaveBeenCalled()
  })
  it.each(['sent','accepted','paid','booked','expired','cancelled'])('never demotes or sends again for %s',async(status)=>{
    const {db,operations}=database([{data:{...quote,status}}])
    expect(await resumeSavedSmsQuote(db,quote.id,'intake-1')).toEqual({quoteId:quote.id,stage:status})
    expect(operations).toHaveLength(2);expect(h.handoff).not.toHaveBeenCalled();expect(h.dispatch).not.toHaveBeenCalled()
  })
  it('uses the stored owner, customer, resource and stable status intent on recovery',async()=>{
    const make=()=>database([{data:quote},{data:{id:'conversation-1',from_number:'+61400111222',quote_id:'quote-1',quote_stage:'awaiting_review',status:'done'}},{data:{caller:null,call_id:null,trade:'electrical'}},{data:{twilio_sms_number:'+61400999888'}}]).db
    await resumeSavedSmsQuote(make(),quote.id,'intake-1');await resumeSavedSmsQuote(make(),quote.id,'intake-1')
    expect(h.context).toHaveBeenCalledWith({tenantId:'tenant-1',conversationId:'conversation-1'})
    expect(h.handoff).toHaveBeenCalledWith(expect.objectContaining({tenantId:'tenant-1',requestKey:'quote:quote-1:review',resourceId:'quote-1'}))
    expect(h.dispatch.mock.calls.map(([o])=>o.deliveryKey)).toEqual(['quote:quote-1:review-status','quote:quote-1:review-status'])
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({to:'+61400111222',from:'+61400999888',conversationId:'conversation-1'}))
  })
  it('propagates a missing durable owner task without asserting customer progress',async()=>{
    h.handoff.mockRejectedValue(new Error('Could not persist review task'))
    const {db}=database([{data:quote},{data:{id:'c',from_number:'+61400111222',quote_id:'quote-1',quote_stage:'awaiting_review',status:'done'}},{data:{trade:'plumbing'}}])
    await expect(resumeSavedSmsQuote(db,quote.id,'i')).rejects.toThrow('persist review task')
    expect(h.dispatch).not.toHaveBeenCalled()
  })
  it('cannot overwrite a tradie release racing a legacy draft transition',async()=>{
    const {db,operations}=database([{data:{...quote,status:'draft'}},{data:null}])
    expect(await resumeSavedSmsQuote(db,quote.id,'i')).toMatchObject({stage:'updated_by_owner'})
    expect(operations.find((op)=>op.update)?.filters).toContainEqual(['status','draft']);expect(operations.find((op)=>op.update)?.filters).toContainEqual(['customer_released_at',null]);expect(h.dispatch).not.toHaveBeenCalled()
  })
  it('keeps a failed review-status enqueue recoverable',async()=>{
    h.dispatch.mockResolvedValue({ok:false})
    const {db}=database([{data:quote},{data:{id:'c',from_number:'+61400111222',quote_id:'quote-1',quote_stage:'awaiting_review',status:'done'}},{data:{trade:'plumbing'}},{data:{twilio_sms_number:'+61400999888'}}])
    await expect(resumeSavedSmsQuote(db,quote.id,'i')).rejects.toThrow('could not be queued')
  })
})
