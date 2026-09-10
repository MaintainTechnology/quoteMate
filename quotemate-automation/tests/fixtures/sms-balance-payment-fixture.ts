import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type BalanceRow = Record<string, unknown>
type QueryResult = { data: unknown; error: unknown }
type FixtureQuery = PromiseLike<QueryResult> & Record<string, (...args: unknown[]) => unknown>
type SharedFixture = {
  pg: PGlite; client: SupabaseClient; close(): Promise<void>
  seed(table: string, rows: BalanceRow[]): Promise<void>
}
export type BalanceFixtureState = {
  unexpected: string[]; pdfs: Map<string, string>; downloads: unknown[]
  rpcCalls: string[]; failBeforeRpc: string | null; loseAfterRpc: string | null
}

/** Reuse unchanged SQL/transport fixtures. This wrapper adds only SQL213 and
 * exact selected-field projection, which the general fixture does not model. */
export async function createSmsBalancePaymentFixture(app: string, state: BalanceFixtureState) {
  const moduleUrl = pathToFileURL(join(app, 'scripts/sms-owner-release-fixture.mjs')).href
  const shared = await import(/* @vite-ignore */ moduleUrl) as {
    createOwnerReleaseFixture(app: string, state: BalanceFixtureState): Promise<SharedFixture>
  }
  const base = await shared.createOwnerReleaseFixture(app, state)
  try {
    await base.pg.exec(`alter table quotes
      add column if not exists selected_tier text,
      add column if not exists scope_of_works text,
      add column if not exists scope_short text,
      add column if not exists assumptions jsonb,
      add column if not exists estimated_timeframe text,
      add column if not exists gst_note text,
      add column if not exists needs_inspection boolean,
      add column if not exists inspection_reason text,
      add column if not exists deposit_pct numeric default 30,
      add column if not exists display_mode text,
      add column if not exists applied_discount_pct numeric,
      add column if not exists quote_kind text,
      add column if not exists paid_tier text,
      add column if not exists stripe_links jsonb;
      alter table intakes add column if not exists call_id uuid,
        add column if not exists customer_id uuid;
      alter table sms_conversations add column if not exists quote_id uuid;
      create unique index balance_fixture_unpaid_child on quotes(parent_quote_id,quote_kind)
        where paid_at is null and quote_kind in ('final','balance');`)
    await base.pg.exec(readFileSync(join(app, 'sql/migrations/213_prepare_balance_quote.sql'), 'utf8'))
    const fail = (message: string): never => { state.unexpected.push(message); throw new Error(message) }
    function from(table: string) {
      const query = base.client.from(table) as unknown as FixtureQuery
      let columns = '*'
      const project = (result: QueryResult): QueryResult => {
        if (result.error || columns === '*' || result.data == null) return result
        const names = columns.split(',').map(value => value.trim())
        if (names.some(name => !/^[a-z_]+$/.test(name))) return fail(`Unsupported balance projection: ${columns}`)
        const row = (value: unknown) => {
          if (!value || typeof value !== 'object') return fail(`Invalid ${table} projection row`)
          const source = value as BalanceRow
          if (names.some(name => !(name in source))) return fail(`Missing physical ${table} projection field: ${columns}`)
          return Object.fromEntries(names.map(name => [name, source[name]]))
        }
        return { ...result, data: Array.isArray(result.data) ? result.data.map(row) : row(result.data) }
      }
      const wrapped: Record<string, unknown> = {
        select(value = '*') { columns = value; query.select(value); return wrapped },
        maybeSingle: async () => project(await query.maybeSingle() as QueryResult),
        single: async () => project(await query.single() as QueryResult),
        then: (resolve: (value: QueryResult) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(query).then(project).then(resolve, reject),
        abortSignal(signal: AbortSignal) { signal.throwIfAborted(); return wrapped },
      }
      for (const method of ['eq', 'neq', 'is', 'in', 'lte', 'lt', 'gte', 'gt', 'not', 'or', 'order', 'limit', 'update']) {
        wrapped[method] = (...args: unknown[]) => { query[method](...args); return wrapped }
      }
      return wrapped
    }
    async function rpc(name: string, args: BalanceRow) {
      state.rpcCalls.push(name)
      if (state.failBeforeRpc === name) {
        state.failBeforeRpc = null
        return { data: null, error: { code: 'FIXTURE_PRE_COMMIT', message: 'Injected definite pre-commit failure' } }
      }
      let result: QueryResult
      if (['prepare_balance_quote', 'sms_outbox_retry', 'sms_outbox_receipt'].includes(name)) {
        const entries = Object.entries(args)
        if (entries.some(([key]) => !/^p_[a-z_]+$/.test(key))) return fail(`Unexpected balance RPC argument: ${name}`)
        const json = new Set(['p_final_snapshot', 'p_root_snapshot', 'p_intake_snapshot'])
        const response = await base.pg.query<{ value: unknown }>(
          `select ${name}(${entries.map(([key], index) => `${key}=>$${index + 1}`).join(',')}) as value`,
          entries.map(([key, value]) => json.has(key) ? JSON.stringify(value) : value),
        )
        result = { data: response.rows[0].value, error: null }
      } else result = await base.client.rpc(name, args)
      if (state.loseAfterRpc === name) {
        state.loseAfterRpc = null
        return { data: null, error: { code: 'FIXTURE_ACK_LOST', message: 'Injected response loss after real SQL commit' } }
      }
      return result
    }
    const client = { ...base.client, from, rpc } as unknown as SupabaseClient
    return { ...base, client }
  } catch (error) {
    await base.close()
    throw error
  }
}
