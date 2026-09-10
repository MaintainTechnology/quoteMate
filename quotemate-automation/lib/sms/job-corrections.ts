import type { SupabaseClient } from '@supabase/supabase-js'
import { currentSmsWork, smsWorkCheckpoint } from './durable-work'
import { persistHumanHandoff } from './human-handoff'
import { dispatchQuoteMessage } from './dispatch'
import { publicWebUrl } from './public-origin'
import { handleExistingQuoteAction, isExistingQuoteRequest, lookupCustomerQuotes, type QuoteReference } from './quote-actions'

/** Deliberate job changes, not profile updates, price questions or new enquiries.
 * This conservative gate does not infer new prices or rewrite a saved brief.
 */
export function isExplicitJobCorrection(text: string): boolean {
  if (/\b(?:new|another|separate|second)\s+(?:job|quote|property|project)\b|\bquote\b.{0,24}\b(?:another|different)\s+(?:property|address)\b/i.test(text)) return false
  if (/\b(?:how much|what\b.{0,16}\bcost|would\b.{0,35}\bcost|does\b.{0,35}\binclude)\b/i.test(text) && !/\b(?:actually|correction|change|instead|make it)\b/i.test(text)) return false
  if (/^(?:the\s+|my\s+|our\s+)?address\s*(?::|is|should be)\s*\d+\b|^(?:the\s+)?postcode\s*(?::|is|should be)\s*\d{4}\b|^(?:it|the (?:property|house|supply))\s+(?:is|has)\s+(?:single|three|1|3)[-\s]*phase\b/i.test(text.trim()) && !text.includes('?')) return true
  const change = /\b(?:actually|correction|correct (?:the|my|our)|change|changed|update|instead|rather than|make (?:it|that)|include|add|remove|exclude|also|not|no)\b/i.test(text)
  const job = /\b(?:address|suburb|postcode|scope|quantity|count|phase|panels?|battery|batteries|system|roof|roofing|gutters?|colorbond|tiles?|material|pitch|storeys?|stories|paint|painting|walls?|ceilings?|coats?|doors?|garage|rooms?|fence|downlights?|lights?|fans?|power\s*points?|sockets?|outlets?|taps?|toilets?|pipes?|drains?|chargers?|switchboard|circuit|units?|metres?|meters?|sqm|kw)\b|\b\d+\s+[\w '-]+\s(?:st(?:reet)?|r(?:oa)?d|avenue|ave|lane|drive|crescent)\b/i.test(text)
  return change && job
}

type Row = Record<string, unknown>
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const phone = (value: unknown): string => {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : ''
  return /^0\d{9}$/.test(digits) ? `61${digits.slice(1)}` : digits
}
export type PendingJobCorrection = { receiptId: string; text: string; candidates: QuoteReference[] }
type CorrectionPlan = { handled: false } | {
  handled: true; reference?: QuoteReference; candidates?: QuoteReference[]; reply: string; trade: string
  pending?: PendingJobCorrection; selection?: { receiptId: string; text: string; ownerPhone: string | null }
  selectionUnresolved?: boolean
}

/** Once a draft has consumed inputs, a customer correction is an owner task.
 * Prices, release flags and existing tokens remain immutable. The chosen reply
 * is checkpointed before task/transport effects so replay cannot change an
 * already accepted intent when an owner releases the quote between attempts.
 */
export async function handleSavedJobCorrection(args: {
  supabase: SupabaseClient; tenantId: string; customerPhone: string; fromNumber: string
  conversationId: string; receiptId: string; text: string; trade: string; pending?: PendingJobCorrection | null
}): Promise<CorrectionPlan> {
  const selecting = !!args.pending && (/^\s*\d{1,2}\s*$/.test(args.text) || args.pending.candidates.some(candidate =>
    candidate.label.length > 6 && args.text.toLowerCase().includes(candidate.label.toLowerCase())))
  const hasSavedPlan = Object.hasOwn(currentSmsWork()?.job.checkpoint ?? {}, 'saved_job_correction')
  if (!isExplicitJobCorrection(args.text) && !selecting && !hasSavedPlan) return { handled: false }
  if (!args.receiptId.trim()) throw new Error('A durable correction receipt is required')
  const plan = await smsWorkCheckpoint<CorrectionPlan>('saved_job_correction', async () => {
    const saved = await args.supabase.from('sms_conversations')
      .select('id,tenant_id,from_number,to_number,status,intake_id,quote_id,quote_stage,conversation_state,roofing_state,painting_state')
      .eq('id', args.conversationId).eq('tenant_id', args.tenantId).maybeSingle()
    if (saved.error || !saved.data || saved.data.id !== args.conversationId || saved.data.tenant_id !== args.tenantId ||
      !phone(args.customerPhone) || phone(saved.data.from_number) !== phone(args.customerPhone) ||
      !phone(args.fromNumber) || phone(saved.data.to_number) !== phone(args.fromNumber)) {
      throw new Error('Correction conversation ownership could not be verified')
    }
    const conversation = saved.data
    const state = row(conversation.conversation_state)
    const roof = row(conversation.roofing_state), paint = row(conversation.painting_state), solar = row(state.solar)
    // The durable intake row is authoritative even before intake_id linkback.
    // Pending/running work already owns this input snapshot; do not race it.
    const work = await args.supabase.from('sms_work_jobs').select('id,checkpoint')
      .eq('tenant_id', args.tenantId).eq('kind', 'intake').eq('serial_key', `intake:sms:${args.conversationId}`).limit(1)
    if (work.error || !Array.isArray(work.data)) throw new Error('Correction draft progress is unavailable')
    const consumed = conversation.status === 'structuring' || !!conversation.intake_id || !!conversation.quote_id ||
      !!roof.pending_quote_token || !!paint.pending_quote_token || !!row(solar.reference).id ||
      !!row(state.quote_reference).id || work.data.length > 0
    const gathering = !!row(state.slots).job_type && row(state.slots).job_type !== 'unknown' ||
      [roof, paint].some(specialist => specialist.last_step && !['closed', 'quoted'].includes(String(specialist.last_step))) ||
      !!solar.step && !solar.reference
    if (!consumed && gathering && !selecting) return { handled: false }
    const found = await lookupCustomerQuotes(args)
    if (!consumed && !found.length && !selecting) return { handled: false }
    const identities = [row(state.quote_reference), row(solar.reference),
      ...(conversation.quote_id ? [{ family: 'generic', id: conversation.quote_id }] : [])]
    const exact = found.filter(reference => identities.some(identity => identity.family === reference.family && identity.id === reference.id) ||
      reference.family === 'roof' && reference.token === roof.pending_quote_token ||
      reference.family === 'paint' && reference.token === paint.pending_quote_token)
    // A replacement address is not the job being corrected. Only a known
    // current identity, or one owned result on a fresh idle conversation, may
    // resolve the target before an explicit clarification question.
    let reference = exact.length === 1 ? exact[0] : !consumed && found.length === 1 ? found[0] : undefined
    if (selecting) {
      const offered = args.pending!.candidates
      const index = /^\s*\d{1,2}\s*$/.test(args.text) ? Number(args.text.trim()) - 1 : -1
      const chosen = index >= 0 ? offered[index] : offered.find(candidate => candidate.label.length > 6 && args.text.toLowerCase().includes(candidate.label.toLowerCase()))
      reference = chosen ? found.find(candidate => candidate.family === chosen.family && candidate.id === chosen.id) : undefined
      if (!reference) return { handled: true, trade: args.trade, selectionUnresolved: true, pending: args.pending!,
        candidates: offered, reply: 'I could not confirm that job selection. Please reply with one of the saved job numbers or its address. Your requested change remains saved for review; no quote has been changed.\n' + offered.map((item, index) => `${index + 1}. ${item.label}`).join('\n') }
    }
    const ambiguous = found.length > 1 && !reference
    let reply = ambiguous
      ? 'Your requested change is saved for tradie review. Which job does it apply to? No saved quote has been changed.\n' + found.map((item, index) => `${index + 1}. ${item.label}`).join('\n')
      : 'Your requested change is saved for tradie review. It has not been applied to the existing job or quote.'
    if (isExistingQuoteRequest(args.text) && reference) {
      const action = await handleExistingQuoteAction({ ...args, preferredReference: reference ?? null })
      if (action.reply) reply += `\n\n${action.reply}`
    } else if (isExistingQuoteRequest(args.text) && !ambiguous) {
      reply += '\n\nI cannot confirm a saved quote to resend for this request yet. Please tell me which job you mean.'
    }
    const owner = selecting ? await args.supabase.from('tenants').select('owner_mobile').eq('id', args.tenantId).single() : null
    if (owner?.error) throw new Error('Correction owner notification lookup is unavailable')
    const trade = reference && reference.family !== 'generic'
      ? ({ roof: 'roofing', paint: 'painting', solar: 'solar', plan: 'plan estimation', aircon: 'air conditioning', 'commercial-paint': 'commercial painting' } as const)[reference.family]
      : args.trade
    return { handled: true, reply, trade,
      ...(reference ? { reference } : {}), ...(ambiguous ? { candidates: found, pending: { receiptId: args.receiptId, text: args.text, candidates: found } } : {}),
      ...(selecting ? { selection: { receiptId: args.pending!.receiptId, text: args.pending!.text,
        ownerPhone: typeof owner?.data?.owner_mobile === 'string' ? owner.data.owner_mobile : null } } : {}) }
  })
  if (!plan.handled) return plan
  if (plan.selectionUnresolved) return plan
  if (plan.selection && plan.reference) {
    const original = await args.supabase.from('sms_human_tasks').select('id,status,reason,resource_type,resource_id')
      .eq('tenant_id', args.tenantId).eq('request_key', `sms-correction:${plan.selection.receiptId}`)
      .eq('conversation_id', args.conversationId).eq('customer_phone', args.customerPhone).single()
    if (original.error || !original.data?.id) throw new Error('Original correction task could not be confirmed')
    const reason = `Customer requested a job correction. Existing job and quote are unchanged.\nCustomer request (verbatim):\n${plan.selection.text}\nCustomer job clarification (verbatim):\n${args.text}`
    const updated = await args.supabase.from('sms_human_tasks').update({ resource_type: plan.reference.family,
      resource_id: plan.reference.id, reason }).eq('tenant_id', args.tenantId).eq('id', original.data.id).select('id').single()
    if (updated.error || updated.data?.id !== original.data.id) throw new Error('Correction job selection could not be saved')
    const sent = plan.selection.ownerPhone ? await dispatchQuoteMessage({ to: plan.selection.ownerPhone, from: args.fromNumber,
      tenantId: args.tenantId, audience: 'tradie', deliveryKey: `human-task:${original.data.id}:job-selection:${args.receiptId}`,
      text: `The customer identified the job for their saved correction: ${plan.reference.label}. Requested change: ${plan.selection.text.slice(0, 220)}. The quote is unchanged. Review at ${publicWebUrl('/dashboard/sms-recovery')}` }) : null
    const notified = await args.supabase.from('sms_human_tasks').update({
      notification_error: sent?.ok ? null : 'Correction job selection notification needs attention',
      ...(original.data.status === 'resolved' ? {} : { status: sent?.ok ? 'notified' : 'open' }),
    }).eq('tenant_id', args.tenantId).eq('id', original.data.id).eq('status', original.data.status).select('id').maybeSingle()
    if (notified.error) throw new Error('Correction selection notification state could not be saved')
    if (notified.data?.id !== original.data.id) {
      const latest = await args.supabase.from('sms_human_tasks').select('id,status')
        .eq('tenant_id', args.tenantId).eq('id', original.data.id).single()
      if (latest.error || latest.data?.id !== original.data.id || latest.data.status !== 'resolved') throw new Error('Correction task changed during job selection; retry required')
    }
    return plan
  }
  await persistHumanHandoff({ ...args, trade: plan.trade,
    requestKey: `sms-correction:${args.receiptId}`, resourceType: plan.reference?.family, resourceId: plan.reference?.id,
    reason: `Customer requested a job correction. Existing job and quote are unchanged.${plan.candidates ? ' Confirm which saved job this applies to.' : ''}\nCustomer request (verbatim):\n${args.text}` })
  return plan
}
