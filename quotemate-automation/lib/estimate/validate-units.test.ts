// L-1 (2026-05-25) — coverage for the unit allowlist in
// validateQuoteGrounding. Pre-L-1 the validator accepted only
// hr / each / lm and dumped any line emitting unit='m' or 'metre' to
// inspection. That blocked auto-quoting LED strip (priced per metre)
// and any future per-metre material the catalogue grows into.
//
// Post-L-1: 'm' and 'metre' are accepted as aliases for 'lm' on the
// VALIDATION side. The candidate side carries no unit, so price + name
// category matching is unaffected.

import { describe, expect, it } from 'vitest'
import {
  validateQuoteGrounding,
  buildCandidatePrices,
  type PricingBookForValidation,
} from './validate'

const pricingBook: PricingBookForValidation = {
  hourly_rate: 110,
  apprentice_rate: 60,
  call_out_minimum: 150,
  default_markup_pct: 28,
  min_labour_hours: 2,
}

// Two candidate rows: one priced per-metre (LED strip), one priced per-each.
// Markup expansion (28% default + ±5pp drift) brings $40 raw → $40, $52.80,
// $51.20, $50.00 etc. We use the raw $40 in the test to keep arithmetic
// simple.
const candidates = buildCandidatePrices(
  // materials
  [{ name: 'LED strip light', price: 40, category: 'strip_light' }],
  // assemblies
  [{ name: 'Install LED strip lighting', price: 80, category: 'strip_light' }],
  pricingBook,
)

function draft(unit: string) {
  return {
    needs_inspection: false,
    good: {
      line_items: [
        // 2 hr labour at hourly_rate → meets min_labour_hours floor + valid
        {
          description: 'Site visit + setup time',
          quantity: 2,
          unit: 'hr',
          unit_price_ex_gst: 110,
        },
        // 5 of the per-metre material at raw $40 — exercising the unit.
        {
          description: 'Supply LED strip light (5 metres)',
          quantity: 5,
          unit,
          unit_price_ex_gst: 40,
        },
      ],
    },
    better: null,
    best: null,
  }
}

describe('L-1: validateQuoteGrounding unit allowlist', () => {
  it('accepts unit="lm" (the canonical metric)', () => {
    const r = validateQuoteGrounding(draft('lm'), pricingBook, candidates)
    expect(r.valid).toBe(true)
  })

  it('accepts unit="m" (alias for lm — added in L-1)', () => {
    const r = validateQuoteGrounding(draft('m'), pricingBook, candidates)
    expect(r.valid).toBe(true)
  })

  it('accepts unit="metre" (alias for lm — added in L-1)', () => {
    const r = validateQuoteGrounding(draft('metre'), pricingBook, candidates)
    expect(r.valid).toBe(true)
  })

  it('rejects unknown units (e.g. "kg") so unsupported units still fail loudly', () => {
    const r = validateQuoteGrounding(draft('kg'), pricingBook, candidates)
    expect(r.valid).toBe(false)
    if (!r.valid) {
      expect(r.failures.some((f) => f.expected.includes('recognised unit'))).toBe(true)
    }
  })

  it('rejects empty unit', () => {
    const r = validateQuoteGrounding(draft(''), pricingBook, candidates)
    expect(r.valid).toBe(false)
  })
})
