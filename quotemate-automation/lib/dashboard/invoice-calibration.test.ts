// Tests for the invoice-calibration pure module (A5).
// No DB, no fetch, no LLM — synthetic invoices + assemblies in, suggestion out.

import { describe, expect, it } from 'vitest'
import {
  matchRecipe,
  computePrediction,
  suggestHourlyRateAdjustment,
  buildCalibrationReport,
  TRUST_GATES,
  type AssemblyForMatch,
  type InvoiceExtraction,
  type TenantPricingContext,
  type PredictionDiff,
} from './invoice-calibration'

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const REPLACE_DOWNLIGHT: AssemblyForMatch = {
  id: 'a1',
  name: 'Replace LED downlight',
  category: 'downlight',
  trade: 'electrical',
  default_labour_hours: 0.4,
  default_unit_price_ex_gst: 28,
}

const INSTALL_DOWNLIGHT_NEW: AssemblyForMatch = {
  id: 'a2',
  name: 'Install LED downlight (new install, single-storey)',
  category: 'downlight',
  trade: 'electrical',
  default_labour_hours: 1.75,
  default_unit_price_ex_gst: 35,
}

const INSTALL_GPO: AssemblyForMatch = {
  id: 'a3',
  name: 'Install GPO',
  category: 'gpo',
  trade: 'electrical',
  default_labour_hours: 0.6,
  default_unit_price_ex_gst: 18,
}

const INSTALL_HWS: AssemblyForMatch = {
  id: 'a4',
  name: 'Install electric HWS',
  category: 'hot_water',
  trade: 'plumbing',
  default_labour_hours: 3,
  default_unit_price_ex_gst: 45,
}

const ALL_ASSEMBLIES = [REPLACE_DOWNLIGHT, INSTALL_DOWNLIGHT_NEW, INSTALL_GPO, INSTALL_HWS]

const ELECTRICAL_CONTEXT: TenantPricingContext = {
  hourly_rate: 120,
  default_markup_pct: 15,
  gst_registered: true,
  trade: 'electrical',
}

// ──────────────────────────────────────────────────────────────────────
// matchRecipe
// ──────────────────────────────────────────────────────────────────────

describe('matchRecipe', () => {
  it('matches by job_type_guess category + keyword overlap with high confidence', () => {
    const r = matchRecipe(
      {
        scope_description: 'Replaced 4 LED downlights in the kitchen',
        job_type_guess: 'downlights',
        total_inc_gst: 450,
      },
      ALL_ASSEMBLIES,
      'electrical',
    )
    expect(r).not.toBeNull()
    expect(r!.assembly_id).toBe('a1') // Replace LED downlight wins on specificity
    expect(r!.confidence).toBe('high')
    expect(r!.match_reason).toContain('category=downlight')
  })

  it('matches by keyword alone (no job_type_guess) with lower confidence', () => {
    const r = matchRecipe(
      {
        scope_description: 'Installed a GPO in the laundry',
        total_inc_gst: 220,
      },
      ALL_ASSEMBLIES,
      'electrical',
    )
    expect(r).not.toBeNull()
    expect(r!.assembly_id).toBe('a3')
    // No category hint, only keyword "gpo" matched → low/medium
    expect(['low', 'medium']).toContain(r!.confidence)
  })

  it('returns null when no candidate matches', () => {
    const r = matchRecipe(
      {
        scope_description: 'Some completely unrelated work that does not match anything',
        total_inc_gst: 999,
      },
      ALL_ASSEMBLIES,
      'electrical',
    )
    expect(r).toBeNull()
  })

  it('filters by trade — plumbing-trade assemblies are invisible for electrical jobs', () => {
    const r = matchRecipe(
      {
        scope_description: 'Install hot water unit',
        job_type_guess: 'hot_water',
        total_inc_gst: 2000,
      },
      ALL_ASSEMBLIES,
      'electrical',
    )
    expect(r).toBeNull() // HWS is plumbing; electrical context can't see it
  })

  it('returns null on empty scope text', () => {
    const r = matchRecipe(
      { scope_description: '', total_inc_gst: 100 },
      ALL_ASSEMBLIES,
      'electrical',
    )
    expect(r).toBeNull()
  })

  it('picks the shorter assembly name when both have category match + same keyword score', () => {
    // Scope mentions "downlight" only — both Replace LED downlight and Install LED
    // downlight (new install...) have category=downlight. Replace wins on shorter name.
    const r = matchRecipe(
      {
        scope_description: 'downlight work',
        job_type_guess: 'downlights',
        total_inc_gst: 100,
      },
      [REPLACE_DOWNLIGHT, INSTALL_DOWNLIGHT_NEW],
      'electrical',
    )
    expect(r!.assembly_id).toBe('a1')
  })
})

