// Phase 6 — integration tests for the route-handler → runEstimation →
// buildRecipeSlots → mergeRecipesIntoDraft wiring.
//
// runEstimation itself hits Anthropic and is integration-level. These
// tests focus on the COMPOSITE behaviour of the pure modules in the
// exact data shape the SMS route handler produces:
//
//   • sms_conversations.conversation_state (jsonb) → { slots: {...} }
//   • Passed as the 4th argument to runEstimation
//   • Forwarded into buildRecipeSlots(intake, { slots })
//   • Slots fed through applyPriceBands by mergeRecipesIntoDraft
//
// Together: when a customer's slot extractor (Phase 4) captures
// distance_to_existing_power=8 mid-conversation, the recipe fires and
// the customer's quote auto-includes the cable-run extras without a
// $99 inspection.
//
// Coverage:
//   • Slot-extractor output (conversation_state.slots) wins over a stale
//     intake.scope value for the same key
//   • Malformed conversation_state (missing slots, wrong type) → safe
//     fallback to intake.scope only
//   • null conversation_state (voice path) → recipe falls back to defaults
//   • Empty slot map → defaults_used reports both recipe slots
//   • Mixed customer answers (some captured, some defaulted) → partial
//     mode produces correct outcome

import { describe, expect, it } from 'vitest'
import {
  mergeRecipesIntoDraft,
  buildRecipeSlots,
  type AssemblyMeta,
} from './merge-recipes'
import type { PriceQuestion } from './price-bands'

// Same fixture shape used by mig 074's seeded recipe on "Replace double GPO".
const GPO_BASE_ID = 'asm-gpo-base'
const GPO_20A_ID = 'asm-gpo-20a'
const TPS_CABLE_ID = 'mat-tps-2.5'

const RECIPE: PriceQuestion[] = [
  {
    id: 'distance_to_existing_power',
    question: 'how far',
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
            unit_price_ex_gst: 5,
            source: `material:${TPS_CABLE_ID}`,
          },
        ],
      },
      { max: null, extra_labour_hr: 2, risk_flag: 'long run' },
    ],
  },
  {
    id: 'circuit_required',
    question: 'amperage',
    variant: 'select',
    default_when_unanswered: '10A',
    bands: [
      { value: '10A', label: 'standard' },
      { value: '20A', label: '20A', use_assembly_id: GPO_20A_ID },
    ],
  },
]

const ASSEMBLIES: Map<string, AssemblyMeta> = new Map([
  [GPO_BASE_ID, { id: GPO_BASE_ID, name: 'Replace double GPO', default_unit_price_ex_gst: 22, default_labour_hours: 0.3 }],
  [GPO_20A_ID, { id: GPO_20A_ID, name: 'Install 20A dedicated GPO', default_unit_price_ex_gst: 80, default_labour_hours: 2 }],
])

const RECIPES = new Map<string, readonly PriceQuestion[]>([
  [GPO_BASE_ID, RECIPE],
])

const pricingBook = { hourly_rate: 118, default_markup_pct: 36 }

function baseDraft() {
  return {
    good: {
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
      ],
      subtotal_ex_gst: 65.32,
    },
    better: null,
    best: null,
    risk_flags: [],
  }
}

