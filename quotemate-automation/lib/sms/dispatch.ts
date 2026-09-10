// Unified message dispatcher with SMS-first, WhatsApp-fallback strategy.
// Per-call: try SMS via Twilio (with retries on transient errors). If
// carrier permanently rejects (21612 PH long-code block, 21408 geo-
// permission, etc.), fall back to WhatsApp on the same number — UNLESS
// this is a customer-facing send from a tenant's own number (US-008 +
// review follow-up 2026-07-23): the WA sender is always the global
// platform number, a stranger's number to a customer, so the fallback is
// scoped by `audience` (customer sends: platform-number flows only;
// tradie notifies: always).
// WhatsApp delivery requires the recipient to have opted in to the
// Twilio sandbox or to a registered WABA template — production v1 (AU)
// will normally succeed on SMS alone and never trigger the fallback.
//
// CONCURRENCY NOTE — at moderate load (e.g. two customers texting at the
// same instant), AU long codes throttle outbound at ~1 SMS/sec. Without
// retries, the second send returns 429 / carrier-rate-limit, dispatch
// falls back to WhatsApp, WhatsApp fails (recipient hasn't opted in),
// and the customer gets silence. With per-customer retries below, the
// throttled send waits a beat and goes through cleanly.

import { sendSms, sendWhatsApp, type TwilioSendResult } from './twilio'
import { dispatchDurably, recoverOutbound, type OutboundOptions } from './durable-outbox'

export type DispatchOk = {
  outboxId?: string
  ok: true
  channel: 'sms' | 'whatsapp'
  sid: string
  status: string
  /** any prior attempt that failed before the eventual success */
  smsAttempt?: { code: string; reason: string }
  /** number of SMS attempts made (1 = first try succeeded, >1 = retried) */
  smsAttempts?: number
  /** true when media was attached and delivered (MMS). */
  mms?: boolean
  /** true when an MMS attempt failed and we fell back to a plain SMS
   *  (the body still carries the quote-page link). */
  mediaDropped?: boolean
}

export type DispatchFail = {
  outboxId?: string
  ok: false
  /** SMS attempt result (last attempt's code/reason) */
  smsAttempt: { code: string; reason: string }
  /** total SMS attempts before giving up */
  smsAttempts: number
  /** WhatsApp attempt result if we tried. Absent when the fallback was
   *  deliberately skipped: customer-facing send from a tenant number
   *  (see `audience` on dispatchQuoteMessage). */
  waAttempt?: { code: string; reason: string }
}

export type DispatchResult = DispatchOk | DispatchFail

// Retry only explicit provider rejections. A timeout or 5xx cannot prove non-acceptance.
function isRetryable(result: Extract<TwilioSendResult, { ok: false }>): boolean {
  return ['429', '14107', '14101'].includes(result.code)
}

const RETRY_DELAYS_MS = [500, 1500, 3500] // total max ~5.5s before falling back

/** PURE-ish (reads env) — may a failed SMS fall back to WhatsApp?
 *  Only when the reply wasn't meant to come from a tenant's own number:
 *  no custom `from`, or `from` IS the platform's shared number. The WA
 *  sender is always the global TWILIO_WHATSAPP_FROM, which on a
 *  tenant-number thread is a stranger's number to the customer. */
export function whatsappFallbackAllowed(from: string | undefined): boolean {
  if (!from) return true
  return from === process.env.TWILIO_SMS_NUMBER || from === process.env.TWILIO_PHONE_NUMBER
}

// A thrown transport failure may happen after acceptance. Stop automatic resend.
function thrownToResult(e: unknown): Extract<TwilioSendResult, { ok: false }> {
  const reason = e instanceof Error ? e.message : String(e)
  // Preserve the thrown error's name as the `code` so isRetryableSendError
  // classifies AbortError/TimeoutError as retryable; otherwise tag NETWORK.
  return { ok: false, code: 'AMBIGUOUS', reason, raw: null }
}

async function sendSmsWithRetry(opts: {
  to: string
  text: string
  from?: string
  mediaUrl?: string | string[]
  statusCallback?: string
}): Promise<{ result: TwilioSendResult; attempts: number }> {
  let attempts = 0
  let last: TwilioSendResult | null = null
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    attempts++
    let result: TwilioSendResult
    try {
      result = await sendSms(opts)
    } catch (e) {
      // sendSms normally returns a failed result rather than throwing, but a
      // Vercel function teardown / undici headers-timeout can surface as a
      // thrown AbortError/TimeoutError. Treat it as a (retryable) transient.
      result = thrownToResult(e)
    }
    if (result.ok) {
      if (attempts > 1) {
        console.log(`[dispatch] sendSms succeeded on attempt ${attempts} to ${opts.to}`)
      }
      return { result, attempts }
    }
    last = result
    if (!isRetryable(result)) {
      console.warn(`[dispatch] sendSms failed permanently (code=${result.code}) to ${opts.to} — falling back`)
      break
    }
    if (i === RETRY_DELAYS_MS.length) {
      console.error(`[dispatch] sendSms exhausted ${attempts} retries (last code=${result.code}) to ${opts.to} — falling back`)
      break
    }
    console.warn(`[dispatch] sendSms transient failure (code=${result.code}) to ${opts.to} — retry ${attempts + 1} in ${RETRY_DELAYS_MS[i]}ms`)
    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[i]))
  }
  return { result: last!, attempts }
}