// ──────────────────────────────────────────────────────────────────────
// computePrediction
// ──────────────────────────────────────────────────────────────────────

describe('computePrediction', () => {
  it('applies markup to sundries but not to labour', () => {
    // qty=1, markup=15%, hourly=$120, GST registered
    // sundries: $28 × 1.15 = $32.20
    // labour: 0.4hr × $120 = $48
    // subtotal: $80.20 → inc GST: $88.22
    const match = {
      assembly_id: 'a1',
      assembly_name: 'Replace LED downlight',
      default_labour_hours: 0.4,
      default_unit_price_ex_gst: 28,
      confidence: 'high' as const,
      match_reason: '',
    }
    const diff = computePrediction(match, 1, ELECTRICAL_CONTEXT, 88.22)
    expect(diff.recipe_total_ex_gst).toBe(80.2)
    expect(diff.recipe_total_inc_gst).toBe(88.22)
    expect(diff.invoice_total_inc_gst).toBe(88.22)
    expect(diff.diff_inc_gst).toBe(0)
    expect(diff.diff_pct).toBe(0)
  })

  it('scales by quantity', () => {
    const match = {
      assembly_id: 'a1',
      assembly_name: 'Replace LED downlight',
      default_labour_hours: 0.4,
      default_unit_price_ex_gst: 28,
      confidence: 'high' as const,
      match_reason: '',
    }
    // qty=6: sundries $28×6×1.15 = $193.20, labour 0.4×6×$120 = $288, total ex $481.20, inc $529.32
    const diff = computePrediction(match, 6, ELECTRICAL_CONTEXT, 529.32)
    expect(diff.recipe_total_ex_gst).toBeCloseTo(481.2, 1)
    expect(diff.recipe_total_inc_gst).toBeCloseTo(529.32, 1)
    expect(diff.diff_pct).toBeCloseTo(0, 1)
  })

  it('skips GST when tenant is not registered', () => {
    const match = {
      assembly_id: 'a1',
      assembly_name: 'Replace LED downlight',
      default_labour_hours: 0.4,
      default_unit_price_ex_gst: 28,
      confidence: 'high' as const,
      match_reason: '',
    }
    const noGstContext = { ...ELECTRICAL_CONTEXT, gst_registered: false }
    const diff = computePrediction(match, 1, noGstContext, 80.2)
    expect(diff.recipe_total_inc_gst).toBe(80.2)
    expect(diff.recipe_total_ex_gst).toBe(80.2)
  })

  it('reports positive diff_pct when invoice > recipe', () => {
    const match = {
      assembly_id: 'a1',
      assembly_name: 'Replace LED downlight',
      default_labour_hours: 0.4,
      default_unit_price_ex_gst: 28,
      confidence: 'high' as const,
      match_reason: '',
    }
    // Recipe predicts $88.22, invoice was $100 → +13.4%
    const diff = computePrediction(match, 1, ELECTRICAL_CONTEXT, 100)
    expect(diff.diff_inc_gst).toBeGreaterThan(0)
    expect(diff.diff_pct).toBeGreaterThan(0)
  })

  it('reports negative diff_pct when invoice < recipe', () => {
    const match = {
      assembly_id: 'a1',
      assembly_name: 'Replace LED downlight',
      default_labour_hours: 0.4,
      default_unit_price_ex_gst: 28,
      confidence: 'high' as const,
      match_reason: '',
    }
    const diff = computePrediction(match, 1, ELECTRICAL_CONTEXT, 70)
    expect(diff.diff_pct).toBeLessThan(0)
  })

  it('clamps quantity ≤ 0 to 1', () => {
    const match = {
      assembly_id: 'a1',
      assembly_name: 'Replace LED downlight',
      default_labour_hours: 0.4,
      default_unit_price_ex_gst: 28,
      confidence: 'high' as const,
      match_reason: '',
    }
    const diff = computePrediction(match, 0, ELECTRICAL_CONTEXT, 88.22)
    expect(diff.recipe_total_inc_gst).toBeCloseTo(88.22, 1) // qty effectively 1
  })
})

