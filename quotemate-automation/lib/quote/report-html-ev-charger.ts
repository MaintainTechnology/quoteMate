// ════════════════════════════════════════════════════════════════════
// The EV charger ESTIMATE document — spec specs/ev-charger-estimate-template.md
//
// A job_type-specific customer document for electrical `ev_charger` quotes
// ONLY. Selected in lib/quote/pdf.ts renderQuoteDocumentHtml when
// intake.job_type === 'ev_charger' AND intake.trade === 'electrical'; every
// other combination keeps the generic buildQuoteReportHtml output byte for byte
// (R1). Reproduces the section set of the source estimates (Appendix A of the
// spec) inside the shared white-label chrome, so the header block, fonts,
// palette and repeating footer are the ones every other trade PDF already uses
// (R2).
//
// Section order (R3): header · ESTIMATE + number · Prepared For / Site Address /
// Date / Valid Until · Scope of Work · Description of Works · Assumptions ·
// Inclusions · Exclusions · Optional Upgrades & Recommendations · phased
// line-item tables with Group Totals · Subtotal / GST / Total · Images ·
// Terms & Conditions. Every optional section is omitted HEADING AND ALL when it
// has no content — an empty section beats a padded one.
//
// PURE. No I/O, no Date.now(): the document date is input.generatedAt (itself
// quotes.created_at) so two renders of one quote are byte-identical (R1). Every
// caller-supplied string goes through esc(). Everything this document needs
// from the database — the estimate number, the customer's own phone, the
// assemblies' exclusions, the embedded images — is resolved by pdf.ts and
// passed in.
//
// Money: line items and the totals block are 2dp; every figure derives from the
// tier's own stored numbers through lib/quote/money.ts (R13). Nothing here
// invents a price — see the Optional Upgrades block, which carries the source
// documents' advisory copy with the dollar figures deliberately removed.
// ════════════════════════════════════════════════════════════════════

import {
  renderReportDocument,
  esc,
  aud2,
  brandingFromName,
  type TenantBranding,
} from '../pdf/report-chrome'
import { asMoneyNumber, totalIncGstCents, dollars } from './money'
import { clampDiscountPct } from './early-bird'

/** Body-template key folded into quotes.pdf_signature (R15). Bump on any change
 *  to this template's OUTPUT so cached EV PDFs — and only those — regenerate.
 *
 *  ev2 — the Images section now leads with the Gemini render of the charger in
 *  the customer's own photo (spec ev-charger-location-photo R12/R14).
 *  ev3 — direction 1B "Numbered & banded": the full-bleed summary band with its
 *  hero total, numbered section heads, hairline lists, facing Inclusions /
 *  Exclusions cards, one white card per tier and the accent accept band. */
export const EV_ESTIMATE_TEMPLATE_KEY = 'ev3'

/** How long the printed estimate says its prices stand (R7). Presentational:
 *  derived at render, never stored, and it gates nothing in the funnel. */
export const EV_ESTIMATE_VALID_DAYS = 30

/** "EST-0534" — the source estimates' format, zero-padded to four digits and
 *  growing naturally beyond them. Lives here rather than in lib/quote/pdf.ts so
 *  the customer page can format the number without pulling the whole PDF
 *  service (Gotenberg, sharp, every trade's report builder) into its bundle. */
export function formatEstimateNumber(n: number): string {
  return `EST-${String(Math.max(0, Math.trunc(n))).padStart(4, '0')}`
}

export const EV_PHASE_1_TITLE = 'Switchboard and rough-in'
export const EV_PHASE_2_TITLE = 'Fit-off and commissioning'

/**
 * Whether this quote gets the EV estimate document (spec R1).
 *
 * Both strings must match exactly. `job_type` is nullable and falls back to
 * 'job' upstream, and plumbing shares the generic electrical branch — so a
 * looser test would quietly capture quotes this document was never designed
 * for. Everything else keeps the generic report, byte for byte.
 */
export function isEvChargerJob(
  jobType: string | null | undefined,
  trade: string | null | undefined,
): boolean {
  return jobType === 'ev_charger' && trade === 'electrical'
}

export type EvEstimateLineItem = {
  description: string
  quantity: number
  unit: string
  unit_price_ex_gst: number
  total_ex_gst: number
  /** "material:<uuid>" | "assembly:<uuid>" | "labour" | "tradie_manual" … */
  source?: string | null
  catalogue_id?: string | null
}

export type EvEstimateTier = {
  label: string
  subtotal_ex_gst: number | string
  line_items?: EvEstimateLineItem[]
} | null

export type EvEstimateUpsell = {
  name: string
  /** Finite ⇒ a catalogue row backed it and the price prints. Null/absent ⇒
   *  "quoted on site" — what lib/estimate/upsell-guard.ts writes (R10). */
  price_ex_gst?: number | null
}

export type EvEstimateImage = {
  /** data: URI (PDF) or absolute URL (live HTML preview). */
  src: string
  caption?: string | null
}

