// Regression coverage for the onboarding activate schema.
//
// History: the wizard initialises optional advanced-pricing inputs to
// '' (empty string). z.coerce.number() coerces '' → 0, which silently
// tripped `.min(1)` on after_hours_multiplier and would have done the
// same to any future floored numeric. These tests lock in the fix:
// every optional numeric must treat '' / null / undefined as "not
// provided" rather than coercing to 0.

import { describe, expect, it } from 'vitest'
import { OnboardActivateSchema, defaultsForTrade } from './schema'

const baseValidPayload = {
  business_name: 'Acme Sparkies',
  owner_first_name: 'Jane',
  owner_email: 'jane@example.com',
  owner_mobile: '0412345678',
  trades: ['electrical'] as const,
  state: 'NSW' as const,
  hourly_rate: '100',
  call_out_minimum: '150',
  default_markup_pct: '15',
}

describe('OnboardActivateSchema — optional advanced-pricing fields', () => {
  it('accepts the wizard\'s blank-form payload (all advanced fields empty strings)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      apprentice_rate: '',
      senior_rate: '',
      after_hours_multiplier: '',
      min_labour_hours: '',
      risk_buffer_pct: '',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.apprentice_rate).toBeUndefined()
      expect(result.data.senior_rate).toBeUndefined()
      expect(result.data.after_hours_multiplier).toBeUndefined()
      expect(result.data.min_labour_hours).toBeUndefined()
      expect(result.data.risk_buffer_pct).toBeUndefined()
    }
  })

  it('accepts payload when advanced fields are omitted entirely', () => {
    const result = OnboardActivateSchema.safeParse(baseValidPayload)
    expect(result.success).toBe(true)
  })

  it('treats null the same as an empty string (parses as undefined)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      after_hours_multiplier: null,
      min_labour_hours: null,
      risk_buffer_pct: null,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.after_hours_multiplier).toBeUndefined()
      expect(result.data.min_labour_hours).toBeUndefined()
      expect(result.data.risk_buffer_pct).toBeUndefined()
    }
  })

  it('coerces numeric strings to numbers when present', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      apprentice_rate: '55',
      senior_rate: '180',
      after_hours_multiplier: '1.75',
      min_labour_hours: '2',
      risk_buffer_pct: '10',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.apprentice_rate).toBe(55)
      expect(result.data.senior_rate).toBe(180)
      expect(result.data.after_hours_multiplier).toBe(1.75)
      expect(result.data.min_labour_hours).toBe(2)
      expect(result.data.risk_buffer_pct).toBe(10)
    }
  })
})

describe('OnboardActivateSchema — after_hours_multiplier boundaries', () => {
  it('accepts 1 (lower bound)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      after_hours_multiplier: 1,
    })
    expect(result.success).toBe(true)
  })

  it('accepts 3 (upper bound)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      after_hours_multiplier: 3,
    })
    expect(result.success).toBe(true)
  })

  it('rejects 0.99 (just below floor)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      after_hours_multiplier: 0.99,
    })
    expect(result.success).toBe(false)
  })

  it('rejects 3.01 (just above ceiling)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      after_hours_multiplier: 3.01,
    })
    expect(result.success).toBe(false)
  })

  it("does NOT coerce empty string to 0 (the original regression)", () => {
    // The bug: '' → 0 → fails .min(1) with a confusing error.
    // The fix: '' → undefined → optional() accepts it.
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      after_hours_multiplier: '',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.after_hours_multiplier).toBeUndefined()
    }
  })
})

describe('OnboardActivateSchema — min_labour_hours boundaries', () => {
  it('accepts 0 (lower bound)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      min_labour_hours: 0,
    })
    expect(result.success).toBe(true)
  })

  it('accepts 8 (upper bound)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      min_labour_hours: 8,
    })
    expect(result.success).toBe(true)
  })

  it('rejects -0.5 (below floor)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      min_labour_hours: -0.5,
    })
    expect(result.success).toBe(false)
  })

  it('rejects 8.5 (above ceiling)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      min_labour_hours: 8.5,
    })
    expect(result.success).toBe(false)
  })
})

describe('OnboardActivateSchema — risk_buffer_pct boundaries', () => {
  it('accepts 0', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      risk_buffer_pct: 0,
    })
    expect(result.success).toBe(true)
  })

  it('accepts 100', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      risk_buffer_pct: 100,
    })
    expect(result.success).toBe(true)
  })

  it('rejects 100.01', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      risk_buffer_pct: 100.01,
    })
    expect(result.success).toBe(false)
  })

  it('rejects negative values', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      risk_buffer_pct: -1,
    })
    expect(result.success).toBe(false)
  })
})

describe('OnboardActivateSchema — required pricing fields', () => {
  it('rejects empty hourly_rate (required field, no defaults backstop)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      hourly_rate: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects 0 hourly_rate (must be positive)', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      hourly_rate: 0,
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty call_out_minimum', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      call_out_minimum: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects default_markup_pct > 100', () => {
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      default_markup_pct: 101,
    })
    expect(result.success).toBe(false)
  })
})

