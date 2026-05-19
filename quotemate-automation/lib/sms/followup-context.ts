// Follow-up quote context — pins the SPECIFIC quote a manual follow-up
// was about onto the SMS conversation, so when the customer replies the
// AI knows which quote a vague reference ("resend the quote", "how much
// again", "still good?") points to — instead of continuing whatever the
// live thread had drifted to (the toilet-vs-blocked-drain collision).
//
// Stored as `conversation_state.followup_quote` by the follow-up text
// endpoint; read + formatted into the dialog prompt by /api/sms/inbound.
// Pure + defensive so it can be unit-tested without a DB or LLM.

export type FollowupQuoteContext = {
  quote_id: string
  share_token: string | null
  job_label: string | null
  total_inc_gst: number | null
  tier: string | null
  quote_url: string | null
  sent_at: string
  /** ISO. After this the pin is stale and ignored so an old follow-up
   *  can't hijack an unrelated later conversation. null = never expires
   *  (legacy rows written before TTL existed). */
  expires_at: string | null
}

/** How long a follow-up pin stays authoritative after it's sent. A quote
 *  chase resolves within days/weeks; beyond this the customer is almost
 *  certainly on something new, so let normal flow take over. */
export const FOLLOWUP_PIN_TTL_DAYS = 14

/** Turn a job_type slug ("blocked_drain") into a label ("Blocked Drain"). */
export function humanizeJobType(slug: string | null | undefined): string | null {
  if (!slug) return null
  const s = String(slug).trim()
  if (!s || s === 'other') return null
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Defensive parse of the JSONB blob — returns null on anything off. */
export function parseFollowupQuoteContext(raw: unknown): FollowupQuoteContext | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const quoteId = typeof o.quote_id === 'string' ? o.quote_id.trim() : ''
  if (!quoteId) return null
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null
  return {
    quote_id: quoteId,
    share_token: str(o.share_token),
    job_label: str(o.job_label),
    total_inc_gst: num(o.total_inc_gst),
    tier: str(o.tier),
    quote_url: str(o.quote_url),
    sent_at: str(o.sent_at) ?? '',
    expires_at: str(o.expires_at),
  }
}

/** Is this pin still authoritative at `nowMs`? A missing/blank expiry is
 *  treated as active (legacy rows). An unparseable expiry is treated as
 *  EXPIRED — fail safe rather than let a malformed pin run forever. */
export function isFollowupContextActive(
  ctx: FollowupQuoteContext | null,
  nowMs: number,
): boolean {
  if (!ctx) return false
  if (!ctx.expires_at) return true
  const exp = Date.parse(ctx.expires_at)
  if (Number.isNaN(exp)) return false
  return exp > nowMs
}

/** Parse → expiry-gate → format, in one call. Returns '' when there is
 *  no pin OR it has gone stale. This is what /api/sms/inbound uses. */
export function formatActiveFollowupContext(
  raw: unknown,
  nowMs: number,
): string {
  const ctx = parseFollowupQuoteContext(raw)
  if (!isFollowupContextActive(ctx, nowMs)) return ''
  return formatFollowupContext(ctx)
}

/** The prompt block injected into the dialog turn. '' when no context. */
export function formatFollowupContext(
  ctx: FollowupQuoteContext | null,
): string {
  if (!ctx) return ''
  const money =
    ctx.total_inc_gst != null
      ? `$${Math.round(ctx.total_inc_gst).toLocaleString('en-AU')} inc GST`
      : 'price as previously quoted'
  const job = ctx.job_label ?? 'their job'
  const tier = ctx.tier ? ` (${ctx.tier} tier)` : ''
  const link = ctx.quote_url ?? null

  return [
    'FOLLOW-UP QUOTE CONTEXT (the tradie just sent this customer a follow-up about a quote they already received):',
    `  - Quote: ${job} — ${money}${tier}`,
    link ? `  - Quote link (their existing quote): ${link}` : `  - Quote link: (not available — do not invent one)`,
    'HOW TO USE THIS:',
    '  - This tells you WHICH quote a vague reference points to. If the customer says "resend the quote", "how much again", "what was the price", "is that still good", "send it through", or refers to "the quote"/"that quote" WITHOUT describing a new job, they mean THIS quote.',
    link
      ? '  - Reply with the quote link above (and the figure if they ask). Do NOT start a fresh intake or re-quote from scratch.'
      : '  - Acknowledge their existing quote and offer to have the tradie resend it. Do NOT start a fresh intake or re-quote from scratch.',
    '  - If they want to proceed / book / pay, point them to that quote.',
    '  - Never invent or change the price. The figure above is the already-sent quote; the link is the authoritative copy.',
    '  - ONLY if the customer clearly describes a DIFFERENT, new job (work other than the one named above) do you start a new request — the follow-up was just a nudge; normal flow resumes for genuinely new work.',
  ].join('\n')
}
