import type { SupabaseClient } from '@supabase/supabase-js'
import { parseAuState, parsePostcode, extractStreetAddress, isAffirmative, rejectsReadBack } from './roofing-intake'
import { runSolarEstimate } from '@/lib/solar/intake'
import { loadSolarConfig } from '@/lib/solar/config'
import { loadSolarTenantRates } from '@/lib/solar/rate-card-overlay'
import { hasCompleteSolarRateOverlay } from '@/lib/solar/complete-rate-card'
import { buildSolarRowPayloads } from '@/lib/solar/persist-helpers'
import { geocodeAddress } from '@/lib/solar/geocode'
import { resolveNetworkFromPostcode } from '@/lib/solar/network-lookup'
import { persistHumanHandoff } from './human-handoff'
import type { QuoteReference } from './quote-actions'
import type { SolarEstimateRequestBody } from '@/lib/solar/request-schema'
import { MAX_REQUESTED_SYSTEM_KW } from '@/lib/solar/limits'
import { currentSmsWork } from './durable-work'

export type SolarSmsState = {
  address?: SolarEstimateRequestBody['address']
  confirmed?: boolean
  phase?: 'single' | 'three' | 'unknown'
  panelType?: 'standard_panels' | 'premium_panels'
  requestedSizeKw?: number
  sizeClarificationRequired?: boolean
  step?: 'address' | 'confirm_address' | 'phase' | 'panels' | 'system_size' | 'estimate' | 'awaiting_review' | 'unavailable'
  reference?: QuoteReference
}

const NEGATED_SOLAR_FACT = String.raw`\b(?:not|no|(?:is|are|do|does|have|has)(?:n[’']?t| not))\s+(?:(?:have|a|an|on|want|use|using|need|prefer)\s+){0,3}`

/** A small deterministic intake uses the SAME contract and deterministic
 * estimator as the solar form. Prices never come from a language model.
 */
