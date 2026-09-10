import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSmsBalancePaymentFixture, type BalanceFixtureState, type BalanceRow } from './sms-balance-payment-fixture'

/** Adds the physical columns read by the final creator and public page, then
 * executes migration214. The inherited fixture executes213/215/217 and the
 * durable outbox migrations. No final/balance/settlement rows are fabricated. */
export async function createSmsFinalChainFixture(app: string, state: BalanceFixtureState) {
  const base = await createSmsBalancePaymentFixture(app, state)
  try {
    await base.pg.exec(`alter table quotes
      add column if not exists subtotal_ex_gst numeric, add column if not exists gst numeric,
      add column if not exists risk_flags jsonb, add column if not exists optional_upsells jsonb,
      add column if not exists inspection_cause text, add column if not exists booking_state text,
      add column if not exists preview_status text, add column if not exists preview_image_path text,
      add column if not exists preview_image_paths jsonb, add column if not exists samples_status text,
      add column if not exists sample_image_paths jsonb, add column if not exists pdf_path text,
      add column if not exists pdf_signature text, add column if not exists early_bird_discount_pct numeric,
      add column if not exists early_bird_expires_at timestamptz, add column if not exists customer_accepted_at timestamptz,
      add column if not exists scheduled_at timestamptz, add column if not exists scheduled_window text;
      alter table quotes add column if not exists last_status_at timestamptz;
      alter table intakes add column if not exists suburb text, add column if not exists scope jsonb,
        add column if not exists photo_paths jsonb;
      alter table pricing_book add column if not exists licence_type text, add column if not exists licence_number text,
        add column if not exists licence_state text, add column if not exists quote_display text,
        add column if not exists quote_tier_mode text;
      alter table tenants add column if not exists photo_url text, add column if not exists owner_first_name text,
        add column if not exists stripe_connect_account_id text,
        add column if not exists owner_last_name text, add column if not exists owner_mobile text,
        add column if not exists owner_email text, add column if not exists contact_name text,
        add column if not exists website_url text, add column if not exists business_address text,
        add column if not exists logo_url text, add column if not exists intro_video_url text,
        add column if not exists thankyou_video_url text, add column if not exists trust_video_state jsonb,
        add column if not exists trade_videos jsonb;
      alter table sms_conversations add column if not exists photo_paths jsonb;`)
    await base.pg.exec(readFileSync(join(app, 'sql/migrations/214_prepare_final_quote.sql'), 'utf8'))
    const client = { ...base.client,
      from(table: string) {
        if (table !== 'quote_followup_events') return base.client.from(table)
        // The inherited balance-only projection wrapper does not expose insert.
        // Execute only the sender's exact timeline write against its real table.
        return { async insert(row: BalanceRow) {
          if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(['kind', 'note', 'outcome', 'quote_id', 'tenant_id']) ||
              row.kind !== 'sms' || row.outcome !== 'text_sent' || typeof row.note !== 'string') {
            state.unexpected.push('Unexpected final sender timeline write')
            throw new Error('Unexpected final sender timeline write')
          }
          await base.pg.query('insert into quote_followup_events(tenant_id,quote_id,kind,outcome,note) values($1,$2,$3,$4,$5)',
            [row.tenant_id, row.quote_id, row.kind, row.outcome, row.note])
          return { data: null, error: null }
        } }
      },
      async rpc(name: string, args: BalanceRow) {
      if (name !== 'prepare_final_quote') return base.client.rpc(name, args)
      state.rpcCalls.push(name)
      const expected = ['p_child', 'p_deposit_version_id', 'p_intake_snapshot', 'p_parent_id', 'p_parent_snapshot', 'p_tenant_id']
      if (JSON.stringify(Object.keys(args).sort()) !== JSON.stringify(expected)) {
        state.unexpected.push('Unexpected prepare_final_quote argument shape')
        throw new Error('Unexpected prepare_final_quote argument shape')
      }
      const entries = Object.entries(args)
      const jsonKeys = new Set(['p_child', 'p_parent_snapshot', 'p_intake_snapshot'])
      const result = await base.pg.query<{ value: unknown }>(
        `select prepare_final_quote(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) as value`,
        entries.map(([key, value]) => jsonKeys.has(key) && value !== null ? JSON.stringify(value) : value),
      )
      return { data: result.rows[0].value, error: null }
    } } as unknown as SupabaseClient
    return { ...base, client }
  } catch (error) { await base.close(); throw error }
}
