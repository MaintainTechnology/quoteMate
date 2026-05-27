// Phase 5 — tests pinning the power_points trigger surface after the
// price-bands recipe engine took over the metric-driven cases.
//
// The five removed triggers are now handled by the Replace-double-GPO
// recipe (mig 074, lib/estimate/merge-recipes.ts → applyPriceBands):
//   - 'dedicated 20A+ circuit'                          → recipe swap
//   - 'new sub-circuit from switchboard requiring a spare way'
//   - 'brand-new run from the switchboard'              → recipe extras
//   - 'no power within 5 metres of the GPO location'    → recipe band
//   - 'three-phase'                                     → recipe swap
//
// What stays in inspectionTriggers is what GENUINELY can't be priced
// from a customer's SMS answer alone:
//   - wet-area zoning (regulatory clearance — needs eyes on)
//   - pre-1970 / old wiring / ceramic fuse (asbestos + safety)
//
// Tests below verify both halves of the cleanup are intact.

import { describe, expect, it } from 'vitest'
import {
  ASSUMPTION_RULES,
  UNIVERSAL_INSPECTION_TRIGGERS,
  UNIVERSAL_MUST_ASK,
  rulesAsText,
} from './assumptions'

describe('Phase 5: power_points inspectionTriggers cleanup', () => {
  const triggers = ASSUMPTION_RULES.power_points.inspectionTriggers

  it.each([
    ['dedicated 20A+ circuit'],
    ['new sub-circuit from switchboard requiring a spare way'],
    ['brand-new run from the switchboard'],
    ['no power within 5 metres of the GPO location'],
    ['three-phase'],
  ])('removed: %s is no longer in power_points triggers', (phrase) => {
    expect(triggers).not.toContain(phrase)
  })

  it.each([
    ['within 600mm of a basin, sink, shower or bath'],
    ['inside a wet-area zone'],
    ['pre-1970 house'],
    ['old wiring'],
    ['ceramic fuse'],
  ])('retained: %s remains a power_points trigger', (phrase) => {
    expect(triggers).toContain(phrase)
  })

  it('total trigger count for power_points is exactly 5 after cleanup', () => {
    // Defends against accidental re-introduction of any removed triggers
    // (an inattentive merge of an old branch). Adjust only when a NEW
    // genuine trigger lands — and update the corresponding recipe if so.
    expect(triggers).toHaveLength(5)
  })

  it('rulesAsText(power_points) DOES NOT mention the five removed phrases', () => {
    const t = rulesAsText('power_points')
    expect(t).not.toContain('dedicated 20A+')
    expect(t).not.toContain('no power within 5 metres')
    expect(t).not.toContain('brand-new run from the switchboard')
    expect(t).not.toContain('new sub-circuit from switchboard')
    expect(t).not.toMatch(/^\s*-\s*three-phase\s*$/m)
  })

  it('rulesAsText(power_points) STILL mentions the retained safety/zoning triggers', () => {
    const t = rulesAsText('power_points')
    expect(t).toContain('within 600mm of a basin')
    expect(t).toContain('inside a wet-area zone')
    expect(t).toContain('pre-1970 house')
  })
})

describe('Phase 5: regression guard — other job_types unaffected', () => {
  // Phase 5 ONLY touched power_points. Other inspectionTriggers arrays
  // must remain at their pre-Phase-5 lengths. If a future cleanup
  // intentionally trims another job_type, update that job's expected
  // count below.
  it.each([
    ['downlights', 7],
    ['ceiling_fans', 3],
    ['smoke_alarms', 6],
    ['outdoor_lighting', 6],
    ['blocked_drain', 6],
    ['hot_water', 6],
    ['tap_repair', 5],
    ['tap_replace', 3],
    ['toilet_repair', 4],
    ['toilet_replace', 4],
  ] as const)('%s inspectionTriggers length === %i', (jobType, expectedLen) => {
    expect(ASSUMPTION_RULES[jobType].inspectionTriggers).toHaveLength(expectedLen)
  })
})

describe('Phase 5: universal layers untouched by power_points cleanup', () => {
  // Layer 1 (UNIVERSAL_INSPECTION_TRIGGERS) still carries the
  // electrical-wide safety triggers — those remain regardless of
  // job_type and are NOT recipe-able.
  it('switchboard upgrade still triggers universally (any electrical job)', () => {
    expect(UNIVERSAL_INSPECTION_TRIGGERS).toContain('switchboard upgrade')
  })

  it('burning smell / sparks still trigger universally (life safety)', () => {
    expect(UNIVERSAL_INSPECTION_TRIGGERS).toContain('burning smell')
    expect(UNIVERSAL_INSPECTION_TRIGGERS).toContain('sparking')
  })

  it('rewire still triggers universally', () => {
    expect(UNIVERSAL_INSPECTION_TRIGGERS).toContain('rewire')
  })

  it('UNIVERSAL_MUST_ASK includes the conversation-wide questions', () => {
    // Sanity check — these have been stable for many migrations and
    // tests touching adjacent code shouldn't perturb them.
    expect(UNIVERSAL_MUST_ASK.length).toBeGreaterThan(0)
  })
})

describe('Phase 5: power_points safeDefaults unchanged', () => {
  // Defaults were left intact — only inspectionTriggers were trimmed.
  // This catches accidental over-cleanup that drops safe defaults.
  it('preserves the "use existing nearby power" default', () => {
    const defaults = ASSUMPTION_RULES.power_points.safeDefaults
    expect(defaults['scope.is_new_install']).toMatch(/replacement/)
  })

  it('preserves the indoor default', () => {
    const defaults = ASSUMPTION_RULES.power_points.safeDefaults
    expect(defaults['scope.indoor_outdoor']).toBe('indoor')
  })

  it('preserves the pre-1970 false default', () => {
    const defaults = ASSUMPTION_RULES.power_points.safeDefaults
    expect(defaults['property.pre_1970']).toBe('false')
  })
})

describe('Phase 5: power_points mustAsk unchanged', () => {
  // The mustAsk array drives clarifying questions in the dialog. Phase 5
  // ONLY trims inspectionTriggers — the must-ask flow stays identical so
  // the dialog still gathers the inputs the recipe engine needs.
  it('still asks about count + room + replace_or_new + wet-area clearance', () => {
    const mustAsk = ASSUMPTION_RULES.power_points.mustAsk
    expect(mustAsk.join(' / ')).toMatch(/how many GPOs/)
    expect(mustAsk.join(' / ')).toMatch(/which room/)
    expect(mustAsk.join(' / ')).toMatch(/600mm/)
  })
})
