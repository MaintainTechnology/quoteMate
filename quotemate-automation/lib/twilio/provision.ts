// Twilio number provisioning for tradie onboarding.
//
// Country:  Australia ONLY (hard-coded `/AU/...` paths below).
// Capabilities required: Voice + SMS + MMS.
// Capabilities preferred (best-effort): Fax.
//
// Reality check on Fax + AU mobile: Twilio's AU Mobile inventory
// typically supports Voice + SMS + MMS but NOT Fax. Fax-capable AU
// numbers are usually Local or TollFree. So this helper:
//   1. First tries AU Mobile with Voice+SMS+MMS+Fax. Rare match but ideal.
//   2. Falls back to AU Local with Voice+SMS+MMS+Fax.
//   3. Falls back to AU Mobile with Voice+SMS+MMS (drops Fax).
//   4. Falls back to AU Local with Voice+SMS+MMS.
// The result includes the final capabilities so the caller knows whether
// Fax actually landed.
//
// Gated by env flag `TWILIO_PROVISIONING_ENABLED=true`. When disabled (the
// default — keeps the test phase free of Twilio charges), returns a
// deterministic stub number derived from the tenant UUID so retries
// don't collide and the UI still has something to show.

const API_BASE = 'https://api.twilio.com/2010-04-01'
const COUNTRY = 'AU' as const

// Vapi's hosted Twilio inbound-call endpoint. When a call lands on the
// purchased Twilio number, Twilio POSTs to this URL; Vapi then looks up
// which assistant to run by the destination number (mapping configured
// via lib/vapi/register-number.ts).
//
// Constant rather than env var because this is Vapi's public endpoint
// and never changes per-deployment.
const VAPI_INBOUND_VOICE_URL = 'https://api.vapi.ai/twilio/inbound_call'

export type NumberCapabilities = {
  voice: boolean
  sms: boolean
  mms: boolean
  fax: boolean
}

export type ProvisionResult =
  | {
      ok: true
      stubbed: false
      phoneNumber: string
      twilioSid: string
      numberType: 'Mobile' | 'Local'
      capabilities: NumberCapabilities
      faxAvailable: boolean
    }
  | { ok: true; stubbed: true; phoneNumber: string }
  | { ok: false; reason: string; code?: string }

type SearchAttempt = {
  numberType: 'Mobile' | 'Local'
  requireFax: boolean
}

// Order matters — earliest match wins. Mobile is preferred because
// tradies' customers expect to text/MMS a mobile, not a landline.
const SEARCH_ORDER: SearchAttempt[] = [
  { numberType: 'Mobile', requireFax: true },   // ideal: all 4 caps on a mobile
  { numberType: 'Local',  requireFax: true },   // ideal-ish: all 4 caps on a landline
  { numberType: 'Mobile', requireFax: false },  // fallback: 3 caps on a mobile
  { numberType: 'Local',  requireFax: false },  // fallback: 3 caps on a landline
]

