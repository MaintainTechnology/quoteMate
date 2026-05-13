// End-to-end tests for the runProvisioning chain.
//
// These tests cover the persistence guarantee the user is missing in
// prod: after a Twilio + Vapi success the tenants row MUST end up with
// twilio_sms_number, twilio_voice_number, vapi_assistant_id, status =
// 'active', and activated_at populated. Mock all 4 provisioner deps and
// the supabase update path so the test is hermetic.

import { describe, expect, it, vi } from 'vitest'
import { runProvisioning } from './run-provisioning'

/* ─── Mock builders ──────────────────────────────────────── */

function mockSupabase() {
  const updateCalls: Array<{ table: string; payload: any; whereCol: string; whereVal: string }> = []
  const supabase = {
    from(table: string) {
      return {
        update(payload: any) {
          return {
            eq(col: string, val: string) {
              updateCalls.push({ table, payload, whereCol: col, whereVal: val })
              return Promise.resolve({ error: null }) as any
            },
          }
        },
      }
    },
  }
  return { supabase, updateCalls }
}

function happyProvisioners() {
  return {
    twilio: vi.fn(async (_opts: { tenantId: string; friendlyName: string }) => ({
      ok: true as const,
      stubbed: false as const,
      phoneNumber: '+61412345678',
      twilioSid: 'PN-test',
      numberType: 'Mobile' as const,
      capabilities: { voice: true, sms: true, mms: true, fax: false },
      faxAvailable: false,
    })),
    vapi: vi.fn(async (_opts: {
      tenantId: string
      businessName: string
      trade: 'electrical' | 'plumbing'
      phoneNumber?: string
    }) => ({
      ok: true as const,
      stubbed: false as const,
      assistantId: 'asst_test_real',
    })),
    registerVapiNumber: vi.fn(async (_opts: {
      phoneNumber: string
      assistantId: string
      name: string
    }) => ({
      ok: true as const,
      stubbed: false as const,
      vapiPhoneNumberId: 'pn_test_real',
    })),
    welcome: vi.fn(async (_opts: {
      fromNumber: string
      toMobile: string
      firstName: string
      businessName: string
    }) => ({
      ok: true as const,
      stubbed: false as const,
      sid: 'SM_test',
    })),
  }
}

const TENANT_ID = '11111111-2222-3333-4444-555555555555'
const STD_INPUT = {
  tenantId: TENANT_ID,
  businessName: 'Peppers Plumbing',
  trade: 'plumbing' as const,
  ownerFirstName: 'Jon',
  ownerMobile: '+61412000999',
}

/* ─── The happy path ─────────────────────────────────────── */

