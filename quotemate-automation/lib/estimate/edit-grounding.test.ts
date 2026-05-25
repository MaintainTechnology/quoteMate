// H-2 (2026-05-25) — coverage for the grounding gate that
// /api/quote/[id]/edit runs on hand-edited tiers before persisting.
//
// Pre-H-2 the edit route recomputed tier subtotals from line items and
// re-issued Stripe Sessions WITHOUT re-checking that the new prices
// derived from pricing_book + catalogue. That meant a tradie could
// edit a $200 GPO line down to $20 (under cost), inject a fabricated
// "supervisor fee", or zero out labour entirely — all of which would
// persist and propagate to a new Stripe Checkout.
//
// Post-H-2 the route calls validateQuoteGrounding on ONLY the tiers
// the tradie edited. Untouched tiers stay as-is (they were grounded
// at draft time). These tests prove the gate accepts grounded edits
// and rejects ungrounded ones — the route wiring (auth, force flag,
// risk_flag stamping, Stripe re-issue) is then a TS guarantee.

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

const candidates = buildCandidatePrices(
  // materials — raw + 28% markup will produce $25, $28, $32, $35.20 etc.
  [
    { name: 'Standard double GPO', price: 25, category: 'gpo' },
    { name: 'Weatherproof double GPO (IP56)', price: 58, category: 'gpo' },
  ],
  // assemblies
  [{ name: 'Replace double GPO', price: 95, category: 'gpo' }],
  pricingBook,
)

describe('H-2: edit-route grounding gate', () => {
  it('accepts an edit where every line is grounded (happy path)', () => {
    const editedDraft = {
      good: {
        line_items: [
          // Call-out — grounds against pricing_book.call_out_minimum
          {
            description: 'Call-out fee',
            quantity: 1,
            unit: 'each',
            unit_price_ex_gst: 150,
            source: 'callout',
          },
          // Labour — grounds against hourly_rate
          {
            description: 'Install GPOs',
            quantity: 2,
            unit: 'hr',
            unit_price_ex_gst: 110,
          },
          // Material — grounds against shared_materials × default markup (25×1.28=32)
          {
            description: 'Standard double GPO',
            quantity: 4,
            unit: 'each',
            unit_price_ex_gst: 32,
          },
        ],
      },
      better: null,
      best: null,
    }
    const r = validateQuoteGrounding(editedDraft, pricingBook, candidates)
    expect(r.valid).toBe(true)
  })

  it('rejects a fabricated line item (e.g. tradie-added "supervisor fee")', () => {
    const editedDraft = {
      good: {
        line_items: [
          {
            description: 'Call-out fee',
            quantity: 1,
            unit: 'each',
            unit_price_ex_gst: 150,
            source: 'callout',
          },
          {
            description: 'Install GPOs',
            quantity: 2,
            unit: 'hr',
            unit_price_ex_gst: 110,
          },
          // Fabricated — no DB row matches "$400 supervisor fee"
          {
            description: 'Supervisor oversight fee',
            quantity: 1,
            unit: 'each',
            unit_price_ex_gst: 400,
          },
        ],
      },
      better: null,
      best: null,
    }
    const r = validateQuoteGrounding(editedDraft, pricingBook, candidates)
    expect(r.valid).toBe(false)
    if (!r.valid) {
      expect(r.failures.some((f) => f.description === 'Supervisor oversight fee')).toBe(true)
    }
  })

  it('rejects an under-cost edit (tradie discounts a $25 GPO to $5)', () => {
    const editedDraft = {
      good: {
        line_items: [
          {
            description: 'Call-out fee',
            quantity: 1,
            unit: 'each',
            unit_price_ex_gst: 150,
            source: 'callout',
          },
          {
            description: 'Install GPOs',
            quantity: 2,
            unit: 'hr',
            unit_price_ex_gst: 110,
          },
          // Under cost — $5 is way below any candidate price
          {
            description: 'Standard double GPO',
            quantity: 4,
            unit: 'each',
            unit_price_ex_gst: 5,
          },
        ],
      },
      better: null,
      best: null,
    }
    const r = validateQuoteGrounding(editedDraft, pricingBook, candidates)
    expect(r.valid).toBe(false)
  })

  it('rejects an edit that zeroes out labour (skips min-labour floor)', () => {
    const editedDraft = {
      good: {
        line_items: [
          // Only material — no labour line at all
          {
            description: 'Standard double GPO',
            quantity: 4,
            unit: 'each',
            unit_price_ex_gst: 32,
          },
        ],
      },
      better: null,
      best: null,
    }
    const r = validateQuoteGrounding(editedDraft, pricingBook, candidates)
    expect(r.valid).toBe(false)
    if (!r.valid) {
      // The validator flags the tier-level labour floor failure with lineIndex=-1
      expect(r.failures.some((f) => f.lineIndex === -1 && f.unit === 'hr')).toBe(true)
    }
  })

  it('skips untouched tiers (only edited tiers go through the gate)', () => {
    // Mimics the edit route's pattern: untouched tiers are nulled out
    // before being passed to the validator. An ungrounded "better" or
    // "best" tier the route never touches cannot fail the gate.
    const editedDraft = {
      good: {
        line_items: [
          {
            description: 'Call-out fee',
            quantity: 1,
            unit: 'each',
            unit_price_ex_gst: 150,
            source: 'callout',
          },
          {
            description: 'Install GPOs',
            quantity: 2,
            unit: 'hr',
            unit_price_ex_gst: 110,
          },
        ],
      },
      better: null, // tradie didn't edit — skipped by validator
      best: null,
    }
    const r = validateQuoteGrounding(editedDraft, pricingBook, candidates)
    expect(r.valid).toBe(true)
  })

  it('flags multiple failures across tiers so the route can list them all', () => {
    const editedDraft = {
      good: {
        line_items: [
          {
            description: 'Call-out fee',
            quantity: 1,
            unit: 'each',
            unit_price_ex_gst: 150,
            source: 'callout',
          },
          {
            description: 'Install GPOs',
            quantity: 2,
            unit: 'hr',
            unit_price_ex_gst: 110,
          },
          // Fail 1: fabricated
          {
            description: 'Mystery fee',
            quantity: 1,
            unit: 'each',
            unit_price_ex_gst: 999,
          },
        ],
      },
      better: {
        line_items: [
          {
            description: 'Call-out fee',
            quantity: 1,
            unit: 'each',
            unit_price_ex_gst: 150,
            source: 'callout',
          },
          {
            description: 'Install GPOs',
            quantity: 2,
            unit: 'hr',
            unit_price_ex_gst: 110,
          },
          // Fail 2: under cost
          {
            description: 'Standard double GPO',
            quantity: 4,
            unit: 'each',
            unit_price_ex_gst: 1,
          },
        ],
      },
      best: null,
    }
    const r = validateQuoteGrounding(editedDraft, pricingBook, candidates)
    expect(r.valid).toBe(false)
    if (!r.valid) {
      expect(r.failures.length).toBeGreaterThanOrEqual(2)
      const tiers = new Set(r.failures.map((f) => f.tier))
      expect(tiers.has('good')).toBe(true)
      expect(tiers.has('better')).toBe(true)
    }
  })
})
