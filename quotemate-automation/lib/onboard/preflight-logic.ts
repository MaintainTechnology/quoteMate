// Pure logic for the /api/onboard/preflight diagnostic — extracted so we
// can unit-test the missing-vars math without spinning up Next's request
// machinery.

export type PreflightResult = {
  ok: boolean
  summary: {
    twilio_mode: 'stub' | 'real'
    vapi_mode: 'stub' | 'real'
    missing_for_activation: string[]
  }
}

export function computePreflight(env: NodeJS.ProcessEnv | Record<string, string | undefined>): PreflightResult {
  const twilioEnabled = env.TWILIO_PROVISIONING_ENABLED === 'true'
  const vapiEnabled = env.VAPI_PROVISIONING_ENABLED === 'true'

  const missing: string[] = []
  if (!env.NEXT_PUBLIC_SUPABASE_URL) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (twilioEnabled) {
    if (!env.TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID')
    if (!env.TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN')
    if (!env.APP_URL && !env.NEXT_PUBLIC_APP_URL) {
      missing.push('APP_URL (or NEXT_PUBLIC_APP_URL)')
    }
  }
  if (vapiEnabled && !env.VAPI_API_KEY) missing.push('VAPI_API_KEY')

  return {
    ok: missing.length === 0,
    summary: {
      twilio_mode: twilioEnabled ? 'real' : 'stub',
      vapi_mode: vapiEnabled ? 'real' : 'stub',
      missing_for_activation: missing,
    },
  }
}
