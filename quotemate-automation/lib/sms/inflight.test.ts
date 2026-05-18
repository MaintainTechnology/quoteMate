// Regression coverage for the "just wrapping up your quote" bug.
//
// The headline case (Jon, 2026-05-18): a conversation that escalated to
// a $199 inspection is marked status='done' with NO intake_id. A
// follow-up 57s later must NOT get the canned hold-on and must NOT skip
// the AI — otherwise service toggles can never be tested and customers
// are told a non-existent quote is "on its way".

import { describe, expect, it } from 'vitest'
import {
  DONE_INFLIGHT_WINDOW_MS,
  STRUCTURING_INFLIGHT_MAX_MS,
  isQuoteInflight,
} from './inflight'

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

  it('holds a done conversation that ACTUALLY produced a quote (< 60s)', () => {
    expect(
      isQuoteInflight({ status: 'done', intake_id: 'abc-123' }, 30_000),
    ).toBe(true)
    expect(
      isQuoteInflight(
        { status: 'done', intake_id: 'abc-123' },
        DONE_INFLIGHT_WINDOW_MS - 1,
      ),
    ).toBe(true)
  })

  it('does NOT hold a done+quote conversation past the 60s window', () => {
    expect(
      isQuoteInflight(
        { status: 'done', intake_id: 'abc-123' },
        DONE_INFLIGHT_WINDOW_MS,
      ),
    ).toBe(false)
  })

  it('THE BUG FIX: done WITHOUT an intake_id is never in-flight', () => {
    // Inspection escalation — status done, no quote drafted (Jon's case).
    expect(isQuoteInflight({ status: 'done', intake_id: null }, 1000)).toBe(
      false,
    )
    expect(isQuoteInflight({ status: 'done' }, 57_000)).toBe(false)
    expect(
      isQuoteInflight({ status: 'done', intake_id: undefined }, 5_000),
    ).toBe(false)
    // Ended conversation — also done, also no intake_id.
    expect(isQuoteInflight({ status: 'done', intake_id: '' }, 2_000)).toBe(
      false,
    )
  })

  it('never holds open / unknown / null statuses', () => {
    expect(isQuoteInflight({ status: 'open' }, 100)).toBe(false)
    expect(isQuoteInflight({ status: 'reuse' }, 100)).toBe(false)
    expect(isQuoteInflight({ status: null }, 100)).toBe(false)
    expect(isQuoteInflight({ status: undefined }, 100)).toBe(false)
  })

  it('exposes the documented window constants', () => {
    expect(STRUCTURING_INFLIGHT_MAX_MS).toBe(5 * 60 * 1000)
    expect(DONE_INFLIGHT_WINDOW_MS).toBe(60 * 1000)
  })
})
