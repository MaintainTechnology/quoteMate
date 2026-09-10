import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueOutbound, processOutbound, recordDeliveryReceipt, type OutboxRow } from '@/lib/sms/durable-outbox'
import { withSmsDeliveryContext } from '@/lib/sms/delivery-context'
import { retryWithBackoff } from '@/lib/sms/send-reliability'

let pg: PGlite
const tenant = randomUUID(), conversation = randomUUID()
const migration = readFileSync('sql/migrations/199_sms_delivery_outbox.sql','utf8')
async function rpc(name: string, args: Record<string, unknown> = {}) {
  try {
    const keys = Object.keys(args)
    const result = await pg.query<{ value: unknown }>(`select public.${name}(${keys.map((key,i)=>`${key}=>$${i+1}`).join(',')}) as value`, Object.values(args))
    return { data: result.rows[0]?.value, error: null }
  } catch (error) { return { data: null, error: { code: (error as {code:string}).code, message: String(error) } } }
}
const client = { rpc } as unknown as SupabaseClient
beforeAll(async () => {
  process.env.PUBLIC_WEB_ORIGIN = 'https://quotemax.com.au'
  pg = new PGlite()
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key);
    create table sms_conversations(id uuid primary key default gen_random_uuid(),from_number text,to_number text,status text,conversation_type text,tenant_id uuid);
    create table sms_messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,direction text,body text,twilio_message_sid text,audience text default 'customer',to_number text,tenant_id uuid);
    create unique index sms_messages_unique_inbound_sid_idx on sms_messages(twilio_message_sid) where direction='inbound' and twilio_message_sid is not null;
    create table intakes(id uuid primary key); create table quotes(id uuid primary key);
    create table plan_upload_requests(id uuid primary key default gen_random_uuid(), token text not null unique,tenant_id uuid,sms_conversation_id uuid,customer_phone text,twilio_number text,status text,created_at timestamptz default now(),updated_at timestamptz default now(),expires_at timestamptz default now()+interval '7 days');`)
  await pg.exec(readFileSync('sql/migrations/198_sms_durable_work.sql','utf8'))
  await pg.exec(migration)
  await pg.query('insert into tenants values($1)', [tenant])
  await pg.query('insert into sms_conversations(id,tenant_id) values($1,$2)', [conversation,tenant])
}, 60_000)
afterAll(async () => { await pg?.close(); delete process.env.PUBLIC_WEB_ORIGIN })
async function queued(text = 'Saved quote ready for review') {
  return enqueueOutbound({ deliveryKey: randomUUID(), tenantId: tenant, conversationId: conversation,
    turnId: randomUUID(), to:'+61400000000', text }, client)
}
async function row(id: string) { return (await pg.query<OutboxRow>('select * from sms_outbox where id=$1',[id])).rows[0] }
async function stageContext(kind: 'inbound' | 'intake' | 'estimate', turnId: string) {
  const workId = randomUUID(), workOwner = randomUUID()
  await pg.query(`insert into sms_work_jobs(id,work_key,kind,serial_key,turn_id,tenant_id,payload,status,owner_token,lease_until)
    values($1::uuid,($1::uuid)::text,$2,($1::uuid)::text,$3,$4,'{}','running',$5,now()+interval '5 minutes')`,[workId,kind,turnId,tenant,workOwner])
  return { workId,workOwner,turnId,tenantId:tenant,conversationId:conversation }
}

describe('durable delivery against actual Postgres migration', () => {
  it('applies idempotently and blocks public function execution', async () => {
    await pg.exec(migration)
    const result = await pg.query<{allowed:boolean}>("select has_function_privilege('anon','sms_outbox_claim(uuid,uuid)','execute') allowed")
    expect(result.rows[0].allowed).toBe(false)
  })
  it('persists a single intent for concurrent replay and rejects key/payload drift', async () => {
    const opts = { deliveryKey: randomUUID(), tenantId: tenant, to:'+61400000000', text:'hello' }
    const jobs = await Promise.all([enqueueOutbound(opts,client), enqueueOutbound(opts,client)])
    expect(jobs[0].id).toBe(jobs[1].id)
    await expect(enqueueOutbound({...opts,text:'invented replacement'},client)).rejects.toThrow()
  })
  it('separates notifications across stages while replaying each job into its original intent', async () => {
    const turnId = randomUUID()
    const opts = {to:'+61400000000',text:'Your details are saved.'}
    const ids = new Set<string>()
    for (const stage of ['inbound','intake','estimate'] as const) {
      const context=await stageContext(stage,turnId)
      const first=await withSmsDeliveryContext(context,()=>enqueueOutbound(opts,client))
      const replay=await withSmsDeliveryContext(context,()=>enqueueOutbound(opts,client))
      expect(first.id).toBe(replay.id)
      expect(first.delivery_key).toMatch(new RegExp(`^${context.workId}:payload:`))
      ids.add(first.id)
    }
    expect(ids.size).toBe(3)
  })
  it('outer 429 retry wrappers and later recovery use one intent and one accepted transcript row', async () => {
    const context=await stageContext('estimate',randomUUID())
    const ids:string[]=[]
    const transport=vi.fn(async()=>({ok:false as const,smsAttempt:{code:'429',reason:'rate limited'},smsAttempts:1}))
    await withSmsDeliveryContext(context,()=>retryWithBackoff(async()=>{
      const queued=await enqueueOutbound({to:'+61400000000',text:'The authorised quote is ready.'},client)
      ids.push(queued.id)
      const result=await processOutbound(queued,transport,client)
      if (!result.ok) throw result.smsAttempt
      return result
    },{retries:2,isRetryable:()=>true,sleep:async()=>{}}))
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
    expect(transport).toHaveBeenCalledTimes(1)
    await pg.query("update sms_outbox set next_attempt_at=now()-interval '1 second' where id=$1",[ids[0]])
    const recoveryTransport=vi.fn(async()=>({ok:true as const,channel:'sms' as const,sid:'SM'+'8'.repeat(32),status:'queued'}))
    await processOutbound(await row(ids[0]),recoveryTransport,client)
    await processOutbound(await row(ids[0]),recoveryTransport,client)
    expect(recoveryTransport).toHaveBeenCalledTimes(1)
    expect((await pg.query('select id from sms_messages where outbox_id=$1',[ids[0]])).rows).toHaveLength(1)
  })
  it('signed media renewal keeps the saved payload authoritative', async () => {
    const context=await stageContext('estimate',randomUUID())
    const original={to:'+61400000000',text:'Your approved quote.',mediaKey:'quotes/saved.pdf',mediaUrl:'https://storage.test/signed/saved.pdf?token=original'}
    const first=await withSmsDeliveryContext(context,()=>enqueueOutbound(original,client))
    const replay=await withSmsDeliveryContext(context,()=>enqueueOutbound({...original,mediaUrl:'https://storage.test/signed/saved.pdf?token=renewed'},client))
    expect(replay.id).toBe(first.id)
    expect(replay.payload.mediaUrl).toBe(original.mediaUrl)
    const plain=await withSmsDeliveryContext(context,()=>enqueueOutbound({...original,mediaUrl:undefined},client))
    expect(plain.id).toBe(first.id)
    expect(plain.payload.mediaUrl).toBe(original.mediaUrl)
  })
  it('also ignores media query renewal when only a stable resource URL is available', async () => {
    const context=await stageContext('inbound',randomUUID())
    const original={to:'+61400000000',text:'Your site photo.',mediaUrl:'https://storage.test/photos/site.png?token=first'}
    const first=await withSmsDeliveryContext(context,()=>enqueueOutbound(original,client))
    const replay=await withSmsDeliveryContext(context,()=>enqueueOutbound({...original,mediaUrl:'https://storage.test/photos/site.png?token=second'},client))
    expect(replay.id).toBe(first.id)
    expect(replay.payload.mediaUrl).toBe(original.mediaUrl)
  })
  it('publishes accepted once, keeps delivery distinct, applies monotonic receipt and rejects wrong SID', async () => {
    const job = await queued(), sid = 'SM'+'1'.repeat(32)
    const transport = vi.fn(async () => ({ok:true as const,channel:'sms' as const,sid,status:'queued'}))
    await processOutbound(job,transport,client)
    await processOutbound(await row(job.id),transport,client)
    expect(transport).toHaveBeenCalledTimes(1)
    const current = await row(job.id)
    expect(current.status).toBe('accepted')
    const receipt = {outboxId:job.id,attempt:current.attempt_token!,sid,status:'delivered'}
    expect(await recordDeliveryReceipt(receipt,client)).toBe(true)
    await recordDeliveryReceipt({...receipt,status:'queued'},client)
    await recordDeliveryReceipt({...receipt,status:'undelivered'},client)
    expect((await row(job.id)).status).toBe('delivered')
    expect(await recordDeliveryReceipt({...receipt,sid:'SM'+'2'.repeat(32)},client)).toBe(false)
    const messages = await pg.query<{delivery_status:string}>('select delivery_status from sms_messages where outbox_id=$1',[job.id])
    expect(messages.rows).toEqual([{delivery_status:'delivered'}])
  })
  it('failed and unknown sends stay visible without becoming transcript replies or automatic retries', async () => {
    for (const code of ['21610','AMBIGUOUS']) {
      const job=await queued(code)
      const transport=vi.fn(async()=>({ok:false as const,smsAttempt:{code,reason:'failure'},smsAttempts:1}))
      await processOutbound(job,transport,client)
      await processOutbound(await row(job.id),transport,client)
      expect(transport).toHaveBeenCalledTimes(1)
      expect((await pg.query('select id from sms_messages where outbox_id=$1',[job.id])).rows).toHaveLength(0)
      expect((await pg.query<{requires_attention:boolean}>('select requires_attention from sms_outbox where id=$1',[job.id])).rows[0].requires_attention).toBe(true)
      expect((await rpc('sms_outbox_retry',{p_id:job.id,p_tenant:tenant})).data).toBe(false)
    }
  })
  it('recovers a killed sending worker as unknown and never calls transport again', async () => {
    const job=await queued()
    await rpc('sms_outbox_claim',{p_id:job.id,p_attempt:randomUUID()})
    await pg.query("update sms_outbox set lease_until=now()-interval '1 second' where id=$1",[job.id])
    const transport=vi.fn()
    await processOutbound(await row(job.id),transport,client)
    expect(transport).not.toHaveBeenCalled()
    expect((await row(job.id)).status).toBe('unknown')
  })
  it('does not overwrite a failure callback that arrives before the send response', async () => {
    const job=await queued(),sid='SM'+'9'.repeat(32)
    const result=await processOutbound(job,async()=>{
      const claimed=await row(job.id)
      await recordDeliveryReceipt({outboxId:job.id,attempt:claimed.attempt_token!,sid,status:'undelivered',errorCode:'30003'},client)
      return {ok:true,channel:'sms',sid,status:'queued'}
    },client)
    expect(result.ok).toBe(false)
    expect((await row(job.id)).status).toBe('undelivered')
  })
  it('never reaches transport when durable intent persistence is unavailable', async () => {
    const failedDb={rpc:async()=>({data:null,error:{code:'08006'}})} as unknown as SupabaseClient
    await expect(enqueueOutbound({to:'+61400000000',text:'must not send'},failedDb)).rejects.toThrow('08006')
  })
  it('retains the saved intent when callback configuration fails before sending', async()=>{
    const job=await queued(),transport=vi.fn()
    const previous=process.env.PUBLIC_WEB_ORIGIN
    process.env.PUBLIC_WEB_ORIGIN='https://quotemax.com.au/invalid-path'
    try {
      const result=await processOutbound(job,transport,client)
      expect(result).toMatchObject({ok:false,outboxId:job.id,smsAttempt:{code:'OUTBOX_UNAVAILABLE'}})
      expect(transport).not.toHaveBeenCalled()
      expect((await row(job.id)).status).toBe('pending')
    } finally { process.env.PUBLIC_WEB_ORIGIN=previous }
  })
  it('allows a known rejection to retry but only for its tenant', async () => {
    const job=await queued()
    await processOutbound(job,async()=>({ok:false,smsAttempt:{code:'NO_FROM',reason:'configuration'},smsAttempts:1}),client)
    expect((await rpc('sms_outbox_retry',{p_id:job.id,p_tenant:randomUUID()})).data).toBe(false)
    expect((await rpc('sms_outbox_retry',{p_id:job.id,p_tenant:tenant})).data).toBe(true)
  })
  it('never records an unproven legacy outbound as accepted', async () => {
    await pg.query("insert into sms_messages(conversation_id,direction,body,delivery_status) values($1,'outbound','not sent','delivered')",[conversation])
    const result=await pg.query<{delivery_status:string}>("select delivery_status from sms_messages where body='not sent'")
    expect(result.rows[0].delivery_status).toBe('unknown')
  })
  it('concurrent plan requests and duplicate inbound SID reuse the saved request/token', async () => {
    const input={p_tenant:tenant,p_from:'+61411111111',p_to:'+61422222222',p_body:'quote my plan',p_sid:'SM'+randomUUID().replaceAll('-','')}
    const results=await Promise.all([rpc('sms_plan_request',input),rpc('sms_plan_request',input)])
    expect(results.every(value=>!value.error)).toBe(true)
    expect((results[0].data as {token:string}).token).toBe((results[1].data as {token:string}).token)
    expect((await pg.query('select id from plan_upload_requests where customer_phone=$1',[input.p_from])).rows).toHaveLength(1)
    expect((await pg.query('select id from sms_messages where twilio_message_sid=$1',[input.p_sid])).rows).toHaveLength(1)
  })
})
