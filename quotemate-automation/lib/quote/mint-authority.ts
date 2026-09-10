import type { SupabaseClient } from '@supabase/supabase-js'
import { QUOTE_EDIT_FIELDS } from './edit-authority'
import { getStripe } from '@/lib/stripe/client'

export const MINT_QUOTE_FIELDS = [...new Set([...QUOTE_EDIT_FIELDS,
  'share_token', 'parent_quote_id', 'scheduled_at', 'created_at', 'price_hold_until',
  'applied_discount_at', 'early_bird_discount_pct', 'early_bird_expires_at',
  'customer_released_at', 'sent_at', 'paid_tier',
])]
export type MintQuote = Record<string, unknown> & { id: string; tenant_id: string | null }

/** Compare every loaded quote field, including price/version/links, in the write itself. */
export async function saveMintState(db: SupabaseClient, quote: MintQuote, changes: Record<string, unknown>) {
  if (!quote.tenant_id || quote.paid_at != null) return null
  let update = db.from('quotes').update(changes).eq('id', quote.id).eq('tenant_id', quote.tenant_id).is('paid_at', null)
  for (const field of MINT_QUOTE_FIELDS) {
    if (['id', 'tenant_id', 'paid_at'].includes(field)) continue
    const value = quote[field]
    update = value == null ? update.is(field, null) : update.eq(field, typeof value === 'object' ? JSON.stringify(value) : value)
  }
  const { data, error } = await update.select(MINT_QUOTE_FIELDS.join(',')).maybeSingle<MintQuote>()
  return !error && data?.id === quote.id && data.tenant_id === quote.tenant_id ? data : null
}

/** Already expired is a confirmed safe state; unknown/completed/foreign sessions are not. */
export async function expireOwnedCheckout(sessionUrl: string, quoteId: string): Promise<boolean> {
  try {
    const url = new URL(sessionUrl)
    const id = url.hostname === 'checkout.stripe.com' && url.protocol === 'https:'
      ? url.pathname.match(/(?:^|\/)cs_(?:test|live)_[A-Za-z0-9]+(?:\/|$)/)?.[0].replace(/^\//, '').replace(/\/$/, '') : null
    if (!id || url.username || url.password) return false
    const stripe = getStripe()
    const existing = await stripe.checkout.sessions.retrieve(id)
    if (existing.id !== id || existing.metadata?.quote_id !== quoteId) return false
    if (existing.status === 'expired') return true
    if (existing.status !== 'open' || existing.payment_status !== 'unpaid') return false
    const expired = await stripe.checkout.sessions.expire(id)
    return expired.id === id && expired.status === 'expired'
  } catch { return false }
}

/** No caller may expose a newly minted URL until its owned unchanged row acknowledges it. */
export async function persistMintedCheckout(db: SupabaseClient, quote: MintQuote, tier: string, url: string) {
  let acknowledged = false
  try {
    const stored = quote.stripe_links
    if (stored !== null && (typeof stored !== 'object' || Array.isArray(stored))) return false
    const links = { ...(stored as Record<string, unknown> | null ?? {}) }
    const replaced = links[tier]
    if (replaced != null && (typeof replaced !== 'string' || !await expireOwnedCheckout(replaced, quote.id))) return false
    links[tier] = url
    const saved = await saveMintState(db, quote, { stripe_links: links })
    acknowledged = !!saved && (saved.stripe_links as Record<string, unknown> | null)?.[tier] === url
    return acknowledged
  } catch { return false }
  finally {
    // A lost DB acknowledgment can still have committed. Expiring this unexposed
    // candidate is safe; the retained quote can mint again on the next click.
    if (!acknowledged && !await expireOwnedCheckout(url, quote.id)) {
      console.error('[quote/mint] unexposed checkout cancellation unconfirmed', { quoteId: quote.id, tier })
    }
  }
}
