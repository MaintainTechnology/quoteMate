// Customer-facing public solar estimate page (spec §6). Token-gated
// against solar_estimates.public_token (unguessable); service-role client
// because this is a public sharing surface.
//
// CONFIRM GATE: prices + deposit CTA are hidden until the estimate is
// confirmed (solar_estimates.confirmed_at set). A CLEAN estimate confirms
// AUTOMATICALLY at creation (Path B, docs/strategy.md v12 2026-06-16); a
// flagged estimate stays unconfirmed until the tradie reviews. The deferred
// assets (heatmap, auto-confirm) land a few seconds after creation, so
// HeatmapAutoRefresh re-renders the page until they arrive (no manual
// reload). Before confirmation the page shows the real satellite roof photo
// + stats overlay framed "indicative — your installer confirms". After
// confirmation it shows the full priced tier breakdown
// (kW, panels, yearly kWh, gross → STC subtraction → net, annual savings,
// banded payback), the always-visible assumptions panel, the confidence
// chip, the mandatory SAA/CEC compliance copy, and the per-tier deposit
// CTA (reusing /r/[token]/[tier]).
//
// TRANSPARENCY LAYER: each hero stat carries a native-<details>
// "why this number?" explainer (buildSolarStatExplainers) and the
// assumptions panel shows value / source / meaning / sensitivity per
// assumption (buildSolarAssumptionsView). Both are pure view models over
// persisted estimate fields — the page stays a server component with no
// client JS.
//
// REDESIGN: the customer surface is reskinned onto the shared QuoteMax
// "command-center" quote kit (app/q/_chrome/*) — dark, square-cornered,
// a narrow 520px quote sheet with mono eyebrows, hairline stat/metric
// grids, Good·Better·Best tier cards and a sticky deposit bar. This is a
// presentation-only reskin: all data prep, the confirm gate, tier
// visibility, deposit-CTA hrefs and the SAA/CEC compliance copy are
// unchanged — only the markup that renders them moved onto the kit.

import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import { QuoteUnavailable } from '@/app/q/_chrome/QuoteUnavailable'
import { quoteReadFailure } from '@/lib/quote/read-failure'
import type { SolarEstimate } from '@/lib/solar/types'
import { resolveSolarQuoteView } from '@/lib/solar/quote-page-row'
import { buildSolarTierCards } from '@/lib/solar/tier-cards'
import { asQuoteTierMode, resolveVisibleTiers, type QuoteTierMode } from '@/lib/quote/tier-visibility'
import { buildHeroOverlay } from '@/lib/solar/hero-overlay'
import { buildSolarStatExplainers, type SolarStatExplainer } from '@/lib/solar/explainers'
import { buildSolarAssumptionsView, type SolarAssumptionRow } from '@/lib/solar/assumptions-view'
import { confidenceChip } from '@/lib/solar/confidence-chip'
import { resolveSolarDepositCta } from '@/lib/solar/deposit-cta'
import {
  SOLAR_COMPLIANCE_COPY,
  SOLAR_PRE_CONFIRM_COPY,
  SOLAR_PROJECTION_COPY,
  SOLAR_LAYOUT_COPY,
  SOLAR_ENVIRONMENTAL_COPY,
} from '@/lib/solar/compliance-copy'
import {
  buildSolarPremiumQuote,
  solarPremiumQuoteEnabled,
  type SolarPremiumQuote,
} from '@/lib/solar/premium-quote'
import { loadSolarConfig } from '@/lib/solar/config'
import type { SolarChart } from '@/lib/solar/charts'
import { buildSolarHardwareCards } from '@/lib/solar/hardware-cards'
import { buildSolarSunView } from '@/lib/solar/sun-view'
import { resolveSolarOverlayCenter } from '@/lib/solar/static-map-center'
import type { DetectedBuilding } from '@/lib/solar/types'
import { SunShadeOverlay } from './SunShadeOverlay'
import { SunShadeMap } from './SunShadeMap'
import { BuildingPickerSection } from './BuildingPickerSection'
import { HeatmapAutoRefresh } from './HeatmapAutoRefresh'
import { money, kwh, kw, paybackBand } from '@/lib/solar/quote-page-format'
import { loadTenantIdentity, contactDisplayName } from '@/lib/quote/tenant-identity'
import {
  repairSolarFeltLayers,
  type SolarFeltRecord,
} from '@/lib/solar/felt-provision'
import type { SolarAiBriefRecord } from '@/lib/solar/ai-brief'
import { QuoteChrome, type StickyBar } from '../../_chrome/QuoteChrome'
import { TradieDashboardPill } from '../../_chrome/TradieDashboardPill'
import { AcceptBlock } from '../../_chrome/AcceptBlock'
import { resolveAcceptView } from '@/lib/quote/accept'
import { tradeIcon } from '../../_chrome/icons'
import {
  QuoteSheet,
  Letterhead,
  HeroPhoto,
  QuoteHero,
  StatGrid,
  SheetSection,
  MetricGrid,
  TierCards,
  CredentialFooter,
  Chip,
  type QuoteTier,
  type Metric,
} from '../../_chrome/parts'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Row = {
  address: string | null
  state: string | null
  estimate: SolarEstimate | null
  confirmed_at: string | null
  quote_variant: string | null
  felt: SolarFeltRecord | null
  ai_brief: SolarAiBriefRecord | null
  buildings: DetectedBuilding[] | null
  selected_building_id: string | null
  tenant_id: string | null
}

