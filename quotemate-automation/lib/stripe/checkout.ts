// Creates one Stripe Checkout Session per quote tier (good/better/best).
// Each Session charges the deposit (default 30% of inc-GST tier total).
// Returns a { good, better, best } map of Session URLs ready to embed in SMS.
//
// Platform-direct charging (NOT Stripe Connect) — money lands in QuoteMate's
// Stripe account. When tradie #2 onboards, switch to Connect by adding
// `stripeAccount` and `application_fee_amount` to the call.

import { getStripe } from './client'
import { randomBytes } from 'node:crypto'
import { clampDiscountPct } from '@/lib/quote/early-bird'

type Tier = { label: string; subtotal_ex_gst: number | string } | null

type QuoteForCheckout = {
  id: string
  good: Tier
  better: Tier
  best: Tier
  deposit_pct: number | string  // e.g. 30 = 30%
}

type IntakeForCheckout = {
  job_type: string
  scope?: { item_count?: number; description?: string } | null
  caller?: { name?: string; email?: string } | null
}

export type StripeLinks = {
  good?: string
  better?: string
  best?: string
  /** Set on inspection-required quotes — single $99 site-visit deposit Session URL. */
  inspection?: string
}

/** Industry-standard $99 refundable site-visit deposit. Hardcoded for v1
 *  per the SOP; move to pricing_book.inspection_fee_amount when multi-tradie
 *  configurability is needed. */
const INSPECTION_FEE_AUD_CENTS = 9900

/**
 * Generate a URL-safe share token (used in success URLs and future portal route).
 * 16 bytes → 22 chars after base64url, ~128 bits of entropy.
 */
export function generateShareToken(): string {
  return randomBytes(16).toString('base64url')
}

function tierIncGstCents(tier: Tier): number {
  if (!tier) return 0
  const ex = typeof tier.subtotal_ex_gst === 'string' ? parseFloat(tier.subtotal_ex_gst) : tier.subtotal_ex_gst
  const inc = ex * 1.10
  return Math.round(inc * 100)
}

function depositCents(tierIncGstCents: number, depositPct: number): number {
  return Math.round(tierIncGstCents * (depositPct / 100))
}

/**
 * v8 — apply an early-booking (whole-job) discount to a tier's inc-GST
 * cents amount. The discount reduces the WHOLE job, so it flows through
 * to the deposit proportionally. `discountPct` is clamped to the
 * platform cap (15%) so a bad value can never over-discount. A 0 /
 * missing pct returns the amount unchanged.
 */
function discountedIncGstCents(
  incGstCents: number,
  discountPct: number | null | undefined,
): number {
  const pct = clampDiscountPct(discountPct)
  if (pct <= 0) return incGstCents
  return Math.round(incGstCents * (1 - pct / 100))
}

export async function createCheckoutSessionsForQuote(opts: {
  quote: QuoteForCheckout
  intake: IntakeForCheckout
  shareToken: string
  appUrl: string  // base URL for success/cancel, e.g. https://quote-mate-rho.vercel.app
}): Promise<StripeLinks> {
  const stripe = getStripe()
  const depositPct = typeof opts.quote.deposit_pct === 'string'
    ? parseFloat(opts.quote.deposit_pct)
    : opts.quote.deposit_pct

  const tiers: Array<['good' | 'better' | 'best', Tier]> = [
    ['good', opts.quote.good],
    ['better', opts.quote.better],
    ['best', opts.quote.best],
  ]

  const links: StripeLinks = {}

  for (const [key, tier] of tiers) {
    if (!tier) continue
    const incCents = tierIncGstCents(tier)
    const deposit = depositCents(incCents, depositPct)
    if (deposit <= 0) continue

    const productName = buildProductName(opts.intake, key, tier)

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'aud',
            product_data: {
              name: productName,
              description: `${depositPct}% deposit · balance due on completion`,
            },
            unit_amount: deposit,
          },
          quantity: 1,
        },
      ],
      customer_email: opts.intake.caller?.email || undefined,
      success_url: `${opts.appUrl}/q/${opts.shareToken}/paid?tier=${key}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${opts.appUrl}/q/${opts.shareToken}/cancelled`,
      metadata: {
        quote_id: opts.quote.id,
        tier: key,
        deposit_pct: String(depositPct),
        full_total_inc_gst_cents: String(incCents),
      },
      payment_intent_data: {
        metadata: {
          quote_id: opts.quote.id,
          tier: key,
        },
      },
      // 24h default Session expiry is fine for a quote workflow.
    })

    if (session.url) links[key] = session.url
  }

  return links
}

function buildProductName(intake: IntakeForCheckout, tierKey: string, tier: NonNullable<Tier>): string {
  const count = intake.scope?.item_count
  const job = intake.job_type.replace(/_/g, ' ')
  const lead = count ? `${count} ${job}` : job
  const tierLabel = tier.label || tierKey
  return `QuoteMate — ${lead} · ${tierLabel}`
}

/**
 * Expire a Stripe Checkout Session so a stale customer link can't be
 * paid after the tradie edited the quote. Idempotent: a Session that's
 * already expired (or one we can't find) returns ok without throwing —
 * we don't want a stale URL in the DB to block a legitimate price edit.
 */
