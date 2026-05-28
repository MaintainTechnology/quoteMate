// Tests for the pure review-policy module.
// No DB, no fetch — just the hold-vs-send decision.

import { describe, expect, it } from 'vitest'
import {
  asReviewPolicy,
  shouldHoldForReview,
  REVIEW_POLICIES,
} from './review-policy'

describe('REVIEW_POLICIES', () => {
  it('exports exactly three policies', () => {
    expect(REVIEW_POLICIES).toEqual([
      'auto_send',
      'always_review',
      'review_over_threshold',
    ])
  })
})

describe('asReviewPolicy', () => {
  it('accepts each valid policy verbatim', () => {
    expect(asReviewPolicy('auto_send')).toBe('auto_send')
    expect(asReviewPolicy('always_review')).toBe('always_review')
    expect(asReviewPolicy('review_over_threshold')).toBe('review_over_threshold')
  })

  it('falls back to auto_send for invalid input (back-compat with pre-migration rows)', () => {
    expect(asReviewPolicy(null)).toBe('auto_send')
    expect(asReviewPolicy(undefined)).toBe('auto_send')
    expect(asReviewPolicy('')).toBe('auto_send')
    expect(asReviewPolicy('hold_everything')).toBe('auto_send')
    expect(asReviewPolicy(42)).toBe('auto_send')
  })

  it('honours an explicit fallback', () => {
    expect(asReviewPolicy(null, 'always_review')).toBe('always_review')
  })

  it('is case-sensitive — uppercase variants are NOT accepted', () => {
    // Defensive: a stale DB row with 'Auto_Send' should NOT be treated
    // as a real policy. Force the fallback so the gate decision is
    // explicit, not accidentally permissive.
    expect(asReviewPolicy('Auto_Send')).toBe('auto_send')
    expect(asReviewPolicy('ALWAYS_REVIEW')).toBe('auto_send')
  })
})

describe('shouldHoldForReview — auto_send', () => {
  it('never holds when policy is auto_send (current behaviour preserved)', () => {
    expect(
      shouldHoldForReview({ policy: 'auto_send', totalIncGst: 99 }).hold,
    ).toBe(false)
    expect(
      shouldHoldForReview({ policy: 'auto_send', totalIncGst: 99999 }).hold,
    ).toBe(false)
  })

  it('defaults missing policy to auto_send (pre-migration rows safe)', () => {
    expect(shouldHoldForReview({ totalIncGst: 1500 }).hold).toBe(false)
    expect(shouldHoldForReview({ policy: null, totalIncGst: 1500 }).hold).toBe(false)
  })

  it('reason string identifies the policy that decided the outcome', () => {
    const r = shouldHoldForReview({ policy: 'auto_send', totalIncGst: 500 })
    expect(r.reason).toBe('tenant_policy_auto_send')
  })
})

describe('shouldHoldForReview — always_review', () => {
  it('always holds regardless of total', () => {
    expect(
      shouldHoldForReview({ policy: 'always_review', totalIncGst: 1 }).hold,
    ).toBe(true)
    expect(
      shouldHoldForReview({ policy: 'always_review', totalIncGst: 999999 }).hold,
    ).toBe(true)
  })

  it('holds even with no total set (defensive)', () => {
    expect(
      shouldHoldForReview({ policy: 'always_review' }).hold,
    ).toBe(true)
  })

  it('reason string identifies always_review', () => {
    const r = shouldHoldForReview({ policy: 'always_review', totalIncGst: 100 })
    expect(r.reason).toBe('tenant_policy_always_review')
  })
})

describe('shouldHoldForReview — review_over_threshold', () => {
  it('holds when total >= threshold', () => {
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: 500,
        totalIncGst: 500,
      }).hold,
    ).toBe(true)
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: 500,
        totalIncGst: 1941,
      }).hold,
    ).toBe(true)
  })

  it('auto-sends when total < threshold', () => {
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: 500,
        totalIncGst: 499.99,
      }).hold,
    ).toBe(false)
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: 500,
        totalIncGst: 99,
      }).hold,
    ).toBe(false)
  })

  it('coerces string numerics from the DB', () => {
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: '500',
        totalIncGst: '750',
      }).hold,
    ).toBe(true)
  })

  it('falls back to auto-send when threshold is zero or missing (legacy rows)', () => {
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: 0,
        totalIncGst: 5000,
      }).hold,
    ).toBe(false)
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: null,
        totalIncGst: 5000,
      }).hold,
    ).toBe(false)
  })

  it('holds defensively when total is unparseable', () => {
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: 500,
        totalIncGst: null,
      }).hold,
    ).toBe(true)
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: 500,
        totalIncGst: 'NaN',
      }).hold,
    ).toBe(true)
  })

  it('reason string carries the comparison numbers for audit logs', () => {
    const over = shouldHoldForReview({
      policy: 'review_over_threshold',
      threshold: 500,
      totalIncGst: 750,
    })
    expect(over.reason).toBe('total_750_at_or_over_threshold_500')
    const under = shouldHoldForReview({
      policy: 'review_over_threshold',
      threshold: 500,
      totalIncGst: 300,
    })
    expect(under.reason).toBe('total_300_under_threshold_500')
  })
})

describe('shouldHoldForReview — bypass rules', () => {
  it('inspection routes bypass the gate even under always_review', () => {
    const r = shouldHoldForReview({
      policy: 'always_review',
      totalIncGst: 99,
      isInspection: true,
    })
    expect(r.hold).toBe(false)
    expect(r.reason).toBe('inspection_route_bypasses_gate')
  })

  it('inspection routes bypass review_over_threshold too', () => {
    expect(
      shouldHoldForReview({
        policy: 'review_over_threshold',
        threshold: 500,
        totalIncGst: 99,
        isInspection: true,
      }).hold,
    ).toBe(false)
  })

  it('always_review has no customer-side bypass — the WP9 product picker does NOT auto-send', () => {
    // Regression guard. Earlier behaviour treated a customer tapping a
    // product variant in the mid-chat picker as a price commitment and
    // silently flipped off the tradie's "review every quote" toggle.
    // That was wrong: the picker selects a variant, not a price. The
    // tradie's explicit toggle wins. Tradies who want a value-based
    // gate use review_over_threshold instead.
    const r = shouldHoldForReview({
      policy: 'always_review',
      totalIncGst: 1941,
    })
    expect(r.hold).toBe(true)
    expect(r.reason).toBe('tenant_policy_always_review')
  })

  it('inspection bypass works even when policy would otherwise hold under always_review', () => {
    // Inspection is the only bypass that overrides always_review —
    // the $99 site visit has no pricing decision worth reviewing.
    const r = shouldHoldForReview({
      policy: 'always_review',
      totalIncGst: 99,
      isInspection: true,
    })
    expect(r.hold).toBe(false)
    expect(r.reason).toBe('inspection_route_bypasses_gate')
  })
})