const TIER_NAME: Record<'good' | 'better' | 'best', string> = {
  good: 'Starter',
  better: 'Full-size',
  best: 'Premium',
}

export default async function SolarQuotePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  if (!token || token.length < 8) notFound()

  const { data, error } = await supabase
    .from('solar_estimates')
    .select('address, state, estimate, confirmed_at, quote_variant, felt, ai_brief, buildings, selected_building_id, tenant_id')
    .eq('public_token', token)
    .maybeSingle()

  if (error) return <QuoteUnavailable correlationId={quoteReadFailure('solar', error)} />
  if (!data) notFound()
  const row = data as Row
  const estimate = row.estimate
  if (!estimate) return <QuoteUnavailable correlationId={quoteReadFailure('solar', { code: 'MISSING_ESTIMATE' })} />

  // Tradie identity for the letterhead (logo + Contact/Phone/Email strip).
  // Best-effort: null tenant_id or a pre-141 deploy simply hides the strip.
  const identity = await loadTenantIdentity(supabase, row.tenant_id)

  // ── Felt variant (spec 2026-06-13 §4.7): the interactive roof map +
  // AI brief sections render only on quote_variant='felt' rows. A
  // failed/missing map degrades to the instant layout (§4.9). The lazy
  // repair pass styles layers that finished processing after the
  // provisioning poll budget — cheap status polls, no re-uploads.
  const isFeltVariant = row.quote_variant === 'felt'
  let felt = isFeltVariant ? row.felt : null
  if (felt && (felt.status === 'partial' || felt.status === 'provisioning')) {
    const repaired = await repairSolarFeltLayers(supabase, { publicToken: token })
    if (repaired) felt = repaired
  }
  const showFeltMap = Boolean(isFeltVariant && felt?.embed_url && felt.status !== 'failed')
  const aiBrief = isFeltVariant ? row.ai_brief : null

  const view = resolveSolarQuoteView({ estimate, confirmedAt: row.confirmed_at })
  const chip = confidenceChip({
    band: estimate.confidence_band,
    coverageSource: estimate.coverage_source,
  })
  const cards = buildSolarTierCards({
    price: estimate.price,
    production: estimate.production,
    economics: estimate.economics,
  })
  // Mig 142 — per-feature tier presentation mode for solar. Solar has no
  // quotes.selected_tier; its "recommended" is the headline (largest) tier, so
  // 'single' collapses to that. Read the tenant's solar pricing_book mode.
  const solarHeadlineTierKey =
    view.headlineTier?.tier ?? cards[cards.length - 1]?.tier ?? null
  let solarTierMode: QuoteTierMode = 'single'
  if (row.tenant_id) {
    const { data: pb } = await supabase
      .from('pricing_book')
      .select('quote_tier_mode')
      .eq('tenant_id', row.tenant_id)
      .eq('trade', 'solar')
      .maybeSingle()
    solarTierMode = asQuoteTierMode(
      (pb as { quote_tier_mode?: string | null } | null)?.quote_tier_mode,
    )
  }
  const visibleSolarTierKeys = resolveVisibleTiers({
    mode: solarTierMode,
    present: {
      good: cards.some((c) => c.tier === 'good'),
      better: cards.some((c) => c.tier === 'better'),
      best: cards.some((c) => c.tier === 'best'),
    },
    selectedTier: solarHeadlineTierKey,
  })
  const visibleCards = cards.filter((c) => visibleSolarTierKeys.includes(c.tier))
  const headlineProd = estimate.production[estimate.production.length - 1]
  const overlay = buildHeroOverlay({
    headlineTier: view.headlineTier,
    roof: estimate.roof,
    annualKwhAc: headlineProd?.annual_kwh_ac ?? 0,
  })
  const explainers = buildSolarStatExplainers(estimate)
  const assumptions = buildSolarAssumptionsView(estimate)
  // Sun & shade analysis (full-exploitation build 2026-06-13) — measured
  // sun hours, per-plane sun scores, the flux heatmap and the shade-free
  // window. No dollar figures → renders pre-confirm; null omits it.
  const sunView = buildSolarSunView(estimate)
  // Pylon hardware supplement (build 2026-06-13) — customer-facing
  // datasheet cards; empty array when the tenant nominated no SKUs.
  const hardwareCards = buildSolarHardwareCards(estimate.context)

  // ── Multi-roof building picker (2026-06-16). When the property carries
  // ≥2 detected buildings, let the viewer pick which roof the estimate is
  // for. The picker projects each building.footprint onto the SAME static
  // map the hero <img> shows — centred via resolveSolarOverlayCenter at
  // zoom 20 / 640×480 — so the outlines are pixel-aligned. Read-only once
  // the estimate is released/confirmed (no switching after the lock).
  const buildings = row.buildings ?? []
  const pickerCenter =
    buildings.length >= 2
      ? resolveSolarOverlayCenter({
          roof: estimate.roof,
          location: estimate.context.location ?? null,
        })
      : null
  const showBuildingPicker = buildings.length >= 2 && pickerCenter != null

  // Deferred-asset auto-refresh (2026-06-16): the Sun & shade heatmap and
  // — for a clean estimate — the auto-release confirm land a few seconds
  // after creation (estimate route's after() job). For a Google-coverage
  // estimate, poll until they arrive so a viewer who opened the quote
  // mid-generation sees the full result without a manual reload. The
  // confirm-flip is only awaited for a CLEAN estimate (a flagged one never
  // auto-confirms, so polling for it would never settle) — once its
  // heatmap lands the poller stops.
  const eligibleForAutoConfirm = (estimate.guardrail_flags ?? []).length === 0
  const pendingAssets =
    estimate.coverage_source === 'google' &&
    (!sunView?.flux_image_available || (!view.confirmed && eligibleForAutoConfirm))

  // Premium proposal sections (spec 2026-06-12 §4.4), behind the
  // SOLAR_PREMIUM_QUOTE flag. The view model degrades field-by-field
  // (§4.6) — each null simply omits its section.
  let premium: SolarPremiumQuote | null = null
  if (solarPremiumQuoteEnabled(process.env.SOLAR_PREMIUM_QUOTE)) {
    const config = await loadSolarConfig(supabase)
    premium = buildSolarPremiumQuote({ estimate, config, theme: 'dark' })
  }

  // AI "panels installed" concept: confirmed Google-coverage estimates
  // only. The proxy lazily renders + caches it post-confirm; manual roofs
  // have no trustworthy aerial to edit, so the block is simply omitted.
  const showAiConcept =
    view.confirmed && estimate.coverage_source === 'google' && view.headlineTier != null

  // ── Headline hero copy: split "6.6kW SOLAR, SORTED." style. line1 =
  // measured system size, line2 = accent word. Falls back cleanly when
  // the size is still to confirm (pre-confirm / manual).
  const headlineKw = view.headlineTier ? `${kw(view.headlineTier.system_kw_dc)}kW` : null
  const heroLine1 = headlineKw ? `${headlineKw} solar,` : 'Your solar'
  const heroLine2 = view.confirmed ? 'sorted.' : 'estimate.'

  // ── Sheet summary stat grid — SYSTEM / OUTPUT / SAVINGS/OFFSET / PAYBACK
  // derived only from persisted headline values (kw/kwh/money/paybackBand).
  const headlineEcon = view.headlineTier
    ? estimate.economics.tiers.find((e) => e.tier === view.headlineTier!.tier)
    : undefined
  const heroStats = [
    {
      k: 'System',
      v: view.headlineTier ? `${kw(view.headlineTier.system_kw_dc)}` : 'TBC',
      sub: view.headlineTier ? `kW · ${view.headlineTier.panels_count} panels` : 'to confirm',
    },
    {
      k: 'Annual output',
      v: headlineProd?.annual_kwh_ac ? kwh(headlineProd.annual_kwh_ac) : 'TBC',
      sub: 'kWh / year',
    },
    view.showPrices && headlineEcon
      ? {
          k: 'Annual saving',
          v: `$${money(headlineEcon.annual_savings_aud)}`,
          sub: 'estimated / year',
        }
      : { k: 'Orientation', v: overlay.stats[2]?.value ?? 'TBC', sub: 'main roof face' },
    view.showPrices && headlineEcon
      ? {
          k: 'Payback',
          v: paybackBand(headlineEcon.payback_years_low, headlineEcon.payback_years_high),
          sub: 'simple payback',
        }
      : { k: 'Confidence', v: chip.bandLabel, sub: chip.indicativeOnly ? 'indicative' : 'aerial imagery' },
  ]

  // ── Sticky deposit bar. Honours the confirm gate: only shows a real
  // deposit CTA once confirmed AND not inspection-routed, on the featured
  // (headline/last visible) tier. Otherwise a gate-consistent state.
  const featuredCard =
    visibleCards.find((c) => c.tier === solarHeadlineTierKey) ??
    visibleCards[visibleCards.length - 1] ??
    null
  let sticky: StickyBar | null = null
  if (view.showPrices && featuredCard) {
    const featuredCta = resolveSolarDepositCta({
      confirmed: view.confirmed,
      token,
      tier: featuredCard.tier,
      inspectionRequired: view.inspectionRequired,
    })
    sticky = {
      tierLabel: `${TIER_NAME[featuredCard.tier]} · ${featuredCard.label}`,
      priceText: `$${money(featuredCard.netIncGst)}`,
      ctaLabel: 'Pay deposit',
      ctaHref: featuredCta.show ? featuredCta.href : null,
    }
  } else {
    sticky = {
      tierLabel: view.inspectionRequired ? 'On-site check needed' : 'Estimate drafted',
      priceText: '—',
      ctaLabel: view.inspectionRequired ? 'Awaiting site check' : 'Awaiting confirmation',
      ctaHref: null,
    }
  }

  // ── Explicit "Accept & confirm" block (Gap #1/#3). A confirmed clean
  // estimate accepts + proceeds to the deposit (the /r/<token>/<tier> mint now
  // works — solar quotes carry good/better/best, migration-era fix); a
  // genuinely held estimate (inspection-routed OR flagged, which never
  // auto-confirms) accepts + books the refundable $99 site visit. A clean
  // estimate still mid-auto-confirm shows the pre-confirm notice + auto-refresh
  // instead, so we don't flash a premature $99 CTA that becomes a deposit a
  // second later.
  // Solar payment records on the twin QUOTES row (share_token == this token)
  // via the generic /r deposit → Stripe webhook; solar_estimates itself has no
  // paid_at column. Best-effort so a solar estimate without a twin quotes row
  // (or a pre-fix legacy row) simply reads not-paid rather than throwing.
  let solarPaidAt: string | null = null
  // Twin quote id feeds the owner-gated "← Dashboard" pill (the solar page has
  // no TradieEditor, so without it the signed-in tradie has no route back).
  let twinQuoteId: string | null = null
  {
    const { data: q } = await supabase
      .from('quotes')
      .select('id, paid_at')
      .eq('share_token', token)
      .maybeSingle()
    solarPaidAt = (q?.paid_at as string | null) ?? null
    twinQuoteId = (q?.id as string | null) ?? null
  }
  const solarPaid = !!solarPaidAt

  const solarDeposit = featuredCard ? Math.round(featuredCard.netIncGst * 0.3) : 0
  const solarAcceptView = resolveAcceptView({
    token,
    tier: (solarHeadlineTierKey ?? featuredCard?.tier ?? 'better') as 'good' | 'better' | 'best',
    isPaid: solarPaid,
    pricesVisible: view.showPrices,
    priceExpired: false,
    priceLabel: view.showPrices && featuredCard ? `$${money(featuredCard.netIncGst)} inc GST` : null,
    depositLabel: view.showPrices && featuredCard ? `30% deposit ($${money(solarDeposit)})` : null,
    siteVisitFee: '$99',
  })
  const showSolarAccept =
    solarPaid || view.showPrices || view.inspectionRequired || !eligibleForAutoConfirm

  return (
    <QuoteChrome trade={{ label: 'Solar', icon: tradeIcon('solar') }} sticky={sticky}>
      {/* Owner-only route back to the dashboard + the sync-safe edit surface
          (SolarTab re-draft/confirm updates solar_estimates AND the twin
          quotes row together — unlike the line-item editor, which would change
          the charged deposit without changing this page's displayed prices). */}
      {twinQuoteId && (
        <TradieDashboardPill quoteId={twinQuoteId} editHref="/dashboard?tab=solar" />
      )}
      {/* Reveal the heatmap + priced result without a manual reload once
          the estimate route's after() job finishes (renders nothing). */}
      {pendingAssets && <HeatmapAutoRefresh pending={pendingAssets} />}

      <QuoteSheet label={`Solar estimate · ${row.address ?? 'your property'}`}>
        <Letterhead
          name={identity?.business_name ?? 'Your solar installer'}
          credential="Prepared with QuoteMax · Accredited CEC installer confirms on site"
          logoUrl={identity?.logo_url ?? null}
          contactName={contactDisplayName(identity)}
          phone={(identity?.owner_mobile ?? '').trim() || null}
          email={(identity?.owner_email ?? '').trim() || null}
        />

        <HeroPhoto
          src={`/api/solar/q/${token}/static-map`}
          alt={`Satellite view of the roof at ${row.address ?? 'the property'}`}
          height={220}
        />

        <QuoteHero
          quoteId="Solar estimate"
          status={
            view.confirmed
              ? { label: 'Priced', tone: 'booked' }
              : { label: view.inspectionRequired ? 'Site check' : 'Awaiting you', tone: 'await' }
          }
          line1={heroLine1}
          line2={heroLine2}
          greeting={
            <>
              {row.address ? <>{row.address}. </> : null}
              {chip.caption}
            </>
          }
        />

        {/* Confidence chip — kept beside the hero, in the sheet. */}
        <SheetSection eyebrow="Estimate confidence" aside={chip.indicativeOnly ? 'Indicative only' : undefined}>
          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.14em',
                color: chip.tone === 'warning' ? 'var(--warning-bright)' : 'var(--accent)',
                borderLeft: `3px solid ${chip.tone === 'warning' ? 'var(--warning-bright)' : 'var(--accent)'}`,
                paddingLeft: 12,
              }}
            >
              {chip.bandLabel}
            </span>
            {chip.indicativeOnly ? <Chip>Indicative only</Chip> : null}
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>{chip.caption}</p>
        </SheetSection>

        {/* Summary stat grid. */}
        <StatGrid items={heroStats} />

        {/* AI "panels installed" concept — confirmed Google estimates only. */}
        {showAiConcept && (
          <SheetSection eyebrow="AI-generated concept" aside="Illustrative only">
            <figure style={{ margin: '14px 0 0', position: 'relative', border: '1px solid var(--ink-line)', overflow: 'hidden' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/solar/q/${token}/panels-after`}
                alt={`AI-generated concept of ${view.headlineTier?.panels_count ?? ''} solar panels installed on the roof at ${row.address ?? 'the property'}`}
                style={{ display: 'block', width: '100%' }}
              />
            </figure>
            <p style={{ margin: '11px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--text-dim)' }}>
              How {view.headlineTier?.panels_count} panels could sit on this roof — illustrative only, not a design document.
            </p>
          </SheetSection>
        )}

        {/* ── Size explainer — why the headline system is the size it is. */}
        {view.sizeNote && (
          <SheetSection eyebrow={view.sizeNote.title} eyebrowAccent>
            <p style={{ margin: '12px 0 0', fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              {view.sizeNote.body}
            </p>
          </SheetSection>
        )}

        {/* ── Felt interactive roof map (§4.7). No dollars → pre-confirm. */}
        {showFeltMap && felt && (
          <SheetSection eyebrow="Explore your roof — interactive map">
            <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              Pan and zoom the real satellite view of your roof. Use the map legend to flip between the proposed
              panel layout, the sun-exposure heat map, and the roof elevation. Tap any panel for its yearly output.
            </p>
            <div style={{ marginTop: 14, border: '1px solid var(--ink-line)', background: 'var(--ink-card)', overflow: 'hidden' }}>
              <iframe
                src={felt.embed_url!}
                title={`Interactive roof map for ${row.address ?? 'the property'}`}
                style={{ display: 'block', width: '100%', height: 300, border: 0 }}
                loading="lazy"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-popups"
                allow="fullscreen"
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderTop: '1px solid var(--ink-line)', padding: '10px 14px' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-dim)' }}>
                  {felt.status === 'ready'
                    ? 'Panels · Sun exposure · Elevation — toggle in the map legend'
                    : 'Map layers are still building — refresh in a minute for the full set'}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)' }}>Maps by Felt</span>
              </div>
            </div>
          </SheetSection>
        )}

        {/* ── AI roof-intelligence brief (§4.6). Clearly labelled. */}
        {aiBrief && (
          <SheetSection eyebrow="Roof intelligence">
            <div style={{ marginTop: 14, border: '1px solid var(--ink-line)', borderLeft: '3px solid var(--accent)', background: 'var(--ink-card)', padding: '18px 18px 20px' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 9 }}>
                <span style={{ border: '1px solid var(--ink-line)', background: 'var(--ink-deep)', padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--accent)' }}>
                  AI-generated summary
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.11em', color: 'var(--text-dim)' }}>Figures from your roof analysis</span>
              </div>
              <h3 style={{ margin: '14px 0 0', fontFamily: 'var(--font-sans)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '-0.01em', fontSize: 17, color: 'var(--text-pri)' }}>
                {aiBrief.headline}
              </h3>
              <p style={{ margin: '11px 0 0', fontSize: 14, lineHeight: 1.55, color: 'var(--text-sec)' }}>{aiBrief.layout_rationale}</p>
              <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr', gap: 1, background: 'var(--ink-line)', border: '1px solid var(--ink-line)' }}>
                <div style={{ background: 'var(--ink-deep)', padding: '14px 16px' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--text-dim)' }}>Best roof face</div>
                  <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--text-sec)' }}>{aiBrief.best_plane_note}</p>
                </div>
                <div style={{ background: 'var(--ink-deep)', padding: '14px 16px' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--text-dim)' }}>Across the seasons</div>
                  <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--text-sec)' }}>{aiBrief.seasonal_note}</p>
                </div>
              </div>
              {aiBrief.caveats.length > 0 && (
                <ul style={{ margin: '14px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
                  {aiBrief.caveats.map((c, i) => (
                    <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                      <span aria-hidden="true" style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent)' }}>·</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SheetSection>
        )}

        {/* §4.4-2 — Proposed panel layout (deterministic, pre-confirm OK). */}
        {premium?.layout && (
          <SheetSection eyebrow="Proposed panel layout">
            <div style={{ marginTop: 14, border: '1px solid var(--ink-line)', background: 'var(--ink-card)', overflow: 'hidden' }}>
              <div style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/solar/q/${token}/static-map`}
                  alt={`Satellite view of the roof at ${row.address ?? 'the property'} with the proposed panel layout drawn over it`}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                />
                <div
                  style={{ position: 'absolute', inset: 0 }}
                  className="[&>svg]:h-full [&>svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: premium.layout.svg }}
                />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 18px', borderTop: '1px solid var(--ink-line)', padding: '10px 14px' }}>
                {premium.layout.legend.map((l) => (
                  <span key={l.segment_index} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.11em', color: 'var(--text-sec)' }}>
                    <span style={{ display: 'inline-block', width: 9, height: 9, backgroundColor: l.color }} aria-hidden />
                    {l.plane_label} · {l.panels_count} {l.panels_count === 1 ? 'panel' : 'panels'}
                  </span>
                ))}
              </div>
              <div style={{ borderTop: '1px solid var(--ink-line)', padding: '10px 14px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                {SOLAR_LAYOUT_COPY} {overlay.caption}
              </div>
            </div>
          </SheetSection>
        )}

        {/* §4.4-3 — Panel strings & component markings (indicative). */}
        {premium?.strings && (
          <SheetSection eyebrow="Panel strings & component markings">
            <div style={{ marginTop: 14, border: '1px solid var(--ink-line)', background: 'var(--ink-card)', overflow: 'hidden' }}>
              <div style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/solar/q/${token}/static-map`}
                  alt={`Satellite view of the roof at ${row.address ?? 'the property'} with indicative panel string runs drawn over it`}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.8 }}
                />
                <div
                  style={{ position: 'absolute', inset: 0 }}
                  className="[&>svg]:h-full [&>svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: premium.strings.svg }}
                />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 18px', borderTop: '1px solid var(--ink-line)', padding: '10px 14px' }}>
                {premium.strings.strings.map((s) => (
                  <span key={s.string_number} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.11em', color: 'var(--text-sec)' }}>
                    <span style={{ display: 'inline-block', width: 9, height: 9, backgroundColor: s.color }} aria-hidden />
                    S{s.string_number} · {s.panels_count} {s.panels_count === 1 ? 'panel' : 'panels'}
                  </span>
                ))}
              </div>
              <div style={{ borderTop: '1px solid var(--ink-line)', padding: '10px 14px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                {premium.strings.caption}
              </div>
            </div>
          </SheetSection>
        )}

        {/* ── Multi-roof building picker (2026-06-16). Read-only once confirmed. */}
        {showBuildingPicker && pickerCenter && (
          <SheetSection eyebrow="Which building?">
            <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              We found more than one building on this property. The estimate below is for the highlighted roof —
              tap another building to re-estimate that one instead.
            </p>
            <BuildingPickerSection
              token={token}
              center={pickerCenter}
              buildings={buildings}
              selectedBuildingId={row.selected_building_id}
              readOnly={view.confirmed}
            />
          </SheetSection>
        )}

        {/* Sun & shade analysis — heatmap + sun metrics. Pre-confirm OK. */}
        {sunView && (
          <SheetSection eyebrow="Sun & shade analysis">
            {sunView.flux_image_available &&
              (sunView.flux_bounds ? (
                <SunShadeMap
                  heatmapSrc={`/api/solar/q/${token}/flux-heatmap`}
                  alt={`Roof irradiance heatmap for ${row.address ?? 'the property'} — brighter areas receive more annual sun`}
                  markers={sunView.markers}
                  caption={sunView.flux_caption}
                  bounds={sunView.flux_bounds}
                />
              ) : (
                <SunShadeOverlay
                  heatmapSrc={`/api/solar/q/${token}/flux-heatmap`}
                  alt={`Roof irradiance heatmap for ${row.address ?? 'the property'} — brighter areas receive more annual sun`}
                  markers={sunView.markers}
                  caption={sunView.flux_caption}
                />
              ))}

            {/* Shade → Full sun legend (mockup). */}
            {sunView.flux_image_available && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-sec)' }}>Shade</span>
                <span aria-hidden="true" style={{ width: 90, height: 7, background: 'linear-gradient(90deg,#2fa39a,#ffd400,#e5471c)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-sec)' }}>Full sun</span>
              </div>
            )}

            {sunView.stats.length > 0 && (
              <MetricGrid
                cols={2}
                items={sunView.stats.map<Metric>((s) => ({ k: s.label, v: s.value, sub: s.hint }))}
              />
            )}

            {/* Per-plane rows — fallback for estimates without on-image anchors. */}
            {sunView.markers.length === 0 && sunView.planes.length > 0 && (
              <div style={{ marginTop: 14, display: 'grid', gap: 1, background: 'var(--ink-line)', border: '1px solid var(--ink-line)' }}>
                {sunView.planes.map((p, i) => (
                  <div
                    key={`${p.orientation}-${i}`}
                    style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'var(--ink-deep)', padding: '11px 14px' }}
                  >
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600, color: 'var(--text-pri)' }}>
                      {p.orientation} face · {p.area_m2.toLocaleString('en-AU')} m²
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--accent)' }}>{p.score_copy}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>{p.relative_pct}% of best face</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SheetSection>
        )}

        {/* The numbers, explained — expandable "why?" per hero stat. */}
        <SheetSection eyebrow="The numbers, explained">
          <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>
            Every figure above traces back to a measurement or a published rate. Open any number to see exactly
            how it was worked out — the same trail your installer reviews.
          </p>
          <div style={{ marginTop: 14, display: 'grid', gap: 1, background: 'var(--ink-line)', border: '1px solid var(--ink-line)' }}>
            {explainers.map((e) => (
              <ExplainerCard key={e.key} explainer={e} />
            ))}
          </div>
        </SheetSection>

        {/* §4.4-4 — System details: modelled monthly production + assumed values. */}
        {premium && (premium.charts.monthlyProduction || premium.assumed_values.length > 0) && (
          <SheetSection eyebrow="System details · monthly output" aside="kWh">
            {premium.charts.monthlyProduction && (
              <ChartFigure chart={premium.charts.monthlyProduction} />
            )}
            {premium.assumed_values.length > 0 && (
              <MetricGrid
                cols={3}
                valueColor="var(--text-pri)"
                valueSize={13}
                items={premium.assumed_values.map<Metric>((r) => ({ k: r.label, v: r.value }))}
              />
            )}
          </SheetSection>
        )}

        {/* Your hardware — tenant-nominated components + datasheets. Pre-confirm. */}
        {hardwareCards.length > 0 && (
          <SheetSection eyebrow="Your hardware">
            <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              The equipment your installer fits as standard — manufacturer datasheets included.
            </p>
            <ul style={{ margin: '14px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
              {hardwareCards.map((c) => (
                <li key={c.kindLabel + c.name} style={{ border: '1px solid var(--ink-line)', background: 'var(--ink-card)', padding: '14px 16px' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--accent)' }}>{c.kindLabel}</div>
                  <div style={{ marginTop: 5, fontSize: 14.5, fontWeight: 700, color: 'var(--text-pri)' }}>{c.name}</div>
                  {c.detail && <div style={{ marginTop: 2, fontSize: 12.5, color: 'var(--text-sec)' }}>{c.detail}</div>}
                  {c.datasheetUrl && (
                    <a
                      href={c.datasheetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ marginTop: 8, display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.11em', color: 'var(--text-dim)', textDecoration: 'underline', textUnderlineOffset: 2 }}
                    >
                      Manufacturer datasheet
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </SheetSection>
        )}

        {/* Pre-confirmation notice. */}
        {!view.showPrices && (
          <SheetSection
            eyebrow={view.inspectionRequired ? 'On-site check needed' : 'Estimate drafted'}
            eyebrowAccent
          >
            <p style={{ margin: '12px 0 0', fontSize: 14, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              {view.inspectionRequired
                ? (estimate.routing.reason ||
                  'This roof needs a quick look on site before we can finalise a price.')
                : SOLAR_PRE_CONFIRM_COPY}
            </p>
          </SheetSection>
        )}

        {/* §4.4-5 — Utility costs (dollar figures → confirm-gated). */}
        {view.showPrices && premium?.charts.utilityCosts && (
          <SheetSection eyebrow="Utility costs — before & with solar">
            <ChartFigure chart={premium.charts.utilityCosts} />
          </SheetSection>
        )}

        {/* §4.4-6 — 25-year financial summary (confirm-gated). */}
        {view.showPrices && premium?.financial && (
          <SheetSection eyebrow="25-year financial summary" eyebrowAccent>
            <MetricGrid
              cols={2}
              items={[
                {
                  k: 'Net present value',
                  v: `$${money(premium.financial.npv_aud)}`,
                  sub: `Discounted at ${(premium.financial.assumptions.discount_rate_pct * 100).toFixed(1)}%`,
                },
                {
                  k: 'Payback',
                  v: paybackBand(premium.financial.payback_years_low, premium.financial.payback_years_high),
                  sub: 'Simple payback band',
                },
                {
                  k: 'Total ROI (20 yr)',
                  v: `${premium.financial.total_roi_pct.toLocaleString('en-AU')}%`,
                  sub: `$${money(premium.financial.total_savings_20yr_aud)} cumulative`,
                },
                {
                  k: 'IRR',
                  v:
                    premium.financial.irr_pct != null
                      ? `${premium.financial.irr_pct.toLocaleString('en-AU')}%`
                      : 'See installer',
                  sub: 'Internal rate of return',
                },
              ]}
            />
            {premium.charts.cumulativeSavings && (
              <ChartFigure chart={premium.charts.cumulativeSavings} />
            )}
            <p style={{ margin: '12px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>{SOLAR_PROJECTION_COPY}</p>
          </SheetSection>
        )}

        {/* §4.4-7 — Monthly-bill financial analysis chart (confirm-gated). */}
        {view.showPrices && premium?.charts.monthlyBill && (
          <SheetSection eyebrow="Financial analysis">
            <ChartFigure chart={premium.charts.monthlyBill} />
          </SheetSection>
        )}

        {/* §4.4-8 — Environmental impact (no dollars → pre-confirm OK). */}
        {premium?.environmental && (
          <SheetSection eyebrow="Environmental impact">
            <MetricGrid
              cols={2}
              valueColor="var(--success-bright)"
              items={[
                { k: 'CO₂e avoided / yr', v: `${premium.environmental.tonnes_co2_per_year.toLocaleString('en-AU')} t` },
                { k: 'CO₂e over 20 yrs', v: `${premium.environmental.tonnes_co2_20yr.toLocaleString('en-AU')} t` },
                { k: 'Like planting', v: `${premium.environmental.trees_equiv_per_year.toLocaleString('en-AU')} trees/yr` },
                { k: 'Like not driving', v: `${premium.environmental.km_driven_equiv_per_year.toLocaleString('en-AU')} km/yr` },
              ]}
            />
            <p style={{ margin: '12px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>{SOLAR_ENVIRONMENTAL_COPY}</p>
          </SheetSection>
        )}

        {/* §4.4-9 — Pricing & acceptance (tier cards, confirm-gated). */}
        {view.showPrices && (
          <TierCards
            eyebrow="Choose your option"
            heading="Good · Better · Best"
            intro="All prices include GST. The deposit locks your booking and comes off the final invoice."
            tiers={visibleCards.map<QuoteTier>((c) => {
              const cta = resolveSolarDepositCta({
                confirmed: view.confirmed,
                token,
                tier: c.tier,
                inspectionRequired: view.inspectionRequired,
              })
              const panels = estimate.sizing.tiers.find((t) => t.tier === c.tier)?.panels_count ?? 0
              return {
                name: `${TIER_NAME[c.tier]} · ${c.label}`,
                badge: c.tier === solarHeadlineTierKey ? 'Most popular' : null,
                recommended: c.tier === solarHeadlineTierKey,
                blurb: c.scope,
                priceText: `$${money(c.netIncGst)}`,
                priceNote: 'net inc GST',
                items: [
                  `${kw(c.systemKwDc)} kW · ${panels} panels`,
                  `${kwh(c.annualKwhAc)} kWh/yr · saves $${money(c.annualSavingsAud)}/yr`,
                  `Gross $${money(c.grossIncGst)} − STC $${money(c.stcRebateAud)} (${c.stcCertificates} certs)`,
                  `Payback ${paybackBand(c.paybackLow, c.paybackHigh)}`,
                ],
                ctaLabel: cta.show ? 'Pay deposit' : SOLAR_PRE_CONFIRM_COPY,
                ctaHref: cta.show ? cta.href : null,
              }
            })}
          />
        )}

        {/* ── Explicit "Accept & confirm" (Gap #1/#3): deposit for a confirmed
            estimate, refundable $99 site visit for a held/flagged one. ── */}
        {showSolarAccept ? <AcceptBlock token={token} view={solarAcceptView} /> : null}

        {/* Always-visible assumptions panel — value, source, meaning, direction. */}
        <SheetSection eyebrow="Assumptions — shown, not hidden" eyebrowAccent>
          <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>
            These are the levers behind the savings and payback figures. Each one shows the value we used, where
            it comes from, and which way your numbers move if your household differs.
          </p>
          <div style={{ marginTop: 14, display: 'grid', gap: 1, background: 'var(--ink-line)', border: '1px solid var(--ink-line)' }}>
            {assumptions.rows.map((r) => (
              <AssumptionRow key={r.key} row={r} />
            ))}
          </div>
          <p style={{ margin: '14px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>{assumptions.footnote}</p>
        </SheetSection>

        {/* Mandatory SAA/CEC compliance copy (+ projection disclaimer
            whenever the premium financial sections rendered). */}
        <SheetSection eyebrow="Compliance">
          <p style={{ margin: '12px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-dim)' }}>{SOLAR_COMPLIANCE_COPY}</p>
          {view.showPrices && premium?.financial && (
            <p style={{ margin: '10px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>{SOLAR_PROJECTION_COPY}</p>
          )}
        </SheetSection>

        <CredentialFooter
          rows={[
            ...(row.address ? [{ k: 'Property', v: row.address }] : []),
            ...(row.state ? [{ k: 'State', v: row.state }] : []),
            { k: 'Accreditation', v: 'CEC-accredited installer confirms design on site' },
            { k: 'Terms', v: 'GST included · estimate, not a contract until confirmed by your installer' },
          ]}
          tagline="Estimate confidence shown · Installer confirms on site · Licensed & accredited"
        />
      </QuoteSheet>
    </QuoteChrome>
  )
}

/** One pure-SVG chart (charts.ts) in a bordered, square card with its caption. */
function ChartFigure({ chart }: { chart: SolarChart }) {
  return (
    <figure style={{ margin: '14px 0 0', border: '1px solid var(--ink-line)', background: 'var(--ink-card)', overflow: 'hidden' }}>
      <div
        className="[&>svg]:h-auto [&>svg]:w-full"
        style={{ padding: 14 }}
        dangerouslySetInnerHTML={{ __html: chart.svg }}
      />
      <figcaption style={{ borderTop: '1px solid var(--ink-line)', padding: '10px 14px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
        {chart.caption}
      </figcaption>
    </figure>
  )
}

/**
 * One expandable "why this number?" card. Native <details> keeps the
 * page a pure server component — no client JS, works without hydration.
 * Square-cornered, dark, tuned for the narrow quote sheet.
 */
function ExplainerCard({ explainer }: { explainer: SolarStatExplainer }) {
  return (
    <details className="group" style={{ background: 'var(--ink-card)' }}>
      <summary
        style={{ display: 'flex', cursor: 'pointer', listStyle: 'none', alignItems: 'center', gap: 12, padding: '14px 16px' }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--text-dim)' }}>
            {explainer.statLabel}
          </div>
          <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 800, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
            {explainer.statValue}
          </div>
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-dim)' }}>
          {explainer.question}
        </span>
        <span aria-hidden="true" style={{ fontFamily: 'var(--font-mono)', fontSize: 18, lineHeight: 1, color: 'var(--accent)' }}>
          +
        </span>
      </summary>

      <div style={{ borderTop: '1px solid var(--ink-line)', padding: '16px' }}>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>{explainer.answer}</p>

        {explainer.steps.length > 0 && (
          <ol style={{ margin: '14px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
            {explainer.steps.map((step, i) => (
              <li key={i} style={{ display: 'flex', gap: 12 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, lineHeight: 1.4, color: 'var(--accent)' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>{step}</span>
              </li>
            ))}
          </ol>
        )}

        {explainer.facts.length > 0 && (
          <dl style={{ margin: '14px 0 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--ink-line)', border: '1px solid var(--ink-line)' }}>
            {explainer.facts.map((f) => (
              <div key={f.label} style={{ background: 'var(--ink-deep)', padding: '10px 12px' }}>
                <dt style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.11em', color: 'var(--text-dim)' }}>
                  {f.label}
                </dt>
                <dd style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--text-pri)', fontVariantNumeric: 'tabular-nums' }}>
                  {f.value}
                </dd>
                {f.note && <dd style={{ margin: '2px 0 0', fontSize: 11, lineHeight: 1.4, color: 'var(--text-dim)' }}>{f.note}</dd>}
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
  )
}

/** One transparent assumption: value, source, meaning, direction of effect. */
function AssumptionRow({ row }: { row: SolarAssumptionRow }) {
  return (
    <div style={{ display: 'grid', gap: 12, background: 'var(--ink-deep)', padding: '14px 16px' }}>
      <div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--text-dim)' }}>
          {row.label}
        </div>
        <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 14.5, fontWeight: 700, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
          {row.value}
        </div>
        <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 8.5, textTransform: 'uppercase', lineHeight: 1.5, letterSpacing: '0.11em', color: 'var(--text-dim)' }}>
          Source · {row.source}
        </div>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55 }}>
        <p style={{ margin: 0, color: 'var(--text-sec)' }}>{row.meaning}</p>
        <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.11em', color: 'var(--teal-glow)' }}>
            If it moves ·{' '}
          </span>
          {row.sensitivity}
        </p>
      </div>
    </div>
  )
}
