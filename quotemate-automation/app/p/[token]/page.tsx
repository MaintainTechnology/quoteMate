// /p/[token] — tradie-facing Paint Estimate Results page (migration 151).
//
// Keyed by painting_measurements.estimate_token (a SECOND unguessable token,
// distinct from the customer-facing public_token). One record, two views:
// this page shows the full priced estimate the tradie reviews; the customer's
// shareable quote lives at /q/paint/[public_token].
//
// This is where the dashboard sends the tradie the moment an estimate is
// computed — clicking "Estimate paintable area" persists the job and routes
// here, mirroring roofing's measure → /m/[measure_token] redirect.
//
// Anyone with the link can open it (same trust model as the customer quote
// page — the unguessable token is the capability). Service-role read because
// this is a sharing surface; only the columns rendered below are exposed.
//
// QuoteMax Command Centre brand: warm charcoal, Caterpillar-yellow accent,
// all-caps display (the old navy/orange Maintain palette is retired).

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import type { CSSProperties } from 'react'
import type { PaintingEstimate } from '@/lib/painting/types'
import { composePaintLocation } from '@/lib/painting/paint-after'
import {
  buildStreetViewMetadataUrl,
  parseStreetViewMetadata,
} from '@/lib/painting/streetview'
import { loadTenantIdentity, contactDisplayName } from '@/lib/quote/tenant-identity'
import { QuoteSheet, Letterhead } from '../../q/_chrome/parts'
import { BrandMark } from '@/app/_components/BrandMark'
import { RepaintPreviewFigure } from '../../q/_chrome/RepaintPreviewFigure'
import { PaintResultView } from '@/app/dashboard/painting/_components/PaintResultView'
import { SendToCustomerButton } from './SendToCustomerButton'
import { EditQuotePanel, type EditableTier } from './EditQuotePanel'
import { paintingEditVersion } from '@/lib/painting/edit-version'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Row = {
  address: string | null
  postcode: string | null
  state: string | null
  scopes: string[] | null
  estimate: PaintingEstimate | null
  public_token: string
  estimate_token: string
  created_at: string
  released_at: string | null
  /** Migration 189 — set only once a carrier accepted the quote message. */
  quote_sent_at: string | null
  tenant_id: string | null
  preview_status: string | null
}

