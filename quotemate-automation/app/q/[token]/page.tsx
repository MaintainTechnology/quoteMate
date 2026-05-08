// Customer-facing public quote page.
// Reached via the SMS link "View full quote: {APP_URL}/q/{share_token}".
// Anyone with the token can view; tokens are unguessable (see lib/stripe/checkout
// generateShareToken). RLS policy on quotes is bypassed via the service-role
// client because this is a public sharing surface — only the columns we render
// below are exposed.
//
// Design system: Maintain Technology brand (dark navy canvas, vibrant orange
// accents, all-caps Manrope display, JetBrains Mono labels, numbered cards,
// topographic SVG overlay, orange CTA bar). Source: maintain.com.au + the
// .claude/skills/maintain-design-system/SKILL.md doc.

import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTierPhoto } from '@/lib/quote/tier-photos'
import { refreshSignedUrl } from '@/lib/storage/upload'
import { generatePreviewImage } from '@/lib/preview/generate'
import { generateSampleImages } from '@/lib/preview/samples'
import { PreviewSection } from './PreviewSection'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type LineItem = {
  unit: string
  quantity: number
  description: string
  total_ex_gst: number
  unit_price_ex_gst: number
}

type Tier = {
  label: string
  subtotal_ex_gst: number | string
  line_items?: LineItem[]
} | null

type StripeLinks = Partial<Record<'good' | 'better' | 'best' | 'inspection', string>>

const JOB_TYPE_LABEL: Record<string, string> = {
  downlights: 'downlights',
  power_points: 'power points',
  ceiling_fans: 'ceiling fans',
  smoke_alarms: 'smoke alarms',
  outdoor_lighting: 'outdoor lighting',
  switchboard: 'switchboard work',
  oven_cooktop: 'oven/cooktop',
  ev_charger: 'EV charger',
  fault_finding: 'fault finding',
  renovation: 'renovation',
  other: 'electrical work',
}

function asNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'string' ? parseFloat(v) : v
}

