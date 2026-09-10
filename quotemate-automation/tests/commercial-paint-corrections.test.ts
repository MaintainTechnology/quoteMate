import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { calculatePaintPricing, parsePaintPricingSource, type PaintPricingSource } from '@/lib/commercial-painting/pricing-proof'
import { applyPaintCorrection, readPaintCorrectionOperation, readPaintEditSnapshot } from '@/lib/commercial-painting/correction-operations'
import { readRichPaintReview } from '@/lib/commercial-painting/rich-run-review'
import { loadSavedQuoteReview } from '@/lib/sms/quote-review'
import { normalisePaintPricedAt } from '@/lib/commercial-painting/saved-quote'

const io = vi.hoisted(() => ({ tenant: '', db: null as unknown as SupabaseClient, writes: [] as string[], beforeSource: null as null | (() => Promise<void>), beforeWrite: null as null | (() => Promise<void>), loseReply: false }))
vi.mock('@/lib/estimation/auth', () => ({ tenantFromBearer: async () => io.tenant ? { id: io.tenant } : null,
  estimatorSupabase: { rpc: (...args: unknown[]) => (io.db.rpc as (...args: unknown[]) => unknown)(...args), from: (...args: unknown[]) => (io.db.from as (...args: unknown[]) => unknown)(...args) } }))
import { GET, POST } from '@/app/api/tenant/commercial-painting/run/[id]/corrections/route'
import { PATCH } from '@/app/api/tenant/commercial-painting/run/[id]/route'
import { POST as PRICE } from '@/app/api/tenant/commercial-painting/price/route'

let pg: PGlite, db: SupabaseClient
const tenant = randomUUID(), other = randomUUID(), run = randomUUID(), extraction = randomUUID(), book = randomUUID()
const item = { surface: 'Internal walls', room: 'Retail', substrate: 'plasterboard', system: 'low_sheen' as const, unit: 'm2' as const,
  quantity: 100, coats: 2, confidence: 'high' as const, source: 'plan' as const, separate_price: false, excluded: false }
const rates = [{ kind: 'labour', code: 'labour:low_sheen:roller', label: 'Labour', system: 'low_sheen', method: 'roller', coverage_m2_per_hr: 10 },
  { kind: 'material', code: 'mat:wall_low_sheen', label: 'Paint', system: 'low_sheen', product: 'Low sheen', spread_m2_per_l: 15, price_per_l_ex_gst: 11 },
  ...Object.entries({ height_low: 1, height_mid: 1.25, height_high: 1.4, prep_pct: 0.1, sundries_pct: 0.08, labour_rate: 95, crew_hours_per_day: 7.6, default_crew_size: 3 })
    .map(([key, value]) => ({ kind: 'modifier', code: `mod:${key}`, label: key, value }))]
