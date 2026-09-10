// SMS, public form and voice handover share tenant pricing, checked persistence,
// a durable tradie review task and an honest saved-draft status. Customer quote
// links are available only after authenticated approval.
import type { SupabaseClient } from '@supabase/supabase-js'
import { applySolarToTiers, buildRoofPhotoMedia } from './roofing-compose'
import { createHash } from 'node:crypto'
import { persistHumanHandoff } from './human-handoff'
import { publicWebOrigin } from './public-origin'
import { toRoofingRequest, type RoofingSlots } from './roofing-intake'
import type { RoofingConversationState } from './roofing-receptionist'
import { sendSms } from './twilio'
import { measureAndPriceRoofs } from '@/lib/roofing/measure'
import { loadTenantRoofingPricingContext } from '@/lib/roofing/pricing-authority'
import { newMeasurementTokens } from '@/lib/roofing/tokens'
import type { MultiRoofQuote } from '@/lib/roofing/types'

/** Base URL every /q/roof link is built from. Shared by the SMS route and
 *  the voice handover so a voice-origin link is identical to an SMS one. */
export const ROOFING_APP_BASE_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://quotemax.com.au'

/** Best-effort roof-photo MMS. One image for a single building, one per
 *  building (capped) for several. Uses sendSms directly (NOT
 *  dispatchQuoteMessage) so a failure or a non-MMS number just means no
 *  photo — never a plain-SMS fallback. Never throws. */
export async function sendRoofPhotoMms(args: {
  supabase: SupabaseClient
  conversationId: string
  to: string
  from?: string
  baseUrl: string
  token: string
  quote: MultiRoofQuote
  max?: number
}): Promise<void> {
  const { supabase, conversationId, to, from, baseUrl, token, quote } = args
  try {
    const media = buildRoofPhotoMedia({ baseUrl, token, quote, max: args.max ?? 3 })
    for (const { mediaUrl, caption } of media) {
      try {
        const res = await sendSms({ to, from, text: caption, mediaUrl })
        if (!res.ok) {
          console.warn('[roofing-measure-dispatch] roof photo MMS not sent (non-fatal)', { code: res.code })
          continue
        }
        await supabase.from('sms_messages').insert({
          conversation_id: conversationId,
          direction: 'outbound',
          body: `[roof photo] ${caption}`,
        })
      } catch (e) {
        console.warn('[roofing-measure-dispatch] roof photo MMS threw (non-fatal)', e)
      }
    }
  } catch (e) {
    console.warn('[roofing-measure-dispatch] sendRoofPhotoMms failed (non-fatal)', e)
  }
}

export type RoofingMeasureDispatchResult =
  /** Measured + saved + messaged. Persist `state` against the conversation. */
  | { ok: true; state: RoofingConversationState; token: string; quote: MultiRoofQuote }
  /** Nothing sent — the caller falls back to its own unavailable path. */
  | { ok: false; reason: string; savedToken?: string }

