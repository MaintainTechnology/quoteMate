// ════════════════════════════════════════════════════════════════════
// SMS painting receptionist — pure reply composer.
//
// Turns a priced PaintingEstimate into the customer-facing SMS body, and
// builds the small set of conversational messages the painting flow sends
// (form offer, inspection, booking, cancel, form thank-you). SMS-length-
// aware: short labels, no cents, one line per tier. Prices are taken
// VERBATIM from the deterministic painting pricer — never re-derived here.
//
// PURE — no I/O. Fully unit-tested. Mirrors lib/sms/roofing-compose.ts.
// ════════════════════════════════════════════════════════════════════

import type { PaintingEstimate } from '@/lib/painting/types'
import { asQuoteTierMode, resolveVisibleTiers, type QuoteTierMode } from '@/lib/quote/tier-visibility'
import { INSPECTION_FEE_AUD } from '@/lib/quote/money'

export type PaintingReplyContext = {
  estimate: PaintingEstimate
  /** The property address, for the message opener. */
  address: string
  /** Public quote-page URL (/q/paint/[public_token]). */
  quoteUrl: string
  /** Stable download URL for the Gotenberg quote PDF (priced jobs only). */
  pdfUrl?: string | null
  /** Customer first name, when known. */
  firstName?: string | null
  /** Per-feature tier presentation mode — which tiers the SMS lists.
   *  Omitted ⇒ 'single' (the platform default). */
  tierMode?: QuoteTierMode
  /** painting_measurements.public_token — needed to build the site-visit
   *  short-link. */
  token?: string
  /** App base URL for the /r/paint/[token]/inspection site-visit short-link.
   *  The link is included only when token + appUrl are both set. */
  appUrl?: string
}

// ── small shared helpers (kept local so the module is self-contained) ──

function greeting(firstName?: string | null): string {
  const f = (firstName ?? '').trim().split(/\s+/)[0]
  return f ? `Hi ${f}, ` : 'Hi, '
}
function nameSuffix(firstName?: string | null): string {
  const f = (firstName ?? '').trim().split(/\s+/)[0]
  return f ? ` ${f}` : ''
}

/** PURE — whole-dollar AUD, no cents (SMS brevity). */
export function fmtAud(n: number): string {
  const safe = Number.isFinite(n) ? n : 0
  return '$' + Math.round(safe).toLocaleString('en-AU')
}

const PAINT_TIER_LABEL_BY_KEY: Record<'good' | 'better' | 'best', string> = {
  good: 'Refresh (1 coat)',
  better: 'Standard (2 coats)',
  best: 'Premium (2 coats + full prep)',
}

/**
 * PURE — the opener that offers the self-serve form FIRST, with the
 * question-by-question flow as the fallback (matches the spec: offer the
 * link, fall back to asking the form fields here).
 */
export function buildPaintingFormOffer(ctx: { firstName?: string | null; formUrl: string }): string {
  return [
    `${greeting(ctx.firstName)}happy to sort a painting quote for you.`,
    `Quickest way is this short form. We'll prepare a draft for the painter to review before sending your quote: ${ctx.formUrl}`,
    `Or just reply here and I'll ask you a few quick questions instead.`,
  ].join('\n')
}

/**
 * PURE — the quotable estimate message. Lists the inc-GST tier prices
 * exactly from the painting pricer, plus the quote-page link and the ONE
 * customer payment: the flat $99 refundable site visit (spec
 * painting-site-visit-first R4 — the per-tier 30% deposit links this message
 * used to carry are retired; the final price is confirmed on site).
 */
export function buildPaintingQuoteSms(ctx: PaintingReplyContext): string {
  const tiers = ctx.estimate.price.tiers
  const area = Math.round(ctx.estimate.price.total_area_m2)

  const visibleTierKeys = resolveVisibleTiers({
    mode: asQuoteTierMode(ctx.tierMode, 'single'),
    present: {
      good: tiers.some((t) => t.tier === 'good'),
      better: tiers.some((t) => t.tier === 'better'),
      best: tiers.some((t) => t.tier === 'best'),
    },
    selectedTier: null,
  })
  const lines = tiers
    .filter((t) => visibleTierKeys.includes(t.tier))
    .map((t) => {
      // Honour a tradie's edited tier label (lib/painting/edit.ts) so the SMS
      // matches the customer page + PDF; fall back to the canonical name.
      const label = t.label?.trim() || PAINT_TIER_LABEL_BY_KEY[t.tier]
      return `• ${label}: ${fmtAud(t.inc_gst)}`
    })

  const out = [
    `${greeting(ctx.firstName)}here's your painting estimate for ${ctx.address} (~${area} m²):`,
    ...lines,
    `Full quote: ${ctx.quoteUrl}`,
  ]
  if (ctx.pdfUrl) out.push(`PDF copy: ${ctx.pdfUrl}`)
  // The one payment: the flat site visit, worded exactly like roofing's
  // (lib/sms/templates.ts) so the two trades promise the same thing.
  if (ctx.token && ctx.appUrl) {
    out.push(
      `Tap to lock in your site visit ($${INSPECTION_FEE_AUD} refundable, credited toward your final quote): ${ctx.appUrl}/r/paint/${ctx.token}/inspection`,
    )
  }
  out.push('Prices inc GST. A painter reviews every quote before we book anything.')
  return out.join('\n')
}

