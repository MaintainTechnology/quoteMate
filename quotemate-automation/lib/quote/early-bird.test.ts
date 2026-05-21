// v8 Phase A — early-booking discount, pure-logic coverage.
//
// Locks the margin cap, the offer/expiry maths, the server-side-live
// gate, and the discount arithmetic so a future change can't silently
// over-discount a quote or resurrect an expired offer.

import { describe, expect, it } from 'vitest'
import {
  MAX_EARLY_BIRD_DISCOUNT_PCT,
  DEFAULT_EARLY_BIRD_WINDOW_HOURS,
  MAX_EARLY_BIRD_WINDOW_HOURS,
  clampDiscountPct,
  parseEarlyBirdConfig,
  earlyBirdConfigFromOverlays,
  computeEarlyBirdOffer,
  earlyBirdStatus,
  isEarlyBirdLive,
  applyEarlyBirdDiscount,
  earlyBirdSavingAmount,
  fmtEarlyBirdDeadlineAU,
  fmtEarlyBirdRemaining,
} from './early-bird'

const HOUR = 60 * 60 * 1000

describe('clampDiscountPct — the margin guardrail', () => {
  it('passes a valid in-range pct through', () => {
    expect(clampDiscountPct(10)).toBe(10)
    expect(clampDiscountPct(15)).toBe(15)
  })
  it('clamps anything above the cap to 15', () => {
    expect(clampDiscountPct(20)).toBe(MAX_EARLY_BIRD_DISCOUNT_PCT)
    expect(clampDiscountPct(999)).toBe(15)
  })
  it('floors negative / zero to 0', () => {
    expect(clampDiscountPct(-5)).toBe(0)
    expect(clampDiscountPct(0)).toBe(0)
  })
  it('treats non-numbers as 0', () => {
    expect(clampDiscountPct(null)).toBe(0)
    expect(clampDiscountPct(undefined)).toBe(0)
    expect(clampDiscountPct('not a number')).toBe(0)
    expect(clampDiscountPct(NaN)).toBe(0)
    expect(clampDiscountPct({})).toBe(0)
  })
  it('accepts numeric strings (hand-edited overlays jsonb)', () => {
    expect(clampDiscountPct('10')).toBe(10)
    expect(clampDiscountPct('99')).toBe(15)
  })
})

describe('parseEarlyBirdConfig', () => {
  it('parses a valid enabled config', () => {
    expect(
      parseEarlyBirdConfig({ enabled: true, discount_pct: 10, window_hours: 24 }),
    ).toEqual({ enabled: true, discountPct: 10, windowHours: 24 })
  })
  it('disables when enabled is not explicitly true', () => {
    expect(parseEarlyBirdConfig({ discount_pct: 10, window_hours: 24 }).enabled).toBe(false)
    expect(parseEarlyBirdConfig({ enabled: false, discount_pct: 10 }).enabled).toBe(false)
    expect(parseEarlyBirdConfig({ enabled: 'yes', discount_pct: 10 }).enabled).toBe(false)
  })
  it('disables when the discount clamps to 0', () => {
    expect(parseEarlyBirdConfig({ enabled: true, discount_pct: 0 }).enabled).toBe(false)
    expect(parseEarlyBirdConfig({ enabled: true, discount_pct: -3 }).enabled).toBe(false)
  })
  it('clamps an over-cap discount instead of rejecting it', () => {
    const c = parseEarlyBirdConfig({ enabled: true, discount_pct: 50, window_hours: 12 })
    expect(c.enabled).toBe(true)
    expect(c.discountPct).toBe(15)
  })
  it('defaults a missing / invalid window to 24h', () => {
    expect(parseEarlyBirdConfig({ enabled: true, discount_pct: 10 }).windowHours).toBe(
      DEFAULT_EARLY_BIRD_WINDOW_HOURS,
    )
    expect(
      parseEarlyBirdConfig({ enabled: true, discount_pct: 10, window_hours: 0 }).windowHours,
    ).toBe(24)
    expect(
      parseEarlyBirdConfig({ enabled: true, discount_pct: 10, window_hours: -5 }).windowHours,
    ).toBe(24)
  })
  it('clamps an absurd window to the 14-day max', () => {
    expect(
      parseEarlyBirdConfig({ enabled: true, discount_pct: 10, window_hours: 99999 }).windowHours,
    ).toBe(MAX_EARLY_BIRD_WINDOW_HOURS)
  })
  it('returns a disabled config for garbage input', () => {
    expect(parseEarlyBirdConfig(null).enabled).toBe(false)
    expect(parseEarlyBirdConfig(undefined).enabled).toBe(false)
    expect(parseEarlyBirdConfig('nonsense').enabled).toBe(false)
    expect(parseEarlyBirdConfig(42).enabled).toBe(false)
  })
})

