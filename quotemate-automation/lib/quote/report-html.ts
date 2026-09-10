// Self-contained HTML for the customer quote PDF (electrical + plumbing
// G/B/B quotes), rendered by Gotenberg (lib/pdf/gotenberg.ts).
//
// White-label Caterpillar chrome shared with every trade
// (lib/pdf/report-chrome.ts). The body keeps its native Good/Better/Best
// tier structure (spec specs/quote-pdf-branding.md D2/R4). Pure — unit-tested.
//
// Money convention: tiers store subtotal_ex_gst; the customer-facing PDF
// shows headline prices from the canonical cents calculation, with the
// verified tax flag supplied by the saved quote reader.

import {
  renderReportDocument,
  renderTradieBlock,
  brandingFromName,
  esc,
  aud2,
  type TenantBranding,
} from '../pdf/report-chrome'
import { renderRoofLayoutSectionHtml, type RoofLayoutOverlay } from '@/lib/roofing/report-html'
import { clampDiscountPct } from './early-bird'
import { INSPECTION_FEE_AUD, clampDepositPct, displayIncGst, totalIncGstCents } from './money'
import type { ReportStyle } from './report-doc/style'

/**
 * Bump whenever buildQuoteReportHtml's output changes in a way that should
 * invalidate already-cached PDFs (mig 146 self-heal). lib/quote/pdf.ts stamps
 * this into quotes.pdf_signature; a mismatch on download/send regenerates the
 * PDF so a tradie's tier-mode change (or a template edit) is reflected without
 * a manual/bulk job.
 *
 *   v2 (2026-06-25): tier-count-aware eyebrow / intro / heading — a single-tier
 *   quote no longer prints "Good / Better / Best".
 *   v3 (2026-07-10): property-visuals section (satellite/aerial image + the
 *   customer page's measurement stat grid) for roofing / commercial-painting
 *   quotes — spec specs/quote-visual-parity.md R1.
 *   v4 (2026-07-10): PDFs render as ONE continuous page (Gotenberg singlePage)
 *   instead of A4 page-by-page; the shared chrome pins the body width.
 *   v5 (2026-07-13): roofing property-visuals aerial now centres on the measured
 *   building polygon, not the geocoded (street-only) address — cached PDFs with
 *   the wrong-building image self-heal on next download.
 *   v6 (2026-07-13): roofing quotes-row PDF now includes the roof layout map +
 *   estimated materials (from the linked measurement) — cached roofing quote PDFs
 *   regenerate to add them.
 *   v7 (2026-07-17): tier prices honour the realised early-booking discount
 *   (P7 — the PDF previously showed the full price while the page + Stripe
 *   charged the discounted one) and pricing_book.gst_registered (P1), both via
 *   the shared lib/quote/money.ts.
 *   v8 (2026-07-21): customer-view parity — the PDF now carries the page's
 *   "Job details" sentence (quotes.scope_short) and a "Your tradie" block with
 *   the tradie's photo (tenants.photo_url, else the placeholder avatar).
 *   v9 (2026-09-03): post-site-visit FINAL quotes (spec
 *   post-visit-money-sequence R5) — the single tier prints as "FINAL QUOTE"
 *   rather than "GOOD", and the "final pricing is confirmed on site"
 *   disclaimer is replaced: on a document produced AFTER the visit that
 *   sentence told the customer the price they are paying a deposit against
 *   might still move.
 *   v10 (2026-09-09): saved tax authority, correct non-GST copy and cent prices.
 *   v11 (2026-09-09): saved quote fonts, accents and heading appearance.
 */
export const REPORT_TEMPLATE_VERSION = 11

export type QuoteReportLineItem = {
  description: string
  quantity: number
  unit: string
  unit_price_ex_gst: number
  total_ex_gst: number
}

export type QuoteReportTier = {
  label: string
  subtotal_ex_gst: number | string
  line_items?: QuoteReportLineItem[]
} | null

/** The customer page's property evidence (satellite/aerial image + measurement
 *  stat grid) mirrored into the report — spec quote-visual-parity R1. */
export type QuoteReportPropertyVisuals = {
  /** Data URI (PDF) or token-gated proxy URL (live HTML preview); null = stats only. */
  imageSrc: string | null
  caption: string
  stats: Array<{ label: string; value: string }>
  disclaimer: string | null
}

