// Random variant picker — used by templates that have multiple wording
// options. Picking one at random per send (rather than rotating) keeps
// the customer-facing thread feeling more human-typed without needing
// to track conversation state. Each customer typically only sees ONE
// instance of any given template per conversation, so the variation is
// noticeable across customers, not within a single thread.
import { priceHoldStatus, fmtHoldUntilAU } from '@/lib/quote/hold'
import { asQuoteDisplayMode, type QuoteDisplayMode } from '@/lib/quote/display'
import { asQuoteTierMode, resolveVisibleTiers, type QuoteTierMode } from '@/lib/quote/tier-visibility'
import {
  INSPECTION_FEE_AUD,
  MIN_STRIPE_CHARGE_CENTS,
  asMoneyNumber,
  PLATFORM_FEE_PCT,
  chargedCents,
  clampDepositPct,
  depositCents,
  finalBalanceBaseCents,
  finalDepositBaseCents,
  totalIncGstCents,
} from '@/lib/quote/money'
import { isSiteVisitFirstRow } from '@/lib/quote/mint-tier'
import { formatQuoteAmount, quoteAmount } from '@/lib/quote/display-money'

/** Phase A — caller-supplied display mode flag. 'summary' suppresses the
 *  per-tier "X items + Yhr labour" component line so the SMS reads as a
 *  cleaner lump-sum option list. Defaults to 'itemised' (today's
 *  behaviour) when no value is passed — back-compat for any caller that
 *  doesn't yet thread this through. */
export interface QuoteSmsOptions {
  displayMode?: QuoteDisplayMode
  /** Mig 142 — per-feature tier presentation mode. Controls WHICH tiers the
   *  customer SMS lists. Internal fallback is 'good_better_best' (all priced
   *  tiers) when omitted, so callers that don't thread it keep the legacy
   *  behaviour; production callers pass the tenant's resolved pricing_book
   *  mode (which defaults to 'single'). */
  tierMode?: QuoteTierMode
  /** RAW `intakes.trade` for this quote. Electrical + plumbing sell only the
   *  flat $99 refundable site inspection (spec elec-plumb-site-visit-first
   *  R5), so their message keeps the tier PRICES but drops the per-tier
   *  deposit amount + pay link and carries one $99 line instead. Every other
   *  trade — and an unthreaded/unresolvable trade — keeps today's per-tier
   *  deposit shape: the allowlist fails open exactly like the mint route. */
  trade?: string | null
  /** quotes.quote_kind (spec post-visit-money-sequence R6/R9). A 'final' row
   *  shares its parent's electrical/plumbing intake, so the `trade` gate above
   *  would otherwise fire on it and text the customer a SECOND $99 site-visit
   *  link for a job already visited. 'final' takes a dedicated message shape:
   *  one confirmed price, the deposit less the $99 credit, the platform fee,
   *  and the balance to come. Omitted → 'initial' → today's behaviour. */
  quoteKind?: string | null
  /** Tenant business name — signs off the final-quote message. */
  businessName?: string | null
}

function pickVariant<T>(variants: readonly T[]): T {
  return variants[Math.floor(Math.random() * variants.length)]
}

// WP6 — appends a "Price held until <date>" urgency line to a quote SMS.
// Strictly conditional on quote.price_hold_until being set, so legacy
// quotes and the SMS-parity fixture (which omit the field) are unchanged
// — this is purely additive and cannot regress existing parity asserts.
function pushPriceHoldLine(lines: string[], holdUntil: string | null | undefined): void {
  if (!holdUntil) return
  const h = priceHoldStatus(holdUntil)
  if (h.state === 'held') {
    lines.push(`Price held until ${fmtHoldUntilAU(h.holdUntil)} - lock in a tier to secure it.`)
    lines.push('')
  } else if (h.state === 'expired') {
    lines.push(`Heads up: this price expired ${fmtHoldUntilAU(holdUntil)} - reply for a fresh quote.`)
    lines.push('')
  }
}

/**
 * The ONE payment line for a site-visit-first trade (electrical + plumbing,
 * spec elec-plumb-site-visit-first R5). Worded verbatim like
 * buildInspectionQuoteSms and painting's buildPaintingQuoteSms so all three
 * trades promise the customer exactly the same thing.
 *
 * `/r/<token>/inspection` mints a fresh $99 Session per click and needs no
 * stored stripe_links.inspection, so the caller can always supply it; the
 * link-less fallback exists only for a caller that couldn't build a URL.
 */
function pushSiteVisitLines(lines: string[], inspectionUrl: string | null | undefined): void {
  if (inspectionUrl) {
    lines.push('Tap to lock in your site visit ($99 refundable, credited toward your final quote):')
    lines.push(inspectionUrl)
  } else {
    lines.push('Call us back to lock in a site visit ($99 refundable, credited toward your final quote).')
  }
  lines.push('')
}

/** Capitalise the first character of a string for use mid-sentence. */
function capitaliseFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Quote-updated SMS — fired when the tradie edits a quote via the
 * /q/<token> edit overlay and chooses to notify the customer.
 *
 * Same shape as buildQuoteSms (tier breakdown with prices, plus either the
 * per-tier deposit amounts + Stripe pay links or — for a site-visit-first
 * trade — the single $99 line) so the customer sees the latest numbers
 * without having to open the quote page first.
 *
 * Lead line differs from the original quote SMS — "Quick update from
 * your tradie" / "Your tradie revised your quote" — so the customer
 * understands this is a refresh, not a duplicate of the original send.
 *
 * Multi-segment is expected here (the full quote with three tier
 * breakdowns rarely fits in 160 chars). The trade-off is intentional:
 * the customer should be able to see the new prices in their notification
 * preview, not have to tap a link first.
 */
export function buildQuoteUpdatedSms(intake: Intake, quote: Quote, options?: QuoteSmsOptions): string {
  // Inspection-required quotes use the dedicated inspection layout but
  // still get an "updated" preamble so the customer knows the tradie
  // touched the quote.
  if (quote.needs_inspection) {
    return buildInspectionQuoteUpdatedSms(intake, quote)
  }
  const displayMode = asQuoteDisplayMode(options?.displayMode, 'itemised')
  // Electrical/plumbing: prices stay, the deposit ask goes (see the option docs).
  const siteVisitFirst = isSiteVisitFirstRow({
    trade: options?.trade,
    quoteKind: options?.quoteKind,
  })

  const firstName = (intake.caller?.name ?? '').split(' ')[0] || 'there'
  const timeframe = (quote.estimated_timeframe ?? '').toLowerCase().trim()
  const depositPct = typeof quote.deposit_pct === 'string' ? parseFloat(quote.deposit_pct) : (quote.deposit_pct ?? 0)
  const hasPayLinks = !!quote.pay_links && Object.values(quote.pay_links).some(Boolean)

  const leadVariants = [
    `Quick update from your tradie — your quote has been revised.`,
    `Your tradie just tweaked your quote. Here are the latest numbers.`,
    `Update: your tradie has refreshed your quote.`,
  ]

  const lines: string[] = []
  lines.push(`Hi ${firstName},`)
  lines.push('')
  lines.push(pickVariant(leadVariants))
  if (timeframe) {
    lines.push(`Estimated timeframe: ${timeframe}.`)
  }
  lines.push('')
  if (quote.quote_view_url) {
    lines.push(`View full quote: ${quote.quote_view_url}`)
    if (quote.pdf_url) lines.push(`PDF copy: ${quote.pdf_url}`)
    lines.push('')
  } else if (quote.pdf_url) {
    lines.push(`PDF copy: ${quote.pdf_url}`)
    lines.push('')
  }

  // Mig 142/146 — list only the tiers this feature's mode surfaces to the
  // customer. Internal fallback 'single' matches the platform default (and the
  // PDF + quote page), so a caller that doesn't thread a mode shows one option
  // rather than the full Good/Better/Best list.
  const visibleTierKeys = resolveVisibleTiers({
    mode: asQuoteTierMode(options?.tierMode, 'single'),
    present: { good: !!quote.good, better: !!quote.better, best: !!quote.best },
    selectedTier: quote.selected_tier ?? null,
  })
  const visibleTierSet = new Set<'good' | 'better' | 'best'>(visibleTierKeys)
  const tierCount = visibleTierKeys.length
  const heading =
    tierCount === 1 ? 'YOUR OPTION' :
    tierCount === 2 ? '2 OPTIONS' :
    tierCount === 3 ? '3 OPTIONS' :
    'YOUR OPTIONS'
  const taxLabel = quote.gst_registered === false ? 'No GST' : 'inc 10% GST'
  if (hasPayLinks && depositPct > 0 && !siteVisitFirst) {
    lines.push(`${heading} (${taxLabel} - ${depositPct}% deposit to confirm):`)
  } else {
    lines.push(`${heading} (${taxLabel}):`)
  }
  lines.push('')

  for (const key of ['good', 'better', 'best'] as const) {
    const tier = quote[key]
    // Mig 142 — skip tiers the resolved mode hides.
    if (!tier || !visibleTierSet.has(key)) continue
    const incCents = totalIncGstCents(tier.subtotal_ex_gst, {
      discountPct: quote.applied_discount_pct,
      gstRegistered: quote.gst_registered,
    })
    const price = formatQuoteAmount(quoteAmount(incCents))
    const depCents = depositCents(incCents, depositPct)
    const deposit = depCents > 0 ? formatQuoteAmount(quoteAmount(depCents)) : null
    // No "recommended" badge when only one option is shown — it IS the offer.
    const recommended = visibleTierKeys.length > 1 && quote.selected_tier === key ? ' (recommended)' : ''

    // Site-visit-first trades keep the PRICE and lose the deposit ask.
    const headerSuffix = deposit && !siteVisitFirst ? ` (deposit $${deposit})` : ''
    lines.push(`${key.toUpperCase()}: $${price}${recommended}${headerSuffix}`)

    const label = tierLabel(tier)
    if (label) lines.push(`- ${label}`)
    if (displayMode !== 'summary') {
      const comps = tierComponents(tier, intake.job_type, intake.scope?.item_count)
      if (comps) lines.push(`- ${comps}`)
    }

    // No per-tier pay link for a site-visit-first trade — the ONE payment
    // line is pushed after the loop.
    const payUrl = siteVisitFirst ? null : quote.pay_links?.[key]
    if (payUrl) lines.push(`Tap to pay: ${payUrl}`)

    lines.push('')
  }

  if (siteVisitFirst) {
    // The ONE payment. The price-hold line is suppressed with it: the $99 has
    // no hold, and its "lock in a tier to secure it" wording promises a deposit
    // these trades no longer take.
    pushSiteVisitLines(lines, quote.pay_links?.inspection)
  } else {
    pushPriceHoldLine(lines, quote.price_hold_until)
  }

  lines.push('Reply or call back if anything looks off.')
  lines.push('')
  lines.push('- QuoteMax')

  return gsm7Safe(lines.join('\n'))
}

