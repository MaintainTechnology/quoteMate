// ════════════════════════════════════════════════════════════════════
// Solar — release side-effects + the auto-release decision.
//
// "Release" = stamp solar_estimates.confirmed_at (which canShowPrices() +
// solarPayRedirectTarget() unlock against) and fire the customer-facing
// side-effects: the customer quote SMS+PDF, the Pylon CRM lead, and the
// OpenSolar lead. Two callers share this module:
//   • the manual POST /api/solar/confirm/[token] route (tradie clicks
//     "Confirm & release") — still the path for a flagged estimate that
//     was re-drafted clean; and
//   • the estimate-creation route's after(), which auto-releases a CLEAN
//     estimate so the tradie no longer has to click confirm (Path B —
//     solar joins the SMS/electrical auto-send model, docs/strategy.md
//     v10 2026-06-16).
//
// A FLAGGED estimate (guardrail_flags non-empty) is never auto-released:
// the publish gate hides prices on a flagged row regardless of
// confirmed_at, so auto-sending one would text the customer a price-less
// link. Those stay forced human-in-loop until re-drafted clean.
//
// Every side-effect is best-effort and never throws — a release must not
// depend on Twilio/Pylon/OpenSolar being up.
// ════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureSolarQuotePdf, solarQuotePdfUrl, signQuotePdfUrl } from '@/lib/quote/pdf'
import { dispatchQuoteWithPdf } from '@/lib/sms/send-quote-pdf'
import { buildSolarCustomerSms } from '@/lib/solar/notify'
import { pylonLeadPushEnabled, pushPylonOpportunity } from '@/lib/pylon/client'
import { pushSolarLeadToOpenSolar } from '@/lib/solar/opensolar-leadpush'
import type { SolarEstimate } from '@/lib/solar/types'

export type ConfirmEligibilityInput = {
  guardrailFlags: string[]
  alreadyConfirmedAt: string | null
}

export type ConfirmEligibilityResult =
  | { ok: true; stamp: boolean }
  | { ok: false; status: number; error: string }

/**
 * PURE — decide whether this estimate may be confirmed/released.
 *  • guardrail flags present → 409, cannot confirm
 *  • already confirmed       → ok, stamp:false (idempotent no-op)
 *  • clean + unconfirmed     → ok, stamp:true
 */
export function confirmEligibility(
  input: ConfirmEligibilityInput,
): ConfirmEligibilityResult {
  if (input.guardrailFlags.length > 0) {
    return {
      ok: false,
      status: 409,
      error:
        'This estimate has open checks (guardrail flags). Adjust the tiers and re-draft before confirming.',
    }
  }
  if (input.alreadyConfirmedAt) return { ok: true, stamp: false }
  return { ok: true, stamp: true }
}

/**
 * PURE — is auto-release (Path B) on? Defaults ON; an admin can revert to
 * the forced-confirm gate without a deploy by setting SOLAR_AUTO_RELEASE
 * to 'false' or '0' (mirrors sunAssetsEnabled's kill-switch shape).
 */
export function solarAutoReleaseEnabled(_env: {
  SOLAR_AUTO_RELEASE?: string
  [key: string]: string | undefined
}): boolean {
  // Human approval is a policy gate, not an environment-variable override.
  return false
}

export type SolarReleaseRow = {
  tenantId: string | null
  publicToken: string
  intakeId: string | null
  routing: string | null
  address: string | null
  state: string | null
  postcode: string | null
}

/**
 * Best-effort customer quote SMS on release. Reads the optional customer
 * mobile from intake.caller (captured at estimate time); when present and
 * the estimate is priced (not inspection-routed), generates the solar PDF
 * and texts the durable quote + PDF link with a best-effort MMS. Never
 * throws — a release must not depend on the customer SMS.
 */
