// ════════════════════════════════════════════════════════════════════
// Tradie-side notifications (Phase 4 / notify) — fire when an SMS-sourced
// quote drafts. Two flavours:
//   • buildTradieDraftNotification — for auto-quote drafts (good/better/best)
//   • buildTradieInspectionNotification — for inspection-required quotes ($199)
// Both are GSM-7 safe ASCII so they fit in a single SMS segment whenever
// possible. They go to the tradie's mobile + WhatsApp simultaneously.
// ════════════════════════════════════════════════════════════════════
export function buildTradieDraftNotification(opts: {
  customerName?: string
  customerPhone?: string
  jobType: string
  itemCount?: number
  totalIncGst: number
  quoteUrl: string
}): string {
  const who = opts.customerName?.split(' ')[0] || opts.customerPhone || 'a customer'
  const job = JOB_TYPE_LABEL[opts.jobType] ?? opts.jobType.replace(/_/g, ' ')
  const qty = opts.itemCount ? `${opts.itemCount} ${job}` : job
  const total = opts.totalIncGst.toFixed(0)
  const body = `[QuoteMate] New SMS quote drafted - ${qty} for ${who}. Total $${total} inc GST. Review: ${opts.quoteUrl}`
  return body
    .replace(/[‐-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/·/g, '-').replace(/[^\x20-\x7E\n]/g, '')
}

export function buildTradieInspectionNotification(opts: {
  customerName?: string
  customerPhone?: string
  jobType: string
  inspectionReason?: string | null
  quoteUrl: string
}): string {
  const who = opts.customerName?.split(' ')[0] || opts.customerPhone || 'a customer'
  const job = JOB_TYPE_LABEL[opts.jobType] ?? opts.jobType.replace(/_/g, ' ')
  const reason = opts.inspectionReason ? ` (${opts.inspectionReason})` : ''
  const body = `[QuoteMate] SMS inspection booking - ${job} for ${who}${reason}. $199 site visit. Details: ${opts.quoteUrl}`
  return body
    .replace(/[‐-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/·/g, '-').replace(/[^\x20-\x7E\n]/g, '')
}

// Incomplete-call SMS — sent when the intake quality gate fires.
// Triggered by `evaluateIntakeQuality(intake) === 'empty'`: caller hung up
// before giving usable info OR the transcript was unintelligible. We send
// a short, apologetic callback prompt INSTEAD OF the photo-request SMS
// and the quote SMS — never both. Designed to fit in 1 GSM-7 segment.
export function buildIncompleteCallSms(opts: { firstName?: string }): string {
  const first = (opts.firstName ?? '').split(' ')[0] || ''
  const greeting = first ? `Hi ${first}, ` : 'Hi, '
  const body = `${greeting}thanks for calling QuoteMate. We didn't quite catch enough on that call to put a quote together - please give us a quick callback when you've got a moment.\n\n- QuoteMate`
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
// confirmation. Sent to TRADIE_NOTIFY_NUMBER (and WhatsApp) when set.
export function buildTradieBookingNotification(opts: {
  customerName?: string
  customerPhone?: string
  jobType: string
  itemCount?: number
  scheduledAt: string
  quoteUrl: string
}): string {
  const who = opts.customerName?.split(' ')[0] || opts.customerPhone || 'a customer'
  const job = JOB_TYPE_LABEL[opts.jobType] ?? opts.jobType.replace(/_/g, ' ')
  const qty = opts.itemCount ? `${opts.itemCount} ${job}` : job
  const when = fmtSlotShort(opts.scheduledAt)
  const body = `[QuoteMate] New booking - ${qty} for ${who} on ${when}. View: ${opts.quoteUrl}`
  return body
    .replace(/[‐-――]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/·/g, '-').replace(/[^\x20-\x7E\n]/g, '')
}

// Photo-request SMS — sent immediately after the call ends, in parallel
// with the intake/estimate chain. ASCII-only, GSM-7 safe, single segment.
export function buildPhotoRequestSms(opts: { firstName?: string; uploadUrl: string }): string {
  const first = (opts.firstName ?? '').split(' ')[0] || 'there'
  const body = `Hi ${first}, thanks for calling QuoteMate. Tap here to add 1-2 photos so we can finalise your quote: ${opts.uploadUrl}\n\n(Optional but helps a lot.)`
  return body
    .replace(/[‐-―−]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/·/g, '-').replace(/[^\x20-\x7E\n]/g, '')
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
   *  inspection-only layout (single $199 link, indicative ranges as context). */
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
}

const JOB_TYPE_LABEL: Record<string, string> = {
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
  other: 'electrical work',
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

function tierComponents(tier: Tier): string {
  if (!tier?.line_items?.length) return ''
  const labourHrs = tier.line_items
    .filter((li) => li.unit === 'hr')
    .reduce((sum, li) => sum + (li.quantity ?? 0), 0)
  const fittingCount = tier.line_items
    .filter((li) => li.unit === 'each')
    .reduce((sum, li) => sum + (li.quantity ?? 0), 0)
  const parts: string[] = []
  if (fittingCount) parts.push(`${fittingCount} fittings`)
  if (labourHrs) parts.push(`${+labourHrs.toFixed(2)}hr labour`)
  return parts.join(' + ')
}

function tierLabel(tier: Tier): string {
  return (tier?.label ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
}

function jobSummary(intake: Intake): string {
  const count = intake.scope?.item_count
  const label = JOB_TYPE_LABEL[intake.job_type] ?? 'electrical work'
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
  // for context, ONE prominent $199 site-visit link, no per-tier pay buttons.
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
  if (hasPayLinks && depositPct > 0) {
    lines.push(`3 OPTIONS (inc 10% GST - ${depositPct}% deposit to confirm):`)
  } else {
    lines.push('3 OPTIONS (inc 10% GST):')
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
    const comps = tierComponents(tier)
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

  lines.push('Reply or call back to confirm a tier and we will book you in.')
  lines.push('')
  lines.push('- QuoteMate')

  return gsm7Safe(lines.join('\n'))
}

// Inspection-required SMS — shown when intake/estimation flags the job as
// needing an on-site visit before a real quote can be drafted. Renders the
// indicative ranges as context, then ONE clear $199 site-visit pay link.
// No per-tier deposit buttons — those would charge against indicative
// (not real) prices, which is misleading.
function buildInspectionQuoteSms(intake: Intake, quote: Quote): string {
  const firstName = (intake.caller?.name ?? '').split(' ')[0] || 'there'
  const job = jobSummary(intake)
  const inspectionUrl = quote.pay_links?.inspection

  // Inspection-required quotes never include fabricated tier numbers.
  // The $199 site-visit fee is the only honest dollar amount we can
  // commit to before seeing the work. Customer pays $199, tradie attends,
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
    lines.push('Tap to lock in your site visit ($199 refundable, credited toward your final quote):')
    lines.push(inspectionUrl)
  } else {
    // Fallback when Stripe Session creation failed — tell the customer to call.
    lines.push('Call us back to lock in a site visit ($199 refundable, credited toward your final quote).')
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
