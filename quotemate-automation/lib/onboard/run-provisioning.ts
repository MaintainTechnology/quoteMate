// Shared provisioning routine — runs the Twilio + Vapi + persistence
// half of activation. Used by both:
//   • /api/onboard/activate (first time, right after tenant insert)
//   • /api/onboard/retry-provision (recovery if first run failed)
//
// Pure function over its supabase + provisioning dependencies so the
// tests can mock each piece without touching network or DB.
//
// Durable attempt contract (migration216): claim before any provider action.
// Completed attempts are read-only; processing, unknown and historical
// artifacts require reconciliation. None of those states reclaims a purchase.
// The account's active flag is separate from verified phone setup readiness.

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
import { setTwilioSmsWebhook } from '@/lib/twilio/set-sms-webhook'
import { smsWebhookUrl } from '@/lib/twilio/provision'
import { provisionTenantStore } from '@/lib/filestore/tenant-provision'
import { isStubTwilioNumber, isStubVapiId } from './stub-detect'
import { after } from 'next/server'
import { computePreflight } from './preflight-logic'
import { ProvisioningAttemptSchema, PROVISIONING_TENANT_FIELDS, readProvisioningStatus, type PhoneReadiness, type ProvisioningTenant } from './provisioning-status'
import { z } from 'zod'

export type ProvisioningInput = {
  tenantId: string
  businessName: string
  /** Primary trade — used for back-compat fields. Any registered trade
   *  name (electrical / plumbing / painting / …); the Vapi layer is
   *  data-driven and speaks new trades verbatim. */
  trade: string
  /** Full set of trades this tenant operates in. When provided, the Vapi
   *  assistant prompt mentions each. Defaults to `[trade]` so older
   *  callers keep working. */
  trades?: string[]
  ownerFirstName: string
  /** E.164, or null when the tenant onboarded without a mobile — the
   *  welcome SMS is skipped and `welcome` stays undefined on the result. */
  ownerMobile: string | null
  /** Pre-existing values on the tenant row — lets us skip steps we already did. */
  existing?: {
    twilioSmsNumber?: string | null
    vapiAssistantId?: string | null
  }
}

