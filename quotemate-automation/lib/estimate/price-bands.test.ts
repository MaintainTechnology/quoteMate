// Phase 1c — unit tests for the price-bands pure module.
//
// Coverage:
//   • Numeric band bucketing (boundary inclusivity, catch-all upper band)
//   • Select band exact-match (case-insensitive, trim)
//   • default_when_unanswered fallback (numeric + select)
//   • Missing slot with NO default → question skipped silently
//   • Unknown select value → falls through, no line items
//   • String-number coercion ("8" → 8)
//   • Multi-question accumulation
//   • Risk-flag-only band (no labour, no materials)
//   • Assembly override (last select band wins)
//   • Material with bad price → skipped, not crashed
//   • Bad pricing_book hourly_rate → bail early with empty result
//   • The user's worked example end-to-end: GPO + 8m distance

import { describe, expect, it } from 'vitest'
import {
  applyPriceBands,
  type PriceQuestion,
  type NumericBand,
  type SelectBand,
} from './price-bands'

const pricingBook = { hourly_rate: 118 }

describe('price-bands: numeric bands', () => {
  const distance: PriceQuestion = {
    id: 'distance_to_existing_power',
    question: 'How far to the nearest existing power point? (metres)',
    variant: 'numeric',
    default_when_unanswered: 2,
    bands: [
      { max: 2, label: 'near existing power' },
      { max: 5, label: 'short extension', extra_labour_hr: 0.5 },
      {
        max: 10,
        label: 'longer run',
        extra_labour_hr: 1.0,
        extra_materials: [
          {
            description: 'TPS cable 2.5mm² × 10m (longer run)',
            quantity: 10,
            unit: 'lm',
            unit_price_ex_gst: 6.8,
            source: 'material:tps-2.5',
          },
        ],
      },
      {
        max: Number.POSITIVE_INFINITY,
        label: 'extended run (assumed up to 20m)',
        extra_labour_hr: 2.0,
        extra_materials: [
          {
            description: 'TPS cable 2.5mm² × 20m (extended run; final length verified onsite)',
            quantity: 20,
            unit: 'lm',
            unit_price_ex_gst: 6.8,
            source: 'material:tps-2.5',
          },
        ],
        risk_flag:
          'Cable run assumed up to 20m. Longer runs adjusted on confirmation with tradie.',
      },
    ],
  }

  it('answer in the lowest band → no line items, no risk flags', () => {
    const r = applyPriceBands([distance], { distance_to_existing_power: 1 }, pricingBook)
    expect(r.extra_line_items).toHaveLength(0)
    expect(r.risk_flags).toHaveLength(0)
    expect(r.defaults_used).toHaveLength(0)
  })

  it('boundary inclusive — answer === max picks that band', () => {
    // 2 is in the first band (max=2). 5 is in the second band (max=5).
    const r1 = applyPriceBands([distance], { distance_to_existing_power: 2 }, pricingBook)
    expect(r1.extra_line_items).toHaveLength(0)
    const r2 = applyPriceBands([distance], { distance_to_existing_power: 5 }, pricingBook)
    expect(r2.extra_line_items).toHaveLength(1) // just the 0.5hr labour line
    expect(r2.extra_line_items[0].quantity).toBe(0.5)
  })

  it('mid-band answer (8m) → applies the 10m band: labour + cable', () => {
    const r = applyPriceBands([distance], { distance_to_existing_power: 8 }, pricingBook)
    expect(r.extra_line_items).toHaveLength(2)
    const labour = r.extra_line_items.find((li) => li.unit === 'hr')
    expect(labour).toBeDefined()
    expect(labour?.quantity).toBe(1.0)
    expect(labour?.unit_price_ex_gst).toBe(118)
    expect(labour?.source).toBe('labour')
    const cable = r.extra_line_items.find((li) => li.unit === 'lm')
    expect(cable).toBeDefined()
    expect(cable?.quantity).toBe(10)
    expect(cable?.source).toBe('material:tps-2.5')
  })

  it('above all bounded bands (50m) → catch-all (max=Infinity) wins, risk_flag stamped', () => {
    const r = applyPriceBands([distance], { distance_to_existing_power: 50 }, pricingBook)
    expect(r.extra_line_items).toHaveLength(2)
    expect(r.risk_flags).toHaveLength(1)
    expect(r.risk_flags[0]).toMatch(/up to 20m/)
  })

  it('missing slot → default_when_unanswered (2) → no line items, defaults_used populated', () => {
    const r = applyPriceBands([distance], {}, pricingBook)
    expect(r.extra_line_items).toHaveLength(0)
    expect(r.defaults_used).toEqual(['distance_to_existing_power'])
  })

  it('null slot → treated as missing → default applies', () => {
    const r = applyPriceBands(
      [distance],
      { distance_to_existing_power: null },
      pricingBook,
    )
    expect(r.defaults_used).toEqual(['distance_to_existing_power'])
  })

  it('string-numeric coercion ("8" → 8) → applies the 10m band correctly', () => {
    const r = applyPriceBands(
      [distance],
      { distance_to_existing_power: '8' },
      pricingBook,
    )
    expect(r.extra_line_items).toHaveLength(2)
  })

  it('non-numeric answer ("two metres") → ignored, no line items, defaults not used either', () => {
    const r = applyPriceBands(
      [distance],
      { distance_to_existing_power: 'two metres' },
      pricingBook,
    )
    expect(r.extra_line_items).toHaveLength(0)
    expect(r.defaults_used).toHaveLength(0)
  })
})

