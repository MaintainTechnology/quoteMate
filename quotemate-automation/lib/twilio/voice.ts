// Click-to-call bridge for the Follow-ups tab.
//
// Flow: VA taps CALL → we ask Twilio to ring the TRADIE's mobile first.
// When the tradie answers, Twilio fetches our public bridge TwiML, which
// dials the CUSTOMER with caller-ID set to the tradie's provisioned Twilio
// number — so the customer sees the business calling, never the VA's
// personal phone.
//
// SECURITY: the bridge TwiML endpoint is public (Twilio must reach it).
// Without a guard, anyone hitting it could make our Twilio account dial
// arbitrary numbers (toll-fraud + spam). Every bridge URL therefore
// carries an HMAC over (customer|callerId) signed with TWILIO_AUTH_TOKEN;
// the TwiML route refuses to dial unless the signature verifies.

import crypto from 'node:crypto'

const API_BASE = 'https://api.twilio.com/2010-04-01'

export type TwilioCallResult =
  | { ok: true; sid: string; status: string }
  | { ok: false; code: string; reason: string }

/** HMAC of the dial target + caller-ID, hex. Stable + URL-safe. */
export function signBridge(customerE164: string, callerIdE164: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${customerE164}|${callerIdE164}`)
    .digest('hex')
}

/** Constant-time verify. False on any shape mismatch (never throws). */
export function verifyBridge(
  customerE164: string,
  callerIdE164: string,
  sig: string | null | undefined,
  secret: string,
): boolean {
  if (!sig) return false
  const expected = signBridge(customerE164, callerIdE164, secret)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** TwiML returned to Twilio when the tradie's leg is answered.
 *  answerOnBridge keeps the tradie un-billed/ringing until the customer
 *  actually picks up; callerId makes the customer see the business number. */
export function buildBridgeTwiml(opts: {
  customerE164: string
  callerIdE164: string
}): string {
  // Minimal escaping — both values are validated E.164 (+61…) upstream,
  // so they contain no XML-special chars, but escape defensively anyway.
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    `<Dial callerId="${esc(opts.callerIdE164)}" answerOnBridge="true" timeLimit="3600">` +
    `<Number>${esc(opts.customerE164)}</Number>` +
    '</Dial>' +
    '</Response>'
  )
}

/** Place the first leg (ring the tradie). Mirrors lib/sms/twilio.ts's
 *  direct-fetch style so the serverless bundle stays lean. */
export async function placeBridgeCall(opts: {
  toTradieE164: string
  fromTenantNumberE164: string
  twimlUrl: string
}): Promise<TwilioCallResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    return { ok: false, code: 'NO_CREDS', reason: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set' }
  }

  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
  const body = new URLSearchParams()
  body.set('To', opts.toTradieE164)
  body.set('From', opts.fromTenantNumberE164)
  body.set('Url', opts.twimlUrl)
  // If the tradie doesn't answer, don't leave a ghost call up.
  body.set('Timeout', '25')

  let res: Response
  try {
    res = await fetch(`${API_BASE}/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (e: unknown) {
    return { ok: false, code: 'NETWORK', reason: e instanceof Error ? e.message : 'fetch failed' }
  }

  const text = await res.text()
  let parsed: { sid?: string; status?: string; code?: number; message?: string } | null = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }

  if (!res.ok || parsed?.code) {
    return {
      ok: false,
      code: String(parsed?.code ?? res.status),
      reason: parsed?.message ?? `HTTP ${res.status}`,
    }
  }
  return { ok: true, sid: parsed?.sid ?? '', status: parsed?.status ?? 'queued' }
}
