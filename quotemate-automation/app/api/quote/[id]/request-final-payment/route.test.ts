import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
type Row = Record<string, unknown>
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'
const I = 'cccccccc-1111-4111-8111-cccccccccccc', R = 'dddddddd-1111-4111-8111-dddddddddddd'
const F = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee', VERSION = 'ffffffff-1111-4111-8111-ffffffffffff'
const state = vi.hoisted(() => ({ client: null as unknown, tenant: null as Row | null, ready: true,
  dispatches: [] as Row[], rpcNames: [] as string[], outcome: 'accepted', loseAck: '',
  beforePrepare: null as (() => Promise<void>) | null, readErrorTable: '', readOverride: null as ((table: string, row: Row) => Row) | null,
}))
let pg: PGlite
vi.mock('@supabase/supabase-js', () => ({ createClient: () => new Proxy({}, { get: (_, key) => (state.client as Row)[key as string] }) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => state.tenant ? { tenant: state.tenant, identity: { userId: 'owner_A' } } : null }))
vi.mock('@/lib/stripe/checkout', () => ({ generateShareToken: () => 'link-' + randomUUID() }))
vi.mock('@/lib/quote/job-quote-operation', () => ({ readQuoteDraftReadiness: async () => state.ready ? { ready: true } : { ready: false, code: 'quote_draft_processing' } }))
vi.mock('@/lib/sms/quote-origin-conversation', () => ({ resolveQuoteOriginConversation: async () => null }))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: async (input: Row) => dispatchDurably(input as OutboundOptions, async () => {
  state.dispatches.push(input)
  if (state.outcome === 'throw') throw new Error('response lost')
  if (state.outcome !== 'accepted') return { ok: false, smsAttempt: { code: 'AMBIGUOUS', reason: 'Provider outcome unknown' }, smsAttempts: 1 }
  return { ok: true, channel: 'sms', sid: 'SM-test', status: 'queued' }
}) }))
import { GET, POST } from './route'
import { quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { dispatchDurably, type OutboundOptions } from '@/lib/sms/durable-outbox'

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key);
    create table sms_conversations(id uuid primary key,from_number text,to_number text,status text,conversation_type text,tenant_id uuid,intake_id uuid,created_at timestamptz default now());
    create table sms_messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,direction text,body text,twilio_message_sid text,audience text,to_number text,tenant_id uuid);
    create table intakes(id uuid primary key,tenant_id uuid,trade text,job_type text,caller jsonb,call_id uuid,customer_id uuid);
    create table calls(id uuid primary key,tenant_id uuid,caller_number text);
    create table customers(id uuid primary key,tenant_id uuid,phone_number text,email text);
    create table quotes(id uuid primary key default gen_random_uuid(),tenant_id uuid,intake_id uuid,status text,paid_at timestamptz,paid_tier text,sent_at timestamptz,price_hold_until timestamptz,
      share_token text unique,good jsonb,better jsonb,best jsonb,total_inc_gst numeric,selected_tier text,scope_of_works text,scope_short text,assumptions jsonb,estimated_timeframe text,gst_note text,
      needs_inspection boolean,inspection_reason text,deposit_pct numeric,display_mode text,applied_discount_pct numeric,quote_kind text,parent_quote_id uuid,stripe_links jsonb,pricing_book_version_id uuid,report_doc jsonb,report_style jsonb);
    create unique index unpaid_child on quotes(parent_quote_id,quote_kind) where paid_at is null and quote_kind in ('final','balance');
    create table plan_upload_requests(id uuid primary key default gen_random_uuid(),token text unique,tenant_id uuid,sms_conversation_id uuid,customer_phone text,twilio_number text,status text,created_at timestamptz default now(),updated_at timestamptz default now(),expires_at timestamptz);`)
  for (const file of ['198_sms_durable_work.sql', '199_sms_delivery_outbox.sql', '205_generic_quote_customer_release.sql', '213_prepare_balance_quote.sql', '215_generic_release_snapshot.sql']) {
    await pg.exec(readFileSync('sql/migrations/' + file, 'utf8'))
  }
  await pg.query('insert into tenants values($1),($2)', [A, B])
  state.client = {
    rpc: async (name: string, args: Row) => {
      state.rpcNames.push(name)
      if (name === 'sms_outbox_claim' && state.outcome === 'queued') return { data: null, error: { message: 'Claim unavailable' } }
      if (name === 'prepare_balance_quote' && state.beforePrepare) { const run = state.beforePrepare; state.beforePrepare = null; await run() }
      try {
        const pairs = Object.entries(args)
        const result = await pg.query<{ value: Row }>('select ' + name + '(' + pairs.map(([key], index) => key + '=>$' + (index + 1)).join(',') + ') value', pairs.map(([, value]) => value))
        return state.loseAck === name ? { data: null, error: { message: 'Acknowledgement lost' } } : { data: result.rows[0].value, error: null }
      } catch (error) { return { data: null, error } }
    },
    from: (table: string) => {
      const filters: string[] = [], args: unknown[] = [], orders: string[] = []
      let projection = '*', limit: number | null = null
      const result = async () => {
        if (state.readErrorTable === table) return { data: null, error: { message: 'Read unavailable' } }
        try {
          const sql = 'select to_jsonb(t) row from (select ' + projection + ' from ' + table +
            (filters.length ? ' where ' + filters.join(' and ') : '') + (orders.length ? ' order by ' + orders.join(',') : '') + (limit ? ' limit ' + limit : '') + ') t'
          const result = await pg.query<{ row: Row }>(sql, args)
          return { data: result.rows.map(({ row }) => state.readOverride?.(table, row) ?? row), error: null }
        } catch (error) { return { data: null, error } }
      }
      const query = {
        select: (value: string) => { projection = value; return query },
        eq: (key: string, value: unknown) => { args.push(value); filters.push(key + '=$' + args.length); return query },
        limit: (value: number) => { limit = value; return query },
        order: (key: string, opts: { ascending: boolean }) => { orders.push(key + (opts.ascending ? ' asc' : ' desc')); return query },
        maybeSingle: async () => { const value = await result(); return { ...value, data: value.data?.[0] ?? null } },
        then: (resolve: (value: unknown) => unknown) => result().then(resolve),
      }
      return query
    },
  }
}, 30_000)
afterAll(async () => { await pg?.close() })
beforeEach(async () => {
  state.tenant = { id: A, twilio_sms_number: '+61488888888', business_name: 'Owner business', stripe_connect_account_id: 'acct_A', stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true }
  state.ready = true; state.outcome = 'accepted'; state.dispatches = []; state.rpcNames = []; state.loseAck = ''; state.beforePrepare = null; state.readErrorTable = ''; state.readOverride = null
  process.env.PUBLIC_WEB_ORIGIN = 'https://web.example.test'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://database.example.test'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-no-network'
  await pg.exec('truncate sms_messages,sms_outbox,sms_conversations,quotes,intakes,calls,customers cascade')
  await pg.query(`insert into intakes(id,tenant_id,trade,job_type,caller) values($1,$2,'electrical','ev_charger','{"name":"Customer","phone":"+61411111111"}')`, [I, A])
  await pg.query("insert into quotes(id,tenant_id,intake_id,quote_kind,paid_at,paid_tier,status,share_token) values($1,$2,$3,'initial',now(),'inspection','paid','root')", [R, A, I])
  await pg.query(`insert into quotes(id,tenant_id,intake_id,quote_kind,parent_quote_id,paid_at,paid_tier,sent_at,status,share_token,total_inc_gst,deposit_pct,scope_of_works,assumptions,pricing_book_version_id,gst_note)
    values($1,$2,$3,'final',$4,now(),'deposit',now(),'paid','final',1000,30,'Completed work','[]',$5,'GST not registered')`, [F, A, I, R, VERSION])
})
async function saved(id: string) { return (await pg.query<{ row: Row }>('select to_jsonb(q) row from quotes q where id=$1', [id])).rows[0].row }
async function post(input?: Row) {
  const body = input ?? { expected_revision: quoteCustomerReleaseRevision(await saved(F)), expected_recipient: '+61411111111' }
  return POST(new Request('https://web.example.test/api/quote/' + F + '/request-final-payment', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: F }) })
}
const get = (requestId?: string) => GET(new Request('https://web.example.test/api/quote/' + F + '/request-final-payment' + (requestId ? '?requestId=' + requestId : '')), { params: Promise.resolve({ id: F }) })
async function balances() { return (await pg.query<{ row: Row }>("select to_jsonb(q) row from quotes q where quote_kind='balance'")).rows.map(value => value.row) }
async function child(extra = '') {
  const result = await pg.query<{ id: string }>(`insert into quotes(tenant_id,intake_id,quote_kind,parent_quote_id,total_inc_gst,deposit_pct,pricing_book_version_id,share_token,status${extra ? ',paid_at' : ''})
    values($1,$2,'balance',$3,700,30,$4,$5,'draft'${extra ? ',now()' : ''}) returning id`, [A, I, F, VERSION, randomUUID()])
  return result.rows[0].id
}

describe('balance request real route + SQL213/205/199 action boundaries', () => {
  it('prepares the exact saved balance/version and only marks sent after outbox acceptance', async () => {
    const response = await post(); const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ accepted: true, status: 'provider_accepted', finalQuoteId: F, channel: 'sms', balance_cents: 70000, charged_cents: 71400 })
    expect(await saved(body.quote_id)).toMatchObject({ total_inc_gst: 700, deposit_pct: 30, quote_kind: 'balance', parent_quote_id: F, pricing_book_version_id: VERSION, gst_note: 'GST not registered', status: 'sent' })
    expect(state.dispatches[0]).toMatchObject({ tenantId: A, to: '+61411111111', deliveryKey: 'quote-release:generic:' + body.quote_id + ':initial', quoteReleaseId: body.quote_id })
    expect(state.dispatches[0].text).toContain('https://web.example.test/r/')
  })
  it('returns queued recovery without sent_at and GET omits stored body/recipient payload', async () => {
    state.outcome = 'queued'
    const response = await post(); const body = await response.json()
    expect(response.status).toBe(202); expect(body).toMatchObject({ sent: false, accepted: false, status: 'approved_delivery_pending' })
    expect(await saved(body.quote_id)).toMatchObject({ sent_at: null, status: 'draft' })
    const read = await get(); const recovered = await read.json()
    expect(recovered).toMatchObject({ finalQuoteId: F, quoteId: body.quote_id, status: 'pending', approved: true, outboxId: body.outboxId })
    expect(JSON.stringify(recovered)).not.toContain('+61411111111'); expect(recovered.message).not.toHaveProperty('payload')
    expect(read.headers.get('Cache-Control')).toContain('no-store')
  })
  it('recovers a lost prepare acknowledgement as one unpublished child without sending', async () => {
    state.loseAck = 'prepare_balance_quote'
    expect((await post()).status).toBe(409); expect(state.dispatches).toHaveLength(0)
    expect(await balances()).toHaveLength(1)
    expect(await (await get()).json()).toMatchObject({ status: 'not_found', approved: false, outboxId: null })
  })
  it('recovers lost release acknowledgement by final ID without another POST', async () => {
    state.loseAck = 'approve_generic_quote_release'
    expect((await post()).status).toBe(503); expect(state.dispatches).toHaveLength(0)
    expect(await (await get()).json()).toMatchObject({ status: 'pending', approved: true })
    expect((await pg.query('select id from sms_outbox')).rows).toHaveLength(1)
  })
  it('uses the same initial child/outbox for duplicate requests and exact deliberate resend IDs', async () => {
    state.outcome = 'unknown'
    const [a, b] = await Promise.all([post(), post()])
    expect(a.status).toBe(202); expect(b.status).toBe(202)
    expect(await balances()).toHaveLength(1); expect((await pg.query('select id from sms_outbox')).rows).toHaveLength(1)
    expect(state.dispatches).toHaveLength(1)
    const requestId = randomUUID()
    await post({ requestId }); await post({ requestId })
    expect((await pg.query('select id from sms_outbox')).rows).toHaveLength(2)
    expect(state.dispatches).toHaveLength(2)
    expect(await (await get(requestId)).json()).toMatchObject({ requestId, status: 'unknown' })
    expect(await (await get(randomUUID())).json()).toMatchObject({ status: 'not_found' })
  })
  it.each([null, '', ' ', true, '1000x', -1, 1.001, Number.POSITIVE_INFINITY])('rejects invalid raw amount %s before preparation', async value => {
    state.readOverride = (table, row) => table === 'quotes' && row.id === F ? { ...row, total_inc_gst: value } : row
    expect((await post({})).status).toBe(409); expect(state.rpcNames).toHaveLength(0); expect(state.dispatches).toHaveLength(0)
  })
  it.each([null, '', ' ', true, 0, 100])('rejects missing/invalid deposit %s without defaulting', async value => {
    state.readOverride = (table, row) => table === 'quotes' && row.id === F ? { ...row, deposit_pct: value } : row
    expect((await post({})).status).toBe(409); expect(state.rpcNames).toHaveLength(0)
  })
  it.each([10, 50, 30.5])('preserves saved deposit %s and matches canonical arithmetic', async pct => {
    await pg.query('update quotes set deposit_pct=$1 where id=$2', [pct, F])
    const response = await post(); expect(response.status).toBe(200)
    const body = await response.json(); expect((await saved(body.quote_id)).deposit_pct).toBe(pct)
    expect(body.balance_cents).toBe(100000 - Math.max(9900, Math.round(100000 * Math.round(pct) / 100)))
  })
  it.each(['foreign', 'wrong-intake', 'not-inspection', 'unpaid', 'nested', 'wrong-trade'])('refuses invalid %s root proof before writes', async issue => {
    if (issue === 'foreign') await pg.query('update quotes set tenant_id=$1 where id=$2', [B, R])
    if (issue === 'wrong-intake') await pg.query('update quotes set intake_id=$1 where id=$2', [randomUUID(), R])
    if (issue === 'not-inspection') await pg.query("update quotes set paid_tier='good' where id=$1", [R])
    if (issue === 'unpaid') await pg.query('update quotes set paid_at=null where id=$1', [R])
    if (issue === 'nested') await pg.query('update quotes set parent_quote_id=$1 where id=$2', [randomUUID(), R])
    if (issue === 'wrong-trade') await pg.query("update intakes set trade='solar' where id=$1", [I])
    expect((await post()).status).toBe(409); expect(state.rpcNames).toHaveLength(0)
  })
  it.each(['final', 'root', 'intake'])('rejects a changed %s after the route read but before the locked preparation', async which => {
    state.beforePrepare = async () => {
      if (which === 'final') await pg.query('update quotes set total_inc_gst=2000 where id=$1', [F])
      if (which === 'root') await pg.query('update quotes set paid_at=null where id=$1', [R])
      if (which === 'intake') await pg.query(`update intakes set caller='{"phone":"+61422222222"}' where id=$1`, [I])
    }
    expect((await post()).status).toBe(409); expect(await balances()).toHaveLength(0); expect(state.dispatches).toHaveLength(0)
  })
  it('does not create another balance when a historical child settles during preparation', async () => {
    const id = await child()
    state.beforePrepare = async () => { await pg.query('update quotes set paid_at=now() where id=$1', [id]) }
    expect(await (await post()).json()).toMatchObject({ already_actioned: true, status: 'balance_already_paid', quote_id: id })
    expect(await balances()).toHaveLength(1); expect(state.dispatches).toHaveLength(0)
  })
  it('rejects a mismatched recovered amount rather than replacing it', async () => {
    const id = await child(); await pg.query('update quotes set total_inc_gst=1 where id=$1', [id])
    expect((await post()).status).toBe(409); expect((await saved(id)).total_inc_gst).toBe(1); expect(state.dispatches).toHaveLength(0)
  })
  it.each(['amount', 'version'])('does not claim full payment for a corrupt paid balance %s', async issue => {
    const id = await child('paid')
    if (issue === 'amount') await pg.query('update quotes set total_inc_gst=1 where id=$1', [id])
    else await pg.query('update quotes set pricing_book_version_id=$1 where id=$2', [randomUUID(), id])
    expect((await post()).status).toBe(409); expect((await get()).status).toBe(409)
    expect(state.dispatches).toHaveLength(0)
  })
  it('confirms a valid paid balance through both action and recovery without dispatch', async () => {
    const id = await child('paid')
    expect(await (await post()).json()).toMatchObject({ status: 'balance_already_paid', finalQuoteId: F, quote_id: id })
    expect(await (await get()).json()).toMatchObject({ balancePaid: true, finalQuoteId: F, quoteId: id })
    expect(state.dispatches).toHaveLength(0)
  })
  it('rejects an impossible credit stamp and allows an actual covered deposit', async () => {
    await pg.query("update quotes set paid_tier='credit' where id=$1", [F])
    expect((await post()).status).toBe(409); expect(state.rpcNames).toHaveLength(0)
    await pg.query('update quotes set total_inc_gst=300 where id=$1', [F])
    expect(await (await post()).json()).toMatchObject({ status: 'provider_accepted', balance_cents: 20100 })
  })
  it('enforces settlement/amount agreement inside SQL even for a stale route snapshot', async () => {
    state.beforePrepare = async () => { await pg.query("update quotes set paid_tier='credit' where id=$1", [F]) }
    expect((await post()).status).toBe(409); expect(await balances()).toHaveLength(0)
  })
  it('does not invent a new initial send for a historical sent balance without a durable intent', async () => {
    const id = await child(); await pg.query("update quotes set sent_at=now(),status='sent' where id=$1", [id])
    expect(await (await post()).json()).toMatchObject({ already_actioned: true, status: 'legacy_delivery_review_required' })
    expect(state.dispatches).toHaveLength(0)
  })
  it('checks expected recipient/revision and does not use either as an override', async () => {
    expect((await post({ expected_recipient: '+61422222222' })).status).toBe(409)
    expect((await post({ expected_recipient: '' })).status).toBe(400)
    expect((await post({ expected_revision: 'stale' })).status).toBe(409)
    expect(state.rpcNames).toHaveLength(0)
    expect((await post({ expected_recipient: '0411 111 111' })).status).toBe(200)
    expect(state.dispatches[0].to).toBe('+61411111111')
  })
  it('fails closed on tenant, contact-read and processing uncertainty', async () => {
    state.tenant = { ...state.tenant, id: B }
    expect((await get()).status).toBe(404); expect((await post()).status).toBe(404)
    state.tenant!.id = A; state.ready = false
    expect((await post()).status).toBe(409)
    state.ready = true; await pg.query("update intakes set caller='{}' where id=$1", [I]); state.readErrorTable = 'sms_conversations'
    expect((await post()).status).toBe(503); expect(state.rpcNames).toHaveLength(0)
  })
  it('does not turn missing child readback into proof of no commit', async () => {
    expect(await (await get()).json()).toMatchObject({ status: 'not_created', quoteId: null })
    expect(state.rpcNames).toHaveLength(0); expect(state.dispatches).toHaveLength(0)
  })
  it('keeps prepare RPC inaccessible to public/authenticated clients', async () => {
    expect((await pg.query<{ allowed: boolean }>("select has_function_privilege('authenticated','prepare_balance_quote(uuid,uuid,jsonb,jsonb,jsonb,bigint,text)','execute') allowed")).rows[0].allowed).toBe(false)
  })
})
