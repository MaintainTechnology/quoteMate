import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { smsIntakeWorkIdentity } from './intake-work'

let db: PGlite
const tenant = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key);
    create table sms_conversations(id uuid primary key);
    create table sms_messages(id uuid primary key default gen_random_uuid());
    create table intakes(id uuid primary key default gen_random_uuid(),tenant_id uuid,trade text,address text,job_type text,caller jsonb, sms_work_id uuid,sms_work_owner uuid);
    create table quotes(id uuid primary key default gen_random_uuid(),tenant_id uuid,intake_id uuid,status text,share_token text unique,created_at timestamptz default now(),sent_at timestamptz,parent_quote_id uuid,sms_work_id uuid,sms_work_owner uuid);
    create table roofing_measurements(id uuid primary key default gen_random_uuid(),tenant_id uuid,address text,public_token text,customer_phone text,quote jsonb,quote_id uuid,created_at timestamptz default now());
    create table painting_measurements(id uuid primary key default gen_random_uuid(),tenant_id uuid,address text,public_token text,customer_phone text,released_at timestamptz,created_at timestamptz default now());
    create table solar_estimates(id uuid primary key default gen_random_uuid(),tenant_id uuid,address text,public_token text unique,intake_id uuid,quote_id uuid,confirmed_at timestamptz,guardrail_flags jsonb default '[]',created_at timestamptz default now());
    create table plan_uploads(id uuid primary key default gen_random_uuid(),tenant_id uuid,filename text);
    create table plan_extractions(id uuid primary key default gen_random_uuid(),tenant_id uuid,plan_upload_id uuid,share_token text,corrected_items jsonb,paint_run_id uuid,priced_bom jsonb,priced_at timestamptz,created_at timestamptz default now());
    create table plan_upload_requests(id uuid primary key default gen_random_uuid(),tenant_id uuid,plan_extraction_id uuid,customer_phone text,created_at timestamptz default now());
    create table aircon_recommendations(id uuid primary key default gen_random_uuid(),tenant_id uuid,address text,public_token text,customer_phone text,created_at timestamptz default now());
    create table paint_runs(id uuid primary key default gen_random_uuid(),tenant_id uuid,job_name text,site_address text,public_token text,status text,created_at timestamptz default now());
    create table sms_outbox_test(delivery_key text primary key,payload jsonb,hash text);
    create function sms_outbox_enqueue(p_key text,p_payload jsonb,p_hash text) returns jsonb language plpgsql as $$begin
      insert into sms_outbox_test values(p_key,p_payload,p_hash) on conflict do nothing;
      return jsonb_build_object('id',p_key); end$$;
    insert into tenants values('${tenant}'),('${other}');
  `)
  await db.exec(readFileSync(resolve('sql/migrations/198_sms_durable_work.sql'), 'utf8'))
  await db.exec(readFileSync(resolve('sql/migrations/201_sms_trade_quote_contract.sql'), 'utf8'))
}, 30_000)
afterAll(async () => { await db?.close() })

describe('201 trade quote contract at the SQL boundary', () => {
  it('normalises Australian mobiles exactly, never by suffix', async () => {
    const r = await db.query<{ phone: string }>(`select sms_normalise_customer_phone('04 1111 1111') phone`)
    expect(r.rows[0].phone).toBe('61411111111')
  })
  it('isolates all seven families by tenant and customer, even after a new conversation', async () => {
    await db.exec(`
      insert into intakes(id,tenant_id,address,caller) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${tenant}','Generic job','{"phone":"0411111111"}');
      insert into quotes(tenant_id,intake_id,status,share_token,sent_at) values('${tenant}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','sent','generic_token_111',now());
      insert into roofing_measurements(tenant_id,address,customer_phone,public_token,released_at) values('${tenant}','Roof job','+61411111111','roof_token_11111',now()),('${other}','Other tenant','+61411111111','secret_token_222',now()),('${tenant}','Other customer','+61422222222','secret_token_333',now());
      insert into painting_measurements(tenant_id,address,customer_phone,public_token) values('${tenant}','Paint job','0411111111','paint_token_1111');
      insert into solar_estimates(tenant_id,address,customer_phone,public_token) values('${tenant}','Solar job','0411111111','solar_token_1111');
      insert into aircon_recommendations(tenant_id,address,customer_phone,public_token,released_at) values('${tenant}','Aircon job','0411111111','aircon_token_111',now());
      insert into paint_runs(tenant_id,job_name,customer_phone,public_token,released_at,status) values('${tenant}','Commercial job','0411111111','commercial_token',now(),'priced');
      insert into plan_uploads(id,tenant_id,filename) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${tenant}','plan.pdf');
      insert into plan_extractions(id,tenant_id,plan_upload_id,share_token,released_at) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','${tenant}','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','plan_token_11111',now());
      insert into plan_upload_requests(tenant_id,plan_extraction_id,customer_phone) values('${tenant}','cccccccc-cccc-4ccc-8ccc-cccccccccccc','0411111111');
    `)
    const found = await db.query<{ family: string; stage: string; token: string }>('select * from sms_customer_quote_references($1,$2)', [tenant, '+61 411 111 111'])
    expect(found.rows.map((r) => r.family).sort()).toEqual(['aircon','commercial-paint','generic','paint','plan','roof','solar'])
    expect(found.rows.every((r) => !r.token.startsWith('secret'))).toBe(true)
    expect(found.rows.find((r) => r.family === 'paint')?.stage).toBe('awaiting_review')
  })
  it('hides an initial quote once an authorised final child has been sent', async () => {
    const initial = await db.query<{ id: string }>(`select id from quotes where share_token='generic_token_111'`)
    await db.query(`insert into quotes(tenant_id,intake_id,parent_quote_id,status,share_token,sent_at) values($1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$2,'sent','final_token_11111',now())`, [tenant, initial.rows[0].id])
    const found = await db.query<{ token: string }>('select * from sms_customer_quote_references($1,$2)', [tenant, '0411111111'])
    expect(found.rows.some((r) => r.token === 'generic_token_111')).toBe(false)
    expect(found.rows.some((r) => r.token === 'final_token_11111')).toBe(true)
  })
  it('atomically saves solar intake/quote/estimate and returns the same token on replay', async () => {
    const params = [tenant, 'solar-request-1', '0411111111', { trade: 'solar' }, { address: 'Solar new', public_token: 'durable_solar_token' }, { share_token: 'durable_solar_token' }]
    const first = await db.query<{ saved: { id: string; intake_id: string; quote_id: string; confirmed_at: string | null } }>('select sms_save_solar_estimate($1,$2,$3,$4,$5,$6) saved', params)
    const second = await db.query<{ saved: { id: string } }>('select sms_save_solar_estimate($1,$2,$3,$4,$5,$6) saved', params)
    expect(first.rows[0].saved.id).toBe(second.rows[0].saved.id)
    expect(first.rows[0].saved.intake_id).toBeTruthy()
    expect(first.rows[0].saved.quote_id).toBeTruthy()
    expect(first.rows[0].saved.confirmed_at).toBeNull()
    const count = await db.query<{ n: number }>(`select count(*)::int n from quotes where share_token='durable_solar_token'`)
    expect(count.rows[0].n).toBe(1)
  })
  it('rolls back intake and quote if the estimate insert fails or worker ownership expires', async () => {
    const before = await db.query<{ n: number }>('select count(*)::int n from intakes')
    await expect(db.query('select sms_save_solar_estimate($1,$2,$3,$4,$5,$6,$7,$8)',
      [tenant,'stale-work','0411111111',{}, { address: 'Stale', public_token: 'stale_solar_token' }, { share_token: 'stale_solar_token' }, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',null])).rejects.toThrow('lease lost')
    const after = await db.query<{ n: number }>('select count(*)::int n from intakes')
    expect(after.rows[0].n).toBe(before.rows[0].n)
    const quote = await db.query(`select id from quotes where share_token='stale_solar_token'`)
    expect(quote.rows).toHaveLength(0)
  })
  it('authorised approval keeps tenant/customer scope and blocks incomplete work', async () => {
    const aircon = await db.query<{ id: string }>(`select id from aircon_recommendations where public_token='aircon_token_111'`)
    const id = aircon.rows[0].id
    await expect(db.query('select sms_release_quote_resource($1,$2,$3,$4)', [other,'aircon',id,'0411111111'])).rejects.toThrow('not found')
    await expect(db.query('select sms_release_quote_resource($1,$2,$3,$4)', [tenant,'aircon',id,'0422222222'])).rejects.toThrow('does not own')
    const approved = await db.query<{ result: { token: string } }>('select sms_release_quote_resource($1,$2,$3,$4,$5,$6) result', [tenant,'aircon',id,'+61411111111',{tenantId:tenant,to:'+61411111111',resourceToken:'aircon_token_111'},'test-digest'])
    expect(approved.rows[0].result.token).toBe('aircon_token_111')
    expect((await db.query('select * from sms_outbox_test')).rows).toHaveLength(1)
    await expect(db.query('select sms_release_quote_resource($1,$2,$3,$4)', [tenant,'plan','cccccccc-cccc-4ccc-8ccc-cccccccccccc',null])).rejects.toThrow('Review plan')
  })
  it('hides a generic roof promotion from the common lookup so a job has one canonical family', async () => {
    const quote = await db.query<{id:string}>(`insert into quotes(tenant_id,intake_id,share_token,status,sent_at) values($1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','promoted_roof_token','sent',now()) returning id`,[tenant])
    await db.query(`update roofing_measurements set quote_id=$1 where public_token='roof_token_11111'`,[quote.rows[0].id])
    const found=await db.query<{token:string}>('select * from sms_customer_quote_references($1,$2)',[tenant,'0411111111'])
    expect(found.rows.some((r)=>r.token==='promoted_roof_token')).toBe(false)
    expect(found.rows.some((r)=>r.token==='roof_token_11111')).toBe(true)
  })
  it('locks tender pricing to the approved snapshot and rolls back delivery intent on changed scope', async () => {
    const run=await db.query<{id:string}>(`select id from paint_runs where public_token='commercial_token'`)
    const id=run.rows[0].id
    await db.query(`insert into plan_extractions(tenant_id,paint_run_id,priced_bom,priced_at) values($1,$2,'{"totalIncGst":20000}',now())`,[tenant,id])
    const row=await db.query<{saved:Record<string,unknown>}>('select to_jsonb(r) saved from paint_runs r where id=$1',[id])
    const snapshot={...row.rows[0].saved,_review_priced_bom:{totalIncGst:19999}}
    const outbound={tenantId:tenant,to:'0411111111',resourceToken:'commercial_token'}
    const before=(await db.query('select * from sms_outbox_test')).rows.length
    await expect(db.query('select sms_release_quote_resource($1,$2,$3,$4,$5,$6,$7)',[tenant,'commercial-paint',id,'0411111111',outbound,'digest',snapshot])).rejects.toThrow('pricing changed')
    expect((await db.query('select * from sms_outbox_test')).rows.length).toBe(before)
    await db.query('select sms_release_quote_resource($1,$2,$3,$4,$5,$6,$7)',[tenant,'commercial-paint',id,'0411111111',outbound,'digest',{...snapshot,_review_priced_bom:{totalIncGst:20000}}])
    expect((await db.query('select * from sms_outbox_test')).rows.length).toBe(before+1)
  })
  it('fences review-task inserts and updates with the actual worker owner, including after takeover', async () => {
    const work=await db.query<{id:string}>(`select id from enqueue_sms_work('human-review-fence','intake','human-review-fence',$1,'{}',$2)`,[other,tenant])
    const id=work.rows[0].id
    const first=(await db.query<{owner_token:string}>(`select * from claim_sms_work(array['intake'],$1)`,[id])).rows[0]
    await expect(db.query(`insert into sms_human_tasks(tenant_id,customer_phone,request_key,trade,reason,sms_work_id,sms_work_owner) values($1,'0411111111','task-fence','solar','Review',$2,$3)`,[tenant,id,other])).rejects.toThrow('lease lost')
    await db.query(`insert into sms_human_tasks(tenant_id,customer_phone,request_key,trade,reason,sms_work_id,sms_work_owner) values($1,'0411111111','task-fence','solar','Review',$2,$3)`,[tenant,id,first.owner_token])
    await db.query(`update sms_work_jobs set lease_until=now()-interval '1 second' where id=$1`,[id])
    const second=(await db.query<{owner_token:string}>(`select * from claim_sms_work(array['intake'],$1)`,[id])).rows[0]
    expect(second.owner_token).not.toBe(first.owner_token)
    await expect(db.query(`update sms_human_tasks set status='notified',sms_work_id=$1,sms_work_owner=$2 where request_key='task-fence'`,[id,first.owner_token])).rejects.toThrow('lease lost')
    expect((await db.query(`select status,sms_work_id,sms_work_owner from sms_human_tasks where request_key='task-fence'`)).rows).toEqual([{status:'open',sms_work_id:null,sms_work_owner:null}])
  })
  it('uses one claim lane for inbound-SID and platform row-id revisions of the same conversation', async () => {
    const live=smsIntakeWorkIdentity({conversationId:'shared-intake',providerMessageSid:'SM-revision-one'})
    const replay=smsIntakeWorkIdentity({conversationId:'shared-intake',providerMessageSid:'SM-revision-one',messageId:'message-row'})
    const next=smsIntakeWorkIdentity({conversationId:'shared-intake',messageId:'form-row'})
    const enqueue=async(value:typeof live)=>(await db.query<{id:string}>(`select id from enqueue_sms_work($1,'intake',$2,$3,'{}',$4)`,[value.key,value.serialKey,other,tenant])).rows[0].id
    const first=await enqueue(live);expect(await enqueue(replay)).toBe(first)
    const second=await enqueue(next)
    const claimed=(await db.query<{owner_token:string}>(`select * from claim_sms_work(array['intake'],$1)`,[first])).rows[0]
    expect((await db.query(`select * from claim_sms_work(array['intake'],$1)`,[second])).rows).toHaveLength(0)
    await db.query('select finish_sms_work($1,$2,$3)',[first,claimed.owner_token,{ok:true}])
    expect((await db.query<{id:string}>(`select * from claim_sms_work(array['intake'],$1)`,[second])).rows[0].id).toBe(second)
  })
})
