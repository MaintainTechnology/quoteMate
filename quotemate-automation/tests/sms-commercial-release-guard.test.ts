import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

// Real trigger/constraint behavior, not production multiconnection timing.
const migration = readFileSync('sql/migrations/211_commercial_quote_release_guard.sql','utf8')
const down = readFileSync('sql/migrations/211_commercial_quote_release_guard_down.sql','utf8')
  .replace(/^begin;\r?$/gm,'').replace(/^commit;\r?$/gm,'')
const tenant='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222'
const run='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', second='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const foreign='cccccccc-cccc-4ccc-cccc-cccccccccccc', row='dddddddd-dddd-4ddd-dddd-dddddddddddd'
const another='eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee'
let pg:PGlite
beforeAll(async()=>{
  pg=new PGlite()
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table paint_runs(id uuid primary key,tenant_id uuid not null,public_token text,released_at timestamptz,job_name text);
    create table plan_extractions(id uuid primary key,tenant_id uuid not null,
      paint_run_id uuid references paint_runs(id) on delete cascade,priced_bom jsonb,priced_at timestamptz,
      report_pdf_path text,sheets_used jsonb,corrected_items jsonb);`)
  await pg.exec(migration)
},20_000)
beforeEach(async()=>{
  await pg.exec('begin')
  await pg.query('insert into paint_runs(id,tenant_id,public_token) values($1,$2,\'original-public-token\'),($3,$2,\'second-public-token\'),($4,$5,\'foreign-public-token\')',[run,tenant,second,foreign,other])
  await pg.query('insert into plan_extractions(id,tenant_id,paint_run_id,priced_bom,priced_at) values($1,$2,$3,$4,\'2026-09-08T00:00:00Z\')',[row,tenant,run,{totalIncGst:100}])
})
afterEach(async()=>{await pg.exec('rollback')})
afterAll(async()=>{await pg?.close()})
async function publish(){await pg.query("update paint_runs set released_at='2026-09-08T01:00:00Z' where id=$1",[run])}
async function ready(){return (await pg.query<{ready:boolean}>('select sms_commercial_quote_guard_ready() ready')).rows[0].ready}
async function blocked(sql:string,args:unknown[]=[],code='QM001'){
  await pg.exec('savepoint rejected_write')
  try{await expect(pg.query(sql,args)).rejects.toMatchObject({code})}
  finally{await pg.exec('rollback to savepoint rejected_write; release savepoint rejected_write')}
}
async function unchanged(){
  expect((await pg.query<{priced_bom:unknown;paint_run_id:string}>('select priced_bom,paint_run_id from plan_extractions where id=$1',[row])).rows[0])
    .toEqual({priced_bom:{totalIncGst:100},paint_run_id:run})
  expect((await pg.query<{public_token:string}>('select public_token from paint_runs where id=$1',[run])).rows[0].public_token).toBe('original-public-token')
}
it('allows owned unreleased pricing, new priced results and ordinary plan pricing',async()=>{
  await pg.query('update plan_extractions set priced_bom=$1,priced_at=now() where id=$2',[{totalIncGst:200},row])
  await pg.query('insert into plan_extractions(id,tenant_id,paint_run_id,priced_bom) values($1,$2,$3,$4)',[another,tenant,second,{totalIncGst:300}])
  await pg.query('update plan_extractions set paint_run_id=null where id=$1',[another])
  expect((await pg.query('select * from plan_extractions')).rows).toHaveLength(2)
  expect(await ready()).toBe(true)
})
it.each([
  ['price',"priced_bom='{\"totalIncGst\":999}'::jsonb"],
  ['remove price','priced_bom=null'],
  ['selection timestamp',"priced_at='2030-01-01'"],
  ['tenant',`tenant_id='${other}'`],
  ['move run',`paint_run_id='${second}'`],
  ['detach','paint_run_id=null'],
  ['row identity',`id='${another}'`],
])('rejects published extraction %s mutation and keeps its price',async(_label,set)=>{
  await publish();await blocked(`update plan_extractions set ${set} where id=$1`,[row]);await unchanged()
})
it('blocks deleting a published extraction and inserting a newer priced extraction',async()=>{
  await publish();await blocked('delete from plan_extractions where id=$1',[row])
  await blocked('insert into plan_extractions(id,tenant_id,paint_run_id,priced_bom,priced_at) values($1,$2,$3,$4,now())',[another,tenant,run,{totalIncGst:999}])
  await unchanged()
})
it('rejects moving another priced extraction into the published run',async()=>{
  await pg.query('insert into plan_extractions(id,tenant_id,paint_run_id,priced_bom) values($1,$2,$3,$4)',[another,tenant,second,{totalIncGst:999}])
  await publish();await blocked('update plan_extractions set paint_run_id=$1 where id=$2',[run,another]);await unchanged()
})
it('requires an owned parent for a new commercial price, including a newly priced existing row',async()=>{
  await blocked('insert into plan_extractions(id,tenant_id,paint_run_id,priced_bom) values($1,$2,$3,$4)',[another,tenant,foreign,{totalIncGst:999}])
  await blocked('insert into plan_extractions(id,tenant_id,paint_run_id,priced_bom) values($1,$2,$3,$4)',[another,tenant,'ffffffff-ffff-4fff-afff-ffffffffffff',{totalIncGst:999}])
  await pg.query('insert into plan_extractions(id,tenant_id,paint_run_id) values($1,$2,$3)',[another,tenant,foreign])
  await blocked('update plan_extractions set priced_bom=$1 where id=$2',[{totalIncGst:999},another])
})
it('preserves existing PDF-cache and projection updates on a released result',async()=>{
  await publish()
  await pg.query("update plan_extractions set report_pdf_path='cached.pdf',sheets_used='{\"saved_quote\":true}' where id=$1",[row])
  await pg.query('update paint_runs set released_at=released_at,public_token=public_token where id=$1',[run])
  await unchanged()
})
it.each([
  ['unrelease','released_at=null'],
  ['change approval',"released_at='2030-01-01'"],
  ['remove token','public_token=null'],
  ['replace token',"public_token='replacement-public-token'"],
  ['tenant',`tenant_id='${other}'`],
  ['identity',`id='${another}'`],
])('rejects published run %s mutation',async(_label,set)=>{
  await publish();await blocked(`update paint_runs set ${set} where id=$1`,[run]);await unchanged()
})
it('allows a held-run FK cascade, but blocks the same deletion after release',async()=>{
  await pg.query('insert into plan_extractions(id,tenant_id,paint_run_id,priced_bom) values($1,$2,$3,$4)',[another,tenant,second,{totalIncGst:200}])
  await pg.query('delete from paint_runs where id=$1',[second])
  expect((await pg.query('select * from plan_extractions where id=$1',[another])).rows).toHaveLength(0)
  await publish();await blocked('delete from paint_runs where id=$1',[run]);await unchanged()
})
it.each(['plan_extractions','paint_runs cascade'])('blocks published removal through TRUNCATE %s',async table=>{
  await publish();await blocked(`truncate ${table}`);await unchanged()
})
it('fails closed when RLS would hide published rows from an otherwise permitted truncation',async()=>{
  await publish()
  await pg.exec(`alter table paint_runs enable row level security;
    create policy hidden_runs on paint_runs for select to authenticated using(false);
    grant select,update on paint_runs to authenticated; grant select,truncate on plan_extractions to authenticated;
    set local role authenticated;`)
  await blocked('truncate plan_extractions',[],'42501')
  await pg.exec('reset role');await unchanged()
})
it.each([
  ['plan_extractions','sms_commercial_extraction_guard'],
  ['paint_runs','sms_commercial_run_guard'],
  ['plan_extractions','sms_commercial_extraction_truncate_guard'],
  ['paint_runs','sms_commercial_run_truncate_guard'],
])('readiness rejects disabled or replica-only %s.%s',async(table,trigger)=>{
  expect(await ready()).toBe(true)
  await pg.exec(`alter table ${table} disable trigger ${trigger}`);expect(await ready()).toBe(false)
  await pg.exec(`alter table ${table} enable replica trigger ${trigger}`);expect(await ready()).toBe(false)
  await pg.exec(`alter table ${table} enable always trigger ${trigger}`);expect(await ready()).toBe(true)
})
it('readiness rejects a missing trigger or reduced event coverage',async()=>{
  await pg.exec('drop trigger sms_commercial_extraction_guard on plan_extractions');expect(await ready()).toBe(false)
  await pg.exec(`create trigger sms_commercial_extraction_guard before update on plan_extractions for each row
    execute function guard_commercial_quote_extraction()`)
  expect(await ready()).toBe(false)
})
it.each([
  ['column-limited update','before insert or update of priced_bom or delete',''],
  ['conditional trigger','before insert or update or delete','when (true)'],
])('readiness rejects %s even when all three events are present',async(_label,events,condition)=>{
  await pg.exec('drop trigger sms_commercial_extraction_guard on plan_extractions')
  await pg.exec(`create trigger sms_commercial_extraction_guard ${events} on plan_extractions for each row ${condition}
    execute function guard_commercial_quote_extraction()`)
  expect(await ready()).toBe(false)
})
it('only service role may call the read-only guard probe',async()=>{
  for(const role of ['anon','authenticated']){
    await pg.exec(`set local role ${role}`);await blocked('select sms_commercial_quote_guard_ready()',[],'42501');await pg.exec('reset role')
  }
  await pg.exec('set local role service_role');expect(await ready()).toBe(true);await pg.exec('reset role')
})
it('safe rollback refuses published runs without dropping protection',async()=>{
  await publish();await pg.exec('savepoint rollback_guard')
  try{await expect(pg.exec(down)).rejects.toThrow('Cannot remove commercial release guard')}
  finally{await pg.exec('rollback to savepoint rollback_guard; release savepoint rollback_guard')}
  expect(await ready()).toBe(true);await unchanged()
})
it('guard rollback preserves held rows and can be reapplied without data loss',async()=>{
  await pg.exec(down)
  expect((await pg.query<{ready:string|null}>("select to_regprocedure('sms_commercial_quote_guard_ready()') ready")).rows[0].ready).toBeNull()
  await unchanged()
  await pg.exec(migration.replace(/^begin;\r?$/gm,'').replace(/^commit;\r?$/gm,''))
  expect(await ready()).toBe(true);await unchanged()
})
