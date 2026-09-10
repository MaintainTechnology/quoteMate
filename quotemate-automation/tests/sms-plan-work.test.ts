import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest'
import type {SupabaseClient} from '@supabase/supabase-js'

const mocks=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),model:vi.fn(),handoff:vi.fn(),enqueue:vi.fn(),dispatch:vi.fn()}))
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:mocks.from,rpc:mocks.rpc})}))
vi.mock('@/lib/estimation/extract',()=>({runExtraction:mocks.model}))
vi.mock('@/lib/storage/plan-pdf',()=>({downloadPlanPdf:async()=>Buffer.from('%PDF-fixture')}))
vi.mock('@/lib/pdf/branding',()=>({loadTenantBranding:async()=>({businessName:'Fixture Electrical'})}))
vi.mock('@/lib/pdf/gotenberg',()=>({gotenbergConfigured:()=>false}))
vi.mock('@/lib/sms/human-handoff',()=>({persistHumanHandoff:mocks.handoff}))
vi.mock('@/lib/sms/durable-outbox',()=>({enqueueOutbound:mocks.enqueue}))
vi.mock('@/lib/sms/dispatch',()=>({dispatchQuoteMessage:mocks.dispatch}))
import {currentSmsWork,runSmsWorkBatch} from '@/lib/sms/durable-work'
import {handlePlanAnalysis} from '@/lib/estimation/plan-work'

let pg:PGlite
const tenant=randomUUID(),requestId=randomUUID(),hash='a'.repeat(64)
let inject:{table:string;operation:string}|null=null
const migration=readFileSync('sql/migrations/210_sms_plan_work.sql','utf8')
const db={from:mocks.from,rpc:mocks.rpc} as unknown as SupabaseClient
function query(table:string){
  let action='select',patch:Record<string,unknown>|undefined,ignore=false,single=false
  const filters:Array<[string,unknown]>=[]
  const execute=async()=>{
    try{
      if(inject?.table===table && inject.operation===action){inject=null;throw new Error('injected database failure')}
      const keys=patch?Object.keys(patch):[],values=patch?Object.values(patch):[]
      let sql=`select * from ${table}`
      if(action==='insert'||action==='upsert') sql=`insert into ${table}(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')})${ignore?' on conflict(sms_source_key) do nothing':''} returning *`
      else {
        if(action==='update') sql=`update ${table} set ${keys.map((key,i)=>`${key}=$${i+1}`).join(',')}`
        if(filters.length) sql+=` where ${filters.map(([key],i)=>`${key}=$${values.length+i+1}`).join(' and ')}`
        values.push(...filters.map(([,value])=>value))
        if(action==='update') sql+=' returning *'
      }
      const result=await pg.query(sql,values)
      return{data:single?(result.rows[0]??null):result.rows,error:null}
    }catch(error){return{data:null,error:{code:'08006',message:String(error)}}}
  }
  const builder={
    select:()=>builder,limit:()=>builder,order:()=>builder,
    eq:(key:string,value:unknown)=>{filters.push([key,value]);return builder},
    update:(value:Record<string,unknown>)=>{action='update';patch=value;return builder},
    insert:(value:Record<string,unknown>)=>{action='insert';patch=value;return builder},
    upsert:(value:Record<string,unknown>,options:{ignoreDuplicates?:boolean})=>{action='upsert';patch=value;ignore=!!options.ignoreDuplicates;return builder},
    maybeSingle:()=>{single=true;return builder},single:()=>{single=true;return builder},
    then:(resolve:(value:unknown)=>unknown,reject?:(reason:unknown)=>unknown)=>execute().then(resolve,reject),
  }
  return builder
}
beforeAll(async()=>{
  pg=new PGlite()
  await pg.exec(`create role anon;create role authenticated;create role service_role;
    create table tenants(id uuid primary key,business_name text);
    create table sms_conversations(id uuid primary key default gen_random_uuid());create table sms_messages(id uuid primary key default gen_random_uuid());
    create table intakes(id uuid primary key);create table quotes(id uuid primary key);
    create table customers(id uuid primary key,first_name text,phone_number text,tenant_id uuid);
    create table pricing_book(id uuid primary key,tenant_id uuid,trade text,created_at timestamptz);
    create table plan_uploads(id uuid primary key default gen_random_uuid(),tenant_id uuid,filename text,size_bytes integer,source text,pdf_path text,sheet_hint text);
    create table plan_extractions(id uuid primary key default gen_random_uuid(),plan_upload_id uuid,tenant_id uuid,items jsonb,sheets_used jsonb,overall_note text,model text,runtime_seconds numeric,share_token text unique,priced_bom jsonb,priced_at timestamptz,report_pdf_path text,trade text default 'electrical',created_at timestamptz default now());
    create table plan_upload_requests(id uuid primary key,token text,tenant_id uuid,customer_phone text,twilio_number text,sms_conversation_id uuid,status text,error text,expires_at timestamptz,updated_at timestamptz,plan_upload_id uuid,plan_extraction_id uuid);`)
  await pg.exec(readFileSync('sql/migrations/198_sms_durable_work.sql','utf8'))
  await pg.exec(migration)
  await pg.query('insert into tenants values($1,$2)',[tenant,'Fixture Electrical'])
},60_000)
beforeEach(async()=>{
  vi.clearAllMocks();inject=null
  process.env.PUBLIC_WEB_ORIGIN='https://quotemax.com.au'
  await pg.exec('truncate plan_upload_requests,plan_uploads,plan_extractions,sms_work_jobs cascade')
  await pg.query(`insert into plan_upload_requests(id,token,tenant_id,customer_phone,twilio_number,status,expires_at)
    values($1,'token',$2,'+61400000000','+61400000001','awaiting_upload',now()+interval '1 day')`,[requestId,tenant])
  mocks.from.mockImplementation(query)
  mocks.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    try{
      const keys=Object.keys(args),values=keys.map(key=>key==='p_value'&&typeof args[key]==='string'?JSON.stringify(args[key]):args[key])
      const result=await pg.query<Record<string,unknown>>(`select * from ${name}(${keys.map((key,i)=>`${key}=>$${i+1}`).join(',')})`,values)
      return{data:name==='claim_sms_work'?result.rows:result.rows[0]?.[name]??result.rows[0],error:null}
    }catch(error){return{data:null,error:{message:String(error)}}}
  })
  mocks.model.mockResolvedValue({parsed:{items:[{type:'Light',count:2}],sheets_used:[],overall_note:''},model:'fixture',runtimeSeconds:1})
  mocks.handoff.mockResolvedValue({id:'task-a',notified:false})
  mocks.enqueue.mockResolvedValue({id:'outbox-a'})
  mocks.dispatch.mockResolvedValue({ok:true,outboxId:'outbox-a',channel:'sms',sid:'SM1',status:'queued'})
})
afterAll(async()=>{await pg?.close();delete process.env.PUBLIC_WEB_ORIGIN})
async function submit(inputHash=hash){
  const payload={url:'https://quotemax.com.au/internal/plan-analysis',headers:{},body:JSON.stringify({requestId,inputHash})}
  return(await pg.query<{id:string;status:string}>(`select * from submit_sms_plan($1,$2,'plan.pdf',100,$3,$4)`,[requestId,inputHash,`${requestId}/${inputHash}/plan.pdf`,payload])).rows[0]
}
async function rerun(){await pg.exec("update sms_work_jobs set available_at=now()-interval '1 second'");return runSmsWorkBatch({plan:handlePlanAnalysis},{db,limit:1})}