export async function expireCheckoutSession(sessionUrl: string): Promise<{ ok: boolean; reason?: string }> {
  // Stripe Session URLs look like:
  //   https://checkout.stripe.com/c/pay/cs_test_a1xxxxx...
  // Pull the `cs_*` SID out of the path. If the URL doesn't carry one
  // (legacy quotes that stored a different shape), skip silently —
  // there's nothing to expire on Stripe's side.
  const m = sessionUrl.match(/cs_[A-Za-z0-9_]+/)
  if (!m) return { ok: true, reason: 'no_session_id_in_url' }
  const sessionId = m[0]
  try {
    const stripe = getStripe()
    await stripe.checkout.sessions.expire(sessionId)
    return { ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    // Most failure modes are non-fatal for the edit flow: the Session
    // was already expired, already paid, or the SID was malformed.
    // We still want to issue the replacement Session so the customer's
    // next click goes to the new price.
    return { ok: false, reason: msg }
  }
}

/**
 * Create a Stripe Checkout Session for a single tier on an existing
 * quote — used by the tradie edit endpoint to issue a replacement
 * Session after a price change. Same shape as createCheckoutSessionsForQuote
 * but scoped to one tier.
 */
export async function createCheckoutSessionForTier(opts: {
  quote: QuoteForCheckout
  tierKey: 'good' | 'better' | 'best'
  intake: IntakeForCheckout
  shareToken: string
  appUrl: string
  /** v8 — whole-job early-booking discount %. When > 0 the tier total
   *  (and therefore the deposit) is reduced before the Session is
   *  created. Clamped to the 15% platform cap. Omitted / 0 → no
   *  discount, behaviour identical to before. */
  discountPct?: number | null
}): Promise<string | null> {
  const stripe = getStripe()
  const tier = opts.quote[opts.tierKey]
  if (!tier) return null
  const depositPct = typeof opts.quote.deposit_pct === 'string'
    ? parseFloat(opts.quote.deposit_pct)
    : opts.quote.deposit_pct
  const fullIncCents = tierIncGstCents(tier)
  const discountPct = clampDiscountPct(opts.discountPct)
  const incCents = discountedIncGstCents(fullIncCents, discountPct)
  const deposit = depositCents(incCents, depositPct)
  if (deposit <= 0) return null

  const productName = buildProductName(opts.intake, opts.tierKey, tier)
  const depositDesc = discountPct > 0
    ? `${depositPct}% deposit · ${discountPct}% early-booking discount applied · balance due on completion`
    : `${depositPct}% deposit · balance due on completion`
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'aud',
          product_data: {
            name: productName,
            description: depositDesc,
          },
          unit_amount: deposit,
        },
        quantity: 1,
      },
    ],
    customer_email: opts.intake.caller?.email || undefined,
    success_url: `${opts.appUrl}/q/${opts.shareToken}/paid?tier=${opts.tierKey}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${opts.appUrl}/q/${opts.shareToken}/cancelled`,
    metadata: {
      quote_id: opts.quote.id,
      tier: opts.tierKey,
      deposit_pct: String(depositPct),
      // Discounted inc-GST total — the figure the deposit % was taken
      // from. `full_total_inc_gst_cents` keeps reporting the pre-discount
      // total so the saving stays auditable from Stripe metadata alone.
      full_total_inc_gst_cents: String(fullIncCents),
      discounted_total_inc_gst_cents: String(incCents),
      early_bird_discount_pct: String(discountPct),
    },
    payment_intent_data: {
      metadata: {
        quote_id: opts.quote.id,
        tier: opts.tierKey,
      },
    },
  })
  return session.url ?? null
}

/**
 * Inspection-required path: create a single Stripe Checkout Session for
 * the $99 refundable site-visit deposit. Sets metadata.tier='inspection'
 * so the webhook can record it on the quote correctly.
 */
export async function createInspectionCheckoutSession(opts: {
  quoteId: string
  intake: IntakeForCheckout
  shareToken: string
  appUrl: string
}): Promise<string | null> {
  const stripe = getStripe()
  const job = opts.intake.job_type.replace(/_/g, ' ')

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'aud',
          product_data: {
            name: `QuoteMate — site visit (${job})`,
            description: 'Refundable site-visit deposit. Credited toward your final quote when accepted.',
          },
          unit_amount: INSPECTION_FEE_AUD_CENTS,
        },
        quantity: 1,
      },
    ],
    customer_email: opts.intake.caller?.email || undefined,
    success_url: `${opts.appUrl}/q/${opts.shareToken}/paid?tier=inspection&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${opts.appUrl}/q/${opts.shareToken}/cancelled`,
    metadata: {
      quote_id: opts.quoteId,
      tier: 'inspection',
      fee_aud_cents: String(INSPECTION_FEE_AUD_CENTS),
    },
    payment_intent_data: {
      metadata: {
        quote_id: opts.quoteId,
        tier: 'inspection',
      },
    },
  })

  return session.url ?? null
}
