// Drift guard for the single source of truth (lib/estimate/categories).
//
// These don't test behaviour — they fail the BUILD if the one list is
// malformed, so the "every consumer keeps its own copy and they drift"
// bug class (which left 10 services uncategorised) cannot come back.

import { describe, expect, it } from 'vitest'
import {
  CATEGORIES,
  CATEGORY_VALUES,
  CATEGORY_ENUM_TUPLE,
  isCategory,
} from './categories'

describe('categories — single-source invariants', () => {
  it('has no duplicate values', () => {
    const values = CATEGORIES.map((c) => c.value)
    expect(new Set(values).size).toBe(values.length)
  })

  it('every entry has a non-empty human label (form dropdown is never blank)', () => {
    for (const c of CATEGORIES) {
      expect(typeof c.label).toBe('string')
      expect(c.label.trim().length).toBeGreaterThan(0)
    }
  })

  it('CATEGORY_VALUES, CATEGORY_ENUM_TUPLE and CATEGORIES stay in lockstep', () => {
    const values = CATEGORIES.map((c) => c.value)
    expect(CATEGORY_VALUES.size).toBe(values.length)
    expect([...CATEGORY_ENUM_TUPLE].sort()).toEqual([...values].sort())
    for (const v of values) expect(CATEGORY_VALUES.has(v)).toBe(true)
  })

  it('isCategory accepts every listed value and rejects anything else', () => {
    for (const c of CATEGORIES) expect(isCategory(c.value)).toBe(true)
    expect(isCategory('not_a_category')).toBe(false)
    expect(isCategory('')).toBe(false)
    expect(isCategory(null)).toBe(false)
    expect(isCategory(undefined)).toBe(false)
  })

  it('still contains the original + migration-029 categories (regression pin)', () => {
    // If a refactor accidentally drops one of these, the validator would
    // silently stop recognising that whole class of job.
    for (const must of [
      'downlight', 'gpo', 'smoke_alarm', 'hot_water', 'toilet', 'gas',
      'sundry', 'general',
      'fault_find', 'strip_light', 'security_camera', 'doorbell_intercom',
      'dishwasher', 'rainwater_tank', 'water_filter', 'leak_detection', 'shower',
    ]) {
      expect(CATEGORY_VALUES.has(must as never)).toBe(true)
    }
  })
})
