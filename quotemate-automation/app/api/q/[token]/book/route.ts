// Booking endpoint — called by the SlotPicker on the booking page.
//
// WP6 reorder: BOOK FIRST, PAY LAST. This route no longer requires a
// paid deposit. It records the customer's chosen time on the quote and
// puts it into 'reserved', then hands back the pay URL as `next` so the
// customer is sent to the deposit step (the LAST step). The booking is
// only CONFIRMED — status='accepted', booking_state='booked', slot
// removed from availability, confirmation SMS sent — when the deposit is
// actually paid, which now happens in the Stripe webhook.
//
// Slot-hold model ("confirm slot on payment"): the picked slot is NOT
// removed from tradies.available_slots here, so an abandoned checkout
// never strands a slot. The (small, pilot-tolerated) trade-off is two
// customers could pick the same time before either pays — the webhook
// resolves that when finalising.
//
// Hardening rules:
//   - share_token must resolve to a quote
//   - if the quote is already PAID + scheduled → already booked (409)
//   - a not-yet-paid quote may (re-)pick a slot freely
//   - slot must be a published slot in tradies.available_slots
//   - slot must be a parseable ISO timestamp in the future

import { createClient } from '@supabase/supabase-js'
import { pipelineLog } from '@/lib/log/pipeline'
import { BOOKING_STATE } from '@/lib/quote/hold'

export const maxDuration = 30

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const PAY_TIERS = new Set(['good', 'better', 'best'])

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const log = pipelineLog('dispatch')
  const { token } = await ctx.params
  log.step('slot reservation attempt', { token: token.slice(0, 8) + '…' })

  let body: { slot?: unknown; tier?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const slot = typeof body.slot === 'string' ? body.slot : null
  if (!slot) {
    return Response.json({ ok: false, error: 'slot is required' }, { status: 400 })
  }

  const slotMs = Date.parse(slot)
  if (!Number.isFinite(slotMs)) {
    return Response.json({ ok: false, error: 'slot is not a valid ISO timestamp' }, { status: 400 })
  }
  if (slotMs <= Date.now()) {
    return Response.json({ ok: false, error: 'slot must be in the future' }, { status: 400 })
  }

  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .select('id, paid_at, scheduled_at, selected_tier, share_token, intake_id, tenant_id')
    .eq('share_token', token)
    .maybeSingle()

  if (quoteErr) {
    log.err('quote lookup failed', quoteErr.message)
    return Response.json({ ok: false, error: 'Lookup failed' }, { status: 500 })
  }
  if (!quote) {
    return Response.json({ ok: false, error: 'Quote not found' }, { status: 404 })
  }
  // Already booked + paid → terminal, don't let them re-pick.
  if (quote.paid_at && quote.scheduled_at) {
    return Response.json(
      { ok: false, error: 'This quote is already booked' },
      { status: 409 },
    )
  }

  const { data: tradie, error: tradieErr } = await supabase
    .from('tradies')
    .select('id, available_slots')
    .limit(1)
    .maybeSingle()

  if (tradieErr) {
    log.err('tradie lookup failed', tradieErr.message)
    return Response.json({ ok: false, error: 'Lookup failed' }, { status: 500 })
  }
  if (!tradie) {
    return Response.json({ ok: false, error: 'No tradie configured' }, { status: 409 })
  }

  const currentSlots: string[] = Array.isArray(tradie.available_slots)
    ? (tradie.available_slots as string[])
    : []

  if (!currentSlots.includes(slot)) {
    log.err('slot not available', null, {
      slot,
      currentSlots: currentSlots.slice(0, 10),
    })
    return Response.json({ ok: false, error: 'That slot is no longer available' }, { status: 409 })
  }

  const nowIso = new Date().toISOString()

  // Reserve the time on the quote. We deliberately do NOT set
  // status='accepted'/accepted_at and do NOT prune the tradie's
  // available_slots — the booking is only CONFIRMED on payment (the
  // Stripe webhook). booking_state='reserved' surfaces "time picked,
  // awaiting deposit" on the dashboard.
  const { error: quoteUpdateErr } = await supabase
    .from('quotes')
    .update({
      scheduled_at: slot,
      booking_state: BOOKING_STATE.RESERVED,
      last_status_at: nowIso,
    })
    .eq('id', quote.id)

  if (quoteUpdateErr) {
    log.err('quote reserve failed', quoteUpdateErr.message, { quote_id: quote.id })
    return Response.json({ ok: false, error: 'Failed to reserve that time' }, { status: 500 })
  }

  // Resolve which tier's deposit to charge: the tier the customer chose
  // on the quote page (passed through), else the quote's selected_tier,
  // else 'better' (the canonical default).
  const reqTier = typeof body.tier === 'string' ? body.tier : null
  const tier =
    reqTier && PAY_TIERS.has(reqTier)
      ? reqTier
      : PAY_TIERS.has(String(quote.selected_tier))
        ? String(quote.selected_tier)
        : 'better'
  const next = `/r/${token}/${tier}`

  log.done('slot reserved — sending customer to deposit (last step)', {
    quote_id: quote.id,
    slot,
    tier,
  })

  return Response.json({ ok: true, scheduled_at: slot, next })
}
