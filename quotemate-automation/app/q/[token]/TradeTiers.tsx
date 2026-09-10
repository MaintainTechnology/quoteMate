// /q/[token] — non-electrical tier options, rendered INSTEAD of the generic
// electrical TierCard grid for any non-generic trade (spec R2/R9/R18: a roofing
// — or solar/paint/etc. — quote must never show the electrical line-item card).
//
// Defaults to roofing framing (patch/repair · re-roof · upgrade) since roofing
// is the trade that actually lands here as a quotes-table row; callers can pass
// generic labels for any other non-generic trade that reaches /q/[token] so it
// still avoids the electrical card. Pairs with RoofHeroStrip above it.
//
// Server component (links only). Maintain design system.

import Link from 'next/link'
import { tierLabelsForTrade } from '@/lib/quote/trade-format'
import { depositCents, totalIncGstCents } from '@/lib/quote/money'
import { quoteAmount, formatQuoteAmount } from '@/lib/quote/display-money'

type Tier = {
  label: string
  subtotal_ex_gst: number | string
  line_items?: unknown[]
} | null

type TierKey = 'good' | 'better' | 'best'

type Props = {
  tiers: Record<TierKey, Tier>
  token: string
  /** Per-tier Stripe deposit links — present ⇒ Pay Deposit CTA renders (R12). */
  stripeLinks: Partial<Record<TierKey, string>>
  /** Deposit percentage from the tenant's pricing book, if any. */
  depositPct: number | null | undefined
  /** The tier the tradie flagged as recommended (quotes.selected_tier). */
  selectedTier: string | null
  /** Applied early-bird discount %, already resolved by the page. */
  appliedDiscountPct: number
  isPaid: boolean
  paidTier: string | null
  /** Price hold lapsed → suppress the Pay Deposit CTA (customer must reply
   *  for a refreshed quote). Defaults false. */
  priceExpired?: boolean
  /** Whether these tiers are a CONFIRMED, deposit-payable price (e.g. a
   *  commercial-painting tender). When true the per-tier CTA links to
   *  /r/<token>/<tier>, which mints a fresh Stripe Session per click — no
   *  pre-stored stripeLinks needed. When false (default) the price is
   *  indicative (e.g. roofing on-site) and the deposit CTA is withheld in
   *  favour of the $99 site-visit path shown above the cards. */
  depositEnabled?: boolean
  /** Section heading. Defaults to a roofing-appropriate heading. */
  heading?: string
  /** Per-tier labels. Defaults to roofing framing. */
  labels?: Record<TierKey, string>
  /** Per-tier descriptive blurbs. Defaults to roofing copy. */
  blurbs?: Record<TierKey, string>
  /** Footnote under the cards. Defaults to the roofing inspection note. */
  footnote?: string
  /** pricing_book.gst_registered (P1) — prices honour it like every other
   *  surface. Defaults true (every live tenant is registered today). */
  gstRegistered?: boolean | null
}

const ROOF_TIER_BLURB: Record<TierKey, string> = {
  good: 'Targeted repairs to the worst-affected sections — the budget-conscious fix to buy time.',
  better: 'A full replacement of the roof covering — the recommended long-term solution.',
  best: 'Premium materials and upgrades for maximum lifespan and street appeal.',
}
const ROOF_FOOTNOTE =
  'Final price is confirmed after our on-site inspection. Pricing is calculated from satellite measurements and your declared roof material and pitch.'

// Money maths + formatting come from lib/quote/money.ts — the same canonical
// order (discount the ex-GST base → GST if registered → round once) the page,
// SMS, PDF and Stripe charge all use (P4: this file previously discounted
// before rounding while the page rounded before discounting).
const fmt = formatQuoteAmount

export function TradeTiers({
  tiers,
  token,
  stripeLinks,
  depositPct,
  selectedTier,
  appliedDiscountPct,
  isPaid,
  paidTier,
  priceExpired = false,
  depositEnabled = false,
  heading,
  labels = tierLabelsForTrade('roofing'),
  blurbs = ROOF_TIER_BLURB,
  footnote = ROOF_FOOTNOTE,
  gstRegistered,
}: Props) {
  const keys = (['good', 'better', 'best'] as const).filter((k) => tiers[k])
  const resolvedHeading =
    heading ?? (keys.length === 1 ? 'Your roofing option' : 'Your roofing options')
  return (
    <section>
      <h2 className="mb-6 font-mono text-xs uppercase tracking-[0.15em] text-text-dim">
        {resolvedHeading}
      </h2>
      <div className="grid gap-5 sm:gap-6 lg:grid-cols-3">
        {keys.map((key) => {
          const tier = tiers[key]!
          const money = { discountPct: appliedDiscountPct, gstRegistered }
          const totalCents = totalIncGstCents(tier.subtotal_ex_gst, money)
          const priceInc = quoteAmount(totalCents)
          const depCents = depositCents(totalCents, depositPct)
          const dep = depCents > 0 ? quoteAmount(depCents) : null
          // A confirmed, deposit-payable tier links straight to the short-link
          // (which mints a fresh Session per click); an indicative tier has no
          // deposit CTA. stripeLinks is retained only as a legacy fallback.
          const href =
            !priceExpired && (depositEnabled || stripeLinks[key])
              ? `/r/${token}/${key}`
              : null
          const recommended = selectedTier === key
          const paid = isPaid && paidTier === key
          const dimmed = isPaid && paidTier !== key
          return (
            <article
              key={key}
              className={`relative flex flex-col border bg-ink-card p-6 sm:p-7 ${
                recommended ? 'border-accent' : 'border-ink-line'
              } ${dimmed ? 'opacity-50' : ''}`}
            >
              {recommended ? (
                <span className="absolute -top-px left-0 bg-accent px-2 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-ink-deep">
                  Recommended
                </span>
              ) : null}
              <div className="mt-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-accent">
                {labels[key]}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-text-sec">{blurbs[key]}</p>

              <div className="mt-5 border-t border-ink-line pt-5">
                <div className="font-mono text-3xl font-bold tabular-nums text-text-pri">
                  ${fmt(priceInc)}
                </div>
                <div className="mt-1 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">
                  {gstRegistered === false ? 'No GST' : 'inc GST'}
                  {appliedDiscountPct > 0 ? ` · ${appliedDiscountPct}% off applied` : ''}
                </div>
                {dep !== null ? (
                  <div className="mt-1 text-sm text-text-sec">
                    Deposit to book: <span className="font-semibold text-text-pri">${fmt(dep)}</span>
                  </div>
                ) : null}
              </div>

              <div className="mt-6">
                {paid ? (
                  <div className="border border-success/40 bg-success/10 px-4 py-3 text-center font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-success">
                    Deposit paid
                  </div>
                ) : priceExpired ? (
                  <div className="border border-warning/40 px-4 py-3 text-center font-mono text-[0.72rem] uppercase tracking-[0.14em] text-warning">
                    Price expired · reply for a refreshed quote
                  </div>
                ) : href ? (
                  <Link
                    href={href}
                    className="block bg-accent px-4 py-3 text-center font-mono text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-ink-deep transition-colors hover:bg-accent-press"
                  >
                    Pay deposit
                  </Link>
                ) : (
                  <div className="border border-ink-line px-4 py-3 text-center font-mono text-[0.72rem] uppercase tracking-[0.14em] text-text-dim">
                    Reply to SMS to confirm
                  </div>
                )}
              </div>
            </article>
          )
        })}
      </div>
      <p className="mt-5 text-sm leading-relaxed text-text-dim">{footnote}</p>
    </section>
  )
}