describe('runProvisioning — happy path', () => {
  it('returns ok=true, persists the tenants row, and sends the welcome SMS', async () => {
    const { supabase, updateCalls } = mockSupabase()
    const provisioners = happyProvisioners()

    const result = await runProvisioning(supabase as any, STD_INPUT, provisioners)

    expect(result.ok).toBe(true)
    expect(result.phoneNumber).toBe('+61412345678')
    expect(result.vapiAssistantId).toBe('asst_test_real')
    expect(result.activated).toBe(true)
    expect(result.stubbedTwilio).toBe(false)
    expect(result.stubbedVapi).toBe(false)
    expect(result.welcome?.ok).toBe(true)

    // Tenant row must have been updated with all provisioning fields
    expect(updateCalls).toHaveLength(1)
    const persist = updateCalls[0]
    expect(persist.table).toBe('tenants')
    expect(persist.whereCol).toBe('id')
    expect(persist.whereVal).toBe(TENANT_ID)
    expect(persist.payload.twilio_sms_number).toBe('+61412345678')
    expect(persist.payload.twilio_voice_number).toBe('+61412345678')
    expect(persist.payload.vapi_assistant_id).toBe('asst_test_real')
    expect(persist.payload.status).toBe('active')
    expect(typeof persist.payload.activated_at).toBe('string')

    // All provisioners called exactly once
    expect(provisioners.twilio).toHaveBeenCalledTimes(1)
    expect(provisioners.vapi).toHaveBeenCalledTimes(1)
    expect(provisioners.registerVapiNumber).toHaveBeenCalledTimes(1)
    expect(provisioners.welcome).toHaveBeenCalledTimes(1)

    // Vapi register call must reference the freshly-purchased number + assistant
    const registerArgs = provisioners.registerVapiNumber.mock.calls[0][0] as any
    expect(registerArgs.phoneNumber).toBe('+61412345678')
    expect(registerArgs.assistantId).toBe('asst_test_real')
  })

  it('flags both stub paths when env flags are off (stubbed results)', async () => {
    const { supabase, updateCalls } = mockSupabase()
    const stubProvisioners = {
      twilio: vi.fn(async () => ({
        ok: true as const,
        stubbed: true as const,
        phoneNumber: '+61482012345',
      })),
      vapi: vi.fn(async () => ({
        ok: true as const,
        stubbed: true as const,
        assistantId: 'vapi-stub-11111111',
      })),
      registerVapiNumber: vi.fn(async () => ({ ok: true as const, stubbed: true as const })),
      welcome: vi.fn(async () => ({ ok: true as const, stubbed: true as const, loggedMessage: '' })),
    }

    const result = await runProvisioning(supabase as any, STD_INPUT, stubProvisioners)

    expect(result.ok).toBe(true)
    expect(result.stubbedTwilio).toBe(true)
    expect(result.stubbedVapi).toBe(true)
    // Even in stub mode we persist the number so the dashboard renders a value.
    expect(updateCalls[0].payload.twilio_sms_number).toBe('+61482012345')
    expect(updateCalls[0].payload.vapi_assistant_id).toBe('vapi-stub-11111111')
    expect(updateCalls[0].payload.status).toBe('active')
  })
})

/* ─── Twilio failure ─────────────────────────────────────── */

describe('runProvisioning — Twilio failure', () => {
  it('returns ok=false, does NOT activate, does NOT call Vapi, and surfaces the reason', async () => {
    const { supabase, updateCalls } = mockSupabase()
    const provisioners = {
      ...happyProvisioners(),
      twilio: vi.fn(async () => ({
        ok: false as const,
        reason: 'Authentication Error - No credentials provided',
      })),
    }

    const result = await runProvisioning(supabase as any, STD_INPUT, provisioners)

    expect(result.ok).toBe(false)
    expect(result.phoneNumber).toBeNull()
    expect(result.activated).toBe(false)
    expect(result.error).toMatch(/Twilio.*Authentication Error/)

    // Vapi must not be called when Twilio fails
    expect(provisioners.vapi).not.toHaveBeenCalled()
    expect(provisioners.registerVapiNumber).not.toHaveBeenCalled()
    expect(provisioners.welcome).not.toHaveBeenCalled()

    // No tenant update — the tenant row should remain in status='onboarding'
    expect(updateCalls).toHaveLength(0)
  })
})

/* ─── Vapi failure (half-provisioned) ────────────────────── */

describe('runProvisioning — Vapi failure', () => {
  it('returns ok=false, persists the Twilio number, leaves status=onboarding', async () => {
    const { supabase, updateCalls } = mockSupabase()
    const provisioners = {
      ...happyProvisioners(),
      vapi: vi.fn(async () => ({ ok: false as const, reason: 'Unauthorized' })),
    }

    const result = await runProvisioning(supabase as any, STD_INPUT, provisioners)

    expect(result.ok).toBe(false)
    expect(result.phoneNumber).toBe('+61412345678')
    expect(result.vapiAssistantId).toBeNull()
    expect(result.activated).toBe(false)
    expect(result.error).toMatch(/Vapi.*Unauthorized/)

    // Should have persisted just the Twilio number, NOT status='active'
    expect(updateCalls).toHaveLength(1)
    const persist = updateCalls[0]
    expect(persist.payload.twilio_sms_number).toBe('+61412345678')
    expect(persist.payload.status).toBeUndefined()
    expect(persist.payload.vapi_assistant_id).toBeUndefined()

    // Welcome SMS not attempted
    expect(provisioners.welcome).not.toHaveBeenCalled()
  })
})

