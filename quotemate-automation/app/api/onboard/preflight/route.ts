// /api/onboard/preflight — diagnostic endpoint.
//
// Hit this from the production deploy to confirm every env var the
// activation flow needs is actually set. Never returns secrets — only
// presence + length so you can tell whether Vercel has the key without
// leaking it.
//
// Public on purpose: the response is presence-only, useful for
// "why didn't my Twilio number provision" debugging without an auth round
// trip. If you'd rather hide it, gate behind the X-Preflight-Token header
// (set PREFLIGHT_TOKEN env var).

import { computePreflight } from '@/lib/onboard/preflight-logic'

export const dynamic = 'force-dynamic'

type CheckResult = {
  key: string
  present: boolean
  hint?: string
}

function check(key: string, hint?: string): CheckResult {
  const v = process.env[key]
  return {
    key,
    present: typeof v === 'string' && v.length > 0,
    ...(hint ? { hint } : {}),
  }
}

export async function GET(req: Request) {
  // Optional auth: if PREFLIGHT_TOKEN is set, require it in the header.
  const token = process.env.PREFLIGHT_TOKEN
  if (token) {
    const sent = req.headers.get('x-preflight-token')
    if (sent !== token) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  const checks: CheckResult[] = [
    check('NEXT_PUBLIC_SUPABASE_URL', 'Required for any DB write'),
    check('SUPABASE_SERVICE_ROLE_KEY', 'Required — service role for tenant inserts/updates'),
    check('TWILIO_PROVISIONING_ENABLED', 'Set to "true" for real Twilio purchase'),
    check('VAPI_PROVISIONING_ENABLED', 'Set to "true" for real Vapi assistant creation'),
    check('TWILIO_ACCOUNT_SID', 'Required when TWILIO_PROVISIONING_ENABLED=true'),
    check('TWILIO_AUTH_TOKEN', 'Required when TWILIO_PROVISIONING_ENABLED=true'),
    check('VAPI_API_KEY', 'Required when VAPI_PROVISIONING_ENABLED=true'),
    check('APP_URL', 'Required so SMS webhook resolves to your deploy'),
    check('NEXT_PUBLIC_APP_URL', 'Alternate to APP_URL — at least one must be set'),
  ]

  const { ok, summary } = computePreflight(process.env)
  const willStub = summary.twilio_mode === 'stub' || summary.vapi_mode === 'stub'

  return Response.json({
    ok,
    summary,
    checks,
    note: ok
      ? willStub
        ? 'Activation will succeed but at least one resource is stubbed. Flip the *_PROVISIONING_ENABLED flag to provision real.'
        : 'All required env vars present. Activation should provision real Twilio + Vapi.'
      : `Missing: ${summary.missing_for_activation.join(', ')}. Set these in Vercel → Project → Environment Variables, then redeploy.`,
  })
}
