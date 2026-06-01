// ════════════════════════════════════════════════════════════════════
// Roofing — pure pricing logic.
//
// $/m² × sloped area × loadings → tier prices + routing decision.
//
// The roofing trade does NOT use the strict-grounding estimator. The
// rationale (docs/strategy.md v10):
//   • Roofers price per sloped square metre operationally; line-item
//     granularity is unnecessary.
//   • Deterministic calc → no Opus on the money path → no grounding
//     validator needed → cheaper, faster, more predictable.
//   • Tier framing maps 1:1 onto the three operational scopes:
//     Good = patch / spot repair, Better = re-roof same material,
//     Best = upgrade to a better material.
//
// PURE — no I/O. Fully unit-testable.
// ════════════════════════════════════════════════════════════════════

import type {
  MultiRoofQuote,
  PitchBucket,
  RoofForm,
  RoofJobIntent,
  RoofMaterial,
  RoofMetrics,
  RoofStructurePrice,
  RoofStructureRole,
  RoofUserInputs,
  RoofingPriceTier,
  RoofingQuotePrice,
  RoofingRateCard,
  RoofingRoutingDecision,
} from './types'

// ── Pitch corrections ───────────────────────────────────────────────
// Footprint × correction = sloped area. Per the standard residential
// pitch ranges in AU practice. unknown/very_steep cases route to
// inspection rather than guessing.
const PITCH_CORRECTION: Record<PitchBucket, number | null> = {
  shallow: 1.06, //   < 20°  (typical ~15°)
  standard: 1.10, // 20–25°  (the AU residential default ~22.5°)
  steep: 1.18, //   26–35°  (typical ~30°)
  very_steep: null, // route to inspection
  unknown: null,
}

/** PURE — sloped area in m² given footprint + customer pitch declaration. */
export function slopedAreaFromFootprint(
  footprint_m2: number,
  pitch: PitchBucket,
): number | null {
  if (!Number.isFinite(footprint_m2) || footprint_m2 <= 0) return null
  const c = PITCH_CORRECTION[pitch]
  if (c === null || c === undefined) return null
  return roundTo(footprint_m2 * c, 1)
}

/** PURE — true when this combination should never be auto-quoted. */
export function requiresInspection(args: {
  metrics: RoofMetrics
  inputs: RoofUserInputs
  outsideCoverage?: boolean
}): RoofingRoutingDecision | null {
  const { metrics, inputs, outsideCoverage } = args

  if (outsideCoverage === true) {
    return {
      decision: 'inspection_required',
      reason:
        'Address is outside Geoscape building coverage, so a tradie needs to attend to measure.',
    }
  }
  if (inputs.material === 'cement_sheet') {
    return {
      decision: 'inspection_required',
      reason:
        'Cement sheet roofs may contain asbestos, so a mandatory inspection on site is needed before any quote.',
    }
  }
  if (
    typeof inputs.building_year_built === 'number' &&
    inputs.building_year_built < 1990 &&
    inputs.intent === 'full_reroof'
  ) {
    return {
      decision: 'inspection_required',
      reason:
        'The building was built before 1990, so asbestos risk in the roof cavity must be assessed on site.',
    }
  }
  if (inputs.pitch === 'very_steep' || inputs.pitch === 'unknown') {
    return {
      decision: 'inspection_required',
      reason:
        'Roof pitch is steep or unknown, so fall protection cost cannot be priced without a measurement on site.',
    }
  }
  if (metrics.form === 'complex') {
    return {
      decision: 'inspection_required',
      reason:
        'Roof form is complex, so area and ridge counts need a measurement on site.',
    }
  }
  if (metrics.sloped_area_m2 === null) {
    return {
      decision: 'inspection_required',
      reason:
        'Sloped roof area could not be determined from available data, so a measurement on site is required.',
    }
  }
  if ((metrics.storeys ?? 1) >= 3) {
    return {
      decision: 'inspection_required',
      reason:
        'The building is 3 or more storeys, so scaffold or EWP access cannot be priced without an inspection on site.',
    }
  }
  return null
}

