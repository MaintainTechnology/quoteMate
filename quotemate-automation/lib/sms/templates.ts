// Random variant picker — used by templates that have multiple wording
// options. Picking one at random per send (rather than rotating) keeps
// the customer-facing thread feeling more human-typed without needing
// to track conversation state. Each customer typically only sees ONE
// instance of any given template per conversation, so the variation is
// noticeable across customers, not within a single thread.
import { priceHoldStatus, fmtHoldUntilAU } from '@/lib/quote/hold'

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

/** Capitalise the first character of a string for use mid-sentence. */
function capitaliseFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Quote-updated SMS — fired when the tradie edits a quote via the
 * /q/<token> edit overlay and chooses to notify the customer.
 *
 * Same shape as buildQuoteSms (full three-tier breakdown with prices,
 * deposit amounts, and per-tier Stripe pay links) so the customer sees
 * the latest numbers without having to open the quote page first.
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
export function buildQuoteUpdatedSms(intake: Intake, quote: Quote): string {
  // Inspection-required quotes use the dedicated inspection layout but
  // still get an "updated" preamble so the customer knows the tradie
  // touched the quote.
  if (quote.needs_inspection) {
    return buildInspectionQuoteUpdatedSms(intake, quote)
  }

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
    lines.push('')
  }

  const tierCount = ([quote.good, quote.better, quote.best].filter(Boolean) as Tier[]).length
  const heading =
    tierCount === 1 ? 'YOUR OPTION' :
    tierCount === 2 ? '2 OPTIONS' :
    tierCount === 3 ? '3 OPTIONS' :
    'YOUR OPTIONS'
  if (hasPayLinks && depositPct > 0) {
    lines.push(`${heading} (inc 10% GST - ${depositPct}% deposit to confirm):`)
  } else {
    lines.push(`${heading} (inc 10% GST):`)
  }
  lines.push('')

  for (const key of ['good', 'better', 'best'] as const) {
    const tier = quote[key]
    if (!tier) continue
    const price = incGst(tier.subtotal_ex_gst)
    const deposit = depositPct > 0 ? Math.round(price * depositPct / 100) : null
    const recommended = quote.selected_tier === key ? ' (recommended)' : ''

    const headerSuffix = deposit ? ` (deposit $${deposit})` : ''
    lines.push(`${key.toUpperCase()}: $${price}${recommended}${headerSuffix}`)

    const label = tierLabel(tier)
    if (label) lines.push(`- ${label}`)
    const comps = tierComponents(tier, intake.job_type)
    if (comps) lines.push(`- ${comps}`)

    const payUrl = quote.pay_links?.[key]
    if (payUrl) lines.push(`Tap to pay: ${payUrl}`)

    lines.push('')
  }

  pushPriceHoldLine(lines, quote.price_hold_until)

  lines.push('Reply or call back if anything looks off.')
  lines.push('')
  lines.push('- QuoteMate')

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
  lines.push('- QuoteMate')
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
}): string {
  const link = `${opts.appUrl}/signup?intent=${opts.token}`
  const body =
    `G'day! Welcome to QuoteMate. Tap the link to set up your AI receptionist. ` +
    `Takes about 4 minutes.\n\n${link}\n\nYour mobile is already saved.\n\n- QuoteMate`
  return gsm7Safe(body)
}

/**
 * Reminder SMS sent if the tradie texts again before finishing the
 * web onboarding. Same link, gentler nudge.
 */
