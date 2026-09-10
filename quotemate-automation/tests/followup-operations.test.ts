import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ db: null as unknown as SupabaseClient, tenant: null as Record<string, unknown> | null,
  failRead: '', failReadMatch: '', readShapes: [] as string[], failRpc: '', loseRpc: '', rpcCalls: [] as string[], sms: vi.fn(), call: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => state.db }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => state.tenant ? { tenant: state.tenant } : null }))
vi.mock('@/lib/sms/twilio', () => ({ sendSms: (...args: unknown[]) => state.sms(...args), sendWhatsApp: vi.fn(() => { throw new Error('Unexpected WhatsApp') }), readTwilioMessage: vi.fn() }))
vi.mock('@/lib/twilio/voice', () => ({ placeBridgeCall: (...args: unknown[]) => state.call(...args), signBridge: () => 'signed-fixture' }))
import { postFollowupOperation, getFollowupOperation } from '@/lib/quote/followup-operations'
import { resolveFollowupTarget, resolveLeadTarget } from '@/lib/quote/followup-contact'
import type { FollowupAction } from '@/lib/quote/followup-operation-contract'

let pg: PGlite
const tenant = randomUUID(), otherTenant = randomUUID(), quote = randomUUID(), intake = randomUUID(), customer = randomUUID(), lead = randomUUID()
const migration = readFileSync('sql/migrations/220_followup_operations.sql', 'utf8')
const phone = '+61411111111', from = '+61422222222'
const sqlName = (name: string) => { if (!/^[a-z_]+$/.test(name)) throw new Error(`Unexpected SQL identifier ${name}`); return name }
beforeAll(async () => {
  process.env.APP_URL = 'https://quotemax.com.au'; process.env.PUBLIC_WEB_ORIGIN = 'https://quotemax.com.au'
  process.env.TWILIO_AUTH_TOKEN = 'offline-fixture'; process.env.TWILIO_ACCOUNT_SID = 'offline-fixture'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-fixture'
  pg = new PGlite()
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key);
    create table customers(id uuid primary key,tenant_id uuid,phone_number text,full_name text,first_name text);
    create table intakes(id uuid primary key,tenant_id uuid,caller jsonb,customer_id uuid,job_type text);
    create table quotes(id uuid primary key,tenant_id uuid,intake_id uuid,share_token text,selected_tier text,total_inc_gst numeric,followed_up_at timestamptz,followup_note text);
    create table sms_conversations(id uuid primary key default gen_random_uuid(),tenant_id uuid,from_number text,to_number text,status text,conversation_type text,
      conversation_state jsonb,intake_id uuid,last_message_at timestamptz,updated_at timestamptz,followup_quote jsonb,roofing_state jsonb,painting_state jsonb);
    create table sms_messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,direction text,body text,twilio_message_sid text,audience text default 'customer',to_number text,tenant_id uuid,created_at timestamptz default now());
    create unique index sms_messages_unique_inbound_sid_idx on sms_messages(twilio_message_sid) where direction='inbound' and twilio_message_sid is not null;
    create table plan_upload_requests(id uuid primary key default gen_random_uuid(),token text not null unique,tenant_id uuid,sms_conversation_id uuid,customer_phone text,twilio_number text,status text,created_at timestamptz default now(),updated_at timestamptz default now(),expires_at timestamptz default now()+interval '7 days');`)
  for (const path of ['198_sms_durable_work.sql', '199_sms_delivery_outbox.sql', '039_quote_followup_events.sql', '220_followup_operations.sql'])
    await pg.exec(readFileSync(`sql/migrations/${path}`, 'utf8'))
  state.db = {
    from(table: string) {
      sqlName(table)
      const filters: [string, unknown, 'eq' | 'in'][] = []; const orders: string[] = []; let cols = '*'; let limit: number | null = null
      const run = async (single = false) => {
        const shape = `${table}/${cols}/${filters.map(([key]) => key).join(',')}`; state.readShapes.push(shape)
        if (state.failRead === table || (state.failReadMatch && shape.includes(state.failReadMatch))) return { data: null, error: { message: 'Injected read failure' } }
        try {
          const result = await pg.query(`select ${cols} from ${table}${filters.length ? ' where ' + filters.map(([key, , mode], index) => `${key}=${mode === 'in' ? `any($${index + 1})` : `$${index + 1}`}`).join(' and ') : ''}${orders.length ? ' order by ' + orders.join(',') : ''}${limit ? ' limit ' + limit : ''}`, filters.map(([, value]) => value))
          return { data: single ? result.rows[0] ?? null : result.rows, error: null }
        } catch (error) { return { data: null, error } }
      }
      const query = { select(value = '*') { cols = value === '*' ? '*' : value.split(',').map(key => sqlName(key.trim())).join(','); return query },
        eq(key: string, value: unknown) { filters.push([key === 'followup_quote->>quote_id' ? "followup_quote->>'quote_id'" : sqlName(key), value, 'eq']); return query },
        in(key: string, value: unknown[]) { filters.push([sqlName(key), value, 'in']); return query },
        order(key: string, options: { ascending: boolean }) { orders.push(`${sqlName(key)} ${options.ascending ? 'asc' : 'desc'}`); return query },
        limit(value: number) { limit = value; return query }, maybeSingle: () => run(true), single: () => run(true),
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => run().then(resolve, reject) }
      return query
    },
    async rpc(name: string, args: Record<string, unknown>) {
      state.rpcCalls.push(name)
      if (state.failRpc === name) return { data: null, error: { code: 'INJECTED' } }
      try {
        const entries = Object.entries(args)
        const result = await pg.query<{ value: unknown }>(`select ${sqlName(name)}(${entries.map(([key], index) => `${sqlName(key)}=>$${index + 1}`).join(',')}) as value`,
          entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value))
        if (state.loseRpc === name) { state.loseRpc = ''; return { data: null, error: { code: 'ACK_LOST' } } }
        return { data: result.rows[0]?.value, error: null }
      } catch (error) { return { data: null, error } }
    },
  } as unknown as SupabaseClient
}, 60_000)
beforeEach(async () => {
  await pg.exec('truncate tenants,quotes,intakes,customers,sms_conversations,sms_messages,sms_outbox,followup_operations,quote_followup_events cascade')
  await pg.query('insert into tenants values($1),($2)', [tenant, otherTenant])
  await pg.query('insert into customers values($1,$2,$3,$4,$5)', [customer, tenant, phone, 'Customer Fixture', 'Customer'])
  await pg.query('insert into intakes values($1,$2,$3,$4,$5)', [intake, tenant, JSON.stringify({ phone, name: 'Customer Fixture' }), customer, 'blocked_drain'])
  await pg.query('insert into quotes(id,tenant_id,intake_id,share_token,total_inc_gst) values($1,$2,$3,$4,110)', [quote, tenant, intake, 'fixture-token'])
  await pg.query("insert into sms_conversations(id,tenant_id,from_number,to_number,conversation_type,conversation_state) values($1,$2,$3,$4,'customer_quote','{}')", [lead, tenant, phone, from])
  state.tenant = { id: tenant, owner_user_id: null, twilio_sms_number: from, twilio_voice_number: from, owner_mobile: '+61433333333' }
  state.failRead = ''; state.failReadMatch = ''; state.readShapes = []; state.failRpc = ''; state.loseRpc = ''; state.rpcCalls = []
  delete process.env.FOLLOWUP_MUTATIONS_DISABLED
  state.sms.mockReset().mockResolvedValue({ ok: true, sid: 'SM' + '1'.repeat(32), status: 'queued' })
  state.call.mockReset().mockResolvedValue({ ok: true, sid: 'CA' + '2'.repeat(32), status: 'queued' })
})
afterAll(async () => { await pg?.close() })
const body = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), quoteId: quote, text: 'Hello, following up.', expectedRecipient: phone, ...extra })
async function post(action: FollowupAction, input: unknown) {
  const response = await postFollowupOperation(state.db, new Request('https://fixture.test/api', { method: 'POST', body: JSON.stringify(input) }), action)
  return { status: response.status, data: await response.json() }
}
async function get(action: FollowupAction, input: { requestId: string; quoteId?: string; conversationId?: string }) {
  const response = await getFollowupOperation(state.db, new Request(`https://fixture.test/api?${new URLSearchParams(input as Record<string,string>)}`), action)
  return { status: response.status, data: await response.json() }
}
async function count(table: string) { return (await pg.query<{ count: number }>(`select count(*)::int count from ${sqlName(table)}`)).rows[0].count }

