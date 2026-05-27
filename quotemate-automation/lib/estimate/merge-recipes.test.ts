// Phase 3 — unit tests for the recipe-merge integration layer.
//
// Coverage:
//   • No-op when draft has no recipe-bearing assembly
//   • No-op when recipe map is empty (fast-path short-circuit)
//   • Append: extra labour + cable lines materialise when bands fire
//   • Swap: assembly_override replaces sundries + labour, preserves materials
//   • Swap with missing override target → defensive no-swap, no-op
//   • Subtotal recompute matches sum(quantity × unit_price)
//   • Risk-flag accumulation across multiple tiers + dedupe
//   • Multi-tier draft — good processed, better/best skipped when null
//   • Defaults reported via outcome.defaults_used when slots are missing
//   • buildRecipeSlots helper merges intake.scope + conversation_state
//   • Material lines / callout / risk_buffer preserved on swap

import { describe, expect, it } from 'vitest'
import {
  mergeRecipesIntoTier,
  mergeRecipesIntoDraft,
  buildRecipeSlots,
  type AssemblyMeta,
} from './merge-recipes'
import type { PriceQuestion } from './price-bands'

const pricingBook = { hourly_rate: 118, default_markup_pct: 36 }

const GPO_BASE_ID = 'asm-gpo-base'
const GPO_20A_ID = 'asm-gpo-20a'
const TPS_CABLE_ID = 'mat-tps-2.5'

const RECIPE_GPO_DISTANCE_AND_AMPERAGE: PriceQuestion[] = [
  {
    id: 'distance_to_existing_power',
    question: 'distance to existing power',
    variant: 'numeric',
    default_when_unanswered: 2,
    bands: [
      { max: 2, label: 'near' },
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
            unit_price_ex_gst: 5, // raw — × 1.36 = 6.80
            source: `material:${TPS_CABLE_ID}`,
          },
        ],
      },
      { max: null, label: 'unbounded', extra_labour_hr: 2, risk_flag: 'long run' },
    ],
  },
  {
    id: 'circuit_required',
    question: 'amperage',
    variant: 'select',
    default_when_unanswered: '10A',
    bands: [
      { value: '10A', label: 'standard' },
      {
        value: '20A',
        label: 'dedicated 20A',
        use_assembly_id: GPO_20A_ID,
        risk_flag: 'switchboard spare way required',
      },
    ],
  },
]

const ASSEMBLIES_BY_ID: Map<string, AssemblyMeta> = new Map([
  [
    GPO_BASE_ID,
    {
      id: GPO_BASE_ID,
      name: 'Replace double GPO',
      default_unit_price_ex_gst: 22,
      default_labour_hours: 0.3,
    },
  ],
  [
    GPO_20A_ID,
    {
      id: GPO_20A_ID,
      name: 'Install 20A dedicated GPO',
      default_unit_price_ex_gst: 80,
      default_labour_hours: 2.0,
    },
  ],
])

const RECIPES_BY_ID = new Map<string, readonly PriceQuestion[]>([
  [GPO_BASE_ID, RECIPE_GPO_DISTANCE_AND_AMPERAGE],
])

function baseGpoTier() {
  // Mirrors what Opus typically emits for "Replace double GPO":
  // an assembly sundries line + a labour line + (optional) materials.
  return {
    label: 'Standard GPO replacement',
    line_items: [
      {
        description: 'Replace double GPO',
        quantity: 1,
        unit: 'each',
        unit_price_ex_gst: 29.92, // $22 × 1.36
        total_ex_gst: 29.92,
        source: `assembly:${GPO_BASE_ID}`,
      },
      {
        description: 'Labour — GPO replacement',
        quantity: 0.3,
        unit: 'hr',
        unit_price_ex_gst: 118,
        total_ex_gst: 35.4,
        source: 'labour',
      },
    ],
    subtotal_ex_gst: 65.32,
  }
}

