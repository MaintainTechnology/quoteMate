import { createHash } from 'node:crypto'

export type QuoteEditRow = Record<string, unknown> & {
  id: string
  tenant_id: string | null
  intake_id: string | null
  status: string | null
  paid_at: string | null
  needs_inspection: boolean | null
  selected_tier: string | null
  total_inc_gst: number | null
}

export const QUOTE_EDIT_FIELDS = [
  'id', 'tenant_id', 'intake_id', 'status', 'paid_at', 'needs_inspection',
  'selected_tier', 'total_inc_gst', 'good', 'better', 'best', 'report_doc',
  'report_style', 'stripe_links', 'risk_flags', 'quote_kind', 'deposit_pct',
  'applied_discount_pct',
  'pricing_book_version_id',
] as const

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]),
  )
  return value ?? null
}

export function quoteEditRevision(quote: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(
    QUOTE_EDIT_FIELDS.map((key) => [key, quote[key] ?? null]),
  )))).digest('hex')
}

export function validExpectedRevision(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
}

/** Legacy quotes have no stored book version or GST snapshot. A current book
 * cannot establish their historical tax basis. Resolve only an exact, unique
 * cent-precision match against the already persisted headline; otherwise the
 * quote needs review/migration before another financial mutation. */
export function storedQuoteGst(quote: {
  selected_tier?: unknown
  good?: unknown
  better?: unknown
  best?: unknown
  total_inc_gst?: unknown
}): boolean | null {
  if (quote.selected_tier != null && !['good', 'better', 'best'].includes(String(quote.selected_tier))) return null
  const key = quote.selected_tier === 'good' || quote.selected_tier === 'best'
    ? quote.selected_tier : 'better'
  const tier = quote[key] ?? quote.better ?? quote.best ?? quote.good
  const subtotal = tier && typeof tier === 'object'
    ? (tier as { subtotal_ex_gst?: unknown }).subtotal_ex_gst : null
  const total = quote.total_inc_gst
  if (typeof subtotal !== 'number' || !Number.isFinite(subtotal) || subtotal <= 0 ||
      typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
  const cents = Math.round(total * 100)
  // Refuse over-precision and unsafe integers rather than silently rounding
  // an inconsistent stored total into plausible tax evidence.
  if (!Number.isSafeInteger(cents) || Math.abs(total * 100 - cents) > 0.000001) return null
  const ex = Math.round(subtotal * 100)
  const inc = Math.round(Number((subtotal * 1.1).toFixed(2)) * 100)
  if (!Number.isSafeInteger(ex) || !Number.isSafeInteger(inc)) return null
  const withoutGst = cents === ex
  const withGst = cents === inc
  return withoutGst === withGst ? null : withGst
}

export function validOwnedQuoteBook(
  book: Record<string, unknown> | null,
  tenantId: string,
  trade: string,
): boolean {
  return !!book && typeof book.id === 'string' && !!book.id &&
    book.tenant_id === tenantId && book.trade === trade &&
    typeof book.gst_registered === 'boolean'
}

type LineProvenance = {
  original_line_index?: number
  description: string
  unit?: string
  quantity: number
  unit_price_ex_gst: number
  source?: string
  supplied_by?: 'tradie' | 'customer'
  safety_note?: string
}

/** Source/supplier/safety provenance is copied from a uniquely identified
 * stored line, never elevated from a caller's arbitrary catalogue claim.
 * An unidentifiable new line is explicitly a human-entered price. */
export function preserveLineProvenance<T extends LineProvenance>(
  line: T,
  stored: LineProvenance[],
  allowNewPriceSource = false,
): Pick<LineProvenance, 'source' | 'supplied_by' | 'safety_note' | 'original_line_index'> | null {
  if (line.original_line_index !== undefined &&
      (!Number.isSafeInteger(line.original_line_index) || line.original_line_index < 0 ||
       line.original_line_index >= stored.length)) return null
  let matches = line.original_line_index !== undefined ? [stored[line.original_line_index]] : line.source
    ? stored.filter((old) => old.source === line.source)
    : []
  if (matches.length !== 1) {
    matches = stored.filter((old) => old.description === line.description &&
      (!line.unit || old.unit === line.unit))
  }
  if (matches.length !== 1) {
    matches = stored.filter((old) => old.quantity === line.quantity &&
      old.unit_price_ex_gst === line.unit_price_ex_gst &&
      (!line.unit || old.unit === line.unit) && (!line.source || old.source === line.source))
  }
  const old = matches.length === 1 ? matches[0] : null
  if (!old) {
    const priceSource = allowNewPriceSource && line.source &&
      (/^(material|assembly):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line.source) ||
        ['material', 'assembly', 'labour', 'callout', 'after_hours'].includes(line.source))
    if (matches.length > 1 || (line.source && !priceSource && !['tradie_manual', 'tradie_edit'].includes(line.source)) ||
        line.supplied_by !== undefined || line.safety_note !== undefined) return null
    return { source: priceSource ? line.source : line.source === 'tradie_manual' ? 'tradie_manual' : 'tradie_edit' }
  }
  if ((line.source && line.source !== old.source) ||
      (line.supplied_by !== undefined && line.supplied_by !== old.supplied_by) ||
      (line.safety_note !== undefined && line.safety_note !== old.safety_note)) return null
  return {
    original_line_index: stored.indexOf(old),
    source: old.source || 'tradie_edit',
    ...(old.supplied_by !== undefined ? { supplied_by: old.supplied_by } : {}),
    ...(old.safety_note !== undefined ? { safety_note: old.safety_note } : {}),
  }
}