export async function sendCustomerSolarQuote(
  supabase: SupabaseClient,
  row: {
    tenantId: string | null
    publicToken: string
    intakeId: string | null
    routing: string | null
  },
): Promise<void> {
  try {
    if (row.routing === 'inspection_required') return
    if (!row.intakeId) return

    const { data: intake } = await supabase
      .from('intakes')
      .select('caller')
      .eq('id', row.intakeId)
      .maybeSingle()
    const caller = (intake?.caller as { name?: string; phone?: string } | null) ?? null
    const phone = caller?.phone?.trim()
    if (!phone) return

    const { data: est } = await supabase
      .from('solar_estimates')
      .select('estimate')
      .eq('public_token', row.publicToken)
      .maybeSingle()
    const estimate = (est?.estimate as SolarEstimate | null) ?? null
    if (!estimate) return
    // Headline = largest tier (last), matching the share-page hero.
    const headline = estimate.price.tiers[estimate.price.tiers.length - 1]

    const { data: tenant } = await supabase
      .from('tenants')
      .select('business_name, twilio_sms_number')
      .eq('id', row.tenantId)
      .maybeSingle()
    const businessName = (tenant?.business_name as string | null) ?? 'Your installer'

    const appUrl = (process.env.APP_URL ?? 'https://www.quotemax.com.au').replace(/\/$/, '')
    const pdfPath = await ensureSolarQuotePdf(row.publicToken)
    const body = buildSolarCustomerSms({
      businessName,
      customerName: caller?.name || null,
      systemKw: headline?.system_kw_dc ?? 0,
      netIncGst: headline?.net_inc_gst ?? 0,
      quoteUrl: `${appUrl}/q/solar/${row.publicToken}`,
      pdfUrl: pdfPath ? solarQuotePdfUrl(row.publicToken) : null,
    })
    await dispatchQuoteWithPdf({
      to: phone,
      text: body,
      from: (tenant?.twilio_sms_number as string | null) ?? process.env.TWILIO_SMS_NUMBER,
      pdfPath,
      signMediaUrl: signQuotePdfUrl,
    })
  } catch (e) {
    console.error(
      '[solar/release] customer quote send failed (non-fatal)',
      e instanceof Error ? e.message : e,
    )
  }
}

/**
 * Best-effort Pylon CRM lead push on release (premium quote §4.5).
 * Gated by PYLON_ENABLED + PYLON_API_KEY + the PYLON_LEAD_PUSH_TENANTS
 * allowlist. On success the created opportunity's id + in-app URL are
 * stamped into estimate.context.pylon_opportunity so the dashboard can
 * read the lead's pipeline stage back. Logged, never throws — the
 * release flow must be bit-identical when Pylon is off.
 */
export async function pushSolarLeadToPylon(
  supabase: SupabaseClient,
  row: {
    tenantId: string | null
    publicToken: string
    intakeId: string | null
    address: string | null
    state: string | null
    postcode: string | null
  },
): Promise<void> {
  try {
    if (
      !pylonLeadPushEnabled(
        {
          PYLON_ENABLED: process.env.PYLON_ENABLED,
          PYLON_API_KEY: process.env.PYLON_API_KEY,
          PYLON_LEAD_PUSH_TENANTS: process.env.PYLON_LEAD_PUSH_TENANTS,
        },
        row.tenantId,
      )
    ) {
      return
    }

    let caller: { name?: string; phone?: string; email?: string } | null = null
    if (row.intakeId) {
      const { data: intake } = await supabase
        .from('intakes')
        .select('caller')
        .eq('id', row.intakeId)
        .maybeSingle()
      caller = (intake?.caller as { name?: string; phone?: string; email?: string } | null) ?? null
    }

    const { data: est } = await supabase
      .from('solar_estimates')
      .select('estimate')
      .eq('public_token', row.publicToken)
      .maybeSingle()
    const estimate = (est?.estimate as SolarEstimate | null) ?? null
    const headline = estimate
      ? estimate.price.tiers[estimate.price.tiers.length - 1] ?? null
      : null

    const result = await pushPylonOpportunity({
      name: caller?.name?.trim() || 'QuoteMax solar lead',
      phone: caller?.phone?.trim() || null,
      email: caller?.email?.trim() || null,
      address: row.address,
      state: row.state,
      postcode: row.postcode,
      title: headline ? `${headline.system_kw_dc} kW solar — QuoteMax` : 'QuoteMax solar estimate',
      summary: headline
        ? `${headline.system_kw_dc} kW solar — confirmed QuoteMax estimate ($${Math.round(headline.net_inc_gst).toLocaleString('en-AU')} net inc GST)`
        : 'Confirmed QuoteMax solar estimate',
      valueDollars: headline?.net_inc_gst ?? null,
      sourceLinkedId: row.publicToken,
    })
    if (!result.ok) {
      console.warn(`[solar/release] Pylon lead push skipped (${result.code}): ${result.detail}`)
      return
    }

    // Stamp the opportunity onto the estimate so the dashboard can show
    // the lead's live Pylon pipeline stage. Best-effort.
    if (result.data.id && estimate) {
      const updated: SolarEstimate = {
        ...estimate,
        context: {
          ...estimate.context,
          pylon_opportunity: {
            id: result.data.id,
            in_app_url: result.data.in_app_url,
            pushed_at: new Date().toISOString(),
          },
        },
      }
      const { error: updErr } = await supabase
        .from('solar_estimates')
        .update({ estimate: updated })
        .eq('public_token', row.publicToken)
      if (updErr) {
        console.warn('[solar/release] pylon_opportunity stamp failed', updErr.message)
      }
    }
  } catch (e) {
    console.warn(
      '[solar/release] Pylon lead push failed (non-fatal)',
      e instanceof Error ? e.message : e,
    )
  }
}

