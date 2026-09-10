// Public, read-only plan take-off results (SMS estimator flow).
// Token = plan_extractions.share_token — unguessable, same trust model as
// the /q/[token] quote page. The tradie's editable view stays behind
// /dashboard/estimator/[runId]; this page only ever reads.
//
// Shows the reviewed counts (corrected_items when the tradie has edited,
// else the AI's items) + the indicative grounded estimate when priced.
// PRICING-VISIBILITY DECISION (flagged for business review): pricing IS
// shown to the customer, framed as indicative and subject to confirmation.

import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import { QuoteUnavailable } from '@/app/q/_chrome/QuoteUnavailable'
import { QuoteAwaitingReview } from '@/app/q/_chrome/QuoteAwaitingReview'
import { quoteReadFailure } from '@/lib/quote/read-failure'
import type { CSSProperties } from 'react'
import type { ExtractionItem } from '@/lib/estimation/extract'
import type { PricedBom } from '@/lib/estimation/price'
import { loadTenantIdentity, contactDisplayName } from '@/lib/quote/tenant-identity'
import { QuoteChrome } from '../../_chrome/QuoteChrome'
import { tradeIcon } from '../../_chrome/icons'
import {
  QuoteSheet, Letterhead, QuoteHero, StatGrid, SheetSection,
  GoodToKnow, CredentialFooter,
} from '../../_chrome/parts'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const aud = (n: number) =>
  '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const MONO: CSSProperties = { fontFamily: 'var(--font-mono)' }