describe('price-bands: select bands', () => {
  const amperage: PriceQuestion = {
    id: 'circuit_required',
    question: 'Standard 10A is fine for most appliances. Need 20A, 32A, or three-phase?',
    variant: 'select',
    default_when_unanswered: '10A',
    bands: [
      { value: '10A', label: 'standard 10A' },
      {
        value: '20A',
        label: 'dedicated 20A circuit',
        use_assembly_id: 'asm-gpo-20a',
        extra_labour_hr: 0.5,
        risk_flag: 'Dedicated 20A circuit added — spare way on switchboard required.',
      },
      {
        value: 'three-phase',
        label: '3-phase outlet',
        use_assembly_id: 'asm-gpo-3phase',
        extra_labour_hr: 1.5,
        risk_flag: '3-phase outlet — switchboard capacity must be verified.',
      },
    ],
  }

  it('exact match → applies band, sets assembly_override_id', () => {
    const r = applyPriceBands(
      [amperage],
      { circuit_required: '20A' },
      pricingBook,
    )
    expect(r.assembly_override_id).toBe('asm-gpo-20a')
    expect(r.extra_line_items[0].quantity).toBe(0.5)
    expect(r.risk_flags).toHaveLength(1)
  })

  it('case + whitespace tolerance — "20a" trimmed and lowercased matches "20A"', () => {
    const r = applyPriceBands(
      [amperage],
      { circuit_required: '  20a  ' },
      pricingBook,
    )
    expect(r.assembly_override_id).toBe('asm-gpo-20a')
  })

  it('default ("10A") → first band wins → no line items, no override', () => {
    const r = applyPriceBands([amperage], {}, pricingBook)
    expect(r.extra_line_items).toHaveLength(0)
    expect(r.assembly_override_id).toBeUndefined()
    expect(r.defaults_used).toEqual(['circuit_required'])
  })

  it('unknown value ("415V") → silently dropped, no line items, no override', () => {
    const r = applyPriceBands(
      [amperage],
      { circuit_required: '415V' },
      pricingBook,
    )
    expect(r.extra_line_items).toHaveLength(0)
    expect(r.assembly_override_id).toBeUndefined()
    expect(r.defaults_used).toHaveLength(0)
  })

  it('last assembly-overriding band wins when multiple select questions fire', () => {
    const secondQ: PriceQuestion = {
      id: 'mount_type',
      question: 'Surface or flush mount?',
      variant: 'select',
      bands: [
        { value: 'surface', label: 'surface mount', use_assembly_id: 'asm-gpo-surface' },
        { value: 'flush', label: 'flush mount', use_assembly_id: 'asm-gpo-flush' },
      ],
    }
    const r = applyPriceBands(
      [amperage, secondQ],
      { circuit_required: '20A', mount_type: 'flush' },
      pricingBook,
    )
    // amperage set assembly_override_id first, then mount_type overwrote it.
    expect(r.assembly_override_id).toBe('asm-gpo-flush')
  })
})

