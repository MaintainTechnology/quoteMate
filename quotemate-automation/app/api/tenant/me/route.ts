// /api/tenant/me — the single endpoint that powers the tradie dashboard.
//
// GET   → returns the authed tradie's tenant + pricing book + service
//         offerings (with assembly labels joined) + last 100 quotes.
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
import { UpdateSchema } from '@/lib/tenant/update-schema'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { parseVapiTranscript } from '@/lib/voice/parse-transcript'
import { measurementHrefByShareToken } from '@/lib/dashboard/measurement-links'
import {
  normalizeServiceDelta,
  buildServiceWritePlan,
  mergeWithLegacyDicts,
  annotateNameCollisions,
} from '@/lib/dashboard/service-delta'

// R36 — per-service delta contract. Accepts a SINGLE entry or an ARRAY so the
// dashboard can flip exactly one row without re-sending its whole in-memory
// service snapshot (which lets a stale tab clobber a row a second tab just
// changed). Parsed from the raw body separately from UpdateSchema so the
// shared schema (consumed by other routes) stays untouched. `is_custom`
// selects the table the route writes to; defaults to shared (false).
const ServiceDeltaEntrySchema = z.object({
  assembly_id: z.string().uuid(),
  enabled: z.boolean(),
  is_custom: z.boolean().optional(),
})
const ServiceDeltaSchema = z.union([
  ServiceDeltaEntrySchema,
  z.array(ServiceDeltaEntrySchema).max(200),
])

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─── GET /api/tenant/me ────────────────────────────────────────────
export async function GET(req: Request) {
  // Dual-auth: accept a Clerk session token (→ clerk_user_id) OR the legacy
  // Supabase access token (→ owner_user_id). Resolver loads the tenant row.
  const resolved = await resolveTenantRequest(supabase, req, '*')
  if (!resolved) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { identity } = resolved
  let tenant = resolved.tenant

  // Self-heal: a tenant row CAN exist UNLINKED (owner_user_id / clerk_user_id
  // NULL) — e.g. the activate wizard submitted without the URL carry-through,
  // or a brand-new Clerk identity not yet linked. On the next signed-in load
  // we backfill the PROVIDER-APPROPRIATE link column via an email match so the
  // tradie isn't permanently bounced to onboarding. (Clerk session tokens may
  // omit the email claim; when they do this simply no-ops, because every
  // migrated tenant is already linked by clerk_user_id.)
  if (!tenant && identity.email) {
    const linkColumn = identity.provider === 'clerk' ? 'clerk_user_id' : 'owner_user_id'
    const { data: byEmail } = await supabase
      .from('tenants')
      .select('*')
      .eq('owner_email', identity.email.toLowerCase())
      .maybeSingle()
    if (byEmail) {
      // Backfill the link ONLY when it is currently unset. If the column already
      // holds an id, it belongs to the OTHER Clerk instance sharing this DB
      // (dev sk_test vs prod sk_live) — overwriting it would break that
      // environment (the see-saw). In that case resolve READ-ONLY. The primary
      // recovery path is the email fallback in lib/tenant/current.ts.
      if (!byEmail[linkColumn]) {
        const { error: linkErr } = await supabase
          .from('tenants')
          .update({ [linkColumn]: identity.userId })
          .eq('id', byEmail.id)
        if (!linkErr) {
          console.log('[tenant/me] backfilled unlinked tenant from email match', {
            tenantId: byEmail.id,
            provider: identity.provider,
            linkColumn,
          })
          tenant = { ...byEmail, [linkColumn]: identity.userId }
        } else {
          console.warn('[tenant/me] backfill update failed', linkErr.message)
          tenant = byEmail
        }
      } else {
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

  const [
    pricingRes,
    assembliesRes,
    offeringsRes,
    quotesRes,
    licencesRes,
    materialsRes,
    prefsRes,
    customAssembliesRes,
  ] =
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
          'id, name, description, trade, default_unit, default_unit_price_ex_gst, default_labour_hours, default_exclusions, default_enabled',
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
          // paid_tier + the mig-194 chain columns (spec post-visit-money-sequence
          // R12): without paid_tier the dashboard cannot tell a $99 site-visit
          // payment from a deposit, which is what gates "Issue final quote";
          // quote_kind/parent_quote_id keep a chained job (initial → final →
          // balance) counting as ONE job in the pipeline KPIs.
          // Native review also needs the actual delivery time, inspection
          // cause and server-issued EV document number (migrations 193/195).
          'id, created_at, sent_at, status, selected_tier, total_inc_gst, scope_of_works, share_token, intake_id, needs_inspection, inspection_cause, estimate_number, routing_decision, good, better, best, estimated_timeframe, display_mode, paid_at, paid_tier, quote_kind, parent_quote_id',
        )
        .eq('tenant_id', tenant.id)
        .order('created_at', { ascending: false })
        // ponytail: 100-quote cap — server pagination when a tenant outgrows it.
        // 20 starved multi-trade tenants: whole trades vanished from the hubs.
        .limit(100),
      // tenant_licences arrived in migration 018 — per-trade licence
      // storage. Multi-trade tradies see one row per trade; single-trade
      // tenants see one row. Pre-018 tenants whose row hasn't been
      // backfilled yet get the legacy tenants.licence_* fallback in the
      // merge step below.
      supabase
        .from('tenant_licences')
        .select('trade, licence_type, licence_number, licence_state, licence_expiry')
        .eq('tenant_id', tenant.id),
      // Material catalogue grouped by category — fed to the dashboard
      // so the "Preferred brands" section can render a brand dropdown
      // per category. We pull only rows that have a category set
      // (migration 022 backfill) AND a brand string (NULL-brand rows
      // are generic and don't participate in preference selection).
      supabase
        .from('shared_materials')
        .select('trade, category, brand')
        .in('trade', tenantTrades.length > 0 ? tenantTrades : ['__never__'])
        .not('category', 'is', null)
        .not('brand', 'is', null)
        .order('trade')
        .order('category')
        .order('brand'),
      // This tenant's current brand preferences (one row per category).
      supabase
        .from('tenant_material_preferences')
        .select('category, preferred_brand')
        .eq('tenant_id', tenant.id),
      // Tenant-owned custom assemblies (migration 023). Returned in
      // their own array AND merged into `services` below so the
      // dashboard can render both seeded + custom rows in one list
      // without the client having to re-merge.
      supabase
        .from('tenant_custom_assemblies')
        .select('*')
        .eq('tenant_id', tenant.id)
        .in('trade', tenantTrades.length > 0 ? tenantTrades : ['__never__'])
        .order('trade')
        .order('name'),
    ])

  // Merge assemblies + offerings into a unified Service[] for the dashboard.
  const offeringMap = new Map<string, boolean>(
    (offeringsRes.data ?? []).map((o) => [
      o.assembly_id as string,
      o.enabled as boolean,
    ]),
  )
  const sharedServices = (assembliesRes.data ?? []).map((a) => ({
    assembly_id: a.id as string,
    name: a.name as string,
    description: (a.description ?? null) as string | null,
    trade: a.trade as string,
    default_unit: (a.default_unit ?? null) as string | null,
    default_unit_price_ex_gst: a.default_unit_price_ex_gst as number | string | null,
    default_labour_hours: a.default_labour_hours as number | string | null,
    default_exclusions: (a.default_exclusions ?? null) as string | null,
    // Custom-only fields default to safe values for shared rows so the
    // unified service shape stays consistent across the API.
    is_custom: false,
    always_inspection: false,
    // Tenant's explicit toggle wins; otherwise fall back to the
    // catalogue's `default_enabled` flag. Migration 021 added that
    // column so opt-in extras (aircon, EV charger, leak detection,
    // etc.) appear OFF until the tradie ticks them, while the core
    // easy-5 assemblies stay ON for tenants who haven't seeded a
    // tenant_service_offerings row yet.
    enabled: offeringMap.has(a.id as string)
      ? (offeringMap.get(a.id as string) as boolean)
      : (a.default_enabled as boolean | null) ?? true,
  }))

  // Merge tenant_custom_assemblies into the same shape. Custom rows
  // are marked is_custom=true so the dashboard can render edit/delete
  // affordances on them. Their `enabled` lives directly on the row,
  // not in a tenant_service_offerings join.
  const customServices = (customAssembliesRes.data ?? []).map((a) => ({
    assembly_id: a.id as string,
    name: a.name as string,
    description: (a.description ?? null) as string | null,
    trade: a.trade as string,
    default_unit: (a.default_unit ?? null) as string | null,
    default_unit_price_ex_gst: a.default_unit_price_ex_gst as number | string | null,
    default_labour_hours: a.default_labour_hours as number | string | null,
    default_exclusions: (a.default_exclusions ?? null) as string | null,
    is_custom: true,
    always_inspection: (a.always_inspection as boolean | null) ?? false,
    enabled: (a.enabled as boolean | null) ?? true,
    // Migration 029 — surface the explicit grounding category so the
    // dashboard edit form can pre-fill it. null → "auto-detect from name".
    category: (a.category ?? null) as string | null,
  }))

  // Final unified list: shared first (anchors the dashboard at the
  // curated catalogue), then custom (the tradie's own additions).
  //
  // R40 — shared + custom services share one flat namespace in the dashboard
  // but live in different tables, so a tradie CAN create a custom service whose
  // name equals a DISABLED shared service (the DB unique index only guards
  // same-table dupes). Rather than reject the create after the fact (which
  // would orphan a persisted row), we surface a `name_collision` discriminator
  // on every row so the UI can badge the cross-table duplicate and the tradie
  // can rename/merge. annotateNameCollisions flags a row TRUE iff a row in the
  // OTHER table shares its normalised name within the SAME trade.
  const services = annotateNameCollisions([...sharedServices, ...customServices])

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
    /** When set, this intake came from a Vapi voice call (calls.id).
     *  Drives the voice-transcript join below. */
    call_id: string | null
  }
  let intakeMap: Record<string, IntakeJoin> = {}
  if (intakeIds.length > 0) {
    const { data: intakes } = await supabase
      .from('intakes')
      .select('id, caller, suburb, job_type, trade, customer_id, inspection_required, call_id')
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
          call_id: (i.call_id as string | null) ?? null,
        },
      ]),
    )
  }

  // Conversation transcripts — join each quote to the SMS messages
  // that produced it so the dashboard can render "what the customer
  // actually said" alongside the AI-drafted quote. Two-hop join via
  // sms_conversations.intake_id → quotes.intake_id. Capped to the last
  // 60 messages per conversation to keep the payload bounded (a typical
  // dialog finishes in <20 messages; 60 is more than enough headroom).
  type ConvoMessage = {
    direction: 'inbound' | 'outbound'
    body: string
    created_at: string
  }
  const conversationByIntake: Record<string, { conversationId: string; messages: ConvoMessage[] }> = {}
  // Customer-contact fallbacks. The send panel disables its buttons on a null
  // contact, so the payload resolves the same 4-source chain the quote viewer
  // uses (lib/quote/send-customer resolveCustomerContact): intake.caller →
  // sms_conversations.from_number → calls.caller_number → customers row.
  const convoPhoneByIntake: Record<string, string> = {}
  const callPhoneByIntake: Record<string, string> = {}
  if (intakeIds.length > 0) {
    const { data: convos } = await supabase
      .from('sms_conversations')
      .select('id, intake_id, from_number')
      .in('intake_id', intakeIds)
    const convoToIntake: Record<string, string> = {}
    const conversationIds: string[] = []
    for (const c of convos ?? []) {
      if (c.intake_id && c.id) {
        convoToIntake[c.id as string] = c.intake_id as string
        conversationIds.push(c.id as string)
        const fromNumber = ((c.from_number as string | null) ?? '').trim()
        if (fromNumber && !convoPhoneByIntake[c.intake_id as string]) {
          convoPhoneByIntake[c.intake_id as string] = fromNumber
        }
      }
    }
    if (conversationIds.length > 0) {
      const { data: msgs } = await supabase
        .from('sms_messages')
        .select('conversation_id, direction, body, created_at')
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: true })
      for (const m of msgs ?? []) {
        const intakeId = convoToIntake[m.conversation_id as string]
        if (!intakeId) continue
        const bucket = conversationByIntake[intakeId] ?? {
          conversationId: m.conversation_id as string,
          messages: [],
        }
        // Cap to last 60 per conversation — typical dialog is <20 turns
        // so this is just a safety bound for outliers / loops.
        if (bucket.messages.length < 60) {
          bucket.messages.push({
            direction: m.direction as 'inbound' | 'outbound',
            body: m.body as string,
            created_at: m.created_at as string,
          })
        }
        conversationByIntake[intakeId] = bucket
      }
    }
  }

  // Voice transcripts — for intakes that came from a Vapi call, load the
  // raw transcript blob from the calls row and parse it into the same
  // {direction, body, created_at} shape as SMS. The dashboard's existing
  // <Transcript> component then renders voice calls with chat bubbles
  // identical to SMS — visual parity, zero new client component.
  const voiceCallIds: string[] = []
  const callIdToIntakeId: Record<string, string> = {}
  for (const [intakeId, info] of Object.entries(intakeMap)) {
    if (info.call_id) {
      voiceCallIds.push(info.call_id)
      callIdToIntakeId[info.call_id] = intakeId
    }
  }
  const voiceByIntake: Record<string, ConvoMessage[]> = {}
  if (voiceCallIds.length > 0) {
    const { data: callRows } = await supabase
      .from('calls')
      .select('id, transcript, ended_at, caller_number')
      .in('id', voiceCallIds)
    for (const c of callRows ?? []) {
      const intakeId = callIdToIntakeId[c.id as string]
      if (!intakeId) continue
      const callerNumber = ((c.caller_number as string | null) ?? '').trim()
      if (callerNumber) callPhoneByIntake[intakeId] = callerNumber
      const parsed = parseVapiTranscript(
        c.transcript as string | null,
        c.ended_at as string | null,
      )
      // Same 60-turn cap as SMS conversations.
      voiceByIntake[intakeId] = parsed.slice(0, 60)
    }
  }

  // Contact fallback #4 — the linked customers row, one batched query.
  const customerContactById: Record<string, { phone: string | null; email: string | null }> = {}
  const linkedCustomerIds = Array.from(
    new Set(
      Object.values(intakeMap)
        .map((i) => i.customer_id)
        .filter((id): id is string => !!id),
    ),
  )
  if (linkedCustomerIds.length > 0) {
    // customers has phone_number (migration 008), not `phone` — the old
    // select 400'd in PostgREST and this whole fallback silently returned
    // nothing (2026-07-23 audit).
    const { data: custRows } = await supabase
      .from('customers')
      .select('id, phone_number, email')
      .in('id', linkedCustomerIds)
    for (const c of custRows ?? []) {
      customerContactById[c.id as string] = {
        phone: ((c.phone_number as string | null) ?? '').trim() || null,
        email: ((c.email as string | null) ?? '').trim() || null,
      }
    }
  }

  // Payments are tracked on quotes.paid_at (set by the Stripe webhook on
  // checkout.session.completed); the standalone payments table was dropped
  // in migration 058 because Stripe Connect Express isn't wired yet. The
  // set stays for a future Connect payments source, but deposit_paid below
  // now also reads quotes.paid_at directly — previously it was hardcoded
  // false for every quote, which made the dashboard's "Deposit paid" badge
  // (and the delete-button gate) dead code.
  const paidQuoteIds = new Set<string>()

  // Promoted roofing measurements (migration 168). /api/tenant/trade-jobs
  // drops a measurement once it becomes a quote (`.is('quote_share_token',
  // null)`) so the job doesn't render twice — but that also stripped its
  // /m/[measure_token] link, leaving a sold job with no way back to its
  // Measurement Results page. Re-attach it here through the reverse key
  // roofing_measurements.quote_share_token = quotes.share_token.
  // Best-effort: a failure means no link, never a failed response.
  // Bounded by the share tokens actually on this page (quotes are capped at
  // 100 above), so this never scans a tenant's whole measurement history and
  // can't be truncated by PostgREST's row cap.
  let measureHrefByShare: Record<string, string> = {}
  const pageShareTokens = (quotesRes.data ?? [])
    .map((q) => q.share_token as string | null)
    .filter((t): t is string => !!t)
  if (pageShareTokens.length > 0) {
    // supabase-js resolves errors into `error` rather than throwing, so this
    // is checked, not try/caught. A failure degrades to "no link" — never a
    // failed /api/tenant/me — but it gets logged rather than vanishing.
    const { data: promoted, error: promotedErr } = await supabase
      .from('roofing_measurements')
      .select('quote_share_token, measure_token')
      .eq('tenant_id', tenant.id)
      .in('quote_share_token', pageShareTokens)
    if (promotedErr) {
      console.warn(
        '[tenant/me] promoted-measurement lookup failed — quotes render without the Measurement Results link',
        promotedErr.message,
      )
    }
    measureHrefByShare = measurementHrefByShareToken(
      (promoted ?? []) as Array<{
        quote_share_token: string | null
        measure_token: string | null
      }>,
    )
  }

  const quotes = (quotesRes.data ?? []).map((q) => {
    const intake = q.intake_id ? intakeMap[q.intake_id] : null
    const callerName = intake?.caller?.name?.trim() || null
    const callerPhone = intake?.caller?.phone?.trim() || null
    const linkedCustomer = intake?.customer_id
      ? customerContactById[intake.customer_id] ?? null
      : null
    const convo = q.intake_id ? conversationByIntake[q.intake_id] : null
    const voiceMessages = q.intake_id ? voiceByIntake[q.intake_id] : null
    // Channel resolution: voice when the intake has a call_id (Vapi-
    // sourced), SMS when an sms_conversations row joins to it, otherwise
    // null (legacy pre-v6 or orphan intakes).
    const channel: 'sms' | 'voice' | null = intake?.call_id
      ? 'voice'
      : convo
        ? 'sms'
        : null
    return {
      ...q,
      customer_first_name: callerName?.split(' ')[0] ?? null,
      customer_full_name: callerName,
      customer_phone:
        callerPhone ??
        (q.intake_id ? convoPhoneByIntake[q.intake_id] ?? null : null) ??
        (q.intake_id ? callPhoneByIntake[q.intake_id] ?? null : null) ??
        linkedCustomer?.phone ??
        null,
      customer_email: (intake?.caller?.email?.trim() || null) ?? linkedCustomer?.email ?? null,
      suburb: intake?.suburb ?? null,
      job_type: intake?.job_type ?? null,
      trade: intake?.trade ?? null,
      inspection_required: intake?.inspection_required ?? null,
      deposit_paid: !!q.paid_at || paidQuoteIds.has(q.id as string),
      // Tradie-facing Measurement Results page, for roofing quotes that were
      // promoted from a saved measurement. Null for every other quote.
      measure_href: q.share_token
        ? measureHrefByShare[q.share_token as string] ?? null
        : null,
      // Channel + transcript: SMS thread for sms-sourced quotes, parsed
      // Vapi transcript for voice-sourced. Both shapes match
      // ConvoMessage[] so the dashboard renders them identically.
      channel,
      conversation_id: convo?.conversationId ?? null,
      messages: voiceMessages ?? convo?.messages ?? [],
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

  // Materials catalogue grouped by (trade, category) → unique brands.
  // The dashboard renders one dropdown per category with these brands.
  // We dedupe across SKUs so "Rheem" only appears once under hws_gas
  // even though both 170L and 250L are Rheem-branded.
  type CategoryRow = { trade: string; category: string; brands: string[] }
  const categoryMap = new Map<string, CategoryRow>()
  for (const m of materialsRes.data ?? []) {
    const trade = m.trade as string
    const category = m.category as string
    const brand = m.brand as string
    const key = `${trade}::${category}`
    const existing = categoryMap.get(key)
    if (existing) {
      if (!existing.brands.includes(brand)) existing.brands.push(brand)
    } else {
      categoryMap.set(key, { trade, category, brands: [brand] })
    }
  }
  const material_categories = Array.from(categoryMap.values())

  const material_preferences: Record<string, string> = {}
  for (const p of prefsRes.data ?? []) {
    material_preferences[p.category as string] = p.preferred_brand as string
  }

  // Never expose the tenant's Gemini file-store id to the browser (spec
  // 2026-06-19 tenant-file-store, R16 + Isolation constraint): the
  // tenant→store mapping is server-side only. Strip it from the row before
  // it goes over the wire (this route does `select('*')`).
  const { file_store_id: _omitFileStoreId, ...tenantSafe } = tenant as Record<string, unknown>

  return Response.json({
    tenant: tenantSafe,
    pricing: pricingBooks[0] ?? null,
    pricing_books: pricingBooks,
    services,
    quotes,
    licences,
    material_categories,
    material_preferences,
  })
}

// ─── PATCH /api/tenant/me ──────────────────────────────────────────
//
// UpdateSchema lives in lib/tenant/update-schema.ts so it can be
// unit-tested without importing this route (which has top-level
// Supabase side-effects). See that file for the partial-record rule
// that fixed the licences_by_trade "invalid_payload" regression on
// single-trade tenants.

export async function PATCH(req: Request) {
  // Dual-auth resolve (Clerk → clerk_user_id, else Supabase → owner_user_id).
  const resolved = await resolveTenantRequest(supabase, req, 'id, owner_user_id')
  if (!resolved) {
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

  // R36 — parse the optional per-service delta out of the RAW body (UpdateSchema
  // strips unknown keys). A present-but-malformed delta is a hard 400 so the UI
  // gets a clear signal rather than a silently-ignored toggle.
  let serviceDeltaEntries: ReturnType<typeof normalizeServiceDelta> = []
  if (
    body !== null &&
    typeof body === 'object' &&
    'service_delta' in (body as Record<string, unknown>)
  ) {
    const deltaParsed = ServiceDeltaSchema.safeParse(
      (body as Record<string, unknown>).service_delta,
    )
    if (!deltaParsed.success) {
      return Response.json(
        { error: 'invalid_payload', details: deltaParsed.error.flatten() },
        { status: 400 },
      )
    }
    serviceDeltaEntries = normalizeServiceDelta(deltaParsed.data)
  }

  // The caller's tenant, already resolved by clerk_user_id or owner_user_id.
  const tenant = resolved.tenant as { id: string; owner_user_id: string | null } | null
  if (!tenant) {
    return Response.json({ error: 'no_tenant' }, { status: 404 })
  }

  const updates = parsed.data
  const errors: string[] = []
  // R31 — a DEFINED cache-invalidation lever for the SMS dialog. The dialog
  // renders the tenant service list OUTSIDE its cached prefix and stamps it
  // with serviceListVersion() (see lib/sms/dialog.ts), so a toggle is already
  // read fresh on the next inbound. This flag additionally records an EXPLICIT
  // bump (pricing_book.overlays.service_version) whenever the service set
  // changes, so the invalidation is observable + queryable rather than relying
  // on cache TTL. Set when any service-offering or custom-service toggle is
  // written below; applied once at the end.
  let serviceSetChanged = false

  // 1. Tenant identity fields
  if (updates.tenant && Object.keys(updates.tenant).length > 0) {
    const { error } = await supabase
      .from('tenants')
      .update(updates.tenant)
      .eq('id', tenant.id)
    if (error) errors.push(`tenant: ${error.message}`)
    // RC-2 — business_name / ABN / licence / contact print in the PDF header +
    // footer (loaded live at render), but the native-trade PDFs cache on a static
    // path rev that doesn't capture them, so an identity change would keep the old
    // branding on the download/MMS. Null their pdf_path to regenerate once.
    // Over-eager (nulls on any tenant-field change) but harmless — a stale
    // regenerate is cheap and this route is cold. Electrical/plumbing branding
    // self-heal is tracked separately (needs a branding fingerprint in
    // quotePdfSignature); commercial painting re-authors its tender on save.
    else {
      for (const table of ['roofing_measurements', 'painting_measurements', 'solar_estimates']) {
        const { error: pErr } = await supabase
          .from(table)
          .update({ pdf_path: null })
          .eq('tenant_id', tenant.id)
        if (pErr) errors.push(`identity_pdf[${table}]: ${pErr.message}`)
      }
    }
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

  // 2bc. Phase A — customer-quote display preference (migration 071).
  //     Tenant-level setting fanned out to every pricing_book row this
  //     tenant owns so multi-trade tradies don't see drift between their
  //     trades. The customer-quote page + the SMS template both read
  //     from this column.
  if (updates.quote_display) {
    const { error } = await supabase
      .from('pricing_book')
      .update({ quote_display: updates.quote_display })
      .eq('tenant_id', tenant.id)
    if (error) errors.push(`quote_display: ${error.message}`)
  }

  // 2bd. Migration 078 — tradie review-before-send policy. Same fan-out
  //      pattern as quote_display. Both fields can be PATCHed
  //      independently — caller can flip just the policy, or just nudge
  //      the threshold, or both atomically.
  if (
    updates.review_policy !== undefined ||
    updates.review_threshold_inc_gst !== undefined
  ) {
    const payload: Record<string, unknown> = {}
    if (updates.review_policy !== undefined) payload.review_policy = updates.review_policy
    if (updates.review_threshold_inc_gst !== undefined) {
      payload.review_threshold_inc_gst = updates.review_threshold_inc_gst
    }
    const { error } = await supabase
      .from('pricing_book')
      .update(payload)
      .eq('tenant_id', tenant.id)
    if (error) errors.push(`review_policy: ${error.message}`)
  }

  // 2bf. Migration 079 — 2-hour customer follow-up check-in toggle.
  //      Same fan-out pattern as quote_display + review_policy.
  if (updates.followup_2h_enabled !== undefined) {
    const { error } = await supabase
      .from('pricing_book')
      .update({ followup_2h_enabled: updates.followup_2h_enabled })
      .eq('tenant_id', tenant.id)
    if (error) errors.push(`followup_2h_enabled: ${error.message}`)
  }

  // 2bg. Migration 142 — per-feature (per-trade) quote tier presentation
  //      mode. PER-ROW, NOT fanned out: each entry writes only the named
  //      trade's pricing_book row, so a tradie can run three-tier painting
  //      and single-price solar at once. The customer quote page + SMS + PDF
  //      read this column via lib/quote/tier-visibility.ts.
  // Native trades whose cached PDF ignores the tier mode (static path rev) — a
  // mode change must null their pdf_path to force a regenerate (RC-2). Solar is
  // excluded: ensureSolarQuotePdf does not gate on quote_tier_mode.
  const TIER_MODE_NATIVE_PDF_TABLES: Record<string, string> = {
    roofing: 'roofing_measurements',
    painting: 'painting_measurements',
  }
  if (updates.quote_tier_mode_by_trade) {
    for (const [trade, mode] of Object.entries(updates.quote_tier_mode_by_trade)) {
      if (!mode) continue
      const { data: modeRows, error } = await supabase
        .from('pricing_book')
        .update({ quote_tier_mode: mode })
        .eq('tenant_id', tenant.id)
        .eq('trade', trade)
        .select('id')
      if (error) errors.push(`quote_tier_mode[${trade}]: ${error.message}`)
      // Audit 2026-07-23 — a trade with NO pricing_book row (cross-trade
      // tenant, feature trade not yet seeded) matched 0 rows and this
      // route reported success while persisting nothing. Fail loudly; the
      // real fix (seeding a row at trade activation) is v9 registry work.
      else if (!modeRows || modeRows.length === 0)
        errors.push(
          `quote_tier_mode[${trade}]: no pricing_book row for this trade — mode not saved`,
        )
      // RC-2 — the native trade PDFs (roofing / painting) cache on a static
      // storage-path rev that does NOT capture the tier mode, so a mode change
      // would keep serving a Good/Better/Best PDF for a tenant who just switched
      // to single-price (or vice-versa). Null their pdf_path to force a one-time
      // regenerate on the next download/send — the same thing migration 148 did
      // by hand for roofing. Electrical/plumbing self-heal via quotePdfSignature
      // (tierMode is already folded into it), so they need no explicit null.
      const nativeTable = TIER_MODE_NATIVE_PDF_TABLES[trade]
      if (nativeTable) {
        const { error: pErr } = await supabase
          .from(nativeTable)
          .update({ pdf_path: null })
          .eq('tenant_id', tenant.id)
        if (pErr) errors.push(`quote_tier_mode_pdf[${trade}]: ${pErr.message}`)
      }
    }
  }

  // 2bb. v8 Phase A — early-booking discount config. Stored in
  //     pricing_book.overlays.early_bird jsonb (no schema migration for
  //     config). The discount is per-TENANT, so it is written uniformly
  //     to EVERY one of the tenant's pricing_book rows. Read-modify-write
  //     so any other keys already living in `overlays` are preserved.
  if (updates.early_bird) {
    const eb = {
      enabled: updates.early_bird.enabled,
      discount_pct: updates.early_bird.discount_pct,
      window_hours: updates.early_bird.window_hours,
    }
    const { data: books, error: readErr } = await supabase
      .from('pricing_book')
      .select('id, overlays')
      .eq('tenant_id', tenant.id)
    if (readErr) {
      errors.push(`early_bird: ${readErr.message}`)
    } else {
      for (const b of books ?? []) {
        const current =
          b.overlays && typeof b.overlays === 'object' && !Array.isArray(b.overlays)
            ? { ...(b.overlays as Record<string, unknown>) }
            : {}
        current.early_bird = eb
        const { error } = await supabase
          .from('pricing_book')
          .update({ overlays: current })
          .eq('id', b.id)
        if (error) errors.push(`early_bird: ${error.message}`)
      }
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

  // R36 — fold the per-service delta into the legacy full-dict maps so the
  // DB-write code below has a SINGLE path. The delta is the more targeted,
  // fresher signal, so it WINS on any key collision with a legacy dict in the
  // same request. The delta's `is_custom` flag routes each row to the right
  // table (shared → tenant_service_offerings, custom → tenant_custom_assemblies).
  const deltaPlan = buildServiceWritePlan(serviceDeltaEntries)
  const mergedServices = mergeWithLegacyDicts(
    deltaPlan,
    updates.services,
    updates.custom_services,
  )

  // 3. Service toggles — UPSERT so the same call works whether or not
  //    a tenant_service_offerings row already exists for this tradie +
  //    assembly. Catalogue-first dashboards mean the row often DOESN'T
  //    exist on the first toggle (the dashboard renders every assembly
  //    for the trade regardless of offerings rows).
  //
  //    Bulk upsert handles all changes in one round-trip via the
  //    composite (tenant_id, assembly_id) primary key. Because we upsert
  //    ONLY the keys present (delta or legacy dict), an unrelated row that a
  //    concurrent tab owns is never written — that's the R36 anti-clobber
  //    guarantee.
  if (Object.keys(mergedServices.shared).length > 0) {
    const rows = Object.entries(mergedServices.shared).map(([assembly_id, enabled]) => ({
      tenant_id: tenant.id,
      assembly_id,
      enabled,
    }))
    if (rows.length > 0) {
      const { error } = await supabase
        .from('tenant_service_offerings')
        .upsert(rows, { onConflict: 'tenant_id,assembly_id' })
      if (error) errors.push(`services: ${error.message}`)
      else serviceSetChanged = true
    }
  }

  // 3b. Custom service toggles — for tenant-owned assemblies (mig 023)
  //     the enabled flag lives directly on the row, NOT in a join
  //     table. So we UPDATE tenant_custom_assemblies for each flip. We
  //     batch by `.in('id', [...])` for ON and again for OFF so two
  //     SQL round-trips cover an arbitrary number of toggles.
  if (Object.keys(mergedServices.custom).length > 0) {
    const enableIds: string[] = []
    const disableIds: string[] = []
    for (const [id, enabled] of Object.entries(mergedServices.custom)) {
      ;(enabled ? enableIds : disableIds).push(id)
    }
    if (enableIds.length > 0) {
      const { error } = await supabase
        .from('tenant_custom_assemblies')
        .update({ enabled: true })
        .eq('tenant_id', tenant.id)
        .in('id', enableIds)
      if (error) errors.push(`custom_services (enable): ${error.message}`)
      else serviceSetChanged = true
    }
    if (disableIds.length > 0) {
      const { error } = await supabase
        .from('tenant_custom_assemblies')
        .update({ enabled: false })
        .eq('tenant_id', tenant.id)
        .in('id', disableIds)
      if (error) errors.push(`custom_services (disable): ${error.message}`)
      else serviceSetChanged = true
    }
  }

  // 4. Material preferences — upsert non-empty brand picks, delete
  //    rows the tradie cleared. A null / empty value means "no
  //    preference" and the row is removed entirely; a string value
  //    becomes the preferred brand for that category.
  if (updates.material_preferences) {
    const upserts: Array<{ tenant_id: string; category: string; preferred_brand: string }> = []
    const deletes: string[] = []
    for (const [category, brand] of Object.entries(updates.material_preferences)) {
      const trimmed = typeof brand === 'string' ? brand.trim() : ''
      if (trimmed) {
        upserts.push({ tenant_id: tenant.id, category, preferred_brand: trimmed })
      } else {
        deletes.push(category)
      }
    }
    if (upserts.length > 0) {
      const { error } = await supabase
        .from('tenant_material_preferences')
        .upsert(upserts, { onConflict: 'tenant_id,category' })
      if (error) errors.push(`material_preferences: ${error.message}`)
    }
    if (deletes.length > 0) {
      const { error } = await supabase
        .from('tenant_material_preferences')
        .delete()
        .eq('tenant_id', tenant.id)
        .in('category', deletes)
      if (error) errors.push(`material_preferences (clear): ${error.message}`)
    }
  }

  // R31 — DEFINED service-catalogue cache bump. When a service-offering or
  // custom-service toggle was written above, stamp a fresh service_version
  // into every pricing_book row's overlays jsonb (read-modify-write, mirrors
  // the early_bird pattern so any other overlay keys are preserved). This is
  // the explicit, queryable invalidation signal the SMS dialog's freshness
  // contract is built on: the dialog renders the service list outside its
  // cached prefix and version-stamps it (lib/sms/dialog.ts serviceListVersion),
  // so a toggle is reflected on the next inbound regardless — but recording
  // this bump makes the invalidation observable rather than relying on cache
  // TTL. Best-effort: a failure here must not fail an otherwise-successful
  // toggle PATCH, so it is logged, not pushed to `errors`.
  if (serviceSetChanged) {
    const stamp = newServiceVersionStamp()
    const { data: books, error: readErr } = await supabase
      .from('pricing_book')
      .select('id, overlays')
      .eq('tenant_id', tenant.id)
    if (readErr) {
      console.warn('[tenant/me] service_version bump skipped — overlays read failed', readErr.message)
    } else {
      for (const b of books ?? []) {
        const next = withServiceVersion(b.overlays, stamp)
        const { error } = await supabase
          .from('pricing_book')
          .update({ overlays: next })
          .eq('id', b.id)
        if (error) {
          console.warn('[tenant/me] service_version bump write failed (non-fatal)', error.message)
        }
      }
    }
  }

  if (errors.length > 0) {
    return Response.json({ ok: false, errors }, { status: 500 })
  }
  return Response.json({ ok: true })
}

/** R31 — a fresh, monotonic-ish service-catalogue version stamp. Wall-clock
 *  ms is enough: a toggle PATCH always lands after the prior one, and the
 *  value only needs to CHANGE on each write so a cache-keyed consumer can
 *  tell "the service set moved". Exported for the route-level test. */
export function newServiceVersionStamp(): string {
  return `v${Date.now()}`
}

/** R31 — pure read-modify-write of a pricing_book.overlays jsonb value that
 *  sets `service_version` while preserving every other overlay key (e.g.
 *  early_bird). Defensive against a null / non-object / array overlays value.
 *  Exported so the bump is unit-testable without the route's Supabase
 *  side-effects. */
export function withServiceVersion(
  overlays: unknown,
  stamp: string,
): Record<string, unknown> {
  const base =
    overlays && typeof overlays === 'object' && !Array.isArray(overlays)
      ? { ...(overlays as Record<string, unknown>) }
      : {}
  base.service_version = stamp
  return base
}

/** Coerce "" / undefined → null. Used when persisting optional text
 *  fields so the DB column stays clean instead of storing empty strings. */
function emptyToNull(v: string | undefined): string | null {
  if (v === undefined || v === null) return null
  const trimmed = String(v).trim()
  return trimmed === '' ? null : trimmed
}
