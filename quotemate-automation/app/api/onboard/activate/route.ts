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
    const defaults = defaultsForTrade(form.trade)
    const normalisedMobile = normaliseAuMobile(form.owner_mobile)

    // ─── 1. Insert tenants row ─────────────────────────────────
    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .insert({
        owner_user_id: form.owner_user_id || null,
        business_name: form.business_name,
        owner_first_name: form.owner_first_name,
        owner_last_name: form.owner_last_name || null,
        owner_email: form.owner_email.toLowerCase(),
        owner_mobile: normalisedMobile,
        trade: form.trade,
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

    // ─── 2. Insert pricing_book row ───────────────────────────
    const { error: pbErr } = await supabase.from('pricing_book').insert({
      tenant_id: id,
      trade: form.trade,
      hourly_rate: form.hourly_rate,
      call_out_minimum: form.call_out_minimum,
      default_markup_pct: form.default_markup_pct,
      apprentice_rate: form.apprentice_rate ?? defaults.apprentice_rate,
      senior_rate: form.senior_rate ?? defaults.senior_rate,
      after_hours_multiplier: form.after_hours_multiplier ?? defaults.after_hours_multiplier,
      min_labour_hours: form.min_labour_hours ?? defaults.min_labour_hours,
      risk_buffer_pct: form.risk_buffer_pct ?? defaults.risk_buffer_pct,
      gst_registered: form.gst_registered ?? true,
      licence_type: form.licence_type || null,
      licence_number: form.licence_number || null,
      licence_state: form.state,
      licence_expiry: form.licence_expiry || null,
    })

    if (pbErr) {
      // Roll back the tenant row so a retry doesn't trip the unique email constraint.
      await supabase.from('tenants').delete().eq('id', id)
      return Response.json(
        { ok: false, error: `pricing_book insert failed: ${pbErr.message}` },
        { status: 500 },
      )
    }

    // ─── 3. Auto-enable the trade's easy-5 services ──────────
    const { data: assemblies } = await supabase
      .from('shared_assemblies')
      .select('id')
      .eq('trade', form.trade)

    if (assemblies && assemblies.length > 0) {
      const rows = assemblies.map((a) => ({
        tenant_id: id,
        assembly_id: a.id,
        enabled: true,
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
    const result = await runProvisioning(supabase, {
      tenantId: id,
      businessName: form.business_name,
      trade: form.trade,
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
