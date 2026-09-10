import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Actual installed migration functions over PGlite; not a production RLS or
// multiconnection race claim. Every negative starts from a proven green probe.
const directory = join(process.cwd(), 'sql/migrations')
const migration = readFileSync(join(directory, '218_sms_quote_chain_readiness.sql'), 'utf8')
const down = readFileSync(join(directory, '218_sms_quote_chain_readiness_down.sql'), 'utf8')
  .replace(/^begin;\r?$/gm, '').replace(/^commit;\r?$/gm, '')
const sources = new Map<string, string>()
let pg: PGlite
let close: (() => Promise<void>) | undefined
type Contract = { signature: string; arg_names: string[] | null; default_count: number; defaults: string | null;
  body_sha256: string; result_type: string; definer: boolean; execute_policy: string }
let contracts: Contract[]
const primary = 'public.prepare_balance_quote(uuid,uuid,jsonb,jsonb,jsonb,bigint,text)'

function sourceFile(number: number) {
  const matches = readdirSync(directory).filter(name => name.startsWith(`${number}_`) && name.endsWith('.sql') && !name.endsWith('_down.sql'))
  expect(matches, `Final mobile migration${number} must exist exactly once before readiness can pass`).toHaveLength(1)
  return matches[0]
}
function bodyFor(sql: string, name: string) {
  const normalized = sql.replace(/\r\n/g, '\n')
  const declaration = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, 'ig')
  const matches = [...normalized.matchAll(declaration)]
  expect(matches, `One exact declared function ${name}`).toHaveLength(1)
  const from = matches[0].index!
  const tag = /\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(normalized.slice(from))!
  expect(tag, `Dollar-quoted PL/pgSQL function ${name}`).toBeTruthy()
  const start = from + tag.index + tag[0].length, end = normalized.indexOf(tag[1], start)
  expect(end).toBeGreaterThan(start)
  return normalized.slice(start, end)
}
async function ready() {
  return (await pg.query<{ ready: boolean }>('select public.sms_quote_chain_ready() ready')).rows[0].ready
}
async function snapshot() {
  return (await pg.query<{ rows: unknown }>(`select jsonb_build_object(
    'quotes',(select coalesce(jsonb_agg(to_jsonb(q) order by id),'[]') from quotes q),
    'intakes',(select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') from intakes i),
    'outbox',(select coalesce(jsonb_agg(to_jsonb(o) order by id),'[]') from sms_outbox o),
    'credit',(select coalesce(jsonb_agg(to_jsonb(c) order by outbox_id),'[]') from quote_credit_settlements c),
    'paint_runs',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from paint_runs r),
    'extractions',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from plan_extractions e),
    'paint_rates',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from paint_rates r),
    'correction_operations',(select coalesce(jsonb_agg(to_jsonb(c) order by tenant_id,run_id,operation_id),'[]') from commercial_paint_correction_operations c),
    'followup_operations',(select coalesce(jsonb_agg(to_jsonb(f) order by id),'[]') from followup_operations f),
    'followup_events',(select coalesce(jsonb_agg(to_jsonb(f) order by id),'[]') from quote_followup_events f),
    'conversations',(select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]') from sms_conversations c),
    'messages',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from sms_messages m),
    'versions',(select coalesce(jsonb_agg(to_jsonb(v) order by id),'[]') from quote_pricing_versions v)) rows`)).rows[0].rows
}
async function replaceBody(signature: string, suffix: string) {
  const { definition } = (await pg.query<{ definition: string }>('select pg_get_functiondef($1::regprocedure) definition', [signature])).rows[0]
  const tag = /\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(definition)!
  const start = tag.index + tag[0].length, end = definition.indexOf(tag[1], start)
  expect(end).toBeGreaterThan(start)
  // A same-signature replacement with even a comment drift must invalidate the
  // reviewed bytes; using comments avoids executing any replacement writer.
  await pg.exec(definition.slice(0, end) + `\n-- ${suffix}\n` + definition.slice(end))
}

