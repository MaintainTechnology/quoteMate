import {beforeEach,describe,it,expect,vi} from 'vitest'
const h=vi.hoisted(()=>{
  type Row=Record<string,unknown>
  const state={quote:{} as Row,intake:{} as Row,conversation:{} as Row,legacy:false,readError:false}
  const writes:Array<{table:string;row:Row}>=[]
  const queries:Array<{table:string;filters:Row}>=[]
  function from(table:string){
    let patch:Row|undefined;const filters:Row={};const q:Record<string,unknown>={}
    for(const method of ['select','order','limit'])q[method]=()=>q
    q.eq=(key:string,value:unknown)=>{filters[key]=value;return q};q.is=(key:string,value:unknown)=>{filters[key]=value;return q}
    q.update=(row:Row)=>{patch=row;return q}
    q.insert=(row:Row)=>{writes.push({table,row});throw new Error('A saved quote must not be inserted again')}
    function result(){
      queries.push({table,filters:{...filters}})
      if(patch){writes.push({table,row:patch});if(table==='quotes')state.quote={...state.quote,...patch};if(table==='sms_conversations')state.conversation={...state.conversation,...patch};return {data:{id:state.quote.id},error:null}}
      if(table==='quotes')return state.readError?{data:null,error:{message:'PGRST204'}}:{data:state.legacy&&Object.hasOwn(filters,'estimate_request_key')?null:state.quote,error:null}
      if(table==='sms_conversations')return {data:state.conversation,error:null}
      if(table==='intakes')return {data:state.intake,error:null}
      if(table==='tenants')return {data:{twilio_sms_number:'+61488888888'},error:null}
      return {data:null,error:null}
    }
    q.single=async()=>result();q.maybeSingle=async()=>result();q.then=(resolve:(r:unknown)=>unknown)=>Promise.resolve(result()).then(resolve)
    return q
  }
  return {state,writes,queries,client:{from},engine:vi.fn(),send:vi.fn(),handoff:vi.fn(),checkout:vi.fn()}
})
vi.mock('@supabase/supabase-js',()=>({createClient:()=>h.client}))
vi.mock('@/lib/sms/durable-work',()=>({currentSmsWork:()=>({jobId:'work-1',ownerToken:'owner-1',turnId:'turn-1'}),withFencedSmsClient:(db:unknown)=>db,
  assertSmsWorkOwnership:async()=>{},attributeSmsWorkTenant:async()=>{},smsWorkFetch:vi.fn(),durableAfter:vi.fn(),smsWorkCheckpoint:vi.fn(),enqueueSmsWork:vi.fn(),enqueueEstimateWork:vi.fn(),internalWorkPayload:vi.fn(),runSmsWorkNow:vi.fn()}))
