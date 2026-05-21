// Phase 0 exit gate (admin bulk loader — docs/admin-bulk-loader-spec.md §12,
// §13): the estimator system prompt produced by the data-driven router must
// be byte-identical to the hand-written electrical/plumbing prompt modules.
// If this fails, the prompt-router refactor changed what Opus sees — Phase 1
// must not start until it is green.
//
// It checks renderEstimatorSystemPrompt() — the real function lib/estimate/
// prompt.ts uses — on BOTH paths: dbTemplate present (the trade_prompts row)
// and dbTemplate absent (the bundled-template fallback).

import { describe, it, expect } from 'vitest'
import { renderEstimatorSystemPrompt } from './prompt'
import { type EstimatorPricingBook } from './prompt-context'
import { ELECTRICAL_ESTIMATOR_TEMPLATE } from './prompt-templates/electrical-estimator'
import { PLUMBING_ESTIMATOR_TEMPLATE } from './prompt-templates/plumbing-estimator'
import { electricalSystemPrompt } from './electrical-prompt'
import { plumbingSystemPrompt } from './plumbing-prompt'

// A spread of pricing books: the electrical/plumbing pilots, a 15%-markup
// GST-unregistered book with NULL licences + NULL min_labour_hours, and a
// high-rate book — so every {{placeholder}} and the {{markup}} helper are
// exercised against real value variety.
const BOOKS: EstimatorPricingBook[] = [
  {
    hourly_rate: 110,
    call_out_minimum: 150,
    apprentice_rate: 65,
    default_markup_pct: 28,
    risk_buffer_pct: 15,
    min_labour_hours: 2,
    gst_registered: true,
    licence_type: 'NSW electrical contractor licence',
    licence_state: 'NSW',
  },
  {
    hourly_rate: 120,
    call_out_minimum: 110,
    apprentice_rate: 70,
    default_markup_pct: 20,
    risk_buffer_pct: 15,
    min_labour_hours: 1.5,
    gst_registered: true,
    licence_type: 'QBCC',
    licence_state: 'QLD',
  },
  {
    hourly_rate: 95,
    call_out_minimum: 99,
    apprentice_rate: 55,
    default_markup_pct: 15,
    risk_buffer_pct: 10,
    min_labour_hours: null,
    gst_registered: false,
    licence_type: null,
    licence_state: null,
  },
  {
    hourly_rate: 135,
    call_out_minimum: 180,
    apprentice_rate: 75,
    default_markup_pct: 35,
    risk_buffer_pct: 20,
    min_labour_hours: 3,
    gst_registered: true,
    licence_type: 'VIC REC',
    licence_state: 'VIC',
  },
]

describe('estimator prompt parity — electrical', () => {
  BOOKS.forEach((book, i) => {
    it(`book #${i}: bundled-template fallback === electricalSystemPrompt()`, () => {
      // dbTemplate omitted → renderEstimatorSystemPrompt uses the bundled
      // template (the DB-unavailable path).
      expect(renderEstimatorSystemPrompt('electrical', book)).toBe(
        electricalSystemPrompt(book),
      )
    })

    it(`book #${i}: trade_prompts-template path === electricalSystemPrompt()`, () => {
      // dbTemplate supplied → simulates the trade_prompts row being read.
      expect(
        renderEstimatorSystemPrompt(
          'electrical',
          book,
          ELECTRICAL_ESTIMATOR_TEMPLATE,
        ),
      ).toBe(electricalSystemPrompt(book))
    })
  })
})

describe('estimator prompt parity — plumbing', () => {
  BOOKS.forEach((book, i) => {
    it(`book #${i}: bundled-template fallback === plumbingSystemPrompt()`, () => {
      expect(renderEstimatorSystemPrompt('plumbing', book)).toBe(
        plumbingSystemPrompt(book),
      )
    })

    it(`book #${i}: trade_prompts-template path === plumbingSystemPrompt()`, () => {
      expect(
        renderEstimatorSystemPrompt('plumbing', book, PLUMBING_ESTIMATOR_TEMPLATE),
      ).toBe(plumbingSystemPrompt(book))
    })
  })
})
