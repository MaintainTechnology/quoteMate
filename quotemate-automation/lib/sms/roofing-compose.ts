// ════════════════════════════════════════════════════════════════════
// SMS roofing receptionist — pure reply composer.
//
// Turns a priced MultiRoofQuote into the customer-facing SMS/MMS body:
//   • quotable job → the three combined tier prices (inc-GST, taken
//     VERBATIM from the deterministic pricer — never re-derived here) +
//     a one-line scope + the quote-page link.
//   • inspection-routed job → the on-site-inspection next step + reason,
//     no dollar figure.
//
// SMS-length-aware: short labels, no cents, one line per tier.
//
// PURE — no I/O. Fully unit-tested.
// ════════════════════════════════════════════════════════════════════

import type { MultiRoofQuote } from '@/lib/roofing/types'

export type RoofingReplyContext = {
  quote: MultiRoofQuote
  /** The property address, for the message opener. */
  address: string
  /** Public quote-page URL (shows the roof on the Google Maps location). */
  quoteUrl: string
  /** Customer first name, when known. */
  firstName?: string | null
}

/** PURE — whole-dollar AUD, no cents (SMS brevity). */
export function fmtAud(n: number): string {
  const safe = Number.isFinite(n) ? n : 0
  return '$' + Math.round(safe).toLocaleString('en-AU')
}

function greeting(firstName?: string | null): string {
  const f = (firstName ?? '').trim().split(/\s+/)[0]
  return f ? `Hi ${f} — ` : 'Hi — '
}

const TIER_LABELS: [string, string, string] = ['Patch/repair', 'Re-roof', 'Upgrade']

/**
 * PURE — the quotable estimate message. Uses quote.combined.tiers
 * inc-GST exactly. Mentions structure count when >1 so the customer
 * knows the shed is included.
 */
export function composeEstimateMessage(ctx: RoofingReplyContext): string {
  const { quote } = ctx
  const n = quote.structures.length
  const area = Math.round(quote.combined.area_m2)
  const scope =
    n > 1
      ? `${n} structures, ~${area} m² total`
      : `~${area} m² of roof`

  const lines = quote.combined.tiers.map((t, i) => `• ${TIER_LABELS[i]}: ${fmtAud(t.inc_gst)}`)

  return [
    `${greeting(ctx.firstName)}here's your roofing estimate for ${ctx.address} (${scope}):`,
    ...lines,
    `Full breakdown + your roof image: ${ctx.quoteUrl}`,
    `Prices inc GST. A roofer reviews every quote before we book anything.`,
  ].join('\n')
}

/**
 * PURE — the inspection-route message. No price; states the reason and
 * the next step. Still links the quote page so the customer sees their
 * roof + location.
 */
export function composeInspectionMessage(ctx: RoofingReplyContext): string {
  const reason =
    ctx.quote.inspection_structures.length > 0
      ? ctx.quote.routing.reason
      : ctx.quote.routing.reason
  return [
    `${greeting(ctx.firstName)}for your roof at ${ctx.address} we'll need a quick on-site inspection before we can quote accurately.`,
    reason,
    `See the roof + location here: ${ctx.quoteUrl}`,
    `Reply YES and we'll book a time that suits you.`,
  ].join('\n')
}

/**
 * PURE — pick the right message for the quote's routing decision.
 * inspection_required → inspection message; otherwise the tiered estimate.
 */
export function buildRoofingReplyMessage(ctx: RoofingReplyContext): string {
  if (ctx.quote.routing.decision === 'inspection_required') {
    return composeInspectionMessage(ctx)
  }
  return composeEstimateMessage(ctx)
}
