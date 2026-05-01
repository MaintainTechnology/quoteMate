// Short-link redirector — keeps the SMS body small.
// SMS contains: https://<domain>/r/<token>/<tier>  (~ 60 chars)
// We look up the quote by share_token, then 302-redirect to the persisted
// Stripe Checkout URL (~250 chars).

import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'

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
    .select('id, stripe_links, paid_at')
    .eq('share_token', token)
    .single()

  if (!quote) return new Response('Not found', { status: 404 })
  if (quote.paid_at) {
    return Response.redirect(
      `${process.env.APP_URL}/q/${token}/paid?tier=${tier}&already=1`,
      302
    )
  }

  const url = (quote.stripe_links as Record<string, string> | null)?.[tier]
  if (!url) return new Response('No payment link for this tier', { status: 404 })

  return Response.redirect(url, 302)
}