describe('price-bands: edge cases', () => {
  it('question without default + missing slot → skipped silently', () => {
    const q: PriceQuestion = {
      id: 'optional_metric',
      question: 'Optional question',
      variant: 'numeric',
      bands: [{ max: 10, label: 'short' }],
    }
    const r = applyPriceBands([q], {}, pricingBook)
    expect(r.extra_line_items).toHaveLength(0)
    expect(r.defaults_used).toHaveLength(0)
  })

  it('risk-flag-only band → only stamps risk_flag, no line items', () => {
    const q: PriceQuestion = {
      id: 'note_only',
      question: 'note',
      variant: 'select',
      bands: [
        {
          value: 'true',
          risk_flag: 'Switchboard spare-way confirmed by customer.',
        },
      ],
    }
    const r = applyPriceBands([q], { note_only: 'true' }, pricingBook)
    expect(r.extra_line_items).toHaveLength(0)
    expect(r.risk_flags).toEqual(['Switchboard spare-way confirmed by customer.'])
  })

  it('multi-question accumulation', () => {
    const q1: PriceQuestion = {
      id: 'metric_a',
      question: 'a',
      variant: 'numeric',
      bands: [
        { max: 10, label: 'a-small', extra_labour_hr: 0.5 },
        { max: Number.POSITIVE_INFINITY, label: 'a-large', extra_labour_hr: 1 },
      ],
    }
    const q2: PriceQuestion = {
      id: 'metric_b',
      question: 'b',
      variant: 'numeric',
      bands: [
        { max: 5, label: 'b-small', extra_labour_hr: 0.25, risk_flag: 'b is small' },
        { max: Number.POSITIVE_INFINITY, label: 'b-large', extra_labour_hr: 0.75 },
      ],
    }
    const r = applyPriceBands(
      [q1, q2],
      { metric_a: 100, metric_b: 3 },
      pricingBook,
    )
    expect(r.extra_line_items).toHaveLength(2)
    expect(r.extra_line_items[0].quantity).toBe(1)
    expect(r.extra_line_items[1].quantity).toBe(0.25)
    expect(r.risk_flags).toEqual(['b is small'])
  })

  it('material with NaN price → skipped, valid material still emitted', () => {
    const q: PriceQuestion = {
      id: 'm',
      question: 'm',
      variant: 'numeric',
      bands: [
        {
          max: Number.POSITIVE_INFINITY,
          extra_materials: [
            {
              description: 'bad price item',
              quantity: 1,
              unit: 'each',
              unit_price_ex_gst: Number.NaN,
            },
            {
              description: 'good cable',
              quantity: 5,
              unit: 'lm',
              unit_price_ex_gst: 6.8,
            },
          ],
        },
      ],
    }
    const r = applyPriceBands([q], { m: 1 }, pricingBook)
    expect(r.extra_line_items).toHaveLength(1)
    expect(r.extra_line_items[0].description).toBe('good cable')
  })

  it('zero / negative quantity material → skipped', () => {
    const q: PriceQuestion = {
      id: 'm',
      question: 'm',
      variant: 'numeric',
      bands: [
        {
          max: Number.POSITIVE_INFINITY,
          extra_materials: [
            { description: 'zero-q', quantity: 0, unit: 'each', unit_price_ex_gst: 10 },
            { description: 'neg-q', quantity: -5, unit: 'each', unit_price_ex_gst: 10 },
            { description: 'real', quantity: 1, unit: 'each', unit_price_ex_gst: 10 },
          ],
        },
      ],
    }
    const r = applyPriceBands([q], { m: 1 }, pricingBook)
    expect(r.extra_line_items).toHaveLength(1)
    expect(r.extra_line_items[0].description).toBe('real')
  })

  it('misconfigured pricing book (hourly_rate=0) → bails early, returns empty', () => {
    const q: PriceQuestion = {
      id: 'distance',
      question: 'd',
      variant: 'numeric',
      bands: [{ max: 10, extra_labour_hr: 1 }],
    }
    const r = applyPriceBands([q], { distance: 5 }, { hourly_rate: 0 })
    expect(r.extra_line_items).toHaveLength(0)
  })

  it('pricing book hourly_rate as string ("118") → parsed correctly', () => {
    const q: PriceQuestion = {
      id: 'distance',
      question: 'd',
      variant: 'numeric',
      bands: [{ max: 10, extra_labour_hr: 1 }],
    }
    const r = applyPriceBands([q], { distance: 5 }, { hourly_rate: '118' })
    expect(r.extra_line_items).toHaveLength(1)
    expect(r.extra_line_items[0].unit_price_ex_gst).toBe(118)
  })
})