/**
 * Send, then record it when the recipient is the tradie.
 *
 * A thin wrapper rather than a line at each of the four return points inside:
 * one place means no send path can be added later that quietly skips the
 * audit. Recording is best-effort and never changes the result — see
 * lib/sms/tradie-log.ts.
 */
export async function dispatchQuoteMessage(
  opts: OutboundOptions,
): Promise<DispatchResult> {
  return dispatchDurably(opts, sendQuoteMessage)
}

/** Called by website cron and exported service workers; safe under overlapping workers. */
export async function recoverSmsOutbox(limit = 10) {
  return recoverOutbound(sendQuoteMessage, limit)
}

async function sendQuoteMessage(opts: {
  to: string
  text: string
  /** Optional SMS sender override. Defaults to TWILIO_PHONE_NUMBER (voice
   *  agent's number). The SMS-channel inbound route passes TWILIO_SMS_NUMBER
   *  here so customer-facing SMS replies originate from the same number the
   *  customer texted. WhatsApp always uses TWILIO_WHATSAPP_FROM regardless. */
  from?: string
  /** Optional media URL(s) to attach as an MMS (e.g. the satellite roof
   *  image). If the MMS send fails, we automatically retry as a plain SMS
   *  — the body still carries the quote-page link — before WhatsApp. */
  mediaUrl?: string | string[]
  /** Who receives this message. Decides the WhatsApp-fallback rule
   *  (review follow-up 2026-07-23): 'customer' (default) suppresses the
   *  fallback on tenant-number sends — the WA sender is the global
   *  platform number, a stranger's number to a customer. 'tradie' keeps
   *  it — the recipient is the tenant OWNER being notified of a lead, and
   *  losing that notification to an SMS reject is the exact failure
   *  b4ccea5f added the fallback to prevent. */
  audience?: 'customer' | 'tradie'
  /** Stamped on the audit row for an audience:'tradie' send, so alerts can be
   *  read back per tenant. Optional — the row is still written without it. */
  tenantId?: string | null
  statusCallback?: string
}): Promise<DispatchResult> {
  let mediaDropped = false
  let attempt = await sendSmsWithRetry({
    to: opts.to,
    text: opts.text,
    from: opts.from,
    mediaUrl: opts.mediaUrl,
    statusCallback: opts.statusCallback,
  })

  if (!attempt.result.ok && ['AMBIGUOUS','21610'].includes(attempt.result.code)) {
    return { ok: false, smsAttempt: { code: attempt.result.code, reason: attempt.result.reason }, smsAttempts: attempt.attempts }
  }

  // MMS attempt failed — fall back to a plain SMS (the link is in the body)
  // before resorting to WhatsApp.
  if (!attempt.result.ok && opts.mediaUrl) {
    console.warn(`[dispatch] MMS send failed (code=${attempt.result.code}) to ${opts.to} — retrying as plain SMS`)
    mediaDropped = true
    attempt = await sendSmsWithRetry({ to: opts.to, text: opts.text, from: opts.from, statusCallback: opts.statusCallback })
  }

  const { result: smsResult, attempts: smsAttempts } = attempt

  if (smsResult.ok) {
    return {
      ok: true,
      channel: 'sms',
      sid: smsResult.sid,
      status: smsResult.status,
      smsAttempts,
      mms: !!opts.mediaUrl && !mediaDropped,
      mediaDropped,
    }
  }

  const smsAttempt = { code: smsResult.code, reason: smsResult.reason }
  if (['AMBIGUOUS','21610'].includes(smsResult.code)) return { ok: false, smsAttempt, smsAttempts }

  // US-008 (audit 2026-07-23): WhatsApp always sends from the global
  // TWILIO_WHATSAPP_FROM — a WA sender can't be a tenant long code. On a
  // tenant-number CUSTOMER thread that re-sent a failed SMS from a
  // STRANGER'S number, so the fallback is scoped to shared/platform-number
  // flows — unless the recipient is the tradie (see `audience` above).
  if (opts.audience !== 'tradie' && !whatsappFallbackAllowed(opts.from)) {
    return { ok: false, smsAttempt, smsAttempts }
  }

  // WhatsApp fallback. Same teardown guard as the SMS path: a thrown
  // AbortError/timeout here must NOT escape dispatchQuoteMessage (callers
  // — the route's after() block included — rely on it returning a
  // DispatchResult, never throwing), so degrade a throw to a failed result.
  let waResult: TwilioSendResult
  try {
    waResult = await sendWhatsApp({ to: opts.to, text: opts.text, statusCallback: opts.statusCallback })
  } catch (e) {
    waResult = thrownToResult(e)
  }
  if (waResult.ok) {
    return {
      ok: true,
      channel: 'whatsapp',
      sid: waResult.sid,
      status: waResult.status,
      smsAttempt,
      smsAttempts,
    }
  }

  return {
    ok: false,
    smsAttempt,
    smsAttempts,
    waAttempt: { code: waResult.code, reason: waResult.reason },
  }
}
