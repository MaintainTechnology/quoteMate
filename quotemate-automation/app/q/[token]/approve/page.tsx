import { quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { resolveOwnedQuoteCustomerContact } from '@/lib/quote/delivery-recipient'
import { isQuotePageOwner } from '@/lib/quote/page-owner'
import { QuoteAwaitingReview } from '@/app/q/_chrome/QuoteAwaitingReview'
// Mig 078 — tradie-side approve page.
//
// Deep-linked from the buildTradieReviewNotification SMS. Reached at:
//   https://<host>/q/<share_token>/approve
//
// Shows the tradie a quick read of the held quote and gives them ONE
// tap to send the customer SMS that's been sitting on hold. They can
// also edit first by hopping to the existing /q/<token> editor.
//
// Auth: the page itself is publicly reachable (the share_token is
// unguessable, same trust model as /q/<token>); the approve API
// requires the tradie's bearer token. The button on this page
// captures the token from the signed-in session in the browser and
// POSTs it.
//
// Visual language: Maintain Technology brand to match the rest of the
// tradie-facing surfaces (dashboard, /dashboard/pricing-wizard).

import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TradieDashboardPill } from '../../_chrome/TradieDashboardPill'
import { ApproveAction } from './ApproveAction'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export default async function ApprovePage(props: {
  params: Promise<{ token: string }>
}) {
  const { token } = await props.params

  const { data: quote } = await supabase
    .from('quotes')
    .select(
      '*',
    )
    .eq('share_token', token)
    .maybeSingle()

  if (!quote) notFound()
  if (!await isQuotePageOwner(supabase,quote.tenant_id)) return <QuoteAwaitingReview />

  const { data: intake, error: intakeError } = await supabase
    .from('intakes')
    .select('id, tenant_id, job_type, caller, suburb, call_id, customer_id')
    .eq('id', quote.intake_id as string)
    .eq('tenant_id', quote.tenant_id as string)
    .maybeSingle()

  if (intakeError) return <p role="alert">Customer contact temporarily unavailable. Refresh before sending.</p>
  let customerPhone: string | null
  try {
    customerPhone = (await resolveOwnedQuoteCustomerContact(supabase, quote.tenant_id, intake)).phone
  } catch {
    return <p role="alert">Customer contact temporarily unavailable. Refresh before sending.</p>
  }

  const jobType = (intake?.job_type as string) ?? 'job'
  const customerName =
    ((intake?.caller as { name?: string } | null)?.name ?? '').trim() || 'a customer'
  const suburb = (intake?.suburb as string | null) ?? null
  const total = typeof quote.total_inc_gst === 'number'
    ? quote.total_inc_gst
    : parseFloat(String(quote.total_inc_gst ?? 0))

  const status = quote.status as string
  const isHeld = status === 'awaiting_tradie_approval'

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      {/* Owner-only route back — the page is share_token-public, so the
          dashboard link must stay invisible to customers who hold the URL. */}
      <TradieDashboardPill quoteId={quote.id as string} />
      <header className="border-b border-ink-line bg-ink-deep/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="font-extrabold uppercase tracking-tight text-accent">
            QuoteMax
          </Link>
          <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-text-dim">
            Review &amp; send
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-accent mb-3">
          Tradie review
        </div>
        <h1 className="font-extrabold uppercase tracking-[-0.03em] text-[clamp(1.6rem,4.5vw,2.4rem)] leading-none">
          {isHeld ? 'Send this quote?' : 'Quote already actioned'}
        </h1>
        <p className="mt-4 max-w-xl text-text-sec">
          {isHeld ? (
            <>
              The AI drafted this quote and held it for your review per your
              <em> Review before send</em> policy. Tap <strong>Send now</strong>
              {' '}to deliver the customer SMS, or <strong>Edit first</strong>{' '}
              to tweak the numbers before sending.
            </>
          ) : (
            <>This quote is in status <code className="font-mono text-accent">{status}</code>{' '}— no approval action needed.</>
          )}
        </p>

        {/* Quote summary card */}
        <section className="mt-8 border border-ink-line bg-ink-card p-5 sm:p-6">
          <div className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-dim mb-3">
            Quote summary
          </div>
          <div className="flex items-baseline gap-3 mb-3 flex-wrap">
            <span className="font-extrabold tracking-tight text-3xl sm:text-4xl text-text-pri tabular-nums">
              ${total.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </span>
            <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">
              inc GST &middot; {(quote.selected_tier as string | null) ?? 'tier'}
            </span>
          </div>
          <div className="text-sm text-text-sec leading-relaxed">
            <div className="mb-1">
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">Customer:</span>{' '}
              {customerName}
              {suburb ? ` · ${suburb}` : ''}
            </div>
            <div className="mb-3">
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">Job:</span>{' '}
              {jobType.replace(/_/g, ' ')}
            </div>
            {quote.scope_of_works ? (
              <div className="mt-4 border-t border-ink-line pt-4 text-sm text-text-sec">
                {quote.scope_of_works}
              </div>
            ) : null}
          </div>
        </section>

        {/* Actions */}
        {isHeld && <p className="mt-6 text-sm text-text-sec">{customerPhone ? <>Send customer SMS to <strong>{customerPhone}</strong>.</> : 'No customer mobile is available. Add the contact before sending.'}</p>}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {isHeld ? (
            <>
              <ApproveAction quoteId={quote.id as string} shareToken={token} reviewVersion={quoteCustomerReleaseRevision(quote)} customerPhone={customerPhone} />
              <Link
                href={`/q/${token}?edit=1`}
                className="inline-flex items-center justify-center gap-2 border border-ink-line text-text-pri font-mono text-xs uppercase tracking-[0.15em] font-bold px-4 py-3 hover:border-accent/50 hover:text-accent transition-colors"
              >
                Edit first →
              </Link>
            </>
          ) : (
            <Link
              href={`/q/${token}`}
              className="inline-flex items-center justify-center gap-2 bg-accent hover:bg-accent-press text-white font-mono text-xs uppercase tracking-[0.15em] font-bold px-5 py-3 transition-colors"
            >
              Open quote →
            </Link>
          )}
        </div>

        <div className="mt-12 text-center font-mono text-[0.6rem] uppercase tracking-[0.2em] text-text-dim">
          Powered by{' '}
          <Link href="/" className="text-text-sec hover:text-accent transition-colors">
            QuoteMax
          </Link>{' '}
          · Built in Australia
        </div>
      </div>
    </main>
  )
}