/** The "Your tradie" block, as resolved by lib/quote/tradie-profile.ts. The PDF
 *  receives `photoSrc` already embedded as a data: URI (lib/pdf/image prepareImage),
 *  so the render never depends on the network. */
export type QuoteReportTradie = {
  name: string
  photoSrc: string
  hasPhoto: boolean
  blurb: string
}

export type QuoteReportInput = {
  reportStyle?: ReportStyle | null
  businessName: string
  /** Full white-label branding; when omitted, derived from businessName. */
  branding?: TenantBranding
  customerName?: string | null
  jobType: string
  scopeOfWorks?: string | null
  /** v8 — quotes.scope_short: the one-line job summary the customer page prints
   *  as section 02 "Job details". Absent/blank ⇒ the section is omitted. */
  jobDetails?: string | null
  /** v8 — the customer page's section 03 "Your tradie" (lib/quote/tradie-profile).
   *  Absent ⇒ the section is omitted (back-compat for callers that don't load it). */
  tradie?: QuoteReportTradie | null
  assumptions?: string[] | null
  estimatedTimeframe?: string | null
  propertyVisuals?: QuoteReportPropertyVisuals | null
  /** Roofing quotes only: the AI work-strategy layout map + estimated materials,
   *  sourced from the linked roofing_measurements (null for every other trade or
   *  when the tradie hasn't generated a plan). Renders after propertyVisuals. */
  layoutOverlay?: RoofLayoutOverlay | null
  good: QuoteReportTier
  better: QuoteReportTier
  best: QuoteReportTier
  selectedTier?: 'good' | 'better' | 'best' | null
  /** v9 — quotes.quote_kind (mig 194). 'final' switches the tier marker to
   *  "FINAL QUOTE" and swaps the "confirmed on site" disclaimer, which is
   *  false on a document produced after the visit. Absent → 'initial'. */
  quoteKind?: string | null
  /** v9 — quotes.deposit_pct, printed in the final-quote disclaimer. */
  depositPct?: number | null
  /** v7 — realised early-booking discount % (quotes.applied_discount_pct).
   *  When > 0 headline tier prices render DISCOUNTED, matching the page,
   *  the SMS and the Stripe charge (P7). Absent/0 → full price. */
  appliedDiscountPct?: number | null
  /** Verified saved quote tax. Legacy pure callers retain the registered default. */
  gstRegistered?: boolean | null
  quoteViewUrl?: string | null
  /** Deprecated: licence now flows via `branding.licenceLine`. Kept for back-compat. */
  licenceLine?: string | null
  generatedAt?: Date
}

/** Same inc-GST rounding every other customer surface uses (lib/quote/money). */
export function incGst(exGst: number | string): number {
  return displayIncGst(exGst)
}

function prettyJobType(jobType: string): string {
  return jobType.replace(/_/g, ' ')
}