beforeAll(async () => {
  // Keep the repository's actual198/199/201/205/207 fixture setup and apply the
  // complete mobile migrations including214's duplicate-history preflight/index.
  const { createOwnerReleaseFixture } = await import('../scripts/sms-owner-release-fixture.mjs')
  const base = await createOwnerReleaseFixture(process.cwd(), { unexpected: [], pdfs: new Map(), downloads: [] })
  pg = base.pg; close = base.close
  try {
    await pg.exec(`alter role service_role bypassrls;
      alter table quotes
      add column if not exists scope_of_works text,add column if not exists scope_short text,
      add column if not exists assumptions jsonb,add column if not exists risk_flags jsonb,
      add column if not exists optional_upsells jsonb,add column if not exists selected_tier text,
      add column if not exists estimated_timeframe text,add column if not exists gst_note text,
      add column if not exists needs_inspection boolean,add column if not exists inspection_reason text,
      add column if not exists deposit_pct numeric,add column if not exists display_mode text,
      add column if not exists stripe_links jsonb,add column if not exists subtotal_ex_gst numeric,
      add column if not exists gst numeric,add column if not exists report_doc jsonb,
      add column if not exists report_style jsonb,add column if not exists applied_discount_pct numeric,
      add column if not exists paid_tier text,add column if not exists quote_kind text,
      add column if not exists paid_amount_cents bigint,add column if not exists paid_stripe_session_id text,
      add column if not exists stripe_connect_destination text,add column if not exists routing_decision text,
      add column if not exists followed_up_at timestamptz,add column if not exists followup_note text;
      alter table pricing_book add column if not exists tenant_id uuid,add column if not exists gst_registered boolean;
      -- Actual baseline columns from init/099/107; complete them before applying
      -- the entire107 migration and actual219, never substitute RPC bodies.
      alter table paint_runs add column if not exists updated_at timestamptz not null default now();
      alter table plan_extractions add column if not exists items jsonb not null default '[]',
        add column if not exists updated_at timestamptz not null default now(),add column if not exists sheets_used jsonb;
      alter table intakes add column if not exists scope jsonb,add column if not exists suburb text,
        add column if not exists access jsonb,add column if not exists property jsonb,
        add column if not exists risks jsonb,add column if not exists inspection_required boolean default false,
        add column if not exists timing jsonb,add column if not exists confidence text,add column if not exists confidence_reason text;
      -- Complete the shared fixture's minimal history table to actual039 shape
      -- before applying its complete migration and the actual220 functions.
      alter table quote_followup_events add column if not exists actor_user_id uuid,
        add column if not exists summary text,add column if not exists created_at timestamptz not null default now();
      grant select,insert,update,delete on quotes,intakes,pricing_book,plan_extractions to service_role;
      grant select on quote_followup_events to service_role;`)
    for (const file of ['030_sms_conversations_followup_quote.sql','039_quote_followup_events.sql']) {
      const sql = readFileSync(join(directory,file),'utf8'); sources.set(file,sql); await pg.exec(sql)
    }
    for (const number of [107,199,201,205,207,211,213,214,215,217,219,220,221]) {
      const file = sourceFile(number), sql = readFileSync(join(directory, file), 'utf8')
      sources.set(file, sql)
      // Shared owner setup now installs the actual non-idempotent217 table and
      // acceptance trigger. Keep its source binding without applying it twice.
      if (number === 107 || (number >= 213 && number !== 217)) await pg.exec(sql)
    }
    await pg.exec(migration)
    await pg.exec(`insert into tenants(id) values('11111111-1111-4111-8111-111111111111');
      insert into intakes(id,tenant_id,trade,job_type) values('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','electrical','power_points');
      insert into quotes(id,tenant_id,intake_id,status,share_token,total_inc_gst) values(
        '33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','draft','offline-readiness-held-token',264);`)
    const begin = migration.indexOf('with required_functions('), end = migration.indexOf('), required_columns(')
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin)
    contracts = (await pg.query<Contract>(`${migration.slice(begin, end + 1)} select * from required_functions`)).rows
  } catch (error) { await close(); close = undefined; throw error }
}, 30000)
beforeEach(async () => { await pg.exec('begin'); expect(await ready(), 'Finalized installed positive control is required before every negative').toBe(true) })
afterEach(async () => { if (close) await pg.exec('rollback') })
afterAll(async () => { await close?.() })

