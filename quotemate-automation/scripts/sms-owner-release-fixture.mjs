// Offline only: reuse the route journey's SQL adapter without changing its
// implementation. Approval and outbound/reference functions are real migrations.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRouteFixtureDb } from './sms-route-fixture-db.mjs'

export async function createOwnerReleaseFixture(appDirectory, state) {
  const fixture = await createRouteFixtureDb(appDirectory)
  await fixture.pg.exec(`alter table quotes add column price_hold_until timestamptz;
    alter table quotes add column if not exists pricing_book_version_id uuid,
      add column if not exists report_doc jsonb, add column if not exists report_style jsonb;
    -- Actual baseline types/defaults from 02, 160 and 194. Install before 217 so
    -- its accepted-delivery trigger sees the same row fields as production.
    alter table quotes add column if not exists paid_amount_cents bigint,
      add column if not exists paid_stripe_session_id text,
      add column if not exists stripe_connect_destination text,
      add column if not exists paid_tier text,
      add column if not exists deposit_pct numeric(5,2) default 30,
      add column if not exists quote_kind text not null default 'initial';
    alter table sms_conversations add column if not exists intake_id uuid;
    alter table sms_conversations add column if not exists roofing_state jsonb;
    alter table sms_conversations add column if not exists painting_state jsonb;
    alter table sms_conversations add column if not exists updated_at timestamptz default now();
    create table quote_followup_events(id uuid primary key default gen_random_uuid(), tenant_id uuid,quote_id uuid,kind text,outcome text,note text);`)
  for (const migration of ['202_job_quote_operations.sql', '205_generic_quote_customer_release.sql',
    '211_commercial_quote_release_guard.sql', '212_plan_quote_release_guard.sql', '215_generic_release_snapshot.sql',
    '217_final_quote_credit_settlement.sql']) {
    await fixture.pg.exec(readFileSync(join(appDirectory, 'sql/migrations', migration), 'utf8'))
  }
  const fail = error => { state.unexpected.push(String(error)); throw error }
  const client = {
    from(table) {
      const input = { table, filters: [], orders: [] }
      let promise
      const run = () => promise ??= (async () => {
        try {
          if (table === 'job_quote_operations') {
            // This fixture seeds legacy held rows. Read the actual migration202
            // relation; never replace a pending operation with a fabricated ready.
            if (input.action && input.action !== 'select') throw new Error('Unexpected operation mutation')
            const result = await fixture.pg.query('select to_jsonb(j) as row from job_quote_operations j')
            if (result.rows.length) throw new Error('Operation fixture needs explicit filter support')
            return { data: input.single ? null : [], error: null }
          }
          if (table === 'quote_followup_events') {
            if (input.action !== 'insert') throw new Error('Unexpected touch-log access')
            const row = input.payload
            await fixture.pg.query('insert into quote_followup_events(tenant_id,quote_id,kind,outcome,note) values($1,$2,$3,$4,$5)',
              [row.tenant_id,row.quote_id,row.kind,row.outcome,row.note])
            return { data: null, error: null }
          }
          if (table === 'quote_credit_settlements') {
            // Only the actual owned-detail reader's shape is supported. Rows
            // are produced by 217, never by an in-memory accounting fixture.
            const fields = 'outbox_id,quote_id,tenant_id,status,reason'
            const filters = new Map(input.filters.map(filter => [filter.key, filter]))
            const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            if ((input.action && input.action !== 'select') || input.columns !== fields ||
              input.single !== 'maybeSingle' || input.limit !== 1 || input.filters.length !== 2 ||
              !['quote_id', 'tenant_id'].every(key => {
                const filter = filters.get(key)
                return filter?.op === 'eq' && !filter.negated && typeof filter.value === 'string' && uuid.test(filter.value)
              }) || JSON.stringify(input.orders) !== JSON.stringify([
                { key: 'updated_at', ascending: false }, { key: 'outbox_id', ascending: false },
              ])) throw new Error('Unexpected settlement readback shape')
            fixture.operations.push({ table, action: 'select', filters: input.filters })
            const result = await fixture.pg.query(`select to_jsonb(s) as row from (
              select outbox_id,quote_id,tenant_id,status,reason from public.quote_credit_settlements
              where quote_id=$1 and tenant_id=$2 order by updated_at desc,outbox_id desc limit 1
            ) s`, [filters.get('quote_id').value, filters.get('tenant_id').value])
            return { data: result.rows[0]?.row ?? null, error: null }
          }
          return await fixture.query(input)
        } catch (error) { return fail(error) }
      })()
      const query = {
        select: columns => { input.columns = columns; return query },
        insert: payload => { input.action = 'insert'; input.payload = payload; return query },
        update: payload => { input.action = 'update'; input.payload = payload; return query },
        upsert: (payload, options = {}) => { Object.assign(input, { action: 'upsert', payload, conflict: options.onConflict, ignoreDuplicates: options.ignoreDuplicates }); return query },
        order: (key, options = {}) => { input.orders.push({ key, ...options }); return query },
        limit: limit => { input.limit = limit; return query },
        maybeSingle: () => { input.single = 'maybeSingle'; return run() },
        single: () => { input.single = 'single'; return run() },
        then: (resolve, reject) => run().then(resolve, reject),
        not: (key, op, value) => { input.filters.push({ key, op, value, negated: true }); return query },
        or: value => { input.filters.push({ op: 'or', value }); return query },
      }
      for (const op of ['eq','neq','is','in','gte','lte','gt','lt','contains','like','ilike']) {
        query[op] = (key, value) => { input.filters.push({ op, key, value }); return query }
      }
      return query
    },
    async rpc(name, args) {
      try {
        if (name === 'settle_final_quote_credit') {
          const keys = Object.keys(args).sort()
          const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          if (JSON.stringify(keys) !== JSON.stringify(['p_outbox_id', 'p_tenant_id']) ||
            keys.some(key => typeof args[key] !== 'string' || !uuid.test(args[key]))) {
            throw new Error('Unexpected settlement RPC arguments')
          }
          fixture.operations.push({ rpc: name, args })
          const result = await fixture.pg.query('select public.settle_final_quote_credit($1::uuid,$2::uuid) as result',
            [args.p_outbox_id, args.p_tenant_id])
          return { data: result.rows[0].result, error: null }
        }
        if (!['sms_release_quote_resource','approve_generic_quote_release'].includes(name)) return await fixture.rpc({ name, args })
        const entries = Object.entries(args)
        if (entries.some(([key]) => !/^p_[a-z_]+$/.test(key))) throw new Error('Unexpected RPC argument')
        const jsonArgs = new Set(['p_snapshot','p_expected_snapshot','p_outbound'])
        const result = await fixture.pg.query(`select ${name}(${entries.map(([key], index) => `${key}=>$${index + 1}`).join(',')}) as result`,
          entries.map(([key,value]) => jsonArgs.has(key) && value != null ? JSON.stringify(value) : value))
        return { data: result.rows[0].result, error: null }
      } catch (error) { return fail(error) }
    },
    storage: { from(bucket) {
      if (!['quote-pdfs','plan-pdfs'].includes(bucket)) return fail(new Error(`Unexpected storage bucket ${bucket}`))
      return {
        download: async path => {
          const bytes = state.pdfs.get(`${bucket}:${path}`)
          if (!bytes) return fail(new Error(`Unseeded PDF ${bucket}:${path}`))
          state.downloads.push({ bucket, path })
          return { data: new Blob([bytes]), error: null }
        },
        createSignedUrl: async () => fail(new Error('Unexpected signed media request')),
        upload: async () => fail(new Error('Unexpected PDF upload')),
      }
    } },
  }
  return { ...fixture, client }
}
