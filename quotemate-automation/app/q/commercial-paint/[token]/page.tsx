// Public, read-only commercial painting tender quote (spec R11/R20).
// Token = paint_runs.public_token (migration 143 — APPLY BEFORE THIS WORKS).
// Service-role read; public sharing surface.
//
// Renders the priced takeoff (PricedPaintBom on the run's latest priced
// plan_extraction) as a tender — surface/room line items, labour + materials +
// equipment, and the inc-GST total — instead of the electrical G/B/B card.
//
// Deposit (R12): commercial painting has no Stripe deposit flow wired; the CTA
// renders in the spec's "no deposit link → clear state" mode (contact to book).

import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import { QuoteUnavailable } from '@/app/q/_chrome/QuoteUnavailable'
import { QuoteAwaitingReview } from '@/app/q/_chrome/QuoteAwaitingReview'
import { quoteReadFailure } from '@/lib/quote/read-failure'
import type { PricedPaintBom } from '@/lib/commercial-painting/types'
import { loadTenantIdentity, contactDisplayName } from '@/lib/quote/tenant-identity'
import { QuoteChrome } from '../../_chrome/QuoteChrome'
import { TradieJobBanner } from '../../_chrome/TradieJobBanner'
import { tradeIcon } from '../../_chrome/icons'
import {
  QuoteSheet, Letterhead, QuoteHero, StatGrid, SheetSection,
  TierCards, GoodToKnow, CredentialFooter,
} from '../../_chrome/parts'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const aud = (n: number) =>
  '$' + Math.round(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

const MONO = { fontFamily: 'var(--font-mono)' } as const

export default async function CommercialPaintQuotePage(props: {
  params: Promise<{ token: string }>
}) {
  const { token } = await props.params

  const { data: run, error } = await supabase
    .from('paint_runs')
    .select('id, job_name, site_address, status, created_at, public_token, tenant_id, released_at, tenants:tenant_id(business_name)')
    .eq('public_token', token)
    .maybeSingle()

  if (error) return <QuoteUnavailable correlationId={quoteReadFailure('commercial-paint', error)} />
  if (!run) notFound()
  if (!run.released_at) return <QuoteAwaitingReview />

  // Tradie identity for the letterhead (logo + Contact / Phone / Email),
  // matching the reference quote surface. Best-effort: degrades to the joined
  // business_name when identity columns are absent or tenant_id is null.
  const identity = await loadTenantIdentity(
    supabase,
    (run as { tenant_id?: string | null }).tenant_id ?? null,
  )

  // Latest priced extraction for this run holds the tender BOM.
  const { data: ext } = await supabase
    .from('plan_extractions')
    .select('priced_bom, priced_at')
    .eq('paint_run_id', run.id)
    .not('priced_bom', 'is', null)
    .order('priced_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const bom = (ext?.priced_bom as PricedPaintBom | null) ?? null
  const business =
    identity?.business_name ??
    (run.tenants as { business_name?: string } | null)?.business_name ??
    'Your painter'
  const jobName = String(run.job_name ?? 'Painting tender')
  const address = run.site_address ? String(run.site_address) : null
  const date = new Date(run.created_at as string).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  // Measured-takeoff summary figures (presentation only — no math change to bom).
  const areaM2 = bom
    ? bom.lines.filter((l) => l.unit === 'm2').reduce((s, l) => s + l.quantity, 0)
    : 0
  const notes: string[] = bom
    ? [...(bom.assumptions ?? []), ...(bom.exclusions ?? [])]
    : []

  return (
    <QuoteChrome
      trade={{ label: 'Commercial paint', icon: tradeIcon('commercial-paint') }}
      sticky={
        bom
          ? { tierLabel: 'Tender · inc GST', priceText: aud(bom.totalIncGst), ctaLabel: 'Contact us to accept' }
          : { tierLabel: 'Tender', priceText: 'Pricing in progress', ctaLabel: 'Awaiting takeoff' }
      }
    >
      {/* Owner-only nav back to the dashboard + the pricing workspace tab. */}
      <TradieJobBanner trade="commercial-painting" publicToken={token} editLabel="Edit pricing" />
      <QuoteSheet label="Painting tender">
        <Letterhead
          name={business}
          credential="Commercial painting tender"
          logoUrl={identity?.logo_url ?? null}
          contactName={contactDisplayName(identity)}
          phone={(identity?.owner_mobile ?? '').trim() || null}
          email={(identity?.owner_email ?? '').trim() || null}
        />

        <QuoteHero
          quoteId={`Tender · ${business}`}
          line1={jobName}
          greeting={[address, date].filter(Boolean).join(' · ') || undefined}
          issued={`Prepared ${date}`}
        />

        {/* ── Site aerial — token-gated Google Maps Static proxy (spec
            quote-visual-parity R4). Only when the run has a site address. ── */}
        {address ? (
          <SheetSection eyebrow="Your site" eyebrowAccent>
            <figure
              style={{
                margin: '12px 0 0',
                border: '1px solid var(--ink-line)',
                background: 'var(--ink-card)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/commercial-paint/q/${token}/static-map`}
                alt={`Aerial view of ${address}`}
                style={{ width: '100%', height: 300, objectFit: 'cover', display: 'block' }}
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
                Site aerial · Google Maps
              </figcaption>
            </figure>
          </SheetSection>
        ) : null}

        {!bom ? (
          <SheetSection eyebrow="Pricing in progress" eyebrowAccent>
            <p style={{ margin: '12px 0 0', fontSize: 14, lineHeight: 1.55, color: 'var(--text-sec)' }}>
              We&apos;re finalising the takeoff for this job. Your detailed tender will appear here shortly.
            </p>
          </SheetSection>
        ) : (
          <>
            <StatGrid
              items={[
                { k: 'Surfaces', v: String(bom.lines.length), sub: 'line items' },
                { k: 'Area', v: `${Math.round(areaM2)} m²`, sub: 'measured takeoff' },
                { k: 'Labour', v: `${Math.round(bom.labour.hours)} hrs`, sub: `${bom.labour.crewSize} crew` },
                { k: 'Duration', v: `${Math.max(1, Math.round(bom.labour.estimatedDays))} days`, sub: 'on site' },
              ]}
            />

            {/* ── Measured takeoff — per-surface line-item table ── */}
            <SheetSection eyebrow="Measured takeoff" aside={`${bom.lines.length} lines`}>
              <div style={{ marginTop: 14, overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: 440, borderCollapse: 'collapse', ...MONO, fontVariantNumeric: 'tabular-nums' }}>
                  <thead>
                    <tr>
                      {['Surface', 'Qty', 'System', 'Coats', 'Price'].map((h, i) => (
                        <th
                          key={h}
                          style={{
                            textAlign: i === 0 ? 'left' : i === 4 ? 'right' : 'left',
                            padding: '0 0 9px',
                            borderBottom: '1px solid var(--ink-line)',
                            fontSize: 8.5,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.13em',
                            color: 'var(--text-dim)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bom.lines.map((l, i) => (
                      <tr key={i}>
                        <td style={{ padding: '11px 12px 11px 0', borderBottom: '1px solid var(--ink-line)', verticalAlign: 'top' }}>
                          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-pri)', lineHeight: 1.3 }}>
                            {l.surface}
                          </div>
                          {l.room ? (
                            <div style={{ marginTop: 3, fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.11em', color: 'var(--text-dim)' }}>
                              {l.room}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ padding: '11px 12px 11px 0', borderBottom: '1px solid var(--ink-line)', fontSize: 12, color: 'var(--text-sec)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                          {Math.round(l.quantity)} {l.unit === 'item' ? 'items' : 'm²'}
                        </td>
                        <td style={{ padding: '11px 12px 11px 0', borderBottom: '1px solid var(--ink-line)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-sec)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                          {String(l.system).replace(/_/g, ' ')}
                        </td>
                        <td style={{ padding: '11px 12px 11px 0', borderBottom: '1px solid var(--ink-line)', fontSize: 12, color: 'var(--text-sec)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                          {l.coats}
                        </td>
                        <td style={{ padding: '11px 0', borderBottom: '1px solid var(--ink-line)', textAlign: 'right', fontSize: 13, color: 'var(--text-pri)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                          {aud(l.lineExGst)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Cost breakdown — labour / materials / equipment */}
              <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 1, background: 'var(--ink-line)', border: '1px solid var(--ink-line)' }}>
                <BreakCell label="Labour" value={aud(bom.labour.costExGst)} sub={`${Math.round(bom.labour.hours)} hrs`} />
                <BreakCell label="Materials" value={aud(bom.materialsExGst)} />
                <BreakCell label="Equipment" value={aud(bom.equipmentExGst)} />
              </div>
            </SheetSection>

            {/* ── Tender price ── */}
            <TierCards
              eyebrow="Your tender"
              heading="Tender price"
              intro={`${aud(bom.subtotalExGst)} ex GST + ${aud(bom.gst)} GST. No online deposit — contact us to accept.`}
              tiers={[
                {
                  name: 'Tender',
                  badge: 'Fixed price',
                  recommended: true,
                  blurb: 'The complete measured takeoff above, delivered as a single fixed-price tender.',
                  priceText: aud(bom.totalIncGst),
                  priceNote: 'inc GST',
                  items: [
                    `${bom.lines.length} surfaces measured and priced`,
                    `${Math.round(bom.labour.hours)} labour hours · ${bom.labour.crewSize} crew`,
                    'Labour, materials and equipment included',
                  ],
                  ctaLabel: 'Contact us to accept this tender',
                },
              ]}
            />

            {notes.length ? (
              <GoodToKnow eyebrow="Assumptions & exclusions" items={notes} />
            ) : null}
          </>
        )}

        <CredentialFooter
          rows={[
            { k: 'Prepared by', v: business },
            ...(address ? [{ k: 'Site', v: address }] : []),
            { k: 'Terms', v: 'Prices include GST · fixed-price tender · contact to accept' },
          ]}
          tagline="Measured takeoff · Fixed-price tender · Contact us to book"
        />
      </QuoteSheet>
    </QuoteChrome>
  )
}

function BreakCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: 'var(--ink-card)', padding: '14px 14px 15px' }}>
      <div style={{ ...MONO, fontSize: 8.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ marginTop: 7, ...MONO, fontWeight: 800, fontSize: 17, color: 'var(--text-pri)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub ? <div style={{ marginTop: 4, ...MONO, fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--text-sec)' }}>{sub}</div> : null}
    </div>
  )
}