function buildInspectionQuoteUpdatedSms(intake: Intake, quote: Quote): string {
  const firstName = (intake.caller?.name ?? '').split(' ')[0] || 'there'
  const inspectionUrl = quote.pay_links?.inspection
  const lines: string[] = []
  lines.push(`Hi ${firstName},`)
  lines.push('')
  lines.push(`Your tradie has updated your quote. It still needs a quick site visit before a final price.`)
  lines.push('')
  if (quote.quote_view_url) {
    lines.push(`View full quote: ${quote.quote_view_url}`)
    lines.push('')
  }
  if (inspectionUrl) {
    lines.push('Tap to lock in your site visit ($99 refundable, credited toward your final quote):')
    lines.push(inspectionUrl)
  } else {
    lines.push('Call us back to lock in the site visit.')
  }
  lines.push('')
  lines.push('- QuoteMax')
  return gsm7Safe(lines.join('\n'))
}

// ════════════════════════════════════════════════════════════════════
// SMS-initiated tradie onboarding templates.
// ════════════════════════════════════════════════════════════════════

/**
 * Welcome SMS sent on turn 1 when the intent classifier flags
 * tradie_registration. Single segment when appUrl is short.
 */
export function buildTradieWelcomeSms(opts: {
  appUrl: string
  token: string
  code?: string
}): string {
  const link = `${opts.appUrl}/signup?intent=${opts.token}${opts.code ? `&code=${encodeURIComponent(opts.code)}` : ''}`
  const body =
    `G'day! Welcome to QuoteMax. Tap the link to set up your AI receptionist. ` +
    `Takes about 4 minutes.\n\n${link}\n\nYour mobile is already saved.\n\n- QuoteMax`
  return gsm7Safe(body)
}

/**
 * Reminder SMS sent if the tradie texts again before finishing the
 * web onboarding. Same link, gentler nudge.
 */
export function buildTradieIntentStillOpenSms(opts: {
  appUrl: string
  token: string
  code?: string
}): string {
  const link = `${opts.appUrl}/signup?intent=${opts.token}${opts.code ? `&code=${encodeURIComponent(opts.code)}` : ''}`
  const body =
    `Still got your signup link open? Tap it here:\n\n${link}\n\n` +
    `Replies here won't progress your signup — finish on the web.\n\n- QuoteMax`
  return gsm7Safe(body)
}

/**
 * Sent when a previous token has expired and the tradie re-texts.
 * (Tells them the new link is already in this same message — token
 * generated by the caller and slotted in.)
 */
export function buildTradieIntentExpiredSms(opts: {
  appUrl: string
  token: string
}): string {
  const link = `${opts.appUrl}/signup?intent=${opts.token}`
  const body =
    `Your earlier signup link expired (24h). Fresh one:\n\n${link}\n\n- QuoteMax`
  return gsm7Safe(body)
}

// ════════════════════════════════════════════════════════════════════
// Tradie-side notifications (Phase 4 / notify) — fire when an SMS-sourced
// quote drafts. Two flavours:
//   • buildTradieDraftNotification — for auto-quote drafts (good/better/best)
//   • buildTradieInspectionNotification — for inspection-required quotes ($99)
// Both are GSM-7 safe ASCII so they fit in a single SMS segment whenever
// possible. They go to the tradie's mobile + WhatsApp simultaneously.
// ════════════════════════════════════════════════════════════════════
// Shared GSM-7 ASCII scrub for both tradie templates. Long dashes, smart
// quotes, ellipsis, and middot render as boxes on older Android phones,
// so we normalise them to safe ASCII before sending.
function scrubForGsm7(text: string): string {
  return text
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7E\n]/g, '')
}

/** R5(c) — one wording for the "we only know this from an older job" address,
 *  used by every tradie notification. Labelled on purpose: presenting it as
 *  the job site is what sent a tradie toward the wrong house on 2026-09-01. */
function rememberedAddressLine(
  rememberedAddress?: string | null,
  noAddressOnFile?: boolean,
): string {
  const a = (rememberedAddress ?? '').trim()
  if (a) return `\nAddress from customer records (confirm on site): ${a}`
  // Silence reads as "nothing to worry about". A job with NO address anywhere
  // is exactly the one a tradie must chase before they set off.
  return noAddressOnFile ? '\nNo address provided - confirm with the customer.' : ''
}

export function buildTradieDraftNotification(opts: {
  /** R5(c) — address on the customer record when THIS conversation produced
   *  none. Always labelled: it may belong to an older, unrelated job. */
  rememberedAddress?: string | null
  /** True when NO address is known from anywhere — the customer declined and
   *  the record is empty. Said out loud so the tradie chases it. */
  noAddressOnFile?: boolean
  tradieFirstName?: string | null
  customerName?: string
  customerPhone?: string
  jobType: string
  itemCount?: number
  totalIncGst: number
  quoteUrl: string
  dashboardUrl?: string
}): string {
  const greet = opts.tradieFirstName ? `Hi ${opts.tradieFirstName}` : 'Hi'
  const who = opts.customerName?.split(' ')[0] || opts.customerPhone || 'a customer'
  const job = JOB_TYPE_LABEL[opts.jobType] ?? opts.jobType.replace(/_/g, ' ')
  const qty = opts.itemCount ? `${opts.itemCount} ${job}` : job
  const total = opts.totalIncGst.toFixed(0)
  const dashLine = opts.dashboardUrl ? `\nDashboard: ${opts.dashboardUrl}` : ''
  const body =
    `${greet}, ${who} has requested a quote - ${qty}, $${total} inc GST drafted and ready to review.\n` +
    `Quote: ${opts.quoteUrl}${dashLine}` +
    rememberedAddressLine(opts.rememberedAddress, opts.noAddressOnFile)
  return scrubForGsm7(body)
}

/**
 * Dialog-first web lead — "new web lead arrived" alert to the tradie, fired the
 * moment a /t/<slug> form is submitted. The customer is being texted to finalise
 * the quote; this guarantees the tradie hears about a hot lead even if the
 * customer never replies. Kept ≤320 chars (1-2 SMS segments).
 */
export function buildTradieWebLeadAlert(opts: {
  tradieFirstName?: string | null
  customerName: string
  suburb: string
  description: string
}): string {
  const hi = opts.tradieFirstName?.trim() ? `Hi ${opts.tradieFirstName.trim()}, ` : ''
  const who = opts.customerName.split(' ')[0] || opts.customerName
  const desc = opts.description.trim().replace(/\s+/g, ' ').slice(0, 140)
  const body =
    `${hi}new web lead - ${who} in ${opts.suburb}: "${desc}". ` +
    `We're texting them now to finalise the quote. - QuoteMax`
  return scrubForGsm7(body).slice(0, 320)
}

