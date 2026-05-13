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
}

const SELECT_COLS =
  'id, business_name, owner_first_name, owner_email, owner_mobile, ' +
  'trade, trades, state, status, twilio_sms_number, twilio_voice_number, ' +
  'vapi_assistant_id, stripe_connect_account_id'

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
  return match ?? null
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

/** Find the pilot tenant for a given trade — fallback when no per-tenant
 *  number match exists (legacy pre-v6 conversations). */
export async function tenantByLegacyPilotTrade(
  supabase: SupabaseClient,
  trade: 'electrical' | 'plumbing',
): Promise<TenantRow | null> {
  const expectedName = trade === 'plumbing' ? 'Pilot Plumber' : 'Pilot Sparky'
  const { data } = await supabase
    .from('tenants')
    .select(SELECT_COLS)
    .eq('business_name', expectedName)
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
