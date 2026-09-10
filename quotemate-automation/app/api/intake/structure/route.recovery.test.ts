import {beforeEach,describe,it,expect,vi} from 'vitest'
const h=vi.hoisted(()=>{
  type Row=Record<string,unknown>
  type Job={id:string;key:string;payload:{url:string;body:string};checkpoint:Record<string,unknown>;callbacks:Array<()=>Promise<unknown>>;result?:{status:number;body:string}}
  const state={conversation:{} as Row,intake:null as Row|null,quote:null as Row|null,messages:[] as Row[],latest:'msg-1',context:null as Job|null,failLink:false}
  const jobs=new Map<string,Job>();const writes:Array<{table:string;op:string;row:Row}>=[]
  function from(table:string){
    let op='select';let payload:Row={};let fields='*';const filters:Row={}
    const q:Record<string,unknown>={}
    q.select=(value='*')=>{fields=value;return q}
    for(const method of ['order','limit','or','is'])q[method]=()=>q
    q.eq=(key:string,value:unknown)=>{filters[key]=value;return q}
    for(const method of ['insert','update','upsert'])q[method]=(row:Row)=>{op=method;payload=row;return q}
    function result(){
      if(op!=='select'){
        writes.push({table,op,row:payload})
        if(table==='sms_conversations'){
          if(state.failLink)return {data:null,error:{message:'write refused'}}
          state.conversation={...state.conversation,...payload}
        }
        if(table==='intakes')state.intake={...state.intake,...payload,id:'11111111-1111-4111-8111-111111111111'}
        return {data:table==='intakes'?state.intake:null,error:null}
      }
      if(table==='sms_messages')return {data:fields==='id,twilio_message_sid'?{id:state.latest}:state.messages,error:null}
      if(table==='sms_conversations')return {data:state.conversation,error:null}
      if(table==='intakes')return {data:state.intake,error:null}
      if(table==='quotes')return {data:state.quote,error:null}
      if(table==='tenants')return {data:{twilio_sms_number:'+61488888888'},error:null}
      return {data:null,error:null}
    }
    q.single=async()=>result();q.maybeSingle=async()=>result();q.then=(resolve:(r:unknown)=>unknown)=>Promise.resolve(result()).then(resolve)
    return q
  }
  const client={from}
  return {state,jobs,writes,client,structure:vi.fn(),estimate:vi.fn(),send:vi.fn(),
    enqueue:vi.fn(async(input:{key:string;payload:Job['payload']})=>{
      if(!jobs.has(input.key))jobs.set(input.key,{id:`work-${jobs.size+1}`,key:input.key,payload:input.payload,checkpoint:{},callbacks:[]})
      return jobs.get(input.key)!
    }),
    run:async(job:Job,handler:(r:Request)=>Promise<Response>)=>{
      if(job.result)return new Response(job.result.body,{status:job.result.status,headers:{'content-type':'application/json'}})
      state.context=job;job.callbacks=[]
      try{const response=await handler(new Request(job.payload.url,{method:'POST',headers:{'content-type':'application/json'},body:job.payload.body}));const text=await response.text();for(const callback of job.callbacks)await callback();if(response.ok)job.result={body:text,status:response.status};return new Response(text,{status:response.status,headers:{'content-type':'application/json'}})}finally{state.context=null}
    },
  }
})
vi.mock('@supabase/supabase-js',()=>({createClient:()=>h.client}))
vi.mock('@/lib/sms/durable-work',()=>({
  currentSmsWork:()=>h.state.context ? {jobId:h.state.context.id,ownerToken:'owner-1',turnId:'turn-1'} : undefined,
  withFencedSmsClient:(db:unknown)=>db,assertSmsWorkOwnership:async()=>{},attributeSmsWorkTenant:async()=>{},smsWorkFetch:vi.fn(),
  durableAfter:(fn:()=>Promise<unknown>)=>h.state.context!.callbacks.push(fn),
  smsWorkCheckpoint:async(key:string,fn:()=>Promise<unknown>)=>{const values=h.state.context!.checkpoint;if(!Object.hasOwn(values,key))values[key]=await fn();return values[key]},
  enqueueSmsWork:h.enqueue,runSmsWorkNow:h.run,enqueueEstimateWork:h.estimate,
  internalWorkPayload:(path:string,body:unknown)=>({url:`https://quotemax.com.au${path}`,body:JSON.stringify(body)}),
}))
vi.mock('@/lib/sms/work-delivery-context',()=>({smsDeliveryWorkScope:vi.fn()}))
vi.mock('@/lib/sms/delivery-context',()=>({updateSmsDeliveryContext:vi.fn()}))
vi.mock('@/lib/agents/cron',()=>({isCronAuthorised:()=>true}))
vi.mock('@/lib/intake/structure',()=>({structureIntake:h.structure}))
vi.mock('@/lib/intake/embed',()=>({embedIntake:async()=>[0.1]}))
vi.mock('@/lib/intake/job-type-reconcile',()=>({reconcileJobType:()=>({agreement:'agree'})}))
vi.mock('@/lib/util/retry',()=>({withRetry:(fn:()=>Promise<unknown>)=>fn()}))
vi.mock('@/lib/log/pipeline',()=>({pipelineLog:()=>({step:vi.fn(),ok:vi.fn(),err:vi.fn(),done:vi.fn()})}))
vi.mock('@/lib/customers/lookup',()=>({findOrCreateCustomer:async()=>null,updateCustomerFromIntake:async()=>{}}))
vi.mock('@/lib/push/events',()=>({enqueuePushEvent:async()=>true}))
vi.mock('@/lib/sms/dispatch',()=>({dispatchQuoteMessage:h.send}))
vi.mock('@/lib/sms/outbound-from',()=>({resolveOutboundFromNumber:()=>'+61488888888'}))
import {POST} from './route'
const intake=(usable:boolean)=>({trade:'electrical',job_type:'power_points',address:null,suburb:usable?'Sydney':null,scope:{description:usable?'Install 2 outdoor power points':'',item_count:usable?2:null},access:{},property:{},risks:[],inspection_required:false,caller:{name:'Sam',phone:'+61411111111'},timing:{},confidence:usable?'HIGH':'LOW',confidence_reason:'Customer facts'})
const request=()=>new Request('https://quotemax.com.au/api/intake/structure',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId:'conversation-1',sourceChannel:'sms'})})
beforeEach(()=>{
  vi.clearAllMocks();h.jobs.clear();h.writes.length=0;h.state.context=null;h.state.intake=null;h.state.quote=null;h.state.failLink=false;h.state.latest='msg-1'
  h.state.messages=[{id:'msg-1',direction:'inbound',body:'Hi',created_at:'2026-09-08T00:00:00Z'}]
  h.state.conversation={id:'conversation-1',tenant_id:'tenant-1',status:'open',intake_id:null,from_number:'+61411111111',conversation_state:{slots:{}},photo_urls:[],photo_paths:[],assumptions_made:[],lead_push_sent_at:'2026-09-08'}
  h.structure.mockReset();h.estimate.mockReset().mockResolvedValue({id:'estimate-1'});h.send.mockReset().mockResolvedValue({ok:true,channel:'sms',sid:'SM1',outboxId:'out-1'})
})
describe('actual intake POST recovery after a completed empty input revision',()=>{
  it('replays the same revision but accepts new facts under a new work checkpoint and reuses one intake',async()=>{
    h.structure.mockResolvedValueOnce(intake(false)).mockResolvedValueOnce(intake(true))
    const first=await POST(request());expect(first.status).toBe(200);expect(await first.json()).toMatchObject({gated:'empty_intake'})
    expect(h.state.conversation.status).toBe('open');expect(h.estimate).not.toHaveBeenCalled()
    await POST(request());expect(h.structure).toHaveBeenCalledTimes(1);expect(h.send).toHaveBeenCalledTimes(1)
    h.state.latest='msg-2';h.state.messages.push({id:'msg-2',direction:'inbound',body:'Install 2 outdoor power points in Sydney',created_at:'2026-09-08T00:01:00Z'})
    const revised=await POST(request());expect(revised.status).toBe(200);expect((await revised.json()).gated).toBeUndefined()
    expect(h.structure).toHaveBeenCalledTimes(2);expect(h.structure.mock.calls[1][0]).toContain('Install 2 outdoor power points')
    expect([...h.jobs.keys()]).toEqual(['intake:sms:conversation-1:msg-1','intake:sms:conversation-1:msg-2'])
    expect(h.writes.filter((w)=>w.table==='intakes')).toHaveLength(2)
    expect(h.state.intake).toMatchObject({id:'11111111-1111-4111-8111-111111111111',scope:{item_count:2},sms_source_key:'sms:conversation-1'})
    expect(h.estimate).toHaveBeenCalledExactlyOnceWith('11111111-1111-4111-8111-111111111111','tenant-1')
  })
  it('resumes a saved usable intake instead of restructuring or silently treating intake persistence as quote completion',async()=>{
    h.state.intake={...intake(true),id:'11111111-1111-4111-8111-111111111111'}
    h.state.conversation.intake_id=h.state.intake.id
    const response=await POST(request())
    expect(await response.json()).toMatchObject({idempotent:true,stage:'estimate_pending'})
    expect(h.structure).not.toHaveBeenCalled();expect(h.estimate).toHaveBeenCalledOnce()
  })
  it('does not leave an already sent quote conversation back in a processing state',async()=>{
    h.state.intake={...intake(true),id:'11111111-1111-4111-8111-111111111111'}
    h.state.quote={id:'22222222-2222-4222-8222-222222222222',intake_id:h.state.intake.id,tenant_id:'tenant-1',status:'sent',share_token:'saved_released_token'}
    h.state.conversation={...h.state.conversation,intake_id:h.state.intake.id,quote_id:h.state.quote.id,status:'done',quote_stage:'sent'}
    const response=await POST(request());expect(response.status).toBe(200)
    expect(h.state.conversation).toMatchObject({status:'done',quote_stage:'sent'})
    expect(h.structure).not.toHaveBeenCalled()
  })
})