/**
 * Run the three customer-facing release side-effects (quote SMS, Pylon
 * lead, OpenSolar lead). Each is independent + best-effort; the customer
 * SMS is awaited so a release reliably texts the quote, the CRM pushes are
 * awaited too but already swallow their own failures.
 */
export async function runSolarReleaseSideEffects(
  supabase: SupabaseClient,
  row: SolarReleaseRow,
): Promise<void> {
  await sendCustomerSolarQuote(supabase, {
    tenantId: row.tenantId,
    publicToken: row.publicToken,
    intakeId: row.intakeId,
    routing: row.routing,
  })
  await pushSolarLeadToPylon(supabase, {
    tenantId: row.tenantId,
    publicToken: row.publicToken,
    intakeId: row.intakeId,
    address: row.address,
    state: row.state,
    postcode: row.postcode,
  })
  await pushSolarLeadToOpenSolar(supabase, {
    tenantId: row.tenantId,
    publicToken: row.publicToken,
    intakeId: row.intakeId,
    address: row.address,
    state: row.state,
    postcode: row.postcode,
  })
}

/**
 * Auto-release a CLEAN solar estimate (Path B). Runs inside the
 * estimate-creation route's after(), AFTER the deferred enrichment (Pylon
 * cross-check may have just appended a guardrail flag, sun-assets the
 * heatmap). Re-reads the row, re-checks eligibility on the freshly-read
 * guardrail_flags + confirmed_at, stamps confirmed_at, then fires the
 * release side-effects. Never throws. Returns whether it released so the
 * caller can word the tradie notification (released vs review-needed).
 */
export async function autoReleaseSolarEstimate(
  supabase: SupabaseClient,
  args: { token: string },
): Promise<{ released: boolean }> {
  if (!solarAutoReleaseEnabled(process.env)) return { released: false }
  try {
    const { data: row } = await supabase
      .from('solar_estimates')
      .select(
        'id, tenant_id, public_token, intake_id, routing, address, state, postcode, confirmed_at, guardrail_flags',
      )
      .eq('public_token', args.token)
      .maybeSingle()
    if (!row) return { released: false }

    const eligibility = confirmEligibility({
      guardrailFlags: (row.guardrail_flags as string[] | null) ?? [],
      alreadyConfirmedAt: (row.confirmed_at as string | null) ?? null,
    })
    // Flagged → leave for tradie review. Already confirmed → nothing to do.
    if (!eligibility.ok || !eligibility.stamp) return { released: false }

    const confirmedAt = new Date().toISOString()
    const { error: updErr } = await supabase
      .from('solar_estimates')
      .update({ confirmed_at: confirmedAt })
      .eq('id', row.id as string)
    if (updErr) {
      console.warn('[solar/auto-release] confirmed_at stamp failed (non-fatal)', updErr.message)
      return { released: false }
    }

    await runSolarReleaseSideEffects(supabase, {
      tenantId: (row.tenant_id as string | null) ?? null,
      publicToken: row.public_token as string,
      intakeId: (row.intake_id as string | null) ?? null,
      routing: (row.routing as string | null) ?? null,
      address: (row.address as string | null) ?? null,
      state: (row.state as string | null) ?? null,
      postcode: (row.postcode as string | null) ?? null,
    })
    return { released: true }
  } catch (e) {
    console.error(
      '[solar/auto-release] failed (non-fatal)',
      e instanceof Error ? e.message : e,
    )
    return { released: false }
  }
}