export type EvChargerEstimateInput = {
  businessName: string
  branding?: TenantBranding
  /** "EST-0534", or the 8-character quote reference when no number could be
   *  assigned (R5). Already formatted by the caller. */
  estimateRef: string
  customerName?: string | null
  customerEmail?: string | null
  /** The customer's OWN number for this thread — never a remembered one (R6). */
  customerPhone?: string | null
  siteAddress?: string | null
  scopeOfWorks?: string | null
  /** Bullets for "Description of Works" (R8), resolved by the caller. */
  descriptionOfWorks?: string[] | null
  assumptions?: string[] | null
  /** Omit to derive from the visible tiers' line items (R9). */
  inclusions?: string[] | null
  /** The priced assemblies' default_exclusions, loaded by the caller (R9). */
  exclusions?: string[] | null
  optionalUpsells?: EvEstimateUpsell[] | null
  images?: EvEstimateImage[] | null
  good: EvEstimateTier
  better: EvEstimateTier
  best: EvEstimateTier
  selectedTier?: 'good' | 'better' | 'best' | null
  appliedDiscountPct?: number | null
  /** pricing_book.gst_registered. Absent ⇒ treated as registered. */
  gstRegistered?: boolean | null
  quoteViewUrl?: string | null
  estimatedTimeframe?: string | null
  /** intakes.scope.specs.supplied_by — drives the charger-unit exclusion (R9). */
  suppliedBy?: 'tradie' | 'customer' | null
  /** Catalogue ids known to be EV charger UNITS, so the unit line lands in
   *  Phase 2 with its mounting rather than in the rough-in (R4). */
  chargerUnitIds?: string[] | null
  generatedAt?: Date
}

// ── Phase classification (R4) ───────────────────────────────────────────
//
// Derived at RENDER, never stored. app/api/quote/[id]/edit/route.ts validates
// tier line items with a Zod object that strips unknown keys and re-emits
// exactly six of them, so a `phase` written onto a line item would be destroyed
// the first time the tradie saved. Re-deriving from the description (plus the
// caller's charger-unit id set) survives every edit.

/**
 * Unambiguous fit-off work: terminating, testing, commissioning, verifying,
 * cleaning up, handing over, energising. A line saying any of these is Phase 2
 * whatever else it mentions — "Mount and terminate the charger, make off the
 * cable glands" is fit-off even though it names cable.
 */
const PHASE_2_STRONG_PATTERN =
  /\b(terminat|commission|test|verif|clean[\s-]?up|cleanup|hand[\s-]?over|handover|energis|energiz)/i

/**
 * "mount" on its own is ambiguous: it is the act of fixing the charger to the
 * wall, but it is ALSO a material descriptor — "25mm surface mount conduit",
 * "surface mount enclosure". Treated as fit-off only when the line does not
 * name rough-in containment.
 */
const PHASE_2_MOUNT_PATTERN = /\bmount/i

/** Rough-in containment. Its presence demotes a mount-only match back to
 *  Phase 1, so conduit never prints under "Fit-off and commissioning". */
const PHASE_1_CONTAINMENT_PATTERN =
  /\b(conduit|cable|duct|ducting|enclosure|tray|saddle|gland)/i

/**
 * Which phase a line item belongs to. Phase 2 covers fit-off and commissioning
 * — including the charger unit itself, which is fitted in the same visit as its
 * mounting. Phase 1 is everything else: protection devices, cable, conduit,
 * fittings, sundries and the rough-in labour.
 */
export function evChargerPhase(
  line: Pick<EvEstimateLineItem, 'description' | 'source' | 'catalogue_id'>,
  opts?: { chargerUnitIds?: string[] | null },
): 1 | 2 {
  const ids = opts?.chargerUnitIds ?? []
  if (ids.length > 0) {
    const refId = line.catalogue_id ?? sourceUuid(line.source)
    // The charger unit is fitted in the same visit as its mounting, and the
    // tenant's catalogue is the only authority on which line IS the unit.
    if (refId && ids.includes(refId)) return 2
  }
  const description = line.description ?? ''
  // An unambiguous fit-off verb settles it, whatever else the line names.
  if (PHASE_2_STRONG_PATTERN.test(description)) return 2
  // Otherwise "mount" counts as fit-off only when the line is not containment.
  if (PHASE_2_MOUNT_PATTERN.test(description)) {
    return PHASE_1_CONTAINMENT_PATTERN.test(description) ? 1 : 2
  }
  return 1
}

/** The uuid out of "material:<uuid>" / "assembly:<uuid>"; null for every other
 *  source form (labour, callout, tradie_manual, …). */
function sourceUuid(source?: string | null): string | null {
  if (!source) return null
  const m = /^(?:material|assembly):(.+)$/i.exec(source.trim())
  return m ? m[1].trim() : null
}

// ── Optional Upgrades advisory copy (R10) ───────────────────────────────
//
// The source estimates print "Single Phase Install: $360.00 + GST", "Three
// Phase Install: $580.00 + GST" and "an additional charge of $150 to $400".
// Those figures are NOT reproduced: no catalogue row backs any of them, so the
// grounding rule that every printed dollar derives from a priced row would be
// broken by construction (this is the exact class of line that caused the
// 2026-09-01 incident); "+ GST" contradicts inc-GST display; and a range
// contradicts the no-indicative-figures rule. The recommendation itself is
// worth printing, so it prints — priced on site.
//
// A tenant who stocks surge-protection devices gets real prices automatically:
// they arrive as catalogue-backed optional_upsells entries and render below.

export const EV_SURGE_PROTECTION_NOTE = {
  title: 'Surge protection option',
  body:
    'We highly recommend installing a Surge Protection Device (SPD) to safeguard your new ' +
    'electric vehicle, EV charger, and valuable household electronics against sudden voltage ' +
    'spikes. Power surges can occur from lightning strikes or grid fluctuations and can cause ' +
    'thousands of dollars in damage to sensitive electronics. Pricing depends on there being ' +
    'sufficient physical room in your existing switchboard to fit the device, and is confirmed ' +
    'at your site visit.',
}