describe('price-bands: markup application (Phase 2)', () => {
  // Phase 2 evolution: bands store RAW catalogue prices, the engine
  // multiplies by pricing_book.default_markup_pct so one shared recipe
  // can be authored once and applied across tenants with different
  // markup policies.
  const cableQuestion: PriceQuestion = {
    id: 'distance_to_existing_power',
    question: 'distance to existing power point',
    variant: 'numeric',
    bands: [
      { max: 2 },
      {
        max: 10,
        label: 'longer run',
        extra_labour_hr: 1.0,
        extra_materials: [
          {
            description: 'TPS cable 2.5mm² × 10m',
            quantity: 10,
            unit: 'lm',
            unit_price_ex_gst: 5,  // RAW catalogue price per metre
            source: 'material:tps-2.5',
          },
        ],
      },
    ],
  }

  it('applies 36% markup to material prices (Sparky default)', () => {
    const r = applyPriceBands(
      [cableQuestion],
      { distance_to_existing_power: 8 },
      { hourly_rate: 118, default_markup_pct: 36 },
    )
    const cable = r.extra_line_items.find((li) => li.unit === 'lm')
    expect(cable).toBeDefined()
    // raw 5 × 1.36 = 6.80
    expect(cable?.unit_price_ex_gst).toBe(6.80)
  })

  it('applies 20% markup to material prices (plumbing default)', () => {
    const r = applyPriceBands(
      [cableQuestion],
      { distance_to_existing_power: 8 },
      { hourly_rate: 120, default_markup_pct: 20 },
    )
    const cable = r.extra_line_items.find((li) => li.unit === 'lm')
    // raw 5 × 1.20 = 6.00
    expect(cable?.unit_price_ex_gst).toBe(6.00)
  })

  it('markup_pct as string ("36") is parsed', () => {
    const r = applyPriceBands(
      [cableQuestion],
      { distance_to_existing_power: 8 },
      { hourly_rate: 118, default_markup_pct: '36' },
    )
    const cable = r.extra_line_items.find((li) => li.unit === 'lm')
    expect(cable?.unit_price_ex_gst).toBe(6.80)
  })

  it('missing default_markup_pct → passthrough (back-compat with Phase 1)', () => {
    const r = applyPriceBands(
      [cableQuestion],
      { distance_to_existing_power: 8 },
      { hourly_rate: 118 },  // no markup specified
    )
    const cable = r.extra_line_items.find((li) => li.unit === 'lm')
    // Raw 5 passes through unchanged
    expect(cable?.unit_price_ex_gst).toBe(5)
  })

  it('zero/negative markup_pct → passthrough', () => {
    const r1 = applyPriceBands(
      [cableQuestion],
      { distance_to_existing_power: 8 },
      { hourly_rate: 118, default_markup_pct: 0 },
    )
    expect(r1.extra_line_items.find((li) => li.unit === 'lm')?.unit_price_ex_gst).toBe(5)
    const r2 = applyPriceBands(
      [cableQuestion],
      { distance_to_existing_power: 8 },
      { hourly_rate: 118, default_markup_pct: -10 },
    )
    expect(r2.extra_line_items.find((li) => li.unit === 'lm')?.unit_price_ex_gst).toBe(5)
  })

  it('labour is NOT marked up — uses hourly_rate directly', () => {
    const r = applyPriceBands(
      [cableQuestion],
      { distance_to_existing_power: 8 },
      { hourly_rate: 118, default_markup_pct: 36 },
    )
    const labour = r.extra_line_items.find((li) => li.unit === 'hr')
    // Labour stays at $118/hr, not $118 × 1.36
    expect(labour?.unit_price_ex_gst).toBe(118)
  })

  it('marked-up prices rounded to 2 decimal places (matches grounding tolerance)', () => {
    const q: PriceQuestion = {
      id: 'd',
      question: 'd',
      variant: 'numeric',
      bands: [
        {
          max: null,
          extra_materials: [
            {
              description: 'odd price',
              quantity: 1,
              unit: 'each',
              unit_price_ex_gst: 7.33,  // raw
            },
          ],
        },
      ],
    }
    const r = applyPriceBands([q], { d: 1 }, { hourly_rate: 118, default_markup_pct: 28 })
    // 7.33 × 1.28 = 9.3824 → rounded to 9.38
    expect(r.extra_line_items[0].unit_price_ex_gst).toBe(9.38)
  })
})