// ──────────────────────────────────────────────────────────────────────
// suggestHourlyRateAdjustment + trust gates
// ──────────────────────────────────────────────────────────────────────

function mkDiff(pct: number): PredictionDiff {
  // We only care about diff_pct for these tests.
  return {
    recipe_total_ex_gst: 100,
    recipe_total_inc_gst: 110,
    invoice_total_inc_gst: 110 * (1 + pct / 100),
    diff_inc_gst: 110 * (pct / 100),
    diff_pct: pct,
  }
}

describe('suggestHourlyRateAdjustment — trust gates', () => {
  it('rejects when fewer than MIN_INVOICES_FOR_SUGGESTION matched', () => {
    const diffs = [mkDiff(5), mkDiff(7)]
    const s = suggestHourlyRateAdjustment(diffs, ELECTRICAL_CONTEXT)!
    expect(s.trust).toBe('reject')
    expect(s.reject_reason).toContain(String(TRUST_GATES.MIN_INVOICES_FOR_SUGGESTION))
    expect(s.invoices_used).toBe(2)
  })

  it('high trust when 5+ invoices with low variance + modest delta', () => {
    const diffs = [mkDiff(5), mkDiff(6), mkDiff(7), mkDiff(5), mkDiff(6)]
    const s = suggestHourlyRateAdjustment(diffs, ELECTRICAL_CONTEXT)!
    expect(s.trust).toBe('high')
    expect(s.delta).toBeGreaterThan(0) // upward suggestion
    expect(s.suggested_value).toBeGreaterThan(ELECTRICAL_CONTEXT.hourly_rate)
  })

  it('medium trust when delta exceeds HIGH cap but stays under HARD cap', () => {
    const diffs = [mkDiff(15), mkDiff(16), mkDiff(14), mkDiff(15), mkDiff(15)]
    const s = suggestHourlyRateAdjustment(diffs, ELECTRICAL_CONTEXT)!
    expect(s.trust).toBe('medium')
  })

  it('rejects when single-step delta exceeds the hard cap', () => {
    const diffs = [mkDiff(35), mkDiff(34), mkDiff(36), mkDiff(35), mkDiff(35)]
    const s = suggestHourlyRateAdjustment(diffs, ELECTRICAL_CONTEXT)!
    expect(s.trust).toBe('reject')
    expect(s.reject_reason).toMatch(/hard cap/i)
  })

  it('rejects when invoice variance range exceeds the hard cap', () => {
    const diffs = [mkDiff(-10), mkDiff(5), mkDiff(20), mkDiff(0), mkDiff(30)]
    const s = suggestHourlyRateAdjustment(diffs, ELECTRICAL_CONTEXT)!
    expect(s.trust).toBe('reject')
    expect(s.reject_reason).toMatch(/variance/i)
  })

  it('suggests downward when invoices systematically run below recipe', () => {
    const diffs = [mkDiff(-5), mkDiff(-6), mkDiff(-5), mkDiff(-7), mkDiff(-5)]
    const s = suggestHourlyRateAdjustment(diffs, ELECTRICAL_CONTEXT)!
    expect(s.delta).toBeLessThan(0)
    expect(s.suggested_value).toBeLessThan(ELECTRICAL_CONTEXT.hourly_rate)
    expect(s.trust).toBe('high')
  })

  it('returns null with no diffs', () => {
    expect(suggestHourlyRateAdjustment([], ELECTRICAL_CONTEXT)).toBeNull()
  })

  it('exposes summary stats so the UI can show "range +X% to +Y%"', () => {
    const diffs = [mkDiff(5), mkDiff(6), mkDiff(8), mkDiff(5), mkDiff(7)]
    const s = suggestHourlyRateAdjustment(diffs, ELECTRICAL_CONTEXT)!
    expect(s.diff_pct_min).toBe(5)
    expect(s.diff_pct_max).toBe(8)
    expect(s.diff_pct_median).toBe(6)
    expect(s.invoices_used).toBe(5)
  })
})

