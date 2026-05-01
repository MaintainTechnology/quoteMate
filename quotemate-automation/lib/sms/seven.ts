// SMS via seven.io (https://docs.seven.io/en).
// Replaces Twilio for outbound SMS. POSTs form-urlencoded to /api/sms with
// Accept: application/json and X-Api-Key auth.
//
// Note: seven.io has no dry-run / sandbox mode — every successful call sends
// a real SMS and is billed. Guard test paths accordingly.

const ENDPOINT = 'https://gateway.seven.io/api/sms'

export type SevenSendResult =
  | { ok: true; messageId: string; price: number; balance: number; raw: SevenResponse }
  | { ok: false; code: string; reason: string; raw: SevenResponse | null }

type SevenResponse = {
  success: string                 // "100" on accepted; other codes on rejection
  total_price?: number
  balance?: number
  debug?: string
  sms_type?: string
  messages?: Array<{
    id: string
    sender: string
    recipient: string
    text: string
    encoding: string
    parts: number
    price: number
    success: boolean
    error: string | null
  }>
}

const REASON_BY_CODE: Record<string, string> = {
  '100': 'accepted',
  '101': 'partially sent — at least one recipient failed',
  '201': 'invalid sender ID (must be ≤11 alphanumeric or ≤16 numeric)',
  '202': 'invalid recipient number',
  '301': 'invalid sender number',
  '305': 'invalid text',
  '401': 'invalid text encoding',
  '402': 'duplicate sent within 180s',
  '500': 'insufficient account credit',
  '600': 'carrier delivery failed',
  '700': 'unknown error',
  '900': 'authentication failed (check SEVEN_API_KEY)',
  '901': 'sender ID not validated for this account',
  '902': 'API key permissions insufficient',
}

export async function sendSms(opts: {
  to: string                 // E.164, e.g. "+61412345678"
  text: string
  from?: string              // sender ID; defaults to env SEVEN_FROM or "QuoteMate"
  foreignId?: string         // your tracking id; ≤64 chars [a-zA-Z0-9.\-_@]
  label?: string             // bucket for stats; ≤100 chars [a-zA-Z0-9.\-_@]
}): Promise<SevenSendResult> {
  const apiKey = process.env.SEVEN_API_KEY
  if (!apiKey) {
    return { ok: false, code: 'NO_KEY', reason: 'SEVEN_API_KEY not set', raw: null }
  }

  const body = new URLSearchParams()
  body.set('to', opts.to)
  body.set('text', opts.text)
  body.set('from', opts.from ?? process.env.SEVEN_FROM ?? 'QuoteMate')
  if (opts.foreignId) body.set('foreign_id', opts.foreignId)
  if (opts.label) body.set('label', opts.label)

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
  } catch (e: any) {
    return { ok: false, code: 'NETWORK', reason: e?.message ?? 'fetch failed', raw: null }
  }

  // seven.io can return text/plain on auth failure even with Accept: application/json
  const text = await res.text()
  let parsed: SevenResponse = { success: String(res.status) }
  if (text) {
    try {
      parsed = JSON.parse(text) as SevenResponse
    } catch {
      // legacy plain-text response (just the status code, e.g. "100")
      parsed = { success: text.trim() }
    }
  }

  const code = parsed.success
  if (code !== '100' || parsed.messages?.[0]?.success === false) {
    return {
      ok: false,
      code,
      reason: parsed.messages?.[0]?.error ?? REASON_BY_CODE[code] ?? `unexpected status ${code}`,
      raw: parsed,
    }
  }

  const m = parsed.messages?.[0]
  return {
    ok: true,
    messageId: m?.id ?? '',
    price: parsed.total_price ?? 0,
    balance: parsed.balance ?? 0,
    raw: parsed,
  }
}