function fmt(n: number): string {
  return n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function incGst(exGst: number | string): number {
  return Math.round(asNumber(exGst) * 1.10)
}

function deposit(price: number, pct: number | null | undefined): number | null {
  if (!pct || pct <= 0) return null
  return Math.round((price * pct) / 100)
}

export default async function PublicQuotePage(props: {
  params: Promise<{ token: string }>
}) {
  const { token } = await props.params

  const { data: quote } = await supabase
    .from('quotes')
    .select('id, intake_id, status, scope_of_works, assumptions, risk_flags, good, better, best, optional_upsells, estimated_timeframe, needs_inspection, inspection_reason, gst_note, selected_tier, share_token, stripe_links, paid_at, paid_tier, created_at, preview_status, preview_image_path, samples_status, sample_image_paths')
    .eq('share_token', token)
    .maybeSingle()

  if (!quote) notFound()

  const [{ data: intake }, { data: pricingBook }] = await Promise.all([
    supabase
      .from('intakes')
      .select('id, call_id, job_type, scope, caller, address, suburb, photo_paths')
      .eq('id', quote.intake_id)
      .maybeSingle(),
    supabase
      .from('pricing_book')
      .select('licence_type, licence_number, licence_state, gst_registered')
      .maybeSingle(),
  ])

  // Photo aggregation — handle the late-upload race condition.
  const intakePhotoPaths = Array.isArray(intake?.photo_paths)
    ? (intake.photo_paths as string[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []

  let sourcePhotoPaths: string[] = []
  if (intake?.call_id) {
    const { data: callRow } = await supabase
      .from('calls')
      .select('photo_paths')
      .eq('id', intake.call_id)
      .maybeSingle()
    sourcePhotoPaths = Array.isArray(callRow?.photo_paths)
      ? (callRow.photo_paths as string[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
  } else if (intake?.id) {
    const { data: convoRow } = await supabase
      .from('sms_conversations')
      .select('photo_paths')
      .eq('intake_id', intake.id)
      .maybeSingle()
    sourcePhotoPaths = Array.isArray(convoRow?.photo_paths)
      ? (convoRow.photo_paths as string[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
  }

  const photoPaths = Array.from(new Set([...intakePhotoPaths, ...sourcePhotoPaths]))

  const customerPhotoUrls: string[] = photoPaths.length === 0 ? [] : (
    await Promise.all(photoPaths.map(p => refreshSignedUrl(p).catch(() => null)))
  ).filter((u): u is string => !!u)

  // ─── AI preview + sample-gallery state for this render + Trigger 2 ───
  const previewStatus = (quote.preview_status as
    'idle' | 'no_photos' | 'generating' | 'ready' | 'failed' | null) ?? 'idle'
  let previewImageUrl: string | null = null
  if (previewStatus === 'ready' && quote.preview_image_path) {
    try {
      previewImageUrl = await refreshSignedUrl(quote.preview_image_path as string)
    } catch {
      // Sign failed — leave URL null, polling will retry.
    }
  }

  const samplesStatus = (quote.samples_status as
    'idle' | 'generating' | 'ready' | 'partial' | 'failed' | null) ?? 'idle'
  const samplePaths = (Array.isArray(quote.sample_image_paths) ? quote.sample_image_paths : []) as string[]
  const sampleImageUrls: string[] = (samplesStatus === 'ready' || samplesStatus === 'partial')
    ? (await Promise.all(samplePaths.map(p => refreshSignedUrl(p).catch(() => null))))
        .filter((u): u is string => !!u)
    : []

  const needsPreview = previewStatus === 'idle' && photoPaths.length > 0 && !quote.needs_inspection
  const needsSamples = samplesStatus === 'idle' && !quote.needs_inspection
  if (needsPreview || needsSamples) {
    after(async () => {
      try {
        await Promise.all([
          needsPreview ? generatePreviewImage(quote.id as string) : Promise.resolve(),
          needsSamples ? generateSampleImages(quote.id as string) : Promise.resolve(),
        ])
      } catch (e: any) {
        console.error('[preview] page-load trigger 2 threw', { quoteId: quote.id, error: e?.message ?? String(e) })
      }
    })
  }

  const firstName = (intake?.caller?.name ?? '').toString().split(' ')[0] || 'there'
  const jobLabel = JOB_TYPE_LABEL[intake?.job_type ?? ''] ?? 'electrical work'
  const itemCount: number | undefined = intake?.scope?.item_count
  const jobSummary = itemCount && itemCount > 0 ? `${itemCount} ${jobLabel}` : jobLabel

  const stripeLinks: StripeLinks = (quote.stripe_links as StripeLinks) ?? {}
  const isInspection = !!quote.needs_inspection
  const isPaid = !!quote.paid_at
  const quoteRef = quote.id.slice(0, 8).toUpperCase()
  const issuedDate = quote.created_at
    ? new Date(quote.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
    : null

  const depositPct = isInspection ? null : 30

  const tierCount = ([quote.good, quote.better, quote.best].filter(Boolean) as Tier[]).length

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri relative">
      {/* ─── Topographic SVG overlay (signature brand pattern) ─── */}
      <TopographicBackground />

      {/* ─── Header ──────────────────────────────────────── */}
      <header className="relative z-10 border-b border-ink-line bg-ink-deep/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="inline-flex items-center group" aria-label="Maintain Technology">
            <MaintainLogo className="h-8 sm:h-9 w-auto transition-transform group-hover:-translate-y-0.5" />
          </Link>
          <div className="text-right">
            <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim">Quote ref</div>
            <div className="font-mono text-sm font-semibold text-text-pri mt-0.5">{quoteRef}</div>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-16">
        {/* ─── Hero ─────────────────────────────────────── */}
        <section>
          <StatusChip
            kind={isPaid ? 'paid' : isInspection ? 'inspection' : 'draft'}
            paidTier={quote.paid_tier as string | null}
          />

          <h1 className="mt-6 font-extrabold uppercase tracking-[-0.03em] text-[clamp(2rem,5vw,3.5rem)] leading-none">
            G&apos;day <span className="text-accent">{firstName}</span>,
            <br />
            your <span className="text-accent">{jobLabel}</span> quote
            {itemCount && itemCount > 0 ? (
              <span className="text-text-sec font-mono text-2xl sm:text-3xl ml-2 align-middle">
                / {itemCount}
              </span>
            ) : null}
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-relaxed text-text-sec sm:text-lg">
            {isInspection ? (
              <>This job needs a quick on-site visit before a real price can be locked in. The visit is <span className="font-semibold text-accent">$199</span> — refundable, credited toward your final quote.</>
            ) : tierCount === 1 ? (
              <>One option below — price includes 10% GST. Tap to lock it in with a {depositPct ?? 30}% deposit.</>
            ) : (
              <>{tierCount === 2 ? 'Two' : 'Three'} options below — all prices include 10% GST. Tap any tier to lock it in with a <span className="font-semibold text-accent">{depositPct ?? 30}%</span> deposit.</>
            )}
          </p>

          {issuedDate ? (
            <p className="mt-4 font-mono text-[0.7rem] uppercase tracking-[0.15em] text-text-dim">
              Issued {issuedDate}
            </p>
          ) : null}
        </section>

        {/* ─── Scope of works ────────────────────────────── */}
        {quote.scope_of_works ? (
          <NumberedSection
            number="01"
            title="Scope of works"
            className="mt-12"
          >
            <p className="whitespace-pre-line text-sm leading-relaxed text-text-sec sm:text-base">
              {quote.scope_of_works}
            </p>
          </NumberedSection>
        ) : null}

        {/* ─── Customer-supplied photos ──────────────────── */}
        <CustomerPhotos urls={customerPhotoUrls} />

        {/* ─── AI preview + sample gallery ───────────────── */}
        {!isInspection ? (
          <PreviewSection
            shareToken={token}
            initialPreviewStatus={previewStatus}
            initialPreviewImageUrl={previewImageUrl}
            initialSamplesStatus={samplesStatus}
            initialSampleImageUrls={sampleImageUrls}
          />
        ) : null}

        {/* ─── Inspection-only block OR tier cards ──────── */}
        {isInspection ? (
          <InspectionBlock
            reason={quote.inspection_reason}
            link={stripeLinks.inspection}
            shareToken={token}
            paid={isPaid}
          />
        ) : (
          <section className="mt-12">
            <h2 className="font-mono text-xs uppercase tracking-[0.15em] text-text-dim mb-6">
              {tierCount === 1 ? 'Your option' : tierCount === 2 ? 'Your two options' : 'Your three options'}
            </h2>
            <div className="grid gap-5 sm:gap-6">
              {(['good','better','best'] as const).map((key, idx) => {
                const tier = quote[key] as Tier
                if (!tier) return null
                // Compute sequential 01/02/03 against actual non-null tiers.
                const seqIndex = (['good','better','best'] as const)
                  .slice(0, idx)
                  .filter(k => quote[k]).length + 1
                return (
                  <TierCard
                    key={key}
                    keyName={key}
                    seq={String(seqIndex).padStart(2, '0')}
                    tier={tier}
                    recommended={quote.selected_tier === key}
                    link={stripeLinks[key] ? `/r/${token}/${key}` : null}
                    depositPct={depositPct}
                    paid={isPaid && quote.paid_tier === key}
                    disabled={isPaid && quote.paid_tier !== key}
                    jobType={intake?.job_type ?? null}
                  />
                )
              })}
            </div>
          </section>
        )}

        {/* ─── Optional upsells ─────────────────────────── */}
        {Array.isArray(quote.optional_upsells) && quote.optional_upsells.length > 0 ? (
          <NumberedSection
            number="04"
            title="Optional add-ons"
            subtitle="Not included in any tier above. Mention to your tradie if you'd like to add them."
            className="mt-12"
          >
            <ul className="mt-2 divide-y divide-ink-line">
              {(quote.optional_upsells as Array<{ description?: string; price_ex_gst?: number | string; total_ex_gst?: number | string }>).map((u, i) => {
                const price = asNumber(u.total_ex_gst ?? u.price_ex_gst)
                return (
                  <li key={i} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                    <span className="text-sm text-text-pri">{u.description ?? 'Add-on'}</span>
                    {price > 0 ? (
                      <span className="font-mono text-sm text-accent shrink-0">+${fmt(incGst(price))}</span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </NumberedSection>
        ) : null}

        {/* ─── Assumptions + Risks ──────────────────────── */}
        <div className="mt-12 grid gap-5 sm:grid-cols-2 sm:gap-6">
          {Array.isArray(quote.assumptions) && quote.assumptions.length > 0 ? (
            <section className="bg-ink-card border border-ink-line p-6 sm:p-7">
              <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim mb-3">
                What&apos;s assumed
              </div>
              <ul className="space-y-2 text-sm leading-relaxed text-text-sec">
                {(quote.assumptions as string[]).map((a, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="text-accent shrink-0">›</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {Array.isArray(quote.risk_flags) && quote.risk_flags.length > 0 ? (
            <section className="bg-ink-card border-l-2 border-l-warning border-y border-r border-ink-line p-6 sm:p-7">
              <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-warning mb-3">
                Things to be aware of
              </div>
              <ul className="space-y-2 text-sm leading-relaxed text-text-sec">
                {(quote.risk_flags as Array<string | { description?: string }>).map((r, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="text-warning shrink-0">!</span>
                    <span>{typeof r === 'string' ? r : (r?.description ?? JSON.stringify(r))}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        {/* ─── Timeframe + GST note ─────────────────────── */}
        {(quote.estimated_timeframe || quote.gst_note) ? (
          <section className="mt-12 bg-ink-card border border-ink-line p-6 sm:p-7">
            <div className="grid gap-3 text-sm">
              {quote.estimated_timeframe ? (
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim">
                    Estimated timeframe
                  </span>
                  <span className="text-right font-medium text-text-pri">{quote.estimated_timeframe}</span>
                </div>
              ) : null}
              {quote.gst_note ? (
                <div className="flex items-baseline justify-between gap-4 border-t border-ink-line pt-3">
                  <span className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim">
                    GST
                  </span>
                  <span className="text-right text-xs text-text-sec">{quote.gst_note}</span>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* ─── Tradie / licence footer ──────────────────── */}
        <section className="mt-12 bg-ink-card border border-ink-line p-6 sm:p-7">
          <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim mb-4">
            Licensed &amp; compliant
          </div>
          <dl className="grid gap-3 sm:grid-cols-3 text-xs">
            {pricingBook?.licence_type && pricingBook?.licence_state ? (
              <div>
                <dt className="text-text-dim">Licence</dt>
                <dd className="font-mono text-text-pri mt-1">
                  {pricingBook.licence_type} ({pricingBook.licence_state})
                  {pricingBook.licence_number ? ` · ${pricingBook.licence_number}` : ''}
                </dd>
              </div>
            ) : null}
            {pricingBook?.gst_registered ? (
              <div>
                <dt className="text-text-dim">GST</dt>
                <dd className="font-mono text-text-pri mt-1">Registered</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-text-dim">Quote ref</dt>
              <dd className="font-mono text-text-pri mt-1">{quoteRef}</dd>
            </div>
          </dl>
          <p className="mt-5 text-xs leading-relaxed text-text-dim">
            This quote is a draft prepared via QuoteMate. Final scope is confirmed by your tradie before any work commences.
            Australian Consumer Law applies.
          </p>
        </section>

        <p className="mt-12 text-center font-mono text-[0.65rem] uppercase tracking-[0.2em] text-text-dim">
          Powered by <Link href="/" className="text-text-sec hover:text-accent transition-colors">QuoteMate</Link> · Built in Australia
        </p>
      </div>

      {/* ─── Closing accent bar (Maintain signature) ─── */}
      <div className="relative z-10 bg-accent text-white text-center py-4 px-6 mt-8">
        <span className="font-mono text-xs sm:text-sm uppercase tracking-[0.18em]">
          {isPaid
            ? 'Deposit received — your tradie will be in touch'
            : isInspection
            ? '$199 site visit · refundable, credited to your final quote'
            : `Lock in your option · ${depositPct ?? 30}% deposit`}
        </span>
      </div>
    </main>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Components
   ═══════════════════════════════════════════════════════════════ */

function MaintainLogo({ className }: { className?: string }) {
  // Maintain Technology brand logo — horizontal lockup.
  // Orange M-mark + "MAINTAIN TECHNOLOGY" wordmark in white. Inlined as
  // SVG so it stays crisp at any size and renders without an HTTP fetch.
  // Source: provided by Maintain Technology design team.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 184 39"
      fill="none"
      className={className}
      role="img"
      aria-label="Maintain Technology"
    >
      <g clipPath="url(#mt-logo-clip)">
        <path d="M76.1019 29.7139H73.5806V36.6808H72.1687V29.7139H69.6475V28.417H76.1023V29.7139H76.1019Z" fill="white" />
        <path d="M82.3761 29.7139V31.9007H86.171V33.1976H82.3761V35.384H86.4355V36.6808H80.9766V28.417H86.4355V29.7139H82.3761Z" fill="white" />
        <path d="M95.4282 29.7263C93.8018 29.7263 92.7052 30.9212 92.7052 32.5489C92.7052 34.1765 93.8022 35.3714 95.4282 35.3714C96.399 35.3714 97.1804 34.8377 97.6091 34.2402L98.7437 35.1172C98.0378 36.147 96.878 36.7827 95.4282 36.7827C92.9952 36.7827 91.3057 35.0028 91.3057 32.5489C91.3057 30.0949 92.9952 28.3154 95.4282 28.3154C96.878 28.3154 98.0378 28.9512 98.7437 29.9809L97.6091 30.8201C97.1804 30.2098 96.399 29.7267 95.4282 29.7267V29.7263Z" fill="white" />
        <path d="M110.276 28.417V36.6808H108.877V33.2354H105.069V36.6808H103.67V28.417H105.069V31.8624H108.877V28.417H110.276Z" fill="white" />
        <path d="M122.284 28.417V36.6808H120.923L117.153 30.8705V36.6808H115.754V28.417H117.115L120.885 34.2273V28.417H122.284Z" fill="white" />
        <path d="M127.468 32.5489C127.468 30.0954 129.157 28.3154 131.59 28.3154C134.023 28.3154 135.688 30.0954 135.688 32.5489C135.688 35.0024 134.023 36.7827 131.59 36.7827C129.157 36.7827 127.468 35.0028 127.468 32.5489ZM134.276 32.5489C134.276 30.9216 133.217 29.7263 131.59 29.7263C129.964 29.7263 128.867 30.9212 128.867 32.5489C128.867 34.1765 129.964 35.3714 131.59 35.3714C133.217 35.3714 134.276 34.1765 134.276 32.5489Z" fill="white" />
        <path d="M146.268 35.384V36.6808H140.834V28.417H142.233V35.384H146.268Z" fill="white" />
        <path d="M150.666 32.5489C150.666 30.0954 152.356 28.3154 154.789 28.3154C157.222 28.3154 158.886 30.0954 158.886 32.5489C158.886 35.0024 157.222 36.7827 154.789 36.7827C152.356 36.7827 150.666 35.0028 150.666 32.5489ZM157.474 32.5489C157.474 30.9216 156.415 29.7263 154.789 29.7263C153.162 29.7263 152.066 30.9212 152.066 32.5489C152.066 34.1765 153.163 35.3714 154.789 35.3714C156.415 35.3714 157.474 34.1765 157.474 32.5489Z" fill="white" />
        <path d="M167.854 36.7827C165.421 36.7827 163.731 35.0028 163.731 32.5489C163.731 30.0949 165.421 28.3154 167.854 28.3154C169.304 28.3154 170.464 28.9512 171.17 29.968L170.023 30.8072C169.506 30.0824 168.699 29.7267 167.854 29.7267C166.228 29.7267 165.131 30.9216 165.131 32.5493C165.131 34.177 166.228 35.3719 167.854 35.3719C169.014 35.3719 169.997 34.66 170.186 33.4139H167.766V32.117H171.788V32.7403C171.699 35.0923 170.224 36.7832 167.854 36.7832V36.7827Z" fill="white" />
        <path d="M180.088 33.121V36.6808H178.688V33.1593L175.764 28.417H177.377L179.382 31.659L181.387 28.417H183L180.088 33.121Z" fill="white" />
        <path d="M91.3279 22.9581H87.6423L86.1248 10.9332L81.3549 22.9581H79.6205L74.8506 10.9332L73.3331 22.9581H69.6475L72.2493 4.59277H75.718L80.4879 16.3989L85.2578 4.59277H88.7266L91.3284 22.9581H91.3279Z" fill="white" />
        <path d="M108.014 9.4017V22.9569H104.546V21.5087C103.462 22.7659 102.052 23.3942 100.426 23.3942C96.7136 23.3942 93.7051 20.1693 93.7051 16.179C93.7051 12.1888 96.7131 8.96387 100.426 8.96387C102.052 8.96387 103.462 9.59224 104.546 10.8494V9.40123H108.014V9.4017ZM104.546 16.1795C104.546 14.1297 102.893 12.4628 100.86 12.4628C98.8273 12.4628 97.1743 14.1297 97.1743 16.1795C97.1743 18.2293 98.8273 19.8962 100.86 19.8962C102.893 19.8962 104.546 18.2293 104.546 16.1795Z" fill="white" />
        <path d="M111.993 9.40234H115.462V22.9575H111.993V9.40234Z" fill="white" />
        <path d="M111.993 4.5918H115.462V7.65291H111.993V4.5918Z" fill="white" />
        <path d="M163.008 4.5918H166.477V7.65291H163.008V4.5918Z" fill="white" />
        <path d="M131.985 15.0871V22.9578H128.516V15.5244C128.516 13.4202 127.703 12.4633 125.914 12.4633C124.342 12.4633 122.879 13.5018 122.879 15.9613V22.9578H119.41V9.40221H122.879V10.7139C123.8 9.6209 124.912 8.96484 126.944 8.96484C130.034 8.96484 131.985 10.9874 131.985 15.0866V15.0871Z" fill="white" />
        <path d="M136.303 12.463H134.568V9.40192H136.303V4.5918H139.772V9.40192H142.373V12.463H139.772V18.1474C139.772 20.2245 140.666 20.3066 142.373 19.8964V22.9575C141.696 23.2307 140.964 23.3949 139.826 23.3949C137.36 23.3949 136.303 21.6187 136.303 19.1043V12.463Z" fill="white" />
        <path d="M159.029 9.4017V22.9569H155.56V21.5087C154.476 22.7659 153.067 23.3942 151.441 23.3942C147.728 23.3942 144.72 20.1693 144.72 16.179C144.72 12.1888 147.728 8.96387 151.441 8.96387C153.067 8.96387 154.476 9.59224 155.56 10.8494V9.40123H159.029V9.4017ZM155.56 16.1795C155.56 14.1297 153.907 12.4628 151.875 12.4628C149.842 12.4628 148.189 14.1297 148.189 16.1795C148.189 18.2293 149.842 19.8962 151.875 19.8962C153.907 19.8962 155.56 18.2293 155.56 16.1795Z" fill="white" />
        <path d="M163.008 9.40234H166.477V22.9575H163.008V9.40234Z" fill="white" />
        <path d="M183.001 15.0871V22.9578H179.532V15.5244C179.532 13.4202 178.719 12.4633 176.93 12.4633C175.358 12.4633 173.895 13.5018 173.895 15.9613V22.9578H170.426V9.40221H173.895V10.7139C174.816 9.6209 175.927 8.96484 177.96 8.96484C181.049 8.96484 183.001 10.9874 183.001 15.0866V15.0871Z" fill="white" />
        <path d="M60.5416 21.3594V38.5104C60.5416 38.7812 60.3238 39.0003 60.0557 39.0003H44.2212C43.7884 39.0003 43.5716 38.4725 43.8776 38.1639L60.5416 21.3594Z" fill="#FF5F00" />
        <path d="M60.5416 0.490945V21.3591H57.1749C56.5307 21.3591 55.9126 21.6175 55.457 22.0765L38.8177 38.8561C38.7266 38.9479 38.6031 38.9996 38.4741 38.9996H22.355C21.9222 38.9996 21.7054 38.4718 22.0114 38.1632L59.7117 0.144465C60.0178 -0.164184 60.5412 0.0544997 60.5412 0.490945H60.5416Z" fill="#FF5F00" />
        <path d="M38.6739 0.490945V21.3591H35.3072C34.663 21.3591 34.0449 21.6175 33.5892 22.0765L16.95 38.8561C16.8589 38.9479 16.7354 38.9996 16.6064 38.9996H0.486839C0.0540439 38.9996 -0.162811 38.4718 0.143256 38.1632L37.8445 0.144465C38.1505 -0.164184 38.6739 0.0544997 38.6739 0.490945Z" fill="#FF5F00" />
      </g>
      <defs>
        <clipPath id="mt-logo-clip">
          <rect width="184" height="39" fill="white" />
        </clipPath>
      </defs>
    </svg>
  )
}

function TopographicBackground() {
  // Faint topographic line overlay — Maintain brand signature.
  // Pure SVG, no JS, fixed background that scrolls with content.
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.07]"
        viewBox="0 0 1920 2400"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="topo-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--teal-glow)" stopOpacity="0.6" />
            <stop offset="100%" stopColor="var(--teal-glow)" stopOpacity="0.1" />
          </linearGradient>
        </defs>
        {/* Stylised mountain-ridge contour lines */}
        <g stroke="url(#topo-fade)" strokeWidth="1" fill="none">
          <path d="M0,800 Q200,600 400,700 T800,650 T1200,700 T1600,600 T1920,650" />
          <path d="M0,860 Q200,680 400,760 T800,720 T1200,770 T1600,680 T1920,720" />
          <path d="M0,920 Q200,760 400,820 T800,790 T1200,830 T1600,760 T1920,790" />
          <path d="M0,1000 Q220,860 420,900 T820,880 T1220,910 T1620,860 T1920,880" />
          <path d="M0,1100 Q240,980 440,1000 T840,990 T1240,1010 T1640,980 T1920,990" />
          <path d="M0,1300 Q260,1160 460,1200 T860,1190 T1260,1210 T1660,1180 T1920,1190" />
          <path d="M0,1500 Q280,1380 480,1400 T880,1390 T1280,1410 T1680,1380 T1920,1390" />
          <path d="M0,1700 Q300,1580 500,1600 T900,1590 T1300,1610 T1700,1580 T1920,1590" />
          <path d="M0,1900 Q320,1780 520,1800 T920,1790 T1320,1810 T1720,1780 T1920,1790" />
          <path d="M0,2100 Q340,1980 540,2000 T940,1990 T1340,2010 T1740,1980 T1920,1990" />
        </g>
      </svg>
    </div>
  )
}

function StatusChip({
  kind,
  paidTier,
}: {
  kind: 'paid' | 'inspection' | 'draft'
  paidTier: string | null
}) {
  const styles =
    kind === 'paid'
      ? 'bg-success/15 text-[#34d399] border-success/40'
      : kind === 'inspection'
      ? 'bg-warning/15 text-[#fbbf24] border-warning/40'
      : 'bg-accent/15 text-accent border-accent/40'
  const label =
    kind === 'paid'
      ? `Deposit received${paidTier ? ` · ${String(paidTier).toUpperCase()} option` : ''}`
      : kind === 'inspection'
      ? 'Site visit required'
      : 'Draft quote · awaiting your choice'
  return (
    <span className={`inline-flex items-center font-mono text-[0.7rem] uppercase tracking-[0.12em] px-3 py-1.5 border ${styles}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current mr-2 animate-pulse" />
      {label}
    </span>
  )
}

function NumberedSection({
  number,
  title,
  subtitle,
  className,
  children,
}: {
  number: string
  title: string
  subtitle?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={`bg-ink-card border border-ink-line p-6 sm:p-8 ${className ?? ''}`}>
      <div className="flex items-start gap-5 sm:gap-6">
        <span className="font-mono text-3xl sm:text-4xl font-bold text-accent leading-none shrink-0">
          {number}
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-text-pri font-extrabold uppercase tracking-tight text-base sm:text-lg">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-1 text-xs text-text-dim">{subtitle}</p>
          ) : null}
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </section>
  )
}

function CustomerPhotos({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null
  const cols =
    urls.length === 1 ? 'grid-cols-1' :
    urls.length === 2 ? 'grid-cols-1 sm:grid-cols-2' :
    'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'

  return (
    <NumberedSection
      number="02"
      title="Photos you sent"
      subtitle="Your tradie reviewed these to draft the quote below. Tap any photo to view full-size."
      className="mt-6"
    >
      <div className={`grid gap-3 sm:gap-4 ${cols}`}>
        {urls.map((url, i) => (
          <a
            key={i}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="block aspect-4/3 overflow-hidden border border-ink-line bg-ink-deep transition-all hover:border-accent/60 hover:scale-[1.01]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`Customer photo ${i + 1}`}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </a>
        ))}
      </div>
    </NumberedSection>
  )
}

function TierCard({
  keyName,
  seq,
  tier,
  recommended,
  link,
  depositPct,
  paid,
  disabled,
  jobType,
}: {
  keyName: 'good' | 'better' | 'best'
  seq: string
  tier: Tier
  recommended: boolean
  link: string | null
  depositPct: number | null
  paid: boolean
  disabled: boolean
  jobType: string | null
}) {
  if (!tier) return null
  const totalIncGst = incGst(tier.subtotal_ex_gst)
  const dep = deposit(totalIncGst, depositPct)
  const cleanLabel = (tier.label ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
  const photo = getTierPhoto(jobType, keyName)

  return (
    <article
      className={`relative overflow-hidden border bg-ink-card transition-colors ${
        recommended
          ? 'border-accent shadow-[0_0_0_1px_rgba(255,90,31,0.5)_inset]'
          : 'border-ink-line hover:border-accent/40'
      }`}
    >
      {/* Tier-photo banner (indicative — see lib/quote/tier-photos.ts) */}
      <div className="relative aspect-video w-full overflow-hidden border-b border-ink-line bg-ink-deep">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.url}
          alt={photo.alt}
          loading="lazy"
          className="h-full w-full object-cover opacity-90"
        />
        <div className="absolute inset-0 bg-linear-to-t from-ink-card via-ink-deep/40 to-transparent" />
        <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between gap-3">
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-pri/80 bg-ink-deep/70 backdrop-blur-sm px-2 py-1">
            Indicative · {photo.caption}
          </span>
          {recommended ? (
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] bg-accent text-white px-2.5 py-1 font-bold">
              Recommended
            </span>
          ) : null}
        </div>
      </div>

      <div className="p-6 sm:p-8">
        {/* Header — sequential number + tier name + price */}
        <div className="flex items-start justify-between gap-4 sm:gap-6">
          <div className="flex items-start gap-4 sm:gap-5 min-w-0 flex-1">
            <span className="font-mono text-3xl sm:text-4xl font-bold text-accent leading-none shrink-0">
              {seq}
            </span>
            <div className="min-w-0 flex-1">
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim">
                {keyName}
              </span>
              {cleanLabel ? (
                <h3 className="mt-1 text-text-pri font-extrabold uppercase tracking-tight text-lg sm:text-xl">
                  {cleanLabel}
                </h3>
              ) : null}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-text-pri font-extrabold tracking-tight text-2xl sm:text-3xl">
              ${fmt(totalIncGst)}
            </div>
            <div className="font-mono text-[0.65rem] uppercase tracking-[0.12em] text-text-dim mt-0.5">
              inc GST
            </div>
          </div>
        </div>

        {/* Line items */}
        {Array.isArray(tier.line_items) && tier.line_items.length > 0 ? (
          <ul className="mt-6 divide-y divide-ink-line border-t border-ink-line text-sm">
            {tier.line_items.map((li, i) => (
              <li key={i} className="flex items-start justify-between gap-4 py-3.5">
                <div className="flex-1 min-w-0">
                  <div className="text-text-pri">{li.description}</div>
                  <div className="mt-0.5 font-mono text-[0.7rem] text-text-dim">
                    {li.quantity} × {li.unit} @ ${fmt(asNumber(li.unit_price_ex_gst))} ex GST
                  </div>
                </div>
                <div className="font-mono text-sm text-text-sec shrink-0">
                  ${fmt(asNumber(li.total_ex_gst))}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {/* CTA */}
        <div className="mt-6 border-t border-ink-line pt-5">
          {paid ? (
            <div className="bg-success/10 border border-success/30 px-5 py-4 text-center">
              <span className="font-mono text-xs uppercase tracking-[0.12em] font-semibold text-[#4ade80]">
                Deposit received — tradie will be in touch
              </span>
            </div>
          ) : disabled ? (
            <div className="bg-ink-deep border border-ink-line px-5 py-4 text-center">
              <span className="font-mono text-xs uppercase tracking-[0.12em] text-text-dim">
                Different option already confirmed
              </span>
            </div>
          ) : link ? (
            <a
              href={link}
              className="block bg-accent hover:bg-accent-press text-white px-5 py-4 text-center transition-colors font-mono text-xs sm:text-sm uppercase tracking-[0.15em] font-bold"
            >
              {dep ? <>Lock in · ${fmt(dep)} deposit →</> : <>Lock in this option →</>}
            </a>
          ) : (
            <div className="bg-ink-deep border border-ink-line px-5 py-4 text-center">
              <span className="font-mono text-xs uppercase tracking-[0.12em] text-text-dim">
                Reply to your tradie&apos;s SMS to confirm
              </span>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function InspectionBlock({
  reason,
  link,
  shareToken,
  paid,
}: {
  reason: string | null
  link: string | undefined
  shareToken: string
  paid: boolean
}) {
  return (
    <section className="mt-12 bg-ink-card border-2 border-warning/50 p-6 sm:p-8 relative overflow-hidden">
      {/* Subtle warning gradient corner accent */}
      <div className="absolute top-0 left-0 w-1.5 h-full bg-warning" aria-hidden />

      <div className="relative">
        <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-warning mb-3">
          Site visit required
        </div>
        <p className="text-base leading-relaxed text-text-pri sm:text-lg">
          Every site is different — we can&apos;t price this safely without seeing the work in person.
        </p>

        {reason ? (
          <p className="mt-5 bg-ink-deep border border-ink-line p-4 text-sm text-text-sec">
            <span className="font-semibold text-text-pri">Why a visit:</span> {reason}
          </p>
        ) : null}

        <div className="mt-7 flex items-baseline gap-3">
          <span className="text-text-pri font-extrabold tracking-tight text-4xl sm:text-5xl">$199</span>
          <span className="text-sm text-text-sec">
            refundable site visit · credited toward your final quote
          </span>
        </div>

        <div className="mt-6">
          {paid ? (
            <div className="bg-success/10 border border-success/30 px-5 py-4 text-center">
              <span className="font-mono text-xs uppercase tracking-[0.12em] font-semibold text-[#4ade80]">
                Site visit booked — tradie will be in touch
              </span>
            </div>
          ) : link ? (
            <a
              href={`/r/${shareToken}/inspection`}
              className="block bg-accent hover:bg-accent-press text-white px-5 py-4 text-center transition-colors font-mono text-xs sm:text-sm uppercase tracking-[0.15em] font-bold"
            >
              Lock in your site visit · $199 →
            </a>
          ) : (
            <div className="bg-ink-deep border border-ink-line px-5 py-4 text-center">
              <span className="font-mono text-xs uppercase tracking-[0.12em] text-text-dim">
                Reply to your tradie&apos;s SMS to book
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