// ──────────────────────────────────────────────────────────────────────
// buildCalibrationReport — end-to-end pure-glue
// ──────────────────────────────────────────────────────────────────────

describe('buildCalibrationReport', () => {
  function mkInvoice(scope: string, total: number, jobType?: string, qty?: number): InvoiceExtraction {
    return {
      scope_description: scope,
      total_inc_gst: total,
      job_type_guess: jobType ?? null,
      quantity: qty ?? null,
    }
  }

  it('counts matched + skipped invoices correctly', () => {
    const extractions = [
      mkInvoice('Replaced 4 LED downlights', 350, 'downlights', 4),
      mkInvoice('Installed GPO in kitchen', 220, 'power_points', 1),
      mkInvoice('', 100, 'downlights', 1), // skipped — no scope
      mkInvoice('Unrelated mystery work zzz', 999), // skipped — no match
    ]
    const r = buildCalibrationReport(extractions, ALL_ASSEMBLIES, ELECTRICAL_CONTEXT)
    expect(r.invoices_total).toBe(4)
    expect(r.invoices_matched + r.invoices_skipped).toBe(4)
    expect(r.skip_breakdown.no_scope_text).toBe(1)
    expect(r.skip_breakdown.no_recipe_match).toBe(1)
  })

  it('produces a suggestion when enough matched invoices exist', () => {
    const extractions = [
      mkInvoice('Replaced 4 LED downlights', 400, 'downlights', 4),
      mkInvoice('Replaced 6 LED downlights', 600, 'downlights', 6),
      mkInvoice('Replaced 2 LED downlights', 200, 'downlights', 2),
      mkInvoice('Replaced 5 LED downlights', 500, 'downlights', 5),
      mkInvoice('Replaced 3 LED downlights', 300, 'downlights', 3),
    ]
    const r = buildCalibrationReport(extractions, ALL_ASSEMBLIES, ELECTRICAL_CONTEXT)
    expect(r.invoices_matched).toBeGreaterThanOrEqual(5)
    expect(r.suggestions.length).toBeGreaterThanOrEqual(1)
  })

  it('no suggestion when too few matched invoices', () => {
    const extractions = [
      mkInvoice('Replaced 4 LED downlights', 400, 'downlights', 4),
      mkInvoice('Replaced 6 LED downlights', 600, 'downlights', 6),
    ]
    const r = buildCalibrationReport(extractions, ALL_ASSEMBLIES, ELECTRICAL_CONTEXT)
    // Either no suggestions OR the suggestion has trust='reject'.
    if (r.suggestions.length > 0) {
      expect(r.suggestions[0].trust).toBe('reject')
    }
  })

  it('skips low-confidence matches from feeding the suggestion', () => {
    // Scope has no keyword overlap and no job_type_guess → low confidence
    // (or no match). Both outcomes should result in zero matched invoices.
    const extractions = Array.from({ length: 10 }).map(() =>
      mkInvoice('ambient work performed', 300),
    )
    const r = buildCalibrationReport(extractions, ALL_ASSEMBLIES, ELECTRICAL_CONTEXT)
    expect(r.invoices_matched).toBe(0)
    expect(r.suggestions.length).toBe(0)
  })
})
