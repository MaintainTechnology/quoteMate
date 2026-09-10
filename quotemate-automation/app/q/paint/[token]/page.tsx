// Public, read-only residential painting quote (spec R11/R21).
// Token = painting_measurements.public_token — unguessable, same trust model
// as /q/[token]. Service-role read because this is a public sharing surface.
//
// Renders the deterministic PaintingEstimate (lib/painting/types.ts) on the
// shared QuoteMax quote chrome (app/q/_chrome/*) — scopes, derived paintable
// area, and the three price tiers as inc-GST RANGES (the estimate is a band,
// not a point).
//
// TWO layouts (spec painting-held-view-parity R1, amending painting-funnel-
// parity R1): EVERY state renders the five-numbered-section format roofing
// (/q/roof/[token]) and electrical/plumbing (/q/[token]) use — Overview →
// Job details → Your tradie → Your price → Next steps — and ?full=1 forces
// the long-scroll layout in any state (roofing's escape hatch, the only way
// the branch at the bottom of this file is now reached). Painting is
// review-required, so the page the quote SMS lands on is almost always the
// HELD state; it used to take the long-scroll branch, which has no
// TrustVideo, so the customer never saw the tradie video until the painter
// pressed Send. A held row now gets the same five sections with the
// publish-gate holding message in 04 and no payable action anywhere.
// Decisions: lib/painting/quote-view.ts (pure).
//
// Payment (spec painting-site-visit-first, owner decision 2026-08-05): the
// ONLY customer payment is the flat $99 refundable site visit
// (/r/paint/<token>/inspection), framed as a site visit and booked after
// paying — exactly roofing's model. Tier prices remain visible as pricing
// information (the final price is confirmed on site), but no surface on this
// page links the retired 30% per-tier deposit mints. A paid quote shows a
// confirmed state.

import type { CSSProperties, ReactNode } from 'react'
import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import { QuoteUnavailable } from '@/app/q/_chrome/QuoteUnavailable'
import { quoteReadFailure } from '@/lib/quote/read-failure'
import type { PaintingEstimate, PaintScope, PaintingPriceTier } from '@/lib/painting/types'
import { composePaintLocation } from '@/lib/painting/paint-after'
import { customerTakeoff } from '@/lib/painting/takeoff'
import { customerMeasurementNotes } from '@/lib/painting/customer-notes'
import {
  buildStreetViewMetadataUrl,
  parseStreetViewMetadata,
} from '@/lib/painting/streetview'
import { asQuoteTierMode, resolveVisibleTiers, type QuoteTierMode } from '@/lib/quote/tier-visibility'
import { canShowPaintingPrices } from '@/lib/painting/publish-gate'
import { paintHeldForReview, paintQuotePayable, paintQuoteViewMode } from '@/lib/painting/quote-view'
import {
  loadTenantIdentity,
  contactDisplayName,
  safeWebsiteUrl,
  trustVideoTrack,
} from '@/lib/quote/tenant-identity'
import { tradieProfile } from '@/lib/quote/tradie-profile'
import { QuoteChrome, type StickyBar } from '../../_chrome/QuoteChrome'
import { RepaintPreviewFigure } from '../../_chrome/RepaintPreviewFigure'
import { TradieJobBanner } from '../../_chrome/TradieJobBanner'
import { AcceptBlock } from '../../_chrome/AcceptBlock'
import { resolveAcceptView } from '@/lib/quote/accept'
import { formatVisitSlot } from '@/lib/quote/trade-booking'
import { visitCalendarLinks } from '@/lib/quote/calendar-links'
import { tzForState } from '@/lib/quote/availability'
import { INSPECTION_FEE_AUD } from '@/lib/quote/money'
import { tradeIcon } from '../../_chrome/icons'
import { NoSlotsNotice } from '../../_chrome/NoSlotsNotice'
import {
  QuoteSheet, Letterhead, QuoteHero, StatGrid, Scope,
  SheetSection, TierCards, CredentialFooter, TrustVideo, TradiePhoto, AddToCalendar,
  type QuoteTier, type Stat, type FooterRow, type ScopeItem,
} from '../../_chrome/parts'

export const dynamic = 'force-dynamic'

/** Primary yellow CTA into the booking / thank-you pages. Dark ink on the
 *  accent — white on yellow is ~1.4:1 and forbidden. */
