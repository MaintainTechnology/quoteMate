import type { SupabaseClient } from '@supabase/supabase-js'
import { finiteQuoteNumber } from './numeric-input'
import { loadQuotePricingVersion, QuotePricingVersionError, versionedQuoteGst } from './pricing-version'
import { getReportAdapter } from './report-adapters/registry'

type Row = Record<string, unknown>
const review = () => new QuotePricingVersionError('quote_pricing_review_required')

/** Reports use the same saved tax evidence as priced edits. Today's rate card
 * is never evidence of the GST basis of an already priced quote. */
export async function loadQuoteReportPricing(db: SupabaseClient, quote: Row, intake: Row | null) {
  if (typeof quote.tenant_id !== 'string' || !quote.tenant_id ||
      typeof quote.intake_id !== 'string' || !intake || intake.id !== quote.intake_id ||
      intake.tenant_id !== quote.tenant_id || typeof intake.trade !== 'string' || !intake.trade.trim()) throw review()
  const trade = intake.trade.trim()
  if (!getReportAdapter(trade).capabilities.manualEdit) throw review()
  if (quote.quote_kind === 'final' && (typeof quote.deposit_pct !== 'number' ||
      !Number.isFinite(quote.deposit_pct) || quote.deposit_pct < 1 || quote.deposit_pct > 90)) throw review()
  let tierCount = 0
  for (const key of ['good', 'better', 'best']) {
    const value = quote[key]
    if (value == null) continue
    if (typeof value !== 'object' || Array.isArray(value)) throw review()
    const tier = value as Row
    const subtotal = finiteQuoteNumber(tier.subtotal_ex_gst)
    if (subtotal === null || subtotal < 0) throw review()
    if (tier.line_items != null && !Array.isArray(tier.line_items)) throw review()
    for (const value of (tier.line_items ?? []) as unknown[]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw review()
      const line = value as Row
      for (const field of ['quantity', 'unit_price_ex_gst', 'total_ex_gst']) {
        const amount = finiteQuoteNumber(line[field])
        if (amount === null || amount < 0) throw review()
      }
    }
    tierCount++
  }
  if (!tierCount) throw review()
  const pricingVersion = await loadQuotePricingVersion(db, quote, trade)
  const gstRegistered = versionedQuoteGst(quote, pricingVersion)
  if (gstRegistered === null) throw review()
  return { trade, gstRegistered, pricingVersion }
}
