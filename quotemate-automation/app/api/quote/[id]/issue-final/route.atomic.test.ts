import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
type Row = Record<string, unknown>
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'
const I = 'cccccccc-1111-4111-8111-cccccccccccc', R = 'dddddddd-1111-4111-8111-dddddddddddd', BOOK = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
const state = vi.hoisted(() => ({ client: null as unknown, tenant: null as Row | null, loseAck: false,
  beforeCreate: null as (() => Promise<void>) | null, changeCandidate: null as ((args: Row) => void) | null,
  errors: [] as unknown[], readError: '', captures: 0,
}))
let pg: PGlite
vi.mock('@supabase/supabase-js', () => ({ createClient: () => new Proxy({}, { get: (_, key) => (state.client as Row)[key as string] }) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => state.tenant ? { tenant: state.tenant } : null }))
vi.mock('@/lib/stripe/checkout', () => ({ generateShareToken: () => 'link-' + randomUUID() }))
vi.mock('@/lib/log/pipeline', () => ({ pipelineLog: () => ({ ok: vi.fn(), err: vi.fn() }) }))
import { POST } from './route'
import { quoteEditRevision } from '@/lib/quote/edit-authority'
import { resolveDepositPct, totalIncGstCents } from '@/lib/quote/money'
const migration = readFileSync('sql/migrations/214_prepare_final_quote.sql', 'utf8')
const schema = `create role anon; create role authenticated; create role service_role;
 create table tenants(id uuid primary key);
 create table intakes(id uuid primary key,tenant_id uuid,trade text,job_type text,caller jsonb);
 create table pricing_book(id uuid primary key,tenant_id uuid,trade text,gst_registered boolean,hourly_rate numeric,overlays jsonb);
 create table quotes(id uuid primary key default gen_random_uuid(),tenant_id uuid,intake_id uuid,quote_kind text,parent_quote_id uuid,
 paid_at timestamptz,paid_tier text,status text,share_token text unique,good jsonb,better jsonb,best jsonb,selected_tier text,
 subtotal_ex_gst numeric,gst numeric,total_inc_gst numeric,scope_of_works text,scope_short text,assumptions jsonb,risk_flags jsonb,
 estimated_timeframe text,gst_note text,display_mode text,optional_upsells jsonb,deposit_pct numeric,
 needs_inspection boolean,inspection_reason text,stripe_links jsonb,price_hold_until timestamptz,customer_released_at timestamptz,sent_at timestamptz);
 create unique index unpaid_child on quotes(parent_quote_id,quote_kind) where paid_at is null and quote_kind in ('final','balance');`