vi.mock('@/lib/sms/work-delivery-context',()=>({smsDeliveryWorkScope:vi.fn()}))
vi.mock('@/lib/sms/delivery-context',()=>({updateSmsDeliveryContext:vi.fn()}))
vi.mock('@/lib/agents/cron',()=>({isCronAuthorised:()=>true}))
vi.mock('@/lib/estimate/run',()=>({runEstimation:h.engine}))
vi.mock('@/lib/log/pipeline',()=>({pipelineLog:()=>({step:vi.fn(),ok:vi.fn(),err:vi.fn(),done:vi.fn()})}))
vi.mock('@/lib/sms/dispatch',()=>({dispatchQuoteMessage:h.send}))
vi.mock('@/lib/sms/human-handoff',()=>({persistHumanHandoff:h.handoff}))
vi.mock('@/lib/stripe/checkout',()=>({createCheckoutSessionsForQuote:h.checkout,createInspectionCheckoutSession:h.checkout,generateShareToken:vi.fn()}))
vi.mock('@/lib/stripe/connect',()=>({connectDestinationForTenantId:vi.fn()}))
vi.mock('@/lib/quote/pdf',()=>({ensureQuotePdf:vi.fn(),quotePdfUrl:vi.fn(),signQuotePdfUrl:vi.fn()}))
vi.mock('@/lib/sms/send-quote-pdf',()=>({dispatchQuoteWithPdf:vi.fn()}))
vi.mock('@/lib/filestore/ingest-quote',()=>({archiveAndIngestQuote:vi.fn()}))
vi.mock('@/lib/ig-engine/generate',()=>({generatePreviewImage:vi.fn()}))
vi.mock('@/lib/ig-engine/samples',()=>({generateSampleImages:vi.fn()}))
import {POST} from './route'
const intakeId='11111111-1111-4111-8111-111111111111'
const quoteId='22222222-2222-4222-8222-222222222222'
const request=()=>new Request('https://quotemax.com.au/api/estimate/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intakeId})})
beforeEach(()=>{
  vi.clearAllMocks();h.writes.length=0;h.queries.length=0;h.state.legacy=false;h.state.readError=false
  h.state.quote={id:quoteId,intake_id:intakeId,tenant_id:'tenant-1',status:'draft',share_token:'saved_quote_token_123',total_inc_gst:3410,estimate_request_key:`initial:${intakeId}`}
  h.state.intake={id:intakeId,tenant_id:'tenant-1',trade:'electrical',caller:{phone:'+61411111111'},call_id:null}
  h.state.conversation={id:'conversation-1',intake_id:intakeId,tenant_id:'tenant-1',from_number:'+61411111111',quote_id:null,quote_stage:'estimate_pending',status:'structuring'}
  h.send.mockReset().mockResolvedValue({ok:true,outboxId:'saved-outbox'})
  h.handoff.mockReset().mockResolvedValue({id:'saved-task',notified:true})
})
describe('actual estimate POST resumes saved work without minting or recalculating a quote',()=>{
  it.each(['sent','accepted','paid'])('preserves the %s lifecycle and price without another send or human task',async(status)=>{
    h.state.quote.status=status
    h.state.conversation={...h.state.conversation,quote_id:quoteId,quote_stage:status,status:'done'}
    const response=await POST(request())
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({idempotent:true,quoteId,stage:status})
    expect(h.state.quote).toMatchObject({status,share_token:'saved_quote_token_123',total_inc_gst:3410})
    expect(h.writes).toHaveLength(0);expect(h.engine).not.toHaveBeenCalled();expect(h.checkout).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();expect(h.handoff).not.toHaveBeenCalled()
  })
  it('recovers a save-before-response crash into the same review task and status intent',async()=>{
    const first=await POST(request());expect(first.status).toBe(200);expect(await first.json()).toMatchObject({quoteId,stage:'awaiting_review'})
    const second=await POST(request());expect(second.status).toBe(200)
    expect(h.state.conversation).toMatchObject({quote_id:quoteId,quote_stage:'awaiting_review',status:'done'})
    expect(h.writes.filter((write)=>write.table==='sms_conversations')).toEqual([{table:'sms_conversations',row:{quote_id:quoteId,quote_stage:'awaiting_review',status:'done'}}])
    expect(h.state.quote).toMatchObject({status:'awaiting_tradie_approval',share_token:'saved_quote_token_123',total_inc_gst:3410})
    expect(h.writes.filter((write)=>write.table==='quotes')).toEqual([{table:'quotes',row:{status:'awaiting_tradie_approval'}}])
    expect(h.send.mock.calls.map((call)=>call[0].deliveryKey)).toEqual([`quote:${quoteId}:review-status`,`quote:${quoteId}:review-status`])
    expect(h.handoff).toHaveBeenCalledWith(expect.objectContaining({resourceId:quoteId,requestKey:`quote:${quoteId}:review`}))
    expect(h.send.mock.calls.every((call)=>!call[0].text.includes('saved_quote_token_123'))).toBe(true)
    expect(h.engine).not.toHaveBeenCalled();expect(h.checkout).not.toHaveBeenCalled()
  })
  it('adopts an existing legacy initial quote without choosing a changed child or generating another price',async()=>{
    h.state.legacy=true;h.state.quote.status='sent'
    const response=await POST(request());expect(response.status).toBe(200)
    expect(h.queries).toContainEqual({table:'quotes',filters:{intake_id:intakeId,parent_quote_id:null}})
    expect(h.engine).not.toHaveBeenCalled();expect(h.writes.filter((write)=>write.table==='quotes')).toHaveLength(0)
    expect(h.state.conversation).toMatchObject({quote_id:quoteId,quote_stage:'sent',status:'done'})
  })
  it('reports dependency errors as retryable instead of proceeding to estimation',async()=>{
    h.state.readError=true
    expect((await POST(request())).status).toBe(500)
    expect(h.engine).not.toHaveBeenCalled();expect(h.checkout).not.toHaveBeenCalled();expect(h.writes).toHaveLength(0)
  })
  it('retries a failed review task using the already-saved quote, without sending before the task exists',async()=>{
    h.handoff.mockRejectedValueOnce(new Error('Task persistence unavailable'))
    expect((await POST(request())).status).toBe(500);expect(h.send).not.toHaveBeenCalled()
    expect((await POST(request())).status).toBe(200)
    expect(h.state.quote.total_inc_gst).toBe(3410);expect(h.engine).not.toHaveBeenCalled()
  })
})


it.each(['approved','paid','cancelled'])('repairs a missing saved quote ID without demoting conversation stage %s', async (stage) => {
  h.state.conversation = {...h.state.conversation,quote_stage:stage,status:'done'}
  h.state.quote.status = stage === 'approved' ? 'awaiting_tradie_approval' : stage
  if (stage === 'approved') h.state.quote.customer_released_at = '2026-09-08'
  expect((await POST(request())).status).toBe(200)
  expect(h.state.conversation).toMatchObject({quote_id:quoteId,quote_stage:stage,status:'done'})
  expect(h.writes.filter((write)=>write.table==='sms_conversations')).toEqual([{table:'sms_conversations',row:{quote_id:quoteId}}])
  expect(h.send).not.toHaveBeenCalled()
})
