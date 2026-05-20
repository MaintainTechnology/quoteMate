// Stripe webhook — authoritative source for "quote was paid".
// Subscribes to `checkout.session.completed`. Idempotent via Stripe's
// event.id (already-processed events are no-ops) and via paid_stripe_session_id
// on the quote row (re-delivery of same session is a no-op).

import { after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe/client'
import { pipelineLog } from '@/lib/log/pipeline'
import { bookingStateOnPaid, shouldFinaliseBookingOnPaid } from '@/lib/quote/booking'
import { notifyBookingConfirmed } from '@/lib/quote/booking-notify'
import { advanceQuoteStatus } from '@/lib/quote/lifecycle'
import type Stripe from 'stripe'

export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: Request) {
  const log = pipelineLog('dispatch')
  log.step('stripe webhook received')

  const sig = req.headers.get('stripe-signature')
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!sig || !secret) {
    log.err('missing signature or webhook secret', null, { has_sig: !!sig, has_secret: !!secret })
    return new Response('Missing signature', { status: 400 })
  }

  const raw = await req.text()
  let event: Stripe.Event
  try {
    event = await getStripe().webhooks.constructEventAsync(raw, sig, secret)
  } catch (err: any) {
    log.err('signature verification failed', err)
    return new Response('Invalid signature', { status: 400 })
  }

  log.ok('event verified', { type: event.type, id: event.id })

  if (event.type !== 'checkout.session.completed') {
    log.ok('event type not handled, acknowledging', { type: event.type })
    return Response.json({ received: true })
  }

  const session = event.data.object as Stripe.Checkout.Session
  const quoteId = session.metadata?.quote_id
  const tier = session.metadata?.tier
  if (!quoteId || !tier) {
    log.err('session missing quote_id/tier metadata', null, { session: session.id })
    return Response.json({ received: true })  // ack so Stripe doesn't retry forever
  }

  const { data: existing } = await supabase
    .from('quotes')
    .select('id, paid_at, paid_stripe_session_id, scheduled_at, intake_id, tenant_id, share_token')
    .eq('id', quoteId)
    .single()

  if (!existing) {
    log.err('quote not found', null, { quote_id: quoteId })
    return Response.json({ received: true })
  }

  if (existing.paid_stripe_session_id === session.id) {
    log.ok('duplicate event for already-recorded session, skipping', { quote_id: quoteId, session: session.id })
    return Response.json({ received: true, idempotent: true })
  }

  if (existing.paid_at) {
    log.ok('quote already paid (different session), skipping', { quote_id: quoteId, prior_session: existing.paid_stripe_session_id, this_session: session.id })
    return Response.json({ received: true })
  }

  const { error } = await supabase
    .from('quotes')
    .update({
      paid_at: new Date().toISOString(),
      paid_tier: tier,
      paid_stripe_session_id: session.id,
    })
    .eq('id', quoteId)

  if (error) {
    log.err('quote update failed', error.message, { quote_id: quoteId })
    return new Response('DB update failed', { status: 500 })
  }

  // WP6 reorder — the deposit is the LAST step, so paying CONFIRMS the
  // booking. If the customer picked a time before paying (the new
  // default for every quote), finalise it now: status='accepted',
  // booking_state='booked', free the held slot, and send the
  // confirmation SMS (moved here from the book route so it only fires
  // once the job is genuinely locked in). If they paid with no slot
  // (an old SMS link, or no slots were published), fall back to
  // 'reserved' and the /paid page prompts them to pick a time.
  //
  // Best-effort + isolated: paid_at is already committed above, so a
  // failure here MUST NOT fail the webhook or undo the payment.
  try {
    const scheduledAt = (existing.scheduled_at as string | null) ?? null
    const bookingState = bookingStateOnPaid(scheduledAt)
    const finalise = shouldFinaliseBookingOnPaid(scheduledAt)
    const nowIso = new Date().toISOString()

    const patch: Record<string, unknown> = { booking_state: bookingState }
    if (finalise) {
      patch.status = 'accepted'
      patch.accepted_at = nowIso
      patch.last_status_at = nowIso
    }
    const { error: bsErr } = await supabase
      .from('quotes')
      .update(patch)
      .eq('id', quoteId)
    if (bsErr) {
      log.err('booking finalise skipped (non-fatal — paid_at IS committed)', bsErr.message, {
        quote_id: quoteId,
        hint: 'apply migration 026 to enable quotes.booking_state',
      })
    } else {
      log.ok('booking finalised on payment', {
        quote_id: quoteId,
        booking_state: bookingState,
        confirmed: finalise,
      })
    }

    if (finalise && scheduledAt) {
      // Slot-hold model = "confirm slot on payment": the slot was NOT
      // removed when the customer picked it, so free it now that it's
      // paid + booked (idempotent — only filters if still present).
      try {
        const { data: tr } = await supabase
          .from('tradies')
          .select('id, available_slots')
          .limit(1)
          .maybeSingle()
        if (tr) {
          const slots = Array.isArray(tr.available_slots)
            ? (tr.available_slots as string[])
            : []
          if (slots.includes(scheduledAt)) {
            await supabase
              .from('tradies')
              .update({ available_slots: slots.filter((s) => s !== scheduledAt) })
              .eq('id', tr.id)
          }
        }
      } catch (e: any) {
        log.err('slot prune failed (non-fatal — booking IS confirmed)', e?.message ?? String(e), {
          quote_id: quoteId,
        })
      }

      // Confirmation SMS to customer + tradie. Deferred via after() so
      // Stripe gets a fast 2xx; notifyBookingConfirmed never throws.
      after(() =>
        notifyBookingConfirmed(supabase, {
          quoteId,
          intakeId: (existing.intake_id as string | null) ?? null,
          tenantId: (existing.tenant_id as string | null) ?? null,
          shareToken: existing.share_token as string,
          slotIso: scheduledAt,
        }),
      )
    }
  } catch (e: any) {
    log.err('booking finalise threw (non-fatal — paid_at committed)', e?.message ?? String(e), { quote_id: quoteId })
  }

  // WP7 — advance the lifecycle ladder to 'paid' so the follow-up queue
  // stops chasing a customer who has paid (paid_at alone never moved the
  // status column before). Monotonic + non-throwing: it won't regress an
  // already-'accepted' quote and a failure here can't undo the committed
  // payment. Mirrors the booking_state best-effort block above.
  await advanceQuoteStatus(supabase, quoteId, 'paid')

  log.done('quote marked paid', {
    quote_id: quoteId,
    tier,
    amount_total: session.amount_total,
    currency: session.currency,
  })
  return Response.json({ received: true })
}