describe('earlyBirdConfigFromOverlays', () => {
  it('reads the early_bird key out of an overlays object', () => {
    const c = earlyBirdConfigFromOverlays({
      brand_hint: 'whatever',
      early_bird: { enabled: true, discount_pct: 12 },
    })
    expect(c.enabled).toBe(true)
    expect(c.discountPct).toBe(12)
  })
  it('disabled when overlays has no early_bird key', () => {
    expect(earlyBirdConfigFromOverlays({ something: 1 }).enabled).toBe(false)
  })
  it('disabled when overlays itself is null / not an object', () => {
    expect(earlyBirdConfigFromOverlays(null).enabled).toBe(false)
    expect(earlyBirdConfigFromOverlays(undefined).enabled).toBe(false)
    expect(earlyBirdConfigFromOverlays('x').enabled).toBe(false)
  })
})

describe('computeEarlyBirdOffer', () => {
  const config = { enabled: true as const, discountPct: 10, windowHours: 24 }
  it('produces an offer that expires window_hours after creation', () => {
    const createdAt = '2026-05-21T00:00:00.000Z'
    const offer = computeEarlyBirdOffer(config, createdAt)
    expect(offer).not.toBeNull()
    expect(offer!.discountPct).toBe(10)
    expect(offer!.expiresAt).toBe('2026-05-22T00:00:00.000Z')
  })
  it('returns null for a disabled config', () => {
    expect(
      computeEarlyBirdOffer({ enabled: false, discountPct: 0, windowHours: 24 }, '2026-05-21T00:00:00.000Z'),
    ).toBeNull()
  })
  it('returns null for a missing / unparseable created-at', () => {
    expect(computeEarlyBirdOffer(config, null)).toBeNull()
    expect(computeEarlyBirdOffer(config, undefined)).toBeNull()
    expect(computeEarlyBirdOffer(config, 'not a date')).toBeNull()
  })
})

describe('earlyBirdStatus', () => {
  const now = Date.parse('2026-05-21T12:00:00.000Z')
  it('live when the deadline is in the future', () => {
    const s = earlyBirdStatus(10, '2026-05-21T21:00:00.000Z', now)
    expect(s.state).toBe('live')
    expect(s.discountPct).toBe(10)
    expect(s.hoursRemaining).toBe(9)
    expect(s.msRemaining).toBe(9 * HOUR)
  })
  it('expired when the deadline has passed', () => {
    const s = earlyBirdStatus(10, '2026-05-21T06:00:00.000Z', now)
    expect(s.state).toBe('expired')
    expect(s.discountPct).toBe(0)
    expect(s.msRemaining).toBeLessThan(0)
  })
  it('expired exactly at the deadline (boundary — not live)', () => {
    expect(earlyBirdStatus(10, '2026-05-21T12:00:00.000Z', now).state).toBe('expired')
  })
  it('none when there is no discount', () => {
    expect(earlyBirdStatus(0, '2026-05-21T21:00:00.000Z', now).state).toBe('none')
  })
  it('none when there is no deadline', () => {
    expect(earlyBirdStatus(10, null, now).state).toBe('none')
    expect(earlyBirdStatus(10, undefined, now).state).toBe('none')
  })
  it('none when the deadline is unparseable', () => {
    expect(earlyBirdStatus(10, 'garbage', now).state).toBe('none')
  })
  it('clamps an over-cap stamped discount when reporting live', () => {
    expect(earlyBirdStatus(80, '2026-05-21T21:00:00.000Z', now).discountPct).toBe(15)
  })
})

describe('isEarlyBirdLive — the server-side gate', () => {
  const now = Date.parse('2026-05-21T12:00:00.000Z')
  it('true only while the offer is genuinely claimable', () => {
    expect(isEarlyBirdLive(10, '2026-05-21T21:00:00.000Z', now)).toBe(true)
    expect(isEarlyBirdLive(10, '2026-05-21T06:00:00.000Z', now)).toBe(false)
    expect(isEarlyBirdLive(0, '2026-05-21T21:00:00.000Z', now)).toBe(false)
    expect(isEarlyBirdLive(10, null, now)).toBe(false)
  })
})

