import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { quoteEditRevision } from '@/lib/quote/edit-authority'
import { quoteDeletionPermission } from '@/lib/quote/delete-authority'

const mocks = vi.hoisted(() => ({ client: {} as SupabaseClient, auth: vi.fn(), provider: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => new Proxy({}, { get: (_, key) => Reflect.get(mocks.client, key) }) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: mocks.auth }))
vi.mock('@/lib/stripe/client', () => ({ getStripe: mocks.provider }))
import { DELETE } from './route'

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const Q = 'cccccccc-1111-4111-8111-cccccccccccc'
const I = 'dddddddd-1111-4111-8111-dddddddddddd'
const CHILD = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
let db: PGlite
let failRead = false
let failRpc = false
let loseAck = false
let badAck: unknown = undefined
let beforeDelete: (() => Promise<unknown>) | null = null
let reads: Array<{ table: string; filters: Array<[string, unknown]> }> = []

function adapter(): SupabaseClient {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (failRpc) return { data: null, error: { message: 'private database detail' } }
      if (badAck !== undefined) return { data: badAck, error: null }
      try {
        if (name === 'delete_supported_quote') await beforeDelete?.()
        const params = [args.p_tenant_id, args.p_quote_id]
        if (name === 'delete_supported_quote') params.push(args.p_expected_quote)
        const result = await db.query<{ receipt: unknown }>(`select ${name}(${params.map((_, index) => `$${index + 1}`).join(',')}) as receipt`, params)
        if (loseAck && name === 'delete_supported_quote') throw new Error('response lost after commit')
        return { data: result.rows[0].receipt, error: null }
      } catch (error) { return { data: null, error } }
    },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = []
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
        maybeSingle: async () => {
          reads.push({ table, filters })
          if (failRead) return { data: null, error: { message: 'private database detail' } }
          const result = await db.query<{ row: Record<string, unknown> }>(`select to_jsonb(q) as row from ${table} q where ${filters.map(([key], index) => `${key}=$${index + 1}`).join(' and ')}`, filters.map(([, value]) => value))
          return { data: result.rows[0]?.row ?? null, error: null }
        },
      }
      return query
    },
  } as unknown as SupabaseClient
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key);
    create table quotes(id uuid primary key,tenant_id uuid,intake_id uuid,status text,paid_at timestamptz,
      sent_at timestamptz,customer_released_at timestamptz,accepted_at timestamptz,scheduled_at timestamptz,share_token text,stripe_links jsonb,
      parent_quote_id uuid references quotes(id) on delete set null,quote_kind text,
      total_inc_gst numeric,good jsonb,better jsonb,best jsonb,selected_tier text,needs_inspection boolean,
      deposit_pct numeric,sms_work_id uuid);
    create table roofing_measurements(quote_id uuid,quote_share_token text);
    create table roofing_quote_revisions(base_quote_id uuid references quotes(id) on delete set null);
    create table solar_estimates(quote_id uuid references quotes(id) on delete set null);
    create table sms_work_jobs(work_key text);
    create table sms_conversations(quote_id uuid,intake_id uuid);
    create table payments(quote_id uuid references quotes(id) on delete cascade);
    insert into tenants values('${A}'),('${B}');`)
  await db.exec(readFileSync(resolve(process.cwd(), 'sql/migrations/202_job_quote_operations.sql'), 'utf8'))
  await db.exec(readFileSync(resolve(process.cwd(), 'sql/migrations/208_supported_quote_deletion.sql'), 'utf8'))
  mocks.client = adapter()
}, 60_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec('truncate quotes,job_quote_operations,roofing_measurements,roofing_quote_revisions,solar_estimates,sms_work_jobs,sms_conversations,payments cascade')
  await db.query("insert into quotes(id,tenant_id,intake_id,status,quote_kind,total_inc_gst,deposit_pct) values($1,$2,$3,'draft','initial',1100,50)", [Q,A,I])
  vi.clearAllMocks(); reads = []; failRead = false; failRpc = false; loseAck = false; badAck = undefined; beforeDelete = null
  mocks.auth.mockResolvedValue({ tenant: { id: A } })
})
function del(body?: unknown, id = Q) {
  return DELETE(new Request(`https://example.test/api/quote/${id}`, { method: 'DELETE',
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), { params: Promise.resolve({ id }) })
}
async function quote() { return (await db.query<{ row: Record<string, unknown> }>('select to_jsonb(q) as row from quotes q where id=$1', [Q])).rows[0]?.row }
async function protectedWith(reason: string) {
  expect(await quoteDeletionPermission(mocks.client, A, Q)).toEqual({ allowed: false, reason })
  const response = await del()
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ ok: false, error: reason })
  expect(await quote()).toBeDefined()
  expect(mocks.provider).not.toHaveBeenCalled()
}

