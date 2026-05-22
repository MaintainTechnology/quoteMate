// Regression coverage for the in-flight rule.
//
// isQuoteInflight is intentionally narrow: a quote is "in flight" ONLY
// while status='structuring' (the transient window between the intake
// handoff and the draft completing). A `done` conversation is never
// in-flight — its draft has finished and the route's hasExistingIntake
// guard owns the don't-re-draft behaviour.
//
// Bug fixed 2026-05-22: the old rule also held a `done` + intake_id
// conversation for 60s, measured from `last_message_at`. Because every
// message (including the bot's own replies) resets `last_message_at`,
// once a conversation had ever produced a quote every quick customer
// reply falsely registered as "in flight" and got the canned hold-on —
// the conversation oscillated between dialog turns and bogus hold-ons.
// `done` is no longer in-flight at all; the assertions below pin that.

import { describe, expect, it } from 'vitest'
import { STRUCTURING_INFLIGHT_MAX_MS, isQuoteInflight } from './inflight'

describe('isQuoteInflight', () => {
  it('returns false when there is no prior conversation', () => {
    expect(isQuoteInflight(null, 0)).toBe(false)
    expect(isQuoteInflight(undefined, 1000)).toBe(false)
  })

  it('holds a structuring conversation that is still drafting (< 5 min)', () => {
    expect(isQuoteInflight({ status: 'structuring' }, 1000)).toBe(true)
    expect(
      isQuoteInflight({ status: 'structuring' }, STRUCTURING_INFLIGHT_MAX_MS - 1),
    ).toBe(true)
  })

  it('does NOT hold a structuring conversation that is stuck (>= 5 min)', () => {
    expect(
      isQuoteInflight({ status: 'structuring' }, STRUCTURING_INFLIGHT_MAX_MS),
    ).toBe(false)
  })

  it('THE BUG FIX: a done conversation is NEVER in-flight, at any age', () => {
    // Even a done conversation that genuinely produced a quote: the draft
    // has finished, so it is not in-flight. The route reuses it and the
    // dialog replies normally; hasExistingIntake stops a re-draft. This
    // is what kills the oscillating canned hold-on.
    expect(
      isQuoteInflight({ status: 'done', intake_id: 'abc-123' }, 1_000),
    ).toBe(false)
    expect(
      isQuoteInflight({ status: 'done', intake_id: 'abc-123' }, 30_000),
    ).toBe(false)
    expect(
      isQuoteInflight({ status: 'done', intake_id: 'abc-123' }, 5 * 60_000),
    ).toBe(false)
    // done without an intake_id (inspection escalation / ended) — also
    // never in-flight.
    expect(isQuoteInflight({ status: 'done', intake_id: null }, 1000)).toBe(false)
    expect(isQuoteInflight({ status: 'done' }, 57_000)).toBe(false)
    expect(isQuoteInflight({ status: 'done', intake_id: '' }, 2_000)).toBe(false)
  })

  it('never holds open / unknown / null statuses', () => {
    expect(isQuoteInflight({ status: 'open' }, 100)).toBe(false)
    expect(isQuoteInflight({ status: 'reuse' }, 100)).toBe(false)
    expect(isQuoteInflight({ status: null }, 100)).toBe(false)
    expect(isQuoteInflight({ status: undefined }, 100)).toBe(false)
  })

  it('exposes the documented window constant', () => {
    expect(STRUCTURING_INFLIGHT_MAX_MS).toBe(5 * 60 * 1000)
  })
})