describe('owned follow-up operations over real SQL198/199/039/220', () => {
  it('is idempotent to install and unavailable to public roles', async () => {
    await pg.exec(migration)
    const result = await pg.query<{ allowed: boolean }>("select has_function_privilege('authenticated','followup_note_commit(uuid,uuid,uuid,text,jsonb)','execute') allowed")
    expect(result.rows[0].allowed).toBe(false)
  })
  it('rejects unauthenticated, both targets, client tenant and oversized copy before any claim/send', async () => {
    state.tenant = null; expect((await post('text', body())).status).toBe(401)
    state.tenant = { id: tenant }
    for (const input of [body({ conversationId: lead }), body({ tenantId: tenant }), body({ text: 'x'.repeat(641) }), body({ requestId: 'invalid' })])
      expect((await post('text', input)).status).toBe(400)
    expect(await count('followup_operations')).toBe(0); expect(state.sms).not.toHaveBeenCalled()
  })
  it('rejects foreign targets and failed nested contact reads without fallback or dispatch', async () => {
    await pg.query('update intakes set tenant_id=$1 where id=$2', [otherTenant, intake])
    expect((await post('text', body())).status).toBe(503)
    await pg.query('update quotes set tenant_id=$1 where id=$2', [otherTenant, quote])
    expect((await post('text', body())).status).toBe(404)
    expect(await count('followup_operations')).toBe(0); expect(state.sms).not.toHaveBeenCalled()
  })
  it('checks fresh reviewed recipient and retains original text without truncation', async () => {
    expect((await post('text', body({ expectedRecipient: '+61499999999' }))).status).toBe(409)
    const result = await post('text', body({ text: 'x'.repeat(640) }))
    expect(result.data).toMatchObject({ status: 'complete', accepted: true, history: 'complete' })
    expect(state.sms.mock.calls[0][0].text).toHaveLength(640)
  })
  it('persists one send, pin, transcript and event across repeated POST and GET', async () => {
    const input = body(); const first = await post('text', input)
    expect(first.data).toMatchObject({ status: 'complete', accepted: true, history: 'complete' })
    expect(first.data.outboxId).toBeTruthy(); expect(first.data.eventId).toBeTruthy()
    expect((await post('text', input)).data).toEqual(first.data)
    state.rpcCalls = []
    expect((await get('text', { requestId: input.requestId, quoteId: quote })).data).toEqual(first.data)
    expect(state.rpcCalls).toEqual([]); expect(state.sms).toHaveBeenCalledTimes(1)
    expect(await count('sms_messages')).toBe(1); expect(await count('quote_followup_events')).toBe(1)
    const pin = (await pg.query<{ followup_quote: Record<string,unknown> }>('select followup_quote from sms_conversations where id=$1', [lead])).rows[0].followup_quote
    expect(pin.quote_id).toBe(quote); expect(pin.job_label).toBe('Blocked Drain')
  })
  it('rejects changed body or changed target on the same request identity', async () => {
    const input = body(); await post('text', input)
    expect((await post('text', { ...input, text: 'Changed copy' })).status).toBe(409)
    expect((await post('text', { requestId: input.requestId, conversationId: lead, text: input.text, expectedRecipient: phone })).status).toBe(409)
    expect(state.sms).toHaveBeenCalledTimes(1)
  })
  it('keeps a lead conversation-only with no quote pin or quote event', async () => {
    const result = await post('text', { requestId: randomUUID(), conversationId: lead, text: 'Following up on your enquiry.', expectedRecipient: phone })
    expect(result.data).toMatchObject({ accepted: true, history: 'complete', eventId: null, target: { kind: 'conversation', id: lead } })
    expect(await count('quote_followup_events')).toBe(0)
    expect((await pg.query<{ followup_quote: unknown }>('select followup_quote from sms_conversations where id=$1', [lead])).rows[0].followup_quote).toBeNull()
  })
  it('fences unknown SMS, including explicit same-ID retry, and never creates accepted history', async () => {
    state.sms.mockResolvedValue({ ok: false, code: 'AMBIGUOUS', reason: 'Response lost', raw: null })
    const input = body(); const first = await post('text', input)
    expect(first.data).toMatchObject({ status: 'unknown', accepted: false })
    await post('text', input); await get('text', { requestId: input.requestId, quoteId: quote })
    expect(state.sms).toHaveBeenCalledTimes(1); expect(await count('sms_messages')).toBe(0); expect(await count('quote_followup_events')).toBe(0)
  })
  it('recovers acceptance after the actual outbox finish committed but its response was lost', async () => {
    state.loseRpc = 'sms_outbox_finish'
    const input = body(); const result = await post('text', input)
    expect(result.data).toMatchObject({ accepted: true, status: 'complete' })
    await post('text', input); expect(state.sms).toHaveBeenCalledTimes(1)
  })
  it('retains accepted evidence when history fails and repairs history without another send', async () => {
    await pg.exec("create function reject_followup_event() returns trigger language plpgsql as $$ begin raise exception 'History unavailable'; end $$; create trigger fixture_reject before insert on quote_followup_events for each row execute function reject_followup_event()")
    const input = body(); const first = await post('text', input)
    expect(first.data).toMatchObject({ status: 'accepted', accepted: true, history: 'pending', eventId: null })
    expect(await count('sms_messages')).toBe(0)
    await pg.exec('drop trigger fixture_reject on quote_followup_events; drop function reject_followup_event()')
    state.rpcCalls = []; expect((await get('text', { requestId: input.requestId, quoteId: quote })).data.history).toBe('pending'); expect(state.rpcCalls).toEqual([])
    expect((await post('text', input)).data.history).toBe('complete')
    expect(state.sms).toHaveBeenCalledTimes(1); expect(await count('sms_messages')).toBe(1); expect(await count('quote_followup_events')).toBe(1)
  })
  it('claims a bridge before provider I/O and keeps timeout or empty SID unknown across retry/reopen', async () => {
    state.call.mockImplementation(async () => { expect(await count('followup_operations')).toBe(1); throw new Error('Lost provider response') })
    const input = { requestId: randomUUID(), quoteId: quote, expectedRecipient: phone }
    expect((await post('call', input)).data).toMatchObject({ status: 'unknown', accepted: false })
    await post('call', input); expect((await get('call', { requestId: input.requestId, quoteId: quote })).data.status).toBe('unknown'); expect(state.call).toHaveBeenCalledTimes(1)
    expect(await count('quote_followup_events')).toBe(0)
    state.call.mockResolvedValue({ ok: true, sid: '', status: 'queued' })
    expect((await post('call', { ...input, requestId: randomUUID() })).data.status).toBe('unknown')
  })
  it('records one accepted bridge and one event after repeated same-ID actions', async () => {
    const input = { requestId: randomUUID(), quoteId: quote, expectedRecipient: phone }
    expect((await post('call', input)).data).toMatchObject({ status: 'complete', accepted: true })
    await post('call', input); expect(state.call).toHaveBeenCalledTimes(1); expect(await count('quote_followup_events')).toBe(1)
  })
  it('commits one manual touch atomically and preserves chase state for Log another', async () => {
    const input = { requestId: randomUUID(), quoteId: quote, kind: 'note', outcome: 'spoke', note: 'Original note' }
    expect((await post('note', input)).data).toMatchObject({ status: 'complete', accepted: false, history: 'complete' })
    await post('note', input)
    const before = (await pg.query('select followed_up_at,followup_note from quotes where id=$1', [quote])).rows[0]
    expect((await post('note', { ...input, requestId: randomUUID(), note: 'Another note', preserveChase: true })).data.status).toBe('complete')
    expect((await pg.query('select followed_up_at,followup_note from quotes where id=$1', [quote])).rows[0]).toEqual(before)
    expect(await count('quote_followup_events')).toBe(2)
  })
  it('rolls back the event and operation when the atomic quote update fails', async () => {
    await pg.exec("create function reject_followup_quote() returns trigger language plpgsql as $$ begin raise exception 'Quote unavailable'; end $$; create trigger fixture_reject before update on quotes for each row execute function reject_followup_quote()")
    const input = { requestId: randomUUID(), quoteId: quote, kind: 'note', outcome: 'other', note: 'Keep this draft' }
    expect((await post('note', input)).status).toBe(503)
    expect(await count('quote_followup_events')).toBe(0); expect(await count('followup_operations')).toBe(0)
    await pg.exec('drop trigger fixture_reject on quotes; drop function reject_followup_quote()')
    expect((await post('note', input)).data.status).toBe('complete')
  })
  it('rejects long notes and every unsupported manual outcome', async () => {
    for (const extra of [{ note: 'x'.repeat(501) }, { outcome: 'text_sent' }, { preserveChase: 'true' }])
      expect((await post('note', { requestId: randomUUID(), quoteId: quote, kind: 'note', outcome: 'other', ...extra })).status).toBe(400)
    expect(await count('followup_operations')).toBe(0)
  })
  it('does not infer safety from GET not_found and rejects target/action query confusion', async () => {
    const requestId = randomUUID()
    expect((await get('text', { requestId, quoteId: quote })).data.status).toBe('not_found')
    expect((await get('text', { requestId, quoteId: quote, conversationId: lead })).status).toBe(400)
    expect(state.rpcCalls).toEqual([]); expect(state.sms).not.toHaveBeenCalled(); expect(state.call).not.toHaveBeenCalled()
  })
  it('fails closed on malformed contact and unavailable customer or lead reads', async () => {
    await pg.query('update intakes set caller=$1 where id=$2', [JSON.stringify({ phone: 123 }), intake])
    expect(await resolveFollowupTarget(state.db, quote, tenant)).toEqual({ ok: false, code: 'unavailable' })
    await pg.query("update intakes set caller='{}' where id=$1", [intake]); state.failRead = 'customers'
    expect(await resolveFollowupTarget(state.db, quote, tenant)).toEqual({ ok: false, code: 'unavailable' })
    state.failRead = 'sms_conversations'
    expect(await resolveLeadTarget(state.db, lead, tenant)).toEqual({ ok: false, code: 'unavailable' })
  })
  it('refuses to attach a forged outbox payload even when its delivery key and SID match', async () => {
    state.failRpc = 'sms_outbox_claim'
    const input = body(); await post('text', input)
    const box = (await pg.query<{ id: string }>('select id from sms_outbox')).rows[0]
    const sid = 'SM' + 'f'.repeat(32)
    for (const field of ['to', 'from', 'text', 'tenantId', 'audience']) {
      await pg.query("update sms_outbox set payload=jsonb_set(payload,array[$1],to_jsonb('forged'::text)),provider_sid=$2,status='accepted',result=$3 where id=$4", [field, sid, JSON.stringify({ ok: true, sid }), box.id])
      expect((await get('text', { requestId: input.requestId, quoteId: quote })).data.accepted).toBe(false)
      expect(await count('sms_messages')).toBe(0); expect(await count('quote_followup_events')).toBe(0)
      await pg.query("update sms_outbox set payload=jsonb_set(payload,array[$1],$2::jsonb) where id=$3", [field, JSON.stringify(({ to: phone, from, text: input.text, tenantId: tenant, audience: 'customer' } as Record<string,string>)[field]), box.id])
      // Restore evidence too, so the next independent mismatch starts unaccepted.
      await pg.exec("update followup_operations set provider_sid=null,accepted_at=null,status='pending',history='pending',event_id=null; truncate sms_messages,quote_followup_events")
    }
  })
  it('does not count an unverified nonempty provider SID as acceptance', async () => {
    state.failRpc = 'sms_outbox_claim'; const input = body(); await post('text', input)
    await pg.query("update sms_outbox set provider_sid=$1,status='unknown',result=$2", ['SM' + 'e'.repeat(32), JSON.stringify({ ok: false })])
    expect((await get('text', { requestId: input.requestId, quoteId: quote })).data.accepted).toBe(false)
    expect(await count('quote_followup_events')).toBe(0)
  })
  it('retains accepted history after a signed provider callback reports undelivered', async () => {
    const input = body(); const first = await post('text', input)
    const box = (await pg.query<{ id: string; attempt_token: string; provider_sid: string }>('select * from sms_outbox')).rows[0]
    const receipt = await state.db.rpc('sms_outbox_receipt', { p_id: box.id, p_attempt: box.attempt_token, p_sid: box.provider_sid, p_status: 'undelivered', p_error: '30003' })
    expect(receipt.error).toBeNull()
    expect((await get('text', { requestId: input.requestId, quoteId: quote })).data).toMatchObject({ accepted: true, status: 'complete', eventId: first.data.eventId })
    await post('text', input); expect(state.sms).toHaveBeenCalledTimes(1)
  })
  it('recovers a note or accepted bridge after its actual commit response is lost', async () => {
    const call = { requestId: randomUUID(), quoteId: quote, expectedRecipient: phone }
    state.loseRpc = 'followup_call_finish'; expect((await post('call', call)).status).toBe(503)
    expect((await get('call', { requestId: call.requestId, quoteId: quote })).data).toMatchObject({ accepted: true, status: 'complete' })
    await post('call', call); expect(state.call).toHaveBeenCalledTimes(1)
    const note = { requestId: randomUUID(), quoteId: quote, kind: 'note', outcome: 'no_answer' }
    state.loseRpc = 'followup_note_commit'; expect((await post('note', note)).status).toBe(503)
    expect((await get('note', { requestId: note.requestId, quoteId: quote })).data.status).toBe('complete')
    await post('note', note); expect(await count('quote_followup_events')).toBe(2)
  })
  it('a failed durable claim cannot call or send, and a lost call claim remains fenced', async () => {
    state.failRpc = 'followup_operation_claim'
    const input = { requestId: randomUUID(), quoteId: quote, expectedRecipient: phone }
    expect((await post('call', input)).status).toBe(503); expect(state.call).not.toHaveBeenCalled()
    state.failRpc = ''; state.loseRpc = 'followup_operation_claim'
    expect((await post('call', input)).status).toBe(503)
    expect((await post('call', input)).data.status).toBe('unknown'); expect(state.call).not.toHaveBeenCalled()
  })
  it('rejects retry when the authoritative recipient changed while a pending SMS was not sent', async () => {
    state.failRpc = 'sms_outbox_claim'; const input = body(); await post('text', input)
    await pg.query('update intakes set caller=$1 where id=$2', [JSON.stringify({ phone: '+61499999999' }), intake])
    state.failRpc = ''; expect((await post('text', input)).status).toBe(409); expect(state.sms).not.toHaveBeenCalled()
  })
  it('actual route exports use the same operation DTO and history GET remains read-only', async () => {
    const textRoute = await import('@/app/api/tenant/followups/text/route')
    const eventRoute = await import('@/app/api/tenant/followups/events/route')
    const callRoute = await import('@/app/api/tenant/followups/call/route')
    const input = body()
    expect((await textRoute.POST(new Request('https://fixture.test', { method: 'POST', body: JSON.stringify(input) }))).status).toBe(200)
    state.rpcCalls = []
    expect((await (await textRoute.GET(new Request(`https://fixture.test?requestId=${input.requestId}&quoteId=${quote}`))).json()).accepted).toBe(true)
    expect((await (await eventRoute.GET(new Request(`https://fixture.test?quoteId=${quote}`))).json()).events).toHaveLength(1)
    expect((await callRoute.GET(new Request(`https://fixture.test?requestId=${randomUUID()}&quoteId=${quote}`))).status).toBe(200)
    expect(state.rpcCalls).toEqual([])
  })
  it.each(["sms_conversations/id/tenant_id,followup_quote", 'quotes/intake_id/', 'sms_conversations/id/tenant_id,intake_id', 'sms_conversations/id/tenant_id,from_number', 'sms_messages/direction,body,created_at/'])('history GET fails closed at %s without widening to another source', async shape => {
    const route = await import('@/app/api/tenant/followups/messages/route')
    state.failReadMatch = shape
    const response = await route.GET(new Request(`https://fixture.test?quoteId=${quote}`))
    expect(response.status).toBe(503)
    expect(state.readShapes.at(-1)).toContain(shape)
    expect((await response.json()).error).toBe('history_unavailable')
  })
  it('history GET isolates a lead to its owned conversation and scopes the transcript by tenant', async () => {
    const another = randomUUID()
    await pg.query("insert into sms_conversations(id,tenant_id,from_number,conversation_type) values($1,$2,$3,'customer_quote')", [another, tenant, phone])
    await pg.query("insert into sms_messages(conversation_id,tenant_id,direction,body) values($1,$2,'inbound','Owned lead reply'),($1,$3,'inbound','Wrong tenant'),($4,$2,'inbound','Other conversation')", [lead, tenant, otherTenant, another])
    const route = await import('@/app/api/tenant/followups/messages/route')
    const response = await route.GET(new Request(`https://fixture.test?conversationId=${lead}`))
    expect(response.status).toBe(200)
    expect((await response.json()).messages).toEqual([expect.objectContaining({ body: 'Owned lead reply' })])
  })
  it('canonicalizes uppercase UUID POST, GET and retry into one accepted action', async () => {
    const route = await import('@/app/api/tenant/followups/text/route')
    const input = body({ quoteId: quote.toUpperCase(), requestId: randomUUID().toUpperCase() })
    const request = () => new Request('https://fixture.test', { method: 'POST', body: JSON.stringify(input) })
    const first = await (await route.POST(request())).json()
    expect(first).toMatchObject({ status: 'complete', requestId: input.requestId.toLowerCase(), target: { id: quote } })
    expect((await route.GET(new Request(`https://fixture.test?quoteId=${input.quoteId}&requestId=${input.requestId}`))).status).toBe(200)
    expect((await route.POST(request())).status).toBe(200); expect(state.sms).toHaveBeenCalledTimes(1)
  })
  it('rollback switch disables producers while preserving readback and durable evidence', async () => {
    const input = body(); await post('text', input); process.env.FOLLOWUP_MUTATIONS_DISABLED = 'true'
    expect((await post('text', input)).status).toBe(503)
    expect((await get('text', { requestId: input.requestId, quoteId: quote })).data.status).toBe('complete')
    expect(await count('followup_operations')).toBe(1); expect(state.sms).toHaveBeenCalledTimes(1)
  })
  it.each(['later-pin', 'equal-time-pin', 'newer-inbound'] as const)('late accepted-history repair preserves %s context and original message/event time', async scenario => {
    await pg.exec("create function reject_old_followup() returns trigger language plpgsql as $$ begin if new.summary like '%Older message%' then raise exception 'History unavailable'; end if; return new; end $$; create trigger fixture_old before insert on quote_followup_events for each row execute function reject_old_followup()")
    const older = body({ text: 'Older message' }); expect((await post('text', older)).data.history).toBe('pending')
    const acceptedAt = (await pg.query<{ accepted_at: string }>('select accepted_at from followup_operations where request_id=$1', [older.requestId])).rows[0].accepted_at
    const nextQuote = randomUUID()
    await pg.query('insert into quotes(id,tenant_id,intake_id,share_token,total_inc_gst) values($1,$2,$3,$4,220)', [nextQuote, tenant, intake, 'new-quote'])
    state.sms.mockResolvedValue({ ok: true, sid: 'SM' + '3'.repeat(32), status: 'queued' })
    expect((await post('text', body({ quoteId: nextQuote, text: 'Newer message' }))).data.history).toBe('complete')
    if (scenario === 'equal-time-pin') await pg.query("update sms_conversations set followup_quote=jsonb_set(followup_quote,'{sent_at}',to_jsonb($1::timestamptz)) where id=$2", [acceptedAt, lead])
    if (scenario === 'newer-inbound') await pg.query('update sms_conversations set followup_quote=null where id=$1', [lead])
    await pg.query("update sms_conversations set roofing_state='{}',painting_state='{}',status='closed',last_message_at=now()+interval '1 minute' where id=$1", [lead])
    if (scenario === 'equal-time-pin') await pg.query('update sms_conversations set last_message_at=$1 where id=$2', [acceptedAt, lead])
    await pg.exec('drop trigger fixture_old on quote_followup_events; drop function reject_old_followup()')
    expect((await post('text', older)).data.history).toBe('complete')
    const conversation = (await pg.query<{ followup_quote: { quote_id: string } | null; roofing_state: unknown; painting_state: unknown; status: string }>('select followup_quote,roofing_state,painting_state,status from sms_conversations where id=$1', [lead])).rows[0]
    expect(conversation).toMatchObject({ followup_quote: scenario === 'newer-inbound' ? null : { quote_id: nextQuote }, roofing_state: {}, painting_state: {}, status: 'closed' })
    expect((await pg.query<{ created_at: string }>("select created_at from quote_followup_events where summary like '%Older message%' ")).rows[0].created_at).toEqual(acceptedAt)
    expect((await pg.query<{ created_at: string }>("select created_at from sms_messages where body='Older message'")).rows[0].created_at).toEqual(acceptedAt)
    expect((await pg.query<{ body: string }>('select body from sms_messages order by created_at,id')).rows.map(row => row.body)).toEqual(['Older message', 'Newer message'])
    expect(state.sms).toHaveBeenCalledTimes(2)
  })
})
