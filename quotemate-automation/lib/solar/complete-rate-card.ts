import type { SolarRateOverlay } from './rate-card-overlay'

/** The SMS estimator's existing completeness gate, before defaults are merged. */
export function hasCompleteSolarRateOverlay(overlay: SolarRateOverlay): boolean {
  const required = [overlay.install_rate_per_kw?.standard_panels, overlay.install_rate_per_kw?.premium_panels,
    overlay.multi_storey_loading_pct, overlay.complex_roof_loading_pct, overlay.call_out_minimum_ex_gst, overlay.stc_price_aud]
  return !required.some((value) => typeof value !== 'number' || !Number.isFinite(value)) && typeof overlay.gst_registered === 'boolean'
}