describe('mergeRecipesIntoTier: no-op paths', () => {
  it('tier without any recipe-bearing assembly is unchanged', () => {
    const tier = {
      line_items: [
        { source: 'assembly:asm-unknown', unit_price_ex_gst: 50, quantity: 1, unit: 'each' },
        { source: 'labour', quantity: 1, unit: 'hr', unit_price_ex_gst: 118 },
      ],
      subtotal_ex_gst: 168,
    }
    const r = mergeRecipesIntoTier(tier, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: {},
      pricingBook,
    })
    expect(r.outcome.changed).toBe(false)
    expect(r.tier).toBe(tier) // referential equality on no-op
  })

  it('tier with empty line_items is unchanged', () => {
    const tier = { line_items: [], subtotal_ex_gst: 0 }
    const r = mergeRecipesIntoTier(tier, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: { distance_to_existing_power: 8 },
      pricingBook,
    })
    expect(r.outcome.changed).toBe(false)
  })
})

describe('mergeRecipesIntoTier: append path', () => {
  it('8m + 10A slots → adds labour + cable, recomputes subtotal', () => {
    const tier = baseGpoTier()
    const r = mergeRecipesIntoTier(tier, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: { distance_to_existing_power: 8, circuit_required: '10A' },
      pricingBook,
    })
    expect(r.outcome.changed).toBe(true)
    expect(r.outcome.recipes_fired).toEqual([GPO_BASE_ID])
    expect(r.outcome.swapped_to).toEqual([])
    expect(r.outcome.added_line_items).toBe(2)
    // 4 lines total: 2 originals + 2 appended (labour + cable)
    expect(r.tier.line_items).toHaveLength(4)
    const cable = r.tier.line_items!.find((li) => li.unit === 'lm')
    expect(cable?.unit_price_ex_gst).toBe(6.8) // 5 × 1.36
    expect(cable?.quantity).toBe(10)
    // Subtotal = 29.92 + 35.4 + (1 × 118) + (10 × 6.80) = 65.32 + 118 + 68 = 251.32
    expect(r.tier.subtotal_ex_gst).toBe(251.32)
  })

  it('missing slots use defaults — defaults_used reported', () => {
    const tier = baseGpoTier()
    const r = mergeRecipesIntoTier(tier, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: {}, // nothing provided
      pricingBook,
    })
    // Distance defaults to 2 (near band — no extras). Amperage defaults
    // to 10A (no swap). So no actual changes — but defaults_used should
    // still record both fallbacks. Because no extras were appended AND
    // no override fired, recipes_fired records the recipe ran but
    // outcome.changed stays false (nothing to merge).
    expect(r.outcome.recipes_fired).toEqual([GPO_BASE_ID])
    expect(r.outcome.defaults_used.sort()).toEqual(
      ['circuit_required', 'distance_to_existing_power'].sort(),
    )
    expect(r.outcome.added_line_items).toBe(0)
    expect(r.outcome.changed).toBe(false)
  })

  it('appends risk_flag when unbounded distance band fires', () => {
    const r = mergeRecipesIntoTier(baseGpoTier(), {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: { distance_to_existing_power: 50, circuit_required: '10A' },
      pricingBook,
    })
    expect(r.outcome.changed).toBe(true)
    expect(r.outcome.risk_flags_added).toEqual(['long run'])
  })
})

