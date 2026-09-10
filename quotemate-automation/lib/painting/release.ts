// ════════════════════════════════════════════════════════════════════
// Painting — tradie notification + customer quote send.
//
// A saved draft requires explicit tradie approval before customer release.
// released_at authorises public prices; quote_sent_at records provider
// acceptance, and the durable outbox separately tracks carrier delivery.
// A failed send must preserve that approval and remain available for recovery.
//
// Mirrors lib/solar/notify.ts + lib/solar/release.ts: defensive (never
// throws), and the tradie SMS send is injectable so the routing is unit-
// testable without Twilio.
// ════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildPaintingTradieNotification } from '@/lib/sms/painting-compose'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { deliveryStatus } from '@/lib/sms/durable-outbox'
import { publicWebOrigin } from '@/lib/sms/public-origin'
import { composePaintingQuoteDelivery, type PaintingQuoteDispatch } from './quote-dispatch'
import type { PaintingEstimate } from './types'

type DispatchResultLike = { ok: boolean }
type DispatchFn = (opts: { to: string; text: string; from?: string }) => Promise<DispatchResultLike>

/**
 * Text the tradie that a customer requested a painting quote, with the review
 * link. Never throws — a missing notify number just means no notification.
 * `dispatch` is injected (the route passes a dispatchQuoteMessage wrapper) so
 * the routing/message is unit-testable without Twilio.
 *
 * `customerTexted: false` switches the copy to the auto-send FAILURE alert
 * (spec painting-auto-send R3): the tradie is told in plain words that the
 * customer has NOT received anything and must be sent manually. Never swallow
 * a failed send — with the review gate retired this alert is the only witness.
 */
export async function notifyPaintingTradie(args: {
  tenant: {
    owner_mobile: string | null
    owner_first_name: string | null
    twilio_sms_number: string | null
  }
  customerName?: string | null
  address: string
  betterIncGst?: number | null
  estimateToken: string
  appUrl: string
  dispatch: DispatchFn
  /** Did the customer actually get the quote? Defaults to true. */
  customerTexted?: boolean
}): Promise<{ notified: boolean }> {
  try {
    const notifyMobile = args.tenant.owner_mobile ?? process.env.TRADIE_NOTIFY_NUMBER ?? null
    if (!notifyMobile) return { notified: false }
    const reviewUrl = `${args.appUrl}/p/${args.estimateToken}`
    const text = buildPaintingTradieNotification({
      tradieFirstName: args.tenant.owner_first_name,
      customerName: args.customerName,
      address: args.address,
      betterIncGst: args.betterIncGst,
      reviewUrl,
      customerTexted: args.customerTexted !== false,
    })
    const r = await args.dispatch({
      to: notifyMobile,
      text,
      from: args.tenant.twilio_sms_number ?? undefined,
    })
    return { notified: r.ok }
  } catch {
    return { notified: false }
  }
}

/**
 * Record that a carrier ACCEPTED the customer's quote message (migration 189).
 * quote_sent_at is the evidence /p keys "Sent to customer" off — released_at
 * only ever meant "prices may show", and a dashboard save stamps that without
 * texting anyone. Written only after a real acceptance; never optimistically.
 * Never throws, and reports whether the write actually landed.
 */
export async function markPaintingQuoteSent(
  supabase: SupabaseClient,
  publicToken: string,
): Promise<{ marked: boolean }> {
  try {
    const { error } = await supabase
      .from('painting_measurements')
      .update({ quote_sent_at: new Date().toISOString() })
      .eq('public_token', publicToken)
    if (error) {
      // Not fatal — the customer HAS the quote. /p will just offer a resend.
      console.error('[painting/release] could not stamp quote_sent_at', error.message)
      return { marked: false }
    }
    return { marked: true }
  } catch (e) {
    console.error(
      '[painting/release] could not stamp quote_sent_at',
      e instanceof Error ? e.message : e,
    )
    return { marked: false }
  }
}

/**
 * Undo an optimistic release whose customer send did NOT go out (spec
 * painting-auto-send R3). released_at is stamped before the send because the
 * quote page and the $99 mint gate on it — so a failed send has to roll the
 * stamp back, or the customer-facing gate stays open for a quote nobody
 * received. Back at released_at = null the row is held again: prices withheld,
 * and /p offers "Send to customer" so the tradie can retry.
 *
 * supabase-js RESOLVES { data, error } on a PostgREST/DB failure — it does not
 * throw — so the error field is what has to be checked; a bare `await` here
 * would swallow a failed rollback exactly like the bare `await sendSms` that
 * started all this. Callers MUST honour `reverted: false` and not report the
 * row as held.
 */
export async function revertPaintingRelease(
  supabase: SupabaseClient,
  publicToken: string,
): Promise<{ reverted: boolean }> {
  try {
    const { error } = await supabase
      .from('painting_measurements')
      .update({ released_at: null })
      .eq('public_token', publicToken)
    if (error) {
      console.error(
        '[painting/release] could not revert released_at after a failed send',
        error.message,
      )
      return { reverted: false }
    }
    return { reverted: true }
  } catch (e) {
    console.error(
      '[painting/release] could not revert released_at after a failed send',
      e instanceof Error ? e.message : e,
    )
    return { reverted: false }
  }
}