// ── Defaults ────────────────────────────────────────────────────────
// Per-tenant rate cards override these via pricing_book.overlays.
// Numbers chosen to match the per-m² norms in the AU re-roof market
// (Q1 2026): ~$80–$110 /m² for Colorbond, ~$95–$130 /m² for tile.

export const DEFAULT_ROOFING_RATE_CARD: RoofingRateCard = {
  reroof_rate_per_m2: {
    colorbond_trimdek: 95,
    colorbond_kliplok: 115,
    concrete_tile: 95,
    terracotta_tile: 130,
    cement_sheet: 0, // never auto-quoted
    unknown: 0,
  },
  multi_storey_loading_pct: 0.20,
  asbestos_loading_pct: 0.35,
  upgrade_material: 'colorbond_kliplok',
  gst_registered: true,
  // A half-day minimum mobilisation charge. Stops a tiny secondary
  // structure (e.g. a 12 m² shed → ~$228 patch) computing a number no
  // roofer would attend for. Well below any whole-house tier, so it
  // only binds on small structures.
  call_out_minimum_ex_gst: 550,
}

// ── Loadings ────────────────────────────────────────────────────────

type Loading = {
  code: 'multi_storey' | 'asbestos' | 'complexity'
  pct: number
  detail: string
}

/** PURE — which loadings stack on this job. */
export function applicableLoadings(
  metrics: RoofMetrics,
  inputs: RoofUserInputs,
  rateCard: RoofingRateCard,
): Loading[] {
  const out: Loading[] = []
  if ((metrics.storeys ?? 1) >= 2) {
    out.push({
      code: 'multi_storey',
      pct: rateCard.multi_storey_loading_pct,
      detail: `${(rateCard.multi_storey_loading_pct * 100).toFixed(0)}% multi-storey access loading`,
    })
  }
  // Asbestos loading only fires when the customer has confirmed asbestos
  // and the work was authorised past the inspection gate. (Inspection-
  // required quotes never reach this loading.)
  if (inputs.material === 'cement_sheet') {
    out.push({
      code: 'asbestos',
      pct: rateCard.asbestos_loading_pct,
      detail: `${(rateCard.asbestos_loading_pct * 100).toFixed(0)}% asbestos handling loading`,
    })
  }
  // Complexity loading — per-tenant override from the rate-card overlay
  // (the "always-applied buffer" lever borrowed from Jobber's research,
  // industry norm 0–25% to absorb on-the-job overhead that can't be
  // named in advance). Only applies when > 0; preserves the no-load
  // shape for tenants that don't set it.
  const cx = (rateCard as { complexity_loading_pct?: unknown }).complexity_loading_pct
  if (typeof cx === 'number' && Number.isFinite(cx) && cx > 0) {
    out.push({
      code: 'complexity',
      pct: cx,
      detail: `${(cx * 100).toFixed(0)}% complexity loading`,
    })
  }
  return out
}

// ── Tier rates ──────────────────────────────────────────────────────
// Tier-to-multiplier mapping. Good = patch (20% of full re-roof typical
// scope), Better = re-roof same material (full rate), Best = upgrade
// material (the rateCard's upgrade_material rate).
//
// The 'good' tier intentionally is NOT a discount on the full re-roof
// rate — it's a different scope (patch / leak repair only). Tradies
// should still review before send.

const GOOD_TIER_SCOPE_FRACTION = 0.20

function tierLabel(intent: RoofJobIntent, tier: 'good' | 'better' | 'best'): string {
  if (intent === 'leak_trace') {
    if (tier === 'good') return 'Leak trace + minor repair'
    if (tier === 'better') return 'Leak trace + flashing rework'
    return 'Leak trace + full section repair'
  }
  if (intent === 'patch_repair' || intent === 'flashing_repair' || intent === 'ridge_cap') {
    if (tier === 'good') return 'Targeted patch / repair'
    if (tier === 'better') return 'Broader repair + repoint'
    return 'Full section repair'
  }
  if (intent === 'gutter_replace') {
    if (tier === 'good') return 'Gutter replace, Quad profile'
    if (tier === 'better') return 'Gutter + downpipe replace'
    return 'Gutter + downpipe + flashings'
  }
  if (tier === 'good') return 'Patch / spot repair'
  if (tier === 'better') return 'Full re-roof, same material'
  return 'Full re-roof, upgrade material'
}