export async function measureAndDispatchRoofing(args: {
  supabase: SupabaseClient
  tenantId: string | null
  /** tenants.trade — picks the pricing_book row the rate card sits on. */
  tenantTrade?: string | null
  conversationId: string
  /** Customer's mobile — the measurement row's customer_phone and MMS target. */
  customerPhone: string
  /** Sender for the photo MMS (the tenant's own number). */
  replyFrom?: string
  firstName: string | null
  baseUrl: string
  slots: RoofingSlots
  /** The brief itself forces a site visit (steep/unknown pitch, etc.) — the
   *  saved quote's routing is overridden and the message uses that path. */
  isInspection: boolean
  inspectionReason?: string
  /** Stable durable turn key; retrying the same job must reuse its saved token. */
  requestKey?: string
  /** Sends one SMS to the customer and persists it on the thread. */
  sendReply: (text: string) => Promise<unknown>
}): Promise<RoofingMeasureDispatchResult> {
  const reqInput = toRoofingRequest(args.slots)
  if (!reqInput) return { ok: false, reason: 'incomplete brief — nothing to measure' }
  if (!args.tenantId) return { ok: false, reason: 'tenant pricing setup required' }

  let savedToken: string | undefined
  try {
    const requestKey = args.requestKey ?? createHash('sha256').update(JSON.stringify([args.conversationId, reqInput])).digest('hex')
    const baseUrl = publicWebOrigin({ ...process.env, APP_URL: args.baseUrl })
    const { data: existing, error: lookupError } = await args.supabase.from('roofing_measurements')
      .select('id,public_token,quote').eq('tenant_id', args.tenantId)
      .eq('source_request_key', requestKey).maybeSingle()
    if (lookupError) return { ok: false, reason: 'saved roofing work unavailable; retry required' }
    let saved = existing as { id: string; public_token: string; quote: MultiRoofQuote } | null
    if (!saved) {
    const pricing = await loadTenantRoofingPricingContext(
      args.supabase,
      args.tenantId,
      args.tenantTrade ?? null,
    )
    if (!pricing) return { ok: false, reason: 'tenant roofing pricing setup required' }
    const result = await measureAndPriceRoofs(reqInput.address, reqInput.inputs, {
      rateCard: pricing.rateCard,
    })
    if (!result.ok) {
      console.error('[roofing-measure-dispatch] measure failed', {
        code: result.code,
        detail: result.detail,
        address: reqInput.address.address,
        postcode: reqInput.address.postcode,
        state: reqInput.address.state,
        tenantId: args.tenantId,
      })
      return { ok: false, reason: `measure failed: ${result.code}` }
    }

    const tokens = newMeasurementTokens()
    // The SMS caller always supplies the gate's own reason; the fallback
    // only guards a caller that flags an inspection without one (the field
    // is rendered on the page + message, so it can't be blank).
    const authorisedQuote = {
      ...result.quote,
      pricing_authority: pricing.authority,
    }
    const quote: MultiRoofQuote = args.isInspection
      ? {
          ...authorisedQuote,
          routing: {
            decision: 'inspection_required',
            reason: args.inspectionReason ?? 'this one needs a closer look on site',
          },
        }
      : authorisedQuote

    const { data: inserted, error: saveError } = await args.supabase.from('roofing_measurements').insert({
      tenant_id: args.tenantId,
      source_request_key: requestKey,
      released_at: null,
      address: reqInput.address.address,
      postcode: reqInput.address.postcode || null,
      state: reqInput.address.state,
      provider: result.provider,
      customer_phone: args.customerPhone,
      structure_count: quote.structures.length,
      combined_area_m2: quote.combined.area_m2,
      combined_better_inc_gst:
        applySolarToTiers(quote.combined.tiers, quote.solar ?? null)[1]?.inc_gst ?? null,
      routing: quote.routing.decision,
      structures: quote.structures,
      quote,
      ...tokens,
    }).select('id,public_token,quote').single()
    if (saveError?.code === '23505') {
      const retry = await args.supabase.from('roofing_measurements').select('id,public_token,quote')
        .eq('tenant_id', args.tenantId).eq('source_request_key', requestKey).single()
      if (retry.error || !retry.data) return { ok: false, reason: 'roofing save race needs retry' }
      saved = retry.data as { id: string; public_token: string; quote: MultiRoofQuote }
    } else {
      if (saveError || !inserted?.id || !inserted.public_token) return { ok: false, reason: 'roofing save failed; retry required' }
      saved = inserted as { id: string; public_token: string; quote: MultiRoofQuote }
    }
    }
    if (!saved?.id || !saved.public_token || !saved.quote) return { ok: false, reason: 'saved roofing result incomplete' }
    savedToken = saved.public_token
    await persistHumanHandoff({ supabase: args.supabase, tenantId: args.tenantId,
      customerPhone: args.customerPhone, conversationId: args.conversationId,
      requestKey: `roof:${saved.id}:review`, trade: 'roofing', reason: `Review saved roof draft at ${reqInput.address.address}`,
      resourceType: 'roof', resourceId: saved.id, baseUrl })
    const sent = await args.sendReply(`Your roofing details and draft are saved. ${args.isInspection ? 'An on-site inspection needs the roofer’s review.' : 'The roofer needs to review the draft before the quote can be shared.'}`)
    if (!sent || typeof sent !== 'object' || !('ok' in sent) || sent.ok !== true) {
      return { ok: false, reason: 'roofing saved; customer status send failed', savedToken }
    }
    return {
      ok: true,
      token: saved.public_token,
      quote: saved.quote,
      state: {
        slots: args.slots,
        last_step: 'closed',
        workflow_stage: 'awaiting_review',
        pending_quote_token: saved.public_token,
        pending_structure_count: saved.quote.structures.length,
      },
    }
  } catch (e) {
    console.error('[roofing-measure-dispatch] measure/save failed', e)
    return { ok: false, reason: e instanceof Error ? e.message : String(e), savedToken }
  }
}
