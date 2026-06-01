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
  const flagged = quote.inspection_structures ?? []
  // The combined total + count reflect the QUOTABLE structures only.
  const quotableCount = Math.max(1, quote.structures.length - flagged.length)
  const area = Math.round(quote.combined.area_m2)
  const scope =
    quotableCount > 1
      ? `${quotableCount} structures, ~${area} m² total`
      : `~${area} m² of roof`

  const lines = quote.combined.tiers.map((t, i) => `• ${TIER_LABELS[i]}: ${fmtAud(t.inc_gst)}`)

  const out = [
    `${greeting(ctx.firstName)}here's your roofing estimate for ${ctx.address} (${scope}):`,
    ...lines,
    `Full breakdown + your roof image: ${ctx.quoteUrl}`,
  ]
  if (flagged.length > 0) {
    out.push(
      `Heads-up: ${flagged.join(', ')} need${flagged.length === 1 ? 's' : ''} a quick on-site look — we'll sort ${flagged.length === 1 ? 'that' : 'those'} separately.`,
    )
  }
  out.push('Prices inc GST. A roofer reviews every quote before we book anything.')
  return out.join('\n')
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

/**
 * PURE — the "is this your roof?" confirmation message, sent with the
 * satellite photo (MMS) BEFORE the price. Single building → a simple
 * yes/no; multiple buildings → a numbered list so the customer can pick
 * one, with "none" handled by a NO reply. Always links the page so they
 * can see the roof(s).
 */
export function composeConfirmMessage(ctx: RoofingReplyContext): string {
  const structures = ctx.quote.structures
  if (structures.length <= 1) {
    return [
      `${greeting(ctx.firstName)}is this your roof at ${ctx.address}?`,
      `Reply YES and I'll send your quote, or NO if it's the wrong building.`,
      `See it here: ${ctx.quoteUrl}`,
    ].join('\n')
  }
  const list = structures.map((s, i) => {
    const area = s.metrics?.sloped_area_m2 != null ? ` (~${Math.round(s.metrics.sloped_area_m2)} m²)` : ''
    return `${i + 1}) ${s.label}${area}`
  })
  return [
    `${greeting(ctx.firstName)}I found ${structures.length} buildings at ${ctx.address}:`,
    ...list,
    `Reply YES to quote all of them, the number for just one, or NO if none are right.`,
    `See them here: ${ctx.quoteUrl}`,
  ].join('\n')
}

/**
 * PURE — narrow a multi-structure quote down to a single chosen structure
 * (1-based index), recomputing the "combined" block as just that
 * structure's numbers. Returns the original quote when the index is out
 * of range. Used when the customer picks one building from the list.
 */
export function narrowQuoteToStructure(quote: MultiRoofQuote, index1Based: number): MultiRoofQuote {
  const i = index1Based - 1
  if (i < 0 || i >= quote.structures.length) return quote
  const picked = quote.structures[i]
  const inspection = picked.price.routing.decision === 'inspection_required'
  return {
    structures: [picked],
    combined: { area_m2: picked.price.area_m2, tiers: picked.price.tiers },
    routing: picked.price.routing,
    inspection_structures: inspection ? [picked.label] : [],
  }
}
