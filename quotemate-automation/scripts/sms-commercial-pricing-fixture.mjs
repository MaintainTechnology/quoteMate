import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rateFields = ['kind','code','label','tenant_id','system','method','product','coverage_m2_per_hr',
  'spread_m2_per_l','price_per_l_ex_gst','unit_hours','value','unit','is_default']
const rpcParameters = {
  commercial_paint_pricing_source: ['p_tenant_id','p_run_id','p_extraction_id'],
  persist_commercial_paint_pricing: ['p_tenant_id','p_run_id','p_extraction_id','p_source','p_proof','p_bom'],
  save_commercial_paint_quote: ['p_tenant_id','p_run_id','p_extraction_id','p_source','p_proof','p_bom','p_priced_at','p_intake','p_quote'],
  commercial_paint_edit_snapshot: ['p_tenant_id','p_run_id'],
  commercial_paint_correction_status: ['p_tenant_id','p_run_id','p_operation_id'],
  apply_commercial_paint_correction: ['p_tenant_id','p_run_id','p_operation_id','p_expected_revision','p_extraction_id','p_request_hash','p_changes'],
}
const jsonParameters = new Set(['p_source','p_proof','p_bom','p_intake','p_quote','p_changes'])

/** Actual 219/221 functions and physical 107 rate columns over the surviving local
 * database. Seed inputs only after their tenant exists; no default rate seed or
 * generated pricing/proof/quote is substituted for the real SQL workflow. */
export async function addCommercialPricingSql(app, fixture, state, tenantId) {
  const base107 = readFileSync(join(app, 'sql/migrations/107_commercial_painting.sql'), 'utf8')
  const start = base107.indexOf('create table if not exists public.paint_rates (')
  const end = base107.indexOf('-- ── 4. Seed:', start)
  assert.ok(start >= 0 && end > start, 'Actual 107 rate-table declaration must be available')
  await fixture.pg.exec(base107.slice(start, end))
  await fixture.pg.exec(`alter table paint_runs add column if not exists updated_at timestamptz default now();
    alter table plan_extractions add column if not exists trade text not null default 'electrical',
      add column if not exists items jsonb,
      add column if not exists updated_at timestamptz default now();
    alter table pricing_book add column if not exists tenant_id uuid,
      add column if not exists gst_registered boolean;
    alter table intakes add column if not exists suburb text, add column if not exists scope jsonb,
      add column if not exists access jsonb, add column if not exists property jsonb,
      add column if not exists risks jsonb, add column if not exists inspection_required boolean,
      add column if not exists timing jsonb, add column if not exists confidence text,
      add column if not exists confidence_reason text;
    alter table quotes add column if not exists scope_of_works text, add column if not exists assumptions jsonb,
      add column if not exists risk_flags jsonb, add column if not exists needs_inspection boolean,
      add column if not exists inspection_reason text, add column if not exists selected_tier text,
      add column if not exists subtotal_ex_gst numeric, add column if not exists gst numeric,
      add column if not exists routing_decision text;`)
  await fixture.pg.exec(readFileSync(join(app, 'sql/migrations/219_commercial_paint_pricing_proof.sql'), 'utf8'))
  await fixture.pg.exec(readFileSync(join(app, 'sql/migrations/221_commercial_paint_correction_operations.sql'), 'utf8'))
  const fail = message => { state.unexpected.push(message); throw new Error(message) }
  const originalFrom = fixture.client.from
  const client = { ...fixture.client,
    rpc(name, args) {
      if (name !== 'sms_commercial_quote_guard_ready' && !rpcParameters[name]) return fixture.client.rpc(name, args)
      const operation = (async () => {
        const parameters = rpcParameters[name] ?? []
        if (JSON.stringify(Object.keys(args ?? {}).sort()) !== JSON.stringify([...parameters].sort()))
          return fail(`Unexpected commercial RPC arguments: ${name}`)
        fixture.operations.push({ rpc: name, args })
        try {
          const response = await fixture.pg.query(`select public.${name}(${parameters.map((_, i) => `$${i + 1}`).join(',')}) as value`,
            parameters.map(key => jsonParameters.has(key) && args[key] !== null ? JSON.stringify(args[key]) : args[key]))
          return { data: response.rows[0].value, error: null }
        } catch (error) {
          // Expected authority/concurrency errors are returned by PostgREST.
          // Unexpected SQL/adapter failures also fail the suite even if caught.
          if (!['QM001','QP001','QP002','QP003','PC001','PC002','PC003','PC004'].includes(error.code))
            state.unexpected.push(`Commercial SQL ${name}: ${error.message}`)
          return { data: null, error: { code: error.code, message: error.message } }
        }
      })()
      return Object.assign(operation, { abortSignal(signal) { signal.throwIfAborted(); return operation } })
    },
    from(table) {
      if (table !== 'paint_rates') return originalFrom(table)
      let columns, trade, owner
      const query = {
        select(value) {
          columns = value.split(',').map(field => field.trim())
          if (JSON.stringify(columns) !== JSON.stringify(rateFields)) return fail('Unexpected commercial rate projection')
          return query
        },
        eq(key, value) {
          if (key !== 'trade' || value !== 'commercial_painting') return fail('Unexpected commercial rate trade')
          trade = value; return query
        },
        or(value) {
          if (value !== `tenant_id.is.null,tenant_id.eq.${tenantId}`) return fail('Unexpected commercial rate owner')
          owner = tenantId; return query
        },
        then(resolve, reject) {
          return (async () => {
            if (!columns || !trade || !owner) return fail('Incomplete commercial rate query')
            const result = await fixture.pg.query(`select to_jsonb(r) as row from (
              select ${columns.join(',')} from paint_rates where trade=$1 and (tenant_id is null or tenant_id=$2)
              order by code,tenant_id nulls first) r`, [trade, owner])
            return { data: result.rows.map(row => row.row), error: null }
          })().catch(error => { state.unexpected.push(String(error)); throw error }).then(resolve, reject)
        },
      }
      return query
    },
  }
  async function seedCommercialRates(rows) {
    for (const row of rows) {
      const keys = Object.keys(row)
      if (keys.some(key => !['trade', ...rateFields].includes(key))) return fail('Unexpected commercial rate seed field')
      await fixture.pg.query(`insert into paint_rates(${keys.join(',')}) values(${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map(key => row[key]))
    }
  }
  return { ...fixture, client, seedCommercialRates }
}
