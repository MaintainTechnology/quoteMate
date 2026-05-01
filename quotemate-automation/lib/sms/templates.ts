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
  if (quote.scope_short && quote.scope_short.trim()) {
    return quote.scope_short.trim()
  }
  if (!quote.scope_of_works) return null
  // Fallback for old quotes: first full sentence of the contractual scope.
  const firstSentence = quote.scope_of_works.match(/^[^.]+\./)
  return (firstSentence ? firstSentence[0] : quote.scope_of_works).trim()
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

  // Build the indicative range string from whichever tiers are present.
  // Opus produces these as INSPECTION FALLBACK shape — just numbers, no real
  // line items. We show them as a range to set expectations without committing.
  const tierPrices: number[] = []
  for (const key of ['good', 'better', 'best'] as const) {
    const tier = quote[key]
    if (tier) tierPrices.push(incGst(tier.subtotal_ex_gst))
  }
  const rangeText =
    tierPrices.length >= 2
      ? `Indicative range $${Math.min(...tierPrices)}-$${Math.max(...tierPrices)} inc GST (3 tiers, confirmed after the visit)`
      : tierPrices.length === 1
        ? `Indicative around $${tierPrices[0]} inc GST (confirmed after the visit)`
        : 'Indicative pricing confirmed after the visit'

  const lines: string[] = []
  lines.push(`Hi ${firstName},`)
  lines.push('')
  lines.push(`Your QuoteMate quote for ${job} needs a quick site visit to confirm scope safely.`)
  lines.push('')
  lines.push(rangeText + '.')
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