function tierScopeLine(
  intent: RoofJobIntent,
  tier: 'good' | 'better' | 'best',
  material: RoofMaterial,
  upgradeMaterial: RoofMaterial,
  area_m2: number,
): string {
  const materialWords: Record<RoofMaterial, string> = {
    colorbond_trimdek: 'Colorbond Trimdek',
    colorbond_kliplok: 'Colorbond Klip-Lok 700',
    concrete_tile: 'concrete tile',
    terracotta_tile: 'terracotta tile',
    cement_sheet: 'cement sheet',
    unknown: 'the existing material',
  }
  const m = materialWords[material]
  const u = materialWords[upgradeMaterial]
  if (intent === 'full_reroof') {
    if (tier === 'good') {
      return `Spot patches and ridge cap rebed on the existing ${m} roof (no full replacement).`
    }
    if (tier === 'better') {
      return `Full re-roof of approximately ${area_m2.toFixed(0)} m² using ${m}, including ridge caps and flashings.`
    }
    return `Full re-roof of approximately ${area_m2.toFixed(0)} m² using ${u} as a material upgrade, including ridge caps and flashings.`
  }
  if (intent === 'leak_trace') {
    if (tier === 'good') return 'Locate the leak source and perform a minor fix (replace one tile / reseal one flashing).'
    if (tier === 'better') return 'Leak trace plus full flashing rework at the suspect penetration.'
    return 'Leak trace plus targeted section repair (up to ~5 m² of roof material replaced).'
  }
  return `Roofing works applied across approximately ${area_m2.toFixed(0)} m² of the existing roof.`
}

/**
 * PURE — compute the three-tier price + routing for a roofing job.
 * Returns RoofingQuotePrice. Throws only on programmer error (negative
 * area, missing pitch correction); operational failures (inspection
 * routing) surface inside the result's `routing` field.
 */
