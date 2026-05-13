// Tests for the preflight env-readiness checker. Pure function, easy to
// table-drive — feeds different env shapes in and asserts what the
// activation flow would conclude.

import { describe, expect, it } from 'vitest'
import { computePreflight } from './preflight-logic'

describe('computePreflight — stub mode (no real provisioning)', () => {
  it('returns ok=true when only Supabase keys are set', () => {
    const r = computePreflight({
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'srv_key',
    })
    expect(r.ok).toBe(true)
    expect(r.summary.twilio_mode).toBe('stub')
    expect(r.summary.vapi_mode).toBe('stub')
    expect(r.summary.missing_for_activation).toEqual([])
  })

  it('returns ok=false if Supabase keys missing (stub mode still needs DB)', () => {
    const r = computePreflight({})
    expect(r.ok).toBe(false)
    expect(r.summary.missing_for_activation).toContain('NEXT_PUBLIC_SUPABASE_URL')
    expect(r.summary.missing_for_activation).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })
})

describe('computePreflight — Twilio real mode', () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    TWILIO_PROVISIONING_ENABLED: 'true',
  }

  it('flags missing Twilio creds', () => {
    const r = computePreflight(base)
    expect(r.ok).toBe(false)
    expect(r.summary.twilio_mode).toBe('real')
    expect(r.summary.missing_for_activation).toContain('TWILIO_ACCOUNT_SID')
    expect(r.summary.missing_for_activation).toContain('TWILIO_AUTH_TOKEN')
  })

  it('flags missing APP_URL', () => {
    const r = computePreflight({
      ...base,
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'tok',
    })
    expect(r.ok).toBe(false)
    expect(r.summary.missing_for_activation).toContain('APP_URL (or NEXT_PUBLIC_APP_URL)')
  })

  it('accepts NEXT_PUBLIC_APP_URL as a stand-in for APP_URL', () => {
    const r = computePreflight({
      ...base,
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'tok',
      NEXT_PUBLIC_APP_URL: 'https://quote-mate-rho.vercel.app',
    })
    expect(r.ok).toBe(true)
    expect(r.summary.missing_for_activation).toEqual([])
  })

  it('returns ok=true when every Twilio prerequisite is set', () => {
    const r = computePreflight({
      ...base,
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'tok',
      APP_URL: 'https://quote-mate-rho.vercel.app',
    })
    expect(r.ok).toBe(true)
  })
})

describe('computePreflight — Vapi real mode', () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    VAPI_PROVISIONING_ENABLED: 'true',
  }

  it('flags missing VAPI_API_KEY', () => {
    const r = computePreflight(base)
    expect(r.ok).toBe(false)
    expect(r.summary.vapi_mode).toBe('real')
    expect(r.summary.missing_for_activation).toContain('VAPI_API_KEY')
  })

  it('returns ok=true when VAPI_API_KEY is set', () => {
    const r = computePreflight({ ...base, VAPI_API_KEY: 'vapi_x' })
    expect(r.ok).toBe(true)
  })
})

describe('computePreflight — both real modes together', () => {
  it('returns ok=true and real mode for both when every key set', () => {
    const r = computePreflight({
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      TWILIO_PROVISIONING_ENABLED: 'true',
      VAPI_PROVISIONING_ENABLED: 'true',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'tok',
      APP_URL: 'https://quote-mate-rho.vercel.app',
      VAPI_API_KEY: 'vapi_x',
    })
    expect(r.ok).toBe(true)
    expect(r.summary.twilio_mode).toBe('real')
    expect(r.summary.vapi_mode).toBe('real')
    expect(r.summary.missing_for_activation).toEqual([])
  })

  it('treats TWILIO_PROVISIONING_ENABLED=false as stub mode', () => {
    const r = computePreflight({
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      TWILIO_PROVISIONING_ENABLED: 'false', // explicitly false → stub
      VAPI_PROVISIONING_ENABLED: 'true',
      VAPI_API_KEY: 'vapi_x',
    })
    expect(r.ok).toBe(true)
    expect(r.summary.twilio_mode).toBe('stub')
  })

  it("treats TWILIO_PROVISIONING_ENABLED='TRUE' (case-mismatch) as stub mode (only literal 'true' enables)", () => {
    const r = computePreflight({
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      TWILIO_PROVISIONING_ENABLED: 'TRUE',
    })
    expect(r.summary.twilio_mode).toBe('stub')
  })
})
