// Booking endpoint — called by the SlotPicker on the booking page.
// Persists `quotes.scheduled_at`, sets status='accepted' + accepted_at,
// and removes the picked slot from `tradies.available_slots`.
//
// Hardening rules (any failure → 4xx, no partial writes):
//   - share_token must resolve to a quote
//   - quote.paid_at must be set (no booking before deposit)
//   - quote.scheduled_at must be null (no double-booking same quote)
//   - slot must currently be in the tradie's available_slots
//   - slot must be a parseable ISO timestamp in the future
//
// Uses two sequential updates rather than a transaction. Race window
// (two customers picking the same slot at once) is tolerated for v0.5
// single-tradie. When tradie #2 onboards, wrap in a stored procedure.

import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { pipelineLog } from '@/lib/log/pipeline'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { buildBookingConfirmationSms, buildTradieBookingNotification } from '@/lib/sms/templates'

export const maxDuration = 30

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const log = pipelineLog('dispatch')
  const { token } = await ctx.params
  log.step('booking attempt', { token: token.slice(0, 8) + '…' })

  let body: { slot?: unknown }
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
    .select('id, paid_at, scheduled_at, share_token, intake_id, tenant_id')
    .eq('share_token', token)
    .maybeSingle()

  if (quoteErr) {
    log.err('quote lookup failed', quoteErr.message)
    return Response.json({ ok: false, error: 'Lookup failed' }, { status: 500 })
  }
  if (!quote) {
    return Response.json({ ok: false, error: 'Quote not found' }, { status: 404 })
  }
  if (!quote.paid_at) {
    return Response.json({ ok: false, error: 'Pay your deposit first' }, { status: 409 })
  }
  if (quote.scheduled_at) {
    return Response.json({ ok: false, error: 'This quote is already scheduled' }, { status: 409 })
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

  const remainingSlots = currentSlots.filter((s) => s !== slot)
  const nowIso = new Date().toISOString()

  const { error: quoteUpdateErr } = await supabase
    .from('quotes')
    .update({
      scheduled_at: slot,
      status: 'accepted',
      accepted_at: nowIso,
    })
    .eq('id', quote.id)

  if (quoteUpdateErr) {
    log.err('quote update failed', quoteUpdateErr.message, { quote_id: quote.id })
    return Response.json({ ok: false, error: 'Failed to lock in slot' }, { status: 500 })
  }

  const { error: tradieUpdateErr } = await supabase
    .from('tradies')
    .update({ available_slots: remainingSlots })
    .eq('id', tradie.id)

  if (tradieUpdateErr) {
    // Quote is already marked scheduled. Log loudly so the operator can
    // manually reconcile the tradie's slot list, but don't fail the request.
    log.err('tradie slot list update failed (quote IS booked, slot list NOT pruned)', tradieUpdateErr.message, {
      quote_id: quote.id,
      tradie_id: tradie.id,
      slot,
    })
  }

  log.done('quote booked', { quote_id: quote.id, slot })

  // Fire confirmation SMS to the customer + tradie. Wrapped in `after()`
  // so the response returns instantly; SMS failures are logged loudly
  // but never undo the booking. Mirrors the pattern in /api/estimate/draft.
  after(async () => {
    const sms = pipelineLog('dispatch', quote.id)
    try {
      const appUrl = process.env.APP_URL ?? 'https://quote-mate-rho.vercel.app'

      // Resolve customer name + phone via intake → calls.
      // intake.caller.phone is set on SMS-sourced quotes; calls.caller_number
      // is set on voice-sourced quotes. Either one is sufficient.
      const { data: intake } = await supabase
        .from('intakes')
        .select('id, call_id, job_type, caller, scope')
        .eq('id', quote.intake_id)
        .maybeSingle()

      let callerNumber: string | null =
        (intake?.caller as { phone?: string } | null)?.phone ?? null

      if (!callerNumber && intake?.call_id) {
        const { data: callRow } = await supabase
          .from('calls')
          .select('caller_number')
          .eq('id', intake.call_id)
          .maybeSingle()
        callerNumber = callRow?.caller_number ?? null
      }

      // v6 multi-tenant: resolve the tenant who owns this quote so the
      // booking confirmation SMS goes FROM their provisioned number
      // (not the shared dev line) and the tradie-notify goes TO their
      // personal mobile (not a shared TRADIE_NOTIFY_NUMBER env var).
      let tenantSmsNumber: string | null = null
      let tenantOwnerMobile: string | null = null
      if (quote.tenant_id) {
        const { data: tenantRow } = await supabase
          .from('tenants')
          .select('twilio_sms_number, owner_mobile')
          .eq('id', quote.tenant_id)
          .maybeSingle()
        tenantSmsNumber = (tenantRow?.twilio_sms_number as string | null) ?? null
        tenantOwnerMobile = (tenantRow?.owner_mobile as string | null) ?? null
      }

      const firstName = (intake?.caller as { name?: string } | null)?.name
      const bookingUrl = `${appUrl}/q/${token}/book`
      const quoteUrl = `${appUrl}/q/${token}`

      // ── Customer SMS — from the tenant's provisioned number so the
      //    booking confirmation lands in the SAME thread as the original
      //    quote (not the shared dev line). Falls back to env for legacy
      //    pre-v6 quotes that have no tenant_id.
      if (callerNumber) {
        const body = buildBookingConfirmationSms({
          firstName,
          scheduledAt: slot,
          bookingUrl,
        })
        const customerFrom = tenantSmsNumber ?? process.env.TWILIO_SMS_NUMBER
        sms.step('sending booking confirmation to customer', {
          to: callerNumber,
          from: customerFrom ?? '(default TWILIO_PHONE_NUMBER)',
        })
        const r = await dispatchQuoteMessage({
          to: callerNumber,
          text: body,
          from: customerFrom ?? undefined,
        })
        if (r.ok) {
          sms.ok('customer booking confirmation sent', { channel: r.channel, sid: r.sid })
        } else {
          sms.err('customer booking confirmation failed', null, {
            sms_code: r.smsAttempt.code,
            sms_reason: r.smsAttempt.reason,
            wa_code: r.waAttempt?.code,
            wa_reason: r.waAttempt?.reason,
          })
        }
      } else {
        sms.ok('customer SMS skipped — no callerNumber resolvable', { quote_id: quote.id })
      }

      // ── Tradie SMS — go to tenant.owner_mobile, from the tenant's
      //    own number so the booking notification lands in the SAME
      //    thread as the tradie's welcome SMS. Falls back to
      //    TRADIE_NOTIFY_NUMBER env for legacy pre-v6 pilot data.
      const notifyMobile = tenantOwnerMobile ?? process.env.TRADIE_NOTIFY_NUMBER
      if (notifyMobile) {
        const tradieBody = buildTradieBookingNotification({
          customerName: firstName,
          customerPhone: callerNumber ?? undefined,
          jobType: intake?.job_type ?? 'other',
          itemCount: (intake?.scope as { item_count?: number } | null)?.item_count,
          scheduledAt: slot,
          quoteUrl,
        })
        sms.step('notifying tradie of booking', {
          to: notifyMobile,
          from: tenantSmsNumber ?? '(default TWILIO_PHONE_NUMBER)',
        })
        const r = await dispatchQuoteMessage({
          to: notifyMobile,
          text: tradieBody,
          from: tenantSmsNumber ?? undefined,
        })
        if (r.ok) {
          sms.ok('tradie booking notification sent', { channel: r.channel, sid: r.sid })
        } else {
          sms.err('tradie booking notification failed', null, {
            sms_code: r.smsAttempt.code,
            sms_reason: r.smsAttempt.reason,
            wa_code: r.waAttempt?.code,
            wa_reason: r.waAttempt?.reason,
          })
        }
      } else {
        sms.ok('tradie notify skipped — no tenant.owner_mobile and no env fallback')
      }
    } catch (e) {
      sms.err('booking SMS dispatch threw — booking IS persisted, only SMS failed', e)
    }
  })

  return Response.json({ ok: true, scheduled_at: slot })
}
