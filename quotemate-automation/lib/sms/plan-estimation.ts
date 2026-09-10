// SMS plan-estimation branch (migration 104).
//
// Runs inside the inbound SMS webhook for tenants with the Account-tab
// "SMS electrical estimation" toggle ON. When the inbound text reads like a
// plan-estimation request ("can you quote my electrical plan?"), this branch
// short-circuits the normal quote dialog and replies with a tokenised link to
// the customer plan-upload page (/upload/plan/<token>).
//
// Link lifecycle lives in plan_upload_requests:
//   awaiting_upload → analysing → complete | failed
// A repeat request while a link is live resends the SAME link (no token churn);
// while a run is analysing it sends a hold-on instead of a second link.
//
// Pure intent/template logic is in lib/estimation/plan-request.ts (unit
// tested); this module is the thin side-effectful layer, mirroring the
// tradie-registration branch in the inbound route.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchQuoteMessage } from './dispatch'
import { publicWebUrl } from './public-origin'
import { smsDeliveryContext } from './delivery-context'
import { wantsPlanEstimation, buildPlanUploadSms } from '@/lib/estimation/plan-request'
import type { TenantRow } from '@/lib/tenant/lookup'

export function planUploadUrl(token: string): string {
  return publicWebUrl(`/upload/plan/${encodeURIComponent(token)}`)
}

export function planResultsUrl(shareToken: string): string {
  return publicWebUrl(`/q/plan/${encodeURIComponent(shareToken)}`)
}

export function planReportPdfUrl(shareToken: string): string {
  return publicWebUrl(`/api/q/plan/${encodeURIComponent(shareToken)}/pdf`)
}

/**
 * Handle a possible plan-estimation request. Returns true when the message
 * was handled (caller acks Twilio and stops); false to let the normal
 * customer-quote pipeline take over.
 */
export async function maybeHandlePlanEstimation(args: {
  supabase: SupabaseClient
  tenant: TenantRow
  fromNumber: string
  toNumber: string
  inboundBody: string
  messageSid: string | null
  customerFirstName?: string | null
}): Promise<boolean> {
  const { supabase, tenant } = args
  if (!tenant.sms_estimator_enabled || !wantsPlanEstimation(args.inboundBody)) return false
  const context = smsDeliveryContext()
  await context?.assertOwnership?.()
  const { data: request, error } = await supabase.rpc('sms_plan_request', {
    p_tenant: tenant.id, p_from: args.fromNumber, p_to: args.toNumber,
    p_body: args.inboundBody, p_sid: args.messageSid,
    p_work: context?.workId ?? null, p_owner: context?.workOwner ?? null,
  })
  if (error || !request) throw new Error(`Plan request persistence failed: ${error?.code ?? 'missing row'}`)
  const body = request.status === 'analysing'
    ? "Your plan is being reviewed. We'll update this conversation when the results are ready."
    : buildPlanUploadSms({ firstName: args.customerFirstName ?? null,
      businessName: tenant.business_name, uploadUrl: planUploadUrl(request.token) })
  const result = await dispatchQuoteMessage({
    to: args.fromNumber, from: args.toNumber, text: body,
    tenantId: tenant.id, conversationId: request.sms_conversation_id,
    deliveryKey: args.messageSid ? `plan-upload:${args.messageSid}` : undefined,
  })
  // A saved failure is visible and recoverable in the outbox. A failure to
  // save the intent must retry the incoming job, never silently acknowledge it.
  if (!result.ok && !result.outboxId) throw new Error('Plan upload notification could not be queued')
  return true
}
