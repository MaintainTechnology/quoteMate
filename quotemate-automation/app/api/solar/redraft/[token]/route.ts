// ════════════════════════════════════════════════════════════════════
// POST /api/solar/redraft/[token] — re-run the deterministic engine over
// an UNRELEASED solar estimate, in place.
//
// This is the action behind the dashboard's "adjust the numbers and
// re-draft" message: after the underlying data is corrected (rate card,
// STC zone table, config version), re-drafting re-prices the same row
// with the SAME public_token (the customer link never changes) and
// re-evaluates every guardrail. Flags that the data fix resolved clear;
// flags that persist keep blocking the confirm gate.
//
// Released (confirmed) estimates 409 — re-pricing under a customer who
// already saw the figures is not allowed; create a new estimate instead.
//
// Bearer auth — same trust model as POST /api/solar/confirm/[token].
// Next 16: params is a Promise; heavy Pylon cross-check runs in after().
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { runSolarEstimate } from '@/lib/solar/intake'
import { loadSolarConfig } from '@/lib/solar/config'
import { depositPctFromOverlay, loadSolarTenantRates } from '@/lib/solar/rate-card-overlay'
import { geocodeAddress } from '@/lib/solar/geocode'
import { validateSolarAddress } from '@/lib/solar/address-validation'
import { fetchSolarDataLayers } from '@/lib/solar/data-layers'
import { applySolarSunAssets } from '@/lib/solar/sun-assets'
import { applySolarFeltMap } from '@/lib/solar/felt-provision'
import { applySolarAiBrief } from '@/lib/solar/ai-brief'
import { resolveNetworkFromPostcode } from '@/lib/solar/network-lookup'
import { redraftEligibility, reconstructSolarInputs } from '@/lib/solar/redraft'
import { MAX_REQUESTED_SYSTEM_KW } from '@/lib/solar/limits'
import { applyPylonStcCrossCheck } from '@/lib/solar/pylon-aftercheck'
import { applyOpenSolarSupplement } from '@/lib/solar/opensolar-supplement'
import { buildSolarRowPayloads } from '@/lib/solar/persist-helpers'
import type { SolarEstimate } from '@/lib/solar/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return Response.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  }

  // Dual-auth (Clerk↔Supabase) — same trust model as POST /api/solar/confirm.
  const supabase = getSupabase()
  const auth = await resolveTenantRequest(supabase, req, 'id')
  const tenantId = auth?.tenant?.id
  if (typeof tenantId !== 'string') {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // Optional tradie overrides (design 2026-06-16). A plain re-draft sends no
  // body; an override sends { phase?, desired_kw? }. Invalid/empty → no override.
  const overrides: { phase?: 'single' | 'three'; desired_kw?: number | null } = {}
  try {
    const raw = (await req.json()) as Record<string, unknown> | null
    if (raw && typeof raw === 'object') {
      if (raw.phase === 'single' || raw.phase === 'three') overrides.phase = raw.phase
      if (raw.desired_kw === null) overrides.desired_kw = null
      else if (
        typeof raw.desired_kw === 'number' &&
        raw.desired_kw > 0 &&
        raw.desired_kw <= MAX_REQUESTED_SYSTEM_KW
      )
        overrides.desired_kw = raw.desired_kw
    }
  } catch {
    // No body / invalid JSON → plain re-draft, unchanged behaviour.
  }

  const { data: row, error } = await supabase
    .from('solar_estimates')
    .select('*')
    .eq('public_token', token)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (error) return Response.json({ ok: false, error: 'quote_unavailable' }, { status: 503 })
  if (!row) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  if (row.paid_at) return Response.json({ ok: false, error: 'paid_quote_locked' }, { status: 409 })
  const eligibility = redraftEligibility({
    confirmedAt: (row.confirmed_at as string | null) ?? null,
  })
  if (!eligibility.ok) {
    return Response.json(
      { ok: false, error: eligibility.error },
      { status: eligibility.status },
    )
  }

  const previous = (row.estimate as SolarEstimate | null) ?? null
  if (!previous) {
    return Response.json(
      { ok: false, error: 'estimate_missing — this row predates the engine jsonb; re-draft is unavailable.' },
      { status: 422 },
    )
  }

  const inputs = reconstructSolarInputs({
    row: {
      address: (row.address as string | null) ?? null,
      state: (row.state as string | null) ?? null,
      postcode: (row.postcode as string | null) ?? null,
    },
    estimate: previous,
    overrides,
  })
  if (!inputs) {
    return Response.json(
      { ok: false, error: 'inputs_unreconstructable — the saved row lacks an address/state/postcode.' },
      { status: 422 },
    )
  }

  // Re-run the engine with the current config — identical wiring to the
  // estimate creation route, so a re-draft prices exactly like a fresh
  // submission of the same details (including the tenant's rate card).
  const baseConfig = await loadSolarConfig(supabase)
  const { config, rateCard, overlay } = await loadSolarTenantRates(
    supabase,
    (row.tenant_id as string | null) ?? null,
    baseConfig,
  )
  let redrafted: SolarEstimate
  try {
    const result = await runSolarEstimate({
      input: inputs.input,
      manual: inputs.manual,
      panelType: inputs.panelType,
      quarterlyBillAud: inputs.quarterlyBillAud,
      // Carry the prior estimate's phase + preferred size so a re-draft keeps
      // the same export ceiling + tier anchor (reconstructed from context).
      phase: inputs.phase,
      requestedSizeKw: inputs.requestedSizeKw,
      config,
      rateCard,
      opts: {
        geocode: async (input) => {
          const r = await geocodeAddress(input.address + ', ' + input.state, {
            apiKey: process.env.GOOGLE_GEOCODE_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY,
          })
          if (!r.ok) throw new Error(r.detail)
          return r.location
        },
        addressValidation: async (input) =>
          validateSolarAddress(input, {
            apiKey:
              process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY ??
              process.env.GOOGLE_MAPS_API_KEY,
          }),
        dataLayers: async (location) =>
          fetchSolarDataLayers(location, {
            apiKey: process.env.GOOGLE_SOLAR_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY,
          }),
        network: resolveNetworkFromPostcode(inputs.input.postcode),
      },
    })
    // KEEP the existing public token — the customer link must not change.
    redrafted = { ...result, token: row.public_token as string }
  } catch (e) {
    return Response.json(
      { ok: false, error: 'engine_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }

  // Shape the refreshed engine output with the same payload builder the
  // creation route uses, then strip insert-only identity fields.
  const quoteVariant: 'instant' | 'felt' =
    row.quote_variant === 'felt' ? 'felt' : 'instant'
  const payloads = buildSolarRowPayloads({
    estimate: redrafted,
    tenantId: (row.tenant_id as string | null) ?? '',
    address: inputs.input,
    // Keep the row's variant — a re-draft must never flip a Felt quote
    // back to the instant layout (Felt tab spec 2026-06-13 §4.5).
    quoteVariant,
    // Tenant deposit % from the solar rate card (null → keep stored/default).
    depositPct: depositPctFromOverlay(overlay),
  })
  const estimateUpdate = Object.fromEntries(Object.entries(payloads.solarEstimate).filter(([key]) => !['tenant_id','public_token','address','state','postcode'].includes(key)))

  // The RPC locks both saved records, checks the exact previously read snapshot
  // and approval/payment state, then refreshes both prices in one transaction.
  // A concurrent owner approval wins without a late redraft changing its prices.
  const quoteUpdate = Object.fromEntries(Object.entries(payloads.quote).filter(([key]) => !['tenant_id','status','share_token'].includes(key)))
  const { data: saved, error: updErr } = await supabase.rpc('sms_redraft_solar_owned', {
    p_tenant_id: tenantId, p_id: row.id, p_expected: row,
    p_changes: { ...estimateUpdate, pdf_path: null, panels_image_status: 'idle', panels_image_path: null },
    p_quote_changes: quoteUpdate,
  })
  if (updErr || !saved) {
    return Response.json({ ok: false, error: 'quote_changed_or_unavailable',
      detail: 'The quote changed while re-drafting. Reload it before trying again.' }, { status: 409 })
  }

  // Re-run the Pylon STC cross-check against the new numbers (spec §4.5
  // "and on re-draft"). After the response; never blocks.
  after(() => applyPylonStcCrossCheck(supabase, redrafted, (row.tenant_id as string | null) ?? null))

  // Re-run the OpenSolar supplements (hardware + pricing cross-check)
  // against the fresh numbers too — same after() semantics.
  after(() => applyOpenSolarSupplement(supabase, redrafted))

  // Regenerate the sun & shade assets against the fresh estimate (the
  // redraft wiped context.sun with the rest of the jsonb). Google path
  // only; best-effort.
  if (redrafted.coverage_source === 'google' && redrafted.context.location) {
    const location = redrafted.context.location
    after(() => applySolarSunAssets(supabase, { publicToken: row.public_token as string, location }))
  }

  // Re-provision the Felt map against the fresh layout (the panel
  // placements/sizing may have changed). applySolarFeltMap deletes the
  // previous map first; best-effort, felt-variant rows only.
  if (quoteVariant === 'felt') {
    const feltLocation = redrafted.context.location ?? null
    after(() =>
      applySolarFeltMap(supabase, {
        publicToken: row.public_token as string,
        location: feltLocation,
      }),
    )
    // Regenerate the AI brief — the facts hash changed with the layout,
    // and applySolarAiBrief skips itself when it didn't. Best-effort.
    after(() => applySolarAiBrief(supabase, { publicToken: row.public_token as string }))
  }

  return Response.json({
    ok: true,
    token: redrafted.token,
    guardrail_flags: redrafted.guardrail_flags,
    routing: redrafted.routing.decision,
    config_version: redrafted.config_version,
  })
}