function tierSection(
  key: 'good' | 'better' | 'best',
  tier: QuoteReportTier,
  selected: boolean,
  money?: { discountPct?: number | null; gstRegistered?: boolean | null },
  /** v9 — a post-site-visit FINAL quote has one confirmed price, so the
   *  marker prints "FINAL QUOTE" rather than the raw slot name. Printing
   *  "GOOD" on a price the tradie confirmed on site reads as one option of
   *  three that were never offered. */
  quoteKind?: string | null,
): string {
  if (!tier) return ''
  const isFinal = quoteKind === 'final'
  const discountPct = clampDiscountPct(money?.discountPct)
  const price = totalIncGstCents(tier.subtotal_ex_gst, {
    discountPct,
    gstRegistered: money?.gstRegistered,
  }) / 100
  const taxNote = money?.gstRegistered === false ? 'No GST' : 'inc GST'
  const priceNote = discountPct > 0 ? `${taxNote} · ${discountPct}% off applied` : taxNote
  const rows = (tier.line_items ?? [])
    .map(
      (li) => `
      <tr>
        <td>${esc(li.description)}</td>
        <td class="num">${li.quantity} ${esc(li.unit)}</td>
        <td class="num">${aud2(li.unit_price_ex_gst)}</td>
        <td class="num">${aud2(li.total_ex_gst)}</td>
      </tr>`,
    )
    .join('')
  return `
  <section class="part">
    <div class="tier-head" style="display:flex;justify-content:space-between;align-items:baseline;">
      <span class="marker" style="padding:4px 10px;font-size:11px;letter-spacing:0.12em;">${
        isFinal ? 'FINAL QUOTE' : key.toUpperCase()
      }${selected && !isFinal ? ' · RECOMMENDED' : ''}</span>
      <span class="tier-price" style="font-size:20px;font-weight:800;">${aud2(price)} <small style="font-size:10px;font-weight:400;color:var(--dim);">${esc(priceNote)}</small></span>
    </div>
    <div class="tier-label" style="margin-top:6px;color:var(--sec);font-weight:600;">${esc(
      tier.label ?? '',
    )}</div>
    ${
      rows
        ? `<table>
      <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit (ex GST)</th><th class="num">Total (ex GST)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
        : ''
    }
  </section>`
}

/** The three Good/Better/Best `<section>`s, in order — shared by the customer
 *  PDF (buildQuoteReportHtml) and the document serializer (report-doc/serialize).
 *  Prices come from good/better/best, so both surfaces render identical tiers. */
export function renderQuoteTiersHtml(
  input: Pick<
    QuoteReportInput,
    | 'good'
    | 'better'
    | 'best'
    | 'selectedTier'
    | 'appliedDiscountPct'
    | 'gstRegistered'
    | 'quoteKind'
  >,
): string {
  const money = {
    discountPct: input.appliedDiscountPct,
    gstRegistered: input.gstRegistered,
  }
  return (['good', 'better', 'best'] as const)
    .map((key) =>
      tierSection(key, input[key], input.selectedTier === key, money, input.quoteKind),
    )
    .join('')
}

/** Per-trade default "Please Note" disclaimers (R7). */
const QUOTE_PLEASE_NOTE = [
  'Headline tier prices include 10% GST; line items are shown ex GST.',
  'Final pricing is confirmed on site; variations to the scope above are quoted separately.',
  'Materials are supplied to equivalent specification where a named brand is unavailable.',
]

/**
 * v9 — the disclaimers for a post-site-visit FINAL quote.
 *
 * Line 2 of the default set promises that "final pricing is confirmed on
 * site", which is exactly backwards on a document produced AFTER the site
 * visit: this price IS the confirmed one. Leaving it would tell the customer
 * the number they are about to pay a deposit against might still move.
 */
function pleaseNoteFor(quoteKind: string | null | undefined, depositPct: number, gstRegistered?: boolean | null): string[] {
  const taxNote = gstRegistered === false ? 'No GST is charged on this quote.' : QUOTE_PLEASE_NOTE[0]
  if (quoteKind !== 'final') return [taxNote, ...QUOTE_PLEASE_NOTE.slice(1)]
  return [
    taxNote,
    `Price confirmed at your site visit. Deposit ${depositPct}% less $${INSPECTION_FEE_AUD} credit; balance on completion.`,
    QUOTE_PLEASE_NOTE[2],
  ]
}

export function buildQuoteReportHtml(input: QuoteReportInput): string {
  return buildQuoteReportHtmlFromBody(input, buildDefaultQuoteBody(input))
}

/** The property-visuals `<section>` — image (when available), stat grid,
 *  disclaimer. Empty string when the input carries neither image nor stats. */
function propertyVisualsSection(v: QuoteReportPropertyVisuals | null | undefined): string {
  if (!v) return ''
  if (!v.imageSrc && v.stats.length === 0) return ''
  const img = v.imageSrc
    ? `<figure style="margin:0 0 10px;"><img src="${v.imageSrc}" alt="${esc(
        v.caption,
      )}" style="width:100%;max-width:640px;display:block;" /><figcaption class="mono" style="font-size:9px;color:var(--dim);margin-top:4px;">${esc(
        v.caption,
      )}</figcaption></figure>`
    : ''
  // The chrome's .statgrid is a non-wrapping flex row — chunk into rows of ≤4
  // so a fully-populated roofing scope (8 stats) stays legible in print.
  const statCell = (s: { label: string; value: string }) =>
    `<div class="stat"><div class="v">${esc(s.value)}</div><div class="l">${esc(s.label)}</div></div>`
  const statRows: string[] = []
  for (let i = 0; i < v.stats.length; i += 4) {
    statRows.push(`<div class="statgrid">${v.stats.slice(i, i + 4).map(statCell).join('')}</div>`)
  }
  const stats = statRows.join('')
  const disclaimer = v.disclaimer
    ? `<p class="note">${esc(v.disclaimer)}</p>`
    : ''
  return `<h2>Your property</h2>${img}${stats}${disclaimer}`
}

/** Section 02 "Job details" — the customer page's one-line scope sentence
 *  (quotes.scope_short). Empty string when the quote carries none. */
function jobDetailsSection(jobDetails: string | null | undefined): string {
  const text = (jobDetails ?? '').trim()
  if (!text) return ''
  return `<h2>Job details</h2><div class="scope">${esc(text)}</div>`
}

/** Section 03 "Your tradie" — photo (or the placeholder avatar) beside the
 *  licensed-local-business sentence, matching the customer page. */
function tradieSection(t: QuoteReportTradie | null | undefined): string {
  if (!t) return ''
  return `
  <h2>Your tradie</h2>${renderTradieBlock(t)}`
}

/** The default report body — scope of works + Good/Better/Best + assumptions,
 *  exactly as before the report-doc split. Used when a quote has no report_doc. */
function buildDefaultQuoteBody(input: QuoteReportInput): string {
  const multiTier = (['good', 'better', 'best'] as const).filter((k) => input[k]).length >= 2
  const tiers = renderQuoteTiersHtml(input)
  const assumptions = (input.assumptions ?? []).filter((a) => a && a.trim()) as string[]

  let body = ''
  if (input.scopeOfWorks) {
    body += `<h2>Scope of works</h2><div class="scope">${esc(input.scopeOfWorks)}</div>`
  }
  // Customer-view order: overview (scope) → job details → property evidence →
  // your tradie → your price. Keeps the PDF reading like the page it mirrors.
  body += jobDetailsSection(input.jobDetails)
  body += propertyVisualsSection(input.propertyVisuals)
  // Roofing: the layout map + estimated materials (from the linked measurement).
  if (input.layoutOverlay) body += renderRoofLayoutSectionHtml(input.layoutOverlay)
  body += tradieSection(input.tradie)
  body += `<h2>${multiTier ? 'Your options' : 'Your quote'}</h2>${tiers}`
  if (assumptions.length > 0) {
    body += `<h2>Assumptions</h2><ul class="bullets">${assumptions
      .map((a) => `<li>${esc(a)}</li>`)
      .join('')}</ul>`
  }
  return body
}

/**
 * Wrap an arbitrary report body in the shared white-label chrome (branding,
 * eyebrow, intro, please-note, closing). The document serializer
 * (report-doc/serialize.ts) renders report_doc through this so a document quote
 * uses the EXACT same chrome the PDF uses — the on-screen HTML == the PDF.
 *
 * Mig 146 — eyebrow / intro / heading wording follows how many tiers are
 * actually visible. The caller (lib/quote/pdf.ts) has already filtered
 * good/better/best to the tenant's tier mode, so a single-tier quote reads as
 * one quote — not "Good / Better / Best"; two or more keeps the tiered framing.
 */
export function buildQuoteReportHtmlFromBody(input: QuoteReportInput, bodyHtml: string): string {
  const date = (input.generatedAt ?? new Date()).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const branding = input.branding ?? brandingFromName(input.businessName)
  const job = prettyJobType(input.jobType)
  const multiTier = (['good', 'better', 'best'] as const).filter((k) => input[k]).length >= 2

  const closingLine = input.quoteViewUrl
    ? `Pay links and the live version of this quote: ${input.quoteViewUrl}`
    : null

  return renderReportDocument(branding, {
    appearance: input.reportStyle,
    docTitle: `Quote — ${branding.businessName}`,
    eyebrow: multiTier ? 'Customer quote · Good / Better / Best' : 'Customer quote',
    dateLabel: date,
    customerName: input.customerName ?? null,
    customerContact: input.estimatedTimeframe ? `Est. timeframe: ${input.estimatedTimeframe}` : null,
    introHtml: `Thank you for the opportunity to quote for <strong>${esc(
      job,
    )}</strong>. ${
      multiTier ? 'Your Good / Better / Best options are' : 'Your quote is'
    } set out below.`,
    bodyHtml,
    pleaseNote: pleaseNoteFor(input.quoteKind, clampDepositPct(input.depositPct), input.gstRegistered),
    footerPriceNote: input.gstRegistered === false ? 'No GST is charged.' : 'Prices include GST.',
    closingLine,
  })
}
