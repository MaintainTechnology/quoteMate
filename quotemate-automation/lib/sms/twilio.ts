// SMS via Twilio (https://www.twilio.com/docs/sms/api).
// Direct fetch against the REST API rather than the `twilio` npm package —
// keeps the serverless bundle lean; we only need outbound Messages.create.

const API_BASE = 'https://api.twilio.com/2010-04-01'

export type TwilioSendResult =
  | { ok: true; sid: string; status: string; to: string; raw: TwilioMessageResponse }
  | { ok: false; code: string; reason: string; raw: TwilioMessageResponse | { error?: string } | null }

type TwilioMessageResponse = {
  sid: string
  status: string                    // queued | sending | sent | failed | delivered | undelivered
  to: string
  from: string
  body: string
  error_code: number | null
  error_message: string | null
  price: string | null
  price_unit: string | null
  num_segments: string
  date_created: string
}

async function postTwilioMessage(channel: 'sms' | 'whatsapp', opts: {
  to: string
  text: string
  from?: string
  statusCallback?: string
  /** One or more public media URLs to attach (turns the SMS into an MMS).
   *  Twilio fetches these server-side, so they must be publicly reachable. */
  mediaUrl?: string | string[]
}): Promise<TwilioSendResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = opts.from
    ?? (channel === 'whatsapp' ? process.env.TWILIO_WHATSAPP_FROM : process.env.TWILIO_PHONE_NUMBER)

  if (!sid || !token) {
    return { ok: false, code: 'NO_CREDS', reason: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set', raw: null }
  }
  if (!from) {
    return {
      ok: false,
      code: 'NO_FROM',
      reason: channel === 'whatsapp'
        ? 'No WhatsApp sender — set TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886) or pass `from`'
        : 'No sender — set TWILIO_PHONE_NUMBER or pass `from`',
      raw: null,
    }
  }

  // For WhatsApp, both From and To must be prefixed with `whatsapp:`. Accept callers passing
  // bare E.164 (`+61…`) or already-prefixed values for either; normalise here.
  const fromAddr = channel === 'whatsapp' && !from.startsWith('whatsapp:') ? `whatsapp:${from}` : from
  const toAddr = channel === 'whatsapp' && !opts.to.startsWith('whatsapp:') ? `whatsapp:${opts.to}` : opts.to

  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64')
  const body = new URLSearchParams()
  body.set('To', toAddr)
  body.set('From', fromAddr)
  body.set('Body', opts.text)
  if (opts.statusCallback) body.set('StatusCallback', opts.statusCallback)
  if (opts.mediaUrl) {
    const urls = Array.isArray(opts.mediaUrl) ? opts.mediaUrl : [opts.mediaUrl]
    for (const u of urls) {
      if (typeof u === 'string' && u.trim()) body.append('MediaUrl', u)
    }
  }

  let res: Response
  try {
    res = await fetch(`${API_BASE}/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (e: any) {
    return { ok: false, code: 'NETWORK', reason: e?.message ?? 'fetch failed', raw: null }
  }

  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { parsed = { rawText: text } }

  if (!res.ok || parsed?.error_code) {
    return {
      ok: false,
      code: String(parsed?.code ?? parsed?.error_code ?? res.status),
      reason: parsed?.message ?? parsed?.error_message ?? `HTTP ${res.status}`,
      raw: parsed,
    }
  }

  const m = parsed as TwilioMessageResponse
  return { ok: true, sid: m.sid, status: m.status, to: m.to, raw: m }
}

export function sendSms(opts: {
  to: string
  text: string
  from?: string
  statusCallback?: string
  mediaUrl?: string | string[]
}): Promise<TwilioSendResult> {
  return postTwilioMessage('sms', opts)
}

export function sendWhatsApp(opts: {
  to: string
  text: string
  from?: string
  statusCallback?: string
  mediaUrl?: string | string[]
}): Promise<TwilioSendResult> {
  return postTwilioMessage('whatsapp', opts)
}
