// /api/onboard/activate — final step of the tradie onboarding wizard.
//
// What it does (atomic-ish, with manual rollback on partial failure):
//   1. Validate payload via Zod (includes optional intent_token for SMS flow)
//   2. Insert tenants row (status='onboarding')
//   3. Insert pricing_book row tied to that tenant
//   4. Insert tenant_service_offerings (auto-enable the easy-5 for their trade)
//   5. Run the provisioning chain via runProvisioning():
//        a. Twilio number purchase (stub if TWILIO_PROVISIONING_ENABLED!=true)
//        b. Vapi assistant create  (stub if VAPI_PROVISIONING_ENABLED!=true)
//        c. Bind the Twilio number to the assistant (Vapi /phone-number)
//        d. UPDATE tenants → status='active', stamp provisioned IDs
//        e. Welcome SMS from the new number to the owner's mobile
//   6. SMS-only: markIntentUsed() — only fires when intent_token is present.
//
// On any non-recoverable failure the tenant row + pricing book still
// exist. The client can call POST /api/onboard/retry-provision to
// re-run step 5 against the existing tenant without rebuilding it.

import { createClient } from '@supabase/supabase-js'
import { OnboardActivateSchema, defaultsForTrade } from '@/lib/onboard/schema'
import { runProvisioning } from '@/lib/onboard/run-provisioning'
import { markIntentUsed } from '@/lib/onboard/intent-tokens'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(req: Request) {
  let tenantId: string | null = null
  try {
    const raw = await req.json()
    const parsed = OnboardActivateSchema.safeParse(raw)
    if (!parsed.success) {
      return Response.json(
        {
          ok: false,
          error: 'validation_failed',
          fieldErrors: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      )
    }
    const form = parsed.data
    const normalisedMobile = normaliseAuMobile(form.owner_mobile)
    // Primary trade — used to populate the legacy `tenants.trade` scalar
    // column for back-compat, to seed the Vapi assistant prompt, and as
    // the first row inserted into pricing_book. Multi-trade tenants get
    // additional pricing_book rows for each extra trade further down.
    const primaryTrade = form.trades[0]

    // Resolve owner_user_id authoritatively. The wizard CAN drop this
    // value if URL params got lost or the Supabase session backfill
    // didn't fire — and a NULL owner_user_id means the tradie can never
    // sign back in (signin / /api/tenant/me both look up by user_id).
    // Fall back to admin email lookup when the form didn't send one.
    let resolvedOwnerUserId: string | null = form.owner_user_id || null
    if (!resolvedOwnerUserId) {
      const looked = await lookupUserIdByEmail(form.owner_email)
      if (looked) {
        resolvedOwnerUserId = looked
        console.log('[activate] owner_user_id missing in payload — resolved from email', {
          email: form.owner_email,
          userId: looked,
        })
      } else {
        console.warn('[activate] owner_user_id missing AND no auth user matches email', {
          email: form.owner_email,
        })
      }
    }

    // ─── 1. Insert tenants row ─────────────────────────────────
    // Note: `trade` (singular) is kept in sync with trades[0] so legacy
    // pipeline code that still reads tenant.trade keeps working.
    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .insert({
        owner_user_id: resolvedOwnerUserId,
        business_name: form.business_name,
        owner_first_name: form.owner_first_name,
        owner_last_name: form.owner_last_name || null,
        owner_email: form.owner_email.toLowerCase(),
        owner_mobile: normalisedMobile,
        trade: primaryTrade,
        trades: form.trades,
        state: form.state,
        abn: form.abn || null,
        licence_type: form.licence_type || null,
        licence_number: form.licence_number || null,
        licence_expiry: form.licence_expiry || null,
        status: 'onboarding',
      })
      .select('id')
      .single()

    if (tErr || !tenant) {
      const errMsg = tErr?.message ?? 'tenant insert failed'
      const friendly = errMsg.toLowerCase().includes('owner_email')
        ? 'An account with that email already exists. Sign in instead.'
        : errMsg
      return Response.json({ ok: false, error: friendly }, { status: 400 })
    }
    const id: string = tenant.id
    tenantId = id

    // ─── 2. Insert pricing_book row(s) ────────────────────────
    // One row per selected trade. The wizard collects a single shared
    // set of rates (hourly_rate, call_out_minimum, default_markup_pct)
    // — multi-trade tradies usually price labour the same across their
    // trades. They can split rates later from the dashboard Pricing tab
    // by editing each pricing_book individually.
    const pricingRows = form.trades.map((t) => {
      const d = defaultsForTrade(t)
      return {
        tenant_id: id,
        trade: t,
        hourly_rate: form.hourly_rate,
        call_out_minimum: form.call_out_minimum,
        default_markup_pct: form.default_markup_pct,
        apprentice_rate: form.apprentice_rate ?? d.apprentice_rate,
        senior_rate: form.senior_rate ?? d.senior_rate,
        after_hours_multiplier: form.after_hours_multiplier ?? d.after_hours_multiplier,
        min_labour_hours: form.min_labour_hours ?? d.min_labour_hours,
        risk_buffer_pct: form.risk_buffer_pct ?? d.risk_buffer_pct,
        gst_registered: form.gst_registered ?? true,
        licence_type: form.licence_type || null,
        licence_number: form.licence_number || null,
        licence_state: form.state,
        licence_expiry: form.licence_expiry || null,
      }
    })
    const { error: pbErr } = await supabase.from('pricing_book').insert(pricingRows)

    if (pbErr) {
      // Roll back the tenant row so a retry doesn't trip the unique email constraint.
      await supabase.from('tenants').delete().eq('id', id)
      return Response.json(
        { ok: false, error: `pricing_book insert failed: ${pbErr.message}` },
        { status: 500 },
      )
    }

    // ─── 2b. Seed tenant_licences (per-trade licence rows) ────────
    // Wizard only collects ONE licence triple in v1, so we copy it to
    // each selected trade. Tradies who hold a different regulator for
    // each trade can refine these per-trade later from the dashboard
    // Account tab. Empty licence fields (the common case in the test
    // phase) still create the row so the dashboard form has a stable
    // shape — every selected trade is guaranteed a tenant_licences row.
    const licenceRows = form.trades.map((t) => ({
      tenant_id: id,
      trade: t,
      licence_type: form.licence_type || null,
      licence_number: form.licence_number || null,
      licence_state: form.state || null,
      licence_expiry: form.licence_expiry || null,
    }))
    const { error: licErr } = await supabase
      .from('tenant_licences')
      .upsert(licenceRows, { onConflict: 'tenant_id,trade' })
    if (licErr) {
      // Non-fatal — primary licence still lives on tenants.licence_*.
      // The dashboard will show the legacy single-licence view until
      // tenant_licences is reachable.
      console.warn('[activate] tenant_licences seed failed (non-fatal)', {
        tenantId: id,
        message: licErr.message,
      })
    }

    // ─── 3. Seed service offerings for ALL selected trades ─────────
    // Core easy-5 assemblies (default_enabled = true in shared_assemblies)
    // land enabled so a newly-onboarded tradie sees their wedge live
    // immediately. Opt-in extras (default_enabled = false — aircon,
    // EV charger, leak detection, etc. from migration 021) land
    // disabled; the tradie ticks them on from the Services tab if
    // they perform that work.
    const { data: assemblies } = await supabase
      .from('shared_assemblies')
      .select('id, default_enabled')
      .in('trade', form.trades)

    if (assemblies && assemblies.length > 0) {
      const rows = assemblies.map((a) => ({
        tenant_id: id,
        assembly_id: a.id,
        enabled: (a as { default_enabled: boolean | null }).default_enabled ?? true,
      }))
      await supabase.from('tenant_service_offerings').upsert(rows, {
        onConflict: 'tenant_id,assembly_id',
      })
    }

    // ─── 4. Mark SMS signup intent as used (SMS-only step) ───────
    // Done before provisioning so a Twilio failure doesn't strand the
    // intent in unused state.
    if (form.intent_token) {
      try {
        const marked = await markIntentUsed(supabase, {
          token: form.intent_token,
          tenantId: id,
        })
        if (!marked.ok) {
          console.warn(
            '[activate] markIntentUsed returned ok=false (token already consumed or missing)',
            { tenantId: id, token: form.intent_token },
          )
        }
      } catch (e: any) {
        console.warn('[activate] markIntentUsed threw — non-fatal', {
          tenantId: id,
          message: e?.message ?? String(e),
        })
      }
    }

    // ─── 5. Provisioning chain ───────────────────────────────────
    // Vapi assistant prompt is built from the full trades[] list so a
    // multi-trade tenant's receptionist greets callers about both
    // services.
    const result = await runProvisioning(supabase, {
      tenantId: id,
      businessName: form.business_name,
      trade: primaryTrade,
      trades: form.trades,
      ownerFirstName: form.owner_first_name,
      ownerMobile: normalisedMobile,
    })

    if (!result.ok) {
      // Tenant + pricing rows still exist. Client should redirect to the
      // dashboard which surfaces a Retry provisioning button.
      return Response.json(
        {
          ok: true,
          tenantId: id,
          phoneNumber: result.phoneNumber,
          vapiAssistantId: result.vapiAssistantId,
          warning: `${result.error}. Retry from the dashboard.`,
          retryable: true,
        },
        { status: 200 },
      )
    }

    return Response.json({
      ok: true,
      tenantId: id,
      phoneNumber: result.phoneNumber,
      stubbed: result.stubbedTwilio,
      stubbedVapi: result.stubbedVapi,
      welcomeSent:
        result.welcome?.ok === true &&
        !('stubbed' in result.welcome && result.welcome.stubbed),
      warning: result.warning,
    })
  } catch (err: any) {
    // Catch-all rollback if we created a tenant but threw afterwards.
    if (tenantId) {
      try {
        await supabase.from('tenants').delete().eq('id', tenantId)
      } catch {
        // best-effort
      }
    }
    return Response.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 },
    )
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Normalise AU mobiles to E.164: 0412345678 → +61412345678. Idempotent. */
function normaliseAuMobile(input: string): string {
  const stripped = input.replace(/\s+/g, '')
  if (stripped.startsWith('+61')) return stripped
  if (stripped.startsWith('61')) return `+${stripped}`
  if (stripped.startsWith('04')) return `+61${stripped.slice(1)}`
  if (stripped.startsWith('4')) return `+61${stripped}`
  return stripped // fall through — Zod already validated shape
}

/**
 * Resolve a Supabase auth user_id from an email via the admin listUsers
 * API. Used as a fallback when the wizard didn't send owner_user_id, so
 * the tenant row always lands with a valid user link. Returns null when
 * no auth.users row matches (legitimate for SMS-only signups that never
 * created a Supabase auth user yet).
 */
async function lookupUserIdByEmail(email: string): Promise<string | null> {
  const target = email.trim().toLowerCase()
  try {
    // listUsers is paginated; tradie volume during pilot is tiny so a
    // single page is plenty. If we ever grow past ~1000 active auth users
    // this needs to switch to admin.getUserByEmail (Supabase v2.40+).
    const { data, error } = await supabase.auth.admin.listUsers({ perPage: 200 })
    if (error) {
      console.warn('[activate] admin.listUsers failed', error.message)
      return null
    }
    const match = data.users.find(
      (u) => (u.email ?? '').trim().toLowerCase() === target,
    )
    return match?.id ?? null
  } catch (e: any) {
    console.warn('[activate] lookupUserIdByEmail threw', e?.message ?? String(e))
    return null
  }
}