export function buildTradieIntentStillOpenSms(opts: {
  appUrl: string
  token: string
}): string {
  const link = `${opts.appUrl}/signup?intent=${opts.token}`
  const body =
    `Still got your signup link open? Tap it here:\n\n${link}\n\n` +
    `Replies here won't progress your signup — finish on the web.\n\n- QuoteMate`
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
    `Your earlier signup link expired (24h). Fresh one:\n\n${link}\n\n- QuoteMate`
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

export function buildTradieDraftNotification(opts: {
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
    `Quote: ${opts.quoteUrl}${dashLine}`
  return scrubForGsm7(body)
}

export function buildTradieInspectionNotification(opts: {
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
    `Details: ${opts.quoteUrl}${dashLine}`
  return scrubForGsm7(body)
}

// Intake-recovery SMS — used when the quality gate fires 'empty' but we
// can identify EXACTLY which field is missing (name vs suburb vs scope vs
// job_type). Instead of the generic "we didn't catch enough" wording, we
// ask the specific question so the customer can answer in one tap and
// the conversation continues naturally on their next reply.
//
// This is the SMS counterpart to the dialog agent's Rules 5/6 — it's a
// safety net for the case where Haiku skipped the universal must-asks
// (e.g. on a returning-but-empty customer record) and reached 'finish'
// with a transcript that doesn't contain the customer's name/suburb.
export type MissingIntakeField = 'name' | 'suburb' | 'scope' | 'job_type'

export function buildIntakeRecoverySms(opts: {
  firstName?: string
  missing: MissingIntakeField[]
  /** Trade of the tenant the customer texted. Drives the job_type recovery
   *  prompt so plumbing customers see plumbing options, not electrical
   *  ones. Defaults to electrical for legacy single-trade pilots. */
  trade?: 'electrical' | 'plumbing' | null
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
  } else {
    variants = [
      `${named ? `Hi ${first}, ` : 'Hi, '}can you give me a quick description of the work?`,
    ]
  }

  // Footer — no "- QuoteMate" sign-off here; the recovery thread feels
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
    ? `${greeting}thanks for messaging QuoteMate. We didn't quite catch enough to put a quote together - reply with a quick description of the work and we'll get back to you.\n\n- QuoteMate`
    : `${greeting}thanks for calling QuoteMate. We didn't quite catch enough on that call to put a quote together - please give us a quick callback when you've got a moment.\n\n- QuoteMate`
  return body
    .replace(/[‐-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/·/g, '-').replace(/[^\x20-\x7E\n]/g, '')
}

// Format an ISO timestamp as a short AU Eastern label, e.g. "Thu 7 May, 9:00am".
// ASCII output for GSM-7 SMS.
function fmtSlotShort(iso: string): string {
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
        timeZone: 'Australia/Sydney',
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
}): string {
  const first = (opts.firstName ?? '').split(' ')[0] || 'there'
  const when = fmtSlotShort(opts.scheduledAt)
  const body = `Hi ${first}, you're locked in for ${when}. The tradie will text the day before to confirm.\n\nView booking: ${opts.bookingUrl}\n\n- QuoteMate`
  return body
    .replace(/[‐-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/·/g, '-').replace(/[^\x20-\x7E\n]/g, '')
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
}): string {
  const greet = opts.tradieFirstName ? `Hi ${opts.tradieFirstName}` : 'Hi'
  const who = opts.customerName?.split(' ')[0] || opts.customerPhone || 'a customer'
  const job = JOB_TYPE_LABEL[opts.jobType] ?? opts.jobType.replace(/_/g, ' ')
  const qty = opts.itemCount ? `${opts.itemCount} ${job}` : job
  const when = fmtSlotShort(opts.scheduledAt)
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
// for messaging QuoteMate" lead-in was repetitive when the dialog already
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

  if (opts.source === 'voice') {
    // Voice flows always lead with the call-context greeting so the
    // photo SMS doesn't feel like it came out of nowhere.
    const body = `Hi ${first || 'there'}, thanks for calling QuoteMate. Here's a quick photo upload to help finalise your quote, tap to add 1-2 pics: ${opts.uploadUrl}\n\nOptional but helps a lot.`
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
  const sorry = first ? `Sorry ${first}, ` : 'Sorry, '
  const tradie = tradieNoun(opts.jobType)
  const variants = [
    `${sorry}we hit a technical snag finalising your quote on our end. The ${tradie}'s been pinged and will give you a callback shortly. Apologies for the wait.`,
    `${sorry}our system tripped up finalising your quote. The ${tradie}'s been notified and will call back soon, apologies for the hassle.`,
    `${sorry}something glitched on our end while putting your quote together. The ${tradie}'s been alerted and will be in touch shortly.`,
  ]
  return gsm7Safe(pickVariant(variants))
}

// Quote-in-flight hold-on SMS — sent when the customer texts a NEW message
// while their previous quote is being drafted (status='structuring') or has
// just been dispatched (status='done' within last ~60s). Bypasses Haiku
// entirely so the customer gets a predictable reply in <1s, and so we
// don't accidentally Haiku-respond to a "new job" mid-flight as if it
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
export function buildQuoteInFlightSms(): string {
  const variants = [
    `Cheers, still pulling your quote together. Soon as it lands, hit me back with this one and I'll get onto it.`,
    `Got you - still working on the quote. Once it's through, send this one again and I'll sort it.`,
    `Bear with us - quote's still in the works. When it arrives, message me back about this and I'll handle it.`,
  ]
  return gsm7Safe(pickVariant(variants))
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
  pay_links?: Partial<Record<'good' | 'better' | 'best' | 'inspection', string>>
  /** % deposit used in the SMS line (e.g. 30 → "(deposit $209)") */
  deposit_pct?: number | string | null
  /** True when intake/estimation flagged this quote as needing an on-site visit
   *  before final pricing. Drives the inspection-only SMS template path. */
  needs_inspection?: boolean | null
  /** Required when needs_inspection is true. Customer-facing reason. */
  inspection_reason?: string | null
  /** Public quote-view URL — `${APP_URL}/q/${share_token}`. When set, both
   *  templates render a "View full quote" line near the top so the customer
   *  can see scope, line items, risks, and CTAs in one place. */
  quote_view_url?: string | null
  /** WP6 — ISO timestamp the quoted price is held until. When present the
   *  SMS adds a "Price held until <date>" urgency line. Absent on legacy
   *  quotes and on the parity fixture, so this field is purely additive. */
  price_hold_until?: string | null
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

function incGst(exGstCents: number | string): number {
  const n = typeof exGstCents === 'string' ? parseFloat(exGstCents) : exGstCents
  return Math.round(n * 1.10)
}

function tierComponents(tier: Tier, jobType?: string | null): string {
  if (!tier?.line_items?.length) return ''
  const labourHrs = tier.line_items
    .filter((li) => li.unit === 'hr')
    .reduce((sum, li) => sum + (li.quantity ?? 0), 0)
  const fittingCount = tier.line_items
    .filter((li) => li.unit === 'each')
    .reduce((sum, li) => sum + (li.quantity ?? 0), 0)
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

export function buildQuoteSms(intake: Intake, quote: Quote): string {
  // Inspection-required quotes get a distinct SMS layout — indicative ranges
  // for context, ONE prominent $99 site-visit link, no per-tier pay buttons.
  if (quote.needs_inspection) {
    return buildInspectionQuoteSms(intake, quote)
  }

  const firstName = (intake.caller?.name ?? '').split(' ')[0] || 'there'
  const job = jobSummary(intake)
  const timeframe = (quote.estimated_timeframe ?? '').toLowerCase().trim()
  const depositPct = typeof quote.deposit_pct === 'string' ? parseFloat(quote.deposit_pct) : (quote.deposit_pct ?? 0)
  const hasPayLinks = !!quote.pay_links && Object.values(quote.pay_links).some(Boolean)

  const lines: string[] = []
  lines.push(`Hi ${firstName},`)
  lines.push('')
  lines.push(`Your QuoteMate quote for ${job}${timeframe ? ` (${timeframe})` : ''}.`)
  lines.push('')
  if (quote.quote_view_url) {
    lines.push(`View full quote: ${quote.quote_view_url}`)
    lines.push('')
  }
  // Count actual non-null tiers — don't say "3 OPTIONS" if BEST dropped
  // because no premium catalogue match for the customer's spec preference
  // (see migration 008 + assumptions.ts note about catalogue gaps).
  const tierCount = ([quote.good, quote.better, quote.best].filter(Boolean) as Tier[]).length
  const heading =
    tierCount === 1 ? 'YOUR OPTION' :
    tierCount === 2 ? '2 OPTIONS' :
    tierCount === 3 ? '3 OPTIONS' :
    'YOUR OPTIONS'
  if (hasPayLinks && depositPct > 0) {
    lines.push(`${heading} (inc 10% GST - ${depositPct}% deposit to confirm):`)
  } else {
    lines.push(`${heading} (inc 10% GST):`)
  }
  lines.push('')

  for (const key of ['good', 'better', 'best'] as const) {
    const tier = quote[key]
    if (!tier) continue
    const price = incGst(tier.subtotal_ex_gst)
    const deposit = depositPct > 0 ? Math.round(price * depositPct / 100) : null
    const recommended = quote.selected_tier === key ? ' (recommended)' : ''

    const headerSuffix = deposit ? ` (deposit $${deposit})` : ''
    lines.push(`${key.toUpperCase()}: $${price}${recommended}${headerSuffix}`)

    const label = tierLabel(tier)
    if (label) lines.push(`- ${label}`)
    const comps = tierComponents(tier, intake.job_type)
    if (comps) lines.push(`- ${comps}`)

    const payUrl = quote.pay_links?.[key]
    if (payUrl) lines.push(`Tap to pay: ${payUrl}`)

    lines.push('')
  }

  const scopeLine = pickScopeForSms(quote)
  if (scopeLine) {
    lines.push(`SCOPE: ${scopeLine}`)
    lines.push('')
  }

  pushPriceHoldLine(lines, quote.price_hold_until)

  lines.push('Reply or call back to confirm a tier and we will book you in.')
  lines.push('')
  lines.push('- QuoteMate')

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
  lines.push(`Your QuoteMate quote for ${job} needs a quick site visit before we can give you a real price.`)
  lines.push('')
  if (quote.quote_view_url) {
    lines.push(`View full quote: ${quote.quote_view_url}`)
    lines.push('')
  }
  lines.push(`Every site is different — we can't price this safely without seeing the work in person.`)
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

  lines.push('- QuoteMate')

  return gsm7Safe(lines.join('\n'))
}