describe('actual quote-chain compatibility RPC', () => {
  it('pins every installed writer/dependency to its actual migration body, with no pending identities', async () => {
    expect(migration).not.toContain('DRAFT:')
    expect(contracts).toHaveLength(29)
    for (const contract of contracts) {
      expect(contract.signature).toMatch(/^public\.[a-z_]+\(/)
      expect(contract.body_sha256).toMatch(/^[a-f0-9]{64}$/)
      const name = contract.signature.slice(7).split('(')[0]
      const source = [...sources.values()].reverse().find(sql => new RegExp(`function\\s+public\\.${name}\\s*\\(`, 'i').test(sql))
      expect(source, `No actual migration defines ${name}`).toBeDefined()
      const body = bodyFor(source!, name)
      expect(createHash('sha256').update(body).digest('hex')).toBe(contract.body_sha256)
      const installed = (await pg.query<{ prosrc: string }>('select prosrc from pg_proc where oid=$1::regprocedure', [contract.signature])).rows[0]
      expect(installed.prosrc.replace(/\r\n/g, '\n')).toBe(body)
    }
  })
  it('runs under service_role in a read-only transaction with no business-row changes', async () => {
    await pg.exec('commit; begin read only')
    const before = await snapshot()
    await pg.exec('set local role service_role')
    expect(await ready()).toBe(true)
    await pg.exec('reset role')
    expect(await snapshot()).toEqual(before)
  })
  it('installs before219 but refuses compatibility until the actual219 functions return', async () => {
    const remove219 = readFileSync(join(directory,'219_commercial_paint_pricing_proof_down.sql'),'utf8')
      .replace(/^begin;\r?$/gm,'').replace(/^commit;\r?$/gm,'')
    await pg.exec(remove219)
    await pg.exec(migration.replace(/^begin;\r?$/gm,'').replace(/^commit;\r?$/gm,''))
    expect(await ready()).toBe(false)
    await pg.exec(sources.get('219_commercial_paint_pricing_proof.sql')!
      .replace(/^begin;\r?$/gm,'').replace(/^commit;\r?$/gm,''))
    expect(await ready()).toBe(true)
  })
  it('installs before220 but refuses compatibility until the actual220 functions return', async () => {
    // Explicit compatibility faults inside this rolled-back, isolated fixture.
    // Production rollback pauses producers and preserves all220 history/objects;
    // there deliberately is no destructive220 down migration.
    await pg.exec('drop trigger followup_outbox_evidence on sms_outbox')
    await pg.exec(`drop function ${contracts.filter(contract=>contract.signature.startsWith('public.followup_')).map(contract=>contract.signature).join(',')}`)
    await pg.exec('drop table followup_operations')
    await pg.exec(migration.replace(/^begin;\r?$/gm,'').replace(/^commit;\r?$/gm,''))
    expect(await ready()).toBe(false)
    await pg.exec(sources.get('220_followup_operations.sql')!
      .replace(/^begin;\r?$/gm,'').replace(/^commit;\r?$/gm,''))
    expect(await ready()).toBe(true)
  })
  it.each(['anon','authenticated'])('denies the probe to %s even on an otherwise ready installation', async role => {
    await pg.exec(`set local role ${role}; savepoint denied_probe`)
    await expect(ready()).rejects.toMatchObject({ code: '42501' })
    await pg.exec('rollback to savepoint denied_probe; reset role')
  })
  it('rejects a missing writer without calling any remaining writer', async () => {
    await pg.exec(`drop function ${primary}`)
    expect(await ready()).toBe(false)
  })
  it('rejects changed argument names even when its body and types are unchanged', async () => {
    const { definition } = (await pg.query<{ definition: string }>('select pg_get_functiondef($1::regprocedure) definition', [primary])).rows[0]
    expect(definition).toContain('p_final_id uuid')
    await pg.exec(`drop function ${primary}`)
    await pg.exec(definition.replace('p_final_id uuid','p_wrong_final_id uuid'))
    expect(await ready()).toBe(false)
  })
  it('rejects changed defaults even when the body and typed signature are unchanged', async () => {
    const signature = 'public.prepare_final_quote(uuid,uuid,jsonb,jsonb,jsonb,uuid)'
    const { definition } = (await pg.query<{ definition: string }>('select pg_get_functiondef($1::regprocedure) definition', [signature])).rows[0]
    expect(definition).toContain('DEFAULT NULL::jsonb')
    await pg.exec(definition.replace('DEFAULT NULL::jsonb',"DEFAULT '{}'::jsonb"))
    expect(await ready()).toBe(false)
  })
  it('rejects each same-name writer or safety dependency whose body changes', async () => {
    for (const contract of contracts) {
      await pg.exec('savepoint changed_body')
      await replaceBody(contract.signature, 'offline contract drift')
      expect(await ready(), contract.signature).toBe(false)
      await pg.exec('rollback to savepoint changed_body; release savepoint changed_body')
      expect(await ready()).toBe(true)
    }
  })
  it.each(['security invoker','set search_path=public,pg_temp','stable','strict','parallel safe'])('rejects altered writer metadata: %s', async alteration => {
    await pg.exec(`alter function ${primary} ${alteration}`)
    expect(await ready()).toBe(false)
  })
  it.each(['volatile','set search_path=public','security definer'])('rejects altered219 source reader metadata: %s', async alteration => {
    await pg.exec(`alter function public.commercial_paint_pricing_source(uuid,uuid,uuid) ${alteration}`)
    expect(await ready()).toBe(false)
  })
  it.each(['stable','set search_path=public','security definer'])('rejects altered220 acceptance helper metadata: %s', async alteration => {
    await pg.exec(`alter function public.followup_outbox_accepted(public.sms_outbox) ${alteration}`)
    expect(await ready()).toBe(false)
  })
  it.each(['remove writer service execute','grant helper service execute','grant trigger authenticated execute'])('rejects changed220 execute permission: %s', async mode => {
    if (mode==='remove writer service execute') await pg.exec('revoke execute on function public.followup_operation_repair(uuid,uuid) from service_role')
    if (mode==='grant helper service execute') await pg.exec('grant execute on function public.followup_outbox_accepted(public.sms_outbox) to service_role')
    if (mode==='grant trigger authenticated execute') await pg.exec('grant execute on function public.followup_outbox_evidence() to authenticated')
    expect(await ready()).toBe(false)
  })
  it.each(['public','anon','authenticated'])('rejects writer execute permission granted to %s', async role => {
    await pg.exec(`grant execute on function ${primary} to ${role}`)
    expect(await ready()).toBe(false)
  })
  it('rejects missing service permission or delegable execute access', async () => {
    await pg.exec(`revoke execute on function ${primary} from service_role`)
    expect(await ready()).toBe(false)
    await pg.exec(`grant execute on function ${primary} to service_role with grant option`)
    expect(await ready()).toBe(false)
  })
  it('rejects a restricted SECURITY DEFINER owner despite unchanged body and service execute', async () => {
    await pg.exec('create role offline_readiness_restricted_owner nologin nobypassrls')
    const before = (await pg.query<{ prosrc: string }>('select prosrc from pg_proc where oid=$1::regprocedure',[primary])).rows[0]
    await pg.exec(`alter function ${primary} owner to offline_readiness_restricted_owner`)
    expect((await pg.query<{ prosrc: string }>('select prosrc from pg_proc where oid=$1::regprocedure',[primary])).rows[0]).toEqual(before)
    expect((await pg.query<{ allowed: boolean }>('select has_function_privilege(\'service_role\',$1::regprocedure,\'EXECUTE\') allowed',[primary])).rows[0].allowed).toBe(true)
    expect(await ready()).toBe(false)
  })
  it('accepts an entitled non-superuser owner and checks its row-lock, RLS and schema authority', async () => {
    await pg.exec(`create role offline_readiness_entitled_owner nologin nosuperuser bypassrls;
      grant usage on schema public to offline_readiness_entitled_owner;
      grant select,insert,update on quotes to offline_readiness_entitled_owner;
      grant select,update on intakes to offline_readiness_entitled_owner;
      grant select on quote_pricing_versions to offline_readiness_entitled_owner;
      alter function ${primary} owner to offline_readiness_entitled_owner;`)
    expect(await ready()).toBe(true)
    await pg.exec('revoke update on intakes from offline_readiness_entitled_owner')
    expect(await ready()).toBe(false)
    await pg.exec('grant update on intakes to offline_readiness_entitled_owner')
    expect(await ready()).toBe(true)
    await pg.exec('alter role offline_readiness_entitled_owner nobypassrls')
    expect(await ready()).toBe(false)
    for (const table of ['quotes','intakes','quote_pricing_versions']) await pg.exec(`alter table ${table} owner to offline_readiness_entitled_owner`)
    expect(await ready()).toBe(true)
    await pg.exec('revoke usage on schema public from public,offline_readiness_entitled_owner; grant usage on schema public to service_role')
    expect(await ready()).toBe(false)
    await pg.exec('grant usage on schema public to offline_readiness_entitled_owner')
    expect(await ready()).toBe(true)
  })
  it('requires a DEFINER trigger owner to retain runtime EXECUTE on its direct dependency', async () => {
    await pg.exec(`create role offline_readiness_caller nologin nosuperuser nobypassrls;
      grant service_role to offline_readiness_caller;
      alter function public.reflect_final_quote_credit() owner to offline_readiness_caller;`)
    expect(await ready()).toBe(true)
    await pg.exec('revoke service_role from offline_readiness_caller')
    expect(await ready()).toBe(false)
  })
  it('requires public schema access for the service execution role', async () => {
    await pg.exec('revoke usage on schema public from public,service_role')
    expect(await ready()).toBe(false)
  })
  it.each(['grant authenticated execute','remove service execute'])('rejects changed219 function permission: %s', async mode => {
    const signature='public.commercial_paint_pricing_source(uuid,uuid,uuid)'
    if (mode==='grant authenticated execute') await pg.exec(`grant execute on function ${signature} to authenticated`)
    else await pg.exec(`revoke execute on function ${signature} from service_role`)
    expect(await ready()).toBe(false)
  })
  it.each([['quotes','applied_discount_pct'],['quotes','report_doc'],['quotes','pricing_book_version_id'],
    ['sms_outbox','body'],['sms_outbox','payload_hash'],['quote_pricing_versions','content_hash'],
    ['quotes','paid_amount_cents'],['quote_credit_settlements','reason'],
    ['plan_extractions','paint_pricing_proof'],['plan_extractions','trade'],['paint_rates','coverage_m2_per_hr'],['intakes','scope'],
    ['followup_operations','accepted_at'],['followup_operations','payload_hash'],['sms_outbox','provider_status'],
    ['sms_outbox','result'],['sms_conversations','followup_quote'],['sms_messages','created_at'],['quote_followup_events','summary'],
    ['commercial_paint_correction_operations','expected_revision'],['commercial_paint_correction_operations','outcome'],
    ['paint_runs','public_token'],['plan_extractions','share_token'],['plan_upload_requests','customer_phone'],['solar_estimates','confirmed_at']])('rejects missing %s.%s', async (table,column) => {
    await pg.exec(`alter table ${table} drop column ${column} cascade`)
    expect(await ready()).toBe(false)
  })
  it('rejects a wrong physical column type', async () => {
    await pg.exec('alter table quotes alter column applied_discount_pct type text')
    expect(await ready()).toBe(false)
  })
  it('rejects a wrong219 extraction trade discriminator type', async () => {
    await pg.exec('alter table plan_extractions alter column trade type varchar(100)')
    expect(await ready()).toBe(false)
  })
  it.each([['status',"'accepted'"],['history',"'complete'"],['accepted_at','now()'],['created_at','null']])('rejects changed220 default %s', async (column,expression) => {
    await pg.exec(`alter table followup_operations alter column ${column} set default ${expression}`)
    expect(await ready()).toBe(false)
  })
  it.each(['request_id','payload_hash','status'])('rejects nullable220 required column %s', async column => {
    await pg.exec(`alter table followup_operations alter column ${column} drop not null`)
    expect(await ready()).toBe(false)
  })
  it('rejects mandatory220 acceptance evidence before any acceptance exists', async () => {
    await pg.exec('alter table followup_operations alter column provider_sid set not null')
    expect(await ready()).toBe(false)
  })
  it.each(['action','target_kind','status','history'])('rejects missing220 allowed-value check on %s', async column => {
    await pg.exec(`alter table followup_operations drop constraint followup_operations_${column}_check`)
    expect(await ready()).toBe(false)
  })
  it('rejects a restrictive220 state check even with the expected name', async () => {
    await pg.exec("alter table followup_operations drop constraint followup_operations_status_check; alter table followup_operations add constraint followup_operations_status_check check(status in ('pending','failed'))")
    expect(await ready()).toBe(false)
  })
  it.each(['drop','nonunique','unpaid-only'])('rejects a %s final-child uniqueness contract', async mode => {
    await pg.exec('drop index quotes_one_final_per_parent')
    if (mode === 'nonunique') await pg.exec("create index quotes_one_final_per_parent on quotes(parent_quote_id) where quote_kind='final' and parent_quote_id is not null")
    if (mode === 'unpaid-only') await pg.exec("create unique index quotes_one_final_per_parent on quotes(parent_quote_id) where quote_kind='final' and parent_quote_id is not null and paid_at is null")
    expect(await ready()).toBe(false)
  })
  it.each(['sms_outbox','quote_pricing_versions','quote_credit_settlements'])('rejects the missing ON CONFLICT unique key on %s', async table => {
    const keys = table === 'sms_outbox' ? ['delivery_key'] : table === 'quote_credit_settlements' ? ['outbox_id'] : ['content_hash','pricing_book_id','tenant_id','trade']
    const constraints = await pg.query<{ name: string }>(`select conname name from pg_constraint c
      where conrelid=$1::regclass and contype in ('p','u') and array(
        select a.attname::text from unnest(c.conkey) key(attnum)
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=key.attnum order by a.attname)=$2::text[]`, [table,keys])
    expect(constraints.rows).toHaveLength(1)
    await pg.exec(`alter table ${table} drop constraint "${constraints.rows[0].name}"`)
    expect(await ready()).toBe(false)
  })
  it.each([['followup_operations',['request_id','tenant_id']],['followup_operations',['id']],['quote_followup_events',['id']]] as const)(
    'rejects missing220 full unique key on %s (%s)', async (table,keys) => {
      const constraints = await pg.query<{ name: string }>(`select conname name from pg_constraint c
        where conrelid=$1::regclass and contype in ('p','u') and array(
          select a.attname::text from unnest(c.conkey) key(attnum)
          join pg_attribute a on a.attrelid=c.conrelid and a.attnum=key.attnum order by a.attname)=$2::text[]`, [table,[...keys]])
      expect(constraints.rows).toHaveLength(1)
      await pg.exec(`alter table ${table} drop constraint "${constraints.rows[0].name}"`)
      expect(await ready()).toBe(false)
    })
  it.each(['followup_operation_provider_idx','sms_messages_outbox_once'])('rejects missing220 deduplication index %s', async index => {
    await pg.exec(`drop index ${index}`)
    expect(await ready()).toBe(false)
  })
  it.each([['sms_outbox','generic_quote_delivery'],['sms_outbox','a_final_quote_credit'],['quote_pricing_versions','quote_pricing_version_immutable'],
    ['quotes','quote_pricing_version_owner'],['sms_outbox','followup_outbox_evidence'],
    ['plan_extractions','sms_commercial_extraction_guard'],['paint_runs','sms_commercial_run_guard']])('rejects disabled, replica-only and changed timing for %s.%s', async (table,trigger) => {
    await pg.exec(`alter table ${table} disable trigger ${trigger}`); expect(await ready()).toBe(false)
    await pg.exec(`alter table ${table} enable replica trigger ${trigger}`); expect(await ready()).toBe(false)
    await pg.exec(`alter table ${table} enable always trigger ${trigger}`); expect(await ready()).toBe(true)
    const definition = (await pg.query<{ definition: string }>('select pg_get_triggerdef(oid) definition from pg_trigger where tgrelid=$1::regclass and tgname=$2', [table,trigger])).rows[0].definition
    await pg.exec(`drop trigger ${trigger} on ${table}`)
    await pg.exec(definition.replace(/\b(BEFORE|AFTER)\b/, value => value === 'BEFORE' ? 'AFTER' : 'BEFORE'))
    expect(await ready()).toBe(false)
  })
  it.each(['disable row level security','revoke service update','grant public read','grant authenticated insert'])('rejects changed220 table permissions: %s', async mode => {
    if (mode==='disable row level security') await pg.exec('alter table followup_operations disable row level security')
    if (mode==='revoke service update') await pg.exec('revoke update on followup_operations from service_role')
    if (mode==='grant public read') await pg.exec('grant select on followup_operations to public')
    if (mode==='grant authenticated insert') await pg.exec('grant insert on followup_operations to authenticated')
    expect(await ready()).toBe(false)
  })
  it.each(['disable row level security','remove RLS bypass','revoke service read','grant public read'])('rejects changed settlement readback permissions: %s', async mode => {
    if (mode === 'disable row level security') await pg.exec('alter table quote_credit_settlements disable row level security')
    if (mode === 'remove RLS bypass') await pg.exec('alter role service_role nobypassrls')
    if (mode === 'revoke service read') await pg.exec('revoke select on quote_credit_settlements from service_role')
    if (mode === 'grant public read') await pg.exec('grant select on quote_credit_settlements to public')
    expect(await ready()).toBe(false)
  })
  it.each([['paint_rates','UPDATE'],['pricing_book','UPDATE'],['paint_runs','UPDATE'],
    ['plan_extractions','UPDATE'],['quotes','INSERT'],['intakes','INSERT'],['paint_rates','SELECT']])(
    'rejects missing219 service privilege %s %s', async (table,privilege) => {
      await pg.exec(`revoke ${privilege} on ${table} from service_role`)
      expect(await ready()).toBe(false)
    })
  it('installs before221 but rejects missing correction receipts and the older rich release writer', async () => {
    const withoutTransaction = (sql: string) => sql.replace(/^begin;\r?$/gm,'').replace(/^commit;\r?$/gm,'')
    await pg.exec('drop function public.apply_commercial_paint_correction(uuid,uuid,uuid,text,uuid,text,jsonb),public.commercial_paint_correction_status(uuid,uuid,uuid),public.commercial_paint_valid_correction(jsonb),public.commercial_paint_edit_snapshot(uuid,uuid)')
    await pg.exec('drop table commercial_paint_correction_operations')
    await pg.exec(withoutTransaction(sources.get('201_sms_trade_quote_contract.sql')!))
    await pg.exec(withoutTransaction(sources.get('211_commercial_quote_release_guard.sql')!))
    await pg.exec(withoutTransaction(migration))
    expect(await ready()).toBe(false)
    await pg.exec(withoutTransaction(sources.get('221_commercial_paint_correction_operations.sql')!))
    expect(await ready()).toBe(true)
  })
  it.each(['volatile','security definer','set search_path=public'])('rejects altered221 snapshot metadata: %s', async alteration => {
    await pg.exec('alter function public.commercial_paint_edit_snapshot(uuid,uuid) '+alteration)
    expect(await ready()).toBe(false)
  })
  it('requires the real phone normalizer STRICT contract', async () => {
    await pg.exec('alter function public.sms_normalise_customer_phone(text) called on null input')
    expect(await ready()).toBe(false)
  })
  it.each(['remove correction service execute','grant guard service execute','grant status authenticated execute'])('rejects altered221 function ACL: %s', async mode => {
    if (mode==='remove correction service execute') await pg.exec('revoke execute on function public.apply_commercial_paint_correction(uuid,uuid,uuid,text,uuid,text,jsonb) from service_role')
    if (mode==='grant guard service execute') await pg.exec('grant execute on function public.guard_commercial_quote_run() to service_role')
    if (mode==='grant status authenticated execute') await pg.exec('grant execute on function public.commercial_paint_correction_status(uuid,uuid,uuid) to authenticated')
    expect(await ready()).toBe(false)
  })
  it('rejects a restricted rich release DEFINER owner with unchanged body and caller permission', async () => {
    const signature='public.sms_release_quote_resource(uuid,text,uuid,text,jsonb,text,jsonb)'
    await pg.exec('create role offline_rich_restricted_owner nologin nobypassrls')
    const before=await pg.query('select prosrc from pg_proc where oid=$1::regprocedure',[signature])
    await pg.exec('alter function '+signature+' owner to offline_rich_restricted_owner')
    expect(await pg.query('select prosrc from pg_proc where oid=$1::regprocedure',[signature])).toEqual(before)
    expect((await pg.query<{ allowed:boolean }>("select has_function_privilege('service_role',$1::regprocedure,'EXECUTE') allowed",[signature])).rows[0].allowed).toBe(true)
    expect(await ready()).toBe(false)
  })
  it.each(['expected_revision','request_hash','changes','outcome'])('rejects nullable221 receipt %s', async column => {
    await pg.exec('alter table commercial_paint_correction_operations alter column '+column+' drop not null')
    expect(await ready()).toBe(false)
  })
  it.each(['request_hash','expected_revision'])('rejects a missing221 receipt check on %s', async column => {
    await pg.exec('alter table commercial_paint_correction_operations drop constraint commercial_paint_correction_operations_'+column+'_check')
    expect(await ready()).toBe(false)
  })
  it('rejects a missing221 full operation identity key', async () => {
    await pg.exec('alter table commercial_paint_correction_operations drop constraint commercial_paint_correction_operations_pkey')
    expect(await ready()).toBe(false)
  })
  it('rejects a wrong221 receipt column type or timestamp default', async () => {
    await pg.exec('savepoint changed_type; alter table commercial_paint_correction_operations alter column outcome type text using outcome::text')
    expect(await ready()).toBe(false)
    await pg.exec('rollback to savepoint changed_type; release savepoint changed_type')
    expect(await ready()).toBe(true)
    await pg.exec('alter table commercial_paint_correction_operations alter column created_at set default now()')
    expect(await ready()).toBe(false)
  })
  it('rejects a wrong physical plan share token type used by rich release', async () => {
    await pg.exec('alter table plan_extractions alter column share_token type varchar(160)')
    expect(await ready()).toBe(false)
  })
  it('checks correction receipt RLS authority independently of credit-table ownership', async () => {
    await pg.exec('alter table quote_credit_settlements owner to service_role; alter role service_role nobypassrls')
    await pg.exec('set local role service_role')
    expect((await pg.query<{ active:boolean }>("select row_security_active('public.commercial_paint_correction_operations') active")).rows[0].active).toBe(true)
    await pg.exec('reset role')
    expect(await ready()).toBe(false)
    await pg.exec('alter table commercial_paint_correction_operations owner to service_role')
    expect(await ready()).toBe(true)
    await pg.exec('alter table commercial_paint_correction_operations force row level security')
    expect(await ready()).toBe(false)
  })
  it.each(['disable RLS','revoke service insert','grant service update','grant public read'])('rejects altered221 receipt access: %s', async mode => {
    if (mode==='disable RLS') await pg.exec('alter table commercial_paint_correction_operations disable row level security')
    if (mode==='revoke service insert') await pg.exec('revoke insert on commercial_paint_correction_operations from service_role')
    if (mode==='grant service update') await pg.exec('grant update on commercial_paint_correction_operations to service_role')
    if (mode==='grant public read') await pg.exec('grant select on commercial_paint_correction_operations to public')
    expect(await ready()).toBe(false)
  })
  it('down migration removes only the probe and leaves all writer bodies and business data intact', async () => {
    const before = await snapshot()
    const definitions = await pg.query('select oid,prosrc from pg_proc where oid=any($1::regprocedure[]) order by oid', [contracts.map(contract => contract.signature)])
    await pg.exec(down)
    expect((await pg.query('select to_regprocedure(\'public.sms_quote_chain_ready()\') as probe')).rows).toEqual([{ probe: null }])
    expect(await snapshot()).toEqual(before)
    expect(await pg.query('select oid,prosrc from pg_proc where oid=any($1::regprocedure[]) order by oid', [contracts.map(contract => contract.signature)])).toEqual(definitions)
  })
})
