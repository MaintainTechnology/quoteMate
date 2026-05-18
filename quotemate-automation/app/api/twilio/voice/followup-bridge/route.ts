// Public TwiML endpoint Twilio fetches when the tradie's leg is answered
// (see /api/tenant/followups/call). It returns the <Dial> that connects
// the tradie to the customer with the tenant's number as caller-ID.
//
// PUBLIC + UNAUTHENTICATED (Twilio has no bearer token). The guard is the
// HMAC signature: the call endpoint signs (customer|callerId) with
// TWILIO_AUTH_TOKEN; we refuse to dial unless it verifies. A bad/forged
// hit gets a polite hangup, never a dial — so this can't be used to make
// our Twilio account call arbitrary numbers.

import { buildBridgeTwiml, verifyBridge } from '@/lib/twilio/voice'

export const dynamic = 'force-dynamic'

const E164 = /^\+\d{8,15}$/

const HANGUP_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Response><Say>Sorry, this call could not be connected.</Say><Hangup/></Response>'

function xml(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

function handle(req: Request): Response {
  const url = new URL(req.url)
  const to = url.searchParams.get('to') ?? ''
  const cid = url.searchParams.get('cid') ?? ''
  const sig = url.searchParams.get('sig')
  const secret = process.env.TWILIO_AUTH_TOKEN

  // Defence in depth: shape-check before trusting the signature, and
  // never dial if the secret is missing.
  if (!secret || !E164.test(to) || !E164.test(cid) || !verifyBridge(to, cid, sig, secret)) {
    console.error('[voice/followup-bridge] rejected — bad signature or params', {
      hasSecret: !!secret,
      toOk: E164.test(to),
      cidOk: E164.test(cid),
      hasSig: !!sig,
    })
    return xml(HANGUP_TWIML, 200) // 200 + hangup: Twilio expects valid TwiML
  }

  return xml(buildBridgeTwiml({ customerE164: to, callerIdE164: cid }))
}

// Twilio POSTs by default; allow GET too for manual verification.
export async function POST(req: Request) {
  return handle(req)
}
export async function GET(req: Request) {
  return handle(req)
}
