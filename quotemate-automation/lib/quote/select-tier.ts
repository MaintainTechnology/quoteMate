// PURE — validate a tradie's "which tier to send" choice and compute the new
// headline total. The quote's good/better/best jsonb is persisted in full;
// changing selected_tier is a VIEW choice (resolveVisibleTiers in 'single' mode
// renders exactly the selected tier across SMS, PDF, and /q/[token]). This never
// re-prices — it only picks which already-priced tier is the recommended/sent one.
//
// Headline maths mirror app/api/quote/[id]/edit (subtotal_ex_gst × GST multiplier)
// so the stored total_inc_gst stays consistent with an edited quote.

export type TierKey = 'good' | 'better' | 'best'

/** Minimal shape read off a persisted good/better/best jsonb tier. */
export type PricedTier = { subtotal_ex_gst?: number | null } | null | undefined

export function isTierKey(v: unknown): v is TierKey {
  return v === 'good' || v === 'better' || v === 'best'
}

export type TierSelectionResult =
  | { ok: true; selectedTier: TierKey; totalIncGst: number }
  | { ok: false; error: 'invalid_tier' | 'tier_not_priced' }

/**
 * PURE — resolve a tier selection against the quote's priced tiers.
 *
 * Rejects an unknown tier (`invalid_tier`) or a tier that isn't present /
 * carries no positive subtotal (`tier_not_priced`) — the customer must never be
 * sent a $0 option. On success returns the new selected tier and the recomputed
 * inc-GST headline total.
 */
export function resolveTierSelection(args: {
  tier: unknown
  tiers: { good: PricedTier; better: PricedTier; best: PricedTier }
  gstRegistered: boolean
}): TierSelectionResult {
  const { tier, tiers, gstRegistered } = args
  if (!isTierKey(tier)) return { ok: false, error: 'invalid_tier' }
  const picked = tiers[tier]
  const subtotal =
    picked && typeof picked.subtotal_ex_gst === 'number' ? picked.subtotal_ex_gst : 0
  if (!Number.isFinite(subtotal) || subtotal <= 0) return { ok: false, error: 'tier_not_priced' }
  const totalIncGst = +(subtotal * (gstRegistered ? 1.1 : 1.0)).toFixed(2)
  if (!Number.isFinite(totalIncGst) || !Number.isSafeInteger(Math.round(totalIncGst * 100))) {
    return { ok: false, error: 'tier_not_priced' }
  }
  return { ok: true, selectedTier: tier, totalIncGst }
}
