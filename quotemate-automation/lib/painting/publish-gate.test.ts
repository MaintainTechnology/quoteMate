import { describe, expect, it } from 'vitest'
import {
  canShowPaintingPrices,
  paintingDepositLocked,
  paintingReleaseEligibility,
} from './publish-gate'

describe('canShowPaintingPrices', () => {
  it('hides prices until the tradie releases', () => {
    const r = canShowPaintingPrices({ releasedAt: null })
    expect(r.showPrices).toBe(false)
    expect(r.reason).toMatch(/saved.*awaiting.*review/i)
    expect(r.reason).not.toMatch(/shortly|on its way|will send/i)
  })
  it('shows prices once released', () => {
    expect(canShowPaintingPrices({ releasedAt: '2026-06-26T00:00:00Z' })).toEqual({ showPrices: true, reason: null })
  })
})

describe('paintingDepositLocked', () => {
  it('is locked until released', () => {
    expect(paintingDepositLocked(null)).toBe(true)
    expect(paintingDepositLocked(undefined)).toBe(true)
    expect(paintingDepositLocked('2026-06-26T00:00:00Z')).toBe(false)
  })
})

describe('paintingReleaseEligibility', () => {
  // Spec tradie-onsite-quote-editing R5 — the eligibility now also decides
  // whether to SEND: first release stamps + sends; a released row resends
  // only on an explicit resend request (post-edit); otherwise it stays the
  // idempotent no-op that never re-texts.
  it('stamps and sends on first release', () => {
    expect(paintingReleaseEligibility({ alreadyReleasedAt: null })).toEqual({
      ok: true,
      stamp: true,
      send: true,
    })
  })
  it('is an idempotent no-op once released AND SENT (no restamp, no send)', () => {
    expect(
      paintingReleaseEligibility({
        alreadyReleasedAt: '2026-06-26T00:00:00Z',
        alreadySentAt: '2026-06-26T00:00:05Z',
      }),
    ).toEqual({ ok: true, stamp: false, send: false })
  })
  // Spec painting-auto-send — released_at only means "prices may show". A
  // dashboard save stamps it and texts nobody, so Send must actually send
  // rather than no-op on the first press.
  it('sends (without restamping) when released but never sent', () => {
    expect(paintingReleaseEligibility({ alreadyReleasedAt: '2026-06-26T00:00:00Z' })).toEqual({
      ok: true,
      stamp: false,
      send: true,
    })
    expect(
      paintingReleaseEligibility({
        alreadyReleasedAt: '2026-06-26T00:00:00Z',
        alreadySentAt: null,
      }),
    ).toEqual({ ok: true, stamp: false, send: true })
  })
  it('resends a released+sent quote on an explicit resend, without restamping', () => {
    expect(
      paintingReleaseEligibility({
        alreadyReleasedAt: '2026-06-26T00:00:00Z',
        alreadySentAt: '2026-06-26T00:00:05Z',
        resend: true,
      }),
    ).toEqual({ ok: true, stamp: false, send: true })
  })
  it('a resend flag on a never-released row is just the first release', () => {
    expect(paintingReleaseEligibility({ alreadyReleasedAt: null, resend: true })).toEqual({
      ok: true,
      stamp: true,
      send: true,
    })
  })
})