describe('applyEarlyBirdDiscount', () => {
  it('discounts by the given pct, rounded to the dollar', () => {
    expect(applyEarlyBirdDiscount(1000, 10)).toBe(900)
    expect(applyEarlyBirdDiscount(820, 10)).toBe(738)
    expect(applyEarlyBirdDiscount(999, 15)).toBe(849) // 849.15 → 849
  })
  it('is a no-op for a 0 / missing discount', () => {
    expect(applyEarlyBirdDiscount(1000, 0)).toBe(1000)
    expect(applyEarlyBirdDiscount(1000, null)).toBe(1000)
    expect(applyEarlyBirdDiscount(1000, undefined)).toBe(1000)
  })
  it('never over-discounts — an out-of-range pct is clamped to 15%', () => {
    expect(applyEarlyBirdDiscount(1000, 90)).toBe(850)
    expect(applyEarlyBirdDiscount(1000, 999)).toBe(850)
  })
  it('returns 0 for a non-positive / non-finite amount', () => {
    expect(applyEarlyBirdDiscount(0, 10)).toBe(0)
    expect(applyEarlyBirdDiscount(-100, 10)).toBe(0)
    expect(applyEarlyBirdDiscount(NaN, 10)).toBe(0)
  })
})

describe('earlyBirdSavingAmount', () => {
  it('is the dollar gap between original and discounted', () => {
    expect(earlyBirdSavingAmount(1000, 10)).toBe(100)
    expect(earlyBirdSavingAmount(820, 10)).toBe(82)
  })
  it('is 0 when there is no discount', () => {
    expect(earlyBirdSavingAmount(1000, 0)).toBe(0)
    expect(earlyBirdSavingAmount(0, 10)).toBe(0)
  })
  it('reconstructs the original: discounted + saving === original', () => {
    const original = 1234
    expect(
      applyEarlyBirdDiscount(original, 10) + earlyBirdSavingAmount(original, 10),
    ).toBe(Math.round(original))
  })
})

describe('fmtEarlyBirdDeadlineAU', () => {
  it('formats an ISO timestamp as an ASCII AU date+time', () => {
    const out = fmtEarlyBirdDeadlineAU('2026-05-22T11:00:00.000Z') // 9:00pm AEST
    expect(out).toMatch(/May/)
    expect(out).toMatch(/pm/)
    // GSM-7 safe — no characters outside printable ASCII.
    expect(out).toMatch(/^[\x20-\x7E]*$/)
  })
  it('returns empty string for missing / unparseable input', () => {
    expect(fmtEarlyBirdDeadlineAU(null)).toBe('')
    expect(fmtEarlyBirdDeadlineAU(undefined)).toBe('')
    expect(fmtEarlyBirdDeadlineAU('not a date')).toBe('')
  })
})

describe('fmtEarlyBirdRemaining', () => {
  const now = Date.parse('2026-05-21T12:00:00.000Z')
  it('days when more than a day remains', () => {
    expect(
      fmtEarlyBirdRemaining(earlyBirdStatus(10, '2026-05-23T12:00:00.000Z', now)),
    ).toBe('2 days left')
  })
  it('hours when under a day remains', () => {
    expect(
      fmtEarlyBirdRemaining(earlyBirdStatus(10, '2026-05-21T21:00:00.000Z', now)),
    ).toBe('9 hours left')
  })
  it('singular hour, and a last-hour message', () => {
    expect(
      fmtEarlyBirdRemaining(earlyBirdStatus(10, '2026-05-21T13:00:00.000Z', now)),
    ).toBe('1 hour left')
    expect(
      fmtEarlyBirdRemaining(earlyBirdStatus(10, '2026-05-21T12:30:00.000Z', now)),
    ).toBe('Last hour to lock it in')
  })
  it('empty string when the offer is not live', () => {
    expect(
      fmtEarlyBirdRemaining(earlyBirdStatus(10, '2026-05-21T06:00:00.000Z', now)),
    ).toBe('')
    expect(fmtEarlyBirdRemaining(earlyBirdStatus(0, null, now))).toBe('')
  })
})