/**
 * Mig 078 — tradie review-before-send notification.
 *
 * Sent INSTEAD of `buildTradieDraftNotification` when the tenant's
 * review_policy holds the quote (always_review, or
 * review_over_threshold with total >= threshold). The customer SMS
 * does NOT fire on this path — it waits for the tradie to tap the
 * approve link.
 *
 * The two URLs in the body cover the two actions a tradie takes here:
 *   • approveUrl  — one-tap "send to customer now"
 *   • editUrl     — open the existing /q/<token> edit overlay first,
 *                   then approve from there
 */
export function buildTradieReviewNotification(opts: {
  tradieFirstName?: string | null
  customerName?: string
  customerPhone?: string
  jobType: string
  itemCount?: number
  totalIncGst: number
  approveUrl: string
  editUrl: string
  policyReason?: string | null
  /** R3.2 — descriptions of the line items that failed grounding. Named in
   *  the text so the tradie knows what to look at before approving, instead
   *  of opening the quote to find out why it was held. */
  groundingFailureDescriptions?: string[]
  /** R5(c) — the address on the customer record when THIS conversation never
   *  produced one. Always labelled: it may be from an older, unrelated job. */
  rememberedAddress?: string | null
  /** See buildTradieDraftNotification. */
  noAddressOnFile?: boolean
}): string {
  const greet = opts.tradieFirstName ? `Hi ${opts.tradieFirstName}` : 'Hi'
  const job = JOB_TYPE_LABEL[opts.jobType] ?? opts.jobType.replace(/_/g, ' ')
  const qty = opts.itemCount ? `${opts.itemCount} ${job}` : job
  const total = opts.totalIncGst.toFixed(0)
  const groundingHeld = (opts.groundingFailureDescriptions ?? []).length > 0
  // Short reason chip — "over $500" reads cleaner than the policy slug
  const reasonChip = groundingHeld
    ? ' (price needs a check)'
    : opts.policyReason?.startsWith('total_')
      ? ' (over your threshold)'
      : opts.policyReason === 'tenant_policy_always_review'
        ? ' (review-all is on)'
        : ''
  const lines: string[] = [
    `${greet}, quote ready for your review${reasonChip} - ${qty}, $${total} inc GST.`,
  ]
  if (groundingHeld) {
    // Two names is enough to orient the tradie; the full list is on the quote.
    // Count from the ARRAY, never by re-splitting the joined string: a line
    // description containing ", " would otherwise be counted as two names and
    // the remainder under-reported (or hidden entirely).
    const all = (opts.groundingFailureDescriptions ?? [])
      .map((d) => String(d ?? '').trim())
      .filter(Boolean)
    const shown = all.slice(0, 2)
    const more = all.length - shown.length
    lines.push(
      `Check these line(s) before sending: ${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}.`,
    )
  }
  const addressLine = rememberedAddressLine(opts.rememberedAddress, opts.noAddressOnFile)
  if (addressLine) lines.push(addressLine.replace(/^\n/, ''))
  lines.push(`Tap to send: ${opts.approveUrl}`)
  lines.push(`Edit first: ${opts.editUrl}`)
  return scrubForGsm7(lines.join('\n'))
}

export function buildTradieInspectionNotification(opts: {
  /** R5(c) — see buildTradieDraftNotification. An inspection-routed job is the
   *  case MOST likely to lack an address, and a tradie cannot attend a suburb. */
  rememberedAddress?: string | null
  /** See buildTradieDraftNotification. */
  noAddressOnFile?: boolean
  tradieFirstName?: string | null
  customerName?: string
  customerPhone?: string
  jobType: string
  inspectionReason?: string | null
  quoteUrl: string
  dashboardUrl?: string
}): string {
  const greet = opts.tradieFirstName ? `Hi ${opts.tradieFirstName}` : 'Hi'
  const who = opts.customerName?.split(' ')[0] || opts.customerPhone || 'a customer'
  const job = JOB_TYPE_LABEL[opts.jobType] ?? opts.jobType.replace(/_/g, ' ')
  const reason = opts.inspectionReason ? ` (${opts.inspectionReason})` : ''
  const dashLine = opts.dashboardUrl ? `\nDashboard: ${opts.dashboardUrl}` : ''
  const body =
    `${greet}, ${who} has requested work that needs a site visit - ${job}${reason}. $99 inspection.\n` +
    `Details: ${opts.quoteUrl}${dashLine}` +
    rememberedAddressLine(opts.rememberedAddress, opts.noAddressOnFile)
  return scrubForGsm7(body)
}

// Intake-recovery SMS — used when the quality gate fires 'empty' but we
// can identify EXACTLY which field is missing (name vs suburb vs scope vs
// job_type). Instead of the generic "we didn't catch enough" wording, we
// ask the specific question so the customer can answer in one tap and
// the conversation continues naturally on their next reply.
//
// This is the SMS counterpart to the dialog agent's Rules 5/6 — it's a
// safety net for the case where Sonnet skipped the universal must-asks
// (e.g. on a returning-but-empty customer record) and reached 'finish'
// with a transcript that doesn't contain the customer's name/suburb.
//
// R28 (2026-06-18): 'count' added so a per-job STRUCTURED-field gap (e.g. a
// downlights intake that quality.ts downgraded to 'empty' purely because no
// count was captured) gets a focused "how many <fittings>?" question
// instead of falling through to the generic "describe the work" wording —
// which made the customer re-describe the job they'd already described,
// looping. See lib/intake/quality.ts missingRequiredFields().
export type MissingIntakeField = 'name' | 'suburb' | 'scope' | 'job_type' | 'count'

export function buildIntakeRecoverySms(opts: {
  firstName?: string
  missing: MissingIntakeField[]
  /** Trade of the tenant the customer texted. Drives the job_type recovery
   *  prompt so plumbing customers see plumbing options, not electrical
   *  ones. Defaults to electrical for legacy single-trade pilots. */
  trade?: 'electrical' | 'plumbing' | null
  /** Job type of the intake — drives the 'count' recovery question's noun
   *  ("How many downlights are we doing?"). Falls back to a trade-aware
   *  generic noun ("fittings"/"items") when absent or unknown. */
  jobType?: string | null
}): string {
  const first = (opts.firstName ?? '').split(' ')[0] || ''
  const trade = opts.trade ?? 'electrical'
  // No "Hi <name>" greeting when the missing field IS the name — would
  // be weird to address them by name and then ask for it.
  const named = first && !opts.missing.includes('name')

  // Pick the question for the FIRST missing field — keeps the SMS to a
  // single focused ask. The customer's reply will populate that field;
  // any remaining gaps get caught on the next pipeline pass.
  let variants: string[]

  if (opts.missing.includes('name')) {
    variants = [
      `Hi, just need one more thing before the quote lands. What's your first name?`,
      `Hi, quick one - what's your first name? Just need it for the quote.`,
      `Hi, can I grab your first name for the quote please?`,
      `Hi, what's your first name? Just so we can put it on the quote.`,
    ]
  } else if (opts.missing.includes('suburb')) {
    const lead = named ? `${first}, ` : ''
    variants = [
      `${lead}quick one - what suburb is the job in? Just need it to finalise.`,
      `${named ? `Cheers ${first}, ` : 'Cheers, '}where's the job - what suburb?`,
      `${lead}what suburb's the job at? Last bit and we're done.`,
      `${named ? `Hi ${first}, ` : 'Hi, '}can I grab the suburb please?`,
    ]
  } else if (opts.missing.includes('scope')) {
    const lead = named ? `${first}, ` : ''
    variants = [
      `${lead}can you give us a quick rundown of the work? Count, room, anything specific.`,
      `${named ? `Cheers ${first}, ` : 'Cheers, '}quick description of the job please - what's needed and where.`,
      `${named ? `Hi ${first}, ` : 'Hi, '}can you describe the work briefly? Count + room + any specifics.`,
    ]
  } else if (opts.missing.includes('job_type')) {
    const lead = named ? `${first}, ` : ''
    // Trade-aware option list: plumbing customers must NEVER see
    // "downlights / GPOs" — and electrical customers must NEVER see
    // "blocked drain / tap repair". Pre-trade-aware versions of this
    // template were hardcoded to the electrical easy-5.
    const optionsList = trade === 'plumbing'
      ? 'blocked drain, hot water, tap repair, tap replacement, toilet repair, or toilet replacement'
      : 'downlights, GPOs, ceiling fans, smoke alarms, or outdoor lighting'
    variants = [
      `${lead}what kind of work did you need? ${capitaliseFirst(optionsList)}?`,
      `${named ? `Cheers ${first}, ` : 'Cheers, '}which one are we quoting - ${optionsList}?`,
      `${named ? `Hi ${first}, ` : 'Hi, '}can I check what type of work? ${capitaliseFirst(optionsList)}.`,
    ]
  } else if (opts.missing.includes('count')) {
    // R28 — a per-job STRUCTURED field (the count) is the ONLY thing
    // missing: the job type + scope are known, we just can't size labour
    // or materials without the quantity. Ask the exact count question
    // using the job's own noun ("downlights"/"power points"/…) so the
    // customer answers in one tap instead of re-describing the work.
    const lead = named ? `${first}, ` : ''
    // Job-type label drives the noun. Falls back to a trade-aware generic
    // ("fittings" for electrical, "items" otherwise) when the job type is
    // unknown — never the bare word "things".
    const noun =
      (opts.jobType ? JOB_TYPE_LABEL[opts.jobType] : null) ??
      (trade === 'plumbing' ? 'items' : 'fittings')
    variants = [
      `${lead}quick one - how many ${noun} are we doing? Just need the number to size the quote.`,
      `${named ? `Cheers ${first}, ` : 'Cheers, '}how many ${noun} in total? Last bit and we're done.`,
      `${named ? `Hi ${first}, ` : 'Hi, '}can I grab the number of ${noun}? Need it to finalise the quote.`,
    ]
  } else {
    variants = [
      `${named ? `Hi ${first}, ` : 'Hi, '}can you give me a quick description of the work?`,
    ]
  }

  // Footer — no "- QuoteMax" sign-off here; the recovery thread feels
  // more human-typed without it (and the customer already knows who we
  // are because they're mid-conversation).
  return gsm7Safe(pickVariant(variants))
}