describe('C05 DELETE, real migration and database action boundary', () => {
  it('acknowledges only an exact owned atomic deletion and supports canonical UUID paths', async () => {
    expect(await quoteDeletionPermission(mocks.client, A, Q)).toEqual({ allowed: true, reason: null })
    const revision = quoteEditRevision((await quote())!)
    const response = await del({ expected_revision: revision }, Q.toUpperCase())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, deleted: true, quote_id: Q })
    expect(await quote()).toBeUndefined()
    expect(reads[0].filters).toEqual([['id', Q], ['tenant_id', A]])
    expect(mocks.provider).not.toHaveBeenCalled()
  })
  it('rejects anonymous before reads and hides missing, foreign, and unscoped records', async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await del()).status).toBe(401); expect(reads).toHaveLength(0)
    mocks.auth.mockResolvedValue({ tenant: { id: B } })
    expect((await del()).status).toBe(404)
    mocks.auth.mockResolvedValue({ tenant: null })
    expect((await del()).status).toBe(404)
    mocks.auth.mockResolvedValue({ tenant: { id: A } })
    await db.exec('update quotes set tenant_id=null')
    expect((await del()).status).toBe(404)
    expect((await del(undefined, 'not-an-id')).status).toBe(404)
    expect(await quote()).toBeDefined()
  })
  it.each(['{', 'null', '[]', '{"expected_revision":"bad"}'])('rejects invalid request %s without reads', async body => {
    expect((await del(body)).status).toBe(400); expect(reads).toHaveLength(0)
  })
  it('rejects the previous native edit revision before deleting', async () => {
    const revision = quoteEditRevision((await quote())!)
    await db.exec('update quotes set total_inc_gst=1200')
    expect(await (await del({ expected_revision: revision })).json()).toEqual({ ok: false, error: 'quote_changed' })
    expect(await quote()).toBeDefined()
  })
  it('never changes an owned or foreign paid record', async () => {
    await db.exec("update quotes set paid_at=now()")
    await protectedWith('quote_already_paid')
    mocks.auth.mockResolvedValue({ tenant: { id: B } })
    expect(await (await del()).json()).toEqual({ ok: false, error: 'not_found' })
  })
  it.each(["sent_at=now()", "customer_released_at=now()", "status='sent'", "accepted_at=now()", "scheduled_at=now()"])( 'protects non-draft lifecycle %s', async set => {
    await db.exec(`update quotes set ${set}`)
    await protectedWith('quote_not_private_draft')
  })
  it.each(['public-link', 'malformed-checkout', 'live-checkout'])('retains %s without best-effort provider cancellation', async kind => {
    if (kind === 'public-link') await db.exec("update quotes set share_token='shared-token'")
    else await db.query('update quotes set stripe_links=$1', [{ good: kind === 'live-checkout' ? 'https://checkout.stripe.com/c/pay/cs_test_fixture' : 123 }])
    await protectedWith(kind === 'public-link' ? 'quote_has_public_link' : 'quote_has_checkout')
  })
  it('protects both parent and child chain records', async () => {
    await db.query("insert into quotes(id,tenant_id,intake_id,parent_quote_id,quote_kind) values($1,$2,$3,$4,'final')", [CHILD,A,I,Q])
    await protectedWith('quote_has_chain')
    expect(await (await del(undefined, CHILD)).json()).toEqual({ ok: false, error: 'quote_has_chain' })
  })
  it.each(['processing', 'unknown', 'completed'])('protects %s durable operation history including un-stamped quote_available', async state => {
    await db.query('insert into job_quote_operations(tenant_id,operation_id,request_hash,intake_id,status,quote_id) values($1,$2,$3,$4,$5,$6)', [A,CHILD,'a'.repeat(64),I,state,state === 'completed' ? Q : null])
    await protectedWith('quote_has_operation_history')
  })
  it.each(['roofing_measurements', 'roofing_quote_revisions', 'solar_estimates'])('protects %s without hiding or unlinking saved work', async table => {
    await db.query(`insert into ${table}(${table === 'roofing_quote_revisions' ? 'base_quote_id' : 'quote_id'}) values($1)`, [Q])
    await protectedWith('quote_has_saved_job')
    expect((await db.query(`select * from ${table}`)).rows).toHaveLength(1)
  })
  it.each(['worker', 'conversation', 'payment'])('protects %s history', async kind => {
    if (kind === 'worker') await db.query('insert into sms_work_jobs values($1)', [`estimate:initial:${I}`])
    if (kind === 'conversation') await db.query('insert into sms_conversations(intake_id) values($1)', [I])
    if (kind === 'payment') await db.query('insert into payments values($1)', [Q])
    await protectedWith(kind === 'payment' ? 'quote_has_payment_history' : 'quote_has_workflow_history')
  })
  it.each(['price', 'paid', 'share', 'child'])('rechecks %s changes after route read inside atomic function', async kind => {
    beforeDelete = () => kind === 'child'
      ? db.query('insert into quotes(id,parent_quote_id) values($1,$2)', [CHILD,Q])
      : db.exec(`update quotes set ${kind === 'price' ? 'total_inc_gst=1200' : kind === 'paid' ? 'paid_at=now()' : "share_token='late-share'"}`)
    const response = await del()
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe(kind === 'price' ? 'quote_changed' : kind === 'paid' ? 'quote_already_paid' : kind === 'share' ? 'quote_has_public_link' : 'quote_has_chain')
    expect(await quote()).toBeDefined()
  })
  it('maps database lookup and RPC errors to retryable unavailable, without leaked details', async () => {
    for (const stage of ['read', 'rpc']) {
      failRead = stage === 'read'; failRpc = stage === 'rpc'
      const response = await del()
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ ok: false, error: 'quote_delete_unavailable' })
      expect(await quote()).toBeDefined()
    }
    expect(await quoteDeletionPermission(mocks.client, A, Q)).toEqual({ allowed: false, reason: 'quote_delete_unavailable' })
  })
  it.each([null, {}, { ok: true }, { ok: true, deleted: true, quote_id: CHILD }])('does not claim deletion from an incomplete acknowledgment %j', async response => {
    badAck = response
    expect((await del()).status).toBe(503)
    expect(await quote()).toBeDefined()
  })
  it('reports response loss as unknown and permits a read/404 reconciliation after real commit', async () => {
    loseAck = true
    expect((await del()).status).toBe(503)
    expect(await quote()).toBeUndefined()
    expect((await del()).status).toBe(404)
  })
  it('keeps functions unavailable to guest and authenticated database roles', async () => {
    const result = await db.query<{ allowed: boolean }>("select has_function_privilege('anon','delete_supported_quote(uuid,uuid,jsonb)','EXECUTE') or has_function_privilege('authenticated','quote_deletion_permission(uuid,uuid)','EXECUTE') as allowed")
    expect(result.rows[0].allowed).toBe(false)
  })
})
