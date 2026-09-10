import { effectivePaintingRateCardFromOverlay, parsePaintingRateOverlay } from './rate-card-overlay'
import type { PaintingRateCard } from './types'

/** Shared with the saved-quote path: incomplete tenant prices remain setup-required. */
export function completePaintingRateCard(overlayJson: unknown): PaintingRateCard | undefined {
  const parsed = parsePaintingRateOverlay(overlayJson)
  if (!parsed.ok) return undefined
  const card = parsed.overlay
  const numeric = [card.colour_change_extra, card.good_refresh_fraction, card.premium_uplift_pct,
    card.double_storey_loading_pct, card.call_out_minimum_ex_gst,
    ...['1','2','3'].map((key) => card.coats_multiplier?.[key as '1'|'2'|'3']),
    ...['sound','minor','bare'].map((key) => card.condition_multiplier?.[key as 'sound'|'minor'|'bare']),
    ...(card.pricing_model === 'hourly'
      ? [card.hourly_rate, ...['walls','ceilings','trim','exterior'].map((key) => card.production_rate_per_unit?.[key as 'walls'|'ceilings'|'trim'|'exterior'])]
      : ['walls','ceilings','trim','exterior'].map((key) => card.rate_per_unit?.[key as 'walls'|'ceilings'|'trim'|'exterior'])),
  ]
  if (numeric.some((value) => typeof value !== 'number' || !Number.isFinite(value)) || typeof card.gst_registered !== 'boolean') return undefined
  return effectivePaintingRateCardFromOverlay(overlayJson)
}
