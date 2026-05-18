// Short-link redirector — keeps the SMS body small.
// SMS contains: https://<domain>/r/<token>/<tier>  (~ 60 chars)
//
// WP6 reorder (book first, pay LAST). This is the single choke-point that
// every pay link flows through — the on-page tier buttons AND the pay
// links already sitting in 138 customers' SMS threads. So flipping the
// funnel here flips it everywhere ("force book-first for all"):
//
//   already paid           → /q/<token>/paid
//   not paid, NO slot yet   → /q/<token>/book?tier=<tier>   (pick a time)
//   not paid, slot chosen   → Stripe Checkout (deposit = the last step)
//   inspection ($199 fee)   → Stripe (pay-first preserved; see booking.ts)

import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { payRedirectTarget } from '@/lib/quote/booking'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const VALID_TIERS = new Set(['good', 'better', 'best', 'inspection'])

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string; tier: string }> }) {
  const { token, tier } = await ctx.params
  if (!VALID_TIERS.has(tier)) {
    return new Response('Invalid tier', { status: 400 })
  }

  const { data: quote } = await supabase
    .from('quotes')
    .select('id, stripe_links, paid_at, scheduled_at')
    .eq('share_token', token)
    .single()

  if (!quote) return new Response('Not found', { status: 404 })

  const target = payRedirectTarget({
    paid: !!quote.paid_at,
    scheduledAt: (quote.scheduled_at as string | null) ?? null,
    tier,
  })

  if (target === 'paid') {
    return Response.redirect(
      `${process.env.APP_URL}/q/${token}/paid?tier=${tier}&already=1`,
      302
    )
  }

  if (target === 'book') {
    // No time chosen yet — pick a slot FIRST, carrying the tier so the
    // deposit step at the end charges the right amount.
    return Response.redirect(
      `${process.env.APP_URL}/q/${token}/book?tier=${tier}`,
      302
    )
  }

  // target === 'stripe' — slot already chosen (or inspection fee): the
  // deposit is now the final step.
  const url = (quote.stripe_links as Record<string, string> | null)?.[tier]
  if (!url) return new Response('No payment link for this tier', { status: 404 })

  return Response.redirect(url, 302)
}
