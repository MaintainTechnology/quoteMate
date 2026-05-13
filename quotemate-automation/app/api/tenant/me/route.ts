// /api/tenant/me — the single endpoint that powers the tradie dashboard.
//
// GET   → returns the authed tradie's tenant + pricing book + service
//         offerings (with assembly labels joined) + last 20 quotes.
//
// PATCH → accepts partial updates for any of:
//         { tenant: {...}, pricing: {...}, services: { assemblyId: bool } }
//
// Auth pattern: client sends Authorization: Bearer <supabase-access-token>.
// Server validates via supabase.auth.getUser(token), then uses the user_id
// to find that tradie's tenant row. The service role key is used for the
// data queries because we haven't shipped RLS yet (per CLAUDE.md v5 note —
// "Full tenant_id/RLS work is flagged as the next architectural debt").

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function userFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

// ─── GET /api/tenant/me ────────────────────────────────────────────
export async function GET(req: Request) {
  const user = await userFromBearer(req)
  if (!user) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Tradie's tenant row — primary lookup by owner_user_id.
  const primary = await supabase
    .from('tenants')
    .select('*')
    .eq('owner_user_id', user.id)
    .maybeSingle()

  if (primary.error) {
    return Response.json({ error: primary.error.message }, { status: 500 })
  }

  let tenant = primary.data

  // Self-heal: a tenant row CAN exist with owner_user_id = NULL when the
  // activate wizard submitted without the URL carry-through (an earlier
  // bug). On the next signed-in load we backfill the link via email so
  // the tradie isn't permanently bounced to onboarding.
  if (!tenant && user.email) {
    const { data: byEmail } = await supabase
      .from('tenants')
      .select('*')
      .eq('owner_email', user.email.toLowerCase())
      .maybeSingle()
    if (byEmail) {
      const { error: linkErr } = await supabase
        .from('tenants')
        .update({ owner_user_id: user.id })
        .eq('id', byEmail.id)
      if (!linkErr) {
        console.log('[tenant/me] backfilled owner_user_id from email match', {
          tenantId: byEmail.id,
          email: user.email,
          userId: user.id,
        })
        tenant = { ...byEmail, owner_user_id: user.id }
      } else {
        console.warn('[tenant/me] backfill update failed', linkErr.message)
        tenant = byEmail
      }
    }
  }

  if (!tenant) {
    return Response.json({ error: 'no_tenant' }, { status: 404 })
  }

  // Run the remaining 4 reads in parallel — they're independent.
  //
  // Service catalogue strategy: we fetch every shared_assemblies row
  // for the tenant's trade AND every tenant_service_offerings row, then
  // merge. This way:
  //   • Tradies whose activation didn't seed offerings still see the
  //     full catalogue (so they can opt in)
  //   • Tradies who toggled OFF a service still see it on the list (so
  //     they can re-enable it)
  //   • New catalogue items added later show up automatically
  // No offering row → enabled defaults to true (catalogue is opt-out
  // by default, matching the activate route's auto-seed intent).
  // Resolve the trades this tenant operates in. Multi-trade tenants
  // have trades=['electrical','plumbing']; legacy single-trade tenants
  // have trades=['electrical'] (backfilled in migration 017) OR an empty
  // array if some legacy code path inserted them without the column. In
  // the empty-array case, fall back to the scalar `trade` so the
  // dashboard still works.
  const tenantTrades: string[] =
    Array.isArray(tenant.trades) && tenant.trades.length > 0
      ? (tenant.trades as string[])
      : tenant.trade
        ? [tenant.trade as string]
        : []

  const [pricingRes, assembliesRes, offeringsRes, quotesRes, licencesRes] =
    await Promise.all([
      // Pricing books — one row per trade for multi-trade tenants. Returned
      // as an array (`pricing_books`) below; the dashboard reads pricing[0]
      // by default and can show a per-trade picker when length > 1.
      supabase
        .from('pricing_book')
        .select('*')
        .eq('tenant_id', tenant.id)
        .order('trade'),
      supabase
        .from('shared_assemblies')
        .select(
          'id, name, description, trade, default_unit, default_unit_price_ex_gst, default_labour_hours, default_exclusions',
        )
        .in('trade', tenantTrades.length > 0 ? tenantTrades : ['__never__'])
        .order('trade')
        .order('name'),
      supabase
        .from('tenant_service_offerings')
        .select('assembly_id, enabled')
        .eq('tenant_id', tenant.id),
      // Quotes table has total_inc_gst (single computed column) + the
      // tier-specific JSONB objects (good/better/best). The dashboard
      // surfaces the headline figure (selected tier total) AND each
      // tier's subtotal so the tradie can see the price range at a
      // glance.
      supabase
        .from('quotes')
        .select(
          'id, created_at, status, selected_tier, total_inc_gst, scope_of_works, share_token, intake_id, needs_inspection, routing_decision, good, better, best, estimated_timeframe',
        )
        .eq('tenant_id', tenant.id)
        .order('created_at', { ascending: false })
        .limit(20),
      // tenant_licences arrived in migration 018 — per-trade licence
      // storage. Multi-trade tradies see one row per trade; single-trade
      // tenants see one row. Pre-018 tenants whose row hasn't been
      // backfilled yet get the legacy tenants.licence_* fallback in the
      // merge step below.
      supabase
        .from('tenant_licences')
        .select('trade, licence_type, licence_number, licence_state, licence_expiry')
        .eq('tenant_id', tenant.id),
    ])

  // Merge assemblies + offerings into a unified Service[] for the dashboard.
  const offeringMap = new Map<string, boolean>(
    (offeringsRes.data ?? []).map((o) => [
      o.assembly_id as string,
      o.enabled as boolean,
    ]),
  )
  const services = (assembliesRes.data ?? []).map((a) => ({
    assembly_id: a.id as string,
    name: a.name as string,
    description: (a.description ?? null) as string | null,
    trade: a.trade as string,
    default_unit: (a.default_unit ?? null) as string | null,
    default_unit_price_ex_gst: a.default_unit_price_ex_gst as number | string | null,
    default_labour_hours: a.default_labour_hours as number | string | null,
    default_exclusions: (a.default_exclusions ?? null) as string | null,
    enabled: offeringMap.has(a.id as string)
      ? (offeringMap.get(a.id as string) as boolean)
      : true,
  }))

  // Resolve job context by joining quotes → intakes. The intake holds
  // the customer-facing details the dashboard wants to surface for each
  // quote row: caller name + phone (JSONB), suburb, job_type, trade,
  // inspection flag. Note the caller fields live inside a JSONB column
  // (`intakes.caller = { name, phone, email }`) — NOT flat columns.
  const intakeIds = Array.from(
    new Set(
      (quotesRes.data ?? [])
        .map((q) => q.intake_id)
        .filter((id): id is string => !!id),
    ),
  )
  type IntakeJoin = {
    caller: { name?: string; phone?: string; email?: string } | null
    suburb: string | null
    job_type: string | null
    trade: string | null
    customer_id: string | null
    inspection_required: boolean | null
  }
  let intakeMap: Record<string, IntakeJoin> = {}
  if (intakeIds.length > 0) {
    const { data: intakes } = await supabase
      .from('intakes')
      .select('id, caller, suburb, job_type, trade, customer_id, inspection_required')
      .in('id', intakeIds)
    intakeMap = Object.fromEntries(
      (intakes ?? []).map((i) => [
        i.id,
        {
          caller: (i.caller as IntakeJoin['caller']) ?? null,
          suburb: (i.suburb as string | null) ?? null,
          job_type: (i.job_type as string | null) ?? null,
          trade: (i.trade as string | null) ?? null,
          customer_id: (i.customer_id as string | null) ?? null,
          inspection_required: (i.inspection_required as boolean | null) ?? null,
        },
      ]),
    )
  }

  // Payments — surface whether the customer has paid a deposit /
  // inspection fee on each quote. We pull only succeeded rows so
  // partial/refunded payments don't flip the badge to paid.
  const quoteIds = (quotesRes.data ?? []).map((q) => q.id)
  const paidQuoteIds = new Set<string>()
  if (quoteIds.length > 0) {
    const { data: paid } = await supabase
      .from('payments')
      .select('quote_id')
      .in('quote_id', quoteIds)
      .eq('status', 'succeeded')
    for (const p of paid ?? []) {
      if (p.quote_id) paidQuoteIds.add(p.quote_id as string)
    }
  }

  const quotes = (quotesRes.data ?? []).map((q) => {
    const intake = q.intake_id ? intakeMap[q.intake_id] : null
    const callerName = intake?.caller?.name?.trim() || null
    const callerPhone = intake?.caller?.phone?.trim() || null
    return {
      ...q,
      customer_first_name: callerName?.split(' ')[0] ?? null,
      customer_full_name: callerName,
      customer_phone: callerPhone,
      suburb: intake?.suburb ?? null,
      job_type: intake?.job_type ?? null,
      trade: intake?.trade ?? null,
      inspection_required: intake?.inspection_required ?? null,
      deposit_paid: paidQuoteIds.has(q.id as string),
    }
  })

  // pricing is shaped as an array for multi-trade tenants. To keep the
  // existing dashboard contract (`pricing` = single object) we surface
  // pricing[0] as `pricing` AND the full list as `pricing_books`. The
  // dashboard can pick whichever shape it needs; legacy single-trade
  // reads of `pricing` keep working unchanged.
  const pricingBooks = pricingRes.data ?? []

  // Build `licences`: one entry per active trade. Order matches
  // tenantTrades. Each entry pulls from tenant_licences (post-018) and
  // falls back to the legacy tenants.licence_* fields when a row hasn't
  // been backfilled yet. Tradies whose accounts pre-date 018 still see
  // their licence on the primary trade.
  type LicenceRow = {
    trade: string
    licence_type: string | null
    licence_number: string | null
    licence_state: string | null
    licence_expiry: string | null
  }
  const licenceByTrade = new Map<string, LicenceRow>(
    (licencesRes.data ?? []).map((l) => [l.trade as string, l as LicenceRow]),
  )
  const licences: LicenceRow[] = tenantTrades.map((t) => {
    const row = licenceByTrade.get(t)
    if (row) return row
    // Legacy fallback — primary trade only.
    if (t === tenant.trade) {
      return {
        trade: t,
        licence_type: (tenant.licence_type as string | null) ?? null,
        licence_number: (tenant.licence_number as string | null) ?? null,
        licence_state: (tenant.state as string | null) ?? null,
        licence_expiry: (tenant.licence_expiry as string | null) ?? null,
      }
    }
    return {
      trade: t,
      licence_type: null,
      licence_number: null,
      licence_state: (tenant.state as string | null) ?? null,
      licence_expiry: null,
    }
  })

  return Response.json({
    tenant,
    pricing: pricingBooks[0] ?? null,
    pricing_books: pricingBooks,
    services,
    quotes,
    licences,
  })
}

