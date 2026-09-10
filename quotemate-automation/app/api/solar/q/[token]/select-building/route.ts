// ════════════════════════════════════════════════════════════════════
// POST /api/solar/q/[token]/select-building — switch which building on the
// property this solar estimate is for (multi-roof picker, approach A).
//
// The row is the PROPERTY record: `buildings` lists every detected
// structure and `selected_building_id` points at the one the headline
// `estimate` jsonb reflects. Selecting a different building re-runs the
// deterministic engine for THAT building's footprint centroid (skipping
// geocode/address-validation via opts.targetLocation) and RE-POINTS the
// row at the new estimate — same public_token, so the customer link is
// stable (mirrors redraft). Each building's full estimate is cached in
// solar_building_cache so switching back is instant (no Google re-fetch).
//
// Gating (selectBuildingEligibility): a switch is allowed only while the
// estimate is UNRELEASED (confirmed_at IS NULL) — a released quote must not
// be re-pointed under the customer's feet; the tradie creates a NEW
// estimate to quote a different building.
//
// PUBLIC, share-token-gated (the token is the capability — mirrors the
// other /q/[token] routes). Money path unchanged: the engine + cache are
// the only price source; this route only re-points WHICH building.
//
// Next 16: params is a Promise (awaited); force-dynamic; the heavy heatmap
// regen runs in after() so the response is fast (the row's estimate is
// updated synchronously before responding).
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { z } from 'zod'
import { runSolarEstimate } from '@/lib/solar/intake'
import { loadSolarConfig } from '@/lib/solar/config'
import { depositPctFromOverlay, loadSolarRateOverlay, loadSolarTenantRates } from '@/lib/solar/rate-card-overlay'
import { geocodeAddress } from '@/lib/solar/geocode'
import { fetchSolarDataLayers } from '@/lib/solar/data-layers'
import { applySolarSunAssets } from '@/lib/solar/sun-assets'
import { resolveNetworkFromPostcode } from '@/lib/solar/network-lookup'
import { reconstructSolarInputs } from '@/lib/solar/redraft'
import { buildSolarRowPayloads } from '@/lib/solar/persist-helpers'
import {
  selectBuildingEligibility,
  findBuilding,
  updateBuildingStatus,
} from '@/lib/solar/building-cache'
import { polygonCentroid } from '@/lib/solar/buildings'
import { resolveSolarQuoteView } from '@/lib/solar/quote-page-row'
import type { DetectedBuilding, SolarEstimate } from '@/lib/solar/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

// Synthetic id for a free-clicked roof Geoscape never outlined. The custom
// building is recomputed on every click (the point moves), so it is never
// cache-read — only optionally cache-written.
const CUSTOM_BUILDING_ID = 'custom'

