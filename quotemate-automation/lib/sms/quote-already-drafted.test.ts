// Regression coverage for the quoteAlreadyDrafted suppression rule.
//
// The 2026-05-28 prod bug (Sparky convo 1c639179) was caused by treating
// status='done' alone as "quote was drafted" — which conflated dismissal
// (decision.action='end_conversation') with delivery. These tests pin
// the corrected rule so the conflation can't sneak back in.

import { describe, expect, it } from 'vitest'
import { quoteAlreadyDrafted } from './quote-already-drafted'

describe('quoteAlreadyDrafted', () => {
  it('returns false for mode=new regardless of prior state', () => {
    expect(
      quoteAlreadyDrafted('new', { status: 'done', intake_id: 'intake-1' }),
    ).toBe(false)
    expect(quoteAlreadyDrafted('new', { status: 'structuring' })).toBe(false)
    expect(quoteAlreadyDrafted('new', null)).toBe(false)
  })

  it('returns false when prior is null/undefined', () => {
    expect(quoteAlreadyDrafted('reuse', null)).toBe(false)
    expect(quoteAlreadyDrafted('reuse', undefined)).toBe(false)
    expect(quoteAlreadyDrafted('inflight', null)).toBe(false)
  })

  it('returns true on reuse when prior has intake_id (quote was drafted)', () => {
    expect(
      quoteAlreadyDrafted('reuse', { status: 'done', intake_id: 'intake-1' }),
    ).toBe(true)
  })

  it('returns true on reuse when prior.status=structuring (handoff in flight)', () => {
    // intake_id may not be visible to this read yet during the 50s
    // structuring window — status is the authoritative signal here.
    expect(
      quoteAlreadyDrafted('reuse', { status: 'structuring', intake_id: null }),
    ).toBe(true)
  })

  it('REGRESSION 2026-05-28: status=done WITHOUT intake_id must NOT be treated as drafted', () => {
    // Sparky convo 1c639179: customer said "nothing for now bye"
    // → decision.action='end_conversation' → status='done'. Re-engaged
    // within the 5-min reuse window. Old logic flipped this to "drafted",
    // killing the photo SMS + WP9 picker + intake handoff. Result:
    // dialog said "quote on its way shortly" then ghosted the customer.
    expect(
      quoteAlreadyDrafted('reuse', { status: 'done', intake_id: null }),
    ).toBe(false)
  })

  it('REGRESSION 2026-05-28: same rule applies to inflight mode', () => {
    // mode='inflight' is also a reuse path; the same conflation could
    // sneak in if the rule were duplicated. Lock it down here too.
    expect(
      quoteAlreadyDrafted('inflight', { status: 'done', intake_id: null }),
    ).toBe(false)
  })

  it('escalate_inspection that wrote status=done with no intake stays NOT-drafted', () => {
    // Inspection escalations end the dialog and write status='done'
    // without an intake_id. The route already has its own inspection
    // handling; do NOT also treat it as "quote drafted".
    expect(
      quoteAlreadyDrafted('reuse', { status: 'done', intake_id: null }),
    ).toBe(false)
  })

  it('handles missing status field gracefully', () => {
    // Defensive — status column is text on the DB; a NULL or absent
    // value should not throw, and definitely should not be treated as
    // structuring.
    expect(quoteAlreadyDrafted('reuse', { intake_id: null })).toBe(false)
    expect(quoteAlreadyDrafted('reuse', { status: null, intake_id: null })).toBe(false)
  })

  it('intake_id alone wins regardless of status', () => {
    // If the handoff fired, suppress — even if status drifted to
    // something unexpected (defensive against future status-enum churn).
    expect(
      quoteAlreadyDrafted('reuse', { status: 'open', intake_id: 'intake-1' }),
    ).toBe(true)
    expect(
      quoteAlreadyDrafted('reuse', { status: null, intake_id: 'intake-1' }),
    ).toBe(true)
  })
})
