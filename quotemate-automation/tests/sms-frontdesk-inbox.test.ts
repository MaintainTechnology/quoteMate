import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, expect, it } from 'vitest'

let db: PGlite
beforeEach(async () => {
  db = new PGlite()
  await db.exec('create role anon; create role authenticated; create role service_role; create table tenants(id uuid primary key);')
  await db.exec(readFileSync('sql/migrations/200_frontdesk_durable_inbox.sql', 'utf8'))
}, 60_000)
afterEach(async () => { await db?.close() }, 30_000)
async function enqueue(key: string, from = '+61400000001') {
  return db.query(`insert into sms_frontdesk_jobs(receipt_key,from_number,to_number,payload)
    values($1,$2,'+61400000002','{}') on conflict(receipt_key) do nothing returning id`, [key,from])
}
async function claim() {
  return (await db.query<{ id: string; lease_owner: string; attempts: number }>('select * from claim_sms_frontdesk_job($1)',[randomUUID()])).rows[0]
}
it('receipt replay is independent from work completion and preserves one turn', async () => {
  await enqueue('SM-one'); await enqueue('SM-one')
  expect((await db.query('select * from sms_frontdesk_jobs')).rows).toHaveLength(1)
  const job = await claim()
  expect(job.attempts).toBe(1)
  expect(await claim()).toBeUndefined()
})
it('serialises one customer burst while allowing another customer through', async () => {
  await enqueue('first'); await enqueue('correction'); await enqueue('other','+61400000003')
  const first = await claim(); const other = await claim()
  expect(first.id).not.toBe(other.id)
  expect(await claim()).toBeUndefined()
  await db.query("update sms_frontdesk_jobs set state='forwarded' where id=$1",[first.id])
  expect((await claim()).id).not.toBe(other.id)
})
it('restart reclaims an expired attempt without losing later messages; stale owner cannot finish it', async () => {
  await enqueue('first'); await enqueue('later')
  const a = await claim()
  await db.query("update sms_frontdesk_jobs set lease_until=now()-interval '1 minute' where id=$1",[a.id])
  const b = await claim()
  expect(b.id).toBe(a.id); expect(b.lease_owner).not.toBe(a.lease_owner)
  const stale = await db.query("update sms_frontdesk_jobs set state='forwarded' where id=$1 and lease_owner=$2 returning id",[a.id,a.lease_owner])
  expect(stale.rows).toHaveLength(0)
  expect(await claim()).toBeUndefined()
})
it('failed forwarding remains visible and authenticated retry reuses the receipt', async () => {
  await enqueue('failure')
  const a = await claim()
  await db.query("update sms_frontdesk_jobs set state='failed',last_error='service unavailable' where id=$1",[a.id])
  expect((await db.query('select retry_sms_frontdesk_job($1) as retried',[a.id])).rows[0]).toEqual({ retried: true })
  expect((await claim()).id).toBe(a.id)
})