export type ProvisioningOutput = {
  phoneReadiness?: PhoneReadiness
  twilioNumberSid?: string | null
  smsRoutingConfirmed?: boolean
  voiceRoutingConfirmed?: boolean
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
  supabase: Pick<SupabaseClient, 'from'|'rpc'>,
  input: ProvisioningInput,
  provisioners: Provisioners = {},
): Promise<ProvisioningOutput> {
  const fallback: ProvisioningOutput = { ok:false, phoneNumber:null, vapiAssistantId:null,
    activated:false, stubbedTwilio:false, stubbedVapi:false }
  let operationId: string | null = null
  try {
    const { data:tenant,error:tenantError } = await supabase.from('tenants').select(PROVISIONING_TENANT_FIELDS).eq('id',input.tenantId).single()
    if (tenantError || !tenant) throw new Error('Account could not be read before phone setup')
    const before = await readProvisioningStatus(supabase,tenant as ProvisioningTenant)
    if (!before.retryable) return { ...fallback,ok:before.state==='ready'||before.state==='stub',
      phoneNumber:before.phoneNumber, phoneReadiness:before, error:before.setupComplete ? undefined:before.message }
    // This check performs no provider I/O. A failure here is the only retryable
    // no-dispatch disposition. Once claimed, a crash or false provider result
    // cannot establish that no number/assistant was created.
    const preflight = computePreflight(process.env)
    if (!preflight.ok) return { ...fallback,phoneReadiness:before,error:'Phone setup configuration is incomplete. Contact support, then check status.' }
    const {data,error} = await supabase.rpc('claim_tenant_provisioning',{ p_tenant_id:input.tenantId })
    if (error) throw new Error('Phone setup attempt could not be recorded')
    const claim = z.object({ claimed:z.boolean(), operation:ProvisioningAttemptSchema.nullable() }).parse(data)
    if (!claim.claimed) {
      const {data:current,error:readError} = await supabase.from('tenants').select(PROVISIONING_TENANT_FIELDS).eq('id',input.tenantId).single()
      if (readError || !current) throw new Error('Phone setup status could not be read')
      const status=await readProvisioningStatus(supabase,current as ProvisioningTenant)
      return {...fallback, phoneNumber:status.phoneNumber, phoneReadiness:status,error:status.message}
    }
    if (!claim.operation || claim.operation.tenant_id !== input.tenantId || claim.operation.state !== 'processing') throw new Error('Phone setup claim identity mismatch')
    operationId=claim.operation.operation_id
    const result=await performProvisioning(supabase,{...input,existing:undefined},provisioners)
    const proof={version:1,mode:before.provisioningMode, phoneNumber:result.phoneNumber,
      twilioNumberSid:result.twilioNumberSid??null,vapiAssistantId:result.vapiAssistantId,
      stubbedTwilio:result.stubbedTwilio,stubbedVapi:result.stubbedVapi,
      smsRoutingConfirmed:result.smsRoutingConfirmed===true,voiceRoutingConfirmed:result.voiceRoutingConfirmed===true,
      tenantPersisted:result.activated}
    const {data:saved,error:saveError}=await supabase.from('tenant_provisioning_attempts')
      .update({state:result.ok?'completed':'unknown',result:proof,completed_at:new Date().toISOString()})
      .eq('tenant_id',input.tenantId).eq('operation_id',operationId).eq('state','processing').select('operation_id').single()
    if(saveError||!saved) throw new Error('Phone setup outcome could not be recorded')
    const {data:current,error:readError}=await supabase.from('tenants').select(PROVISIONING_TENANT_FIELDS).eq('id',input.tenantId).single()
    if(readError||!current) throw new Error('Phone setup outcome could not be read')
    return {...result,phoneReadiness:await readProvisioningStatus(supabase,current as ProvisioningTenant)}
  } catch {
    // Never clear/reclaim a started attempt, even when this best-effort stamp
    // fails. Its persisted processing state blocks further provider dispatch.
    if(operationId) {
      try { await supabase.from('tenant_provisioning_attempts').update({state:'unknown'})
        .eq('tenant_id',input.tenantId).eq('operation_id',operationId).eq('state','processing') } catch { /* retain processing */ }
    }
    return {...fallback,error:'Phone setup could not be confirmed. Check status before taking further action.'}
  }
}