it('commits one upload and work receipt for duplicate submit and rejects an active different input',async()=>{
  await pg.exec(migration)
  const [a,b]=await Promise.all([submit(),submit()])
  expect(a.id).toBe(b.id)
  expect((await pg.query('select id from plan_uploads')).rows).toHaveLength(1)
  await expect(submit('b'.repeat(64))).rejects.toThrow('plan_already_queued')
  expect((await pg.query('select id from plan_uploads')).rows).toHaveLength(1)
})
it('rolls back input metadata and request state when enqueue fails',async()=>{
  await pg.exec(`create function reject_plan_work() returns trigger language plpgsql as $$begin raise exception 'queue unavailable';end$$;
    create trigger reject_plan_work before insert on sms_work_jobs for each row execute function reject_plan_work();`)
  try{
    await expect(submit()).rejects.toThrow('queue unavailable')
    expect((await pg.query('select id from plan_uploads')).rows).toHaveLength(0)
    expect((await pg.query('select status,analysis_work_id from plan_upload_requests')).rows[0]).toEqual({status:'awaiting_upload',analysis_work_id:null})
  }finally{await pg.exec('drop trigger reject_plan_work on sms_work_jobs;drop function reject_plan_work()')}
})
it.each(['extraction','review','outbox'])('recovers %s failure without rerunning a saved model or duplicating extraction',async(boundary)=>{
  const job=await submit()
  if(boundary==='extraction')inject={table:'plan_extractions',operation:'upsert'}
  if(boundary==='review')mocks.handoff.mockRejectedValueOnce(new Error('Review task persistence failed'))
  if(boundary==='outbox')mocks.enqueue.mockRejectedValueOnce(new Error('Outbox persistence failed'))
  expect(await rerun()).toEqual([{id:job.id,ok:false}])
  const failed=(await pg.query<{status:string;last_error:string;checkpoint:Record<string,unknown>}>('select status,last_error,checkpoint from sms_work_jobs')).rows[0]
  expect(failed.status).toBe('retry');expect(failed.last_error).toBeTruthy()
  expect(failed.checkpoint['plan:model']).toBeTruthy()
  expect(await rerun()).toEqual([{id:job.id,ok:true}])
  expect(mocks.model).toHaveBeenCalledTimes(1)
  expect((await pg.query('select id from plan_extractions')).rows).toHaveLength(1)
  expect((await pg.query('select status from plan_upload_requests')).rows[0]).toEqual({status:'complete'})
  expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  expect(mocks.dispatch.mock.calls[0][0].text).toContain('awaiting approval')
})
it('reuses a saved extraction if its checkpoint response was lost',async()=>{
  const job=await submit()
  mocks.handoff.mockRejectedValueOnce(new Error('Worker died after extraction'))
  await rerun()
  await pg.exec("update sms_work_jobs set checkpoint=checkpoint-'plan:saved-extraction'-'plan:model'")
  expect(await rerun()).toEqual([{id:job.id,ok:true}])
  expect(mocks.model).toHaveBeenCalledTimes(1)
  expect((await pg.query('select id from plan_extractions')).rows).toHaveLength(1)
})
it('fences an expired worker out of plan mutations',async()=>{
  const job=await submit()
  const claimed=(await pg.query<{owner_token:string}>('select * from claim_sms_work(array[\'plan\'],$1)',[job.id])).rows[0]
  await pg.exec("update sms_work_jobs set lease_until=now()-interval '1 second'")
  await expect(pg.query('update plan_upload_requests set sms_work_id=$1,sms_work_owner=$2,status=\'complete\' where id=$3',[job.id,claimed.owner_token,requestId])).rejects.toThrow('lease lost')
})
it('recovers stranded legacy uploads into one visible job without creating another upload',async()=>{
  const uploadId=randomUUID()
  await pg.query('insert into plan_uploads(id,tenant_id,filename,pdf_path) values($1,$2,\'legacy.pdf\',$3)',[uploadId,tenant,`${requestId}/plan.pdf`])
  await pg.query("update plan_upload_requests set status='analysing',plan_upload_id=$1",[uploadId])
  await pg.exec(migration);await pg.exec(migration)
  expect((await pg.query('select id from sms_work_jobs')).rows).toHaveLength(1)
  expect((await pg.query('select id from plan_uploads')).rows).toHaveLength(1)
  expect((await pg.query<{input_sha256:string}>('select input_sha256 from plan_upload_requests')).rows[0].input_sha256).toMatch(/^[a-f0-9]{64}$/)
  expect((await rerun())[0].ok).toBe(true)
})
it('keeps repeated extraction failure visible after the bounded retry budget is exhausted',async()=>{
  await submit()
  mocks.model.mockRejectedValue(new Error('Model unavailable'))
  for(let i=0;i<8;i++)expect((await rerun())[0].ok).toBe(false)
  expect((await pg.query('select status,attempts from sms_work_jobs')).rows[0]).toEqual({status:'failed',attempts:8})
  expect((await pg.query('select status,error from plan_upload_requests')).rows[0]).toEqual({status:'failed',error:'Model unavailable'})
  expect(await rerun()).toEqual([])
  expect(mocks.dispatch).not.toHaveBeenCalled()
})
it.each([{hasReference:true,hasPrice:true},{hasReference:false,hasPrice:true},{hasReference:true,hasPrice:false},{hasReference:false,hasPrice:false}])('preserves legacy result (reference=$hasReference, price=$hasPrice)',async({hasReference,hasPrice})=>{
  const uploadId=randomUUID(),extractionId=randomUUID(),priced=hasPrice?{totalIncGst:123,authority:'saved fixture'}:null
  await pg.query('insert into plan_uploads(id,tenant_id,filename,pdf_path) values($1,$2,\'legacy.pdf\',$3)',[uploadId,tenant,`${requestId}/plan.pdf`])
  await pg.query(`insert into plan_extractions(id,plan_upload_id,tenant_id,items,sheets_used,share_token,priced_bom) values($1,$2,$3,$4,'[]','original-link',$5)`,[extractionId,uploadId,tenant,[{type:'Light',count:5}],priced])
  await pg.query("update plan_upload_requests set status='analysing',plan_upload_id=$1,plan_extraction_id=$2",[uploadId,hasReference?extractionId:null])
  await pg.exec(migration)
  expect((await rerun())[0].ok).toBe(true)
  expect(mocks.model).not.toHaveBeenCalled()
  expect(mocks.from.mock.calls.some(([table])=>table==='pricing_book')).toBe(false)
  expect((await pg.query('select id,priced_bom,share_token from plan_extractions')).rows).toEqual([{id:extractionId,priced_bom:priced,share_token:'original-link'}])
})
it('refuses direct execution outside the durable worker',async()=>{
  expect(currentSmsWork()).toBeUndefined()
  await expect(handlePlanAnalysis(new Request('https://quotemax.com.au'))).rejects.toThrow('ownership required')
})