// Incomplete-intake SMS — sent when the intake quality gate fires.
// Triggered by `evaluateIntakeQuality(intake) === 'empty'`: caller hung up
// or texter dropped before giving usable info, OR the transcript was
// unintelligible. We send a short, apologetic prompt INSTEAD OF the
// photo-request and quote SMSes — never both. Designed to fit in 1 GSM-7
// segment. Wording adapts to the channel (voice vs SMS).
//
// NOTE: SMS source no longer uses this template directly — the route
// dispatches buildIntakeRecoverySms() instead so the customer gets a
// focused question and the conversation can continue. Voice source still
// uses this template (callback-request wording) because the call is over.
export function buildIncompleteCallSms(opts: {
  firstName?: string
  source?: 'voice' | 'sms'
}): string {
  const first = (opts.firstName ?? '').split(' ')[0] || ''
  const greeting = first ? `Hi ${first}, ` : 'Hi, '
  const body = opts.source === 'sms'
    ? `${greeting}thanks for messaging QuoteMax. We didn't quite catch enough to put a quote together - reply with a quick description of the work and we'll get back to you.\n\n- QuoteMax`
    : `${greeting}thanks for calling QuoteMax. We didn't quite catch enough on that call to put a quote together - please give us a quick callback when you've got a moment.\n\n- QuoteMax`
  return body
    .replace(/[‐-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/·/g, '-').replace(/[^\x20-\x7E\n]/g, '')
}

// ════════════════════════════════════════════════════════════════════
// Migration 079 — automated 2-hour customer follow-up check-in.
//
// Fired by /api/cron/followup-2h on quotes that have been sent or viewed
// 2h+ ago, where the customer hasn't replied and the tradie has opted in.
// One SMS per quote, ever (idempotency stamped on quotes.followup_2h_sent_at).
//
// Body is intentionally short — sits inside a single GSM-7 segment (160
// chars) for typical name + business pairs so it lands as one notification,
// not a multipart split. Wording is the exact body in the design brief:
// no emoji, no markdown, plain AU tone, signed off with the tradie's
// business name (so the customer recognises the sender immediately).
//
// Defensive fallbacks:
//   • firstName missing → 'there'   (matches buildQuoteSms convention)
//   • businessName missing → 'your tradie'   (shouldn't happen — toggle
//     can't be enabled without a tenant row — but safer than emitting
//     '— ' with a trailing dash and no name).
// ════════════════════════════════════════════════════════════════════
export function buildFollowup2hSms(opts: {
  firstName?: string | null
  businessName?: string | null
}): string {
  const first = (opts.firstName ?? '').trim().split(' ')[0] || 'there'
  const business = (opts.businessName ?? '').trim() || 'your tradie'
  const body = `Hi ${first}, just checking in on the quote we sent through - did we answer everything, or anything else we can help with? - ${business}`
  return body
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7E\n]/g, '')
}

// ════════════════════════════════════════════════════════════════════
// Migration 159 — 2-hour MID-CONVERSATION check-in (no quote yet).
//
// Fired by /api/cron/followup-2h on customer threads where the SMS
// receptionist asked a question 2h+ ago and the customer never replied.
// Trade-agnostic: the sweep unit is the sms_conversations thread, so
// electrical/plumbing dialog and the roofing/painting/solar receptionist
// flows are all covered. One SMS per conversation, ever (idempotency on
// sms_conversations.followup_2h_sent_at).
//
// Wording differs from buildFollowup2hSms deliberately — there is no
// quote to reference yet, so the body invites the customer to resume the
// intake, not to reread a quote. Same GSM-7 single-segment target and
// firstName/businessName fallbacks as the quote-level template.
// ════════════════════════════════════════════════════════════════════
export function buildConversationFollowup2hSms(opts: {
  firstName?: string | null
  businessName?: string | null
}): string {
  const first = (opts.firstName ?? '').trim().split(' ')[0] || 'there'
  const business = (opts.businessName ?? '').trim() || 'your tradie'
  const body = `Hi ${first}, just checking in - still keen to get that job sorted? Reply here and we'll pick up where we left off. - ${business}`
  return body
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7E\n]/g, '')
}

// Format an ISO timestamp as a short AU label, e.g. "Thu 7 May, 9:00am".
// Renders in the tenant's timezone when given (slots are generated in it —
// a Sydney-fixed echo shows a WA evening slot as the next day). ASCII for GSM-7.
// Exported so the roofing/painting tradie booking alert formats the slot with
// the SAME function as the customer confirmation — two formatters would let
// the two SMSes name different days for one slot.
export function fmtSlotShort(iso: string, timeZone = 'Australia/Sydney'): string {
  try {
    const d = new Date(iso)
    return d
      .toLocaleString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone,
      })
      .replace(/ /g, ' ')          // narrow no-break space some runtimes emit
      .replace(/\s*([ap])m\b/i, '$1m')  // tighten "9:00 am" → "9:00am"
  } catch {
    return iso
  }
}

