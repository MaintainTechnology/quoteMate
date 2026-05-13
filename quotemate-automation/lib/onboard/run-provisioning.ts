// Shared provisioning routine — runs the Twilio + Vapi + persistence
// half of activation. Used by both:
//   • /api/onboard/activate (first time, right after tenant insert)
//   • /api/onboard/retry-provision (recovery if first run failed)
//
// Pure function over its supabase + provisioning dependencies so the
// tests can mock each piece without touching network or DB.
//
// Idempotence contract:
//   • If the tenant already has twilio_sms_number AND vapi_assistant_id,
//     do nothing and return ok with the existing values. This means the
//     retry endpoint is safe to hammer.
//   • If only one of the two is set, finish the other half. The Vapi
//     register-number call uses whichever phone number is now on file.
//   • On success, tenant row ends with status='active', activated_at
//     populated, and both provisioned IDs stamped.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  provisionTwilioNumber,
  type ProvisionResult as TwilioProvisionResult,
} from '@/lib/twilio/provision'
import {
  provisionVapiAssistant,
  type VapiProvisionResult,
} from '@/lib/vapi/provision'
import {
  registerNumberWithVapi,
  type VapiRegisterResult,
} from '@/lib/vapi/register-number'
import { sendWelcomeSms, type WelcomeSmsResult } from '@/lib/twilio/welcome-sms'

export type ProvisioningInput = {
  tenantId: string
  businessName: string
  trade: 'electrical' | 'plumbing'
  ownerFirstName: string
  ownerMobile: string // E.164
  /** Pre-existing values on the tenant row — lets us skip steps we already did. */
  existing?: {
    twilioSmsNumber?: string | null
    vapiAssistantId?: string | null
  }
}

export type ProvisioningOutput = {
  ok: boolean
  /** Final number that lives on the tenant row (real, stub, or pre-existing). */
  phoneNumber: string | null
  /** Final Vapi assistant id on the tenant row. */
  vapiAssistantId: string | null
  /** True iff the tenant row was updated to status='active' in this call. */
  activated: boolean
  /** True iff the underlying provisioning relied on the deterministic stub. */
  stubbedTwilio: boolean
  stubbedVapi: boolean
  /** Optional non-fatal warning surfaced to the caller. */
  warning?: string
  /** Outcome of the welcome SMS. Undefined if we didn't try to send one. */
  welcome?: WelcomeSmsResult
  /** First hard error from the chain (Twilio purchase / Vapi create). */
  error?: string
}

export type Provisioners = {
  twilio?: typeof provisionTwilioNumber
  vapi?: typeof provisionVapiAssistant
  registerVapiNumber?: typeof registerNumberWithVapi
  welcome?: typeof sendWelcomeSms
}

/**
 * Run the provisioning chain for a tenant.
 *
 * - `supabase` must be a service-role client (used to update the tenants row).
 * - `provisioners` lets tests inject mocks; defaults call the live libs.
 */
export async function runProvisioning(
  supabase: Pick<SupabaseClient, 'from'>,
  input: ProvisioningInput,
  provisioners: Provisioners = {},
): Promise<ProvisioningOutput> {
  const buyTwilio = provisioners.twilio ?? provisionTwilioNumber
  const createVapi = provisioners.vapi ?? provisionVapiAssistant
  const registerVapi = provisioners.registerVapiNumber ?? registerNumberWithVapi
  const welcomeSms = provisioners.welcome ?? sendWelcomeSms

  let phoneNumber: string | null = input.existing?.twilioSmsNumber ?? null
  let vapiAssistantId: string | null = input.existing?.vapiAssistantId ?? null
  let stubbedTwilio = isStubTwilio(phoneNumber)
  let stubbedVapi = isStubVapi(vapiAssistantId)
  let warning: string | undefined

  // ── 1. Provision Twilio number (skip if already on file) ─────────
  if (!phoneNumber) {
    const twilio: TwilioProvisionResult = await buyTwilio({
      tenantId: input.tenantId,
      friendlyName: `${input.businessName} — QuoteMate`,
    })
    if (!twilio.ok) {
      return {
        ok: false,
        phoneNumber: null,
        vapiAssistantId,
        activated: false,
        stubbedTwilio: false,
        stubbedVapi,
        error: `Twilio: ${twilio.reason}`,
      }
    }
    phoneNumber = twilio.phoneNumber
    stubbedTwilio = 'stubbed' in twilio ? twilio.stubbed : false
  }

  // ── 2. Provision Vapi assistant (skip if already on file) ────────
  if (!vapiAssistantId) {
    const vapi: VapiProvisionResult = await createVapi({
      tenantId: input.tenantId,
      businessName: input.businessName,
      trade: input.trade,
      phoneNumber,
    })
    if (!vapi.ok) {
      // Half-provisioned: we keep the Twilio number on the tenant so the
      // retry endpoint can finish the Vapi half later.
      await supabase
        .from('tenants')
        .update({
          twilio_sms_number: phoneNumber,
          twilio_voice_number: phoneNumber,
        })
        .eq('id', input.tenantId)
      return {
        ok: false,
        phoneNumber,
        vapiAssistantId: null,
        activated: false,
        stubbedTwilio,
        stubbedVapi: false,
        error: `Vapi: ${vapi.reason}`,
      }
    }
    vapiAssistantId = vapi.assistantId
    stubbedVapi = vapi.stubbed
  }

  // ── 3. Bind the Twilio number to the Vapi assistant ───────────────
  // Non-fatal: assistant + number both exist. Voice routing simply
  // won't work until this registration retries successfully.
  const register: VapiRegisterResult = await registerVapi({
    phoneNumber,
    assistantId: vapiAssistantId,
    name: `${input.businessName} — QuoteMate`,
  })
  if (!register.ok) {
    warning = `Vapi number registration failed: ${register.reason}`
  }

  // ── 4. Stamp the tenant row → active ─────────────────────────────
  const { error: updErr } = await supabase
    .from('tenants')
    .update({
      twilio_sms_number: phoneNumber,
      twilio_voice_number: phoneNumber,
      vapi_assistant_id: vapiAssistantId,
      status: 'active',
      activated_at: new Date().toISOString(),
    })
    .eq('id', input.tenantId)

  if (updErr) {
    return {
      ok: false,
      phoneNumber,
      vapiAssistantId,
      activated: false,
      stubbedTwilio,
      stubbedVapi,
      error: `Tenant update failed: ${updErr.message ?? String(updErr)}`,
      warning,
    }
  }

  // ── 5. Welcome SMS (non-fatal) ───────────────────────────────────
  const welcome = await welcomeSms({
    fromNumber: phoneNumber,
    toMobile: input.ownerMobile,
    firstName: input.ownerFirstName,
    businessName: input.businessName,
  })

  return {
    ok: true,
    phoneNumber,
    vapiAssistantId,
    activated: true,
    stubbedTwilio,
    stubbedVapi,
    welcome,
    warning,
  }
}

/** Detects the deterministic stub number shape `+614820xxxxx`. */
function isStubTwilio(n: string | null | undefined): boolean {
  return !!n && /^\+614820\d{5}$/.test(n)
}

/** Detects the deterministic stub assistant id `vapi-stub-...`. */
function isStubVapi(id: string | null | undefined): boolean {
  return !!id && id.startsWith('vapi-stub-')
}