export function solarSmsNext(text: string, previous: SolarSmsState = {}): {
  state: SolarSmsState; reply?: string; ready: boolean
} {
  const state = { ...previous }
  if (state.reference) return { state, ready: false, reply: 'Your solar draft is saved and awaiting the installer’s review. Ask for the quote link to check its current release status.' }

  // Capture explicit facts before selecting the next question: a panel answer
  // can also correct supply phase, even while address confirmation is pending.
  const phaseText = text.replace(/\b(single|one|1|three|3)\s*(?:or|and|\/)\s*(single|one|1|three|3)[\s-]*phase\b/gi, '$1 phase $2 phase')
  const shortPhase = previous.step === 'phase' ? text.trim().match(/^(single|one|1|three|3)[.!?]*$/i)?.[1].toLowerCase() : undefined
  const three = /\b(?:three|3)[\s-]*phase\b/i.test(phaseText) || shortPhase === 'three' || shortPhase === '3'
  const single = /\b(?:single|one|1)[\s-]*phase\b/i.test(phaseText) || ['single','one','1'].includes(shortPhase ?? '')
  const uncertainPhase = (previous.step === 'phase' || /\bphase\b/i.test(text)) && /\b(?:unknown|not sure|don[’']?t know|unsure)\b/i.test(text)
  const conflictingShortPhase = previous.step === 'phase' && /^(?:single|one|1|three|3)\s*(?:or|and|\/)\s*(?:single|one|1|three|3)[.!?]*$/i.test(text.trim())
  const negatedPhase = new RegExp(`${NEGATED_SOLAR_FACT}(?:single|one|1|three|3)[\\s-]*phase\\b`, 'i').test(text)
  if ((three && single) || conflictingShortPhase || ((three || single) && (uncertainPhase || negatedPhase))) delete state.phase
  else if (three) state.phase = 'three'
  else if (single) state.phase = 'single'
  else if (uncertainPhase) state.phase = 'unknown'

  const premium = /\bpremium[\s-]+(?:solar[\s-]+)?panels?\b/i.test(text) || (previous.step === 'panels' && /^\s*premium[.!?]*\s*$/i.test(text))
  const standard = /\bstandard[\s-]+(?:solar[\s-]+)?panels?\b/i.test(text) || (previous.step === 'panels' && /^\s*standard[.!?]*\s*$/i.test(text))
  const negatedPanels = new RegExp(`${NEGATED_SOLAR_FACT}(?:premium|standard)[\\s-]+(?:solar[\\s-]+)?panels?\\b`, 'i').test(text)
  if ((premium && standard) || negatedPanels) delete state.panelType
  else if (premium) state.panelType = 'premium_panels'
  else if (standard) state.panelType = 'standard_panels'

  const sizes = [...text.matchAll(/(?<![\w.])([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*kW\b/gi)].map(match => Number(match[1]))
  if (sizes.length) {
    const negatedSize = new RegExp(`${NEGATED_SOLAR_FACT}[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)\\s*kW\\b`, 'i').test(text)
    const sizeRange = /\d+(?:\.\d+)?\s*(?:[-–—]|to|or)\s*\d+(?:\.\d+)?\s*kW\b/i.test(text)
    if (new Set(sizes).size !== 1 || sizeRange || negatedSize || sizes.some(size => !Number.isFinite(size) || size <= 0 || size > MAX_REQUESTED_SYSTEM_KW)) {
      delete state.requestedSizeKw
      state.sizeClarificationRequired = true
    } else {
      state.requestedSizeKw = sizes[0]
      delete state.sizeClarificationRequired
    }
  }

  // The shared street helper accepts number+words; supply ratings and a bare
  // postcode/state answer are solar facts, not a replacement street address.
  const addressText = text.replace(/\b\d+[\s-]*phase\b/gi, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:[-–—]|to|or)\s*\d+(?:\.\d+)?\s*kWh?\b/gi, '')
    .replace(/(?<![\w.])[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*kWh?\b/gi, '')
  const candidate = extractStreetAddress(addressText)
  const street = candidate && !/^\d{4}\s+(?:NSW|VIC|QLD|SA|WA|TAS|ACT|NT)[\s.,!?]*$/i.test(candidate) ? candidate : null
  const postcode = parsePostcode(addressText), region = parseAuState(addressText)
  if (street) {
    state.address = { address: street, postcode: postcode ?? state.address?.postcode ?? '', state: region ?? state.address?.state ?? 'NSW' }
    // An unknown state is asked for, never priced using an assumed NSW zone.
    if (!region && !previous.address?.state) state.address.state = '' as SolarEstimateRequestBody['address']['state']
  } else if (state.address) {
    state.address = { ...state.address, postcode: postcode ?? state.address.postcode, state: region ?? state.address.state }
  }
  const addressChanged = state.address?.address !== previous.address?.address || state.address?.postcode !== previous.address?.postcode || state.address?.state !== previous.address?.state
  if (addressChanged || (previous.step === 'confirm_address' && rejectsReadBack(text))) state.confirmed = false
  if (!state.address?.address || !state.address.postcode || !state.address.state) {
    state.step = 'address'
    return { state, ready: false, reply: 'What is the solar installation address, including suburb, state and postcode?' }
  }
  if (!state.confirmed) {
    if (previous.step === 'confirm_address' && !addressChanged && isAffirmative(text) && !rejectsReadBack(text)) state.confirmed = true
    else { state.step = 'confirm_address'; return { state, ready: false, reply: `Please confirm the solar installation address: ${state.address.address}, ${state.address.state} ${state.address.postcode}. Is that correct?` } }
  }
  if (state.sizeClarificationRequired) {
    state.step = 'system_size'
    return { state, ready: false, reply: `What solar system size would you like assessed? Please give one size above 0 and up to ${MAX_REQUESTED_SYSTEM_KW} kW, for example 10 kW.` }
  }
  if (!state.phase) { state.step = 'phase'; return { state, ready: false, reply: 'Does the property have single-phase or three-phase electricity? It is fine to reply “not sure”.' } }
  if (!state.panelType) { state.step = 'panels'; return { state, ready: false, reply: 'Would you like standard or premium panels assessed? The installer will review the proposed system before releasing a quote.' } }
  state.step = 'estimate'
  return { state, ready: true }
}

export async function saveSolarSmsEstimate(args: {
  supabase: SupabaseClient; tenantId: string; customerPhone: string; requestKey: string
  state: SolarSmsState; workId?: string; workOwner?: string
}): Promise<QuoteReference> {
  const { data: existing, error: readError } = await args.supabase.from('solar_estimates')
    .select('id,public_token,address,created_at').eq('tenant_id', args.tenantId).eq('source_request_key', args.requestKey).maybeSingle()
  if (readError) throw new Error('Solar saved-work lookup unavailable')
  const reference = (saved: Record<string, unknown>): QuoteReference => ({ family: 'solar', id: String(saved.id),
    token: String(saved.public_token), label: String(saved.address), createdAt: String(saved.created_at), stage: 'awaiting_review' })
  if (existing?.id && existing.public_token) return reference(existing)
  if (!args.state.address || !args.state.confirmed || !args.state.phase || !args.state.panelType || args.state.sizeClarificationRequired ||
    (args.state.requestedSizeKw !== undefined && (!Number.isFinite(args.state.requestedSizeKw) || args.state.requestedSizeKw <= 0 || args.state.requestedSizeKw > MAX_REQUESTED_SYSTEM_KW))) throw new Error('Solar brief incomplete')
  const base = await loadSolarConfig(args.supabase)
  const { config, rateCard, overlay } = await loadSolarTenantRates(args.supabase, args.tenantId, base)
  if (!hasCompleteSolarRateOverlay(overlay)) {
    throw new Error('The installer needs to complete the solar pricing setup')
  }
  const estimate = await runSolarEstimate({ input: args.state.address, panelType: args.state.panelType,
    phase: args.state.phase, requestedSizeKw: args.state.requestedSizeKw, config, rateCard,
    opts: { network: resolveNetworkFromPostcode(args.state.address.postcode), geocode: async (address) => {
      const result = await geocodeAddress(`${address.address}, ${address.state} ${address.postcode}`,
        { apiKey: process.env.GOOGLE_GEOCODE_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY })
      if (!result.ok) throw new Error('Solar address lookup unavailable')
      return result.location
    } } })
  const payloads = buildSolarRowPayloads({ estimate, tenantId: args.tenantId,
    address: args.state.address, customer: { phone: args.customerPhone }, depositPct: overlay.deposit_pct })
  const { data: saved, error } = await args.supabase.rpc('sms_save_solar_estimate', {
    p_tenant_id: args.tenantId, p_request_key: args.requestKey, p_customer_phone: args.customerPhone,
    p_intake: payloads.intake, p_solar: payloads.solarEstimate, p_quote: payloads.quote,
    p_work_id: args.workId ?? currentSmsWork()?.jobId ?? null,
    p_work_owner: args.workOwner ?? currentSmsWork()?.ownerToken ?? null,
  })
  if (error || !saved?.id || !saved.public_token) throw new Error('Solar draft could not be saved; retry required')
  return reference(saved)
}

export async function handleSolarSmsTurn(args: {
  supabase: SupabaseClient; tenantId: string; customerPhone: string; conversationId: string
  text: string; state?: SolarSmsState; requestKey: string; baseUrl: string
  workId?: string; workOwner?: string
  sendReply: (text: string) => Promise<{ ok: boolean }>
}): Promise<{ handled: true; state: SolarSmsState; stage: string; reference?: QuoteReference }> {
  const next = solarSmsNext(args.text, args.state)
  if (!next.ready) {
    const sent = await args.sendReply(next.reply!)
    if (!sent.ok) throw new Error('Solar reply send failed')
    return { handled: true, state: next.state, stage: next.state.step ?? 'address', reference: next.state.reference }
  }
  let reference: QuoteReference
  try { reference = await saveSolarSmsEstimate({ ...args, state: next.state }) }
  catch (error) {
    await persistHumanHandoff({ ...args, trade: 'solar', requestKey: `${args.requestKey}:solar-recovery`,
      reason: error instanceof Error ? error.message : 'Solar estimate unavailable' })
    const sent = await args.sendReply('Your solar details are saved for installer review because the estimate could not be completed. No quote has been sent. You can reply here to check the request.')
    if (!sent.ok) throw new Error('Solar recovery status send failed')
    return { handled: true, state: { ...next.state, step: 'unavailable' }, stage: 'unavailable' }
  }
  await persistHumanHandoff({ ...args, trade: 'solar', requestKey: `solar:${reference.id}:review`,
    reason: `Review saved solar draft at ${reference.label}`, resourceType: 'solar', resourceId: reference.id })
  const sent = await args.sendReply('Your solar draft is saved and awaiting the installer’s review. A quote link can be shared once they approve it.')
  if (!sent.ok) throw new Error('Solar saved; customer status send failed')
  return { handled: true, state: { ...next.state, step: 'awaiting_review', reference }, stage: 'awaiting_review', reference }
}
