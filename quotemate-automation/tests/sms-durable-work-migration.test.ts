import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { currentSmsWork, durableAfter, runSmsWorkBatch, smsWorkCheckpoint, withFencedSmsClient } from '@/lib/sms/durable-work'
import type { SupabaseClient } from '@supabase/supabase-js'

let db: PGlite
const turn = '11111111-1111-4111-8111-111111111111'
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table sms_conversations(id uuid primary key default gen_random_uuid());
    create table sms_messages(id uuid primary key default gen_random_uuid());
    create table intakes(id uuid primary key default gen_random_uuid());
    create table quotes(id uuid primary key default gen_random_uuid());`)
  await db.exec(readFileSync(resolve(process.cwd(), 'sql/migrations/198_sms_durable_work.sql'), 'utf8'))
}, 60_000)
beforeEach(async () => { await db.exec('truncate sms_work_jobs,sms_conversations,sms_messages,intakes,quotes restart identity') })
afterAll(async () => { await db?.close() })

async function enqueue(key = 'SM1', serial = 'tenant:customer', service = 'platform') {
  const result = await db.query<{ id: string }>(`select id from enqueue_sms_work($1,'inbound',$2,$3,$4,null,$5)`,
    [key, serial, turn, { url: 'https://website.test/api/sms/inbound', headers: {}, body: 'test' }, service])
  return result.rows[0].id
}
async function claim(id?: string, service = 'platform') {
  return (await db.query<{ id: string; owner_token: string }>(`select * from claim_sms_work(array['inbound'], $1,90,$2)`, [id ?? null, service])).rows[0]
}
const rpcOrder: Record<string, string[]> = {
  claim_sms_work: ['p_kinds','p_id','p_lease_seconds','p_service'],
  renew_sms_work: ['p_id','p_owner','p_lease_seconds'],
  assert_sms_work_owner: ['p_id','p_owner'],
  checkpoint_sms_work: ['p_id','p_owner','p_name','p_value'],
  finish_sms_work: ['p_id','p_owner','p_result','p_error'],
}
function adapter(): SupabaseClient {
  return { rpc: async (name: string, params: Record<string, unknown>) => {
    const keys = rpcOrder[name].filter(key => Object.hasOwn(params,key))
    try {
      const result = await db.query<Record<string, unknown>>(`select * from ${name}(${keys.map((key,i)=>`${key} => $${i+1}`).join(',')})`, keys.map(key=>params[key]))
      return { data: name === 'claim_sms_work' ? result.rows : result.rows[0]?.[name], error: null }
    } catch (error) { return { data: null, error: { message: String(error) } } }
  } } as unknown as SupabaseClient
}

describe('durable SMS database and running worker boundary', () => {
  it('persists a null stage result as JSON null and does not run the stage again',async()=>{
    const id=await enqueue();let calls=0
    const handler=async()=>{expect(await smsWorkCheckpoint('optional',async()=>{calls++;return null})).toBeNull();expect(await smsWorkCheckpoint('optional',async()=>{calls++;return 'must not run'})).toBeNull();return Response.json({ok:true})}
    expect(await runSmsWorkBatch({inbound:handler},{db:adapter(),limit:1})).toEqual([{id,ok:true}])
    expect(calls).toBe(1);expect((await db.query('select checkpoint from sms_work_jobs where id=$1',[id])).rows[0]).toEqual({checkpoint:{optional:null}})
  })
  it('acknowledgement receipt replay returns one durable identity and FIFO followers remain runnable', async () => {
    const first = await enqueue()
    expect(await enqueue()).toBe(first)
    const second = await enqueue('SM2')
    const owner = await claim(first)
    expect(await claim(second)).toBeUndefined()
    await db.query('select finish_sms_work($1,$2,$3)', [first,owner.owner_token,{ok:true}])
    expect((await claim(second))?.id).toBe(second)
  })
  it('an expired owner cannot write, finish or clear successor state', async () => {
    const id = await enqueue()
    const a = await claim(id)
    await db.query("update sms_work_jobs set lease_until=now()-interval '1 second' where id=$1",[id])
    expect((await db.query('select renew_sms_work($1,$2)',[id,a.owner_token])).rows[0]).toEqual({renew_sms_work:false})
    const b = await claim(id)
    expect(b.owner_token).not.toBe(a.owner_token)
    await expect(db.query('insert into quotes(sms_work_id,sms_work_owner) values($1,$2)',[id,a.owner_token])).rejects.toThrow('lease lost')
    await expect(db.query('select finish_sms_work($1,$2)',[id,a.owner_token])).rejects.toThrow('lease lost')
    await db.query('insert into quotes(sms_work_id,sms_work_owner) values($1,$2)',[id,b.owner_token])
    expect(await claim(await enqueue('SM3'))).toBeUndefined()
    const saved = await db.query('select sms_work_id,sms_work_owner from quotes')
    expect(saved.rows).toEqual([{sms_work_id:null,sms_work_owner:null}])
  })
  it('one service cannot claim another trade’s payload', async () => {
    const solar = await enqueue('solar','tenant:customer','solar')
    expect(await claim(solar,'electrical')).toBeUndefined()
    expect((await claim(solar,'solar'))?.id).toBe(solar)
  })
  it('initial quote and intake keys reject a response-lost duplicate while allowing explicit revisions', async () => {
    await db.query("insert into intakes(sms_source_key) values('sms:convo')")
    await expect(db.query("insert into intakes(sms_source_key) values('sms:convo')")).rejects.toThrow('duplicate')
    await db.query("insert into quotes(estimate_request_key) values('initial:intake')")
    await expect(db.query("insert into quotes(estimate_request_key) values('initial:intake')")).rejects.toThrow('duplicate')
    await db.query("insert into quotes(estimate_request_key) values(null),(null)")
    expect((await db.query('select count(*)::int as count from quotes')).rows[0]).toEqual({count:3})
  })
  it('restart resumes persisted model checkpoint and drains nested callbacks before completing', async () => {
    const id = await enqueue()
    let modelCalls = 0
    let firstRun = true
    const events: string[] = []
    const handler = async () => {
      const decision = await smsWorkCheckpoint('decision',async()=>{ modelCalls++;return {answer:'saved answer'} })
      events.push(decision.answer)
      durableAfter(async()=>{
        expect(currentSmsWork()?.jobId).toBe(id)
        if (firstRun) { firstRun=false; throw new Error('process loss after model commit') }
        durableAfter(()=>{events.push('nested persisted send')})
      })
      return Response.json({ok:true})
    }
    expect(await runSmsWorkBatch({inbound:handler},{db:adapter(),limit:1})).toEqual([{id,ok:false}])
    await db.query("update sms_work_jobs set available_at=now()-interval '1 second' where id=$1",[id])
    expect(await runSmsWorkBatch({inbound:handler},{db:adapter(),limit:1})).toEqual([{id,ok:true}])
    expect(modelCalls).toBe(1)
    expect(events).toEqual(['saved answer','saved answer','nested persisted send'])
    expect((await db.query('select status,attempts from sms_work_jobs where id=$1',[id])).rows[0]).toEqual({status:'completed',attempts:2})
  })
  it('a database fence failure inside an otherwise swallowed mutation prevents job completion', async () => {
    const id = await enqueue()
    const mockBuilder = { insert: (value: unknown) => {
      expect(value).toMatchObject({sms_work_id:id,sms_work_owner:expect.any(String)})
      return { then: (resolve: (value: unknown) => unknown) => Promise.resolve({data:null,error:{code:'40001',message:'lease lost'}}).then(resolve) }
    } }
    const wrapped = withFencedSmsClient({from:()=>mockBuilder} as unknown as SupabaseClient)
    const handler = async () => { await wrapped.from('quotes').insert({});return Response.json({ok:true}) }
    expect(await runSmsWorkBatch({inbound:handler},{db:adapter(),limit:1})).toEqual([{id,ok:false}])
  })
  it('a hung handler loses its attempt within the deadline and another customer can progress', async () => {
    const stuck = await enqueue('hung','tenant:first')
    const next = await enqueue('next','tenant:second')
    let signal: AbortSignal | undefined
    let release: (()=>void) | undefined
    const handler = async (request: Request) => {
      if (currentSmsWork()?.jobId === stuck) {
        signal = request.signal
        await new Promise<void>(resolve => { release=resolve })
        await smsWorkCheckpoint('too_late', async()=>true)
      }
      return Response.json({ok:true})
    }
    expect(await runSmsWorkBatch({inbound:handler},{db:adapter(),limit:2,attemptTimeoutMs:150})).toEqual([{id:stuck,ok:false},{id:next,ok:true}])
    expect(signal?.aborted).toBe(true)
    release?.()
    await new Promise(resolve=>setTimeout(resolve,10))
    const row = (await db.query('select status,owner_token,checkpoint from sms_work_jobs where id=$1',[stuck])).rows[0]
    expect(row).toEqual({status:'retry',owner_token:null,checkpoint:{}})
  })
  it('retired signed receipts are atomically flagged and cannot enter the normal worker', async () => {
    const id = await enqueue('retired:sid','retired:customer','retired-platform')
    expect(await enqueue('retired:sid','retired:customer','retired-platform')).toBe(id)
    expect((await db.query('select status,last_error from sms_work_jobs where id=$1',[id])).rows[0]).toMatchObject({status:'failed',last_error:expect.stringContaining('retired webhook')})
    expect(await claim(id,'platform')).toBeUndefined()
    expect(await claim(id,'retired-platform')).toBeUndefined()
  })
})
