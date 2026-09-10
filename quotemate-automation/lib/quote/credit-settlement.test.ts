import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
type Row = Record<string, unknown>
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'
const I = 'cccccccc-1111-4111-8111-cccccccccccc', R = 'dddddddd-1111-4111-8111-dddddddddddd'
const F = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee', BOOK = 'ffffffff-1111-4111-8111-ffffffffffff'
const h = vi.hoisted(() => ({ client: null as unknown, tenant: null as Row | null, outcome: 'accepted',
  beforeAccept: null as (() => Promise<void>) | null, loseCreditAck: false, calls: [] as Row[], readFailure: '',
}))
let pg: PGlite
vi.mock('@supabase/supabase-js', () => ({ createClient: () => new Proxy({}, { get: (_, key) => (h.client as Row)[key as string] }) }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => ({ tenant: h.tenant, identity: { userId: 'owner_A' } }) }))
vi.mock('@/lib/quote/job-quote-operation', () => ({ readQuoteDraftReadiness: async () => ({ ready: true }) }))
vi.mock('@/lib/quote/pdf', () => ({ ensureQuotePdf: async () => null, signQuotePdfUrl: vi.fn(), downloadQuotePdf: vi.fn() }))
vi.mock('@/lib/quote/lifecycle', () => ({ advanceQuoteStatus: vi.fn() }))
vi.mock('@/lib/sms/quote-origin-conversation', () => ({ resolveQuoteOriginConversation: async () => null }))
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn() }))
vi.mock('@/lib/sms/send-quote-pdf', () => ({ dispatchQuoteWithPdf: async (input: Row) => {
  if (h.outcome === 'queued') return { ok: false, smsAttempt: { code: 'OUTBOX_UNAVAILABLE', reason: 'Queued' } }
  return sendAccepted(input)
} }))
import { POST } from '@/app/api/quote/[id]/send/route'
import { quoteCustomerReleaseRevision } from './customer-release'
import { readQuoteCreditSettlement, settleFinalQuoteCredit } from './credit-settlement'
import { dispatchDurably, recordDeliveryReceipt, type OutboundOptions } from '@/lib/sms/durable-outbox'
import { finalDepositBaseCents } from './money'