export const EV_SWITCHBOARD_CAPACITY_NOTE = {
  title: 'Switchboard capacity note',
  body:
    'If your switchboard does not have a spare circuit position available, additional work is ' +
    'needed to create space or upgrade the board. This is confirmed at your site visit.',
}

// ── Terms & Conditions (R13) ────────────────────────────────────────────
//
// Three lines survive from the source estimates verbatim. Two are replaced
// because they describe a commercial model this platform does not run:
//   "A 50% deposit is required to commence work."  → electrical takes the flat
//     $99 refundable site visit and nothing else (strategy v20); every deposit
//     link 302s to it, so printing a deposit promises what the funnel refuses.
//   "All prices are in AUD and include GST."       → contradicts the ex-GST line
//     items printed directly above it, and is simply false for a tenant whose
//     pricing_book.gst_registered is off.

export function evEstimateTerms(gstRegistered: boolean): string[] {
  return [
    'This is an estimate, not a contract.',
    `Prices are valid for ${EV_ESTIMATE_VALID_DAYS} days from the date of this estimate.`,
    'Final price may vary based on actual work performed.',
    'A $99 refundable site visit fee confirms your booking and is credited toward your final quote.',
    gstRegistered
      ? 'All prices are in Australian dollars. Line items are shown ex GST; the total includes 10% GST.'
      : 'All prices are in Australian dollars and are not subject to GST.',
  ]
}

// ── Formatting helpers ──────────────────────────────────────────────────

/** "13 Aug 2026" — the source estimates' date format, en-AU. */
function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime())
  out.setDate(out.getDate() + days)
  return out
}

/** "10 METRE", "1.5 HOUR", "1 EACH" — quantity and unit in one cell (R3). */
function qtyCell(line: EvEstimateLineItem): string {
  const unit = (line.unit ?? '').trim().toUpperCase()
  const qty = asMoneyNumber(line.quantity)
  return unit ? `${qty} ${unit}` : `${qty}`
}