/**
 * PURE — the inspection-route message. No firm price; states the reason
 * and the next step (book an on-site measure).
 */
export function buildPaintingInspectionSms(ctx: {
  firstName?: string | null
  address: string
  reason: string
  quoteUrl?: string | null
}): string {
  const out = [
    `${greeting(ctx.firstName)}for the painting at ${ctx.address} we'll need a quick look on site before we can quote accurately.`,
    ctx.reason,
  ]
  if (ctx.quoteUrl) out.push(`Details: ${ctx.quoteUrl}`)
  out.push(`Reply YES and we'll book a time that suits you.`)
  return out.join('\n')
}

/** PURE — reply after the inspection "shall we book?" prompt. */
export function composePaintingBooking(firstName: string | null | undefined, confirmed: boolean): string {
  return confirmed
    ? `Great${nameSuffix(firstName)}. A painter will be in touch shortly to lock in a time for the on-site measure.`
    : `No worries${nameSuffix(firstName)}. Just text us whenever you're ready and we'll sort the measure.`
}

/** PURE — polite close when the customer asks to stop / cancel. */
export function composePaintingCancel(firstName?: string | null): string {
  return `No problem${nameSuffix(firstName)}. I've stopped there. Just text me anytime if you'd like a painting quote.`
}

/** PURE — the thank-you shown on the form page + texted after a submit. */
export function buildPaintingFormThankYou(ctx: { firstName?: string | null }): string {
  return `Thanks${nameSuffix(ctx.firstName)} — got your painting details. A painter needs to review the draft before a quote can be shared.`
}

/**
 * PURE — the holding message texted to the CUSTOMER when we can't hand them a
 * price yet. Since spec painting-auto-send a priced quote goes straight out,
 * so this is now the ERROR fallback: the estimate saved but the quote SMS
 * could not be delivered. It sets the expectation without leaking a price.
 */
export function buildPaintingHoldingSms(ctx: {
  firstName?: string | null
  businessName?: string | null
}): string {
  const who = ctx.businessName?.trim() || 'your painter'
  return `${greeting(ctx.firstName)}your painting draft is saved and awaiting review by ${who}. It has not been released as a quote yet.`
}

/**
 * PURE — the notification texted to the TRADIE when a customer requests a
 * painting quote. Links them to the review page where they edit, audit and
 * re-send it. Mirrors lib/solar/notify.ts buildSolarTradieNotification.
 *
 * `customerTexted: false` is the auto-send FAILURE alert (spec
 * painting-auto-send R3). Painting no longer waits for the tradie, so a
 * dropped send has no other witness — the copy has to say, in plain words,
 * that the customer received NOTHING and the quote needs sending by hand.
 */
export function buildPaintingTradieNotification(args: {
  tradieFirstName?: string | null
  customerName?: string | null
  address: string
  betterIncGst?: number | null
  reviewUrl: string
  customerTexted?: boolean
}): string {
  const greet = args.tradieFirstName ? `Hi ${args.tradieFirstName}, ` : ''
  const who = args.customerName?.trim() || 'A customer'
  const price =
    typeof args.betterIncGst === 'number' && args.betterIncGst > 0
      ? ` (est. ${fmtAud(args.betterIncGst)})`
      : ''
  if (args.customerTexted === false) {
    return (
      `${greet}${who} requested a painting quote for ${args.address}${price}, ` +
      `but we could NOT text it to them — the customer has NOT been sent anything. ` +
      `Open it and send it manually: ${args.reviewUrl}`
    )
  }
  return (
    `${greet}${who} just requested a painting quote for ${args.address}${price}. ` +
    `Review, adjust the coats/scope, then send it to them: ${args.reviewUrl}`
  )
}
