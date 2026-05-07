// Customer-facing public quote page.
// Reached via the SMS link "View full quote: {APP_URL}/q/{share_token}".
// Anyone with the token can view; tokens are unguessable (see lib/stripe/checkout
// generateShareToken). RLS policy on quotes is bypassed via the service-role
// client because this is a public sharing surface — only the columns we render
// below are exposed.

import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTierPhoto } from '@/lib/quote/tier-photos'
import { refreshSignedUrl } from '@/lib/storage/upload'

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
    .select('id, intake_id, status, scope_of_works, assumptions, risk_flags, good, better, best, optional_upsells, estimated_timeframe, needs_inspection, inspection_reason, gst_note, selected_tier, share_token, stripe_links, paid_at, paid_tier, created_at')
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
  //
  // intakes.photo_paths is a SNAPSHOT taken when /api/intake/structure runs.
  // Customers often tap the photo-request SMS and upload AFTER the snapshot
  // was taken (dialog finishes in ~2-4 turns; intake structures in ~35s;
  // estimate runs in ~40s; meanwhile the customer is still picking photos).
  // Late uploads land on calls.photo_paths or sms_conversations.photo_paths
  // but never make it to intakes.photo_paths.
  //
  // To make the customer's photos appear on the quote page even when uploaded
  // late, we render a UNION of:
  //   1. intakes.photo_paths            (snapshot at intake time — vision sees these)
  //   2. The source-of-truth table:
  //      - calls.photo_paths            (voice-sourced quotes; intake.call_id set)
  //      - sms_conversations.photo_paths (SMS-sourced quotes; intake.call_id null)
  // Late uploads appear on the next page refresh — no re-quote, no re-render
  // trigger needed.
  const intakePhotoPaths = Array.isArray(intake?.photo_paths)
    ? (intake.photo_paths as string[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []

  let sourcePhotoPaths: string[] = []
  if (intake?.call_id) {
    // Voice-sourced — fetch the live calls row.
    const { data: callRow } = await supabase
      .from('calls')
      .select('photo_paths')
      .eq('id', intake.call_id)
      .maybeSingle()
    sourcePhotoPaths = Array.isArray(callRow?.photo_paths)
      ? (callRow.photo_paths as string[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
  } else if (intake?.id) {
    // SMS-sourced — fetch the live sms_conversations row that points at this intake.
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

  // Re-sign on every render — signed URLs expire after 24h, so persisting
  // them is wrong. Path is permanent; sign-on-demand is cheap. Failures
  // degrade silently (skip the photo).
  const customerPhotoUrls: string[] = photoPaths.length === 0 ? [] : (
    await Promise.all(photoPaths.map(p => refreshSignedUrl(p).catch(() => null)))
  ).filter((u): u is string => !!u)

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

  // Deposit % is stored on stripe_links via createCheckoutSessionsForQuote;
  // the SMS path reads it from a sibling field, but for this page we infer
  // 30% (the only value currently issued). If/when other deposit pcts ship,
  // promote this to a dedicated column on `quotes`.
  const depositPct = isInspection ? null : 30

  return (
    <main className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      {/* ─── Header ──────────────────────────────────────── */}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-zinc-900 text-xs font-black text-white">Q</span>
            <span className="font-bold tracking-tight">QuoteMate</span>
          </Link>
          <div className="text-right">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Quote ref</div>
            <div className="font-mono text-sm font-semibold">{quoteRef}</div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        {/* ─── Hero / status ─────────────────────────────── */}
        <section>
          {isPaid ? (
            <span className="inline-block rounded-md bg-emerald-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-emerald-700">
              Deposit received{quote.paid_tier ? ` · ${String(quote.paid_tier).toUpperCase()} option` : ''}
            </span>
          ) : isInspection ? (
            <span className="inline-block rounded-md bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-700">
              Site visit required
            </span>
          ) : (
            <span className="inline-block rounded-md border border-zinc-200 bg-white px-3 py-1 text-xs font-bold uppercase tracking-widest text-zinc-600">
              Draft quote · awaiting your choice
            </span>
          )}
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">
            Hi {firstName}, your quote for {jobSummary}.
          </h1>
          <p className="mt-3 text-sm text-zinc-600 sm:text-base">
            {isInspection ? (
              <>This job needs a quick on-site visit before a real price can be locked in. The visit is $199 (refundable, credited toward your final quote).</>
            ) : (
              <>Three options below — all prices include 10% GST. Tap any tier to lock it in with a {depositPct ?? 30}% deposit.</>
            )}
          </p>
          {issuedDate ? (
            <p className="mt-2 text-xs text-zinc-500">Issued {issuedDate}</p>
          ) : null}
        </section>

        {/* ─── Scope of works ────────────────────────────── */}
        {quote.scope_of_works ? (
          <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 sm:p-6">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600">Scope of works</h2>
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-zinc-800">{quote.scope_of_works}</p>
          </section>
        ) : null}

        {/* ─── Customer-supplied photos ──────────────────── */}
        <CustomerPhotos urls={customerPhotoUrls} />

        {/* ─── Inspection-only block OR three tiers ──────── */}
        {isInspection ? (
          <InspectionBlock
            reason={quote.inspection_reason}
            link={stripeLinks.inspection}
            shareToken={token}
            paid={isPaid}
          />
        ) : (
          <section className="mt-8 grid gap-5 sm:gap-6">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600">Your three options</h2>
            <TierCard
              keyName="good"
              tier={quote.good as Tier}
              recommended={quote.selected_tier === 'good'}
              link={stripeLinks.good ? `/r/${token}/good` : null}
              depositPct={depositPct}
              paid={isPaid && quote.paid_tier === 'good'}
              disabled={isPaid && quote.paid_tier !== 'good'}
              jobType={intake?.job_type ?? null}
            />
            <TierCard
              keyName="better"
              tier={quote.better as Tier}
              recommended={quote.selected_tier === 'better'}
              link={stripeLinks.better ? `/r/${token}/better` : null}
              depositPct={depositPct}
              paid={isPaid && quote.paid_tier === 'better'}
              disabled={isPaid && quote.paid_tier !== 'better'}
              jobType={intake?.job_type ?? null}
            />
            <TierCard
              keyName="best"
              tier={quote.best as Tier}
              recommended={quote.selected_tier === 'best'}
              link={stripeLinks.best ? `/r/${token}/best` : null}
              depositPct={depositPct}
              paid={isPaid && quote.paid_tier === 'best'}
              disabled={isPaid && quote.paid_tier !== 'best'}
              jobType={intake?.job_type ?? null}
            />
          </section>
        )}

        {/* ─── Optional upsells ─────────────────────────── */}
        {Array.isArray(quote.optional_upsells) && quote.optional_upsells.length > 0 ? (
          <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 sm:p-6">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600">Optional add-ons</h2>
            <p className="mt-2 text-xs text-zinc-500">Not included in any tier above. Mention to your tradie if you'd like to add them.</p>
            <ul className="mt-4 space-y-3">
              {(quote.optional_upsells as Array<{ description?: string; price_ex_gst?: number | string; total_ex_gst?: number | string }>).map((u, i) => {
                const price = asNumber(u.total_ex_gst ?? u.price_ex_gst)
                return (
                  <li key={i} className="flex items-start justify-between gap-4 border-t border-zinc-100 pt-3 first:border-t-0 first:pt-0">
                    <span className="text-sm text-zinc-800">{u.description ?? 'Add-on'}</span>
                    {price > 0 ? <span className="font-mono text-sm text-zinc-700">+${fmt(incGst(price))} inc GST</span> : null}
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}

        {/* ─── Assumptions + Risks ──────────────────────── */}
        <div className="mt-8 grid gap-5 sm:grid-cols-2 sm:gap-6">
          {Array.isArray(quote.assumptions) && quote.assumptions.length > 0 ? (
            <section className="rounded-lg border border-zinc-200 bg-white p-5 sm:p-6">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600">What's assumed</h2>
              <ul className="mt-4 list-inside list-disc space-y-2 text-sm leading-relaxed text-zinc-700">
                {(quote.assumptions as string[]).map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </section>
          ) : null}

          {Array.isArray(quote.risk_flags) && quote.risk_flags.length > 0 ? (
            <section className="rounded-lg border border-amber-200 bg-amber-50 p-5 sm:p-6">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-amber-700">Things to be aware of</h2>
              <ul className="mt-4 list-inside list-disc space-y-2 text-sm leading-relaxed text-amber-900">
                {(quote.risk_flags as Array<string | { description?: string }>).map((r, i) => (
                  <li key={i}>{typeof r === 'string' ? r : (r?.description ?? JSON.stringify(r))}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        {/* ─── Timeframe + GST note ─────────────────────── */}
        {(quote.estimated_timeframe || quote.gst_note) ? (
          <section className="mt-8 grid gap-3 rounded-lg border border-zinc-200 bg-white p-5 text-sm sm:p-6">
            {quote.estimated_timeframe ? (
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-zinc-500">Estimated timeframe</span>
                <span className="text-right font-medium text-zinc-800">{quote.estimated_timeframe}</span>
              </div>
            ) : null}
            {quote.gst_note ? (
              <div className="flex items-baseline justify-between gap-4 border-t border-zinc-100 pt-3">
                <span className="text-zinc-500">GST</span>
                <span className="text-right text-xs text-zinc-600">{quote.gst_note}</span>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* ─── Tradie / licence footer ──────────────────── */}
        <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 text-xs text-zinc-600 sm:p-6">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {pricingBook?.licence_type && pricingBook?.licence_state ? (
              <span><strong className="font-semibold text-zinc-800">Licence:</strong> {pricingBook.licence_type} ({pricingBook.licence_state}){pricingBook.licence_number ? ` · ${pricingBook.licence_number}` : ''}</span>
            ) : null}
            {pricingBook?.gst_registered ? <span><strong className="font-semibold text-zinc-800">GST:</strong> Registered</span> : null}
            <span><strong className="font-semibold text-zinc-800">Quote ref:</strong> <span className="font-mono">{quoteRef}</span></span>
          </div>
          <p className="mt-4 text-zinc-500">
            This quote is a draft prepared via QuoteMate. Final scope is confirmed by your tradie before any work commences. Australian Consumer Law applies.
          </p>
        </section>

        <p className="mt-10 text-center text-xs text-zinc-400">
          Powered by <Link href="/" className="underline underline-offset-2 hover:text-zinc-600">QuoteMate</Link> · Built in Australia
        </p>
      </div>
    </main>
  )
}

/* ─────────────── Components ─────────────── */

function CustomerPhotos({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null
  return (
    <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 sm:p-6">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600">Photos you sent</h2>
      <p className="mt-2 text-xs text-zinc-500">Your tradie reviewed these to draft the quote below. Tap any photo to view full-size.</p>
      <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3">
        {urls.map((url, i) => (
          <a
            key={i}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="block aspect-square overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 transition-opacity hover:opacity-90"
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
    </section>
  )
}

function TierCard({
  keyName,
  tier,
  recommended,
  link,
  depositPct,
  paid,
  disabled,
  jobType,
}: {
  keyName: 'good' | 'better' | 'best'
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

  const accent =
    keyName === 'good' ? { ring: 'border-zinc-200', tag: 'bg-zinc-100 text-zinc-700' } :
    keyName === 'better' ? { ring: 'border-blue-300', tag: 'bg-blue-100 text-blue-700' } :
    { ring: 'border-violet-300', tag: 'bg-violet-100 text-violet-700' }

  return (
    <article className={`relative overflow-hidden rounded-lg border-2 ${recommended ? accent.ring : 'border-zinc-200'} bg-white`}>
      {recommended ? (
        <span className="absolute top-3 left-5 z-10 rounded-full bg-zinc-900 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white shadow-sm">
          Recommended
        </span>
      ) : null}

      {/* Indicative product photo (mocked for v1 — see lib/quote/tier-photos.ts) */}
      <div className="relative aspect-video w-full overflow-hidden border-b border-zinc-100 bg-zinc-50">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.url}
          alt={photo.alt}
          loading="lazy"
          className="h-full w-full object-cover"
        />
        <span className="absolute bottom-3 left-3 rounded-md bg-white/90 px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-700 backdrop-blur-sm">
          Indicative · {photo.caption}
        </span>
      </div>

      <div className="p-5 sm:p-6">

      <div className="flex items-start justify-between gap-4">
        <div>
          <span className={`inline-block rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-widest ${accent.tag}`}>
            {keyName}
          </span>
          {cleanLabel ? <h3 className="mt-2 text-lg font-bold tracking-tight">{cleanLabel}</h3> : null}
        </div>
        <div className="text-right">
          <div className="text-2xl font-extrabold tracking-tight sm:text-3xl">${fmt(totalIncGst)}</div>
          <div className="text-xs text-zinc-500">inc GST</div>
        </div>
      </div>

      {Array.isArray(tier.line_items) && tier.line_items.length > 0 ? (
        <ul className="mt-5 divide-y divide-zinc-100 border-t border-zinc-100 text-sm">
          {tier.line_items.map((li, i) => (
            <li key={i} className="flex items-start justify-between gap-4 py-3">
              <div className="flex-1">
                <div className="text-zinc-800">{li.description}</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {li.quantity} × {li.unit} @ ${fmt(asNumber(li.unit_price_ex_gst))} ex GST
                </div>
              </div>
              <div className="font-mono text-sm text-zinc-700">${fmt(asNumber(li.total_ex_gst))}</div>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 border-t border-zinc-100 pt-4">
        {paid ? (
          <div className="rounded-md bg-emerald-50 px-4 py-3 text-center text-sm font-semibold text-emerald-700">
            Deposit received — your tradie will be in touch.
          </div>
        ) : disabled ? (
          <div className="rounded-md bg-zinc-100 px-4 py-3 text-center text-xs text-zinc-500">
            A different option has already been confirmed.
          </div>
        ) : link ? (
          <a
            href={link}
            className="block rounded-md bg-zinc-900 px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:bg-zinc-700"
          >
            {dep ? `Lock in this option · $${fmt(dep)} deposit` : 'Lock in this option'}
          </a>
        ) : (
          <div className="rounded-md bg-zinc-100 px-4 py-3 text-center text-xs text-zinc-500">
            Reply to your tradie's SMS to confirm this option.
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
    <section className="mt-8 rounded-lg border-2 border-amber-300 bg-amber-50 p-6 sm:p-8">
      <h2 className="text-xs font-bold uppercase tracking-widest text-amber-700">Site visit required</h2>
      <p className="mt-3 text-base leading-relaxed text-amber-950">
        Every site is different — we can't price this one safely without seeing the work in person.
      </p>
      {reason ? (
        <p className="mt-3 rounded-md border border-amber-200 bg-white/50 p-3 text-sm text-amber-900">
          <strong className="font-semibold">Why a visit:</strong> {reason}
        </p>
      ) : null}

      <div className="mt-6 flex items-baseline gap-3">
        <span className="text-3xl font-extrabold tracking-tight text-amber-950 sm:text-4xl">$199</span>
        <span className="text-sm text-amber-900">refundable site visit · credited toward your final quote</span>
      </div>

      <div className="mt-5">
        {paid ? (
          <div className="rounded-md bg-emerald-50 px-4 py-3 text-center text-sm font-semibold text-emerald-700">
            Site visit booked — your tradie will be in touch.
          </div>
        ) : link ? (
          <a
            href={`/r/${shareToken}/inspection`}
            className="block rounded-md bg-amber-600 px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:bg-amber-500"
          >
            Lock in your site visit · $199
          </a>
        ) : (
          <div className="rounded-md bg-white/60 px-4 py-3 text-center text-xs text-amber-900">
            Reply to your tradie's SMS to book a site visit.
          </div>
        )}
      </div>
    </section>
  )
}