export default async function PaintEstimateResultsPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  if (!token || token.length < 8) notFound()

  const { data, error } = await supabase
    .from('painting_measurements')
    .select(
      'address, postcode, state, scopes, estimate, public_token, estimate_token, created_at, released_at, quote_sent_at, tenant_id, preview_status',
    )
    .eq('estimate_token', token)
    .maybeSingle()

  if (error || !data) notFound()
  const row = data as Row
  const estimate = row.estimate
  if (!estimate) notFound()

  // Tenant letterhead — same identity block the roofing measurement page and
  // the customer quote chrome use. Best-effort: null renders a generic head.
  const identity = await loadTenantIdentity(supabase, row.tenant_id)

  // TWO different questions, two different columns — conflating them is what
  // made /p claim sends that never happened:
  //   released_at (mig 157) — MAY the customer see prices? Gates the repaint
  //     preview's render eligibility, exactly as before.
  //   quote_sent_at (mig 189) — WAS the quote actually delivered? Evidence a
  //     carrier accepted it. A dashboard save stamps released_at and texts
  //     nobody, so only this column may drive "Sent to customer". Null (a
  //     dashboard save, a legacy held draft, an inspection row, or a failed
  //     auto-send) leaves the button actionable.
  const released = row.released_at != null
  const quoteSent = row.quote_sent_at != null

  const inspection = estimate.price?.routing?.decision === 'inspection_required'
  // Editable tier shape for the tradie pre-send edit panel (only the
  // customer-visible fields — label, scope, inc-GST headline).
  const editableTiers: EditableTier[] = (estimate.price?.tiers ?? []).map((t) => ({
    tier: t.tier,
    label: t.label,
    scope: t.scope,
    inc_gst: t.inc_gst,
  }))
  const customerPath = `/q/paint/${row.public_token}`
  const pdfPath = `/api/q/paint/${row.public_token}/pdf`
  const date = new Date(row.created_at).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  // FREE Street View metadata check at render — the imagery section only
  // appears when Google actually has a pano here (no broken frames), same
  // posture as /m/[token]'s always-available satellite block.
  let hasPano = false
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY
  if (mapsKey && row.address) {
    try {
      const metaRes = await fetch(
        buildStreetViewMetadataUrl(
          {
            location: composePaintLocation({
              address: row.address,
              postcode: row.postcode,
              state: row.state,
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

  return (
    <div
      className="qm-quote"
      data-qm-theme="dark"
      style={
        {
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--ink-deep)',
          color: 'var(--text-pri)',
          // Wider sheet than the customer quote — this is a desktop review
          // surface, same width as the roofing measurement results page.
          '--qm-sheet-w': '1200px',
        } as CSSProperties
      }
    >
      <div className="noise-overlay" aria-hidden="true" />

      {/* ── tradie top bar — mirrors the roofing measurement chrome ── */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          height: 56,
          padding: '0 20px',
          borderBottom: '1px solid var(--ink-line)',
          background: 'var(--ink-deep)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <BrandMark className="h-6 w-auto" />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.16em',
              color: 'var(--text-dim)',
              whiteSpace: 'nowrap',
            }}
          >
            Tradie · Paint estimate
          </span>
        </div>
        {/* estimate_token holders are tradies by construction — static link. */}
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-text-dim transition-colors hover:text-text-pri"
        >
          ← Dashboard
        </Link>
      </header>

      <main style={{ position: 'relative', flex: 1, minHeight: 0, padding: '0 16px 40px' }}>
        <QuoteSheet label={`Paint estimate · ${row.address ?? 'estimated property'}`}>
          <Letterhead
            name={identity?.business_name ?? 'Your painting team'}
            credential="Painting · estimate review"
            logoUrl={identity?.logo_url ?? null}
            contactName={contactDisplayName(identity)}
            phone={(identity?.owner_mobile ?? '').trim() || null}
            email={(identity?.owner_email ?? '').trim() || null}
          />

          <div className="px-6 sm:px-10">
            <div className="pt-8">
              <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-accent">
                QuoteMax · Painting · Estimate
              </div>
              <h1 className="mt-3 font-extrabold uppercase leading-[0.95] tracking-[-0.035em] text-[clamp(1.9rem,4.2vw,3.2rem)]">
                Estimate <span className="qm-accentword">results</span>
              </h1>
              {row.address && <p className="mt-4 text-lg text-text-sec">{row.address}</p>}
              <div className="mt-2 font-mono text-sm text-text-dim">
                {[row.postcode, row.state].filter(Boolean).join(' ')}
                {row.postcode || row.state ? ' · ' : ''}
                {date}
              </div>
            </div>
          </div>

          {/* Property imagery via the token-gated /api/painting/q/[token]
          proxies (mirrors /m/[token]'s satellite block). Top row: the real
          photos (Street View frontage + aerial). Below: the before/after
          repaint block — every paint job gets the AI colour visualisation
          (product decision 2026-07-11), auto-generated on first load. */}
      {hasPano && (
        <section className="relative z-10 mx-auto mt-8 max-w-6xl px-6 sm:px-10">
          <div className="grid gap-5 md:grid-cols-2">
            <figure className="border border-ink-line bg-ink-card">
              {/* The source photo is 4:3 — an aspect-ratio box shows the
                  whole property instead of a fixed-height crop. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/painting/q/${row.public_token}/street-view`}
                alt={`Street View of the front of ${row.address ?? 'the property'}`}
                className="block w-full object-cover"
                style={{ aspectRatio: '4 / 3' }}
              />
              <figcaption className="border-t border-ink-line px-4 py-2.5 font-mono text-xs uppercase tracking-[0.14em] text-text-dim">
                Front of the property · Google Street View
              </figcaption>
            </figure>
            <figure className="border border-ink-line bg-ink-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/painting/q/${row.public_token}/static-map`}
                alt={`Aerial view of ${row.address ?? 'the property'}`}
                className="block w-full object-cover"
                style={{ aspectRatio: '4 / 3' }}
              />
              <figcaption className="border-t border-ink-line px-4 py-2.5 font-mono text-xs uppercase tracking-[0.14em] text-text-dim">
                Aerial view · Google Maps
              </figcaption>
            </figure>
          </div>
          <div className="mt-5">
            <RepaintPreviewFigure
              publicToken={row.public_token}
              address={row.address}
              initialReady={row.preview_status === 'ready'}
              released={released}
            />
          </div>
        </section>
      )}

      {/* Full priced breakdown — the same view the tradie sees inline on the
          estimate tool. */}
      <PaintResultView estimate={estimate} />

      {/* Share + next steps */}
      <section className="relative z-10 mx-auto mt-8 max-w-6xl px-6 pb-16 sm:px-10">
        <div className="border border-ink-line border-l-4 border-l-accent bg-ink-card p-6 sm:p-7">
          <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
            {inspection ? 'On-site measure' : 'Review & send'}
          </div>
          <p className="mt-2 text-sm leading-relaxed text-text-sec">
            {inspection
              ? 'This job needs an on-site measure — the customer has been asked to book a time.'
              : quoteSent
                ? 'The customer already has this quote. Adjust the measurements, coats or pricing above and resend if anything changes.'
                : 'Check the measurements, coats and pricing above, then send the full quote to the customer — they have not received it yet.'}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            {/* Editable pre- AND post-release (spec tradie-onsite-quote-editing
                R4): the on-site inspection flow edits an already-sent quote,
                then resends via the button below. */}
            {!inspection && editableTiers.length > 0 && (
              <EditQuotePanel estimateToken={row.estimate_token} tiers={editableTiers} expectedVersion={paintingEditVersion(estimate)} released={!!row.released_at} />
            )}
            {!inspection && (
              <SendToCustomerButton estimateToken={row.estimate_token} sent={quoteSent} />
            )}
            {/* Filled accent primary — matches /m/[token]'s "Open customer
                quote" (MeasurementReview action row). */}
            <Link
              href={customerPath}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 bg-accent px-5 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-colors hover:bg-accent-press"
            >
              Open customer quote <span aria-hidden="true">&rarr;</span>
            </Link>
            {!inspection && (
              <a
                href={pdfPath}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 border border-ink-line px-5 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-text-pri transition-colors hover:border-accent hover:text-accent"
              >
                Download PDF <span aria-hidden="true">↓</span>
              </a>
            )}
            <Link
              href="/dashboard/painting"
              className="inline-flex items-center gap-2 border border-ink-line px-5 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-text-pri transition-colors hover:border-accent hover:text-accent"
            >
              New estimate
            </Link>
          </div>
          <p className="mt-4 font-mono text-xs uppercase tracking-[0.12em] text-text-dim">
            Customer link · {customerPath}
          </p>
        </div>
      </section>
        </QuoteSheet>
      </main>

      <div className="bg-accent px-6 py-5 text-center text-white">
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.16em]">
          QuoteMax · Painting · Estimate
        </span>
      </div>
    </div>
  )
}
