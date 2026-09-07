// Tenant lookup helpers — resolve a tenant row from various keys so
// inbound webhooks (SMS, voice), the estimator pipeline, and dashboard
// queries all route correctly per the v6 multi-tenant model.
//
// All lookups return `null` when no match exists (caller decides what
// to do with that — typically fall back to the legacy single-tenant
// pricing book for back-compat with pre-v6 conversations).

import type { SupabaseClient } from '@supabase/supabase-js'

export type Trade = 'electrical' | 'plumbing'

export type TenantRow = {
  id: string
  business_name: string
  owner_first_name: string | null
  owner_email: string
  owner_mobile: string
  /** Primary trade — kept in sync with trades[0] for back-compat. */
  trade: Trade
  /** Every trade this tenant operates in. Length 1 for single-trade
   *  tenants, length 2 when a tradie holds both an electrical and a
   *  plumbing licence. Use this in preference to `trade` when routing
   *  inbound work or rendering catalogues. */
  trades: Trade[]
  state: string | null
  status: 'onboarding' | 'active' | 'suspended'
  twilio_sms_number: string | null
  twilio_voice_number: string | null
  vapi_assistant_id: string | null
  stripe_connect_account_id: string | null
  /** Migration 104 — SMS electrical-plan estimation opt-in (Account tab). */
  sms_estimator_enabled: boolean | null
}

const SELECT_COLS =
  'id, business_name, owner_first_name, owner_email, owner_mobile, ' +
  'trade, trades, state, status, twilio_sms_number, twilio_voice_number, ' +
  'vapi_assistant_id, stripe_connect_account_id, sms_estimator_enabled'

/** PURE — may this tenant's provisioned number transact (run the AI
 *  pipeline, quote, create customer rows)? Only an ACTIVE tenant may.
 *  Fail closed: null/unknown statuses do not transact — a suspended or
 *  still-onboarding tenant's number must behave like a disconnected line,
 *  not keep issuing priced quotes (audit 2026-07-23). */
export function isTransactableTenantStatus(status: string | null | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'active'
}

/** SMS webhooks: find the tenant whose number the customer texted.
 *
 *  Canonicalises both sides to E.164 (+614xxxxxxxx) before comparing.
 *  Previous implementation used Supabase's `.or()` filter to match
 *  either the raw inbound `toNumber` OR the AU-normalised form. That
 *  pattern is fragile because:
 *    1. Supabase escapes commas/special chars inside `.or()` differently
 *       depending on the client version.
 *    2. If a tenant row stored its number as `0468072695` (local) and
 *       Twilio sends `+61468072695` (E.164), the OR would only match
 *       if either format exactly equals what's in the column.
 *  Activation stores every new number as E.164 today, but legacy pilot
 *  rows + any manual edits in Studio could be either format. Comparing
 *  by canonical E.164 on both sides makes the lookup robust to both. */
export async function tenantByDestinationSms(
  supabase: SupabaseClient,
  toNumber: string,
): Promise<TenantRow | null> {
  const canonical = normaliseAuMobile(toNumber)
  // First try a direct equality on the canonical form — covers the
  // common case where the tenant row stores E.164 (which it does for
  // every activation since v6).
  const direct = await supabase
    .from('tenants')
    .select(SELECT_COLS)
    .eq('twilio_sms_number', canonical)
    .maybeSingle()
  if (direct.data) return (direct.data as unknown as TenantRow) ?? null
  // Fallback: tenant row may have a non-canonical legacy format.
  // Pull a small page of candidates and compare normalised on the
  // client. We DON'T select all tenants — bound by twilio_sms_number
  // NOT NULL so the scan is short.
  const { data: candidates } = await supabase
    .from('tenants')
    .select(SELECT_COLS)
    .not('twilio_sms_number', 'is', null)
  const rows = (candidates ?? []) as unknown as TenantRow[]
  const match = rows.find(
    (t) => normaliseAuMobile(t.twilio_sms_number ?? '') === canonical,
  )
  if (match) return match
  // Last resort, LOCAL DEVELOPMENT ONLY (migration 197) — a tenant's
  // spare dev number, so a developer can point a second Twilio number at
  // their laptop without taking the tenant's live number down.
  //
  // The gate is deliberately NODE_ENV rather than a feature flag: a flag
  // is something you can forget to unset, whereas `npm run dev` is the
  // only thing that produces 'development' — Vercel sets 'production' on
  // preview deploys as well as production. So a number parked in this
  // column routes on a developer's machine and nowhere else, and a number
  // left pointing at the production webhook by mistake resolves to no
  // tenant (a disconnected line) instead of quoting as that tenant.
  //
  // Runs only after BOTH production lookups miss, so it can never shadow
  // a live number. Errors are swallowed: on a database that has not taken
  // migration 197 yet, the column is absent and this must degrade to
  // "no tenant", never throw into the webhook.
  if (process.env.NODE_ENV === 'development') {
    const { data: dev, error } = await supabase
      .from('tenants')
      .select(SELECT_COLS)
      .eq('twilio_sms_number_dev', canonical)
      .maybeSingle()
    if (error) {
      console.warn('[tenant/lookup] dev-number lookup skipped', { message: error.message })
      return null
    }
    if (dev) {
      console.warn('[tenant/lookup] resolved via DEV number — local development only', {
        toNumber: canonical,
        tenant: (dev as unknown as TenantRow).business_name,
      })
      return dev as unknown as TenantRow
    }
  }
  return null
}

/** Voice webhooks: find the tenant by the Vapi assistant_id from the payload. */
export async function tenantByVapiAssistant(
  supabase: SupabaseClient,
  assistantId: string,
): Promise<TenantRow | null> {
  const { data } = await supabase
    .from('tenants')
    .select(SELECT_COLS)
    .eq('vapi_assistant_id', assistantId)
    .maybeSingle()
  return (data as TenantRow | null) ?? null
}

/** Sign-in / dashboard: find the tenant by the signed-in Supabase user. */
export async function tenantByOwnerUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<TenantRow | null> {
  const { data } = await supabase
    .from('tenants')
    .select(SELECT_COLS)
    .eq('owner_user_id', userId)
    .maybeSingle()
  return (data as TenantRow | null) ?? null
}

/** Normalise AU mobiles to E.164 (+614xxxxxxxx). Idempotent. */
function normaliseAuMobile(input: string): string {
  const stripped = input.replace(/\s+/g, '')
  if (stripped.startsWith('+61')) return stripped
  if (stripped.startsWith('61')) return `+${stripped}`
  if (stripped.startsWith('04')) return `+61${stripped.slice(1)}`
  if (stripped.startsWith('4') && stripped.length === 9) return `+61${stripped}`
  return stripped
}