async function sendAccepted(input: Row) {
  return dispatchDurably(input as OutboundOptions, async () => {
    h.calls.push(input)
    if (h.beforeAccept) { const run = h.beforeAccept; h.beforeAccept = null; await run() }
    if (h.outcome === 'unknown') return { ok: false, smsAttempts: 1, smsAttempt: { code: 'AMBIGUOUS', reason: 'Response lost' } }
    return { ok: true, channel: 'sms', sid: 'SM-credit-' + h.calls.length, status: 'queued' }
  })
}
beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key);
    create table sms_conversations(id uuid primary key,from_number text,to_number text,status text,conversation_type text,tenant_id uuid,intake_id uuid,created_at timestamptz default now());
    create table sms_messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,direction text,body text,twilio_message_sid text,audience text,to_number text,tenant_id uuid);
    create table intakes(id uuid primary key,tenant_id uuid,trade text,job_type text,caller jsonb,suburb text,scope jsonb,call_id uuid,customer_id uuid);
    create table pricing_book(id uuid primary key,tenant_id uuid,trade text,gst_registered boolean,hourly_rate numeric,quote_display text,quote_tier_mode text);
    create table quotes(id uuid primary key default gen_random_uuid(),tenant_id uuid,intake_id uuid,status text,paid_at timestamptz,paid_tier text,sent_at timestamptz,price_hold_until timestamptz,
      share_token text unique,good jsonb,better jsonb,best jsonb,total_inc_gst numeric,selected_tier text,scope_of_works text,assumptions jsonb,estimated_timeframe text,
      needs_inspection boolean,inspection_reason text,deposit_pct numeric,display_mode text,applied_discount_pct numeric,quote_kind text,parent_quote_id uuid,stripe_links jsonb,
      paid_amount_cents bigint,paid_stripe_session_id text,stripe_connect_destination text,report_doc jsonb,report_style jsonb);
    create table quote_followup_events(id uuid primary key default gen_random_uuid(),tenant_id uuid,quote_id uuid,kind text,outcome text,note text);
    create table plan_upload_requests(id uuid primary key default gen_random_uuid(),token text unique,tenant_id uuid,sms_conversation_id uuid,customer_phone text,twilio_number text,status text,created_at timestamptz default now(),updated_at timestamptz default now(),expires_at timestamptz);`)
  for (const file of ['198_sms_durable_work.sql', '199_sms_delivery_outbox.sql', '205_generic_quote_customer_release.sql',
    '207_quote_pricing_versions.sql', '215_generic_release_snapshot.sql', '217_final_quote_credit_settlement.sql']) {
    await pg.exec(readFileSync('sql/migrations/' + file, 'utf8'))
  }
  await pg.query('insert into tenants values($1),($2)', [A, B])
  h.client = {
    rpc: async (name: string, args: Row) => {
      try {
        const pairs = Object.entries(args)
        const result = await pg.query<{ value: Row }>('select ' + name + '(' + pairs.map(([key], n) => key + '=>$' + (n + 1)).join(',') + ') value', pairs.map(([, value]) => value))
        if (name === 'settle_final_quote_credit' && h.loseCreditAck) return { data: null, error: { message: 'Ack lost' } }
        return { data: result.rows[0].value, error: null }
      } catch (error) { return { data: null, error } }
    },
    from: (table: string) => {
      const filters: string[] = [], args: unknown[] = [], order: string[] = []
      let fields = '*', limit: number | null = null, insert: Row | null = null
      const result = async () => {
        if (h.readFailure === table) return { data: null, error: { message: 'Read unavailable' } }
        try {
          if (insert) {
            const pairs = Object.entries(insert)
            const saved = await pg.query('insert into ' + table + '(' + pairs.map(([key]) => key).join(',') + ') values(' + pairs.map((_, n) => '$' + (n + 1)).join(',') + ') returning *', pairs.map(([, value]) => value))
            return { data: saved.rows, error: null }
          }
          const rows = await pg.query<{ row: Row }>('select to_jsonb(t) row from (select ' + fields + ' from ' + table +
            (filters.length ? ' where ' + filters.join(' and ') : '') + (order.length ? ' order by ' + order.join(',') : '') + (limit ? ' limit ' + limit : '') + ') t', args)
          return { data: rows.rows.map(value => value.row), error: null }
        } catch (error) { return { data: null, error } }
      }
      const query = {
        select: (value: string) => { fields = value; return query },
        eq: (key: string, value: unknown) => { args.push(value); filters.push(key + '=$' + args.length); return query },
        order: (key: string, opts: { ascending: boolean }) => { order.push(key + (opts.ascending ? ' asc' : ' desc')); return query },
        limit: (value: number) => { limit = value; return query },
        insert: (value: Row) => { insert = value; return query },
        maybeSingle: async () => { const value = await result(); return { ...value, data: value.data?.[0] ?? null } },
        then: (resolve: (value: unknown) => unknown) => result().then(resolve),
      }; return query
    },
  }
}, 30_000)
afterAll(async () => { await pg?.close() })
afterEach(() => vi.unstubAllEnvs())
beforeEach(async () => {
  h.tenant = { id: A, business_name: 'Owned trade', twilio_sms_number: '+61488888888' }
  h.outcome = 'accepted'; h.beforeAccept = null; h.calls = []; h.loseCreditAck = false; h.readFailure = ''
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://web.example.test')
  vi.stubEnv('SMS_QUOTE_PDF_MMS', '0')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://database.example.test')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only-no-network')
  await pg.exec('truncate quote_credit_settlements,sms_outbox,sms_messages,sms_conversations,quotes,intakes,pricing_book,quote_pricing_versions,quote_followup_events cascade')
  await pg.query(`insert into intakes(id,tenant_id,trade,job_type,caller) values($1,$2,'electrical','power_points','{"name":"Customer","phone":"+61411111111","email":"customer@example.test"}')`, [I, A])
  await pg.query("insert into quotes(id,tenant_id,intake_id,quote_kind,paid_at,paid_tier,status,share_token) values($1,$2,$3,'initial',now(),'inspection','paid','root')", [R, A, I])
  await pg.query("insert into pricing_book values($1,$2,'electrical',false,125,'summary','single')", [BOOK, A])
  const book = (await pg.query<{ row: Row }>('select to_jsonb(b) row from pricing_book b')).rows[0].row
  const version = (await pg.query<{ row: Row }>('select capture_quote_pricing_version($1,$2,$3,$4) row', [A, 'electrical', BOOK, book])).rows[0].row
  await pg.query(`insert into quotes(id,tenant_id,intake_id,quote_kind,parent_quote_id,status,share_token,total_inc_gst,deposit_pct,selected_tier,good,pricing_book_version_id,needs_inspection,assumptions,stripe_links)
    values($1,$2,$3,'final',$4,'draft','final',200,30,'good','{"label":"Confirmed work","subtotal_ex_gst":200,"line_items":[]}', $5,false,'[]','{}')`, [F, A, I, R, version.id])
})
const db = () => h.client as SupabaseClient
async function saved() { return (await pg.query<{ row: Row }>('select to_jsonb(q) row from quotes q where id=$1', [F])).rows[0].row }
async function outbox() { return (await pg.query<{ row: Row }>('select to_jsonb(o) row from sms_outbox o')).rows[0].row }
async function post() {
  return POST(new Request('https://web.example.test/api/quote/' + F + '/send', { method: 'POST', body: JSON.stringify({ channel: 'sms', expected_recipient: '+61411111111', expected_revision: quoteCustomerReleaseRevision(await saved()) }) }), { params: Promise.resolve({ id: F }) })
}
async function receipt() { return readQuoteCreditSettlement(db(), F, A) }
async function reconcile() { return settleFinalQuoteCredit(db(), { quoteId: F, tenantId: A, outboxId: String((await outbox()).id) }) }

describe('final credit real send/release/outbox/settlement boundaries', () => {
  it('settles only an accepted exact owned final and persists a truthful receipt', async () => {
    const response = await post(); const body = await response.json()
    expect(response.status).toBe(200); expect(body).toMatchObject({ accepted: true, deposit_covered_by_credit: true, credit_settlement: { status: 'settled' } })
    expect(await saved()).toMatchObject({ paid_tier: 'credit', paid_amount_cents: 0, paid_stripe_session_id: null, stripe_connect_destination: null, sent_at: expect.any(String) })
    expect(await outbox()).toMatchObject({ status: 'accepted', provider_sid: expect.any(String) })
    expect(await receipt()).toMatchObject({ status: 'settled', quote_id: F })
  })
  it('rejects a changed final amount after the provider request began while preserving accepted evidence', async () => {
    h.beforeAccept = async () => { await pg.query("update quotes set total_inc_gst=1000,good='{\"label\":\"New work\",\"subtotal_ex_gst\":1000,\"line_items\":[]}' where id=$1", [F]) }
    const response = await post(); const body = await response.json()
    expect(response.status).toBe(200); expect(body).toMatchObject({ accepted: true, credit_settlement: { status: 'review_required', reason: 'accepted_quote_changed' } })
    expect(body.deposit_covered_by_credit).toBeUndefined(); expect((await saved()).paid_at).toBeNull(); expect((await outbox()).status).toBe('accepted')
  })
  it('settles after durable worker recovery even though the original request returned queued', async () => {
    h.outcome = 'queued'; expect((await post()).status).toBe(202); expect((await saved()).paid_at).toBeNull()
    h.outcome = 'accepted'; await sendAccepted((await outbox()).payload as Row)
    expect(await saved()).toMatchObject({ paid_tier: 'credit', sent_at: expect.any(String) }); expect(await receipt()).toMatchObject({ status: 'settled' })
    expect(h.calls).toHaveLength(1)
  })
  it('never replays an unknown provider outcome or turns it into a credit payment', async () => {
    h.outcome = 'unknown'; expect((await post()).status).toBe(202)
    expect(await reconcile()).toMatchObject({ status: 'pending', reason: 'provider_acceptance_unconfirmed' })
    expect((await saved()).paid_at).toBeNull(); expect((await outbox()).status).toBe('unknown'); expect(h.calls).toHaveLength(1)
  })
  it('a paid inspection root must still belong to this final and tenant at acceptance', async () => {
    h.beforeAccept = async () => { await pg.query('update quotes set tenant_id=$1 where id=$2', [B, R]) }
    expect((await post()).status).toBe(200); expect((await saved()).paid_at).toBeNull()
    expect(await receipt()).toMatchObject({ status: 'review_required', reason: 'owned_inspection_credit_unconfirmed' })
  })
  it('rejects a different paid root even when its tenant and intake match', async () => {
    const otherRoot = '11111111-1111-4111-8111-111111111111'
    h.beforeAccept = async () => {
      await pg.query("insert into quotes(id,tenant_id,intake_id,quote_kind,paid_at,paid_tier) values($1,$2,$3,'initial',now(),'inspection')", [otherRoot, A, I])
      await pg.query('update quotes set parent_quote_id=$1 where id=$2', [otherRoot, F])
    }
    expect((await post()).status).toBe(200); expect((await saved()).paid_at).toBeNull()
    expect(await receipt()).toMatchObject({ status: 'review_required', reason: 'accepted_quote_changed' })
  })
  it('does not replace a real payment landing during dispatch', async () => {
    h.beforeAccept = async () => { await pg.query("update quotes set paid_at=now(),paid_tier='deposit',paid_amount_cents=100,paid_stripe_session_id='cs_real' where id=$1", [F]) }
    expect((await post()).status).toBe(200)
    expect(await saved()).toMatchObject({ paid_tier: 'deposit', paid_amount_cents: 100, paid_stripe_session_id: 'cs_real' })
    expect(await receipt()).toMatchObject({ status: 'not_required', reason: 'quote_already_paid' })
  })
  it('an unknown settlement response cannot claim success and readback recovers its persisted receipt', async () => {
    h.loseCreditAck = true; const body = await (await post()).json()
    expect(body.deposit_covered_by_credit).toBeUndefined(); expect(body.credit_settlement.status).toBe('pending')
    expect(await receipt()).toMatchObject({ status: 'settled' }); expect((await saved()).paid_tier).toBe('credit')
  })
  it('keeps provider acceptance committed during an accounting failure and settles on a later receipt', async () => {
    await pg.exec('alter table quote_credit_settlements add constraint simulated_outage check(false)')
    try {
      const body = await (await post()).json()
      expect(body).toMatchObject({ accepted: true, credit_settlement: { status: 'pending' } })
      expect((await outbox()).status).toBe('accepted'); expect((await saved()).paid_at).toBeNull()
    } finally { await pg.exec('alter table quote_credit_settlements drop constraint simulated_outage') }
    const savedMessage = await outbox()
    await recordDeliveryReceipt({ outboxId: String(savedMessage.id), attempt: String(savedMessage.attempt_token), sid: String(savedMessage.provider_sid), status: 'delivered' }, db())
    expect((await outbox()).status).toBe('delivered'); expect((await saved()).paid_tier).toBe('credit')
    expect(await receipt()).toMatchObject({ status: 'settled' }); expect(h.calls).toHaveLength(1)
  })
  it('legacy accepted payloads without a snapshot remain reviewable and never guess today\'s credit', async () => {
    h.outcome = 'queued'; await post(); await pg.exec("update sms_outbox set payload=payload-'quoteReleaseSnapshot'")
    h.outcome = 'accepted'; await sendAccepted((await outbox()).payload as Row)
    expect((await saved()).paid_at).toBeNull(); expect((await outbox()).status).toBe('accepted')
    expect(await receipt()).toMatchObject({ status: 'review_required', reason: 'legacy_delivery_snapshot_missing' })
  })
  it.each([{ total: 200, pct: 24.5 }, { total: 331.63, pct: 30 }, { total: 331.67, pct: 30 }, { total: 1000, pct: 30 }])('uses canonical final deposit arithmetic %j', async ({ total, pct }) => {
    await pg.query('update quotes set total_inc_gst=$1,deposit_pct=$2,good=$3 where id=$4', [total, pct, { label: 'Work', subtotal_ex_gst: total, line_items: [] }, F])
    expect((await post()).status).toBe(200)
    expect(!!(await saved()).paid_at).toBe(finalDepositBaseCents(Math.round(total * 100), pct) < 50)
  })
  it('readback remains scoped and does not mutate money', async () => {
    await post(); const before = await saved()
    expect(await readQuoteCreditSettlement(db(), F, B)).toBeNull(); expect(await receipt()).toMatchObject({ quote_id: F })
    expect(await saved()).toEqual(before)
    h.readFailure = 'quote_credit_settlements'; await expect(receipt()).rejects.toThrow('read unavailable')
  })
  it('restricts accounting RPC and receipt access to service_role', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const value = await pg.query<{ rpc: boolean; read: boolean }>("select has_function_privilege($1,'settle_final_quote_credit(uuid,uuid)','execute') rpc,has_table_privilege($1,'quote_credit_settlements','select') read", [role])
      expect(value.rows[0]).toEqual({ rpc: role === 'service_role', read: role === 'service_role' })
    }
  })
  it('runs credit proof before the existing final lifecycle trigger to preserve root-first locking', async () => {
    const triggers = await pg.query<{ tgname: string }>("select tgname from pg_trigger where tgrelid='sms_outbox'::regclass and not tgisinternal order by tgname")
    const names = triggers.rows.map(row => row.tgname)
    expect(names.indexOf('a_final_quote_credit')).toBeLessThan(names.indexOf('generic_quote_delivery'))
  })
})
