// All painting intake channels save the same draft and review task. Only an
// authenticated tradie approval can release the saved quote to its customer.
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildPaintingHoldingSms } from './painting-compose'
import { toPaintingRequest, type PaintingSlots } from './painting-intake'
import type { PaintingConversationState } from './painting-receptionist'
import { persistHumanHandoff } from './human-handoff'
import { runAndSavePaintingQuote } from '@/lib/painting/quote-dispatch'

export type PaintingEstimateDispatchResult =
  | { ok: true; state: PaintingConversationState; token: string; inspection: boolean }
  | { ok: false; reason: string }

export async function estimateAndDispatchPainting(args: {
  supabase: SupabaseClient
  tenantId: string | null
  customerPhone: string
  firstName: string | null
  baseUrl: string
  slots: PaintingSlots
  requestKey?: string
  conversationId?: string
  /** Sends one SMS/MMS to the customer and persists it on the thread. The
   *  dispatch result is USED — `ok: false` means the customer got nothing. */
  sendReply: (text: string, mediaUrl?: string) => Promise<{ ok: boolean }>
}): Promise<PaintingEstimateDispatchResult> {
  const request = toPaintingRequest(args.slots)
  if (!request) return { ok: false, reason: 'incomplete brief — nothing to estimate' }

  const disp = await runAndSavePaintingQuote({
    supabase: args.supabase,
    tenantId: args.tenantId,
    customerPhone: args.customerPhone,
    customerName: args.firstName,
    request,
    requestKey: args.requestKey,
  })
  if (!disp.ok) return { ok: false, reason: 'painting estimate failed' }

  if (!args.tenantId) return { ok: false, reason: 'painting tenant unavailable' }
  try {
    const { data: saved, error } = await args.supabase.from('painting_measurements')
      .select('id').eq('tenant_id', args.tenantId).eq('public_token', disp.token).single()
    if (error || !saved?.id) return { ok: false, reason: 'painting saved draft unavailable' }
    await persistHumanHandoff({ supabase: args.supabase, tenantId: args.tenantId,
      customerPhone: args.customerPhone, conversationId: args.conversationId,
      requestKey: `paint:${saved.id}:review`, trade: 'painting',
      reason: `Review saved painting draft at ${request.address.address}`,
      resourceType: 'paint', resourceId: saved.id, baseUrl: args.baseUrl })
    const sent = await args.sendReply(disp.inspection
      ? 'Your painting details are saved. This job needs an on-site assessment; the painter needs to review the request before arranging it.'
      : buildPaintingHoldingSms({ firstName: args.firstName, businessName: null }))
    if (!sent.ok) return { ok: false, reason: 'painting draft saved; customer status send failed' }
    return { ok: true, token: disp.token, inspection: disp.inspection,
      state: { slots: args.slots, last_step: 'closed', workflow_stage: 'awaiting_review',
        pending_form_token: null, pending_quote_token: disp.token } }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'painting review handoff unavailable' }
  }
}
