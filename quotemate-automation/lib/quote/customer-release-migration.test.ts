import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {PGlite} from '@electric-sql/pglite'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import type {SupabaseClient} from '@supabase/supabase-js'
import {genericQuoteSendKey,persistGenericQuoteRelease,quoteCustomerReleaseRevision,quoteCustomerReleaseSnapshot} from './customer-release'
let pg:PGlite
const tenant=randomUUID(),other=randomUUID()
const client={rpc:async(name:string,args:Record<string,unknown>)=>{
  try {const entries=Object.entries(args);const result=await pg.query<{value:unknown}>(`select ${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,entries.map(([,v])=>v));return {data:result.rows[0].value,error:null}}
  catch(error){return {data:null,error}}
}} as unknown as SupabaseClient
beforeAll(async()=>{
  pg=new PGlite()
  await pg.exec(`create role anon;create role authenticated;create role service_role;
    create table tenants(id uuid primary key);
    create table sms_conversations(id uuid primary key,from_number text,to_number text,status text,conversation_type text,tenant_id uuid);
    create table sms_messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,direction text,body text,twilio_message_sid text,audience text,to_number text,tenant_id uuid);
    create table intakes(id uuid primary key);
    create table quotes(id uuid primary key default gen_random_uuid(),tenant_id uuid,intake_id uuid,status text,paid_at timestamptz,sent_at timestamptz,price_hold_until timestamptz,
      share_token text,good jsonb,better jsonb,best jsonb,total_inc_gst numeric,selected_tier text,scope_of_works text,assumptions jsonb,estimated_timeframe text,
      needs_inspection boolean,inspection_reason text,deposit_pct numeric,display_mode text,applied_discount_pct numeric,quote_kind text,
      parent_quote_id uuid,pricing_book_version_id uuid,report_doc jsonb,report_style jsonb);
    create table plan_upload_requests(id uuid primary key default gen_random_uuid(),token text unique,tenant_id uuid,sms_conversation_id uuid,customer_phone text,twilio_number text,status text,created_at timestamptz default now(),updated_at timestamptz default now(),expires_at timestamptz);`)
  for(const file of ['198_sms_durable_work.sql','199_sms_delivery_outbox.sql','205_generic_quote_customer_release.sql','215_generic_release_snapshot.sql'])await pg.exec(readFileSync(`sql/migrations/${file}`,'utf8'))
  await pg.query('insert into tenants values($1),($2)',[tenant,other])
},30_000)
afterAll(async()=>{await pg?.close()})
async function quote(){return (await pg.query<{row:Record<string,unknown>}>(`insert into quotes(tenant_id,status,share_token,total_inc_gst,good,quote_kind) values($1,'awaiting_tradie_approval',$2,100,'{"subtotal_ex_gst":90.91}','initial') returning to_jsonb(quotes) row`,[tenant,randomUUID()])).rows[0].row}
function input(q:Record<string,unknown>,requestId?:string){return {quote:q,tenantId:tenant,ownerId:'verified-owner',holdUntil:'2026-09-16T00:00:00Z',outbound:{tenantId:tenant,to:'+61411111111',from:'+61488888888',text:'Approved quote https://quotemax.com.au/q/'+q.share_token,deliveryKey:genericQuoteSendKey(q.id as string,requestId)}}}
describe('generic approval and carrier intent transaction205',()=>{
  it('shares one initial and one explicit resend across UUID case variants',async()=>{
    const q=await quote(),args=input(q)
    const uppercase={...args,outbound:{...args.outbound,deliveryKey:genericQuoteSendKey(String(q.id).toUpperCase())}}
    const first=await persistGenericQuoteRelease(client,uppercase)
    expect(await persistGenericQuoteRelease(client,args)).toEqual(first)
    const resendId='abcdefab-cdef-4abc-8def-abcdefabcdef'
    const resend=input(q,resendId.toUpperCase())
    const second=await persistGenericQuoteRelease(client,resend)
    expect(await persistGenericQuoteRelease(client,input(q,resendId))).toEqual(second)
    expect(genericQuoteSendKey(String(q.id).toUpperCase(),resendId.toUpperCase())).toBe(genericQuoteSendKey(String(q.id),resendId))
    expect((await pg.query('select id from sms_outbox where payload->>\'quoteReleaseId\'=$1',[q.id])).rows).toHaveLength(2)
  })
  it('saves approval and one pending message, then recovery acceptance changes the lifecycle',async()=>{
    const q=await quote(),args=input(q);const first=await persistGenericQuoteRelease(client,args)
    const saved=(await pg.query<{status:string;customer_released_at:string}>('select * from quotes where id=$1',[q.id])).rows[0]
    expect(saved.status).toBe('awaiting_tradie_approval');expect(saved.customer_released_at).toBeTruthy()
    expect((await pg.query<{status:string}>('select status from sms_outbox where id=$1',[first.outboxId])).rows[0].status).toBe('pending')
    const replay=await persistGenericQuoteRelease(client,{...args,holdUntil:'2026-09-18T00:00:00Z',outbound:{...args.outbound,text:'A recomposed retry body'}})
    expect(replay).toEqual(first)
    await pg.query("update sms_outbox set status='accepted' where id=$1",[first.outboxId])
    expect((await pg.query<{status:string}>('select status from quotes where id=$1',[q.id])).rows[0].status).toBe('sent')
  })
  it('does not demote a paid quote when a late receipt arrives',async()=>{
    const q=await quote();const saved=await persistGenericQuoteRelease(client,input(q))
    await pg.query("update quotes set paid_at=now(),status='paid' where id=$1",[q.id])
    await pg.query("update sms_outbox set status='delivered' where id=$1",[saved.outboxId])
    expect((await pg.query<{status:string}>('select status from quotes where id=$1',[q.id])).rows[0].status).toBe('paid')
  })
  it('rejects another tenant, changed prices, and a customer change under an existing intent',async()=>{
    const q=await quote(),args=input(q)
    await expect(persistGenericQuoteRelease(client,{...args,tenantId:other})).rejects.toThrow('save approval')
    await expect(persistGenericQuoteRelease(client,{...args,quote:{...q,total_inc_gst:999}})).rejects.toThrow('save approval')
    expect((await pg.query('select * from sms_outbox where payload->>\'quoteReleaseId\'=$1',[q.id])).rows).toHaveLength(0)
    await persistGenericQuoteRelease(client,args)
    await expect(persistGenericQuoteRelease(client,{...args,outbound:{...args.outbound,to:'+61422222222'}})).rejects.toThrow('save approval')
  })
  it('rolls back approval if outbox persistence fails and allows an explicit distinct resend',async()=>{
    const q=await quote(),args=input(q)
    await expect(persistGenericQuoteRelease(client,{...args,outbound:{...args.outbound,conversationId:randomUUID()}})).rejects.toThrow('save approval')
    expect((await pg.query<{customer_released_at:null}>('select customer_released_at from quotes where id=$1',[q.id])).rows[0].customer_released_at).toBeNull()
    const first=await persistGenericQuoteRelease(client,args)
    const second=await persistGenericQuoteRelease(client,input(q,randomUUID()))
    expect(second.outboxId).not.toBe(first.outboxId)
    expect((await pg.query('select id from sms_outbox where payload->>\'quoteReleaseId\'=$1',[q.id])).rows).toHaveLength(2)
  })
  it('does not expose the approval RPC to public or authenticated database clients',async()=>{
    const rows=await pg.query<{allowed:boolean}>("select has_function_privilege('authenticated','approve_generic_quote_release(uuid,uuid,text,jsonb,timestamptz,jsonb,text)','execute') allowed")
    expect(rows.rows[0].allowed).toBe(false)
  })
})

describe('complete saved release snapshot215',()=>{
  it.each([
    ['report_doc', { version: 1, sections: [{ type: 'paragraph', text: 'New unreviewed scope' }] }],
    ['report_style', { accentColor: '#123456' }],
    ['pricing_book_version_id', randomUUID()],
    ['parent_quote_id', randomUUID()],
  ])('rejects a concurrent %s write before approval or enqueue',async(field,value)=>{
    const q=await quote(),args=input(q)
    await pg.query(`update quotes set ${field}=$1 where id=$2`,[typeof value === 'object' ? JSON.stringify(value) : value,q.id])
    await expect(persistGenericQuoteRelease(client,args)).rejects.toThrow('save approval')
    expect((await pg.query('select id from sms_outbox where payload->>\'quoteReleaseId\'=$1',[q.id])).rows).toHaveLength(0)
    expect((await pg.query<{customer_released_at:null}>('select customer_released_at from quotes where id=$1',[q.id])).rows[0].customer_released_at).toBeNull()
  })
  it('does not accept added or reordered reviewed array content through JSON containment',async()=>{
    const q=await quote()
    await pg.query('update quotes set assumptions=$1 where id=$2',[JSON.stringify(['First','Second']),q.id])
    const saved={...q,assumptions:['First','Second']}
    for(const assumptions of [['First','Second','Unreviewed'],['Second','First']]){
      await pg.query('update quotes set assumptions=$1 where id=$2',[JSON.stringify(assumptions),q.id])
      await expect(persistGenericQuoteRelease(client,input(saved))).rejects.toThrow('save approval')
    }
  })
  it('rejects an older partial snapshot and an outbound snapshot that differs from the reviewed row',async()=>{
    const q=await quote(),snapshot=quoteCustomerReleaseSnapshot(q),args=input(q)
    const oldSnapshot={...snapshot}
    delete oldSnapshot.pricing_book_version_id;delete oldSnapshot.report_doc;delete oldSnapshot.report_style;delete oldSnapshot.parent_quote_id
    for(const partial of [oldSnapshot,{},null]){
      const result=await client.rpc('approve_generic_quote_release',{p_quote_id:q.id,p_tenant_id:tenant,
        p_owner_id:'verified-owner',p_snapshot:partial,p_hold_until:null})
      expect(result.error).toBeTruthy()
    }
    const result=await client.rpc('approve_generic_quote_release',{p_quote_id:q.id,p_tenant_id:tenant,
      p_owner_id:'verified-owner',p_snapshot:snapshot,p_hold_until:null,p_outbound:{...args.outbound,
        quoteReleaseId:q.id,quoteReleaseRevision:quoteCustomerReleaseRevision(q),quoteReleaseSnapshot:{...snapshot,report_style:{accentColor:'#123456'}}},p_hash:'hash'})
    expect(result.error).toBeTruthy()
    expect((await pg.query('select id from sms_outbox where payload->>\'quoteReleaseId\'=$1',[q.id])).rows).toHaveLength(0)
  })
  it('stores the exact accepted snapshot and returns it unchanged on retry',async()=>{
    const q=await quote(),args=input(q)
    const saved=await persistGenericQuoteRelease(client,args)
    expect(saved.outbound).toMatchObject({quoteReleaseSnapshot:quoteCustomerReleaseSnapshot(q),quoteReleaseRevision:quoteCustomerReleaseRevision(q)})
    expect(await persistGenericQuoteRelease(client,{...args,outbound:{...args.outbound,text:'Retry must not replace content'}})).toEqual(saved)
    for(const field of ['pricing_book_version_id','report_doc','report_style','parent_quote_id']){
      expect(quoteCustomerReleaseRevision({...q,[field]:field.endsWith('_id')?randomUUID():{changed:true}})).not.toBe(quoteCustomerReleaseRevision(q))
    }
  })
  it('preserves pre215 delivery recovery without silently approving a recomposed retry',async()=>{
    const q=await quote(),args=input(q)
    await pg.exec(readFileSync('sql/migrations/215_generic_release_snapshot_down.sql','utf8'))
    let oldOutboxId:string
    try {
      const snapshot=quoteCustomerReleaseSnapshot(q)
      delete snapshot.pricing_book_version_id;delete snapshot.report_doc;delete snapshot.report_style;delete snapshot.parent_quote_id
      const old=await client.rpc('approve_generic_quote_release',{p_quote_id:q.id,p_tenant_id:tenant,p_owner_id:'verified-owner',
        p_snapshot:snapshot,p_hold_until:null,p_outbound:{...args.outbound,quoteReleaseId:q.id,quoteReleaseRevision:'pre215-reviewed-revision'},p_hash:'old-hash'})
      expect(old.error).toBeNull()
      oldOutboxId=old.data.outbox_id
    } finally {
      await pg.exec(readFileSync('sql/migrations/215_generic_release_snapshot.sql','utf8'))
    }
    await expect(persistGenericQuoteRelease(client,args)).rejects.toThrow('save approval')
    const pending=(await pg.query<{payload:Record<string,unknown>;status:string}>('select payload,status from sms_outbox where id=$1',[oldOutboxId!])).rows[0]
    expect(pending.status).toBe('pending');expect(pending.payload.text).toBe(args.outbound.text)
    expect(pending.payload).not.toHaveProperty('quoteReleaseSnapshot')
    await pg.query("update sms_outbox set status='accepted' where id=$1",[oldOutboxId!])
    expect((await pg.query<{status:string}>('select status from quotes where id=$1',[q.id])).rows[0].status).toBe('sent')
    expect((await pg.query('select id from sms_outbox where payload->>\'quoteReleaseId\'=$1',[q.id])).rows).toHaveLength(1)
  })
})