const name = (value: string) => { if (!/^[a-z_]+$/.test(value)) throw new Error('Unexpected SQL identifier'); return value }
beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table paint_runs(id uuid primary key,tenant_id uuid,job_name text,site_address text,status text,public_token text,released_at timestamptz,customer_phone text,created_at timestamptz default now(),updated_at timestamptz);
    create table plan_extractions(id uuid primary key,tenant_id uuid,paint_run_id uuid,trade text default 'commercial_painting',items jsonb,corrected_items jsonb,sheets_used jsonb,priced_bom jsonb,priced_at timestamptz,created_at timestamptz default now(),updated_at timestamptz);
    create table paint_rates(id uuid primary key default gen_random_uuid(),trade text,tenant_id uuid,kind text,code text,label text,system text,method text,product text,coverage_m2_per_hr numeric,spread_m2_per_l numeric,price_per_l_ex_gst numeric,unit_hours numeric,value numeric,unit text,is_default boolean);
    create table pricing_book(id uuid primary key,tenant_id uuid,trade text,gst_registered boolean);
    create table intakes(id uuid primary key,tenant_id uuid,trade text,job_type text,address text,suburb text,scope jsonb,access jsonb,property jsonb,risks jsonb,inspection_required boolean,caller jsonb,timing jsonb,confidence text,confidence_reason text);
    create table quotes(id uuid primary key,tenant_id uuid,intake_id uuid references intakes(id),status text,share_token text,scope_of_works text,assumptions jsonb,risk_flags jsonb,needs_inspection boolean,inspection_reason text,good jsonb,better jsonb,best jsonb,selected_tier text,subtotal_ex_gst numeric,gst numeric,total_inc_gst numeric,routing_decision text);
    create table fixture_outbox(key text primary key,body jsonb,hash text);
    create function sms_outbox_enqueue(key text,body jsonb,hash text) returns void language plpgsql as $$ begin insert into fixture_outbox values(key,body,hash) on conflict do nothing; end $$;`)
  const dependency = readFileSync('sql/migrations/201_sms_trade_quote_contract.sql', 'utf8').match(/create or replace function public\.sms_normalise_customer_phone\(p_phone text\)[\s\S]*?\$\$;/)![0]
  await pg.exec(dependency)
  for (const file of ['211_commercial_quote_release_guard.sql', '219_commercial_paint_pricing_proof.sql', '221_commercial_paint_correction_operations.sql']) await pg.exec(readFileSync(`sql/migrations/${file}`, 'utf8'))
  await pg.exec('grant usage on schema public to service_role; grant select,insert,update,delete on paint_runs,plan_extractions,paint_rates,pricing_book to service_role')
  db = {
    rpc(rpc: string, args: Record<string, unknown> = {}) {
      return { abortSignal: async () => {
        if (rpc === 'commercial_paint_pricing_source' && io.beforeSource) { const hook = io.beforeSource; io.beforeSource = null; await hook() }
        if (rpc === 'apply_commercial_paint_correction') { io.writes.push(rpc); if (io.beforeWrite) { const hook = io.beforeWrite; io.beforeWrite = null; await hook() } }
        try {
          const pairs = Object.entries(args)
          const result = await pg.query<{ value: unknown }>(`select ${name(rpc)}(${pairs.map(([key], index) => `${name(key)}=>$${index + 1}`).join(',')}) value`, pairs.map(([, value]) => value))
          if (rpc === 'apply_commercial_paint_correction' && io.loseReply) { io.loseReply = false; return { data: null, error: { code: 'LOST_REPLY' } } }
          return { data: result.rows[0]?.value, error: null }
        } catch (error) { return { data: null, error } }
      } }
    },
    from(table: string) {
      const filters: [string, unknown][] = [], order: string[] = []; let nonnull = ''; let limit = ''
      const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([name(key), value]); return query },
        not: (key: string) => { nonnull = ` and ${name(key)} is not null`; return query },
        order: (key: string, options: { ascending: boolean }) => { order.push(`${name(key)} ${options.ascending ? 'asc' : 'desc'}`); return query },
        limit: (value: number) => { limit = ` limit ${Number(value)}`; return query },
        maybeSingle: async () => {
          // PostgREST returns timestamp strings with database precision, not JS Dates.
          const rows = await pg.query<{ data: Record<string, unknown> }>(`select to_jsonb(t) data from (select * from ${name(table)} where ${filters.map(([key], i) => `${key}=$${i + 1}`).join(' and ')}${nonnull}${order.length ? ' order by ' + order.join(',') : ''}${limit}) t`, filters.map(([, value]) => value))
          return { data: rows.rows[0]?.data ?? null, error: null }
        } }
      return query
    },
  } as unknown as SupabaseClient
  io.db = db
}, 60000)
beforeEach(async () => {
  await pg.exec('begin')
  io.tenant = tenant; io.writes = []; io.beforeWrite = null; io.beforeSource = null; io.loseReply = false
  await pg.query("insert into paint_runs(id,tenant_id,job_name,site_address,status,public_token,customer_phone) values($1,$2,'Original job','Original address','ready','paint_test_public_token','0411111111')", [run, tenant])
  await pg.query('insert into plan_extractions(id,tenant_id,paint_run_id,items) values($1,$2,$3,$4)', [extraction, tenant, run, [item]])
  await pg.query("insert into pricing_book values($1,$2,'commercial_painting',true)", [book, tenant])
  for (const rate of rates) {
    const row = { ...rate, tenant_id: tenant, trade: 'commercial_painting', is_default: false }; const keys = Object.keys(row)
    await pg.query(`insert into paint_rates(${keys.join(',')}) values(${keys.map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(row))
  }
})
afterEach(async () => { await pg.exec('rollback') })
afterAll(async () => { await pg?.close() })
async function source() { return (await pg.query<{ source: PaintPricingSource }>('select commercial_paint_pricing_source($1,$2,$3) source', [tenant, run, extraction])).rows[0]!.source }
async function price() {
  const input = parsePaintPricingSource(await source(), tenant, run, extraction)
  const result = calculatePaintPricing(input, { mode: 'tenant', ratePerHr: null })
  const persisted = await pg.query<{ result: { priced_at: string } }>('select persist_commercial_paint_pricing($1,$2,$3,$4,$5,$6) result', [tenant, run, extraction, input, result.proof, result.bom])
  return { ...result, pricedAt: normalisePaintPricedAt(persisted.rows[0]!.result.priced_at)! }
}
async function body(patch: Record<string, unknown> = {}) { return { operationId: randomUUID(), expectedRevision: (await readPaintEditSnapshot(db, tenant, run)).revision, extractionId: extraction, corrected_items: [{ ...item, quantity: 125 }], ...patch } }
async function route(method: 'GET' | 'POST' | 'PATCH', payload?: unknown, query = '', owner: string = tenant) {
  io.tenant = owner; const request = new Request(`https://fixture.test/api/tenant/commercial-painting/run/${run}/corrections${query}`, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
  const response = await ({ GET, POST, PATCH }[method])(request, { params: Promise.resolve({ id: run }) })
  return { status: response.status, data: await response.json() }
}
async function row() { return (await pg.query<{ data: Record<string, unknown> }>('select to_jsonb(r) data from paint_runs r where id=$1', [run])).rows[0]!.data }
async function ext() { return (await pg.query<Record<string, unknown>>('select * from plan_extractions where id=$1', [extraction])).rows[0]! }
async function release(snapshot: Record<string, unknown>) {
  const outbound = { tenantId: tenant, to: '0411111111', resourceToken: 'paint_test_public_token' }
  return pg.query('select sms_release_quote_resource($1,$2,$3,$4,$5,$6,$7)', [tenant, 'commercial-paint', run, '0411111111', outbound, 'fixture-hash', snapshot])
}
async function rejected(operation: () => Promise<unknown>, code: string) {
  await pg.exec('savepoint rejected'); try { await expect(operation()).rejects.toMatchObject({ code }) }
  finally { await pg.exec('rollback to savepoint rejected; release savepoint rejected') }
}
it('atomically saves metadata and all valid zero/false corrections, clears pricing proof, and recovers a lost reply by GET', async () => {
  await price(); const input = await body({ job_name: 'Changed job', site_address: '', corrected_items: [{ ...item, quantity: 0, excluded: false }] })
  io.loseReply = true; const failed = await route('POST', input); expect(failed.status).toBe(503)
  const recovered = await route('GET', undefined, `?operationId=${input.operationId}`)
  expect(recovered.data).toMatchObject({ status: 'applied', runId: run, operationId: input.operationId, expectedRevision: input.expectedRevision, extractionId: extraction })
  expect(io.writes).toHaveLength(1); expect(await row()).toMatchObject({ job_name: 'Changed job', site_address: null, status: 'ready' })
  expect(await ext()).toMatchObject({ corrected_items: [{ ...item, quantity: 0, excluded: false }], priced_bom: null, priced_at: null, paint_pricing_proof: null })
});
it.each([{ coats: 6 }, { quantity: -1 }, { system: null }, { surface: '' }, { height_m: 30 }])('rejects the whole invalid request before metadata or RPC writes %j', async invalid => {
  const response = await route('POST', await body({ job_name: 'Must not write', corrected_items: [{ ...item, ...invalid }] }))
  expect(response.status).toBe(400); expect(io.writes).toEqual([]); expect((await row()).job_name).toBe('Original job')
});
it('legacy PATCH validates before all writes and keeps its success shape through the atomic adapter', async () => {
  expect((await route('PATCH', { extractionId: extraction, job_name: 'Must not write', corrected_items: [{ ...item, coats: 6 }] })).status).toBe(400)
  expect((await row()).job_name).toBe('Original job'); expect(io.writes).toHaveLength(0)
  expect((await route('PATCH', { extractionId: extraction, job_name: 'Legacy job', corrected_items: [item] })).data).toMatchObject({ ok: true, savedItems: 1 })
  expect((await row()).job_name).toBe('Legacy job')
});
it('rejects a competing correction against an old opened baseline without partial metadata changes', async () => {
  const first = await body({ job_name: 'First winner' }), second = { ...await body(), job_name: 'Losing edit' }
  await applyPaintCorrection(db, tenant, run, first)
  await pg.exec('savepoint rejected'); expect((await route('POST', second)).status).toBe(409); await pg.exec('rollback to savepoint rejected; release savepoint rejected')
  expect((await row()).job_name).toBe('First winner')
});
it('returns an original operation after newer edits without replaying it and rejects altered ID reuse', async () => {
  const first = await body({ job_name: 'First' }); const applied = await applyPaintCorrection(db, tenant, run, first)
  await applyPaintCorrection(db, tenant, run, await body({ job_name: 'Second' }))
  expect(await applyPaintCorrection(db, tenant, run, first)).toEqual(applied); expect((await row()).job_name).toBe('Second')
  await pg.exec('savepoint rejected'); await expect(applyPaintCorrection(db, tenant, run, { ...first, job_name: 'Changed request' })).rejects.toMatchObject({ code: 'correction_operation_reused' }); await pg.exec('rollback to savepoint rejected; release savepoint rejected')
});
it('cannot edit a superseded extraction or reveal another tenant operation', async () => {
  const input = await body(); await pg.query('insert into plan_extractions(id,tenant_id,paint_run_id,items,created_at) values($1,$2,$3,$4,clock_timestamp()+interval \'1 hour\')', [randomUUID(), tenant, run, [item]])
  await pg.exec('savepoint rejected'); expect((await route('POST', input)).status).toBe(409); await pg.exec('rollback to savepoint rejected; release savepoint rejected')
  await pg.exec('savepoint rejected'); await expect(readPaintCorrectionOperation(db, other, run, input.operationId)).rejects.toMatchObject({ code: 'not_found' }); await pg.exec('rollback to savepoint rejected; release savepoint rejected')
  expect((await row()).job_name).toBe('Original job')
});
it('GET is read-only and validates scoped IDs and authentication', async () => {
  expect((await route('GET')).data.snapshot).toMatchObject({ runId: run, extractionId: extraction, released: false })
  expect((await route('GET', undefined, '?operationId=invalid')).status).toBe(400)
  expect((await route('GET', undefined, `?operationId=${randomUUID()}&operationId=${randomUUID()}`)).status).toBe(400)
  expect((await route('GET', undefined, '?tenantId=forged')).status).toBe(400)
  expect((await route('POST', await body(), '?unexpected=1')).status).toBe(400)
  expect((await route('GET', undefined, '', '')).status).toBe(401); expect(io.writes).toHaveLength(0)
});
it('bounds declared and streamed bodies before correction writes and preserves the valid 5000-row limit', async () => {
  const huge = new Request(`https://fixture.test/run/${run}/corrections`, { method: 'POST', headers: { 'content-length': String(4_000_001) }, body: '{}' })
  expect((await POST(huge, { params: Promise.resolve({ id: run }) })).status).toBe(413)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4_000_001)); controller.close() } })
  const streamed = new Request(`https://fixture.test/run/${run}/corrections`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
  expect((await POST(streamed, { params: Promise.resolve({ id: run }) })).status).toBe(413)
  expect(io.writes).toHaveLength(0)
  expect((await route('POST', await body({ corrected_items: Array.from({ length: 5000 }, () => ({ ...item, quantity: 0 })) }))).status).toBe(200)
})
it.each(['current', 'uppercase', 'stale', 'between-reads'])('price binds the caller-observed revision: %s', async mode => {
  const baseline = await readPaintEditSnapshot(db, tenant, run)
  if (mode === 'stale') await pg.query("update paint_runs set job_name='Other editor' where id=$1", [run])
  if (mode === 'between-reads') io.beforeSource = () => pg.query("update paint_runs set job_name='Other editor' where id=$1", [run]).then(() => {})
  const response = await PRICE(new Request('https://fixture.test/price', { method: 'POST', body: JSON.stringify({ paintRunId: mode === 'uppercase' ? run.toUpperCase() : run,
    extractionId: mode === 'uppercase' ? extraction.toUpperCase() : extraction, expectedRevision: baseline.revision }) }))
  expect(response.status).toBe(['current', 'uppercase'].includes(mode) ? 200 : 409)
  if (!['current', 'uppercase'].includes(mode)) expect((await ext()).priced_bom).toBeNull()
})
it('rich-run review requires current219 proof, not a positive legacy BOM', async () => {
  await pg.query("update plan_extractions set priced_bom='{\"totalIncGst\":100}' where id=$1", [extraction]); await pg.query("update paint_runs set status='priced' where id=$1", [run])
  expect((await loadSavedQuoteReview(db, tenant, 'commercial-paint', run))?.canApprove).toBe(false)
  await price(); const review = await loadSavedQuoteReview(db, tenant, 'commercial-paint', run)
  expect(review?.canApprove).toBe(true); expect(review?.sourceSnapshot._review_paint_pricing).toMatchObject({ extractionId: extraction })
});
it.each(['rate', 'GST', 'new extraction', 'same BOM timestamp'])('locked rich-run release rejects %s changes after review', async kind => {
  await price(); const review = await loadSavedQuoteReview(db, tenant, 'commercial-paint', run)
  if (kind === 'rate') await pg.query("update paint_rates set value=96 where tenant_id=$1 and code='mod:labour_rate'", [tenant])
  if (kind === 'GST') await pg.query('update pricing_book set gst_registered=false where id=$1', [book])
  if (kind === 'new extraction') await pg.query('insert into plan_extractions(id,tenant_id,paint_run_id,items,created_at) values($1,$2,$3,$4,clock_timestamp()+interval \'1 hour\')', [randomUUID(), tenant, run, [item]])
  if (kind === 'same BOM timestamp') {
    await price()
    await rejected(() => release(review!.sourceSnapshot), 'P0001')
    // Even with the latest run metadata, an old identical-BOM pass is rejected.
    review!.sourceSnapshot = { ...await row(), _review_priced_bom: review!.sourceSnapshot._review_priced_bom,
      _review_paint_pricing: review!.sourceSnapshot._review_paint_pricing }
  }
  await rejected(() => release(review!.sourceSnapshot), 'QP001')
  expect((await pg.query('select * from fixture_outbox')).rows).toHaveLength(0); expect((await row()).released_at).toBeNull()
});
it('released review uses immutable historical rates and disallows later source/proof/metadata edits', async () => {
  await price(); const review = await loadSavedQuoteReview(db, tenant, 'commercial-paint', run); await release(review!.sourceSnapshot)
  await pg.query("update paint_rates set value=96 where tenant_id=$1 and code='mod:labour_rate'", [tenant])
  const released = await loadSavedQuoteReview(db, tenant, 'commercial-paint', run); expect(released?.canApprove).toBe(true)
  await release(released!.sourceSnapshot); expect((await pg.query('select * from fixture_outbox')).rows).toHaveLength(1)
  await rejected(() => pg.query('update plan_extractions set corrected_items=$1 where id=$2', [[{ ...item, quantity: 200 }], extraction]), 'QM001')
  await rejected(() => pg.query("update plan_extractions set paint_pricing_proof=null where id=$1", [extraction]), 'QM001')
  await rejected(() => pg.query("update paint_runs set job_name='Changed' where id=$1", [run]), 'QM001')
  expect((await readRichPaintReview(db, tenant, await row())).binding).not.toBeNull()
});
it('denies public and authenticated execution/table access', async () => {
  const rows = await pg.query<{ allowed: boolean }>(`select has_function_privilege('authenticated','apply_commercial_paint_correction(uuid,uuid,uuid,text,uuid,text,jsonb)','EXECUTE') allowed
    union all select has_table_privilege('anon','commercial_paint_correction_operations','SELECT')`)
  expect(rows.rows.every(row => row.allowed === false)).toBe(true)
});
it('proves all seven effective ACLs, trigger invoker modes, and the actual201 phone dependency', async () => {
  const functions = ['commercial_paint_edit_snapshot', 'commercial_paint_valid_correction', 'commercial_paint_correction_status',
    'apply_commercial_paint_correction', 'sms_release_quote_resource', 'guard_commercial_quote_extraction', 'guard_commercial_quote_run']
  const rows = await pg.query<{ proname: string; security_definer: boolean; anon: boolean; authenticated: boolean; service: boolean }>(`select proname,prosecdef security_definer,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and proname=any($1::text[])`, [functions])
  expect(rows.rows).toHaveLength(7)
  for (const row of rows.rows) expect(row).toMatchObject({ anon: false, authenticated: false,
    security_definer: row.proname === 'sms_release_quote_resource', service: !row.proname.startsWith('guard_') })
  expect((await pg.query("select proisstrict,provolatile,sms_normalise_customer_phone('0411 111 111') normalized,sms_normalise_customer_phone(null) absent from pg_proc where proname='sms_normalise_customer_phone'")).rows[0])
    .toMatchObject({ proisstrict: true, provolatile: 'i', normalized: '61411111111', absent: null })
})
it('executes owned correction, status and trigger guards as the actual service role', async () => {
  const input = await body({ job_name: 'Service correction' })
  await pg.exec('set local role service_role')
  const saved = await applyPaintCorrection(db, tenant, run, input)
  expect(await readPaintCorrectionOperation(db, tenant, run, input.operationId)).toEqual(saved)
  expect((await readPaintEditSnapshot(db, tenant, run)).job_name).toBe('Service correction')
  await pg.exec('reset role')
  await price(); const review = await loadSavedQuoteReview(db, tenant, 'commercial-paint', run)
  await pg.exec('set local role service_role')
  await release(review!.sourceSnapshot)
  await rejected(() => pg.query("update paint_runs set job_name='Forbidden edit' where id=$1", [run]), 'QM001')
  await pg.exec('reset role')
})
it.each([{ corrected_items: [{ ...item, system: null }] }, { corrected_items: [{ ...item, quantity: '10' }] }, { job_name: 'valid', hidden: true }])('SQL independently rejects invalid complete corrections %j', async changes => {
  const input = await body()
  await rejected(() => pg.query('select apply_commercial_paint_correction($1,$2,$3,$4,$5,$6,$7)',
    [tenant, run, input.operationId, input.expectedRevision, extraction, 'a'.repeat(64), changes]), 'PC003')
  expect((await row()).job_name).toBe('Original job')
  expect((await pg.query('select * from commercial_paint_correction_operations')).rows).toHaveLength(0)
})
it('operational rollback preserves committed replay and GET recovery while pausing new writes', async () => {
  const input = await body(); const saved = await applyPaintCorrection(db, tenant, run, input)
  const rollback = readFileSync('sql/rollbacks/221_commercial_paint_correction_operations.sql', 'utf8')
  await pg.exec(rollback.match(/create or replace function public\.apply_commercial_paint_correction[\s\S]*?end \$\$;/)![0])
  expect(await applyPaintCorrection(db, tenant, run, input)).toEqual(saved)
  expect(await readPaintCorrectionOperation(db, tenant, run, input.operationId)).toEqual(saved)
  const fresh = await body()
  await rejected(() => pg.query('select apply_commercial_paint_correction($1,$2,$3,$4,$5,$6,$7)',
    [tenant, run, fresh.operationId, fresh.expectedRevision, extraction, 'b'.repeat(64), { job_name: 'Must stay paused' }]), 'PC005')
  expect((await row()).job_name).toBe('Original job')
})