async function performProvisioning(
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
  let stubbedTwilio = isStubTwilioNumber(phoneNumber)
  let stubbedVapi = isStubVapiId(vapiAssistantId)
  let warning: string | undefined
  let smsRoutingConfirmed = false
  let smsCapable = false
  let voiceCapable = false

  // Twilio Phone Number SID — the authoritative real-vs-stub signal we persist
  // so the Tenant Health monitor never has to guess from the number's digits
  // (BUG-15). Only known when we provision a number in THIS call; for a
  // pre-existing number we leave the stored value untouched (the backfill
  // heals it). `freshTwilio` gates whether we write the column at all.
  let twilioNumberSid: string | null = null
  let freshTwilio = false

  // ── 1. Provision Twilio number (skip if already on file) ─────────
  if (!phoneNumber) {
    const twilio: TwilioProvisionResult = await buyTwilio({
      tenantId: input.tenantId,
      friendlyName: `${input.businessName} — QuoteMax`,
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
    freshTwilio = true
    // Real provision → capture the SID; stub provision → leave it null.
    if ('stubbed' in twilio && !twilio.stubbed) {
      twilioNumberSid = twilio.twilioSid
      smsCapable = twilio.capabilities?.sms === true
      voiceCapable = twilio.capabilities?.voice === true
    }
  }

  // ── 2. Provision Vapi assistant (skip if already on file) ────────
  if (!vapiAssistantId) {
    const vapi: VapiProvisionResult = await createVapi({
      tenantId: input.tenantId,
      businessName: input.businessName,
      trade: input.trade,
      trades: input.trades ?? [input.trade],
      phoneNumber,
    })
    if (!vapi.ok) {
      // Keep known provider artifacts for reconciliation. The durable attempt
      // remains unknown; a partial result never authorizes another purchase.
      await supabase
        .from('tenants')
        .update({
          twilio_sms_number: phoneNumber,
          twilio_voice_number: phoneNumber,
          ...(freshTwilio ? { twilio_number_sid: twilioNumberSid } : {}),
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
    name: `${input.businessName} — QuoteMax`,
  })
  if (!register.ok) {
    warning = `Vapi number registration failed: ${register.reason}`
  }

  // ── 3b. Reclaim the SMS webhook from Vapi ────────────────────────
  // When Vapi accepts a Twilio number via /phone-number it ALSO
  // rewrites Twilio's SmsUrl to api.vapi.ai/twilio/sms so it can offer
  // AI-SMS. We don't use that path, so immediately after registration we
  // POST the SmsUrl back to the SMS receptionist.
  //
  // ⚠ Cutover 2026-08-05: "ours" is now the FRONT DESK service, not this app.
  // This used to rebuild the URL from APP_URL, which would have provisioned
  // every new tenant onto the in-app receptionist that is now disabled —
  // born broken. smsWebhookUrl() is shared with lib/twilio/provision.ts so
  // there is one source of truth for where inbound SMS goes.
  //
  // Non-fatal: assistant + number still exist with status=active. If
  // this step fails, inbound voice keeps working; only inbound SMS is
  // misrouted until someone retries provisioning (or fixes it via the
  // Twilio console).
  if (!stubbedTwilio) {
    const smsHook = await setTwilioSmsWebhook({
      phoneNumber,
      smsUrl: smsWebhookUrl(),
    })
    if (!smsHook.ok) {
      const note = `SMS webhook reclaim failed: ${smsHook.reason}`
      warning = warning ? `${warning} · ${note}` : note
    } else smsRoutingConfirmed = smsCapable && !smsHook.stubbed && smsHook.twilioSid === twilioNumberSid
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
      ...(freshTwilio ? { twilio_number_sid: twilioNumberSid } : {}),
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

  // ── 4b. Provision the tenant's file store (fire-and-forget, post-ack) ──
  // Deferred via next/server after() (spec R6) so it never adds the KB
  // round-trip to the activation request latency. STUBs (no-op, no network)
  // when TENANT_FILESTORE_ENABLED !== 'true' — the pilot default. Never fatal:
  // failures are logged, not surfaced, and the lazy ensure-on-first-quote +
  // reconcile paths recover later if this misses.
  after(async () => {
    try {
      const fs = await provisionTenantStore(
        { tenantId: input.tenantId, businessName: input.businessName },
        { supabase },
      )
      if (!fs.ok) {
        console.warn(`[run-provisioning] file-store provisioning failed: ${fs.reason}`)
      }
    } catch (e) {
      console.warn(
        `[run-provisioning] file-store provisioning threw: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  })

  // ── 5. Welcome SMS (non-fatal) ───────────────────────────────────
  // Skipped entirely when the tenant onboarded without a mobile —
  // `welcome` stays undefined, the declared "didn't try" state.
  const welcome = input.ownerMobile && !stubbedTwilio && !stubbedVapi && !warning && smsRoutingConfirmed
    ? await welcomeSms({
        fromNumber: phoneNumber,
        toMobile: input.ownerMobile,
        firstName: input.ownerFirstName,
        businessName: input.businessName,
      })
    : undefined

  return {
    ok: true,
    phoneNumber,
    vapiAssistantId,
    activated: true,
    stubbedTwilio,
    stubbedVapi,
    welcome,
    warning,
    twilioNumberSid,
    smsRoutingConfirmed,
    voiceRoutingConfirmed: voiceCapable && register.ok && !register.stubbed,
  }
}