/**
 * Legacy compatibility sender: only an already approved quote may be sent.
 * Acceptance stamps quote_sent_at. Failure cannot revoke the tradie's approval
 * or make a previously released link unavailable.
 */
export async function autoSendPaintingQuote(args: {
  supabase: SupabaseClient
  disp: Extract<PaintingQuoteDispatch, { ok: true }>
  address: string
  appUrl: string
  tenantId: string | null
  firstName?: string | null
  /** Deliver one SMS/MMS. True ONLY when the carrier accepted it. */
  send: (text: string, mmsUrl?: string) => Promise<boolean>
}): Promise<{ sent: boolean }> {
  // Compatibility adapter for old form callers. Draft creation cannot release
  // a customer quote; only the authenticated release endpoint stamps this.
  const { data: approved, error: approvalError } = await args.supabase.from('painting_measurements')
    .select('released_at').eq('public_token', args.disp.token).eq('tenant_id', args.tenantId).maybeSingle()
  if (approvalError || !approved?.released_at) return { sent: false }
  let sent = false
  try {
    const { text, mmsUrl } = await composePaintingQuoteDelivery({
      supabase: args.supabase,
      disp: args.disp,
      address: args.address,
      appUrl: args.appUrl,
      tenantId: args.tenantId,
      firstName: args.firstName,
    })
    sent = (await args.send(text, mmsUrl)) === true
  } catch (e) {
    console.error(
      '[painting] auto-send compose/send failed',
      e instanceof Error ? e.message : e,
    )
  }

  if (sent) await markPaintingQuoteSent(args.supabase, args.disp.token)

  return { sent }
}

/**
 * Deliver the full painting quote to the customer — the ONE send used by the
 * release endpoint (first send, retry and resend). Reconstructs the dispatch
 * shape from the saved row and reuses composePaintingQuoteDelivery (G/B/B
 * prices + quote-page + PDF links + the ONE $99 site-visit pay link + MMS).
 * Never throws; `sent` is false — never silently true — when the row has no
 * customer_phone, no from-number, or Twilio rejects the message.
 */
export async function sendPaintingQuoteToCustomer(
  supabase: SupabaseClient,
  args: { estimateToken?: string; publicToken?: string; appUrl: string; tenantId?: string; deliveryKey?: string; requestId?: string },
): Promise<{ sent: boolean; outboxId?: string; status?: string }> {
  try {
    const tokenCol = args.estimateToken ? 'estimate_token' : 'public_token'
    const tokenVal = args.estimateToken ?? args.publicToken
    if (!tokenVal) return { sent: false }

    const { data: row, error: rowError } = await supabase
      .from('painting_measurements')
      .select('public_token, estimate_token, estimate, customer_phone, tenant_id, routing, address, released_at')
      .eq(tokenCol, tokenVal)
      .maybeSingle()
    if (rowError || !row || !row.customer_phone || !row.estimate || !row.released_at) return { sent: false }

    const tenantId = (row.tenant_id as string | null) ?? null
    if (!tenantId || (args.tenantId && args.tenantId !== tenantId)) return { sent: false }
    const { data: tenant, error: tenantError } = await supabase
        .from('tenants')
        .select('twilio_sms_number')
        .eq('id', tenantId)
        .maybeSingle()
    const fromNumber = (tenant?.twilio_sms_number as string | null) ?? null
    if (tenantError || !fromNumber || !/^\+[1-9]\d{7,14}$/.test(fromNumber)) return { sent: false }

    const disp = {
      ok: true as const,
      token: row.public_token as string,
      estimateToken: (row.estimate_token as string | null) ?? '',
      estimate: row.estimate as PaintingEstimate,
      inspection: (row.routing as string | null) === 'inspection_required',
    }
    const { text, mmsUrl } = await composePaintingQuoteDelivery({
      supabase,
      disp,
      address: (row.address as string | null) ?? 'your property',
      appUrl: publicWebOrigin(),
      tenantId,
    })
    // sendSms RESOLVES on a Twilio rejection ({ ok: false }) — it does not
    // throw. Returning `sent: true` off the bare await was the silent failure
    // this spec exists to close.
    const res = await dispatchQuoteMessage({ to: row.customer_phone as string, from: fromNumber, text,
      mediaUrl: mmsUrl, tenantId, audience: 'customer',
      deliveryKey: args.deliveryKey ?? `painting:${row.public_token}:${args.requestId ? `resend:${args.requestId}` : 'approved-send'}` })
    if (!res.ok) {
      console.error('[painting/release] Customer quote was not accepted', res.smsAttempt.code)
      return { sent: false, outboxId: res.outboxId,
        status: !res.outboxId ? 'not_queued'
          : ['OUTBOX_PENDING', 'OUTBOX_UNAVAILABLE'].includes(res.smsAttempt.code) ? 'recovery_pending' : deliveryStatus(res) }
    }
    // Accepted — record the evidence /p reads (migration 189). Best-effort:
    // the customer already has the quote, so a failed stamp must not turn a
    // real delivery into a reported failure.
    await markPaintingQuoteSent(supabase, row.public_token as string)
    return { sent: true, outboxId: res.outboxId, status: deliveryStatus(res) }
  } catch (e) {
    console.error('[painting/release] customer quote send failed (non-fatal)', e instanceof Error ? e.message : e)
    return { sent: false }
  }
}