export default async function PlanResultsPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params

  const { data: extraction, error: quoteError } = await supabase
    .from('plan_extractions')
    .select(
      'id, items, corrected_items, sheets_used, overall_note, priced_bom, report_pdf_path, created_at, tenant_id, released_at, plan_uploads(filename), tenants:tenant_id(business_name)',
    )
    .eq('share_token', token)
    .maybeSingle()

  if (quoteError) return <QuoteUnavailable correlationId={quoteReadFailure('plan', quoteError)} />
  if (!extraction) notFound()
  if (!extraction.released_at) return <QuoteAwaitingReview />
  if (!extraction) {
    return (
      <QuoteChrome trade={{ label: 'Plan', icon: tradeIcon('plan') }} sticky={null}>
        <QuoteSheet label="Invalid link">
          <QuoteHero
            quoteId="Take-off results"
            line1="Results not"
            line2="found."
            greeting="This results link is invalid or has expired. Text us if you need it re-sent."
          />
        </QuoteSheet>
      </QuoteChrome>
    )
  }

  // Tradie identity for the letterhead (logo + Contact / Phone / Email),
  // matching the reference quote surface. Best-effort: degrades to the joined
  // business_name when identity columns are absent or tenant_id is null.
  const identity = await loadTenantIdentity(
    supabase,
    (extraction as { tenant_id?: string | null }).tenant_id ?? null,
  )

  const business =
    identity?.business_name ??
    (extraction.tenants as { business_name?: string } | null)?.business_name ??
    'Your tradie'
  const filename = (extraction.plan_uploads as { filename?: string } | null)?.filename ?? 'plan.pdf'
  const corrected = extraction.corrected_items as ExtractionItem[] | null
  const items: ExtractionItem[] =
    Array.isArray(corrected) && corrected.length > 0
      ? corrected
      : ((extraction.items as ExtractionItem[]) ?? [])
  const bom = (extraction.priced_bom as PricedBom | null) ?? null
  const sheets = (extraction.sheets_used as string[] | null) ?? []
  const deviceCount = items.reduce((sum, it) => sum + (it.count || 0), 0)
  const date = new Date(extraction.created_at as string).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const stats: { k: string; v: React.ReactNode; sub?: React.ReactNode }[] = [
    { k: 'Item types', v: String(items.length) },
    { k: 'Devices counted', v: String(deviceCount) },
  ]
  if (bom) {
    stats.push({
      k: `Indicative total${bom.gstRegistered ? ' inc GST' : ''}`,
      v: aud(bom.totalIncGst),
    })
  }

  const pdfHref = extraction.report_pdf_path ? `/api/q/plan/${token}/pdf` : null

  // Sticky: when priced, surface the indicative total; otherwise a neutral
  // summary. The CTA links to the PDF report when one exists.
  const sticky = bom
    ? {
        tierLabel: `Indicative estimate${bom.gstRegistered ? ' · inc GST' : ''}`,
        priceText: aud(bom.totalIncGst),
        ctaLabel: pdfHref ? 'Download PDF ↓' : 'Awaiting confirmation',
        ctaHref: pdfHref,
      }
    : pdfHref
      ? { tierLabel: 'Plan take-off', priceText: `${deviceCount} counted`, ctaLabel: 'Download PDF ↓', ctaHref: pdfHref }
      : null

  return (
    <QuoteChrome trade={{ label: 'Plan', icon: tradeIcon('plan') }} sticky={sticky}>
      <QuoteSheet label="Take-off results">
        <Letterhead
          name={identity?.business_name ?? business}
          credential={`Plan take-off · ${date}`}
          logoUrl={identity?.logo_url ?? null}
          contactName={contactDisplayName(identity)}
          phone={(identity?.owner_mobile ?? '').trim() || null}
          email={(identity?.owner_email ?? '').trim() || null}
        />
        <QuoteHero
          quoteId="Take-off results"
          line1="Your plan,"
          line2="counted."
          greeting={
            <>
              Every electrical item read off <strong style={{ color: 'var(--text-pri)' }}>{filename}</strong>
              {sheets.length > 0 ? <> (sheets: {sheets.join(', ')})</> : null}. {business} reviews and confirms before anything is final.
            </>
          }
          issued={`Read ${date}`}
        />

        <StatGrid items={stats} />

        {/* ── Counted items ── */}
        <SheetSection eyebrow="Counted items" eyebrowAccent aside={`${items.length} types`}>
          <div style={{ marginTop: 14, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ ...MONO, textAlign: 'left', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.13em', color: 'var(--text-dim)' }}>
                  <th style={{ padding: '8px 12px 8px 0', borderBottom: '1px solid var(--ink-line)' }}>Item</th>
                  <th style={{ padding: '8px 12px 8px 0', borderBottom: '1px solid var(--ink-line)', textAlign: 'right' }}>Count</th>
                  <th style={{ padding: '8px 0', borderBottom: '1px solid var(--ink-line)' }}>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td style={{ padding: '10px 12px 10px 0', borderBottom: '1px solid color-mix(in srgb, var(--ink-line) 55%, transparent)', color: 'var(--text-pri)' }}>{it.type}</td>
                    <td style={{ padding: '10px 12px 10px 0', borderBottom: '1px solid color-mix(in srgb, var(--ink-line) 55%, transparent)', textAlign: 'right', ...MONO, fontWeight: 800, color: 'var(--text-pri)', fontVariantNumeric: 'tabular-nums' }}>{it.count}</td>
                    <td style={{ padding: '10px 0', borderBottom: '1px solid color-mix(in srgb, var(--ink-line) 55%, transparent)' }}>
                      <span
                        style={{
                          ...MONO,
                          fontSize: 8.5,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.12em',
                          padding: '3px 7px',
                          border: `1px solid ${
                            it.confidence === 'high'
                              ? 'color-mix(in srgb, var(--success-bright) 45%, transparent)'
                              : it.confidence === 'low'
                                ? 'color-mix(in srgb, var(--danger-bright) 45%, transparent)'
                                : 'color-mix(in srgb, var(--warning-bright) 45%, transparent)'
                          }`,
                          color:
                            it.confidence === 'high'
                              ? 'var(--success-bright)'
                              : it.confidence === 'low'
                                ? 'var(--danger-bright)'
                                : 'var(--warning-bright)',
                        }}
                      >
                        {it.confidence}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {extraction.overall_note ? (
            <p style={{ margin: '16px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
              Reader&apos;s note: {String(extraction.overall_note)}
            </p>
          ) : null}
        </SheetSection>

        {/* ── Indicative estimate ── */}
        {bom ? (
          <SheetSection eyebrow="Indicative estimate" eyebrowAccent>
            <p style={{ margin: '10px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
              Generated from {business}&apos;s standard rates — {business} confirms the final price
              before any work is booked.
            </p>
            <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
              <Row label="Materials (ex GST)" value={aud(bom.materialExGst)} />
              <Row label="Labour (ex GST)" value={aud(bom.labourExGst)} />
              {bom.labourFloorAddedExGst > 0 ? (
                <Row label="Minimum-labour adjustment" value={aud(bom.labourFloorAddedExGst)} />
              ) : null}
              <Row label="Subtotal (ex GST)" value={aud(bom.subtotalExGst)} />
              {bom.gstRegistered ? <Row label="GST" value={aud(bom.gstExGst)} /> : null}
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, borderTop: '2px solid var(--ink-line)', paddingTop: 12, marginTop: 6 }}>
                <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '-0.01em', fontSize: 14, color: 'var(--text-pri)' }}>
                  Indicative total{bom.gstRegistered ? ' (inc GST)' : ''}
                </span>
                <span style={{ ...MONO, fontWeight: 800, fontSize: 22, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>{aud(bom.totalIncGst)}</span>
              </div>
            </div>
            {bom.unmatched.length > 0 ? (
              <p style={{ margin: '16px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                Not yet priced (needs {business}&apos;s manual look):{' '}
                {bom.unmatched.map((u) => `${u.type} × ${u.count}`).join(' · ')}
              </p>
            ) : null}
          </SheetSection>
        ) : null}

        {/* ── PDF download ── */}
        {pdfHref ? (
          <SheetSection eyebrow="Report">
            <a
              href={pdfHref}
              className="qm-cta"
              style={{ display: 'block', marginTop: 14, textAlign: 'center', border: '1px solid transparent', background: 'var(--accent)', color: 'var(--accent-ink)', padding: '14px 16px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em', textDecoration: 'none' }}
            >
              Download PDF report ↓
            </a>
          </SheetSection>
        ) : null}

        <GoodToKnow
          items={[
            'Counts are read straight off the plan and reviewed before pricing.',
            `${business} confirms the final scope and price before any work is booked.`,
            'Anything the reader flagged as low-confidence gets a manual look.',
          ]}
          note="This take-off is indicative only. Text us if any count looks off and we'll re-check the plan."
        />

        <CredentialFooter
          rows={[
            { k: 'Prepared by', v: business },
            { k: 'Source plan', v: filename },
            ...(sheets.length > 0 ? [{ k: 'Sheets', v: sheets.join(', ') }] : []),
            { k: 'Read on', v: date },
          ]}
          tagline="Reviewed counts · Indicative estimate · Confirmed before booking"
        />
      </QuoteSheet>
    </QuoteChrome>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, fontSize: 13.5 }}>
      <span style={{ color: 'var(--text-sec)' }}>{label}</span>
      <span style={{ ...MONO, color: 'var(--text-pri)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}