describe('Phase 6: route-handler shape → end-to-end recipe fire', () => {
  it('conversation_state.slots makes the recipe fire even when intake.scope is empty', () => {
    // The slot extractor captured the customer's answer mid-conversation,
    // before the intake structurer ran. intake.scope is therefore EMPTY
    // for the recipe slot. conversation_state.slots carries the live answer.
    // Expected: recipe fires because buildRecipeSlots reads from BOTH and
    // conversation slots win.
    const intake = {
      job_type: 'power_points',
      trade: 'electrical',
      scope: { item_count: 1, description: 'new GPO in garage' },
    }
    // This is the EXACT shape the route handler now passes to runEstimation:
    //   { slots: { distance_to_existing_power: 8 } }
    const conversationState = { slots: { distance_to_existing_power: 8 } }
    const slots = buildRecipeSlots(intake, conversationState)
    expect(slots.distance_to_existing_power).toBe(8)
    expect(slots.item_count).toBe(1) // intake.scope still merged

    const r = mergeRecipesIntoDraft(baseDraft(), {
      recipesByAssemblyId: RECIPES,
      assembliesById: ASSEMBLIES,
      slots,
      pricingBook,
    })
    expect(r.outcome.any_changed).toBe(true)
    expect(r.outcome.good.added_line_items).toBe(2) // labour + cable
    const cable = r.draft.good!.line_items!.find((li) => li.unit === 'lm')
    expect(cable?.unit_price_ex_gst).toBe(6.8) // 5 × 1.36
    expect(r.draft.good!.subtotal_ex_gst).toBe(251.32)
  })

  it('conversation_state.slots OVERRIDES a stale intake.scope value', () => {
    // The customer first said "5m", structurer wrote it into intake.scope.
    // Then they corrected to "8m"; the slot extractor wrote 8 into
    // conversation_state.slots. The recipe MUST see 8, not 5 —
    // otherwise we under-quote the cable run.
    const intake = {
      job_type: 'power_points',
      scope: {
        item_count: 1,
        distance_to_existing_power: 5, // stale
      },
    }
    const conversationState = {
      slots: { distance_to_existing_power: 8 }, // live
    }
    const slots = buildRecipeSlots(intake, conversationState)
    expect(slots.distance_to_existing_power).toBe(8)

    const r = mergeRecipesIntoDraft(baseDraft(), {
      recipesByAssemblyId: RECIPES,
      assembliesById: ASSEMBLIES,
      slots,
      pricingBook,
    })
    // 8m → max:10 band → 10m cable. (5m → max:5 band → just 0.5hr labour
    // with no cable.) Verifying the 8m band fired by checking for cable.
    const cable = r.draft.good!.line_items!.find((li) => li.unit === 'lm')
    expect(cable).toBeDefined()
    expect(cable?.quantity).toBe(10)
  })

  it('circuit_required from conversation_state triggers the assembly swap', () => {
    // Customer said "20A" — captured by the slot extractor, lives in
    // conversation_state.slots, intake.scope has nothing about amperage.
    const intake = {
      job_type: 'power_points',
      scope: { item_count: 1 },
    }
    const conversationState = {
      slots: { circuit_required: '20A' },
    }
    const slots = buildRecipeSlots(intake, conversationState)
    const r = mergeRecipesIntoDraft(baseDraft(), {
      recipesByAssemblyId: RECIPES,
      assembliesById: ASSEMBLIES,
      slots,
      pricingBook,
    })
    expect(r.outcome.good.swapped_to).toEqual([GPO_20A_ID])
    expect(r.draft.good!.line_items![0].source).toBe(`assembly:${GPO_20A_ID}`)
  })

  it('null conversation_state (voice path) → recipe falls back to intake.scope + defaults', () => {
    // Voice intake doesn't have an sms_conversation row. The route handler
    // passes null for conversationState. buildRecipeSlots reads intake.scope
    // only.
    const intake = {
      job_type: 'power_points',
      scope: {
        item_count: 1,
        distance_to_existing_power: 8, // structurer wrote it
      },
    }
    const slots = buildRecipeSlots(intake, null)
    expect(slots.distance_to_existing_power).toBe(8)

    const r = mergeRecipesIntoDraft(baseDraft(), {
      recipesByAssemblyId: RECIPES,
      assembliesById: ASSEMBLIES,
      slots,
      pricingBook,
    })
    expect(r.outcome.good.added_line_items).toBe(2)
  })

  it('null conversation_state AND empty intake.scope → defaults used for every recipe slot', () => {
    const intake = { job_type: 'power_points', scope: {} }
    const slots = buildRecipeSlots(intake, null)
    const r = mergeRecipesIntoDraft(baseDraft(), {
      recipesByAssemblyId: RECIPES,
      assembliesById: ASSEMBLIES,
      slots,
      pricingBook,
    })
    // Default distance=2 → 'near' band → no extras
    // Default circuit_required='10A' → no swap
    // Net: no change, recipe ran but produced nothing.
    expect(r.outcome.any_changed).toBe(false)
    expect(r.outcome.good.defaults_used.sort()).toEqual(
      ['circuit_required', 'distance_to_existing_power'].sort(),
    )
  })
})

describe('Phase 6: defensive handling of malformed conversation_state', () => {
  // The route handler does its own shape validation before passing
  // conversationState through, but these tests pin buildRecipeSlots
  // behaviour for direct callers (and defend against drift in the
  // route handler's shape coercion).

  it('conversation_state with .slots missing → fallback to intake.scope only', () => {
    const intake = { job_type: 'power_points', scope: { item_count: 1 } }
    const slots = buildRecipeSlots(intake, {} as any)
    expect(slots.item_count).toBe(1)
    expect(slots.distance_to_existing_power).toBeUndefined()
  })

  it('conversation_state with .slots = null → fallback to intake.scope only', () => {
    const intake = { job_type: 'power_points', scope: { item_count: 1 } }
    const slots = buildRecipeSlots(intake, { slots: null } as any)
    expect(slots.item_count).toBe(1)
    expect(slots.distance_to_existing_power).toBeUndefined()
  })

  it('conversation_state with .slots = non-object → fallback gracefully', () => {
    const intake = { job_type: 'power_points', scope: { item_count: 1 } }
    // Real-world malformed shape — defensive.
    const r = buildRecipeSlots(intake, { slots: 'bogus' as any })
    expect(r.item_count).toBe(1)
  })
})

describe('Phase 6: partial slot capture — recipe uses live + defaults in mix', () => {
  it('customer answered distance but not amperage → recipe partial-fires', () => {
    const intake = { job_type: 'power_points', scope: { item_count: 1 } }
    const conversationState = {
      slots: { distance_to_existing_power: 8 },
      // circuit_required not yet captured by the slot extractor
    }
    const slots = buildRecipeSlots(intake, conversationState)
    const r = mergeRecipesIntoDraft(baseDraft(), {
      recipesByAssemblyId: RECIPES,
      assembliesById: ASSEMBLIES,
      slots,
      pricingBook,
    })
    // Recipe fired: cable + labour extras for 8m.
    expect(r.outcome.good.added_line_items).toBe(2)
    // No swap (default 10A).
    expect(r.outcome.good.swapped_to).toEqual([])
    // defaults_used reports the one slot that fell back.
    expect(r.outcome.good.defaults_used).toEqual(['circuit_required'])
  })

  it('customer answered amperage but not distance → only swap fires', () => {
    const intake = { job_type: 'power_points', scope: { item_count: 1 } }
    const conversationState = { slots: { circuit_required: '20A' } }
    const slots = buildRecipeSlots(intake, conversationState)
    const r = mergeRecipesIntoDraft(baseDraft(), {
      recipesByAssemblyId: RECIPES,
      assembliesById: ASSEMBLIES,
      slots,
      pricingBook,
    })
    // Swap fired.
    expect(r.outcome.good.swapped_to).toEqual([GPO_20A_ID])
    // Default distance=2 → 'near' band → 0 extras.
    expect(r.outcome.good.added_line_items).toBe(0)
    expect(r.outcome.good.defaults_used).toEqual(['distance_to_existing_power'])
  })
})
