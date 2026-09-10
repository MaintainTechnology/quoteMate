import type { SupabaseClient } from '@supabase/supabase-js'
import { publicWebOrigin } from './public-origin'

export const QUOTE_FAMILIES = ['generic', 'roof', 'paint', 'solar', 'plan', 'aircon', 'commercial-paint'] as const
export type QuoteFamily = typeof QUOTE_FAMILIES[number]
export type QuoteReference = {
  family: QuoteFamily
  id: string
  token: string
  label: string
  stage: 'awaiting_review' | 'ready' | 'inspection_required' | 'unavailable'
  createdAt: string
}

/** Tokens and ownership come from persisted records, never from transcript URLs. */
export function canonicalQuoteUrl(reference: QuoteReference, baseUrl = publicWebOrigin()): string {
  if (!QUOTE_FAMILIES.includes(reference.family) || !/^[A-Za-z0-9_-]{12,160}$/.test(reference.token)) {
    throw new Error('Invalid saved quote reference')
  }
  const origin = publicWebOrigin({ ...process.env, APP_URL: baseUrl })
  return `${origin}/q/${reference.family === 'generic' ? '' : `${reference.family}/`}${reference.token}`
}

export function isExistingQuoteRequest(text: string): boolean {
  return /\b(resend|re-send|send\b.{0,30}\bagain|where(?:'s| is|s)\b.{0,25}\bquote|quote\b.{0,35}\b(status|ready|link|arriv|sent)|(?:link|quote).{0,25}(?:again|404|not working|can.?t open|cannot open)|how much again)\b/i.test(text)
}

/** A single DB snapshot handles all quote families and normalises AU mobiles.
 * The service-only RPC enforces BOTH tenant and customer; errors are not absence.
 */
export async function lookupCustomerQuotes(args: {
  supabase: SupabaseClient; tenantId: string; customerPhone: string
}): Promise<QuoteReference[]> {
  if (!args.tenantId || !/^\+?[\d ()-]{8,24}$/.test(args.customerPhone)) throw new Error('Quote ownership is required')
  const { data, error } = await args.supabase.rpc('sms_customer_quote_references', {
    p_tenant_id: args.tenantId, p_customer_phone: args.customerPhone,
  })
  if (error || !Array.isArray(data)) throw new Error('Saved quote lookup unavailable')
  return data.flatMap((row: Record<string, unknown>) => {
    if (!QUOTE_FAMILIES.includes(row.family as QuoteFamily) || typeof row.resource_id !== 'string' ||
        typeof row.token !== 'string' || !/^[A-Za-z0-9_-]{12,160}$/.test(row.token)) return []
    return [{ family: row.family as QuoteFamily, id: row.resource_id, token: row.token,
      label: String(row.label || `${row.family} quote`).slice(0, 140),
      stage: ['ready', 'inspection_required', 'unavailable'].includes(String(row.stage))
        ? row.stage as QuoteReference['stage'] : 'awaiting_review' as const,
      createdAt: String(row.created_at || '') }]
  })
}

export async function handleExistingQuoteAction(args: {
  supabase: SupabaseClient; tenantId: string; customerPhone: string; text: string; baseUrl?: string
  preferredReference?: { family: string; id: string } | null
  /** IDs offered by a previous disambiguation turn. Revalidated against ownership. */
  selectionCandidates?: Array<{ family: string; id: string }> | null
}): Promise<{ handled: boolean; reply?: string; reference?: QuoteReference; candidates?: QuoteReference[] }> {
  const selection = args.selectionCandidates && /^\s*\d{1,2}\s*$/.test(args.text) ? Number(args.text.trim()) - 1 : -1
  if (!isExistingQuoteRequest(args.text) && selection < 0) return { handled: false }
  const found = await lookupCustomerQuotes(args)
  if (!found.length) return { handled: true, reply: 'I cannot find a saved quote linked to this number yet. What is the job address or the type of work? I can check the request without creating another quote.' }
  const chosen = selection >= 0 ? args.selectionCandidates?.[selection] : args.preferredReference
  const preferred = chosen ? found.find((q) => q.family === chosen.family && q.id === chosen.id) : undefined
  const explicit = found.filter((q) => q.label.length > 6 && args.text.toLowerCase().includes(q.label.toLowerCase()))
  const reference = preferred ?? (explicit.length === 1 ? explicit[0] : found.length === 1 ? found[0] : undefined)
  if (!reference) return { handled: true, candidates: found, reply: `Which job do you mean? Reply with its number:\n${found.map((q, i) => `${i + 1}. ${q.label}`).join('\n')}` }
  if (reference.stage === 'awaiting_review') return { handled: true, reference, reply: `Your ${reference.label} draft is saved and awaiting the tradie's review. It has not been released to you yet.` }
  if (reference.stage === 'unavailable') return { handled: true, reference, reply: `Your ${reference.label} request is saved, but its result needs attention before it can be shared.` }
  return { handled: true, reference, reply: `Here is your saved ${reference.label}${reference.stage === 'inspection_required' ? ' inspection information' : ' quote'}: ${canonicalQuoteUrl(reference, args.baseUrl)}` }
}

/** Only exact server-approved URLs may survive model output. A transcript is
 * deliberately not an authority: inbound links can belong to another customer.
 */
export function guardGeneratedQuoteLinks(reply: string, verifiedUrls: readonly string[] = []): string {
  const trusted = new Set(verifiedUrls)
  // Phones also auto-link bare hosts. Relative quote paths may be expanded by
  // clients, so neither spelling can bypass the saved-reference authority.
  const destinations = /(?:https?:\/\/|\/\/|www\.)[^\s<>()"'\]}`]+|(?<![\w@.])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:[/?#][^\s<>()"'\]}`]*)?|(?<!\w)\/(?:api\/)?(?:q|%71|p|m|r)\/[^\s<>()"'\]}`]+/gi
  return reply.replace(destinations, (raw) => {
    const trailing = raw.match(/[.,;:!?]+$/)?.[0] ?? ''
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw
    try { new URL(candidate) } catch { return '[saved link needs verification]' + trailing }
    // The model is not a URL authority. Restrict every generated destination,
    // including encoded paths and invented external quote hosts, to exact
    // server-provided links. Ordinary business links can be explicitly allowed.
    return trusted.has(candidate) ? candidate + trailing : '[saved link needs verification]' + trailing
  })
}
