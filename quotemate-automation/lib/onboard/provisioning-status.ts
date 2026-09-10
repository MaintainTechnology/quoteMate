import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { computePreflight } from './preflight-logic'

export const ProvisioningProofSchema = z.object({
  version: z.literal(1),
  mode: z.object({ twilio: z.enum(['real','stub']), vapi: z.enum(['real','stub']) }),
  phoneNumber: z.string().nullable(), twilioNumberSid: z.string().nullable(),
  vapiAssistantId: z.string().nullable(),
  stubbedTwilio: z.boolean(), stubbedVapi: z.boolean(),
  smsRoutingConfirmed: z.boolean(), voiceRoutingConfirmed: z.boolean(),
  tenantPersisted: z.boolean(),
})
export const ProvisioningAttemptSchema = z.object({
  tenant_id: z.string().uuid(), operation_id: z.string().uuid(),
  state: z.enum(['processing','completed','unknown']),
  result: ProvisioningProofSchema.nullable(), created_at: z.string(), completed_at: z.string().nullable(),
})
export type ProvisioningAttempt = z.infer<typeof ProvisioningAttemptSchema>
export const PROVISIONING_TENANT_FIELDS = 'id,status,twilio_sms_number,twilio_voice_number,twilio_number_sid,vapi_assistant_id'
export type ProvisioningTenant = {
  id: string; status?: string | null; twilio_sms_number?: string | null;
  twilio_voice_number?: string | null; twilio_number_sid?: string | null; vapi_assistant_id?: string | null
}
export type PhoneReadiness = {
  version: 1; tenantId: string; operationId: string | null;
  state: 'ready'|'stub'|'incomplete'|'processing'|'unknown'|'not_started';
  setupComplete: boolean; retryable: boolean; phoneNumber: string | null;
  smsReady: boolean; voiceReady: boolean;
  provisioningMode: { twilio: 'real'|'stub'; vapi: 'real'|'stub' };
  message: string;
}
export function provisioningView(tenant: ProvisioningTenant, attempt: ProvisioningAttempt | null): PhoneReadiness {
  const { summary } = computePreflight(process.env)
  const mode = { twilio: summary.twilio_mode, vapi: summary.vapi_mode }
  const base = { version: 1 as const, tenantId: tenant.id, operationId: attempt?.operation_id ?? null,
    setupComplete:false, retryable:false, phoneNumber:tenant.twilio_sms_number ?? null,
    smsReady:false, voiceReady:false, provisioningMode:mode }
  if (!attempt) {
    const historical = [tenant.twilio_sms_number,tenant.twilio_voice_number,tenant.twilio_number_sid,tenant.vapi_assistant_id].some(v => !!v?.trim())
    return { ...base, state: historical ? 'unknown':'not_started', retryable:!historical,
      message: historical ? 'Existing phone setup needs provider reconciliation. Contact support before retrying.' : 'Account created. Phone setup has not started.' }
  }
  if (attempt.tenant_id !== tenant.id) throw new Error('Provisioning receipt ownership mismatch')
  if (attempt.state !== 'completed') return { ...base, state:attempt.state,
    message:'Phone setup is unconfirmed. Check status; do not start another purchase. Contact support if it remains unconfirmed.' }
  const proof = attempt.result
  if (!proof || !proof.tenantPersisted || tenant.status !== 'active' ||
      proof.phoneNumber !== tenant.twilio_sms_number || proof.phoneNumber !== tenant.twilio_voice_number ||
      proof.twilioNumberSid !== (tenant.twilio_number_sid ?? null) || proof.vapiAssistantId !== tenant.vapi_assistant_id) {
    return { ...base, state:'unknown', message:'The saved phone setup no longer matches this account. Contact support to reconcile it.' }
  }
  if (proof.stubbedTwilio || proof.stubbedVapi || proof.mode.twilio !== 'real' || proof.mode.vapi !== 'real') {
    return { ...base, state:'stub', message:'This is a test phone setup. Contact support to arrange a real line.' }
  }
  const real = mode.twilio === 'real' && mode.vapi === 'real' &&
    /^PN[a-f0-9]{32}$/i.test(proof.twilioNumberSid ?? '') && /^\+[1-9]\d{7,14}$/.test(proof.phoneNumber ?? '') &&
    !!proof.vapiAssistantId?.trim() && !proof.vapiAssistantId.startsWith('vapi-stub-')
  const smsReady = real && proof.smsRoutingConfirmed
  const voiceReady = real && proof.voiceRoutingConfirmed
  const ready = smsReady && voiceReady
  return { ...base, state:ready ? 'ready':'incomplete', setupComplete:ready, smsReady, voiceReady,
    message:ready ? 'Your phone setup is ready.' : 'Phone routing is not fully confirmed. Contact support to complete setup.' }
}
export async function readProvisioningStatus(db: Pick<SupabaseClient,'from'>, tenant: ProvisioningTenant): Promise<PhoneReadiness> {
  const { data,error } = await db.from('tenant_provisioning_attempts').select('*').eq('tenant_id',tenant.id).maybeSingle()
  if (error) throw new Error('Phone setup status is unavailable')
  return provisioningView(tenant,data ? ProvisioningAttemptSchema.parse(data):null)
}