export function calculateRoofingPrice(args: {
  metrics: RoofMetrics
  inputs: RoofUserInputs
  rateCard?: RoofingRateCard
  outsideCoverage?: boolean
}): RoofingQuotePrice {
  const rateCard = args.rateCard ?? DEFAULT_ROOFING_RATE_CARD
  const { metrics, inputs } = args

  const routing =
    requiresInspection({
      metrics,
      inputs,
      outsideCoverage: args.outsideCoverage,
    }) ??
    ({
      decision: 'tradie_review',
      reason:
        'Quote auto-calculated from Geoscape measurement. Every roofing quote requires tradie sign-off before customer send.',
    } as RoofingRoutingDecision)

  // Sloped area is the canonical pricing input. When inspection routing
  // already fired we still emit a "would have been" indicative number
  // for the tradie's situational awareness, using the footprint and a
  // gentle 1.10 correction. Customers never see this if inspection
  // routing applied — the UI swaps to the inspection CTA.
  const area_m2 =
    metrics.sloped_area_m2 ??
    (metrics.footprint_m2 > 0 ? roundTo(metrics.footprint_m2 * 1.10, 1) : 0)

  const baseRate = rateCard.reroof_rate_per_m2[inputs.material] ?? 0
  const upgradeRate = rateCard.reroof_rate_per_m2[rateCard.upgrade_material] ?? 0

  const loadings = applicableLoadings(metrics, inputs, rateCard)
  const loadingMultiplier = loadings.reduce((acc, l) => acc * (1 + l.pct), 1)

  const betterRaw = area_m2 * baseRate * loadingMultiplier
  const bestRaw = area_m2 * upgradeRate * loadingMultiplier
  const goodRaw = betterRaw * GOOD_TIER_SCOPE_FRACTION

  // Per-structure call-out floor — raise any positive tier to at least
  // the minimum job charge. Zero-rate tiers (unknown / cement_sheet,
  // which route to inspection anyway) are left at 0 rather than fabricating
  // a number. See call_out_minimum_ex_gst on the rate card.
  const floor = rateCard.call_out_minimum_ex_gst ?? 0
  const applyFloor = (n: number) => (floor > 0 && n > 0 ? Math.max(n, floor) : n)
  const goodEx = applyFloor(goodRaw)
  const betterEx = applyFloor(betterRaw)
  const bestEx = applyFloor(bestRaw)
  const callOutMinimumApplied =
    floor > 0 &&
    ((goodRaw > 0 && goodRaw < floor) ||
      (betterRaw > 0 && betterRaw < floor) ||
      (bestRaw > 0 && bestRaw < floor))

  const gstFactor = rateCard.gst_registered ? 1.10 : 1.0
  const toIncGst = (n: number) => roundTo(n * gstFactor, 2)

  const effectiveRate = baseRate * loadingMultiplier

  const tiers: [RoofingPriceTier, RoofingPriceTier, RoofingPriceTier] = [
    {
      tier: 'good',
      label: tierLabel(inputs.intent, 'good'),
      ex_gst: roundTo(goodEx, 2),
      inc_gst: toIncGst(goodEx),
      scope: tierScopeLine(
        inputs.intent,
        'good',
        inputs.material,
        rateCard.upgrade_material,
        area_m2,
      ),
    },
    {
      tier: 'better',
      label: tierLabel(inputs.intent, 'better'),
      ex_gst: roundTo(betterEx, 2),
      inc_gst: toIncGst(betterEx),
      scope: tierScopeLine(
        inputs.intent,
        'better',
        inputs.material,
        rateCard.upgrade_material,
        area_m2,
      ),
    },
    {
      tier: 'best',
      label: tierLabel(inputs.intent, 'best'),
      ex_gst: roundTo(bestEx, 2),
      inc_gst: toIncGst(bestEx),
      scope: tierScopeLine(
        inputs.intent,
        'best',
        inputs.material,
        rateCard.upgrade_material,
        area_m2,
      ),
    },
  ]

  return {
    area_m2,
    effective_rate_per_m2: roundTo(effectiveRate, 2),
    tiers,
    loadings_applied: loadings,
    routing,
    call_out_minimum_applied: callOutMinimumApplied,
  }
}

// ── Multi-structure pricing ──────────────────────────────────────────

/** One structure handed to the multi-roof pricer (pre-pricing). */
export type RoofStructureInput = {
  buildingId: string | null
  role: RoofStructureRole
  /** Optional explicit label; auto-derived from role + index when absent. */
  label?: string
  metrics: RoofMetrics
  inputs: RoofUserInputs
  outsideCoverage?: boolean
}

/** PURE — default per-structure label from its role + secondary index. */
function defaultStructureLabel(role: RoofStructureRole, secondaryIndex: number): string {
  if (role === 'primary') return 'Main dwelling'
  return `Secondary structure ${secondaryIndex}`
}

/**
 * PURE — price N structures and aggregate into one MultiRoofQuote.
 *
 * Each structure is priced INDEPENDENTLY with its own material, area and
 * loadings via calculateRoofingPrice — areas are never summed onto a
 * single material rate (a tile house + Colorbond shed would mis-price).
 * The combined tiers sum the per-structure tier amounts (GST is linear,
 * so summing inc-GST per structure is exact) over the QUOTABLE structures
 * only. The whole job routes to inspection ONLY when the PRIMARY dwelling
 * needs it, or when nothing is quotable — otherwise we quote what we can
 * and `inspection_structures` flags the rest. Each structure keeps its own
 * line-level routing flag.
 */
