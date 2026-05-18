// Booking-confirmation SMS — customer + tradie.
//
// MOVED here from /api/q/[token]/book so it fires on the LAST step of
// the new funnel: the deposit payment (the Stripe webhook), not slot
// selection. A booking is only confirmed once it's paid, so that's when
// "you're locked in for <time>" should go out. Logic is otherwise
// identical to the pre-reorder book route (intake → caller/calls phone
// resolution, tenant-scoped from/to numbers).
//
// Defensive by contract: never throws. The booking + payment are already
// committed by the time this runs; a failed SMS must never undo them or
// break the webhook ack.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import {
  buildBookingConfirmationSms,
  buildTradieBookingNotification,
} from '@/lib/sms/templates'
import { pipelineLog } from '@/lib/log/pipeline'

export async function notifyBookingConfirmed(
  supabase: SupabaseClient,
  args: {
    quoteId: string
    intakeId: string | null
    tenantId: string | null
    shareToken: string
    slotIso: string
  },
): Promise<void> {
  const sms = pipelineLog('dispatch', args.quoteId)
  try {
    const appUrl = process.env.APP_URL ?? 'https://quote-mate-rho.vercel.app'

    // Resolve customer name + phone via intake → calls. caller.phone is
    // set on SMS-sourced quotes; calls.caller_number on voice-sourced.
    type IntakeRow = {
      call_id?: string | null
      job_type?: string | null
      caller?: { name?: string; phone?: string } | null
      scope?: { item_count?: number } | null
    }
    let intake: IntakeRow | null = null
    if (args.intakeId) {
      const { data } = await supabase
        .from('intakes')
        .select('id, call_id, job_type, caller, scope')
        .eq('id', args.intakeId)
        .maybeSingle()
      // supabase-js types a non-literal select row as `never`; go via
      // `unknown` to read our own columns (same pattern as lifecycle.ts).
      intake = (data as unknown as IntakeRow | null) ?? null
    }

    let callerNumber: string | null = intake?.caller?.phone ?? null
    if (!callerNumber && intake?.call_id) {
      const { data: callRow } = await supabase
        .from('calls')
        .select('caller_number')
        .eq('id', intake.call_id)
        .maybeSingle()
      callerNumber = (callRow?.caller_number as string | null) ?? null
    }

    // v6 multi-tenant: send FROM the tenant's provisioned number so the
    // confirmation lands in the same thread as the quote; notify the
    // tradie's own mobile. Env fallbacks for legacy pre-v6 quotes.
    let tenantSmsNumber: string | null = null
    let tenantOwnerMobile: string | null = null
    let tenantOwnerFirstName: string | null = null
    if (args.tenantId) {
      const { data: tenantRow } = await supabase
        .from('tenants')
        .select('twilio_sms_number, owner_mobile, owner_first_name')
        .eq('id', args.tenantId)
        .maybeSingle()
      tenantSmsNumber = (tenantRow?.twilio_sms_number as string | null) ?? null
      tenantOwnerMobile = (tenantRow?.owner_mobile as string | null) ?? null
      tenantOwnerFirstName =
        (tenantRow?.owner_first_name as string | null) ?? null
    }

    const firstName = intake?.caller?.name
    const bookingUrl = `${appUrl}/q/${args.shareToken}/book`
    const quoteUrl = `${appUrl}/q/${args.shareToken}`

    if (callerNumber) {
      const body = buildBookingConfirmationSms({
        firstName,
        scheduledAt: args.slotIso,
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
        sms.ok('customer booking confirmation sent', {
          channel: r.channel,
          sid: r.sid,
        })
      } else {
        sms.err('customer booking confirmation failed', null, {
          sms_code: r.smsAttempt.code,
          wa_code: r.waAttempt?.code,
        })
      }
    } else {
      sms.ok('customer SMS skipped — no callerNumber resolvable', {
        quote_id: args.quoteId,
      })
    }

    const notifyMobile = tenantOwnerMobile ?? process.env.TRADIE_NOTIFY_NUMBER
    if (notifyMobile) {
      const tradieBody = buildTradieBookingNotification({
        tradieFirstName: tenantOwnerFirstName,
        customerName: firstName,
        customerPhone: callerNumber ?? undefined,
        jobType: intake?.job_type ?? 'other',
        itemCount: intake?.scope?.item_count,
        scheduledAt: args.slotIso,
        quoteUrl,
        dashboardUrl: `${appUrl}/dashboard`,
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
        sms.ok('tradie booking notification sent', {
          channel: r.channel,
          sid: r.sid,
        })
      } else {
        sms.err('tradie booking notification failed', null, {
          sms_code: r.smsAttempt.code,
          wa_code: r.waAttempt?.code,
        })
      }
    } else {
      sms.ok('tradie notify skipped — no tenant.owner_mobile and no env fallback')
    }
  } catch (e) {
    sms.err(
      'booking confirmation SMS threw — booking + payment ARE committed, only SMS failed',
      e,
    )
  }
}