describe('mergeRecipesIntoTier: swap path', () => {
  it('20A select → replaces base assembly + labour with 20A versions, preserves other lines', () => {
    const tier = {
      line_items: [
        {
          description: 'Replace double GPO',
          quantity: 1,
          unit: 'each',
          unit_price_ex_gst: 29.92,
          source: `assembly:${GPO_BASE_ID}`,
        },
        {
          description: 'Labour — GPO replacement',
          quantity: 0.3,
          unit: 'hr',
          unit_price_ex_gst: 118,
          source: 'labour',
        },
        {
          description: 'Clipsal 10A double GPO',
          quantity: 1,
          unit: 'each',
          unit_price_ex_gst: 25,
          source: 'material:mat-clipsal',
        },
        {
          description: 'Call-out',
          quantity: 1,
          unit: 'each',
          unit_price_ex_gst: 160,
          source: 'callout',
        },
      ],
      subtotal_ex_gst: 250.32,
    }
    const r = mergeRecipesIntoTier(tier, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: { distance_to_existing_power: 2, circuit_required: '20A' },
      pricingBook,
    })
    expect(r.outcome.changed).toBe(true)
    expect(r.outcome.swapped_from).toEqual([GPO_BASE_ID])
    expect(r.outcome.swapped_to).toEqual([GPO_20A_ID])
    // Expected line composition:
    //   1. New sundries for 20A assembly:  $80 × 1.36 = $108.80
    //   2. New labour for 20A:             2.0hr × $118 = $236
    //   3. Preserved Clipsal GPO material  ($25)
    //   4. Preserved callout               ($160)
    expect(r.tier.line_items).toHaveLength(4)
    const newSundries = r.tier.line_items![0]
    expect(newSundries.description).toBe('Install 20A dedicated GPO')
    expect(newSundries.unit_price_ex_gst).toBe(108.8)
    expect(newSundries.source).toBe(`assembly:${GPO_20A_ID}`)
    const newLabour = r.tier.line_items![1]
    expect(newLabour.description).toBe('Labour — Install 20A dedicated GPO')
    expect(newLabour.quantity).toBe(2)
    expect(newLabour.unit_price_ex_gst).toBe(118)
    expect(newLabour.source).toBe('labour')
    // Material + callout preserved (order: after the swap pair)
    const sources = r.tier.line_items!.map((li) => li.source)
    expect(sources).toContain('material:mat-clipsal')
    expect(sources).toContain('callout')
    // Subtotal: 108.80 + 236 + 25 + 160 = 529.80
    expect(r.tier.subtotal_ex_gst).toBe(529.8)
    // Risk flag for switchboard spare way recorded
    expect(r.outcome.risk_flags_added).toContain('switchboard spare way required')
  })

  it('swap target missing from assembliesById → falls back to no-swap', () => {
    // Recipe wants to swap to an id that isn't in the assembliesById map.
    // Should defensively keep the original lines, not mis-price.
    const tier = baseGpoTier()
    const r = mergeRecipesIntoTier(tier, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: new Map([[GPO_BASE_ID, ASSEMBLIES_BY_ID.get(GPO_BASE_ID)!]]),
      // 20A target deliberately missing from the map
      slots: { distance_to_existing_power: 2, circuit_required: '20A' },
      pricingBook,
    })
    // No swap actually happened (target not found). Original assembly +
    // labour lines remain. Risk flag from the 20A band still recorded.
    expect(r.outcome.swapped_to).toEqual([])
    expect(r.tier.line_items![0].source).toBe(`assembly:${GPO_BASE_ID}`)
  })

  it('swap + extras: 8m + 20A → swap to 20A AND append cable line', () => {
    const r = mergeRecipesIntoTier(baseGpoTier(), {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: { distance_to_existing_power: 8, circuit_required: '20A' },
      pricingBook,
    })
    expect(r.outcome.swapped_to).toEqual([GPO_20A_ID])
    expect(r.outcome.added_line_items).toBe(2)
    // 4 lines: new sundries + new labour + appended labour + appended cable
    expect(r.tier.line_items).toHaveLength(4)
  })
})

describe('mergeRecipesIntoDraft: draft-level orchestration', () => {
  it('walks all three tiers; null tiers stay null', () => {
    const draft = {
      good: baseGpoTier(),
      better: null,
      best: baseGpoTier(),
      risk_flags: ['pre-existing flag'],
    }
    const r = mergeRecipesIntoDraft(draft, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: { distance_to_existing_power: 8 },
      pricingBook,
    })
    expect(r.outcome.any_changed).toBe(true)
    expect(r.outcome.good.changed).toBe(true)
    expect(r.outcome.better.changed).toBe(false)
    expect(r.outcome.best.changed).toBe(true)
    expect(r.draft.better).toBeNull()
    // Risk flags dedupe across tiers
    expect(r.draft.risk_flags).toContain('pre-existing flag')
  })

  it('empty recipe map → fast-path no-op', () => {
    const draft = { good: baseGpoTier(), better: null, best: null }
    const r = mergeRecipesIntoDraft(draft, {
      recipesByAssemblyId: new Map(),
      assembliesById: ASSEMBLIES_BY_ID,
      slots: { distance_to_existing_power: 8 },
      pricingBook,
    })
    expect(r.outcome.any_changed).toBe(false)
    expect(r.draft).toBe(draft)
  })

  it('null draft → returns safe empty result', () => {
    const r = mergeRecipesIntoDraft(null, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: {},
      pricingBook,
    })
    expect(r.outcome.any_changed).toBe(false)
    expect(r.draft).toBeDefined()
  })

  it('multi-tier risk flags dedupe (same flag from good + best → appears once)', () => {
    const draft = {
      good: baseGpoTier(),
      better: null,
      best: baseGpoTier(),
    }
    const r = mergeRecipesIntoDraft(draft, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: { distance_to_existing_power: 50 }, // hits unbounded band → 'long run'
      pricingBook,
    })
    expect(r.draft.risk_flags).toEqual(['long run'])
  })
})

