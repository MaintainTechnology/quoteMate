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
  const firstName = (intake.caller?.name ?? '').split(' ')[0] || 'there'
  const job = jobSummary(intake)
  const timeframe = (quote.estimated_timeframe ?? '').toLowerCase().trim()

  const lines: string[] = []
  lines.push(`Hi ${firstName},`)
  lines.push('')
  lines.push(`Your QuoteMate quote for ${job}${timeframe ? ` (${timeframe})` : ''}.`)
  lines.push('')
  lines.push('3 OPTIONS (inc 10% GST):')
  lines.push('')

  for (const key of ['good', 'better', 'best'] as const) {
    const tier = quote[key]
    if (!tier) continue
    const price = incGst(tier.subtotal_ex_gst)
    const recommended = quote.selected_tier === key ? ' (recommended)' : ''
    lines.push(`${key.toUpperCase()}: $${price}${recommended}`)
    const label = tierLabel(tier)
    if (label) lines.push(`- ${label}`)
    const comps = tierComponents(tier)
    if (comps) lines.push(`- ${comps}`)
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
