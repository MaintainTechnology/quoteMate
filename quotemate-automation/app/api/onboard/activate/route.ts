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

import { after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { OnboardActivateSchema } from '@/lib/onboard/schema'
import { buildPricingRows } from '@/lib/onboard/pricing-rows'
import { defaultAvailabilityForState } from '@/lib/quote/availability'
import { runProvisioning } from '@/lib/onboard/run-provisioning'
import { inspectIntentToken, markIntentUsed } from '@/lib/onboard/intent-tokens'
import { seedTenantServiceOfferings } from '@/lib/onboard/seed-tenant-defaults'
import { checkInvitationCode, consumeInvitationCode } from '@/lib/onboard/invitation-codes'
import { stampFeatureProvenance } from '@/lib/features/access'
import { computePreflight } from '@/lib/onboard/preflight-logic'
import { ensureClerkUser } from '@/lib/clerk/ensure-user'
import { autoGenerateTrustVideos } from '@/lib/videos/trust-video'
import { resolveIdentityRequest } from '@/lib/tenant/from-request'
import { deriveActivationOwnership } from '@/lib/onboard/activation-identity'
import { readProvisioningStatus } from '@/lib/onboard/provisioning-status'

// Deferred trust-video generation polls Veo after the response; a platform
// cut-off mid-poll is harmless (resumable) but headroom lets most finish here.
export const maxDuration = 300

// A step result in the activation chain — collected so the response (and the
// /admin tenant-health view) can show exactly what succeeded vs failed,
// instead of swallowing failures silently. (spec A1)
type StepResult = { step: string; ok: boolean; detail?: string }

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(req: Request) {
  let tenantId: string | null = null
  const steps: StepResult[] = []
  try {
    // This is a public-facing mutation backed by a service-role client. The
    // bearer is therefore the first gate: no payload parsing, invitation
    // lookup, or service-role write happens until its signature is verified.
    const identity = await resolveIdentityRequest(supabase, req)
    if (!identity) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    }

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

    // Older clients still send identity fields. Treat them only as assertions
    // for a compatible rollout; the verified bearer subject is the value that
    // selects and is written as the tenant owner.
    const ownership = deriveActivationOwnership(identity, form)
    if (!ownership.ok) {
      return Response.json(
        {
          ok: false,
          error: 'identity_mismatch',
          fieldErrors: { [ownership.field]: [ownership.message] },
          message: ownership.message,
        },
        { status: 403 },
      )
    }
    const resolvedOwnerUserId = ownership.ownerUserId
    const resolvedClerkUserId = ownership.clerkUserId

    // Idempotent retry: an activation already owned by this authenticated
    // subject is the same activation, never permission to insert another
    // tenant or buy another number. This also makes a lost HTTP response safe.
    const existing = await findExistingActivation(identity.provider, identity.userId)
    if (existing.error) {
      return Response.json(
        { ok: false, error: `tenant lookup failed: ${existing.error}` },
        { status: 500 },
      )
    }
    if (existing.tenant) return existingActivationResponse(existing.tenant)

    // Mobile is optional (user clarification 2026-07-17): null when the
    // tradie onboarded without one — the welcome SMS is skipped downstream.
    let normalisedMobile = form.owner_mobile ? normaliseAuMobile(form.owner_mobile) : null
    // Primary trade — used to populate the legacy `tenants.trade` scalar
    // column for back-compat, to seed the Vapi assistant prompt, and as
    // the first row inserted into pricing_book. Multi-trade tenants get
    // additional pricing_book rows for each extra trade further down.
    const primaryTrade = form.trades[0]

    // An SMS intent adds verified-phone context; it is never authentication.
    // Bearer auth already succeeded above, and the server-side row must also be
    // unused + unexpired before it can be linked. If a mobile was supplied it
    // must agree with the verified SMS source; otherwise use that source.
    if (form.intent_token) {
      const inspected = await inspectIntentToken(supabase, form.intent_token)
      if (inspected.status === 'unavailable') {
        return Response.json(
          {
            ok: false,
            error: 'intent_unavailable',
            message: 'Could not verify that SMS signup link just now. Try again.',
          },
          { status: 503 },
        )
      }
      if (inspected.status !== 'verified') {
        return Response.json(
          {
            ok: false,
            error: `intent_${inspected.status}`,
            message:
              inspected.status === 'expired'
                ? 'That SMS signup link has expired.'
                : inspected.status === 'used'
                  ? 'That SMS signup link was already used.'
                  : 'That SMS signup link is invalid.',
          },
          { status: 422 },
        )
      }
      const intent = inspected.intent
      const intentMobile = normaliseAuMobile(intent.owner_mobile)
      if (normalisedMobile && normalisedMobile !== intentMobile) {
        return Response.json(
          {
            ok: false,
            error: 'intent_mobile_mismatch',
            message: 'The mobile number does not match the verified SMS signup link.',
          },
          { status: 403 },
        )
      }
      normalisedMobile = intentMobile
    }

    // Re-validate the invitation code at the last moment. Cheap insurance
    // against a code that was revoked or exhausted between Step-0 and submit.
    const codeCheck = await checkInvitationCode(supabase, form.invitation_code)
    if (!codeCheck.ok) {
      return Response.json(
        { ok: false, error: codeCheck.error, message: codeCheck.message },
        { status: 422 },
      )
    }

    // ─── 1. Insert tenants row ─────────────────────────────────
    // Note: `trade` (singular) is kept in sync with trades[0] so legacy
    // pipeline code that still reads tenant.trade keeps working.
    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .insert({
        owner_user_id: resolvedOwnerUserId,
        // Both ownership columns are derived from the verified bearer above.
        // Payload ids never select the owner of a service-role insert.
        clerk_user_id: resolvedClerkUserId,
        business_name: form.business_name,
        owner_first_name: form.owner_first_name,
        owner_last_name: form.owner_last_name || null,
        owner_email: form.owner_email.toLowerCase(),
        owner_mobile: normalisedMobile,
        trade: primaryTrade,
        trades: form.trades,
        state: form.state || null,
        abn: form.abn || null,
        licence_type: form.licence_type || null,
        licence_number: form.licence_number || null,
        licence_expiry: form.licence_expiry || null,
        // ── Brand / identity (migration 141) — surfaced on the quote letterhead ──
        contact_name: form.contact_name || null,
        website_url: form.website_url || null,
        business_address: form.business_address || null,
        logo_url: form.logo_url || null,
        logo_path: form.logo_path || null,
        // Default schedule availability (mig 147). Use the tradie's chosen
        // hours from the wizard, else a state-derived default so every new
        // tenant is immediately bookable.
        default_availability:
          form.default_availability ?? defaultAvailabilityForState(form.state || null),
        status: 'onboarding',
      })
      .select('id')
      .single()

    if (tErr || !tenant) {
      const errMsg = tErr?.message ?? 'tenant insert failed'
      // Two requests can pass the pre-insert lookup together. The unique
      // owner constraint decides the race; return the row owned by this same
      // verified subject rather than surfacing an error or inserting again.
      if (tErr && isUniqueViolation(tErr)) {
        const raced = await findExistingActivation(identity.provider, identity.userId)
        if (raced.tenant) return existingActivationResponse(raced.tenant)
      }
      const friendly = errMsg.toLowerCase().includes('owner_email')
        ? 'An account with that email already exists. Sign in instead.'
        : errMsg
      return Response.json({ ok: false, error: friendly }, { status: 400 })
    }
    const id: string = tenant.id
    tenantId = id
    steps.push({ step: 'tenant', ok: true })

    // ─── 2. Insert pricing_book row(s) ────────────────────────
    // One row per selected trade — construction lives in
    // lib/onboard/pricing-rows.ts (pure, unit-tested) because overlay
    // placement is subtle: painting's rate card rides its own trade row,
    // but the roofing rate card must ride the PRIMARY trade's row (the
    // row loadRoofingOverlay + the dashboard Roof-rates editor resolve).
    const pricingRows = buildPricingRows(form, id)
    const { error: pbErr } = await supabase.from('pricing_book').insert(pricingRows)

    if (pbErr) {
      // Roll back the tenant row so a retry doesn't trip the unique email constraint.
      await supabase.from('tenants').delete().eq('id', id)
      return Response.json(
        { ok: false, error: `pricing_book insert failed: ${pbErr.message}` },
        { status: 500 },
      )
    }
    steps.push({ step: 'pricing_book', ok: true })

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
    steps.push({ step: 'licences', ok: !licErr, detail: licErr?.message })

    // ─── 3. Seed service offerings for ALL selected trades ─────────
    // v7 Phase 1: the seed logic is shared with the backfill script via
    // seedTenantServiceOfferings() so a backfilled tenant lands with
    // identical defaults to a fresh activate. The helper preserves the
    // pre-v7 semantics (default_enabled per assembly, fallback to true).
    // A1: service offerings is a REQUIRED step — a tenant must never go live
    // with an empty service catalogue. Retry once on a transient failure; if
    // it still fails, stop BEFORE provisioning so the tenant stays in
    // 'onboarding' (clearly Incomplete) for repair, rather than going active
    // half-configured. The seed is idempotent (upsert on tenant+assembly).
    let offeringsSeeded = false
    let offeringsErr: string | undefined
    for (let attempt = 1; attempt <= 2 && !offeringsSeeded; attempt++) {
      try {
        await seedTenantServiceOfferings({ supabase, tenantId: id, trades: form.trades })
        offeringsSeeded = true
      } catch (seedErr: unknown) {
        offeringsErr = errorDetail(seedErr)
        console.warn(`[activate] seedTenantServiceOfferings attempt ${attempt} failed`, {
          tenantId: id,
          message: offeringsErr,
        })
      }
    }
    steps.push({ step: 'service_offerings', ok: offeringsSeeded, detail: offeringsErr })
    if (!offeringsSeeded) {
      // Required step failed — leave the tenant Incomplete (status stays
      // 'onboarding', provisioning not run). Repair re-seeds via
      // scripts/verify-tenant.mjs --apply or /admin/tenants.
      return Response.json(
        {
          ok: true,
          tenantId: id,
          setupComplete: false,
          steps,
          warning: `Service catalogue seed failed: ${offeringsErr}. Tenant left incomplete — repair from /admin/tenants.`,
          retryable: true,
        },
        { status: 200 },
      )
    }

    // ─── 3b. Stamp feature provenance (migration 138) ──────────────
    // The tenant's selected trades become 'onboarding'-sourced grants so a
    // later plan downgrade never strips the trade they signed up with. trades[]
    // itself was set on the tenants insert above; this only records provenance.
    // Non-fatal: wrapped so a provenance failure never rolls back the tenant.
    let provenanceOk = true
    let provenanceErr: string | undefined
    try {
      await stampFeatureProvenance(supabase, {
        tenantId: id,
        features: form.trades,
        source: 'onboarding',
      })
    } catch (e: unknown) {
      provenanceOk = false
      provenanceErr = errorDetail(e)
      console.warn('[activate] stampFeatureProvenance failed (non-fatal)', {
        tenantId: id,
        message: provenanceErr,
      })
    }
    steps.push({ step: 'feature_provenance', ok: provenanceOk, detail: provenanceErr })

    // ─── 3c. Ensure a Clerk user + link it to the tenant ───────────
    // The web funnel (/signup) creates a SUPABASE auth user only, so without
    // this every web-onboarded tenant landed with clerk_user_id = NULL and never
    // appeared in Clerk — it had to be backfilled by hand with
    // scripts/link-accounts-clerk.ts. A Clerk-native signup is already linked
    // by the verified bearer subject stamped on the insert above, so we skip it.
    // Non-fatal by design: a Clerk outage must never roll back a tenant that is
    // otherwise complete — the backfill script remains the repair path.
    let clerkOk = true
    let clerkDetail: string | undefined
    if (!resolvedClerkUserId) {
      try {
        // Admin status is keyed off admin_users (the DB source of truth), the
        // same rule the backfill script applies. A fresh signup is never admin,
        // but check anyway so an admin onboarding lands with the right flag.
        let isAdmin = false
        if (resolvedOwnerUserId) {
          const { data: adminRow } = await supabase
            .from('admin_users')
            .select('user_id')
            .eq('user_id', resolvedOwnerUserId)
            .maybeSingle()
          isAdmin = !!adminRow
        }
        const ensured = await ensureClerkUser({
          email: form.owner_email,
          seed: resolvedOwnerUserId ?? id,
          isAdmin,
        })
        if (!ensured) {
          clerkDetail = 'CLERK_SECRET_KEY unset — skipped'
        } else {
          await supabase.from('tenants').update({ clerk_user_id: ensured.id }).eq('id', id)
          clerkDetail = ensured.created ? 'clerk user created' : 'linked to existing clerk user'
        }
      } catch (e: unknown) {
        clerkOk = false
        clerkDetail = errorDetail(e)
        console.warn('[activate] ensureClerkUser failed (non-fatal)', {
          tenantId: id,
          message: clerkDetail,
        })
      }
    } else {
      clerkDetail = 'clerk-native signup — already linked'
    }
    steps.push({ step: 'clerk_link', ok: clerkOk, detail: clerkDetail })

    // ─── Consume the invitation code (idempotent, once per tenant) ──
    // Done after the tenant row exists so the redemption ledger has a
    // valid FK. If quota was exhausted by a concurrent signup, roll the
    // tenant back and surface the friendly error.
    const consumed = await consumeInvitationCode(supabase, {
      codeId: codeCheck.code_id,
      tenantId: id,
      channel: form.intent_token ? 'sms' : 'web',
    })
    if (!consumed.ok) {
      await supabase.from('pricing_book').delete().eq('tenant_id', id)
      await supabase.from('tenants').delete().eq('id', id)
      tenantId = null
      return Response.json(
        { ok: false, error: consumed.error, message: consumed.message },
        { status: 422 },
      )
    }

    // ─── 4. Mark SMS signup intent as used (SMS-only step) ───────
    // Done before provisioning so a Twilio failure doesn't strand the
    // intent in unused state.
    if (form.intent_token) {
      let marked: Awaited<ReturnType<typeof markIntentUsed>> | null = null
      try {
        marked = await markIntentUsed(supabase, {
          token: form.intent_token,
          tenantId: id,
        })
      } catch {
        // Handled by the required-step failure below.
      }
      if (!marked?.ok) {
        // The intent was valid at preflight but another activation consumed it
        // first (or the claim write failed). Do not leave a second tenant.
        await supabase.from('pricing_book').delete().eq('tenant_id', id)
        await supabase.from('tenants').delete().eq('id', id)
        tenantId = null
        return Response.json(
          {
            ok: false,
            error: 'intent_used',
            message: 'That SMS signup link was already used. Sign in to continue.',
          },
          { status: 422 },
        )
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

    // Provisioning mode (live vs stub) — surfaced on every response so the
    // caller/admin can never mistake a stub tenant for production-ready.
    const { summary } = computePreflight(process.env)
    const provisioningMode = { twilio: summary.twilio_mode, vapi: summary.vapi_mode }

    // Trust videos (spec tradie-trust-video-generation R5): kick AI generation
    // of the welcome + thank-you videos in the deferred block — activation
    // response time is unaffected, and a serverless timeout mid-poll is
    // harmless (the operation is persisted and GET /api/tenant/videos resumes
    // it). Runs on both the success and retry-provisioning paths; the tenant
    // row exists either way and the guard inside is idempotent.
    after(() => autoGenerateTrustVideos(supabase, id))

    if (!result.ok) {
      // Tenant + pricing rows still exist. Client should redirect to the
      // dashboard which surfaces a Retry provisioning button.
      steps.push({ step: 'provisioning', ok: false, detail: result.error })
      return Response.json(
        {
          ok: true,
          tenantId: id,
          setupComplete: false,
          provisioningMode,
          steps,
          phoneNumber: result.phoneNumber,
          vapiAssistantId: result.vapiAssistantId,
          phoneReadiness: result.phoneReadiness,
          warning: result.error ?? result.phoneReadiness?.message,
          retryable: result.phoneReadiness?.retryable === true,
        },
        { status: 200 },
      )
    }

    // A2: never report success with stub artifacts. A stub number/assistant
    // means provisioning ran in stub mode (flag off) and the tenant cannot
    // receive real calls/SMS — so setupComplete is false even though the row
    // is technically 'active'. A non-fatal warning (registration / SMS
    // webhook reclaim failed) also blocks setupComplete because those are
    // required for the line to actually work. The /admin tenant-health view
    // + banner make any such gap visible so no stub tenant looks ready.
    const stubbed = result.stubbedTwilio || result.stubbedVapi
    const setupComplete = result.phoneReadiness?.setupComplete === true
    steps.push({
      step: 'provisioning',
      ok: setupComplete,
      detail: stubbed ? 'stub mode' : result.warning,
    })

    return Response.json({
      ok: true,
      tenantId: id,
      setupComplete,
      provisioningMode,
      steps,
      phoneNumber: result.phoneNumber,
      phoneReadiness: result.phoneReadiness,
      vapiAssistantId: result.vapiAssistantId,
      stubbed: result.stubbedTwilio,
      stubbedVapi: result.stubbedVapi,
      welcomeSent:
        result.welcome?.ok === true &&
        !('stubbed' in result.welcome && result.welcome.stubbed),
      warning:
        result.warning ??
        (stubbed
          ? 'Provisioning ran in STUB mode — this tenant has no real phone line. Enable live provisioning (TWILIO/VAPI_PROVISIONING_ENABLED) and retry.'
          : undefined),
    })
  } catch (err: unknown) {
    // Catch-all rollback if we created a tenant but threw afterwards.
    if (tenantId) {
      try {
        await supabase.from('tenants').delete().eq('id', tenantId)
      } catch {
        // best-effort
      }
    }
    return Response.json(
      { ok: false, error: errorDetail(err) },
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

type ExistingActivation = {
  id: string
  status: string | null
  twilio_sms_number: string | null
  vapi_assistant_id: string | null
  twilio_voice_number: string | null
  twilio_number_sid: string | null
}

async function findExistingActivation(provider: 'clerk' | 'supabase', userId: string) {
  const column = provider === 'clerk' ? 'clerk_user_id' : 'owner_user_id'
  const { data, error } = await supabase
    .from('tenants')
    .select('id, status, twilio_sms_number, twilio_voice_number, twilio_number_sid, vapi_assistant_id')
    .eq(column, userId)
    .maybeSingle()
  return {
    tenant: (data as ExistingActivation | null) ?? null,
    error: error?.message ?? null,
  }
}

async function existingActivationResponse(tenant: ExistingActivation) {
  const phoneReadiness = await readProvisioningStatus(supabase,tenant).catch(()=>undefined)
  const setupComplete = phoneReadiness?.setupComplete === true
  return Response.json({
    ok: true,
    tenantId: tenant.id,
    setupComplete,
    phoneReadiness,
    provisioningMode: phoneReadiness?.provisioningMode,
    phoneNumber: tenant.twilio_sms_number,
    vapiAssistantId: tenant.vapi_assistant_id,
    alreadyActivated: true,
    idempotent: true,
    retryable: phoneReadiness?.retryable === true,
    warning: setupComplete
      ? undefined
      : phoneReadiness?.message ?? 'Account created. Phone setup status is unavailable; check status before retrying.',
  })
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' || /duplicate key|unique constraint/i.test(error.message ?? '')
}