describe('defaultsForTrade — values must satisfy the schema', () => {
  // This is the safety net: if anyone ever tightens a schema bound past
  // a default value, this test fires loudly instead of letting the
  // activate route try to insert an invalid row.
  it('electrical defaults pass the schema as a complete payload', () => {
    const defaults = defaultsForTrade('electrical')
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      ...defaults,
    })
    expect(result.success).toBe(true)
  })

  it('plumbing defaults pass the schema as a complete payload', () => {
    const defaults = defaultsForTrade('plumbing')
    const result = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      trades: ['plumbing'] as const,
      ...defaults,
    })
    expect(result.success).toBe(true)
  })

  it('electrical after_hours_multiplier default lies inside [1, 3]', () => {
    const d = defaultsForTrade('electrical')
    expect(d.after_hours_multiplier).toBeGreaterThanOrEqual(1)
    expect(d.after_hours_multiplier).toBeLessThanOrEqual(3)
  })

  it('plumbing after_hours_multiplier default lies inside [1, 3]', () => {
    const d = defaultsForTrade('plumbing')
    expect(d.after_hours_multiplier).toBeGreaterThanOrEqual(1)
    expect(d.after_hours_multiplier).toBeLessThanOrEqual(3)
  })

  it('min_labour_hours defaults lie inside [0, 8] for both trades', () => {
    for (const trade of ['electrical', 'plumbing'] as const) {
      const d = defaultsForTrade(trade)
      expect(d.min_labour_hours).toBeGreaterThanOrEqual(0)
      expect(d.min_labour_hours).toBeLessThanOrEqual(8)
    }
  })

  it('risk_buffer_pct defaults lie inside [0, 100] for both trades', () => {
    for (const trade of ['electrical', 'plumbing'] as const) {
      const d = defaultsForTrade(trade)
      expect(d.risk_buffer_pct).toBeGreaterThanOrEqual(0)
      expect(d.risk_buffer_pct).toBeLessThanOrEqual(100)
    }
  })
})

describe('OnboardActivateSchema — blank-wizard → defaults round-trip', () => {
  // Simulates the exact activate-route flow: tradie submits a payload
  // with every advanced field blank, schema parses, then the route
  // applies defaultsForTrade(...) via `??`. The merged row must satisfy
  // every database-bound constraint (mirrored by the schema bounds).
  it('electrical: blank payload + defaults still validates as a complete payload', () => {
    const blank = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      apprentice_rate: '',
      senior_rate: '',
      after_hours_multiplier: '',
      min_labour_hours: '',
      risk_buffer_pct: '',
    })
    expect(blank.success).toBe(true)
    if (!blank.success) return

    const defaults = defaultsForTrade('electrical')
    const merged = {
      ...blank.data,
      apprentice_rate: blank.data.apprentice_rate ?? defaults.apprentice_rate,
      senior_rate: blank.data.senior_rate ?? defaults.senior_rate,
      after_hours_multiplier:
        blank.data.after_hours_multiplier ?? defaults.after_hours_multiplier,
      min_labour_hours:
        blank.data.min_labour_hours ?? defaults.min_labour_hours,
      risk_buffer_pct: blank.data.risk_buffer_pct ?? defaults.risk_buffer_pct,
    }

    // Re-parse the merged result through the schema. If a future
    // tightening of bounds breaks the default, this fails loudly.
    const reparsed = OnboardActivateSchema.safeParse(merged)
    expect(reparsed.success).toBe(true)
    if (reparsed.success) {
      expect(reparsed.data.after_hours_multiplier).toBe(1.5)
      expect(reparsed.data.min_labour_hours).toBe(2)
      expect(reparsed.data.risk_buffer_pct).toBe(15)
    }
  })

  it('plumbing: blank payload + defaults still validates as a complete payload', () => {
    const blank = OnboardActivateSchema.safeParse({
      ...baseValidPayload,
      trades: ['plumbing'] as const,
      apprentice_rate: '',
      senior_rate: '',
      after_hours_multiplier: '',
      min_labour_hours: '',
      risk_buffer_pct: '',
    })
    expect(blank.success).toBe(true)
    if (!blank.success) return

    const defaults = defaultsForTrade('plumbing')
    const merged = {
      ...blank.data,
      apprentice_rate: blank.data.apprentice_rate ?? defaults.apprentice_rate,
      senior_rate: blank.data.senior_rate ?? defaults.senior_rate,
      after_hours_multiplier:
        blank.data.after_hours_multiplier ?? defaults.after_hours_multiplier,
      min_labour_hours:
        blank.data.min_labour_hours ?? defaults.min_labour_hours,
      risk_buffer_pct: blank.data.risk_buffer_pct ?? defaults.risk_buffer_pct,
    }

    const reparsed = OnboardActivateSchema.safeParse(merged)
    expect(reparsed.success).toBe(true)
    if (reparsed.success) {
      expect(reparsed.data.after_hours_multiplier).toBe(1.5)
      expect(reparsed.data.min_labour_hours).toBe(1.5)
      expect(reparsed.data.risk_buffer_pct).toBe(15)
    }
  })
})

describe('OnboardActivateSchema — class-of-bug guard', () => {
  // Every optional numeric pricing field in the schema. If a new one is
  // added, add it here too — this test exists specifically to catch the
  // "I added a new optional number with a floor > 0" regression.
  const OPTIONAL_NUMERIC_FIELDS = [
    'apprentice_rate',
    'senior_rate',
    'after_hours_multiplier',
    'min_labour_hours',
    'risk_buffer_pct',
  ] as const

  for (const field of OPTIONAL_NUMERIC_FIELDS) {
    it(`field "${field}" — empty string MUST parse as undefined, not 0`, () => {
      const result = OnboardActivateSchema.safeParse({
        ...baseValidPayload,
        [field]: '',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect((result.data as Record<string, unknown>)[field]).toBeUndefined()
      }
    })
  }
})