const SelectBuildingSchema = z
  .object({
    building_id: z.string().min(1).optional(),
    centroid: z
      .object({
        lat: z.number().gte(-90).lte(90),
        lng: z.number().gte(-180).lte(180),
      })
      .optional(),
  })
  .refine((d) => d.building_id || d.centroid, 'building_id or centroid required')

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return Response.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = SelectBuildingSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }
  // A free-click `centroid` (a roof Geoscape never outlined) wins over a
  // detected `building_id` when both are sent — the explicit point is the
  // most specific intent.
  const isCustom = !!parsed.data.centroid

  const supabase = getSupabase()
  const { data: row, error } = await supabase
    .from('solar_estimates')
    .select('*')
    .eq('public_token', token)
    .maybeSingle()
  if (error) return Response.json({ ok: false, error: 'quote_unavailable' }, { status: 503 })
  if (!row) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  if (row.paid_at) return Response.json({ ok: false, error: 'paid_quote_locked' }, { status: 409 })

  const persistedBuildings = normalisePersistedBuildingCentroids(
    (row.buildings as DetectedBuilding[] | null) ?? [],
  )

  // ── Working set + target differ by path. ─────────────────────────────
  // Detected: the persisted list; target = the matched building.
  // Custom (free-click): a synthetic 'custom' building at the clicked point,
  // replacing any prior custom entry in the working list.
  let buildingId: string
  let buildings: DetectedBuilding[]
  let target: DetectedBuilding
  if (isCustom) {
    buildingId = CUSTOM_BUILDING_ID
    const custom: DetectedBuilding = {
      building_id: CUSTOM_BUILDING_ID,
      role: 'secondary',
      label: 'Selected roof',
      centroid: parsed.data.centroid!,
      footprint: null,
      area_m2: null,
      roof_shape: null,
      storeys: null,
      solar_status: 'pending',
    }
    buildings = [
      ...persistedBuildings.filter((b) => b.building_id !== CUSTOM_BUILDING_ID),
      custom,
    ]
    target = custom
  } else {
    buildingId = parsed.data.building_id!
    buildings = persistedBuildings
    const found = findBuilding(buildings, buildingId)
    if (!found) {
      return Response.json(
        { ok: false, error: 'No such building on this property.' },
        { status: 404 },
      )
    }
    target = found
  }

  // ── Eligibility: building must exist + estimate must be unreleased. The
  //    custom path always "exists" (we just synthesised it) — the gate then
  //    only enforces the released-lock (409). ──────────────────────────
  const eligibility = selectBuildingEligibility({
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    buildingExists: true,
  })
  if (!eligibility.ok) {
    return Response.json(
      { ok: false, error: eligibility.error },
      { status: eligibility.status },
    )
  }

  // ── No-op: already pointed at this DETECTED building. Return the current
  //    view. Never short-circuits the custom path — the clicked point moves
  //    each time, so it must always recompute. ──────────────────────────
  if (
    !isCustom &&
    buildingId === ((row.selected_building_id as string | null) ?? null) &&
    estimateLocationMatchesTarget(row.estimate as SolarEstimate | null, target.centroid)
  ) {
    const current = (row.estimate as SolarEstimate | null) ?? null
    return Response.json({
      ok: true,
      changed: false,
      selected_building_id: buildingId,
      view: current
        ? resolveSolarQuoteView({
            estimate: current,
            confirmedAt: (row.confirmed_at as string | null) ?? null,
          })
        : null,
    })
  }

  // ── Reconstruct the engine inputs from the persisted row + estimate
  //    (same address; the engine re-fetches the roof at the building's
  //    centroid). Needed both for a cache miss AND to refresh the row.
  const previous = (row.estimate as SolarEstimate | null) ?? null
  if (!previous) {
    return Response.json(
      { ok: false, error: 'estimate_missing — this row predates the engine jsonb; building switch is unavailable.' },
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
  })
  if (!inputs) {
    return Response.json(
      { ok: false, error: 'inputs_unreconstructable — the saved row lacks an address/state/postcode.' },
      { status: 422 },
    )
  }

  // ── CACHE HIT: a previously-computed estimate for this building. SKIPPED
  //    for the custom path — the free-clicked point changes every click, so a
  //    cached 'custom' estimate would be for a different roof. ────────────
  let computed: SolarEstimate | null = null
  if (!isCustom) {
    const { data: cached } = await supabase
      .from('solar_building_cache')
      .select('estimate')
      .eq('estimate_id', row.id)
      .eq('building_id', buildingId)
      .maybeSingle()
    if (cached?.estimate) {
      const cachedEstimate = cached.estimate as SolarEstimate
      if (estimateLocationMatchesTarget(cachedEstimate, target.centroid)) {
        computed = cachedEstimate
      }
    }
  }

  // ── CACHE MISS: run the engine at the building's centroid. Identical
  //    wiring to the redraft route, plus opts.targetLocation so the
  //    coverage gate / Solar API / dataLayers use this building's point
  //    rather than re-geocoding the address.
  if (!computed) {
    const baseConfig = await loadSolarConfig(supabase)
    const { config, rateCard } = await loadSolarTenantRates(
      supabase,
      (row.tenant_id as string | null) ?? null,
      baseConfig,
    )
    try {
      const result = await runSolarEstimate({
        input: inputs.input,
        manual: inputs.manual,
        panelType: inputs.panelType,
        quarterlyBillAud: inputs.quarterlyBillAud,
        // Carry the prior estimate's phase + preferred size so switching the
        // building keeps the same export ceiling + tier anchor.
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
          dataLayers: async (location) =>
            fetchSolarDataLayers(location, {
              apiKey: process.env.GOOGLE_SOLAR_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY,
            }),
          network: resolveNetworkFromPostcode(inputs.input.postcode),
          // Multi-roof: estimate THIS building, not the address's findClosest.
          targetLocation: target.centroid,
        },
      })
      // KEEP the existing public token — the customer link must not change.
      computed = { ...result, token: row.public_token as string }
    } catch (e) {
      return Response.json(
        { ok: false, error: 'engine_failed', detail: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      )
    }

    // Cache the per-building estimate (instant switch-back).
    const { error: cacheErr } = await supabase
      .from('solar_building_cache')
      .upsert(
        {
          estimate_id: row.id,
          building_id: buildingId,
          estimate: computed,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'estimate_id,building_id' },
      )
    if (cacheErr) {
      console.warn('[solar/select-building] cache upsert failed (non-fatal)', cacheErr.message)
    }
  }

  // ── NO-COVERAGE: Google Solar has no imagery for this building (manual/
  //    empty path). Do NOT repoint the row — mark the building no_coverage
  //    so the picker can grey it out, persist only the buildings list, and
  //    422. The customer keeps seeing the previously-selected building.
  if (computed.coverage_source !== 'google') {
    const noCoverage = updateBuildingStatus(buildings, buildingId, 'no_coverage')
    const { error: updateError } = await supabase.rpc('sms_redraft_solar_owned', {
      p_tenant_id: row.tenant_id, p_id: row.id, p_expected: row,
      p_changes: { buildings: noCoverage }, p_quote_changes: {},
    })
    if (updateError) return Response.json({ ok: false, error: 'quote_changed',
      detail: 'This quote changed. Reload it before choosing another building.' }, { status: 409 })
    return Response.json(
      {
        ok: false,
        code: 'no_coverage',
        error: 'No solar imagery is available for that building.',
      },
      { status: 422 },
    )
  }

  // ── SUCCESS: repoint the row at this building. Re-shape the engine
  //    output with the same payload builder the creation/redraft routes use,
  //    then strip insert-only identity fields (same as redraft).
  const quoteVariant: 'instant' | 'felt' =
    row.quote_variant === 'felt' ? 'felt' : 'instant'
  const nextBuildings = updateBuildingStatus(buildings, buildingId, 'ready')
  // Tenant deposit % — loaded here (not only on the cache-miss branch) so a
  // cache-hit building switch stamps the same deposit as a fresh compute.
  const depositOverlay = await loadSolarRateOverlay(
    supabase,
    (row.tenant_id as string | null) ?? null,
  )
  const payloads = buildSolarRowPayloads({
    estimate: computed,
    tenantId: (row.tenant_id as string | null) ?? '',
    address: inputs.input,
    quoteVariant,
    buildings: nextBuildings,
    selectedBuildingId: buildingId,
    depositPct: depositPctFromOverlay(depositOverlay),
  })
  const estimateUpdate = omitKeys(payloads.solarEstimate, [
    'tenant_id',
    'public_token',
    'address',
    'state',
    'postcode',
  ] as const)

  const quoteUpdate = omitKeys(payloads.quote, ['tenant_id', 'status', 'share_token'] as const)
  // The customer may choose a building while the quote is held. Commit only
  // if the exact saved snapshot is still unapproved and unpaid; the same row
  // lock is used by owner approval, with both pricing records saved together.
  const { data: saved, error: updErr } = await supabase.rpc('sms_redraft_solar_owned', {
    p_tenant_id: row.tenant_id, p_id: row.id, p_expected: row,
    p_changes: { ...estimateUpdate, pdf_path: null, panels_image_status: 'idle', panels_image_path: null },
    p_quote_changes: quoteUpdate,
  })
  if (updErr || !saved) return Response.json({ ok: false, error: 'quote_changed_or_unavailable',
    detail: 'This quote changed. Reload it before choosing another building.' }, { status: 409 })

  // Regenerate the sun & shade assets against the newly-selected building's
  // estimate (the repoint replaced context.sun). Namespaced per building so
  // each keeps its own cached heatmap PNG. Google path only; best-effort,
  // after the response so the switch is fast.
  if (computed.coverage_source === 'google' && computed.context.location) {
    const location = computed.context.location
    after(() =>
      applySolarSunAssets(
        supabase,
        { publicToken: row.public_token as string, location },
        { buildingId },
      ),
    )
  }

  const view = resolveSolarQuoteView({
    estimate: computed,
    confirmedAt: (row.confirmed_at as string | null) ?? null,
  })
  return Response.json({
    ok: true,
    changed: true,
    selected_building_id: buildingId,
    view,
  })
}

function normalisePersistedBuildingCentroids(
  buildings: DetectedBuilding[],
): DetectedBuilding[] {
  return buildings.map((building) => {
    const centroid = building.footprint ? polygonCentroid(building.footprint) : null
    return centroid ? { ...building, centroid } : building
  })
}

function estimateLocationMatchesTarget(
  estimate: SolarEstimate | null,
  target: { lat: number; lng: number },
): boolean {
  const location = estimate?.context.location
  if (!location) return false
  return distanceMeters(location, target) <= 2
}

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const radiusM = 6_371_000
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLng = (b.lng - a.lng) * toRad
  const lat1 = a.lat * toRad
  const lat2 = b.lat * toRad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * radiusM * Math.asin(Math.sqrt(h))
}

function omitKeys<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Omit<T, K> {
  const copy: Partial<T> = { ...obj }
  for (const key of keys) delete copy[key]
  return copy as Omit<T, K>
}