it('keeps the same empty-intake revision retryable until its recovery question has a durable intent', async () => {
  h.structure.mockResolvedValue(intake(false))
  h.send.mockResolvedValueOnce({ok:false,smsAttempt:{code:'OUTBOX_UNAVAILABLE',reason:'persistence failed'},smsAttempts:0})
    .mockResolvedValueOnce({ok:false,outboxId:'durable-recovery',smsAttempt:{code:'RATE_LIMITED',reason:'retry later'},smsAttempts:1})
  await expect(POST(request())).rejects.toThrow('could not be queued')
  const failedJob=[...h.jobs.values()][0]
  expect(failedJob.result).toBeUndefined()
  expect(h.estimate).not.toHaveBeenCalled()
  const recovered = await POST(request())
  expect(recovered.status).toBe(200)
  expect(await recovered.json()).toMatchObject({gated:'empty_intake'})
  expect(h.structure).toHaveBeenCalledTimes(1)
  expect(h.send.mock.calls.map(([args])=>args.deliveryKey)).toEqual([`${failedJob.id}:empty-intake-recovery`,`${failedJob.id}:empty-intake-recovery`])
  expect(failedJob.result?.status).toBe(200)
  expect(h.writes.filter((write)=>write.table==='sms_messages')).toHaveLength(0)
})

it('lets the outbox publish accepted recovery replies exactly once', async () => {
  h.structure.mockResolvedValue(intake(false))
  expect((await POST(request())).status).toBe(200)
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({tenantId:'tenant-1',conversationId:'conversation-1'}))
  expect(h.writes.filter((write)=>write.table==='sms_messages')).toHaveLength(0)
})