export function priceMultiRoof(args: {
  structures: RoofStructureInput[]
  rateCard?: RoofingRateCard
}): MultiRoofQuote {
  const rateCard = args.rateCard ?? DEFAULT_ROOFING_RATE_CARD

  let secondaryCounter = 0
  const structures: RoofStructurePrice[] = args.structures.map((s) => {
    const label =
      s.label ??
      defaultStructureLabel(
        s.role,
        s.role === 'secondary' ? ++secondaryCounter : 0,
      )
    const price = calculateRoofingPrice({
      metrics: s.metrics,
      inputs: s.inputs,
      rateCard,
      outsideCoverage: s.outsideCoverage,
    })
    return {
      buildingId: s.buildingId,
      role: s.role,
      label,
      metrics: s.metrics,
      inputs: s.inputs,
      price,
    }
  })

  // Split quotable vs inspection-needed. We price the quotable structures
  // and FLAG the rest — a small odd outbuilding shouldn't block a quote
  // for the main roof.
  const isInspection = (st: RoofStructurePrice) =>
    st.price.routing.decision === 'inspection_required'
  const quotable = structures.filter((st) => !isInspection(st))
  const inspection_structures = structures.filter(isInspection).map((st) => st.label)

  // Combined per-tier totals — over the QUOTABLE structures only.
  const combinedTiers = ([0, 1, 2] as const).map((i): RoofingPriceTier => {
    const tierName = (['good', 'better', 'best'] as const)[i]
    const exSum = quotable.reduce((acc, st) => acc + st.price.tiers[i].ex_gst, 0)
    const incSum = quotable.reduce((acc, st) => acc + st.price.tiers[i].inc_gst, 0)
    const labelWord = tierName === 'good' ? 'Patch / repair' : tierName === 'better' ? 'Re-roof' : 'Upgrade'
    return {
      tier: tierName,
      label: `${labelWord}, all structures`,
      ex_gst: roundTo(exSum, 2),
      inc_gst: roundTo(incSum, 2),
      scope: `${labelWord} priced across ${quotable.length} structure${quotable.length === 1 ? '' : 's'}.`,
    }
  }) as [RoofingPriceTier, RoofingPriceTier, RoofingPriceTier]

  const combinedArea = roundTo(
    quotable.reduce((acc, st) => acc + st.price.area_m2, 0),
    1,
  )

  // Whole job routes to inspection ONLY when the PRIMARY dwelling needs
  // it, or when nothing is quotable. Otherwise we quote the quotable
  // structures and flag the inspection-needed ones separately.
  const primary = structures.find((st) => st.role === 'primary') ?? structures[0]
  const primaryNeedsInspection = primary ? isInspection(primary) : false

  let routing: RoofingRoutingDecision
  if (primaryNeedsInspection && primary) {
    routing = { decision: 'inspection_required', reason: primary.price.routing.reason }
  } else if (quotable.length === 0) {
    routing = {
      decision: 'inspection_required',
      reason:
        `${inspection_structures.join(', ')} require${inspection_structures.length === 1 ? 's' : ''} an on-site inspection before we can quote.`,
    }
  } else {
    routing = {
      decision: 'tradie_review',
      reason:
        'Quotable structures auto-calculated from measurement. Every roofing quote requires tradie sign-off before customer send.',
    }
  }

  return {
    structures,
    combined: { area_m2: combinedArea, tiers: combinedTiers },
    routing,
    inspection_structures,
  }
}

/** PURE — round to N decimal places, banker-rounding-free, predictable. */
function roundTo(n: number, dp: number): number {
  if (!Number.isFinite(n)) return 0
  const f = Math.pow(10, dp)
  return Math.round(n * f) / f
}

// Re-export the small helpers for tests + callers that want them direct.
export const __test_only__ = { roundTo, GOOD_TIER_SCOPE_FRACTION, PITCH_CORRECTION }

/** Map a RoofForm value to a human-readable label for UI. */
export function formLabel(form: RoofForm): string {
  switch (form) {
    case 'gable':       return 'Gable'
    case 'hip':         return 'Hip'
    case 'skillion':    return 'Skillion (mono-pitch)'
    case 'gable_hip':   return 'Gable + hip combination'
    case 'complex':     return 'Complex / irregular'
    case 'unknown':     return 'Unknown, needs inspection'
  }
}
