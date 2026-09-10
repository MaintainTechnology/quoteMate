import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OutboundOptions } from '@/lib/sms/durable-outbox'

export function genericQuoteReleased(quote: Record<string, unknown>): boolean {
  return !!quote.customer_released_at || !!quote.paid_at || !!quote.sent_at ||
    ['sent', 'accepted', 'paid'].includes(String(quote.status))
}

/** Stable across approve/send entry points and retries; only deliberate resends get a new ID. */
export function genericQuoteSendKey(quoteId: string, requestId?: unknown): string {
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))) {
    throw new Error('invalid_request_id')
  }
  // PostgreSQL UUID identity is case-insensitive. The route parameter, returned
  // row and recovery query must select the same durable intent for that ID.
  return `quote-release:generic:${quoteId.toLowerCase()}:${requestId ? `resend:${(requestId as string).toLowerCase()}` : 'initial'}`
}

const SNAPSHOT_FIELDS = ['share_token','intake_id','good','better','best','total_inc_gst','selected_tier',
  'scope_of_works','assumptions','estimated_timeframe','needs_inspection','inspection_reason','deposit_pct',
  'display_mode','applied_discount_pct','quote_kind','parent_quote_id','pricing_book_version_id','report_doc','report_style'] as const

function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical)
  if(value && typeof value === 'object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,canonical(entry)]))
  return value ?? null
}
/** The complete saved content checked atomically by migration215 before release. */
export function quoteCustomerReleaseSnapshot(quote:Record<string,unknown>):Record<string,unknown> {
  return Object.fromEntries(SNAPSHOT_FIELDS.map(key => [key, quote[key] ?? null]))
}
export function quoteCustomerReleaseRevision(quote:Record<string,unknown>):string {
  return createHash('sha256').update(JSON.stringify(canonical(quoteCustomerReleaseSnapshot(quote)))).digest('hex')
}
export function quoteReleaseReviewMatches(quote:Record<string,unknown>,expected:unknown):boolean {
  if(expected === undefined && genericQuoteReleased(quote))return true
  return typeof expected === 'string' && expected === quoteCustomerReleaseRevision(quote)
}

export async function persistGenericQuoteRelease(db: SupabaseClient, input: {
  quote: Record<string, unknown>; tenantId: string; ownerId: string; holdUntil: string | null
  outbound?: OutboundOptions
  signMediaUrl?: (path: string) => Promise<string>
}): Promise<{ outbound: OutboundOptions | null; outboxId: string | null }> {
  const snapshot = quoteCustomerReleaseSnapshot(input.quote)
  const outbound = input.outbound ? { ...input.outbound, quoteReleaseId: input.quote.id,
    quoteReleaseRevision: quoteCustomerReleaseRevision(input.quote), quoteReleaseSnapshot: snapshot } : null
  if (outbound && process.env.SMS_QUOTE_PDF_MMS === '1' && typeof outbound.mediaKey === 'string' && input.signMediaUrl) {
    try { outbound.mediaUrl = await input.signMediaUrl(outbound.mediaKey) } catch { /* Body retains the stable PDF link. */ }
  }
  const hash = outbound ? createHash('sha256').update(JSON.stringify([
    outbound.tenantId ?? null, outbound.to, outbound.from ?? null, outbound.text,
    outbound.mediaKey ?? null, outbound.audience ?? 'customer',
  ])).digest('hex') : null
  const { data, error } = await db.rpc('approve_generic_quote_release', {
    p_quote_id: input.quote.id, p_tenant_id: input.tenantId, p_owner_id: input.ownerId,
    p_snapshot: snapshot,
    p_hold_until: input.holdUntil, p_outbound: outbound, p_hash: hash,
  })
  if (error || !data?.approved) throw new Error('Could not save approval and customer delivery. Refresh the quote before retrying.')
  return { outbound: data.outbound ?? null, outboxId: data.outbox_id ?? null }
}