// Customer booking-confirmation SMS — fires after the slot is locked in
// on /api/q/[token]/book. ASCII-only, single GSM-7 segment when possible.
export function buildBookingConfirmationSms(opts: {
  firstName?: string
  scheduledAt: string
  bookingUrl: string
  /** Tenant timezone (tzForState) — defaults to Sydney for legacy callers. */
  timeZone?: string
}): string {
  const first = (opts.firstName ?? '').split(' ')[0] || 'there'
  const when = fmtSlotShort(opts.scheduledAt, opts.timeZone)
  const body = `Hi ${first}, you're locked in for ${when}. The tradie will text the day before to confirm.\n\nView booking: ${opts.bookingUrl}\n\n- QuoteMax`
  return body
    .replace(/[‐-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/·/g, '-').replace(/[^\x20-\x7E\n]/g, '')
}

// Customer "deposit paid, now pick a time" SMS — fires when a deposit /
// $99 inspection is paid WITHOUT a slot chosen yet (the /paid page shows
// the same "Pick a time" CTA). ASCII-only, GSM-7 safe.
export function buildDepositAwaitingSlotSms(opts: {
  firstName?: string
  bookingUrl: string
}): string {
  const first = (opts.firstName ?? '').split(' ')[0] || 'there'
  const body = `Hi ${first}, deposit received - thanks! Pick a time that suits and we'll lock it in: ${opts.bookingUrl}\n\n- QuoteMax`
  return scrubForGsm7(body)
}

// ── Post-site-visit child payments (spec post-visit-money-sequence R11) ──
//
// The site visit has already happened by the time either of these fires, so
// neither may carry the "pick a time" nudge or a /book link the way
// buildDepositAwaitingSlotSms does — there is no visit left to schedule, and
// the booking page would let the customer prune a real slot out of the
// tenant's calendar for a job that has no appointment.

/** Customer SMS when the deposit on a 'final' row is paid. */
export function buildDepositReceivedSms(opts: {
  firstName?: string | null
  businessName?: string | null
}): string {
  const first = (opts.firstName ?? '').trim().split(' ')[0] || 'there'
  const business = (opts.businessName ?? '').trim() || 'your tradie'
  return scrubForGsm7(
    `Hi ${first}, deposit received - thanks! ${business} will be in touch to confirm the job date.\n\n- QuoteMax`,
  )
}

/** Customer SMS when the balance on a 'balance' row is paid. */
export function buildBalanceReceivedSms(opts: {
  firstName?: string | null
  businessName?: string | null
}): string {
  const first = (opts.firstName ?? '').trim().split(' ')[0] || 'there'
  const business = (opts.businessName ?? '').trim() || 'your tradie'
  return scrubForGsm7(
    `Hi ${first}, payment received - you're all paid up. Thanks for your business.\n\n- ${business}`,
  )
}

/**
 * Tradie SMS when a child payment lands. Today a deposit landing without a
 * slot notifies the tradie by PUSH only (booking-notify only texts when a
 * slot exists), which is not good enough for money on a job in progress:
 * the tradie is standing on site asking whether the payment came through.
 */
export function buildTradieChildPaymentSms(opts: {
  tradieFirstName?: string | null
  customerName?: string | null
  jobType: string
  /** Whole dollars the customer was charged, fee included. */
  amountAud: number
  kind: 'deposit' | 'balance'
  quoteUrl: string
}): string {
  const who = (opts.tradieFirstName ?? '').trim().split(' ')[0]
  const hi = who ? `Hi ${who}, ` : ''
  const customer = (opts.customerName ?? '').trim().split(' ')[0] || 'The customer'
  const job = (opts.jobType ?? 'job').replace(/_/g, ' ')
  const label = opts.kind === 'deposit' ? 'the deposit' : 'the balance'
  const tail =
    opts.kind === 'deposit'
      ? 'The job is confirmed - book it in with them.'
      : 'That job is paid in full.'
  return scrubForGsm7(
    `${hi}${customer} just paid ${label} of $${fmtAudWhole(opts.amountAud)} for the ${job}. ${tail}\n\n${opts.quoteUrl}`,
  )
}

/**
 * Customer SMS asking for the final payment, sent when the tradie taps
 * "Request final payment" on the job (spec post-visit-money-sequence R10).
 *
 * Links the /r short-link, never the raw Stripe URL: a Checkout Session dies
 * after 24h, and the tradie sends this standing on site — the customer may
 * well pay it the next day. /r mints a fresh Session per click.
 *
 * Says "tap to pay", never "reply YES": replies to this thread land at the
 * out-of-repo receptionist, which would read them as a brand-new enquiry.
 */
export function buildBalanceRequestSms(opts: {
  firstName?: string | null
  businessName?: string | null
  jobType: string
  /** Balance owed, whole dollars, before the platform fee. */
  balanceAud: number
  /** Total charged, whole dollars, fee included. */
  chargedAud: number
  payUrl: string
}): string {
  const first = (opts.firstName ?? '').trim().split(' ')[0] || 'there'
  const business = (opts.businessName ?? '').trim() || 'your tradie'
  const job = (opts.jobType ?? 'job').replace(/_/g, ' ')
  return scrubForGsm7(
    `Hi ${first}, your ${job} is complete. Balance due: $${fmtAudWhole(opts.balanceAud)} + 2% platform fee = $${fmtAudWhole(opts.chargedAud)}.\n\nTap to pay: ${opts.payUrl}\n\nThanks - ${business}`,
  )
}

/** Whole-dollar en-AU amount for SMS bodies ("1,250"). Local to keep the
 *  templates ASCII-safe and independent of the money module's formatter. */
function fmtAudWhole(n: number): string {
  return Math.round(n).toLocaleString('en-AU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

// Tradie-side booking notification — fires alongside the customer
// confirmation. Sent to the tenant's owner_mobile (and WhatsApp where
// configured) when a customer accepts a tier and pays the deposit.
export function buildTradieBookingNotification(opts: {
  tradieFirstName?: string | null
  customerName?: string
  customerPhone?: string
  jobType: string
  itemCount?: number
  scheduledAt: string
  quoteUrl: string
  dashboardUrl?: string
  /** v8 — realised early-booking discount %. When > 0 the notification
   *  adds an explicit line so the tradie knows to collect the REDUCED
   *  balance on completion, not the original quoted figure. */
  earlyBirdDiscountPct?: number
  /** Tenant timezone (tzForState) — must match the customer confirmation's
   *  zone or the two SMSes name different days for the same slot. */
  timeZone?: string
}): string {
  const greet = opts.tradieFirstName ? `Hi ${opts.tradieFirstName}` : 'Hi'
  const who = opts.customerName?.split(' ')[0] || opts.customerPhone || 'a customer'
  const job = JOB_TYPE_LABEL[opts.jobType] ?? opts.jobType.replace(/_/g, ' ')
  const qty = opts.itemCount ? `${opts.itemCount} ${job}` : job
  const when = fmtSlotShort(opts.scheduledAt, opts.timeZone)
  const dashLine = opts.dashboardUrl ? `\nDashboard: ${opts.dashboardUrl}` : ''
  const discount = opts.earlyBirdDiscountPct ?? 0
  const discountLine =
    discount > 0
      ? `\nNote: ${discount}% early-booking discount applied - collect the reduced balance on completion.`
      : ''
  const body =
    `${greet}, ${who} has booked and paid the deposit - ${qty} on ${when}.\n` +
    `Job: ${opts.quoteUrl}${dashLine}${discountLine}`
  return scrubForGsm7(body)
}

// Photo-request SMS — sent during/after the customer's first contact, in
// parallel with the intake/estimate chain. ASCII-only, GSM-7 safe, single
// segment.
//
// 4 wording variants picked at random per call. The "Hi <name>, thanks
// for messaging QuoteMax" lead-in was repetitive when the dialog already
// said "Welcome back" or "G'day" two messages ago, so the variants ditch
// the formal preamble and lead with the actual action ("here's a link").
//
// Voice path keeps a polite "thanks for calling" opener since the customer
// hung up before this SMS lands and won't have seen any prior text.
// Job-type → tradie noun. Keep electrical/plumbing aware so the SMS
// templates don't say "sparky" on a plumbing job (and vice-versa).
// 'tradie' is the safe fallback when job_type is unknown.
const ELECTRICAL_JOB_TYPES = new Set([
  'downlights','power_points','ceiling_fans','smoke_alarms','outdoor_lighting',
])
const PLUMBING_JOB_TYPES = new Set([
  'blocked_drain','hot_water','tap_repair','tap_replace','toilet_repair','toilet_replace',
])
function tradieNoun(jobType?: string | null): string {
  if (jobType && ELECTRICAL_JOB_TYPES.has(jobType)) return 'sparky'
  if (jobType && PLUMBING_JOB_TYPES.has(jobType))   return 'plumber'
  return 'tradie'
}

export function buildPhotoRequestSms(opts: {
  firstName?: string
  uploadUrl: string
  source?: 'voice' | 'sms'
  jobType?: string | null
}): string {
  const first = (opts.firstName ?? '').split(' ')[0] || ''
  const named = first ? `${first}, ` : ''
  const tradie = tradieNoun(opts.jobType)

  // EV charger is the one job type where the photo is REQUIRED, not optional
  // (spec ev-charger-location-photo R8): the quote's AI render of the charger
  // in position is built from it, and the electrician needs to see the spot.
  // Every other variant below offers the photo as optional, which would tell
  // the customer the opposite of what the readiness gate then enforces.
  // Deliberately NOT randomised — one clear ask, no "optional" anywhere.
  if (opts.jobType === 'ev_charger') {
    return gsm7Safe(
      `${first ? `${first}, ` : ''}last thing - send a photo of the spot where the charger will go and I'll get your quote across: ${opts.uploadUrl}`,
    )
  }

  if (opts.source === 'voice') {
    // Voice flows always lead with the call-context greeting so the
    // photo SMS doesn't feel like it came out of nowhere.
    const body = `Hi ${first || 'there'}, thanks for calling QuoteMax. Here's a quick photo upload to help finalise your quote, tap to add 1-2 pics: ${opts.uploadUrl}\n\nOptional but helps a lot.`
    return gsm7Safe(body)
  }

  // SMS variants — keep the link prominent, vary the framing.
  const variants = [
    `Hey ${named}here's a quick link to drop 1-2 photos so we can finalise your quote: ${opts.uploadUrl}\n\nOptional, but it really helps.`,
    `${first ? `Cheers ${first}, ` : 'Cheers, '}when you've got a sec, snap 1-2 photos of the spot here: ${opts.uploadUrl}\n\nNot required, just helps the ${tradie} pin down the quote.`,
    `${named ? `${first}, ` : ''}photos help us nail the quote. Upload 1-2 here whenever you're ready: ${opts.uploadUrl}\n\nTotally optional.`,
    `${first ? `Hi ${first}, ` : 'Hi, '}drop us a couple of photos here so the ${tradie} can lock in the right gear: ${opts.uploadUrl}\n\nOptional but a big help.`,
  ]
  return gsm7Safe(pickVariant(variants))
}

// Quote-failure fallback SMS — sent when the post-dialog chain (intake →
// estimate → SMS dispatch) exhausts retries and can't produce a quote.
// Without this the customer sees the AI say "quote in 2 mins" and then
// nothing. This message keeps the customer informed and gives them a
// next step (we'll call them back). Aussie tone, GSM-7 safe, single segment.
//
// Optional firstName personalises the apology when we have it from
// the dialog. Falls back to no name when we don't.
export function buildQuoteFailureSms(opts: { firstName?: string; jobType?: string | null }): string {
  const first = (opts.firstName ?? '').split(' ')[0] || ''
  return gsm7Safe(`${first ? `Sorry ${first}, ` : 'Sorry, '}the quote could not be completed because of a technical problem. It has not been sent. Reply here to check the request or contact the tradie directly.`)
}

// Quote-in-flight hold-on SMS — sent when the customer texts a NEW message
// while their previous quote is being drafted (status='structuring') or has
// just been dispatched (status='done' within last ~60s). Bypasses Sonnet
// entirely so the customer gets a predictable reply in <1s, and so we
// don't accidentally Sonnet-respond to a "new job" mid-flight as if it
// were an add-on to the in-flight quote.
//
// Three wording variants picked at random per call so the customer doesn't
// see the exact same canned phrase every time the in-flight short-circuit
// fires — keeps the thread feeling more human-typed.
//
// The customer's new message is preserved in sms_messages — when they
// re-engage after their quote arrives, the dialog picks up normally.
//
// 2026-05-19: variants rewritten to drop the "(under a minute)" /
// "(about a minute away)" time claims and the "nearly ready" promise.
// The INFLIGHT branch can fire for any conversation that's still
// status='structuring' or status='done' + intake_id within 60s — which
// includes recovery-flow leftovers and add-on flows where no quote is
// genuinely "nearly ready". Telling the customer it's a minute away when
// it isn't damages trust (the dialog system prompt has its own
// scrubVoiceWording regex for the same reason — see lib/sms/dialog.ts).
// New wording acknowledges we're still working but makes no time
// guarantee, and avoids the specific phrases dialog.ts strips elsewhere.
//
// 2026-05-22: the hold-on is now CONTEXT-AWARE. The old single variant set
// always told the customer to "send this one again" — which reads as
// out-of-sync when the in-flight message is NOT a new request. E.g. a
// customer answering the optional photo prompt with "I don't have any
// photos sorry" was told to re-send it, as if it were a new job. The
// classifier below routes photo replies and bare acknowledgements to
// reassurance wording; only a genuine-looking new request keeps the
// "send it again" ask.

/** What an in-flight inbound message is, for hold-on wording selection. */
type InflightReplyKind = 'photo' | 'ack' | 'request'

/** Classify an in-flight inbound so the hold-on SMS can be context-aware
 *  instead of always telling the customer to re-send their message. */
export function classifyInflightMessage(
  text: string | null | undefined,
): InflightReplyKind {
  const t = (text ?? '').trim().toLowerCase()
  if (!t) return 'ack'
  // Mentions photos — "I don't have any photos sorry", "no pics", "can't
  // get a photo". Decline or not, the right reply is the same: photos are
  // optional and the quote is coming regardless.
  if (/\b(photo|photos|pic|pics|picture|pictures|image|images)\b/.test(t)) {
    return 'photo'
  }
  // A bare acknowledgement — short, no real content to action.
  if (
    t.length <= 28 &&
    /\b(thanks|thank you|thankyou|ok|okay|kk|cheers|no worries|all good|sweet|great|got it|cool|yep|yes|yeah|ta|np)\b/.test(
      t,
    )
  ) {
    return 'ack'
  }
  return 'request'
}

export function buildQuoteInFlightSms(inboundText?: string | null): string {
  const variantsByKind: Record<InflightReplyKind, string[]> = {
    // A reply about photos — reassure they're optional; never ask the
    // customer to re-send. Fixes the "I don't have photos" -> "hit me
    // back with this one" out-of-sync reply.
    photo: [
      `No worries - photos are optional, they just help the tradie. Your quote is still being put together and will land shortly.`,
      `All good, photos aren't required. Your quote is still in the works - it'll come through shortly.`,
      `That's fine - no photos needed. Your quote is still on the way.`,
    ],
    // A bare acknowledgement — just reassure, nothing to action.
    ack: [
      `Cheers - your quote is still being put together, it'll land shortly.`,
      `Got it - quote's still in the works, it'll come through soon.`,
      `All good - your quote is still on the way.`,
    ],
    // Looks like a new request/question — keep the "send it again" ask so
    // it gets actioned once the in-flight quote clears.
    request: [
      `Cheers, still pulling your quote together. Soon as it lands, hit me back with this one and I'll get onto it.`,
      `Got you - still working on the quote. Once it's through, send this one again and I'll sort it.`,
      `Bear with us - quote's still in the works. When it arrives, message me back about this and I'll handle it.`,
    ],
  }
  const kind = classifyInflightMessage(inboundText)
  return gsm7Safe(pickVariant(variantsByKind[kind]))
}

// SMS body builder for the customer-facing quote dispatch.
// Output is plain ASCII to stay in GSM-7 encoding (160 chars/segment instead
// of 70 for UCS-2). Sanitised against em-dashes, smart quotes, ellipsis.

type LineItem = { unit: string; quantity: number; description: string; total_ex_gst: number; unit_price_ex_gst: number }
type Tier = { label: string; subtotal_ex_gst: number | string; line_items?: LineItem[] } | null

type Intake = {
  job_type: string
  caller?: { name?: string } | null
  scope?: { item_count?: number; description?: string } | null
}

type Quote = {
  good: Tier
  better: Tier
  best: Tier
  selected_tier: 'good' | 'better' | 'best' | null
  scope_of_works: string | null
  scope_short?: string | null
  assumptions: string[] | null
  estimated_timeframe: string | null
  /** optional per-tier short redirect URLs. May include 'inspection' for
   *  inspection-required quotes — when present, template renders the
   *  inspection-only layout (single $99 link, indicative ranges as context). */
  /** quotes.total_inc_gst — the stored figure the page shows and the mint
   *  charges from. Used by the final-quote message so all three agree. */
  total_inc_gst?: number | string | null
  pay_links?: Partial<
    Record<'good' | 'better' | 'best' | 'inspection' | 'deposit' | 'balance', string>
  >
  /** % deposit used in the SMS line (e.g. 30 → "(deposit $209)") */
  deposit_pct?: number | string | null
  /** True when intake/estimation flagged this quote as needing an on-site visit
   *  before final pricing. Drives the inspection-only SMS template path. */
  needs_inspection?: boolean | null
  /** Required when needs_inspection is true. Customer-facing reason. */
  inspection_reason?: string | null
  /** Migration 193 — WHY the quote is inspection-routed. Only
   *  'site_conditions' / 'model_declared' / null (legacy) may show the
   *  "Every site is different" line; 'grounding_failed' is an internal
   *  validation problem and gets neutral copy instead. */
  inspection_cause?: 'site_conditions' | 'model_declared' | 'grounding_failed' | null
  /** Public quote-view URL — `${APP_URL}/q/${share_token}`. When set, both
   *  templates render a "View full quote" line near the top so the customer
   *  can see scope, line items, risks, and CTAs in one place. */
  quote_view_url?: string | null
  /** Migration 105 — stable download URL for the Gotenberg quote PDF
   *  (`${APP_URL}/api/q/${share_token}/pdf`). Rendered as a "PDF copy"
   *  line under the view link. Priced quotes only — inspection-routed
   *  quotes never set this (no committable prices to put in a document). */
  pdf_url?: string | null
  /** WP6 — ISO timestamp the quoted price is held until. When present the
   *  SMS adds a "Price held until <date>" urgency line. Absent on legacy
   *  quotes and on the parity fixture, so this field is purely additive. */
  price_hold_until?: string | null
  /** v8 — realised early-booking discount % (quotes.applied_discount_pct).
   *  When > 0 the tier prices + deposits print DISCOUNTED, matching the
   *  Stripe Session the embedded pay link mints (P6 fix). Absent/0 → the
   *  full price, exactly as before. */
  applied_discount_pct?: number | null
  /** pricing_book.gst_registered (P1). Absent → treated as registered. */
  gst_registered?: boolean | null
}

const JOB_TYPE_LABEL: Record<string, string> = {
  // ── Electrical ──────────────────────────────
  downlights: 'downlights',
  power_points: 'power points',
  ceiling_fans: 'ceiling fans',
  smoke_alarms: 'smoke alarms',
  outdoor_lighting: 'outdoor lighting',
  switchboard: 'switchboard work',
  oven_cooktop: 'oven/cooktop',
  ev_charger: 'EV charger',
  fault_finding: 'fault finding',
  renovation: 'renovation',
  // ── Plumbing (v5) ───────────────────────────
  blocked_drain: 'blocked drain',
  hot_water: 'hot water system',
  tap_repair: 'tap repair',
  tap_replace: 'tap replacement',
  toilet_repair: 'toilet repair',
  toilet_replace: 'toilet replacement',
  gas_fitting: 'gas fitting',
  burst_pipe: 'burst pipe repair',
  bathroom_renovation: 'bathroom renovation',
  cctv_inspection: 'CCTV drain inspection',
  prv_install: 'pressure-reduction valve',
  // ── Fallback (trade-neutral; was "electrical work" pre-v5) ──
  other: 'job',
}

function gsm7Safe(s: string): string {
  return s
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7E\n]/g, '')
}

// Tier pricing now flows through lib/quote/money.ts (displayIncGst /
// depositCents) so the SMS prints the SAME number the page shows, the PDF
// prints, and Stripe charges — including any realised early-booking
// discount, which this file previously ignored (P6: SMS said "$1000
// (deposit $300)" while the embedded link minted a $270 Session).

function tierComponents(tier: Tier, jobType?: string | null, itemCount?: number | null): string {
  if (!tier?.line_items?.length) return ''
  const labourHrs = tier.line_items
    .filter((li) => li.unit === 'hr')
    .reduce((sum, li) => sum + (li.quantity ?? 0), 0)
  // Fixture count = how many units are being installed. intake.scope.item_count
  // is the source of truth. NEVER sum every unit='each' line: a fixture-install
  // job carries a separate product line AND a per-fixture install-kit line,
  // both unit='each' at the same quantity — summing them double-counts
  // (6 downlights -> product 6 + install-kit 6 -> "12 fittings", the bug).
  // When item_count is absent, fall back to the MAX 'each' quantity, never
  // the sum.
  const eachQtys = tier.line_items
    .filter((li) => li.unit === 'each')
    .map((li) => li.quantity ?? 0)
  const fittingCount =
    typeof itemCount === 'number' && itemCount > 0
      ? itemCount
      : (eachQtys.length ? Math.max(...eachQtys) : 0)
  // Trade-aware noun: electrical jobs install discrete "fittings"
  // (downlights, GPOs, fans, alarms). Plumbing jobs are mostly callouts
  // with one or two assembly + sundries items, so "fittings" reads as
  // wrong. Use "items" for plumbing and unknown, "fittings" for electrical.
  const noun = jobType && PLUMBING_JOB_TYPES.has(jobType)
    ? 'items'
    : (jobType && ELECTRICAL_JOB_TYPES.has(jobType) ? 'fittings' : 'items')
  const parts: string[] = []
  if (fittingCount) parts.push(`${fittingCount} ${noun}`)
  if (labourHrs) parts.push(`${+labourHrs.toFixed(2)}hr labour`)
  return parts.join(' + ')
}

function tierLabel(tier: Tier): string {
  return (tier?.label ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
}

function jobSummary(intake: Intake): string {
  const count = intake.scope?.item_count
  const label = JOB_TYPE_LABEL[intake.job_type] ?? 'job'
  if (count && count > 0) return `${count} ${label}`
  return label
}

function pickScopeForSms(quote: Quote): string | null {
  // Prefer the first full sentence of scope_of_works — that's the
  // richer, contractual wording the customer expects to see (e.g.
  // "Replace 6 existing downlights in living/kitchen ceilings with
  // new LEDs, including disposal of old fittings and circuit testing.").
  // Fall back to scope_short only when scope_of_works is missing.
  if (quote.scope_of_works && quote.scope_of_works.trim()) {
    const firstSentence = quote.scope_of_works.match(/^[^.]+\./)
    return (firstSentence ? firstSentence[0] : quote.scope_of_works).trim()
  }
  if (quote.scope_short && quote.scope_short.trim()) {
    return quote.scope_short.trim()
  }
  return null
}

/**
 * The customer quote SMS. Two shapes, decided by options.trade:
 *
 *   • default — tier prices + per-tier deposit amount + per-tier pay link.
 *     Solar, commercial painting and the roofing rows on `quotes` still take
 *     this path, as does any caller that doesn't thread a trade.
 *   • electrical / plumbing — the tier PRICES stay, the deposit amount and
 *     per-tier links go, and ONE "$99 refundable site visit" line replaces
 *     them (spec elec-plumb-site-visit-first R5). Modelled on painting's
 *     buildPaintingQuoteSms.
 *
 * Genuinely inspection-routed quotes (needs_inspection) keep their own
 * dedicated layout below and are untouched by the trade gate.
 */
export function buildQuoteSms(intake: Intake, quote: Quote, options?: QuoteSmsOptions): string {
  // A post-site-visit FINAL quote is a different message entirely: one
  // confirmed price, a deposit that credits the $99 already paid, and a
  // balance to come. It must never reach the site-visit branch below.
  if (options?.quoteKind === 'final') {
    return buildFinalQuoteSms(intake, quote, options)
  }
  // Inspection-required quotes get a distinct SMS layout — indicative ranges
  // for context, ONE prominent $99 site-visit link, no per-tier pay buttons.
  if (quote.needs_inspection) {
    return buildInspectionQuoteSms(intake, quote)
  }
  const displayMode = asQuoteDisplayMode(options?.displayMode, 'itemised')
  // Electrical/plumbing: prices stay, the deposit ask goes (see the option docs).
  const siteVisitFirst = isSiteVisitFirstRow({
    trade: options?.trade,
    quoteKind: options?.quoteKind,
  })

  const firstName = (intake.caller?.name ?? '').split(' ')[0] || 'there'
  const job = jobSummary(intake)
  const timeframe = (quote.estimated_timeframe ?? '').toLowerCase().trim()
  const depositPct = typeof quote.deposit_pct === 'string' ? parseFloat(quote.deposit_pct) : (quote.deposit_pct ?? 0)
  const hasPayLinks = !!quote.pay_links && Object.values(quote.pay_links).some(Boolean)

  const lines: string[] = []
  lines.push(`Hi ${firstName},`)
  lines.push('')
  lines.push(`Your QuoteMax quote for ${job}${timeframe ? ` (${timeframe})` : ''}.`)
  lines.push('')
  if (quote.quote_view_url) {
    lines.push(`View full quote: ${quote.quote_view_url}`)
    if (quote.pdf_url) lines.push(`PDF copy: ${quote.pdf_url}`)
    lines.push('')
  } else if (quote.pdf_url) {
    lines.push(`PDF copy: ${quote.pdf_url}`)
    lines.push('')
  }
  // Count actual non-null tiers — don't say "3 OPTIONS" if BEST dropped
  // because no premium catalogue match for the customer's spec preference
  // (see migration 008 + assumptions.ts note about catalogue gaps).
  // Mig 142/146 — list only the tiers this feature's mode surfaces to the
  // customer. Internal fallback 'single' matches the platform default (and the
  // PDF + quote page), so a caller that doesn't thread a mode shows one option
  // rather than the full Good/Better/Best list.
  const visibleTierKeys = resolveVisibleTiers({
    mode: asQuoteTierMode(options?.tierMode, 'single'),
    present: { good: !!quote.good, better: !!quote.better, best: !!quote.best },
    selectedTier: quote.selected_tier ?? null,
  })
  const visibleTierSet = new Set<'good' | 'better' | 'best'>(visibleTierKeys)
  const tierCount = visibleTierKeys.length
  const heading =
    tierCount === 1 ? 'YOUR OPTION' :
    tierCount === 2 ? '2 OPTIONS' :
    tierCount === 3 ? '3 OPTIONS' :
    'YOUR OPTIONS'
  const taxLabel = quote.gst_registered === false ? 'No GST' : 'inc 10% GST'
  if (hasPayLinks && depositPct > 0 && !siteVisitFirst) {
    lines.push(`${heading} (${taxLabel} - ${depositPct}% deposit to confirm):`)
  } else {
    lines.push(`${heading} (${taxLabel}):`)
  }
  lines.push('')

  for (const key of ['good', 'better', 'best'] as const) {
    const tier = quote[key]
    // Mig 142 — skip tiers the resolved mode hides.
    if (!tier || !visibleTierSet.has(key)) continue
    const incCents = totalIncGstCents(tier.subtotal_ex_gst, {
      discountPct: quote.applied_discount_pct,
      gstRegistered: quote.gst_registered,
    })
    const price = formatQuoteAmount(quoteAmount(incCents))
    const depCents = depositCents(incCents, depositPct)
    const deposit = depCents > 0 ? formatQuoteAmount(quoteAmount(depCents)) : null
    // No "recommended" badge when only one option is shown — it IS the offer.
    const recommended = visibleTierKeys.length > 1 && quote.selected_tier === key ? ' (recommended)' : ''

    // Site-visit-first trades keep the PRICE and lose the deposit ask.
    const headerSuffix = deposit && !siteVisitFirst ? ` (deposit $${deposit})` : ''
    lines.push(`${key.toUpperCase()}: $${price}${recommended}${headerSuffix}`)

    const label = tierLabel(tier)
    if (label) lines.push(`- ${label}`)
    if (displayMode !== 'summary') {
      const comps = tierComponents(tier, intake.job_type, intake.scope?.item_count)
      if (comps) lines.push(`- ${comps}`)
    }

    // No per-tier pay link for a site-visit-first trade — the ONE payment
    // line is pushed after the loop.
    const payUrl = siteVisitFirst ? null : quote.pay_links?.[key]
    if (payUrl) lines.push(`Tap to pay: ${payUrl}`)

    lines.push('')
  }

  const scopeLine = pickScopeForSms(quote)
  if (scopeLine) {
    lines.push(`SCOPE: ${scopeLine}`)
    lines.push('')
  }

  if (siteVisitFirst) {
    // The ONE payment. The price-hold line is suppressed with it: the $99 has
    // no hold, and its "lock in a tier to secure it" wording promises a deposit
    // these trades no longer take.
    pushSiteVisitLines(lines, quote.pay_links?.inspection)
  } else {
    pushPriceHoldLine(lines, quote.price_hold_until)
  }

  lines.push(
    siteVisitFirst
      ? 'Reply or call back if anything looks off.'
      : 'Reply or call back to confirm a tier and we will book you in.',
  )
  lines.push('')
  lines.push('- QuoteMax')

  return gsm7Safe(lines.join('\n'))
}

/**
 * The FINAL-quote SMS — the message that unblocks a job stuck at "site visit
 * paid" (spec post-visit-money-sequence R9).
 *
 * Deliberately its own shape rather than a variant of the tier message:
 *   • there is exactly ONE price (the tradie confirmed it on site), so the
 *     Good/Better/Best scaffolding and the "recommended" badge are noise;
 *   • the deposit is not `pct% of total` — it is that LESS the $99 already
 *     paid, plus the platform fee on top — and every one of those three
 *     numbers has to be visible or the customer can't reconcile what they
 *     are about to be charged;
 *   • the only link is /r/<token>/deposit. An `/inspection` link here would
 *     sell a second site visit for a job already visited, and paying it would
 *     claim the row's single paid_at slot and block the deposit for good.
 *
 * Says "tap to pay", never "reply YES": replies land at the out-of-repo
 * receptionist, which would read them as a fresh enquiry.
 */
function buildFinalQuoteSms(intake: Intake, quote: Quote, options?: QuoteSmsOptions): string {
  const firstName = (intake.caller?.name ?? '').split(' ')[0] || 'there'
  const job = jobSummary(intake)
  const business = (options?.businessName ?? '').trim() || 'QuoteMax'

  // T is the STORED total_inc_gst — the same column the quote page displays
  // from and the /r mint charges from. Re-deriving it here from the tier
  // subtotal plus a live gst_registered read would agree only until that flag
  // is toggled between the edit that stamped the total and this send, and
  // then the customer would be texted a deposit 10% away from what Stripe
  // takes. Falls back to the tier only for a row with no stored total.
  const tier = quote.good ?? quote.better ?? quote.best ?? null
  const storedTotalCents = Math.round(asMoneyNumber(quote.total_inc_gst) * 100)
  const totalCents =
    storedTotalCents > 0
      ? storedTotalCents
      : tier
        ? totalIncGstCents(tier.subtotal_ex_gst, { gstRegistered: quote.gst_registered })
        : 0
  const pct = clampDepositPct(quote.deposit_pct)
  const depositBase = finalDepositBaseCents(totalCents, pct)
  const balanceBase = finalBalanceBaseCents(totalCents, pct)
  const charged = chargedCents(depositBase)
  const payUrl = quote.pay_links?.deposit ?? null

  const lines: string[] = []
  lines.push(`Hi ${firstName},`)
  lines.push('')
  lines.push(`Your final quote for ${job} from ${business}: $${formatQuoteAmount(quoteAmount(totalCents))} ${quote.gst_registered === false ? 'No GST' : 'inc GST'}.`)
  lines.push('')
  if (quote.quote_view_url) lines.push(`View quote: ${quote.quote_view_url}`)
  if (quote.pdf_url) lines.push(`PDF copy: ${quote.pdf_url}`)
  if (quote.quote_view_url || quote.pdf_url) lines.push('')

  if (depositBase >= MIN_STRIPE_CHARGE_CENTS) {
    lines.push(
      `Accept with a ${pct}% deposit: $${formatQuoteAmount(quoteAmount(
        depositCents(totalCents, pct),
      ))} less your $${INSPECTION_FEE_AUD} site-visit credit + ${PLATFORM_FEE_PCT}% platform fee = $${formatQuoteAmount(quoteAmount(
        charged,
      ))}.`,
    )
    if (payUrl) {
      lines.push('Tap to pay:')
      lines.push(payUrl)
    }
    lines.push('')
    if (balanceBase >= MIN_STRIPE_CHARGE_CENTS) {
      lines.push(`Balance $${formatQuoteAmount(quoteAmount(balanceBase))} is requested on completion.`)
      lines.push('')
    }
  } else {
    // R8 — the $99 already covers the deposit, so there is nothing to pay now.
    // Saying "deposit $0" would read as a mistake; say what actually happened.
    lines.push(
      `Your $${INSPECTION_FEE_AUD} site visit covers the deposit - nothing to pay now.`,
    )
    if (balanceBase >= MIN_STRIPE_CHARGE_CENTS) {
      lines.push(`Balance $${formatQuoteAmount(quoteAmount(balanceBase))} on completion.`)
    }
    lines.push('')
  }

  lines.push('Questions? Call us back.')
  lines.push('')
  lines.push(`- ${business}`)

  return gsm7Safe(lines.join('\n'))
}

// Inspection-required SMS — shown when intake/estimation flags the job as
// needing an on-site visit before a real quote can be drafted. Renders the
// indicative ranges as context, then ONE clear $99 site-visit pay link.
// No per-tier deposit buttons — those would charge against indicative
// (not real) prices, which is misleading.
function buildInspectionQuoteSms(intake: Intake, quote: Quote): string {
  const firstName = (intake.caller?.name ?? '').split(' ')[0] || 'there'
  const job = jobSummary(intake)
  const inspectionUrl = quote.pay_links?.inspection

  // Inspection-required quotes never include fabricated tier numbers.
  // The $99 site-visit fee is the only honest dollar amount we can
  // commit to before seeing the work. Customer pays $99, tradie attends,
  // real fixed-price quote follows.

  const lines: string[] = []
  lines.push(`Hi ${firstName},`)
  lines.push('')
  lines.push(`Your QuoteMax quote for ${job} needs a quick site visit before we can give you a real price.`)
  lines.push('')
  if (quote.quote_view_url) {
    lines.push(`View full quote: ${quote.quote_view_url}`)
    lines.push('')
  }
  // R4 (2026-09-02) — this sentence is a claim about the SITE. It is only
  // honest when a site or model decision actually routed the job here. When
  // the cause was our own grounding validator rejecting a price
  // (inspection_cause 'grounding_failed'), saying it blames the customer's
  // property for our validation problem — which is exactly what happened on
  // 2026-09-01 to a fully priced EV charger quote. Legacy rows (null cause)
  // keep today's copy: every one of them predates the classification.
  lines.push(
    quote.inspection_cause === 'grounding_failed'
      ? `We've got your details and we're confirming the price on this one.`
      : `Every site is different — we can't price this safely without seeing the work in person.`,
  )
  lines.push('')
  if (inspectionUrl) {
    lines.push('Tap to lock in your site visit ($99 refundable, credited toward your final quote):')
    lines.push(inspectionUrl)
  } else {
    // Fallback when Stripe Session creation failed — tell the customer to call.
    lines.push('Call us back to lock in a site visit ($99 refundable, credited toward your final quote).')
  }
  lines.push('')

  const scopeLine = pickScopeForSms(quote)
  if (scopeLine) {
    lines.push(`SCOPE: ${scopeLine}`)
    lines.push('')
  }

  if (quote.inspection_reason) {
    lines.push(`Why a visit: ${quote.inspection_reason}`)
    lines.push('')
  }

  lines.push('- QuoteMax')

  return gsm7Safe(lines.join('\n'))
}