/* ─── Vapi register-number is non-fatal ───────────────────── */

describe('runProvisioning — Vapi register-number failure is non-fatal', () => {
  it('still activates the tenant and returns ok=true, with a warning', async () => {
    const { supabase, updateCalls } = mockSupabase()
    const provisioners = {
      ...happyProvisioners(),
      registerVapiNumber: vi.fn(async () => ({
        ok: false as const,
        reason: 'Number already registered',
      })),
    }

    const result = await runProvisioning(supabase as any, STD_INPUT, provisioners)

    expect(result.ok).toBe(true)
    expect(result.activated).toBe(true)
    expect(result.warning).toMatch(/Number already registered/)
    expect(updateCalls[0].payload.status).toBe('active')
  })
})

/* ─── Idempotent retry: pre-existing values are reused ────── */

describe('runProvisioning — retry path (existing values)', () => {
  it('skips Twilio when twilio_sms_number is already on file', async () => {
    const { supabase, updateCalls } = mockSupabase()
    const provisioners = happyProvisioners()

    const result = await runProvisioning(
      supabase as any,
      {
        ...STD_INPUT,
        existing: { twilioSmsNumber: '+61412999000', vapiAssistantId: null },
      },
      provisioners,
    )

    expect(result.ok).toBe(true)
    expect(result.phoneNumber).toBe('+61412999000')
    expect(provisioners.twilio).not.toHaveBeenCalled()
    expect(provisioners.vapi).toHaveBeenCalledTimes(1)
    expect(provisioners.registerVapiNumber).toHaveBeenCalledTimes(1)
    expect(updateCalls[0].payload.twilio_sms_number).toBe('+61412999000')
    expect(updateCalls[0].payload.vapi_assistant_id).toBe('asst_test_real')
  })

  it('skips Vapi when vapi_assistant_id is already on file', async () => {
    const { supabase, updateCalls } = mockSupabase()
    const provisioners = happyProvisioners()

    const result = await runProvisioning(
      supabase as any,
      {
        ...STD_INPUT,
        existing: { twilioSmsNumber: null, vapiAssistantId: 'asst_existing' },
      },
      provisioners,
    )

    expect(result.ok).toBe(true)
    expect(result.vapiAssistantId).toBe('asst_existing')
    expect(provisioners.twilio).toHaveBeenCalledTimes(1) // must still buy a number
    expect(provisioners.vapi).not.toHaveBeenCalled()
    expect(provisioners.registerVapiNumber).toHaveBeenCalledTimes(1)
    expect(updateCalls[0].payload.vapi_assistant_id).toBe('asst_existing')
  })

  it('correctly detects stub markers from pre-existing values', async () => {
    const { supabase } = mockSupabase()
    const provisioners = happyProvisioners()

    const result = await runProvisioning(
      supabase as any,
      {
        ...STD_INPUT,
        existing: {
          twilioSmsNumber: '+61482012345',
          vapiAssistantId: 'vapi-stub-aaaa',
        },
      },
      provisioners,
    )

    expect(result.ok).toBe(true)
    expect(result.stubbedTwilio).toBe(true)
    expect(result.stubbedVapi).toBe(true)
  })
})

/* ─── Persistence failure ────────────────────────────────── */

describe('runProvisioning — tenant update failure', () => {
  it('returns ok=false with the DB error reason', async () => {
    const failingSupabase = {
      from() {
        return {
          update() {
            return {
              eq() {
                return Promise.resolve({ error: { message: 'permission denied' } }) as any
              },
            }
          },
        }
      },
    }
    const provisioners = happyProvisioners()

    const result = await runProvisioning(failingSupabase as any, STD_INPUT, provisioners)

    expect(result.ok).toBe(false)
    expect(result.activated).toBe(false)
    expect(result.error).toMatch(/permission denied/)
  })
})