describe('price-bands: max=null catch-all sentinel (Phase 2 DB compat)', () => {
  // Phase 2 stores recipes in shared_assemblies.price_recipe (jsonb).
  // JSON.stringify(Infinity) → "null", so the on-disk shape uses
  // `max: null` for the catch-all. The interpreter must accept both
  // Number.POSITIVE_INFINITY (Phase 1 test fixtures) AND null (DB shape).
  it('null max acts as catch-all', () => {
    const q: PriceQuestion = {
      id: 'metric',
      question: 'q',
      variant: 'numeric',
      bands: [
        { max: 10, extra_labour_hr: 0.5 },
        { max: null, extra_labour_hr: 2.0, risk_flag: 'unbounded' },
      ],
    }
    const r1 = applyPriceBands([q], { metric: 5 }, { hourly_rate: 118 })
    expect(r1.extra_line_items[0].quantity).toBe(0.5)
    expect(r1.risk_flags).toHaveLength(0)

    const r2 = applyPriceBands([q], { metric: 9999 }, { hourly_rate: 118 })
    expect(r2.extra_line_items[0].quantity).toBe(2.0)
    expect(r2.risk_flags).toEqual(['unbounded'])
  })

  it('max=null first in array → catches all answers (even 0)', () => {
    // Edge case: if author puts null first, every numeric answer lands here.
    // The engine doesn't second-guess band order; it's the author's job
    // to order ascending. This test documents the behaviour rather than
    // protecting against it.
    const q: PriceQuestion = {
      id: 'metric',
      question: 'q',
      variant: 'numeric',
      bands: [
        { max: null, extra_labour_hr: 1, label: 'catch-all-first' },
        { max: 10, extra_labour_hr: 5, label: 'never-reached' },
      ],
    }
    const r = applyPriceBands([q], { metric: 5 }, { hourly_rate: 118 })
    expect(r.extra_line_items[0].quantity).toBe(1)
    expect(r.extra_line_items[0].description).toContain('catch-all-first')
  })

  it('round-trip through JSON.stringify preserves null-max bands', () => {
    // The DB stores recipes as jsonb. Author writes max:null in the
    // migration; the runtime reads it back the same way. Verify that a
    // JSON round-trip produces an interpretable recipe.
    const original: PriceQuestion = {
      id: 'metric',
      question: 'q',
      variant: 'numeric',
      bands: [
        { max: 5, label: 'short' },
        { max: null, label: 'long', extra_labour_hr: 1 },
      ],
    }
    const roundTripped = JSON.parse(JSON.stringify(original)) as PriceQuestion
    const r = applyPriceBands([roundTripped], { metric: 100 }, { hourly_rate: 118 })
    expect(r.extra_line_items).toHaveLength(1)
    expect(r.extra_line_items[0].description).toContain('long')
  })
})

describe('price-bands: worked example — GPO with 8m cable run', () => {
  // Mirrors the example in the design conversation: customer wants a GPO,
  // nearest power point is 8m away, no amperage specified. Expected
  // behaviour: standard 10A assembly (no override), +1.0hr labour for
  // the cable extension, +10m TPS cable as a separate line item. No
  // inspection routing.
  const questions: PriceQuestion[] = [
    {
      id: 'distance_to_existing_power',
      question: 'How far to the nearest existing power point? (metres)',
      variant: 'numeric',
      default_when_unanswered: 2,
      bands: [
        { max: 2, label: 'near existing power' },
        { max: 5, label: 'short extension', extra_labour_hr: 0.5 },
        {
          max: 10,
          label: 'longer run',
          extra_labour_hr: 1.0,
          extra_materials: [
            {
              description: 'TPS cable 2.5mm² × 10m',
              quantity: 10,
              unit: 'lm',
              unit_price_ex_gst: 6.8,
              source: 'material:tps-2.5',
            },
          ],
        },
        {
          max: Number.POSITIVE_INFINITY,
          label: 'extended run',
          extra_labour_hr: 2.0,
          risk_flag: 'Cable run assumed up to 20m — verified onsite.',
        },
      ],
    },
    {
      id: 'circuit_required',
      question: '10A standard, 20A, or three-phase?',
      variant: 'select',
      default_when_unanswered: '10A',
      bands: [
        { value: '10A', label: 'standard 10A' },
        {
          value: '20A',
          use_assembly_id: 'asm-gpo-20a',
          extra_labour_hr: 0.5,
        },
      ],
    },
  ]

  it('produces the right recipe output for the worked example', () => {
    const r = applyPriceBands(
      questions,
      { distance_to_existing_power: 8 },
      pricingBook,
    )
    expect(r.assembly_override_id).toBeUndefined() // standard 10A — no swap
    expect(r.extra_line_items).toHaveLength(2)
    const labour = r.extra_line_items.find((li) => li.unit === 'hr')
    expect(labour).toEqual({
      description: 'Additional labour — longer run',
      quantity: 1.0,
      unit: 'hr',
      unit_price_ex_gst: 118,
      source: 'labour',
    })
    const cable = r.extra_line_items.find((li) => li.unit === 'lm')
    expect(cable?.quantity).toBe(10)
    expect(cable?.source).toBe('material:tps-2.5')
    expect(r.risk_flags).toHaveLength(0)
    expect(r.defaults_used).toEqual(['circuit_required'])
  })
})
