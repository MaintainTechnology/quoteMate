import { describe, expect, it } from 'vitest'
import {
  humanizeJobType,
  parseFollowupQuoteContext,
  formatFollowupContext,
  isFollowupContextActive,
  formatActiveFollowupContext,
  type FollowupQuoteContext,
} from './followup-context'

// Typed fixture factory. Tests override only the fields they assert on.
// Robustness: when a new field is added to FollowupQuoteContext, the
// compiler points HERE (one place) instead of breaking every hand-built
// literal across the file. Defaults are the canonical "Blocked Drain
// $598" pin the assertions below expect.
function makeCtx(
  overrides: Partial<FollowupQuoteContext> = {},
): FollowupQuoteContext {
  return {
    quote_id: 'q1',
    share_token: 'tok',
    job_label: 'Blocked Drain',
    total_inc_gst: 598,
    tier: 'better',
    quote_url: 'https://x/q/tok',
    sent_at: '2026-05-18T00:00:00Z',
    expires_at: null,
    ...overrides,
  }
}

describe('humanizeJobType', () => {
  it('title-cases a slug', () => {
    expect(humanizeJobType('blocked_drain')).toBe('Blocked Drain')
    expect(humanizeJobType('hot_water')).toBe('Hot Water')
  })
  it('drops empty / generic / nullish', () => {
    expect(humanizeJobType(null)).toBeNull()
    expect(humanizeJobType('')).toBeNull()
    expect(humanizeJobType('other')).toBeNull()
  })
})

describe('parseFollowupQuoteContext', () => {
  it('parses a well-formed blob', () => {
    const c = parseFollowupQuoteContext({
      quote_id: 'q1',
      share_token: 'tok',
      job_label: 'Blocked Drain',
      total_inc_gst: 598,
      tier: 'better',
      quote_url: 'https://x/q/tok',
      sent_at: '2026-05-18T00:00:00Z',
    })
    expect(c).not.toBeNull()
    expect(c?.quote_id).toBe('q1')
    expect(c?.total_inc_gst).toBe(598)
  })
  it('returns null without a quote_id', () => {
    expect(parseFollowupQuoteContext({ job_label: 'X' })).toBeNull()
    expect(parseFollowupQuoteContext(null)).toBeNull()
    expect(parseFollowupQuoteContext('nope')).toBeNull()
  })
  it('coerces bad field types to null rather than throwing', () => {
    const c = parseFollowupQuoteContext({
      quote_id: 'q1',
      total_inc_gst: 'not-a-number',
      share_token: 42,
    })
    expect(c?.quote_id).toBe('q1')
    expect(c?.total_inc_gst).toBeNull()
    expect(c?.share_token).toBeNull()
  })
})

describe('formatFollowupContext', () => {
  it('returns empty string when there is no context', () => {
    expect(formatFollowupContext(null)).toBe('')
  })

  it('names the quote, the figure and the link, and forbids re-quoting', () => {
    const block = formatFollowupContext(makeCtx())
    expect(block).toContain('Blocked Drain')
    expect(block).toContain('$598 inc GST')
    expect(block).toContain('https://x/q/tok')
    expect(block).toMatch(/do NOT start a fresh intake/i)
    expect(block).toMatch(/never invent or change the price/i)
    expect(block).toMatch(/DIFFERENT, new job/i)
  })

  it('degrades safely with no link / no price', () => {
    const block = formatFollowupContext(
      makeCtx({
        share_token: null,
        job_label: null,
        total_inc_gst: null,
        tier: null,
        quote_url: null,
        sent_at: '',
      }),
    )
    expect(block).toContain('do not invent one')
    expect(block).toContain('price as previously quoted')
    expect(block).toMatch(/offer to have the tradie resend it/i)
  })
})

describe('isFollowupContextActive', () => {
  const now = Date.parse('2026-05-19T00:00:00Z')
  const base = makeCtx()

  it('is inactive when there is no pin', () => {
    expect(isFollowupContextActive(null, now)).toBe(false)
  })
  it('is active when expiry is in the future', () => {
    expect(
      isFollowupContextActive(
        { ...base, expires_at: '2026-06-01T00:00:00Z' },
        now,
      ),
    ).toBe(true)
  })
  it('is inactive once expired', () => {
    expect(
      isFollowupContextActive(
        { ...base, expires_at: '2026-05-18T00:00:00Z' },
        now,
      ),
    ).toBe(false)
  })
  it('treats a missing expiry as active (legacy rows)', () => {
    expect(isFollowupContextActive(base, now)).toBe(true)
  })
  it('fails safe (inactive) on an unparseable expiry', () => {
    expect(
      isFollowupContextActive({ ...base, expires_at: 'not-a-date' }, now),
    ).toBe(false)
  })
})

describe('formatActiveFollowupContext', () => {
  const now = Date.parse('2026-05-19T00:00:00Z')
  const raw = {
    quote_id: 'q1',
    share_token: 'tok',
    job_label: 'Blocked Drain',
    total_inc_gst: 598,
    tier: 'better',
    quote_url: 'https://x/q/tok',
    sent_at: '2026-05-18T00:00:00Z',
  }

  it('formats a fresh pin', () => {
    const block = formatActiveFollowupContext(
      { ...raw, expires_at: '2026-06-01T00:00:00Z' },
      now,
    )
    expect(block).toContain('Blocked Drain')
    expect(block).toContain('https://x/q/tok')
  })
  it('returns empty string for a stale pin (no hijack of new chats)', () => {
    expect(
      formatActiveFollowupContext(
        { ...raw, expires_at: '2026-05-01T00:00:00Z' },
        now,
      ),
    ).toBe('')
  })
  it('returns empty string when there is no pin at all', () => {
    expect(formatActiveFollowupContext(null, now)).toBe('')
    expect(formatActiveFollowupContext({}, now)).toBe('')
  })
})