describe('buildRecipeSlots: assemble slot map from intake + conversation_state', () => {
  it('lifts top-level intake fields', () => {
    const slots = buildRecipeSlots(
      { job_type: 'power_points', trade: 'electrical', suburb: 'Chandler' },
      null,
    )
    expect(slots.job_type).toBe('power_points')
    expect(slots.trade).toBe('electrical')
    expect(slots.suburb).toBe('Chandler')
  })

  it('lifts intake.scope and intake.scope.specs', () => {
    const slots = buildRecipeSlots(
      {
        scope: {
          item_count: 2,
          description: 'two GPOs',
          specs: { supplied_by: 'customer', smart: true },
        },
      },
      null,
    )
    expect(slots.item_count).toBe(2)
    expect(slots.description).toBe('two GPOs')
    expect(slots.supplied_by).toBe('customer')
    expect(slots.smart).toBe(true)
  })

  it('conversation_state.slots wins on conflict (most recent signal)', () => {
    const slots = buildRecipeSlots(
      { scope: { distance_to_existing_power: 2 } },
      { slots: { distance_to_existing_power: 8 } },
    )
    expect(slots.distance_to_existing_power).toBe(8)
  })

  it('null intake → empty slot map (no crash)', () => {
    const slots = buildRecipeSlots(null as any, null)
    expect(Object.keys(slots)).toHaveLength(0)
  })

  it('skips nested objects at top level (they go through scope/specs explicitly)', () => {
    const slots = buildRecipeSlots(
      { caller: { name: 'James' }, suburb: 'Chandler' },
      null,
    )
    expect(slots.caller).toBeUndefined() // nested object — skipped at top level
    expect(slots.suburb).toBe('Chandler')
  })
})

describe('worked example — Anant-style 8m GPO install end-to-end', () => {
  // Mirrors the worked example from the design conversation:
  // Customer wants a new GPO; nearest existing power is 8m away.
  // Expected: no $99 inspection, just an auto-quote with the 8m cable
  // run priced into the line items.
  it('Opus drafts a base GPO, recipe adds 1hr labour + 10m cable @ $6.80/lm', () => {
    const draft = {
      good: baseGpoTier(),
      better: null,
      best: null,
      risk_flags: [],
      needs_inspection: false,
    }
    const r = mergeRecipesIntoDraft(draft, {
      recipesByAssemblyId: RECIPES_BY_ID,
      assembliesById: ASSEMBLIES_BY_ID,
      slots: { distance_to_existing_power: 8 },
      pricingBook,
    })
    const good = r.draft.good!
    expect(good.line_items).toHaveLength(4)
    // Original base GPO line preserved (no swap fired)
    expect(good.line_items![0].source).toBe(`assembly:${GPO_BASE_ID}`)
    expect(good.line_items![1].source).toBe('labour')
    // Appended labour for the cable run
    expect(good.line_items![2].source).toBe('labour')
    expect(good.line_items![2].quantity).toBe(1)
    // Appended cable
    expect(good.line_items![3].source).toBe(`material:${TPS_CABLE_ID}`)
    expect(good.line_items![3].unit).toBe('lm')
    expect(good.line_items![3].unit_price_ex_gst).toBe(6.8)
    // Customer would have paid $99 + site visit fees today. Instead:
    expect(good.subtotal_ex_gst).toBe(251.32)
    expect(r.outcome.good.defaults_used).toContain('circuit_required')
  })
})