export async function provisionTwilioNumber(opts: {
  tenantId: string
  /** Customer-facing label for the number — shows in Twilio console */
  friendlyName: string
  /** AU area code preference (e.g. '02' Sydney, '07' Brisbane). Mobile defaults to '04'. */
  areaCode?: string
}): Promise<ProvisionResult> {
  // Gate the live API call. When unset or "false", return a stub so the
  // rest of the activate flow can run end-to-end without burning Twilio money.
  if (process.env.TWILIO_PROVISIONING_ENABLED !== 'true') {
    return {
      ok: true,
      stubbed: true,
      phoneNumber: stubNumberFor(opts.tenantId),
    }
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  // AU numbers require an AddressSid at purchase time (Twilio regulatory
  // bundle). We attach the single platform-level address registered on
  // QuoteMate's Twilio account to every tradie's number. The tradie's own
  // address isn't required here — Twilio only needs a verifiable address
  // for the account doing the purchase, which is us. Set this in Vercel
  // to the SID shown under Twilio Console → Phone Numbers → Regulatory
  // Compliance → Addresses (starts with AD…).
  const addressSid = process.env.TWILIO_ADDRESS_SID
  // AU MOBILE numbers (the 04xx kind) additionally require a Regulatory
  // Compliance Bundle (a BU… SID) that proves the buying entity's
  // identity. AU LOCAL numbers (landline-style 02/03/07/08) only need an
  // Address. Setting TWILIO_BUNDLE_SID unlocks Mobile inventory; leaving
  // it unset means we fall back to Local automatically when Twilio
  // rejects the Mobile purchase for missing regulatory metadata.
  const bundleSid = process.env.TWILIO_BUNDLE_SID
  if (!sid || !token) {
    return { ok: false, reason: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set' }
  }
  if (!appUrl) {
    return { ok: false, reason: 'APP_URL or NEXT_PUBLIC_APP_URL must be set so webhooks resolve' }
  }
  if (!addressSid) {
    return {
      ok: false,
      reason:
        'TWILIO_ADDRESS_SID not set. AU numbers require an address on the purchase. ' +
        'Grab the SID from Twilio Console → Phone Numbers → Regulatory Compliance → ' +
        'Addresses (starts with AD…) and add it to Vercel env vars.',
    }
  }

  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64')

  // Walk SEARCH_ORDER; for each attempt: search for an available number,
  // then immediately try to buy it. On a regulatory-rejection (bundle
  // missing) we fall through to the next attempt rather than aborting —
  // this lets us auto-degrade from Mobile to Local when the deployment
  // doesn't have a regulatory bundle configured.
  const attempts: string[] = []

  for (const attempt of SEARCH_ORDER) {
    // ── 1. Search for an available number matching this attempt ───
    const sp = new URLSearchParams({
      VoiceEnabled: 'true',
      SmsEnabled: 'true',
      MmsEnabled: 'true',
      Limit: '5',
    })
    if (attempt.requireFax) sp.set('FaxEnabled', 'true')
    if (opts.areaCode) sp.set('AreaCode', opts.areaCode)

    const path = `/AU/${attempt.numberType}.json`
    const label = `${attempt.numberType}${attempt.requireFax ? '+fax' : ''}`
    let candidate: string | null = null
    try {
      const res = await fetch(
        `${API_BASE}/Accounts/${sid}/AvailablePhoneNumbers${path}?${sp.toString()}`,
        { headers: { Authorization: auth, Accept: 'application/json' } },
      )
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 200)
        attempts.push(`${label}: search HTTP ${res.status} — ${errText}`)
        continue
      }
      const json = (await res.json()) as {
        available_phone_numbers?: Array<{ phone_number: string }>
      }
      candidate = json.available_phone_numbers?.[0]?.phone_number ?? null
      if (!candidate) {
        attempts.push(`${label}: 0 results`)
        continue
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      attempts.push(`${label}: search threw — ${msg}`)
      continue
    }

    // ── 2. Attempt to purchase the candidate ───────────────────────
    //
    //   SmsUrl   → our /api/sms/inbound (Twilio posts inbound SMS here;
    //              handled in-process by the tenant lookup pipeline)
    //   VoiceUrl → Vapi's hosted Twilio inbound endpoint; Vapi looks up
    //              the assistant by destination number after we register
    //              the number with Vapi (lib/vapi/register-number.ts).
    //
    // Bundle attachment: only Mobile needs it, and only when configured.
    // Leaving it off for Local saves an unused field on every purchase.
    const purchaseBody = new URLSearchParams()
    purchaseBody.set('PhoneNumber', candidate)
    purchaseBody.set('FriendlyName', opts.friendlyName)
    purchaseBody.set('AddressSid', addressSid)
    if (attempt.numberType === 'Mobile' && bundleSid) {
      purchaseBody.set('BundleSid', bundleSid)
    }
    purchaseBody.set('SmsUrl', `${appUrl}/api/sms/inbound`)
    purchaseBody.set('SmsMethod', 'POST')
    purchaseBody.set('VoiceUrl', VAPI_INBOUND_VOICE_URL)
    purchaseBody.set('VoiceMethod', 'POST')

    let purchaseResp: Response
    try {
      purchaseResp = await fetch(
        `${API_BASE}/Accounts/${sid}/IncomingPhoneNumbers.json`,
        {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: purchaseBody.toString(),
        },
      )
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      attempts.push(`${label}: purchase threw — ${msg}`)
      continue
    }

    const text = await purchaseResp.text()
    const parsed = (() => { try { return JSON.parse(text) } catch { return null } })()

    if (!purchaseResp.ok) {
      const reason = parsed?.message ?? `HTTP ${purchaseResp.status}`
      const lowered = String(reason).toLowerCase()
      // Regulatory rejection — keep walking SEARCH_ORDER. The Mobile→Local
      // fallback is the explicit reason this loop exists.
      const isRegulatoryMiss =
        lowered.includes('bundle required') ||
        lowered.includes('regulatory') ||
        lowered.includes('compliance')
      if (isRegulatoryMiss) {
        attempts.push(`${label}: ${reason} (falling back)`)
        continue
      }
      // Non-regulatory purchase failure — surface immediately so the
      // tradie sees a real error rather than a "no inventory" mask.
      return {
        ok: false,
        reason,
        code: parsed?.code != null ? String(parsed.code) : undefined,
      }
    }

    // ── 3. Purchase succeeded — return the result ──────────────────
    const caps = parsed.capabilities ?? {}
    const capabilities: NumberCapabilities = {
      voice: !!(caps.voice ?? caps.VOICE),
      sms:   !!(caps.sms   ?? caps.SMS),
      mms:   !!(caps.mms   ?? caps.MMS),
      fax:   !!(caps.fax   ?? caps.FAX),
    }
    return {
      ok: true,
      stubbed: false,
      phoneNumber: parsed.phone_number,
      twilioSid: parsed.sid,
      numberType: attempt.numberType,
      capabilities,
      faxAvailable: capabilities.fax,
    }
  }

  // Every attempt fell through. Most common cause: AU Mobile inventory
  // needs a Bundle that isn't configured AND AU Local inventory was empty.
  return {
    ok: false,
    reason:
      `Could not provision an AU number. Attempts: ${attempts.join(' | ')}. ` +
      (bundleSid
        ? 'Bundle is configured — check Twilio inventory or contact support.'
        : 'Tip: AU Mobile needs a Regulatory Compliance Bundle. Set TWILIO_BUNDLE_SID, or rely on Local fallback (which means AU Local must have available inventory).'),
  }
}

/**
 * Deterministic placeholder number derived from the tenant UUID.
 * Format: +61 482 0XX XXX — within the AU mobile band, recognisable as
 * a placeholder once you've seen one, and stable across retries.
 */
function stubNumberFor(tenantId: string): string {
  const hex = tenantId.replace(/-/g, '').slice(0, 5)
  const num = (parseInt(hex, 16) % 100000).toString().padStart(5, '0')
  return `+614820${num.slice(0, 2)}${num.slice(2)}`
}
