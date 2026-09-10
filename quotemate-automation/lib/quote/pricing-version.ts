import type { SupabaseClient } from '@supabase/supabase-js'
import { storedQuoteGst, validOwnedQuoteBook } from './edit-authority'

type Row = Record<string, unknown>
export type QuotePricingVersion = {
  id: string; tenant_id: string; trade: string; pricing_book_id: string;
  snapshot: Row; content_hash: string;
}
export class QuotePricingVersionError extends Error {
  constructor(public readonly code: 'quote_review_required' | 'quote_pricing_review_required' | 'pricing_revision_changed' | 'pricing_unavailable',
    public readonly status: 409 | 503 = 409) { super(code); this.name = 'QuotePricingVersionError' }
}
function version(value: unknown, tenantId: string, trade: string): QuotePricingVersion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Row
  const snapshot = row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot) ? row.snapshot as Row : null
  return typeof row.id === 'string' && row.tenant_id === tenantId && row.trade === trade &&
    typeof row.content_hash === 'string' && /^[a-f0-9]{64}$/.test(row.content_hash) &&
    snapshot && row.pricing_book_id === snapshot.id && validOwnedQuoteBook(snapshot, tenantId, trade)
    ? row as QuotePricingVersion : null
}
export async function captureQuotePricingVersion(db: SupabaseClient, book: Row, tenantId: string, trade: string) {
  if (!validOwnedQuoteBook(book, tenantId, trade)) throw new QuotePricingVersionError('quote_pricing_review_required')
  const { data, error } = await db.rpc('capture_quote_pricing_version', {
    p_tenant_id: tenantId, p_trade: trade, p_book_id: book.id, p_expected_book: book,
  })
  if (error) {
    if (String(error.message).includes('pricing revision changed')) throw new QuotePricingVersionError('pricing_revision_changed')
    throw new QuotePricingVersionError('pricing_unavailable', 503)
  }
  const saved = version(data, tenantId, trade)
  if (!saved) throw new QuotePricingVersionError('pricing_unavailable', 503)
  return saved
}
export async function loadQuotePricingVersion(db: SupabaseClient, quote: Row, trade: string) {
  if (quote.pricing_book_version_id == null) return null
  if (typeof quote.pricing_book_version_id !== 'string' || typeof quote.tenant_id !== 'string') {
    throw new QuotePricingVersionError('quote_pricing_review_required')
  }
  const { data, error } = await db.from('quote_pricing_versions').select('*')
    .eq('id', quote.pricing_book_version_id).eq('tenant_id', quote.tenant_id).eq('trade', trade).maybeSingle()
  if (error) throw new QuotePricingVersionError('pricing_unavailable', 503)
  const saved = version(data, quote.tenant_id, trade)
  if (!saved || saved.id !== quote.pricing_book_version_id) throw new QuotePricingVersionError('quote_pricing_review_required')
  return saved
}
export function versionedQuoteGst(quote: Row, saved: QuotePricingVersion | null): boolean | null {
  if (!saved) return storedQuoteGst(quote)
  const gst = saved.snapshot.gst_registered as boolean
  const historic = storedQuoteGst(quote)
  if (historic !== null) return historic === gst ? gst : null
  // A new final child can intentionally start at $0. Its explicit captured
  // book establishes tax without pretending zero totals prove a GST basis.
  const key = quote.selected_tier
  const tier = typeof key === 'string' ? quote[key] : null
  return quote.total_inc_gst === 0 && tier && typeof tier === 'object' &&
    (tier as Row).subtotal_ex_gst === 0 ? gst : null
}

/** Checkpoint the pricing version together with the estimator result. A resumed
 * worker must use the captured book even if today's book changed/disappeared.
 * Old checkpoints without this explicit binding require review, never a fresh
 * version retroactively assigned to an already computed price. */
export async function versionedEstimationCheckpoint<T extends object>(db: SupabaseClient, args: {
  tenantId: string | null; trade: string; book: Row | null;
  checkpoint: <R>(name: string, operation: () => Promise<R>) => Promise<R>;
  run: () => Promise<T>;
}) {
  type Bound = T & { pricing_context_version: 1; pricing_book_version_id: string | null }
  const result = await args.checkpoint<Bound>('estimation', async () => {
    const captured = args.book && args.tenantId
      ? await captureQuotePricingVersion(db, args.book, args.tenantId, args.trade) : null
    return { ...await args.run(), pricing_context_version: 1, pricing_book_version_id: captured?.id ?? null }
  })
  if (!result || result.pricing_context_version !== 1 ||
      (result.pricing_book_version_id !== null && typeof result.pricing_book_version_id !== 'string')) {
    throw new QuotePricingVersionError('quote_pricing_review_required')
  }
  const captured = result.pricing_book_version_id === null ? null : await loadQuotePricingVersion(db,
    { tenant_id: args.tenantId, pricing_book_version_id: result.pricing_book_version_id }, args.trade)
  return { estimation: result as T, pricingVersion: captured }
}