beforeAll(async () => {
 pg = new PGlite(); await pg.exec(schema)
 await pg.exec(readFileSync('sql/migrations/207_quote_pricing_versions.sql', 'utf8')); await pg.exec(migration)
 await pg.query('insert into tenants values($1),($2)', [A, B])
 state.client = {
  rpc: async (name: string, args: Row) => {
   if (name === 'capture_quote_pricing_version') state.captures++
   if (args.p_child) {
    if (state.beforeCreate) { const run = state.beforeCreate; state.beforeCreate = null; await run() }
    state.changeCandidate?.(args)
   }
   try {
    const pairs = Object.entries(args)
    const result = await pg.query<{ value: Row }>('select ' + name + '(' + pairs.map(([key], index) => key + '=>$' + (index + 1)).join(',') + ') value', pairs.map(([, value]) => value))
    return state.loseAck && args.p_child ? { data: null, error: { message: 'Acknowledgement lost' } } : { data: result.rows[0].value, error: null }
   } catch (error) { state.errors.push(error); return { data: null, error } }
  },
  from: (table: string) => {
   const filters: string[] = [], args: unknown[] = []; let projection = '*'
   const query = {
    select: (value: string) => { projection = value; return query },
    eq: (key: string, value: unknown) => { args.push(value); filters.push(key + '=$' + args.length); return query },
    maybeSingle: async () => {
     if (state.readError === table) return { data: null, error: { message: 'Read unavailable' } }
     try {
      const result = await pg.query<{ row: Row }>('select to_jsonb(t) row from (select ' + projection + ' from ' + table + (filters.length ? ' where ' + filters.join(' and ') : '') + ') t', args)
      return { data: result.rows[0]?.row ?? null, error: null }
     } catch (error) { return { data: null, error } }
    },
   }; return query
  },
 }
}, 30_000)
afterAll(async () => { await pg?.close() })
beforeEach(async () => {
 state.tenant = { id: A, stripe_connect_account_id: 'acct_A', stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true }
 state.loseAck = false; state.beforeCreate = null; state.changeCandidate = null; state.errors = []; state.readError = ''; state.captures = 0
 await pg.exec('truncate quotes,intakes,quote_pricing_versions,pricing_book cascade')
 await pg.query("insert into intakes(id,tenant_id,trade,job_type) values($1,$2,'electrical','ev_charger')", [I, A])
 await pg.query("insert into quotes(id,tenant_id,intake_id,quote_kind,paid_at,paid_tier,status,share_token) values($1,$2,$3,'initial',now(),'inspection','paid','root')", [R, A, I])
 await pg.query(`insert into pricing_book values($1,$2,'electrical',false,125,'{"deposit_pct_by_job_type":{"ev_charger":50}}')`, [BOOK, A])
})
async function saved(id = R) { return (await pg.query<{ row: Row }>('select to_jsonb(q) row from quotes q where id=$1', [id])).rows[0].row }
async function finals() { return (await pg.query<{ row: Row }>("select to_jsonb(q) row from quotes q where quote_kind='final'")).rows.map(value => value.row) }
const post = (body?: string) => POST(new Request('https://example.test/api/quote/' + R + '/issue-final', { method: 'POST', body }), { params: Promise.resolve({ id: R }) })
async function historical(tier: Row) {
 const book = (await pg.query<{ row: Row }>('select to_jsonb(b) row from pricing_book b where id=$1', [BOOK])).rows[0].row
 const version = (await pg.query<{ row: Row }>('select capture_quote_pricing_version($1,$2,$3,$4) row', [A, 'electrical', BOOK, book])).rows[0].row
 await pg.query("update quotes set pricing_book_version_id=$1,good=$2,selected_tier='good' where id=$3", [version.id, tier, R])
 await pg.query('update pricing_book set gst_registered=true,hourly_rate=200 where id=$1', [BOOK]); return version
}
describe('issue final real route + SQL207/214 locked authority', () => {
 it.each(['{', 'null', '[]', '{"expected_revision":null}', '{"expected_revision":""}'])('rejects malformed body/revision %s before any capture/create', async body => {
  expect((await post(body)).status).toBe(400); expect(state.captures).toBe(0); expect(await finals()).toHaveLength(0)
 })
 it('checks the same parent revision as owned GET before preparing a draft', async () => {
  const revision = quoteEditRevision(await saved())
  expect(await (await post(JSON.stringify({ expected_revision: 'f'.repeat(64) }))).json()).toMatchObject({ error: 'quote_review_required' })
  expect(state.captures).toBe(0)
  const response = await post(JSON.stringify({ expected_revision: revision }))
  expect(await response.json()).toMatchObject({ ok: true, parent_quote_id: R })
 })
 it.each([true, false])('creates an unsent zero draft with captured GST %s', async tax => {
  await pg.query('update pricing_book set gst_registered=$1', [tax])
  const response = await post(); const body = await response.json()
  expect(state.errors).toEqual([]); expect(response.status).toBe(200); expect(body).toMatchObject({ deposit_pct: 50, already: false })
  expect(await saved(body.quote_id)).toMatchObject({ pricing_book_version_id: expect.any(String), total_inc_gst: 0, status: 'draft', stripe_links: {}, sent_at: null, paid_at: null, customer_released_at: null })
 })
 it('reopens the exact saved child after the mutable book is removed', async () => {
  const first = await (await post()).json(); await pg.exec('delete from pricing_book')
  expect(await (await post()).json()).toMatchObject({ already: true, quote_id: first.quote_id, share_token: first.share_token }); expect(await finals()).toHaveLength(1)
 })
 it.each([0, 1])('copies the historical price/version and exact provenance with quantity %s', async quantity => {
  const line = { description: 'Original', quantity, unit_price_ex_gst: 100, source: 'assembly:a', supplied_by: 'customer', safety_note: 'Keep' }
  const version = await historical({ label: 'Quoted', subtotal_ex_gst: quantity * 100, line_items: [line] })
  const response = await post(); const body = await response.json(); expect(state.errors).toEqual([]); expect(response.status).toBe(200)
  expect(await saved(body.quote_id)).toMatchObject({ pricing_book_version_id: version.id, total_inc_gst: quantity * 100, deposit_pct: 50, good: { line_items: [line] } })
 })
 it('materialises a historical subtotal without lines', async () => {
  await historical({ label: 'Quoted', subtotal_ex_gst: 100 })
  expect((await post()).status).toBe(200); expect((await finals())[0]).toMatchObject({ good: { line_items: [{ description: 'Quoted — as quoted', unit_price_ex_gst: 100 }] } })
 })
 it.each([null, '', 999])('rejects a contradictory stored line amount %s instead of copying it', async amount => {
  await historical({ subtotal_ex_gst: 100, line_items: [{ description: 'Work', quantity: 1, unit_price_ex_gst: 100, total_ex_gst: amount }] })
  expect((await post()).status).toBe(409); expect(await finals()).toHaveLength(0); expect(state.captures).toBe(0)
 })
 it.each([{ ev_charger: 24.5 }, { ev_charger: null, default: 60 }, {}, { ev_charger: 0 },
  { ev_charger: '50%' }, { ev_charger: '2.5e1 trailing' }, { ev_charger: true }, { ev_charger: [50] }])('keeps the established captured deposit policy %j', async policy => {
  await pg.query('update pricing_book set overlays=$1', [{ deposit_pct_by_job_type: policy }])
  const response = await post(); const body = await response.json(); expect(state.errors).toEqual([]); expect(response.status).toBe(200)
  expect(body.deposit_pct).toBe(resolveDepositPct(policy, 'ev_charger'))
 })
 it('uses the captured deposit policy when the mutable book changes after capture', async () => {
  state.beforeCreate = async () => { await pg.exec(`update pricing_book set overlays='{"deposit_pct_by_job_type":{"ev_charger":10}}'`) }
  expect(await (await post()).json()).toMatchObject({ deposit_pct: 50 })
 })
 it('preserves the canonical IEEE-754 GST boundary for a $1.15 saved source', async () => {
  await pg.exec('update pricing_book set gst_registered=true')
  await historical({ subtotal_ex_gst: 1.15 })
  const response = await post(); const body = await response.json(); expect(state.errors).toEqual([]); expect(response.status).toBe(200)
  expect(await saved(body.quote_id)).toMatchObject({ total_inc_gst: totalIncGstCents(1.15, { gstRegistered: true }) / 100 })
  expect((await saved(body.quote_id)).total_inc_gst).toBe(1.26)
 })
 it('preserves canonical fractional unit-price rounding when copied line totals are present', async () => {
  await historical({ subtotal_ex_gst: 1, line_items: [{ description: 'Measured', quantity: 1, unit_price_ex_gst: 1.005, total_ex_gst: 1 }] })
  const response = await post(); expect(state.errors).toEqual([]); expect(response.status).toBe(200)
  expect((await finals())[0]).toMatchObject({ subtotal_ex_gst: 1, good: { line_items: [{ unit_price_ex_gst: 1.005, total_ex_gst: 1 }] } })
 })
 it.each(['parent', 'intake'])('rechecks the full %s snapshot immediately before creation', async target => {
  state.beforeCreate = async () => { await pg.exec(target === 'parent' ? "update quotes set scope_short='Changed'" : "update intakes set caller='{}'") }
  expect(await (await post()).json()).toMatchObject({ error: 'final_prepare_unconfirmed' }); expect(await finals()).toHaveLength(0)
 })
 it('does not create a second final if a competing child is created and paid between probe and commit', async () => {
  state.beforeCreate = async () => { const other = await (await post()).json(); await pg.query("update quotes set paid_at=now(),paid_tier='deposit' where id=$1", [other.quote_id]) }
  expect(await (await post()).json()).toMatchObject({ error: 'final_already_paid' }); expect(await finals()).toHaveLength(1)
 })
 it('serializes concurrent creation requests to one acknowledged child', async () => {
  const bodies = await Promise.all([post(), post()]).then(responses => Promise.all(responses.map(response => response.json())))
  expect(state.errors).toEqual([]); expect(bodies.every(body => body.ok)).toBe(true); expect(new Set(bodies.map(body => body.quote_id)).size).toBe(1); expect(await finals()).toHaveLength(1)
 })
 it('reports an unknown write and recovers the same child after lost acknowledgement', async () => {
  state.loseAck = true; expect(await (await post()).json()).toMatchObject({ ok: false, error: 'final_prepare_unconfirmed' })
  const [child] = await finals(); expect(child).toBeTruthy(); state.loseAck = false
  expect(await (await post()).json()).toMatchObject({ already: true, quote_id: child.id }); expect(await finals()).toHaveLength(1)
 })
 it.each(['deposit', 'price', 'provenance', 'payment'])('rejects injected %s that differs from locked authority', async field => {
  state.changeCandidate = args => { const c = args.p_child as Row
   if (field === 'deposit') c.deposit_pct = 30
   if (field === 'price') c.total_inc_gst = 99
   if (field === 'payment') c.paid_at = '2026-09-09'
   if (field === 'provenance') ((c.good as Row).line_items as Row[])[0].source = 'assembly:injected'
  }
  expect((await post()).status).toBe(409); expect(await finals()).toHaveLength(0)
 })
 it('pins intake ownership before any pricing capture', async () => {
  await pg.query('update intakes set tenant_id=$1', [B]); expect((await post()).status).toBe(409); expect(state.captures).toBe(0)
 })
 it('does not claim a missing intake on a lookup outage', async () => {
  state.readError = 'intakes'; expect(await (await post()).json()).toMatchObject({ error: 'intake_unavailable' }); expect(await finals()).toHaveLength(0)
 })
 it('permanent uniqueness blocks direct second-final insertion after the first settles', async () => {
  const first = await (await post()).json(); await pg.query("update quotes set paid_at=now(),paid_tier='deposit' where id=$1", [first.quote_id])
  await expect(pg.query("insert into quotes(tenant_id,intake_id,quote_kind,parent_quote_id,share_token) values($1,$2,'final',$3,'second')", [A, I, R])).rejects.toMatchObject({ code: '23505' })
 })
 it('grants the RPC only to service_role', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
   const result = await pg.query<{ allowed: boolean }>("select has_function_privilege($1,'prepare_final_quote(uuid,uuid,jsonb,jsonb,jsonb,uuid)','execute') allowed", [role])
   expect(result.rows[0].allowed).toBe(role === 'service_role')
  }
 })
 it('migration refuses duplicate paid/unpaid history with actionable IDs and preserves the rows', async () => {
  const isolated = new PGlite()
  try {
   await isolated.exec(schema); await isolated.query("insert into quotes(parent_quote_id,quote_kind,paid_at,share_token) values($1,'final',now(),'paid'),($1,'final',null,'unpaid')", [R])
   await expect(isolated.exec(migration)).rejects.toThrow('review duplicate final children for parent IDs ' + R)
   await isolated.exec('rollback'); expect((await isolated.query<{ count: number }>('select count(*)::int count from quotes')).rows[0].count).toBe(2)
  } finally { await isolated.close() }
 })
})