function dedupeStrings(items: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const s = (raw ?? '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

function visibleTiers(
  input: EvChargerEstimateInput,
): Array<{ key: 'good' | 'better' | 'best'; tier: NonNullable<EvEstimateTier> }> {
  return (['good', 'better', 'best'] as const)
    .map((key) => ({ key, tier: input[key] }))
    .filter((t): t is { key: 'good' | 'better' | 'best'; tier: NonNullable<EvEstimateTier> } =>
      Boolean(t.tier),
    )
}

/** Every visible tier's line items, in tier order. */
function allLineItems(input: EvChargerEstimateInput): EvEstimateLineItem[] {
  return visibleTiers(input).flatMap((t) => t.tier.line_items ?? [])
}

/**
 * Inclusions, derived from what is actually priced (R9): one bullet per distinct
 * line-item description across the visible tiers. Nothing new is asked of the
 * model — the priced lines ARE the inclusions.
 */
export function deriveEvInclusions(input: EvChargerEstimateInput): string[] {
  if (input.inclusions) return dedupeStrings(input.inclusions)
  return dedupeStrings(allLineItems(input).map((li) => li.description))
}

/**
 * "Description of Works" bullets (R8), in priority order: what the customer
 * actually described, else the authored EV method this repo already ships
 * (lib/quote/job-method.ts, rendered on the quote page but never in a PDF
 * before), else the labour lines that were priced.
 *
 * Nothing is invented and no new model output is asked for: every bullet traces
 * to intake content, authored method text, or a priced line.
 */
export function deriveEvDescriptionOfWorks(args: {
  scopeDescription?: string | null
  methodSteps?: string[] | null
  lineItems?: EvEstimateLineItem[] | null
}): string[] {
  const described = splitSentences(args.scopeDescription)
  if (described.length > 0) return described
  const steps = dedupeStrings(args.methodSteps ?? [])
  if (steps.length > 0) return steps
  return dedupeStrings(
    (args.lineItems ?? [])
      .filter((li) => (li.unit ?? '').trim().toLowerCase() === 'hr')
      .map((li) => li.description),
  )
}

/** Sentence-split a free-text scope into bullets. Abbreviations are not worth
 *  a parser here: the split needs whitespace after the stop, so "approx. 6m"
 *  and "AS/NZS 3000." survive intact. */
function splitSentences(text?: string | null): string[] {
  const s = (text ?? '').trim()
  if (!s) return []
  return dedupeStrings(s.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((part) => part.trim()))
}

/**
 * Exclusions (R9): the priced assemblies' own default_exclusions, resolved by
 * the caller, plus the charger unit when the customer is supplying it. An
 * assembly whose uuid a tradie edit stripped contributes nothing — the section
 * renders what survives, and is omitted when nothing does.
 */
export function deriveEvExclusions(input: EvChargerEstimateInput): string[] {
  const supplied =
    input.suppliedBy === 'customer' ? ['Supply of the EV charger unit itself.'] : []
  return dedupeStrings([...supplied, ...(input.exclusions ?? [])])
}

// ── Body sections ───────────────────────────────────────────────────────

/** One phase's table, with its Group Total (R4). */
function phaseTable(title: string, items: EvEstimateLineItem[]): string {
  if (items.length === 0) return ''
  const groupTotal = items.reduce((sum, li) => sum + asMoneyNumber(li.total_ex_gst), 0)
  const rows = items
    .map(
      (li) => `
      <tr>
        <td>${esc(li.description)}</td>
        <td class="num">${esc(qtyCell(li))}</td>
        <td class="num">${aud2(asMoneyNumber(li.unit_price_ex_gst))}</td>
        <td class="num-last">${aud2(asMoneyNumber(li.total_ex_gst))}</td>
      </tr>`,
    )
    .join('')
  // No <section> here — 1B nests every phase table AND the totals inside ONE
  // white card, which tierBlock opens. The first and last columns lose their
  // outer padding so the table sits flush to the card's inner edges.
  return `
    <h3 class="ev-phase-title">${esc(title)}</h3>
    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="num">Qty</th>
          <th class="num">Rate</th>
          <th class="num-last">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="ev-group-total">
          <td colspan="3">Group Total:</td>
          <td class="num-last">${aud2(groupTotal)}</td>
        </tr>
      </tfoot>
    </table>`
}

/**
 * The Subtotal / GST / Total block (R13). Every figure comes from
 * lib/quote/money.ts and the three rows always reconcile: the GST row is the
 * difference between the total and the ex-GST base, so Subtotal + GST = Total
 * exactly (the source estimates read the same way). A tenant who is not GST
 * registered gets no GST row and a total equal to the subtotal — never a fixed
 * 10% line.
 */
type EvMoney = { discountPct?: number | null; gstRegistered?: boolean | null }

/**
 * The three reconciling figures, computed once.
 *
 * Extracted so the banded direction's hero `Total:` panel and the totals block
 * print the SAME number — R1's total appears twice on the page now, and two
 * independent sums would eventually disagree.
 */
function evTotals(tier: NonNullable<EvEstimateTier>, money: EvMoney): {
  exBase: number
  gstAmount: number
  total: number
  gstRegistered: boolean
} {
  const gstRegistered = money.gstRegistered ?? true
  const pct = clampDiscountPct(money.discountPct)
  const rawEx = asMoneyNumber(tier.subtotal_ex_gst)
  // The ex-GST base actually being charged. Identical to subtotal_ex_gst for
  // electrical, whose early-booking discount has been unreachable since v20;
  // discounting it here keeps the three rows reconciling if that ever changes.
  const exBase = pct > 0 ? Math.round(rawEx * (1 - pct / 100) * 100) / 100 : rawEx
  const total = totalIncGstCents(rawEx, { discountPct: pct, gstRegistered }) / 100
  return { exBase, gstAmount: total - exBase, total, gstRegistered }
}

function totalsBlock(tier: NonNullable<EvEstimateTier>, money: EvMoney): string {
  const { exBase, gstAmount, total, gstRegistered } = evTotals(tier, money)
  const rows = [
    `<div class="ev-total-row"><span class="ev-total-label">Subtotal (ex GST):</span><span class="num">${aud2(exBase)}</span></div>`,
    gstRegistered
      ? `<div class="ev-total-row"><span class="ev-total-label">GST (10%):</span><span class="num">${aud2(gstAmount)}</span></div>`
      : '',
    `<div class="ev-grand"><span class="ev-grand-label">Total:</span><span class="num">${aud2(total)}</span></div>`,
  ]
    .filter(Boolean)
    .join('')
  return `
    <div class="ev-totals-wrap"><div class="ev-totals">${rows}</div></div>`
}

/** One tier: its phased tables and its totals. Tier arity is untouched — every
 *  tier resolveVisibleTiers surfaced is rendered under its own label (R13). */
function tierBlock(
  input: EvChargerEstimateInput,
  entry: { key: 'good' | 'better' | 'best'; tier: NonNullable<EvEstimateTier> },
  showLabel: boolean,
): string {
  const items = entry.tier.line_items ?? []
  const opts = { chargerUnitIds: input.chargerUnitIds }
  const phase1 = items.filter((li) => evChargerPhase(li, opts) === 1)
  const phase2 = items.filter((li) => evChargerPhase(li, opts) === 2)
  // One populated phase ⇒ a single table still numbered "Phase 1", matching the
  // single-phase source estimate (R4).
  const tables =
    phase1.length > 0 && phase2.length > 0
      ? phaseTable(`Phase 1 - ${EV_PHASE_1_TITLE}`, phase1) +
        phaseTable(`Phase 2 - ${EV_PHASE_2_TITLE}`, phase2)
      : phaseTable(
          `Phase 1 - ${phase2.length > 0 ? EV_PHASE_2_TITLE : EV_PHASE_1_TITLE}`,
          phase1.length > 0 ? phase1 : phase2,
        )
  const heading = showLabel
    ? `<h2 class="ev-tier-heading">${esc(entry.tier.label || entry.key)}${
        input.selectedTier === entry.key ? ' <span class="chip">Recommended</span>' : ''
      }</h2>`
    : ''
  const totals = totalsBlock(entry.tier, {
    discountPct: input.appliedDiscountPct,
    gstRegistered: input.gstRegistered,
  })
  // One white card per tier: every phase table plus that tier's totals. The
  // `part ev-phase` class pair is load-bearing — report-html-ev-charger.test.ts
  // finds the end of the Optional Upgrades section by searching forward for
  // `<section class="part ev-phase"`, so renaming it silently breaks that test's
  // "no prices above the tables" assertion rather than failing it loudly.
  return `${heading}
  <section class="part ev-phase">${tables}${totals}
  </section>`
}

function optionalUpgradesSection(input: EvChargerEstimateInput): string {
  const upsells = (input.optionalUpsells ?? []).filter((u) => (u?.name ?? '').trim())
  const note = (n: { title: string; body: string }): string => `
      <div class="ev-note">
        <div class="ev-upgrade-title">${esc(n.title)}</div>
        <p>${esc(n.body)}</p>
      </div>`
  const upsellHtml = upsells.length
    ? `
      <div class="ev-upsells">${upsells
        .map((u) => {
          const price = u.price_ex_gst
          // A price prints ONLY when a catalogue row produced one. Anything else
          // is quoted on site — never a figure this template invented (R10).
          const priced =
            typeof price === 'number' && Number.isFinite(price)
              ? `$${dollars(
                  totalIncGstCents(price, { gstRegistered: input.gstRegistered }),
                ).toLocaleString('en-AU')} inc GST`
              : 'quoted on site'
          return `
        <div class="ev-upsell"><span class="ev-upsell-name">${esc(
          u.name.trim(),
        )}</span><span class="ev-upsell-price">${esc(priced)}</span></div>`
        })
        .join('')}
      </div>`
    : ''
  // 1B splits the advisory notes across two columns: the surge-protection note
  // fills the left, the switchboard note and the priced rows stack on the right.
  return `
  ${sectionHead('02', 'Optional Upgrades &amp; Recommendations')}
  <div class="ev-upgrades">
    <div>${note(EV_SURGE_PROTECTION_NOTE)}</div>
    <div class="ev-upgrades-right">${note(EV_SWITCHBOARD_CAPACITY_NOTE)}${upsellHtml}</div>
  </div>`
}

function imagesSection(images: EvEstimateImage[]): string {
  if (images.length === 0) return ''
  // 1B gives the image the full text column rather than a 280px-capped figure
  // in a flex row. Full-bleed images are direction 1C, not this one.
  return `
  ${sectionHead('03', 'Images')}
  ${images
    .map(
      (img) => `
  <img class="ev-image" src="${esc(img.src)}" alt="${esc(img.caption ?? 'Job image')}">`,
    )
    .join('')}`
}

/**
 * A numbered section head — the design system's own Part-marker vocabulary,
 * reused for the four top-level sections (01 Scope of Work, 02 Optional
 * Upgrades, 03 Images, 04 Terms). `headingHtml` is HTML, not text: the
 * Optional Upgrades title carries a literal `&amp;`.
 *
 * The numbers are not decoration — they are the reading order of an estimate,
 * and only these four sections carry one. The nested Description / Assumptions
 * subheads stay unnumbered so the hierarchy still reads as two levels.
 */
function sectionHead(index: string, headingHtml: string): string {
  return `<div class="ev-secthead"><span class="ev-marker">${esc(
    index,
  )}</span><h2>${headingHtml}</h2></div>`
}

/**
 * The full-bleed white summary band: estimate number + ESTIMATE, Prepared For
 * and Site Address on the left, the ink hero Total and Proposal Details on the
 * right. Replaces the chrome's rule + intro block wholesale (R2/R3/R6/R7).
 *
 * `totalLabel` is the already-formatted grand total from evTotals(), so the
 * hero figure and the totals block can never disagree. Null when there is no
 * priced tier — the panel is then omitted rather than printing $0.00.
 *
 * Omits any line with no value, and the whole Prepared For column when nothing
 * at all is known.
 */
function summaryBand(
  input: EvChargerEstimateInput,
  issued: Date,
  totalLabel: string | null,
): string {
  const preparedLines = dedupeStrings([
    input.customerEmail,
    input.customerPhone,
  ]).map((s) => `<div class="ev-meta-line">${esc(s)}</div>`)
  const name = (input.customerName ?? '').trim()
  const preparedFor =
    name || preparedLines.length
      ? `
        <div>
          <div class="ev-meta-label">Prepared For:</div>
          ${name ? `<div class="ev-meta-name">${esc(name)}</div>` : ''}
          ${preparedLines.join('')}
        </div>`
      : ''
  const site = input.siteAddress
    ? `
        <div>
          <div class="ev-meta-label">Site Address</div>
          <div class="ev-meta-line ev-meta-line-sub">${esc(input.siteAddress)}</div>
        </div>`
    : ''
  const bandMeta =
    preparedFor || site ? `<div class="ev-band-meta">${preparedFor}${site}</div>` : ''

  const totalPanel = totalLabel
    ? `
        <div class="ev-total-panel">
          <div class="ev-total-panel-label">Total:</div>
          <div class="ev-total-panel-fig">${esc(totalLabel)}</div>
        </div>`
    : ''

  return `
  <div class="ev-band">
    <div class="ev-band-row">
      <div>
        <div class="ev-eyebrow">${esc(input.estimateRef)}</div>
        <div class="ev-title">ESTIMATE</div>
        ${bandMeta}
      </div>
      <div class="ev-band-right">
        ${totalPanel}
        <div class="ev-details">
          <div class="ev-meta-label">Proposal Details:</div>
          <div class="ev-details-list">
            <div><strong>Date:</strong> ${esc(fmtDate(issued))}</div>
            <div><strong>Valid Until:</strong> ${esc(
              fmtDate(addDays(issued, EV_ESTIMATE_VALID_DAYS)),
            )}</div>
            ${
              input.estimatedTimeframe
                ? `<div><strong>Est. timeframe:</strong> ${esc(input.estimatedTimeframe)}</div>`
                : ''
            }
          </div>
        </div>
      </div>
    </div>
  </div>`
}

/** EV-only styling for direction 1B "Numbered & banded", contributed through
 *  the body slot so the shared chrome needs no new CSS file (R2). Tokens only
 *  — no new colours, no new fonts.
 *
 *  FULL-BLEED: the chrome's `body` has no horizontal padding, so the two bands
 *  (`.ev-band`, `.ev-accept`) reach the 7.27in content edge simply by carrying
 *  their own 30px insets, and everything else is wrapped in `.ev-body`, which
 *  supplies the document's 30px sides. No negative margins, no calc() — the
 *  width contract that lets Gotenberg measure one continuous page is untouched.
 */
const EV_STYLE = `
<style>
  /* Header — logo cap tightened from the chrome's 60px so the four contact
     lines stop out-weighing it; the ABN line becomes a mono micro-label. */
  .brand .logo{ max-height:52px; max-width:205px; }
  .head-meta{ font-size:10.5px; color:var(--sec); line-height:1.5; }
  /* The chrome's body carries no horizontal padding, so its header sits flush
     at x=0. Give the header the same 30px inset .ev-body uses, or the logo
     hangs 30px to the left of every heading beneath it. */
  header{ padding:0 30px; }

  /* ── Full-bleed white summary band (replaces the chrome's intro block) ── */
  .ev-band{ margin-top:20px; background:var(--card); border-top:3px solid var(--accent);
    border-bottom:1px solid var(--line); padding:18px 30px 20px; }
  .ev-band-row{ display:flex; justify-content:space-between; align-items:flex-start; gap:28px; }
  .ev-eyebrow{ font-family:'JetBrains Mono','Courier New',monospace; font-size:9px;
    letter-spacing:0.2em; text-transform:uppercase; color:var(--dim); }
  .ev-title{ font-size:34px; font-weight:800; text-transform:uppercase;
    letter-spacing:-0.035em; line-height:1; margin:3px 0 0; color:var(--pri); }
  .ev-band-meta{ display:flex; gap:24px; margin-top:16px; }
  .ev-band-right{ flex:none; text-align:right; }
  .ev-meta-label{ font-family:'JetBrains Mono','Courier New',monospace; font-size:9px;
    letter-spacing:0.16em; text-transform:uppercase; color:var(--pri); font-weight:600; }
  .ev-meta-name{ font-weight:800; font-size:12px; margin-top:3px; color:var(--pri); }
  .ev-meta-line{ font-size:11px; color:var(--sec); }
  .ev-meta-line-sub{ margin-top:3px; }

  /* Hero total — the same figure the totals block prints, never a second sum. */
  .ev-total-panel{ background:var(--pri); color:var(--paper); padding:12px 16px 14px; }
  .ev-total-panel-label{ font-family:'JetBrains Mono','Courier New',monospace; font-size:9px;
    letter-spacing:0.18em; text-transform:uppercase; color:var(--accent); }
  .ev-total-panel-fig{ font-family:'JetBrains Mono','Courier New',monospace;
    font-variant-numeric:tabular-nums; font-size:30px; font-weight:600;
    letter-spacing:-0.03em; line-height:1.1; margin-top:3px; }
  .ev-details{ margin-top:10px; }
  .ev-details-list{ display:grid; gap:1px; margin-top:3px; font-size:11px; color:var(--sec); }
  .ev-details-list strong{ color:var(--pri); }

  /* ── The 30px document body every non-bleeding block sits in ── */
  .ev-body{ padding:0 30px; }

  /* Numbered section heads (01-04) */
  .ev-secthead{ display:flex; align-items:center; gap:12px; margin:26px 0 10px; }
  .ev-marker{ font-family:'JetBrains Mono','Courier New',monospace; font-weight:600;
    font-size:16px; line-height:1; color:var(--accent-ink); background:var(--accent);
    padding:7px 10px; min-width:38px; text-align:center; }
  .ev-secthead h2{ font-size:14px; font-weight:800; text-transform:uppercase;
    letter-spacing:0.01em; margin:0; color:var(--pri); }

  .ev-scope{ color:var(--sec); font-size:12px; margin:0; }
  .ev-sub{ font-size:11.5px; font-weight:800; text-transform:uppercase;
    letter-spacing:0.02em; color:var(--pri); margin:20px 0 8px; }

  /* NB: these comments ship inside the document, so none of them may repeat a
     section heading verbatim — the spec tests assert an omitted section's
     heading is absent from the whole HTML, and a comment would satisfy the
     search and hide a genuinely missing section.

     The works list — the 1px grid gap over --line IS the divider. */
  .ev-hairlist{ display:grid; gap:1px; background:var(--line); border:1px solid var(--line); }
  .ev-hairlist > div{ background:var(--card); padding:8px 13px; font-size:11.5px; color:var(--sec); }

  /* What we assume — 5x5 accent squares, optically aligned to the first line. */
  ul.ev-assume{ list-style:none; margin:0; padding:0; display:grid; gap:6px; }
  ul.ev-assume li{ display:flex; gap:9px; font-size:11.5px; color:var(--sec); }
  ul.ev-assume li .mark{ flex:none; width:5px; height:5px; background:var(--accent); margin-top:7px; }

  /* What's in / what's out, as facing cards; what is OUT reads as clearly as
     what is IN. Only the card top border and heading carry the flag colour. */
  .ev-cards{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:20px; }
  /* Only one of the two present (an estimate with no exclusions is common) —
     it takes the full width rather than sitting beside an empty column. */
  .ev-cards-one{ grid-template-columns:1fr; }
  .ev-card{ border:1px solid var(--line); background:var(--card); padding:12px 14px; }
  .ev-card-inc{ border-top:3px solid var(--accent); }
  .ev-card-exc{ border-top:3px solid #B45309; }
  .ev-card h3{ font-size:11.5px; font-weight:800; text-transform:uppercase;
    letter-spacing:0.02em; margin:0 0 9px; color:var(--pri); }
  .ev-card-exc h3{ color:#B45309; }
  .ev-card ul{ list-style:none; margin:0; padding:0; display:grid; gap:7px; }
  .ev-card li{ font-size:11px; color:var(--sec); padding-left:14px; border-left:2px solid var(--line); }
  .ev-card-inc li{ border-left-color:var(--accent); }

  /* Optional upgrades — advisory notes left, notes + priced rows right. */
  .ev-upgrades{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .ev-upgrades-right{ display:grid; gap:12px; align-content:start; }
  .ev-note{ border:1px solid var(--line); background:var(--card); padding:12px 14px; }
  .ev-upgrade-title{ font-family:'JetBrains Mono','Courier New',monospace; font-size:9px;
    letter-spacing:0.16em; text-transform:uppercase; color:var(--pri); font-weight:600;
    margin-bottom:5px; }
  .ev-note p{ color:var(--sec); font-size:11px; margin:0; }
  .ev-upsells{ display:grid; gap:1px; background:var(--line); border:1px solid var(--line); }
  .ev-upsell{ display:flex; justify-content:space-between; align-items:baseline; gap:10px;
    background:var(--card); padding:9px 13px; }
  .ev-upsell-name{ font-size:11px; font-weight:700; color:var(--pri); }
  .ev-upsell-price{ font-family:'JetBrains Mono','Courier New',monospace;
    font-variant-numeric:tabular-nums; font-size:11px; font-weight:600; white-space:nowrap; }

  /* Phase card — the tables AND the totals live in one white card. */
  .ev-phase{ border:1px solid var(--line); background:var(--card); padding:14px 16px;
    margin-top:22px; page-break-inside:avoid; }
  .ev-phase-title{ font-size:12px; font-weight:800; text-transform:uppercase;
    letter-spacing:-0.01em; margin:0 0 10px; color:var(--pri); }
  .ev-phase table + .ev-phase-title{ margin-top:20px; }
  .ev-phase table{ width:100%; border-collapse:collapse; }
  .ev-phase th{ font-family:'JetBrains Mono','Courier New',monospace; font-size:9px;
    font-weight:600; letter-spacing:0.12em; text-transform:uppercase; color:var(--dim);
    border-bottom:2px solid var(--pri); text-align:left; padding:0 8px 6px 0; }
  .ev-phase th.num{ text-align:right; padding:0 8px 6px; white-space:nowrap; }
  .ev-phase th.num-last{ text-align:right; padding:0 0 6px 8px; white-space:nowrap; }
  .ev-phase td{ border-bottom:1px solid var(--line); padding:9px 8px 9px 0;
    vertical-align:top; font-size:11px; color:var(--pri); }
  .ev-phase td.num{ padding:9px 8px; text-align:right; white-space:nowrap;
    font-family:'JetBrains Mono','Courier New',monospace; font-variant-numeric:tabular-nums;
    color:var(--sec); }
  .ev-phase td.num-last{ padding:9px 0 9px 8px; text-align:right; white-space:nowrap;
    font-family:'JetBrains Mono','Courier New',monospace; font-variant-numeric:tabular-nums;
    font-weight:600; color:var(--pri); }
  .ev-group-total td{ border-bottom:none; border-top:2px solid var(--pri);
    font-family:'JetBrains Mono','Courier New',monospace; font-size:10px; letter-spacing:0.1em;
    text-transform:uppercase; font-weight:600; text-align:right; padding:9px 8px 0 0;
    color:var(--pri); }
  .ev-group-total td.num-last{ font-size:13px; letter-spacing:normal; text-transform:none;
    padding:9px 0 0 8px; }

  /* Totals nested in the same card, right-aligned. */
  .ev-totals-wrap{ display:flex; justify-content:flex-end; margin-top:16px; }
  .ev-totals{ min-width:290px; }
  .ev-total-row{ display:flex; justify-content:space-between; gap:16px; padding:6px 0;
    border-bottom:1px solid var(--line); font-size:11.5px; }
  .ev-total-row .ev-total-label{ color:var(--sec); }
  .ev-total-row .num{ font-family:'JetBrains Mono','Courier New',monospace;
    font-variant-numeric:tabular-nums; color:var(--pri); }
  .ev-grand{ display:flex; justify-content:space-between; align-items:baseline; gap:16px;
    margin-top:8px; padding:11px 13px; background:var(--pri); color:var(--paper); }
  .ev-grand-label{ font-family:'JetBrains Mono','Courier New',monospace; font-size:10px;
    letter-spacing:0.16em; text-transform:uppercase; color:var(--accent); font-weight:600; }
  .ev-grand .num{ font-family:'JetBrains Mono','Courier New',monospace;
    font-variant-numeric:tabular-nums; font-size:20px; font-weight:600; letter-spacing:-0.02em; }

  .ev-tier-heading{ margin-top:22px; }

  /* Images span the text column (full-bleed images are direction 1C). */
  .ev-image{ width:100%; height:320px; object-fit:cover; object-position:50% 60%;
    display:block; border:1px solid var(--line); }

  /* Terms — two columns, the GST/currency line spanning both. */
  .ev-terms{ border:1px solid var(--line); background:var(--card); padding:14px 16px; }
  .ev-terms-grid{ display:grid; grid-template-columns:1fr 1fr; gap:8px 20px; }
  .ev-terms-grid > div{ font-size:11px; color:var(--sec); }
  .ev-terms-span{ grid-column:1 / -1; }

  /* Full-bleed accept band. The chrome's global link colour must not leak. */
  .ev-accept{ margin-top:22px; background:var(--accent); color:var(--accent-ink);
    padding:14px 30px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .ev-accept-line{ font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:0.02em; }
  .ev-accept-url{ font-family:'JetBrains Mono','Courier New',monospace; font-size:10.5px;
    margin-top:3px; word-break:break-all; color:var(--accent-ink); }
  .ev-accept a{ color:var(--accent-ink); text-decoration:none; }
  .ev-accept-total{ font-family:'JetBrains Mono','Courier New',monospace;
    font-variant-numeric:tabular-nums; font-size:18px; font-weight:600; white-space:nowrap; }

</style>`

/**
 * The EV charger estimate, as one self-contained HTML document.
 *
 * Pure and deterministic: with a fixed `generatedAt`, two calls return
 * identical strings.
 */
export function buildEvChargerEstimateHtml(input: EvChargerEstimateInput): string {
  const issued = input.generatedAt ?? new Date(0)
  const branding = input.branding ?? brandingFromName(input.businessName)
  const gstRegistered = input.gstRegistered ?? true
  const tiers = visibleTiers(input)
  const showTierLabels = tiers.length > 1

  const description = dedupeStrings(input.descriptionOfWorks ?? [])
  const assumptions = dedupeStrings(input.assumptions ?? [])
  const inclusions = deriveEvInclusions(input)
  const exclusions = deriveEvExclusions(input)
  const images = (input.images ?? []).filter((i) => (i?.src ?? '').trim())

  const scopeLead = (input.scopeOfWorks ?? '').trim()

  // The hero total mirrors the FIRST visible tier — the one the customer reads
  // as "the price" when tiers are collapsed to one, and the top of the ladder
  // when they are not. Null when nothing is priced, so the panel is omitted
  // rather than printing $0.00.
  const heroTier = tiers[0]?.tier ?? null
  const heroTotal = heroTier
    ? aud2(
        evTotals(heroTier, {
          discountPct: input.appliedDiscountPct,
          gstRegistered: input.gstRegistered,
        }).total,
      )
    : null

  const terms = evEstimateTerms(gstRegistered)
  // The GST/currency basis is the last term and spans both columns — it
  // qualifies every line above it, so it must not read as one more item.
  const termsHtml = terms
    .map(
      (t, i) =>
        `<div${i === terms.length - 1 ? ' class="ev-terms-span"' : ''}>${esc(t)}</div>`,
    )
    .join('')

  const acceptBand = input.quoteViewUrl
    ? `
  <div class="ev-accept">
    <div>
      <div class="ev-accept-line">View and accept this estimate online</div>
      <div class="ev-accept-url">${esc(input.quoteViewUrl)}</div>
    </div>
    ${heroTotal ? `<div class="ev-accept-total">${esc(heroTotal)}</div>` : ''}
  </div>`
    : ''

  const body = `
${EV_STYLE}
  <div class="ev-body">
  ${sectionHead('01', 'Scope of Work')}
  ${scopeLead ? `<p class="ev-scope">${esc(scopeLead)}</p>` : ''}
  ${
    description.length
      ? `<h3 class="ev-sub">Description of Works</h3>
  <div class="ev-hairlist">${description.map((d) => `<div>${esc(d)}</div>`).join('')}</div>`
      : ''
  }
  ${
    assumptions.length
      ? `<h3 class="ev-sub">Assumptions</h3>
  <ul class="ev-assume">${assumptions
    .map((a) => `<li><span class="mark"></span><span>${esc(a)}</span></li>`)
    .join('')}</ul>`
      : ''
  }
  ${
    inclusions.length || exclusions.length
      ? `<div class="ev-cards${inclusions.length && exclusions.length ? '' : ' ev-cards-one'}">
    ${
      inclusions.length
        ? `<div class="ev-card ev-card-inc"><h3>Inclusions</h3><ul>${inclusions
            .map((i) => `<li>${esc(i)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
    ${
      exclusions.length
        ? `<div class="ev-card ev-card-exc"><h3>Exclusions</h3><ul>${exclusions
            .map((e) => `<li>${esc(e)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
  </div>`
      : ''
  }
  ${optionalUpgradesSection(input)}
  ${tiers.map((entry) => tierBlock(input, entry, showTierLabels)).join('')}
  ${imagesSection(images)}
  ${sectionHead('04', 'Terms &amp; Conditions')}
  <div class="ev-terms"><div class="ev-terms-grid">${termsHtml}</div></div>
  </div>`

  return renderReportDocument(branding, {
    docTitle: `Estimate ${input.estimateRef} — ${branding.businessName}`,
    titleText: 'ESTIMATE',
    eyebrow: input.estimateRef,
    // 1B replaces the chrome's rule + intro block with the full-bleed band, and
    // the closing line with the accent accept band. Both must reach the document
    // edges, which nothing nested inside those wrappers can do.
    introBlockHtml: summaryBand(input, issued, heroTotal),
    closingHtml: acceptBand || null,
    dateLabel: fmtDate(issued),
    bodyHtml: body,
    footerPriceNote: gstRegistered ? 'Prices include GST' : 'Prices are not subject to GST',
  })
}