// ─── PATCH /api/tenant/me ──────────────────────────────────────────

// Pricing fields are shared between the legacy single-trade payload
// (`pricing: {...}`) and the per-trade payload (`pricing_by_trade:
// { electrical: {...}, plumbing: {...} }`). Defining once keeps the two
// payloads in lockstep.
const PricingFields = z.object({
  hourly_rate: z.coerce.number().positive().optional(),
  call_out_minimum: z.coerce.number().nonnegative().optional(),
  default_markup_pct: z.coerce.number().min(0).max(100).optional(),
  apprentice_rate: z.coerce.number().nonnegative().optional(),
  senior_rate: z.coerce.number().nonnegative().optional(),
  after_hours_multiplier: z.coerce.number().min(1).max(3).optional(),
  min_labour_hours: z.coerce.number().min(0).max(8).optional(),
  risk_buffer_pct: z.coerce.number().min(0).max(100).optional(),
  gst_registered: z.boolean().optional(),
})

const LicenceFields = z.object({
  licence_type: z.string().trim().max(40).optional().or(z.literal('')),
  licence_number: z.string().trim().max(60).optional().or(z.literal('')),
  licence_state: z
    .enum(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'])
    .optional()
    .or(z.literal('')),
  licence_expiry: z.string().trim().optional().or(z.literal('')),
})

const UpdateSchema = z.object({
  tenant: z
    .object({
      business_name: z.string().trim().min(2).max(80).optional(),
      owner_first_name: z.string().trim().min(1).max(40).optional(),
      owner_email: z.string().trim().email().max(120).optional(),
      owner_mobile: z.string().trim().min(8).max(20).optional(),
      trade: z.enum(['electrical', 'plumbing']).optional(),
      state: z.enum(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']).optional(),
      abn: z.string().trim().max(20).optional().or(z.literal('')),
      // Legacy single-licence triple — still written to tenants.licence_*
      // for back-compat with code paths that read the scalar columns.
      licence_type: z.string().trim().max(40).optional().or(z.literal('')),
      licence_number: z.string().trim().max(60).optional().or(z.literal('')),
      licence_expiry: z.string().trim().optional().or(z.literal('')),
    })
    .optional(),
  // Legacy single-pricing payload: applies the same fields to EVERY
  // pricing_book row this tenant owns. Keep accepting this shape so
  // older dashboard builds still work after the per-trade rollout.
  pricing: PricingFields.optional(),
  // Per-trade pricing — apply different rates per trade. Keys are the
  // trade name; values are partial pricing fields. Lets a sparky charge
  // $110/hr for electrical and $0/hr (i.e. unset) for plumbing.
  pricing_by_trade: z
    .record(z.enum(['electrical', 'plumbing']), PricingFields)
    .optional(),
  // Per-trade licence storage (migration 018). Same shape as
  // pricing_by_trade: trade → licence triple.
  licences_by_trade: z
    .record(z.enum(['electrical', 'plumbing']), LicenceFields)
    .optional(),
  // Map of assembly_id → enabled flag. Lets the UI flip multiple
  // service offerings in one round trip.
  services: z.record(z.string().uuid(), z.boolean()).optional(),
})

export async function PATCH(req: Request) {
  const user = await userFromBearer(req)
  if (!user) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = UpdateSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  // Find the tradie's tenant
  const { data: tenant, error: tenantErr } = await supabase
    .from('tenants')
    .select('id, owner_user_id')
    .eq('owner_user_id', user.id)
    .maybeSingle()
  if (tenantErr) {
    return Response.json({ error: tenantErr.message }, { status: 500 })
  }
  if (!tenant) {
    return Response.json({ error: 'no_tenant' }, { status: 404 })
  }

  const updates = parsed.data
  const errors: string[] = []

  // 1. Tenant identity fields
  if (updates.tenant && Object.keys(updates.tenant).length > 0) {
    const { error } = await supabase
      .from('tenants')
      .update(updates.tenant)
      .eq('id', tenant.id)
    if (error) errors.push(`tenant: ${error.message}`)
  }

  // 2a. Pricing book (legacy shared-pricing payload) — applies the
  //     same field updates to every pricing_book row for this tenant.
  if (updates.pricing && Object.keys(updates.pricing).length > 0) {
    const { error } = await supabase
      .from('pricing_book')
      .update(updates.pricing)
      .eq('tenant_id', tenant.id)
    if (error) errors.push(`pricing: ${error.message}`)
  }

  // 2b. Per-trade pricing — each entry updates one specific
  //     pricing_book row scoped by (tenant_id, trade). Lets multi-trade
  //     tradies charge different rates per trade.
  if (updates.pricing_by_trade) {
    for (const [trade, fields] of Object.entries(updates.pricing_by_trade)) {
      if (!fields || Object.keys(fields).length === 0) continue
      const { error } = await supabase
        .from('pricing_book')
        .update(fields)
        .eq('tenant_id', tenant.id)
        .eq('trade', trade)
      if (error) errors.push(`pricing[${trade}]: ${error.message}`)
    }
  }

  // 2c. Per-trade licences — upsert against tenant_licences. We use
  //     upsert (not update) so a tradie filling in licence details for
  //     the FIRST time on a freshly-added trade lands cleanly. Empty
  //     strings are normalised to null so the column stays clean.
  if (updates.licences_by_trade) {
    const rows = Object.entries(updates.licences_by_trade)
      .map(([trade, fields]) => {
        if (!fields) return null
        return {
          tenant_id: tenant.id,
          trade,
          licence_type: emptyToNull(fields.licence_type),
          licence_number: emptyToNull(fields.licence_number),
          licence_state: emptyToNull(fields.licence_state),
          licence_expiry: emptyToNull(fields.licence_expiry),
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
    if (rows.length > 0) {
      const { error } = await supabase
        .from('tenant_licences')
        .upsert(rows, { onConflict: 'tenant_id,trade' })
      if (error) errors.push(`licences: ${error.message}`)
    }
  }

  // 3. Service toggles — UPSERT so the same call works whether or not
  //    a tenant_service_offerings row already exists for this tradie +
  //    assembly. Catalogue-first dashboards mean the row often DOESN'T
  //    exist on the first toggle (the dashboard renders every assembly
  //    for the trade regardless of offerings rows).
  //
  //    Bulk upsert handles all changes in one round-trip via the
  //    composite (tenant_id, assembly_id) primary key.
  if (updates.services) {
    const rows = Object.entries(updates.services).map(([assembly_id, enabled]) => ({
      tenant_id: tenant.id,
      assembly_id,
      enabled,
    }))
    if (rows.length > 0) {
      const { error } = await supabase
        .from('tenant_service_offerings')
        .upsert(rows, { onConflict: 'tenant_id,assembly_id' })
      if (error) errors.push(`services: ${error.message}`)
    }
  }

  if (errors.length > 0) {
    return Response.json({ ok: false, errors }, { status: 500 })
  }
  return Response.json({ ok: true })
}

/** Coerce "" / undefined → null. Used when persisting optional text
 *  fields so the DB column stays clean instead of storing empty strings. */
function emptyToNull(v: string | undefined): string | null {
  if (v === undefined || v === null) return null
  const trimmed = String(v).trim()
  return trimmed === '' ? null : trimmed
}