const PAINT_CTA_LINK = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  border: '1px solid transparent',
  background: 'var(--accent)',
  color: 'var(--accent-ink)',
  padding: '13px 20px',
  fontFamily: 'var(--font-sans)',
  fontWeight: 700,
  fontSize: 13,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  textDecoration: 'none',
} as const

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const aud = (n: number) =>
  '$' + Math.round(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

const SCOPE_LABEL: Record<PaintScope, string> = {
  walls: 'Walls',
  ceilings: 'Ceilings',
  trim: 'Trim & doors',
  exterior: 'Exterior',
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export default async function PaintingQuotePage(props: {
  params: Promise<{ token: string }>
  /** ?slots=0 — set by /r/paint when it REFUSED to charge because the painter
   *  has published no bookable windows. Renders NoSlotsNotice so the refusal
   *  isn't silent. ?full=1 — force the long-scroll layout (roofing's escape
   *  hatch, spec painting-funnel-parity R1). */
  searchParams: Promise<{ slots?: string; full?: string }>
}) {
  const { token } = await props.params
  const sp = await props.searchParams
  const noSlots = sp.slots === '0'

  const { data: row, error: quoteError } = await supabase
    .from('painting_measurements')
    .select(
      'address, postcode, state, scopes, confidence, routing, estimate, public_token, customer_name, created_at, tenant_id, preview_status, released_at, paid_at, paid_tier, scheduled_at, scheduled_window, tenants:tenant_id(business_name)',
    )
    .eq('public_token', token)
    .maybeSingle()

  if (quoteError) return <QuoteUnavailable correlationId={quoteReadFailure('paint', quoteError)} />
  if (!row) notFound()
  if (!row.estimate) return <QuoteUnavailable correlationId={quoteReadFailure('paint', { code: 'MISSING_ESTIMATE' })} />
  if (!row || !row.estimate) {
    return (
      <QuoteChrome trade={{ label: 'Paint', icon: tradeIcon('paint') }} sticky={null}>
        <QuoteSheet>
          <SheetSection eyebrow="Invalid link" eyebrowAccent first>
            <h1
              style={{
                margin: '14px 0 0',
                fontFamily: 'var(--font-sans)',
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '-0.02em',
                fontSize: 28,
                lineHeight: 1,
                color: 'var(--text-pri)',
              }}
            >
              Quote not found
            </h1>
            <p style={{ margin: '14px 0 0', fontSize: 14, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              This quote link is invalid or has expired. Text us if you need it re-sent.
            </p>
          </SheetSection>
        </QuoteSheet>
      </QuoteChrome>
    )
  }

  const business =
    (row.tenants as { business_name?: string } | null)?.business_name ?? 'Your painter'

  // Tradie identity for the letterhead (logo + Contact / Phone / Email),
  // matching the reference quote surface. Best-effort: degrades to the joined
  // business_name when identity columns are absent or tenant_id is null.
  const identity = await loadTenantIdentity(
    supabase,
    (row as { tenant_id?: string | null }).tenant_id ?? null,
  )

  const estimate = row.estimate as PaintingEstimate
  const tiers: PaintingPriceTier[] = estimate.price?.tiers ?? []
  const measurement = estimate.measurement
  const scopes = (row.scopes as PaintScope[] | null) ?? estimate.measurement?.surfaces?.map((s) => s.scope) ?? []
  const inspection = estimate.price?.routing?.decision === 'inspection_required'

  // Mig 142 — per-feature tier presentation mode. Residential painting has no
  // quotes.selected_tier, so 'single' resolves to the Better (2-coat) baseline.
  let paintTierMode: QuoteTierMode = 'single'
  if (row.tenant_id) {
    const { data: pb } = await supabase
      .from('pricing_book')
      .select('quote_tier_mode')
      .eq('tenant_id', row.tenant_id as string)
      .eq('trade', 'painting')
      .maybeSingle()
    paintTierMode = asQuoteTierMode(
      (pb as { quote_tier_mode?: string | null } | null)?.quote_tier_mode,
    )
  }
  const visibleTierKeys = resolveVisibleTiers({
    mode: paintTierMode,
    present: {
      good: tiers.some((t) => t.tier === 'good'),
      better: tiers.some((t) => t.tier === 'better'),
      best: tiers.some((t) => t.tier === 'best'),
    },
    selectedTier: 'better',
  })
  const visibleTiers = tiers.filter((t) => visibleTierKeys.includes(t.tier))

  // Release is required authority for the saved price, so it shares the
  // checked estimate read above. A missing column or failed read cannot
  // turn a held draft into a customer-visible offer.
  const paid = !!row.paid_at
  const paidTier = (row.paid_tier as string | null) ?? null
  const paintScheduledAt = (row.scheduled_at as string | null) ?? null
  const paintScheduledWindow = (row.scheduled_window as string | null) ?? null
  const released = row.released_at != null

  // Self-serve visit booking (mig 167) now happens on /q/paint/<token>/book,
  // which loads the painter's open windows itself — this page only links to it,
  // so no booking query runs here at all.
  const priceGate = canShowPaintingPrices({ releasedAt: released ? 'released' : null })

  const date = new Date(row.created_at as string).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const showTiers = !inspection && priceGate.showPrices
  const source = estimate.facts?.source ?? 'property data'

  // ─── Stat grid — up to 4 truthful cells from data that exists ─────────
  const statItems: Stat[] = []
  if (measurement) {
    statItems.push({ k: 'Floor area', v: `${Math.round(measurement.floor_area_m2)} m²` })
    statItems.push({ k: 'Paintable area', v: `${Math.round(estimate.price?.total_area_m2 ?? 0)} m²` })
    if (measurement.storeys != null) {
      statItems.push({ k: 'Storeys', v: String(measurement.storeys) })
    }
    statItems.push({
      k: 'Confidence',
      v: titleCase(String(row.confidence ?? measurement.confidence ?? '—')),
    })
  }

  // ─── Scope of works — surfaces measured + About-your-home facts ───────
  const scopeItems: ScopeItem[] = []
  const surfaces = Array.isArray(measurement?.surfaces) ? measurement.surfaces : []
  if (scopes.length > 0 || surfaces.length > 0) {
    scopeItems.push({
      title: 'Surfaces to paint',
      body:
        scopes.length > 0
          ? scopes.map((s) => SCOPE_LABEL[s] ?? s).join(' · ')
          : undefined,
      list:
        surfaces.length > 0
          ? surfaces.map((s) => (
              <span key={s.scope}>
                {SCOPE_LABEL[s.scope] ?? s.scope} —{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  {Math.round(s.quantity)} {s.unit === 'lm' ? 'lm' : 'm²'}
                </span>
              </span>
            ))
          : undefined,
    })
  }
  const facts = estimate.facts
  const homeList: string[] = []
  if (facts?.property_type) homeList.push(`Type — ${facts.property_type}`)
  if (facts?.bedrooms != null) homeList.push(`Bedrooms — ${facts.bedrooms}`)
  if (facts?.bathrooms != null) homeList.push(`Bathrooms — ${facts.bathrooms}`)
  if (facts?.car_spaces != null) homeList.push(`Car spaces — ${facts.car_spaces}`)
  if (facts?.land_size_m2 != null) homeList.push(`Land size — ${Math.round(facts.land_size_m2)} m²`)
  if (homeList.length > 0) {
    scopeItems.push({ title: 'About your home', list: homeList })
  }

  // ─── Tier cards — pricing INFORMATION only (spec painting-site-visit-first
  //     R1): the one payment is the $99 site visit, carried by the sticky bar
  //     and the accept block, so no card links a mint. On a legacy row whose
  //     tier deposit was paid, the paid tier keeps its ✓. ───
  const quoteTiers: QuoteTier[] = visibleTiers.map((tier) => {
    const paidThis = paid && paidTier === tier.tier
    return {
      name: tier.label,
      blurb: tier.scope,
      priceText: aud(tier.inc_gst),
      priceNote: `inc GST · ${aud(tier.inc_gst_low)}–${aud(tier.inc_gst_high)}`,
      ctaLabel: paid
        ? paidThis
          ? 'Deposit paid ✓'
          : 'Payment received'
        : 'Final price confirmed on site',
      ctaHref: null,
    }
  })

  // ─── Sticky bar — pins the $99 site visit for every unpaid actionable row
  //     (released or inspection-routed); a HELD row pins nothing. ───
  const featured =
    visibleTiers.find((t) => t.tier === 'better') ?? visibleTiers[0] ?? null
  let stickyBar: StickyBar | null = null
  if (paid) {
    stickyBar = {
      paid: true,
      // paid_tier 'inspection' = the $99 site visit; a named tier only ever
      // comes from a legacy per-tier deposit payment.
      paidSub:
        paidTier === 'inspection'
          ? 'Site visit paid — your painter will be in touch'
          : paidTier
            ? `${titleCase(paidTier)} option — your painter will be in touch`
            : 'Your painter will be in touch',
    }
  } else if (showTiers || inspection) {
    stickyBar = {
      tierLabel: `$${INSPECTION_FEE_AUD} site visit · refundable`,
      priceText: `$${INSPECTION_FEE_AUD}`,
      ctaLabel: `Pay $${INSPECTION_FEE_AUD}`,
      ctaHref: `/r/paint/${token}/inspection`,
    }
  }

  // ─── Credential footer — only rows whose data genuinely exists ────────
  const footerRows: FooterRow[] = []
  footerRows.push({ k: 'Painter', v: business })
  if (row.address) {
    footerRows.push({
      k: 'Property',
      v: [String(row.address), [row.postcode, row.state].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', '),
    })
  }
  footerRows.push({ k: 'Prepared', v: date })
  footerRows.push({
    k: 'Terms',
    v: `Prices are inc-GST estimates derived from ${source} and your declared scope. The final price is confirmed after a quick on-site check.`,
  })

  // Clean street / suburb headline: drop a trailing "<STATE> <POSTCODE>" so the
  // accent line isn't a redundant "4151 QLD" echo of the address in line 1.
  const rawAddr = String(row.address ?? 'Your property')
  const cleanAddr =
    rawAddr.replace(/,?\s*(QLD|NSW|VIC|SA|WA|TAS|NT|ACT)\b\s*\d{4}\s*$/i, '').trim() || rawAddr
  const addrSegs = cleanAddr.split(',').map((s) => s.trim()).filter(Boolean)
  const heroLine1 = addrSegs.length >= 2 ? `${addrSegs.slice(0, -1).join(', ')},` : cleanAddr
  const heroLine2 = addrSegs.length >= 2 ? addrSegs[addrSegs.length - 1] : undefined

  // Explicit "Accept & confirm" block (Gap #1/#3). Painting's only customer
  // payment is the flat $99 refundable site visit (spec
  // painting-site-visit-first R1), so EVERY unpaid actionable quote —
  // released-priced or inspection-routed — resolves to resolveAcceptView's
  // inspection mode ("Accept & book $99 site visit", credited toward the
  // final quote) at /r/paint/<token>/inspection. pricesVisible is pinned
  // false to make the deposit branch unreachable: the tier prices above are
  // information, not a payable offer. Both layouts gate the block on
  // showPaintAccept — released-unpaid, inspection-routed-unpaid and paid rows
  // only. A HELD quote shows no accept CTA at all, in either layout.
  const paintAcceptView = resolveAcceptView({
    token,
    tier: (featured?.tier ?? 'better') as 'good' | 'better' | 'best',
    isPaid: paid,
    pricesVisible: false,
    priceExpired: false,
    priceLabel: featured ? `${aud(featured.inc_gst)} inc GST` : null,
    inspectionHref: `/r/paint/${token}/inspection`,
  })
  // Derived from lib/painting/quote-view.ts, NOT restated here: heldView is
  // its exact complement, so the holding copy and a payment CTA can never
  // render together. Restating it inline is how the two could drift.
  const showPaintAccept = paintQuotePayable({ released, paid, inspection })

  const heroStatus: { label: string; tone: 'await' | 'booked' } = paid
    ? { label: 'Payment received', tone: 'booked' }
    : inspection
      ? { label: 'On-site measure', tone: 'await' }
      : { label: 'Awaiting you', tone: 'await' }
  // Property imagery (spec quote-visual-parity R3) — FREE Street View metadata
  // check at render so the section only appears when Google actually has a
  // pano here (no broken frames; mirrors /p/[token]). The AI repaint
  // AUTO-generates on first load (product decision 2026-07-11); the
  // after-image route's released_at gate still means a held draft can never
  // bill a Gemini render.
  let hasPano = false
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY
  if (mapsKey && row.address) {
    try {
      const metaRes = await fetch(
        buildStreetViewMetadataUrl(
          {
            location: composePaintLocation({
              address: String(row.address),
              postcode: (row.postcode as string | null) ?? null,
              state: (row.state as string | null) ?? null,
            }),
          },
          { apiKey: mapsKey },
        ),
      )
      hasPano = parseStreetViewMetadata(await metaRes.json().catch(() => null)).ok
    } catch {
      /* best-effort — page renders without the imagery section */
    }
  }
  const afterImageReady = (row.preview_status as string | null) === 'ready'

  // ── Property imagery via the token-gated /api/painting/q/[token] proxies
  //    (spec quote-visual-parity R3; mirrors /p/[token]). Top row: the real
  //    photos (Street View frontage + aerial). Below: the before/after repaint
  //    block with the colour picker. Extracted as an inner fragment so BOTH
  //    layouts render the identical block — the long-scroll "Your property"
  //    section and the five-section "Job details" body (R1). ──
  const imageryInner: ReactNode = hasPano ? (
    <>
      <div
        style={{
          display: 'grid',
          gap: 14,
          marginTop: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        }}
      >
        <figure style={{ margin: 0, border: '1px solid var(--ink-line)', background: 'var(--ink-card)' }}>
          {/* The source photo is 4:3 — an aspect-ratio box shows the
              whole property instead of a fixed-height crop. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/painting/q/${row.public_token}/street-view`}
            alt={`Street View of the front of ${row.address ?? 'the property'}`}
            style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', display: 'block' }}
          />
          <figcaption
            style={{
              borderTop: '1px solid var(--ink-line)',
              padding: '10px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: 'var(--text-dim)',
            }}
          >
            Front of the property · Google Street View
          </figcaption>
        </figure>
        <figure style={{ margin: 0, border: '1px solid var(--ink-line)', background: 'var(--ink-card)' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/painting/q/${row.public_token}/static-map`}
            alt={`Aerial view of ${row.address ?? 'the property'}`}
            style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', display: 'block' }}
          />
          <figcaption
            style={{
              borderTop: '1px solid var(--ink-line)',
              padding: '10px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: 'var(--text-dim)',
            }}
          >
            Aerial view · Google Maps
          </figcaption>
        </figure>
      </div>
      <div style={{ marginTop: 14 }}>
        <RepaintPreviewFigure
          publicToken={row.public_token}
          address={row.address}
          initialReady={afterImageReady}
          released={released}
        />
      </div>
    </>
  ) : null
  // Customer-safe take-off (quantities + time on site, no internal costs),
  // limited to the tiers this quote actually shows.
  const customerTiers = customerTakeoff(estimate.takeoff).filter((c) =>
    visibleTierKeys.includes(c.tier),
  )
  // Customer-safe price derivation (mirrors the PDF's "How your price was
  // built" table). The rates shown are the CHARGE side of the quote —
  // internal costs and margin never render on customer surfaces. Suppressed
  // after a manual tier edit: the derivation would no longer reconcile with
  // the hand-set headline prices.
  const bd0 = estimate.price?.breakdown
  const breakdown =
    !estimate.price?.manual_override && bd0 && (bd0.surfaces?.length ?? 0) > 0 ? bd0 : null
  const measuredNotes = customerMeasurementNotes(measurement?.notes)

  // ── "How your price was built" inner content — customer-safe derivation.
  //    Each row is the already-computed ex-GST cost of a measured surface
  //    (rates, coats, prep and colour allowance are baked into that cost), so
  //    the surface costs sum EXACTLY to the subtotal — no separate multiplier
  //    step (that would double-count). Tier-relation rows are shown only when
  //    the call-out floor did not override them. Same content as the PDF table
  //    (lib/painting/report-html.ts). Extracted as an inner fragment so both
  //    layouts (long-scroll section / five-section "Your price" body) render
  //    the identical block. ──
  const priceBuildInner: ReactNode = breakdown ? (() => {
    const tierLabel = (k: 'good' | 'better' | 'best') =>
      tiers.find((t) => t.tier === k)?.label
    const betterLabel = tierLabel('better') ?? 'Better'
    // Small-job floor overrides the surface-derived tier prices, so the
    // "= Better × N%" rows would no longer reconcile — suppress them.
    const floorApplied = !!estimate.price?.call_out_minimum_applied
    const rows: Array<{ k: string; v: string; strong?: boolean }> = []
    for (const s of breakdown.surfaces) {
      const unit = s.unit === 'lm' ? 'lm' : 'm²'
      rows.push({
        k: `${SCOPE_LABEL[s.scope] ?? titleCase(String(s.scope))} · ${Math.round(s.quantity)} ${unit}`,
        v: aud(s.line_ex_gst),
      })
    }
    if (Number.isFinite(breakdown.better_ex_gst)) {
      rows.push({ k: 'Subtotal (ex GST)', v: aud(breakdown.better_ex_gst), strong: true })
    }
    if (!floorApplied && visibleTierKeys.includes('good') && tierLabel('good') && Number.isFinite(breakdown.good_refresh_fraction)) {
      rows.push({
        k: `${tierLabel('good')} = ${betterLabel} ×`,
        v: `${Math.round(breakdown.good_refresh_fraction * 100)}%`,
      })
    }
    if (!floorApplied && visibleTierKeys.includes('best') && tierLabel('best') && Number.isFinite(breakdown.premium_uplift_pct)) {
      rows.push({
        k: `${tierLabel('best')} = ${betterLabel} ×`,
        v: `${Math.round((1 + breakdown.premium_uplift_pct) * 100)}%`,
      })
    }
    if (Number.isFinite(breakdown.gst_factor) && breakdown.gst_factor > 1) {
      rows.push({ k: 'GST', v: `+ ${Math.round((breakdown.gst_factor - 1) * 100)}%` })
    }
    if (floorApplied && Number.isFinite(breakdown.call_out_minimum_ex_gst) && breakdown.call_out_minimum_ex_gst > 0) {
      rows.push({ k: 'Call-out minimum applied', v: aud(breakdown.call_out_minimum_ex_gst) })
    }
    const loadings = estimate.price?.loadings_applied ?? []
    return (
      <>
        <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>
          Your {betterLabel} price is the sum of each measured surface below. Each cost
          already includes the coats, surface preparation and prep consumables (filler,
          caulk, tape and drop sheets); headline prices above include GST.
        </p>
        <div style={{ marginTop: 14, border: '1px solid var(--ink-line)', background: 'var(--ink-card)', padding: '6px 16px' }}>
          {rows.map((r, i) => (
            <div
              key={`${r.k}-${i}`}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                gap: 12,
                padding: '9px 0',
                borderTop: i === 0 ? 'none' : '1px solid var(--ink-line)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                color: r.strong ? 'var(--text-pri)' : 'var(--text-sec)',
                fontWeight: r.strong ? 600 : 400,
              }}
            >
              <span>{r.k}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: r.strong ? 'var(--accent)' : 'var(--text-pri)' }}>
                {r.v}
              </span>
            </div>
          ))}
        </div>
        {loadings.length > 0 ? (
          <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-sec)' }}>
            {loadings.map((l) => (
              <div key={l.code}>+ {l.detail}</div>
            ))}
          </div>
        ) : null}
      </>
    )
  })() : null

  // "How we measured" list — provenance bullets shared by both layouts.
  const measuredNotesList: ReactNode = measuredNotes.length > 0 ? (
    <ul style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: 'var(--text-sec)' }}>
      {measuredNotes.map((n) => (
        <li key={n}>{n}</li>
      ))}
      <li>A painter confirms all measurements on site before works commence.</li>
    </ul>
  ) : null

  // ── "Materials & time on site" inner content — the CUSTOMER-safe take-off
  //    view: paint quantities and duration per option. Internal costs, rates
  //    and margin never render on customer surfaces. Shared by both layouts. ──
  const materialsInner: ReactNode = customerTiers.length > 0 ? (
    <>
      <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-sec)' }}>
        What each option uses on your property — litres round up to whole retail packs, and
        time on site is an estimate at standard working days, confirmed before works commence.
      </p>
      <div
        style={{
          display: 'grid',
          gap: 12,
          marginTop: 14,
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        }}
      >
        {customerTiers.map((c) => {
          const tierLabel = visibleTiers.find((t) => t.tier === c.tier)?.label ?? c.tier
          return (
            <div
              key={c.tier}
              style={{ border: '1px solid var(--ink-line)', background: 'var(--ink-card)', padding: '14px 16px' }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.14em',
                  color: 'var(--accent)',
                }}
              >
                {tierLabel}
              </div>
              <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none' }}>
                {c.materials.map((m) => (
                  <li
                    key={m}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: 'var(--text-sec)',
                    }}
                  >
                    {m}
                  </li>
                ))}
              </ul>
              <div
                style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: '1px solid var(--ink-line)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--text-pri)',
                }}
              >
                {c.time_on_site}
              </div>
            </div>
          )
        })}
      </div>
    </>
  ) : null

  const heroGreeting = inspection
    ? (estimate.price?.routing?.reason ??
        'This job needs a quick on-site measure before we can lock a price. Book your $99 refundable site visit below.')
    : !priceGate.showPrices
      ? priceGate.reason
      : visibleTiers.length === 1
        ? 'One painting option below — all prices include 10% GST as an estimated range.'
        : 'Your painting options below — all prices include 10% GST as an estimated range.'

  // ═══ Five-section customer view (spec painting-held-view-parity R1) ═══
  //
  // Every state renders the same five-numbered-section format as roofing
  // (/q/roof/[token]:659) and electrical/plumbing (/q/[token]
  // usesGenericCard): Overview → Job details → Your tradie → Your price →
  // Next steps. ?full=1 forces the long-scroll layout below. Presentation
  // only — every block reuses the data and gate logic computed above.
  //
  // heldView is the ONE predicate the publish gate rides on inside this
  // branch: sections 04 and 05 take their holding-message arms and the
  // AcceptBlock is suppressed, so a held row shows no price, no deposit link
  // and no accept CTA — content-equivalent to the long-scroll held view it
  // replaces, plus section 03's tradie video (the whole point of the fix).
  // It is the exact complement of showPaintAccept / the sticky-bar gate, both
  // of which already resolve to "nothing payable" for a held row.
  const viewMode = paintQuoteViewMode({
    released,
    paid,
    inspection,
    fullParam: sp.full === '1',
  })
  const heldView = paintHeldForReview({ released, paid, inspection })
  if (viewMode === 'five') {
    // Video + the script it speaks, resolved together so the captions can
    // never belong to a different film than the one playing. The 'painting'
    // argument is load-bearing: the dashboard Videos tab stores the clip at
    // tenants.trade_videos[trade][slot] (mig 179), and with the trade omitted
    // every tenant fell through to the stock QuoteMax clip — see the note at
    // app/q/roof/[token]/page.tsx.
    const welcomeVideo = trustVideoTrack(identity, 'welcome', 'painting')
    const websiteUrl = safeWebsiteUrl(identity?.website_url)
    const tradieName = identity?.business_name ?? business
    // Section 03 identity — the same resolver the quote PDF uses, so the
    // photo and the sentence are identical on both surfaces (mig 180).
    const paintTradie = tradieProfile({
      businessName: tradieName,
      photoUrl: identity?.photo_url,
      trade: 'painting',
    })
    const tz = tzForState(identity?.state ?? null)
    const slotLabel = paintScheduledAt
      ? formatVisitSlot(paintScheduledAt, paintScheduledWindow, tz)
      : ''
    const calLinks =
      paid && paintScheduledAt
        ? visitCalendarLinks({
            scheduledAt: paintScheduledAt,
            scheduledWindow: paintScheduledWindow,
            tradieName,
            slotLabel,
            // Raw address, not the postcode/state echo — the stored address
            // already carries the state.
            location: (row.address as string | null)?.trim() || null,
            timeZone: tz,
          })
        : null

    const microNote: CSSProperties = {
      fontFamily: 'var(--font-mono)',
      fontSize: 9.5,
      textTransform: 'uppercase',
      letterSpacing: '0.12em',
      color: 'var(--text-dim)',
    }
    const subHeading: CSSProperties = {
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.14em',
      color: 'var(--text-pri)',
      margin: 0,
    }
    // Scope's body cell sets white-space: pre-line for plain-text bodies.
    // These bodies are structured JSX, where pre-line turns every source-code
    // newline into rendered whitespace.
    const blockBody: CSSProperties = {
      display: 'grid',
      gap: 20,
      maxWidth: 560,
      whiteSpace: 'normal',
    }

    const firstName =
      ((row.customer_name as string | null) ?? '').trim().split(/\s+/)[0] || null
    // Overview ORIENTS (the QuoteHero content in a sentence); the sections
    // below carry the detail. State-aware so a paid visitor isn't told to
    // book and an inspection-routed one isn't promised "we'll be in touch"
    // now that the visit is self-serve bookable.
    const fiveGreeting = paid
      ? paintScheduledAt
        ? 'Your visit is booked — the details are below.'
        : 'Payment received — pick your visit time below.'
      : inspection
        ? `${
            estimate.price?.routing?.reason ??
            'This job needs a quick on-site measure before we can lock a price.'
          } Book your site visit below and your painter confirms everything in person.`
        : heroGreeting

    // Section 02 checklist — the measured surfaces + About-your-home facts
    // already built for the long-scroll Scope, flattened to bullets.
    const jobDetailList: ReactNode[] = scopeItems.flatMap((si) => si.list ?? [])

    const paintSections: ScopeItem[] = [
      {
        title: 'Overview',
        body: (
          <div style={blockBody}>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              G&apos;day{firstName ? ` ${firstName}` : ''}, here&apos;s your painting quote
              {cleanAddr ? ` for ${cleanAddr}` : ''}, issued {date}. {fiveGreeting}
            </p>
          </div>
        ),
      },
      {
        title: 'Job details',
        body: (
          <div style={blockBody}>
            {statItems.length > 0 ? <StatGrid items={statItems} /> : null}
            {scopes.length > 0 ? (
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-sec)' }}>
                Surfaces to paint — {scopes.map((s) => SCOPE_LABEL[s] ?? s).join(' · ')}.
              </p>
            ) : null}
            {imageryInner ? (
              <div>
                <p style={subHeading}>Your property</p>
                {imageryInner}
              </div>
            ) : null}
            {measuredNotesList ? (
              <div>
                <p style={subHeading}>How we measured</p>
                {measuredNotesList}
              </div>
            ) : null}
          </div>
        ),
        list: jobDetailList.length > 0 ? jobDetailList : undefined,
      },
      {
        title: 'Your tradie',
        body: (
          <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
            <div className="qm-print-hide">
              <TrustVideo
                src={welcomeVideo.url}
                script={welcomeVideo.script}
                title={tradieName}
                caption="A short introduction from your tradie"
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <TradiePhoto src={paintTradie.photoSrc} alt={paintTradie.name} />
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-sec)' }}>
                {paintTradie.blurb}
                {websiteUrl ? (
                  <>
                    {' '}
                    <a href={websiteUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                      Visit their website
                    </a>
                    .
                  </>
                ) : null}
              </p>
            </div>
          </div>
        ),
      },
      {
        title: 'Your price',
        body: inspection ? (
          // No committable tiers — the $99 refundable site visit IS the price
          // (mirrors the generic page's inspection body).
          <div style={blockBody}>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 800,
                  fontSize: 24,
                  lineHeight: 1,
                  color: 'var(--text-pri)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                ${INSPECTION_FEE_AUD}
              </div>
              <div style={{ marginTop: 6, ...microNote }}>Site visit · refundable</div>
              <p style={{ margin: '10px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-dim)', maxWidth: '52ch' }}>
                {estimate.price?.routing?.reason
                  ? `Why a visit: ${estimate.price.routing.reason}`
                  : 'Every home is different, so this job is priced in person rather than sight-unseen.'}{' '}
                The visit fee is credited toward your final quote.
              </p>
            </div>
          </div>
        ) : heldView ? (
          // HELD for review — the publish-gate holding message stands in for
          // the whole price block (spec painting-held-view-parity R2). Same
          // content as the long-scroll "Quote being finalised" SheetSection:
          // no tier figures, no derivation table, no deposit or site-visit
          // CTA, no PDF link. TierCards is unreachable from here.
          <div style={blockBody}>
            <div>
              <p style={subHeading}>Awaiting painter review</p>
              <p style={{ margin: '12px 0 0', fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
                {priceGate.reason}
              </p>
            </div>
          </div>
        ) : showTiers && quoteTiers.length > 0 ? (
          <div style={blockBody}>
            <TierCards
              heading={visibleTiers.length === 1 ? 'Your painting option' : 'Your painting options'}
              intro={`Prices are inc-GST estimates derived from ${source} and your declared scope. The final price is confirmed after a quick on-site check.`}
              tiers={quoteTiers}
            />
            {priceBuildInner ? (
              <div>
                <p style={subHeading}>How your price was built</p>
                {priceBuildInner}
              </div>
            ) : null}
            {materialsInner ? (
              <div>
                <p style={subHeading}>Materials &amp; time on site</p>
                {materialsInner}
              </div>
            ) : null}
          </div>
        ) : (
          // Defensive: paid/released without renderable tiers — never crash a
          // live public page over pruned tier data.
          'Your painter will confirm your price with you directly.'
        ),
      },
      {
        // Every unpaid ACTIONABLE path books the SITE VISIT (spec painting-
        // site-visit-first R1) — the $99 refundable visit is the payment,
        // never a "book your job" deposit. A held row books nothing at all:
        // it is not payable (/r/paint 302s it straight back here), so the
        // section never names a price or invites one.
        title: heldView ? 'Next steps' : paid && paintScheduledAt ? 'Your visit' : 'Book your site visit',
        // The thank-you video + calendar live on the dedicated /book and
        // /thanks pages. Here we only confirm the booked state, point a
        // paid-but-unbooked customer to the booking page, frame the accept
        // action below, or — held — say we'll text them when it's ready.
        body:
          heldView ? (
            <div style={{ display: 'grid', gap: 10, maxWidth: 480 }}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
                Your draft is saved. {tradieName} needs to review and approve it before
                the prices and booking options can be shared.
              </p>
              <span style={microNote}>Awaiting painter approval</span>
            </div>
          ) : paid && paintScheduledAt ? (
            <div style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
                Your visit is booked for{' '}
                <strong style={{ color: 'var(--text-pri)' }}>{slotLabel}</strong>
                . {tradieName} will text you the day before to confirm.
              </p>
              {calLinks ? (
                <AddToCalendar
                  google={calLinks.google}
                  outlook={calLinks.outlook}
                  outlookOffice={calLinks.outlookOffice}
                  icsHref={`/q/paint/${token}/visit.ics`}
                />
              ) : null}
              <a href={`/q/paint/${token}/thanks`} className="qm-cta" style={PAINT_CTA_LINK}>
                View your booking →
              </a>
            </div>
          ) : paid ? (
            <div style={{ display: 'grid', gap: 10, maxWidth: 380 }}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
                Payment received. Pick a time that suits and your visit is locked in.
              </p>
              <a href={`/q/paint/${token}/book`} className="qm-cta" style={PAINT_CTA_LINK}>
                Pick your visit time →
              </a>
            </div>
          ) : noSlots ? (
            // /r/paint refused to charge — no windows published. Explain it
            // rather than repeating the CTA that just bounced them.
            <NoSlotsNotice tradieName={identity?.business_name ?? null} />
          ) : inspection ? (
            // No CTA here on purpose — the AcceptBlock below is the ONE
            // action band on this page (it records customer_accepted_at
            // before routing to Stripe).
            <div style={{ display: 'grid', gap: 10, maxWidth: 480 }}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
                Your painter prices this one in person. Book the ${INSPECTION_FEE_AUD} site
                visit below and you pick your time straight after paying — the fee is
                refundable and credited toward your final quote.
              </p>
              <span style={microNote}>Takes about 30 minutes on site</span>
            </div>
          ) : (
            // Released prices are information — the payment is still the $99
            // site visit (spec painting-site-visit-first R1). The AcceptBlock
            // below stays the ONE action band on this page.
            <div style={{ display: 'grid', gap: 10, maxWidth: 480 }}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
                Happy with your options? Book the ${INSPECTION_FEE_AUD} site visit below and
                you pick your time straight after paying — the fee is refundable, credited
                toward your final quote, and your painter confirms the final price on site.
              </p>
              <span style={microNote}>Takes about 30 minutes on site</span>
            </div>
          ),
      },
    ]

    return (
      // The shared sticky bar already pins the $99 site visit for every
      // unpaid actionable row (built above) — no five-section special case.
      <QuoteChrome trade={{ label: 'Paint', icon: tradeIcon('paint') }} sticky={stickyBar}>
        {/* Owner-only "Review & edit" pill → /p/[estimate_token] (spec R3). */}
        <TradieJobBanner trade="painting" publicToken={row.public_token} />
        <QuoteSheet label={`Painting quote · ${business}`}>
          <Letterhead
            name={identity?.business_name ?? business}
            credential={`Painting quote · ${date}`}
            logoUrl={identity?.logo_url ?? null}
            contactName={contactDisplayName(identity)}
            phone={(identity?.owner_mobile ?? '').trim() || null}
            email={(identity?.owner_email ?? '').trim() || null}
          />
          <Scope eyebrow={`Painting quote · ${business}`} items={paintSections} />
          {/* Acceptance record (customer_accepted_at) — kept OUT of section 05
              on purpose: it renders its own full-bleed action band with the
              #accept anchor. Rendered ONLY when actionable — always the $99
              site-visit mode now; in 'paid' mode section 05 already confirms
              the booking. showPaintAccept is load-bearing since the held
              state joined this layout: resolveAcceptView returns an ACTIONABLE
              inspection view for a held row (its own gate is "unreleased →
              offer the $99 visit"), which painting must not honour — the
              tradie's release gate comes first, and /r/paint would 302 the
              click straight back here anyway. Same gate the long-scroll
              branch uses, so released / inspection / paid are unchanged. */}
          {showPaintAccept && paintAcceptView.actionable ? (
            <AcceptBlock token={token} view={paintAcceptView} />
          ) : null}
          {/* The shared default tagline still sells the retired tier-deposit
              flow ("Pick a tier · Pay the deposit"). Painting takes the same
              $99-visit line roofing uses (spec painting-site-visit-first R4). */}
          <CredentialFooter
            rows={footerRows}
            tagline="Book the visit · We confirm on site · Licensed & insured"
          />
        </QuoteSheet>
      </QuoteChrome>
    )
  }

  // ═══ Long-scroll layout — ?full=1 ONLY (spec painting-held-view-parity R1).
  // Retained as roofing's escape hatch; no state reaches it on its own any
  // more, the held state included. Its gates are unchanged, so a held row
  // opened with ?full=1 still shows the publish-gate holding message and no
  // accept CTA. ═══
  return (
    <QuoteChrome trade={{ label: 'Paint', icon: tradeIcon('paint') }} sticky={stickyBar}>
      {/* Owner-only "Review & edit" pill → /p/[estimate_token] (spec R3). */}
      <TradieJobBanner trade="painting" publicToken={row.public_token} />
      <QuoteSheet label={`Painting quote · ${business}`}>
        <Letterhead
          name={identity?.business_name ?? business}
          credential={`Painting quote · ${date}`}
          logoUrl={identity?.logo_url ?? null}
          contactName={contactDisplayName(identity)}
          phone={(identity?.owner_mobile ?? '').trim() || null}
          email={(identity?.owner_email ?? '').trim() || null}
        />

        <QuoteHero
          quoteId={`Painting quote · ${business}`}
          status={heroStatus}
          line1={heroLine1}
          line2={heroLine2}
          greeting={heroGreeting}
          issued={`Issued ${date}`}
        />

        {statItems.length > 0 ? <StatGrid items={statItems} /> : null}

        {/* ── Property imagery (shared inner — see imageryInner above). ── */}
        {imageryInner ? (
          <SheetSection eyebrow="Your property" eyebrowAccent>
            {imageryInner}
          </SheetSection>
        ) : null}

        {scopeItems.length > 0 ? (
          <Scope
            items={scopeItems}
            eyebrow={measurement ? `Scope of works · measured from ${source}` : 'Scope of works'}
          />
        ) : null}

        {/* ── Inspection note · held-for-review note · OR tiers ── */}
        {inspection ? (
          <SheetSection eyebrow="On-site measure needed" eyebrowAccent>
            <p style={{ margin: '12px 0 0', fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              {estimate.price?.routing?.reason ??
                'This job needs a quick on-site measure before we can lock a price.'}{' '}
              Book your ${INSPECTION_FEE_AUD} refundable site visit below — the fee is
              credited toward your final quote.
            </p>
          </SheetSection>
        ) : !priceGate.showPrices ? (
          <SheetSection eyebrow="Awaiting painter review" eyebrowAccent>
            <p style={{ margin: '12px 0 0', fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              {priceGate.reason}
            </p>
          </SheetSection>
        ) : quoteTiers.length > 0 ? (
          <TierCards
            heading={visibleTiers.length === 1 ? 'Your painting option' : 'Your painting options'}
            intro={`Prices are inc-GST estimates derived from ${source} and your declared scope. The final price is confirmed after a quick on-site check.`}
            tiers={quoteTiers}
          />
        ) : null}

        {/* ── How your price was built (shared inner — see priceBuildInner). ── */}
        {showTiers && priceBuildInner ? (
          <SheetSection eyebrow="How your price was built" eyebrowAccent>
            {priceBuildInner}
          </SheetSection>
        ) : null}

        {/* ── How we measured — measurement provenance, standalone so it shows
            whenever notes exist (independent of the price-build section and a
            manual tier edit), matching the PDF exactly. ── */}
        {measuredNotesList ? (
          <SheetSection eyebrow="How we measured" eyebrowAccent>
            {measuredNotesList}
          </SheetSection>
        ) : null}

        {/* ── Materials & time on site (shared inner — see materialsInner). ── */}
        {!inspection && priceGate.showPrices && materialsInner ? (
          <SheetSection eyebrow="Materials & time on site" eyebrowAccent>
            {materialsInner}
          </SheetSection>
        ) : null}

        {/* The pay CTA was refused because no windows are published — say so
            above the accept block, where the customer just came from. */}
        {noSlots && !paid ? (
          <SheetSection>
            <NoSlotsNotice tradieName={identity?.business_name ?? null} />
          </SheetSection>
        ) : null}

        {/* ── Explicit "Accept & confirm" — the $99 site visit on every unpaid
            actionable quote (released or inspection-routed), confirmation once
            paid. Held quotes render nothing here. ── */}
        {showPaintAccept ? <AcceptBlock token={token} view={paintAcceptView} /> : null}

        {/* Self-serve visit booking — appears once the site visit is paid. The
            picker itself lives on the dedicated /book page since 2026-07-22
            (spec booking-three-page-split R3), so this is a link rather than an
            inline picker the customer has to scroll a pricing page to find.
            Mig 167. */}
        {paid ? (
          <SheetSection eyebrow={paintScheduledAt ? 'Visit booked' : 'Pick your visit time'} eyebrowAccent>
            {paintScheduledAt ? (
              <div style={{ marginTop: 12, display: 'grid', gap: 14, justifyItems: 'start' }}>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
                  Your visit is booked for{' '}
                  <strong style={{ color: 'var(--text-pri)' }}>
                    {formatVisitSlot(paintScheduledAt, paintScheduledWindow, tzForState(identity?.state ?? null))}
                  </strong>
                  . {business} will text you the day before to confirm.
                </p>
                <a href={`/q/paint/${token}/thanks`} className="qm-cta" style={PAINT_CTA_LINK}>
                  View your booking →
                </a>
              </div>
            ) : (
              <div style={{ marginTop: 12 }}>
                <p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-sec)' }}>
                  Payment received — pick a time that suits and we&apos;ll lock in your visit.
                </p>
                <a href={`/q/paint/${token}/book`} className="qm-cta" style={PAINT_CTA_LINK}>
                  Pick your visit time →
                </a>
              </div>
            )}
          </SheetSection>
        ) : null}

        {/* Same site-visit tagline as the five-section branch above — the
            shared default still names the retired tier deposit. */}
        <CredentialFooter
          rows={footerRows}
          tagline="Book the visit · We confirm on site · Licensed & insured"
        />
      </QuoteSheet>
    </QuoteChrome>
  )
}
