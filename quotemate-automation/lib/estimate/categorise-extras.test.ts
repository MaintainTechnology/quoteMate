// Migration 029 coverage — the 10 catalogue extras (migration 021) that
// the validator's name-regex previously could not categorise now:
//   1. tag correctly from their NAME (line-side regex), AND
//   2. ground via an EXPLICIT row category even when the name is opaque
//      (the additive column), WITHOUT becoming a blanket price bypass.
//
// The collision guards are the real safety: a too-broad keyword would be
// WORSE than the old "general" behaviour because it could let a genuinely
// wrong-category price through. Each new tag is asserted NOT to swallow an
// adjacent existing category.

import { describe, expect, it } from 'vitest'
import {
  buildCandidatePrices,
  categorise,
  validateQuoteGrounding,
  type Category,
} from './validate'
import { applyMinLabourFloor } from './min-labour'

const pricingBook = {
  hourly_rate: 110,
  apprentice_rate: 60,
  call_out_minimum: 150,
  default_markup_pct: 28,
  min_labour_hours: 2,
}

describe('categorise() — migration-021 extras now tag from the name', () => {
  // [assembly name as seeded, a natural line phrasing Opus would write,
  //  the category they must share]
  const cases: Array<[string, string, Category]> = [
    ['Diagnostic call-out (fault finding)', 'Fault finding and diagnostic on the power circuit', 'fault_find'],
    ['Install LED strip lighting', 'Supply and install LED strip lighting under the cabinets', 'strip_light'],
    ['Install motion sensor flood light', 'Mount and wire motion sensor flood light to the eave', 'outdoor_light'],
    ['Install security camera (single)', 'Mount one security camera and run the cable', 'security_camera'],
    ['Install wired doorbell or intercom', 'Wire the customer-supplied doorbell at the front door', 'doorbell_intercom'],
    ['Install dishwasher', 'Connect the new dishwasher to water and waste', 'dishwasher'],
    ['Install rainwater tank', 'Connect the rainwater tank to the downpipe', 'rainwater_tank'],
    ['Install whole-house water filter', 'Cut into the mains and install whole-house water filter', 'water_filter'],
    ['Leak detection', 'Acoustic leak detection on the concealed pipe', 'leak_detection'],
    ['Replace shower head', 'Remove and replace the shower head on the existing arm', 'shower'],
  ]

  for (const [name, line, cat] of cases) {
    it(`"${name}" and its line phrasing both → ${cat}`, () => {
      expect(categorise(name).has(cat)).toBe(true)
      expect(categorise(line).has(cat)).toBe(true)
      // ...and they share it (the actual grounding condition).
      const shared = [...categorise(name)].some((c) => categorise(line).has(c))
      expect(shared).toBe(true)
    })
  }
})

describe('categorise() — collision guards (a new tag must not swallow an adjacent category)', () => {
  it('plumbing CCTV drain camera is cctv, NOT electrical security_camera', () => {
    const c = categorise('CCTV drain camera inspection of blocked line')
    expect(c.has('cctv')).toBe(true)
    expect(c.has('security_camera')).toBe(false)
  })

  it('a gas leak stays gas, never leak_detection', () => {
    const c = categorise('Locate and repair gas leak at the bayonet')
    expect(c.has('gas')).toBe(true)
    expect(c.has('leak_detection')).toBe(false)
  })

  it('hot water storage tank is hot_water, NOT rainwater_tank', () => {
    const c = categorise('Replace 250L electric hot water storage tank')
    expect(c.has('hot_water')).toBe(true)
    expect(c.has('rainwater_tank')).toBe(false)
  })

  it('a mixer tap is tap, NOT shower', () => {
    const c = categorise('Replace leaking mixer tap in the kitchen')
    expect(c.has('tap')).toBe(true)
    expect(c.has('shower')).toBe(false)
  })

  it('LED downlights stay downlight, NOT strip_light', () => {
    const c = categorise('Install 6 LED downlights in the kitchen')
    expect(c.has('downlight')).toBe(true)
    expect(c.has('strip_light')).toBe(false)
  })

  it('a plain GPO is unaffected by the new tags', () => {
    const c = categorise('Replace double GPO power point')
    expect(c.has('gpo')).toBe(true)
    expect([...c].some((x) =>
      ['fault_find', 'strip_light', 'security_camera', 'doorbell_intercom',
       'dishwasher', 'rainwater_tank', 'water_filter', 'leak_detection', 'shower'].includes(x))
    ).toBe(false)
  })
})

// ── Explicit-category column (additive) end-to-end ───────────────────
// A draft GOOD tier: one 'each' line priced at the assembly's 28% markup
// ($80 → $102.40) plus a compliant 2 hr labour line.
function draftWithLine(description: string, unitPrice: number) {
  return {
    needs_inspection: false,
    good: {
      label: 'Standard',
      subtotal_ex_gst: unitPrice + 220,
      line_items: [
        { description, unit: 'each', quantity: 1, unit_price_ex_gst: unitPrice, total_ex_gst: unitPrice },
        { description: 'Labour', unit: 'hr', quantity: 2, unit_price_ex_gst: 110, total_ex_gst: 220 },
      ],
    },
    better: null,
    best: null,
  }
}

describe('migration 029 — explicit row category grounds an opaque-named assembly', () => {
  // A row whose NAME the regex cannot tag (categorise → 'general' only),
  // priced at $80 ex-GST. The customer-facing line, however, is plainly
  // "whole-house water filter" → categorise → water_filter.
  const opaque = { name: 'Acme package AX-12', price: 80 }

  it('WITHOUT a category it dumps to inspection (proves the gap is real)', () => {
    const candidates = buildCandidatePrices([], [opaque], pricingBook)
    const res = validateQuoteGrounding(
      draftWithLine('Install whole-house water filter', 102.4),
      pricingBook,
      candidates,
    )
    expect(res.valid).toBe(false)
  })

  it('WITH category=water_filter it grounds (the migration-029 fix)', () => {
    const candidates = buildCandidatePrices(
      [],
      [{ ...opaque, category: 'water_filter' }],
      pricingBook,
    )
    const res = validateQuoteGrounding(
      draftWithLine('Install whole-house water filter', 102.4),
      pricingBook,
      candidates,
    )
    expect(res.valid).toBe(true)
  })

  it('the explicit category is NOT a blanket bypass — a wrong-category line still fails', () => {
    const candidates = buildCandidatePrices(
      [],
      [{ ...opaque, category: 'water_filter' }],
      pricingBook,
    )
    // Same $102.40 price, but the line is downlights — must NOT ground off
    // a water_filter-tagged row just because the dollar figure matches.
    const res = validateQuoteGrounding(
      draftWithLine('Install 6 LED downlights', 102.4),
      pricingBook,
      candidates,
    )
    expect(res.valid).toBe(false)
  })

  it('an invalid category string is ignored (falls back to name regex)', () => {
    const candidates = buildCandidatePrices(
      [],
      [{ ...opaque, category: 'not_a_real_category' }],
      pricingBook,
    )
    const res = validateQuoteGrounding(
      draftWithLine('Install whole-house water filter', 102.4),
      pricingBook,
      candidates,
    )
    expect(res.valid).toBe(false) // unchanged from the no-category case
  })
})

// The migration-032 promise: once the dialog has gathered the mandated
// questions, a fully-priced plumbing extra must produce a GROUNDED quote
// — i.e. it is NOT forced to the $99 inspection just because it is an
// "extra". These pin that for both category paths.
describe('plumbing pilot (mig 032) — a fully-priced extra grounds, no forced inspection', () => {
  it('Install rainwater tank ($80, explicit category) grounds', () => {
    const candidates = buildCandidatePrices(
      [],
      [{ name: 'Install rainwater tank', price: 80, category: 'rainwater_tank' }],
      pricingBook,
    )
    const res = validateQuoteGrounding(
      draftWithLine('Install rainwater tank', 102.4), // 80 × 1.28
      pricingBook,
      candidates,
    )
    expect(res.valid).toBe(true)
  })

  it('Gas appliance connection ($30, name-regex category only) grounds', () => {
    const candidates = buildCandidatePrices(
      [],
      [{ name: 'Gas appliance connection', price: 30 }], // no explicit cat
      pricingBook,
    )
    const res = validateQuoteGrounding(
      draftWithLine('Gas appliance connection to existing bayonet', 38.4), // 30 × 1.28
      pricingBook,
      candidates,
    )
    expect(res.valid).toBe(true)
  })
})

// Same promise for the electrical follow-up (migration 033). Both rely on
// the name-regex category path (no explicit category column needed).
describe('electrical follow-up (mig 033) — a fully-priced extra grounds, no forced inspection', () => {
  it('Install EV charger ($120) grounds', () => {
    const candidates = buildCandidatePrices(
      [],
      [{ name: 'Install EV charger', price: 120 }],
      pricingBook,
    )
    const res = validateQuoteGrounding(
      draftWithLine('Install EV charger on dedicated circuit', 153.6), // 120 × 1.28
      pricingBook,
      candidates,
    )
    expect(res.valid).toBe(true)
  })

  it('Hardwire oven ($35) grounds', () => {
    const candidates = buildCandidatePrices(
      [],
      [{ name: 'Hardwire oven', price: 35 }],
      pricingBook,
    )
    const res = validateQuoteGrounding(
      draftWithLine('Hardwire oven on existing circuit', 44.8), // 35 × 1.28
      pricingBook,
      candidates,
    )
    expect(res.valid).toBe(true)
  })
})

// The QM-Peppers screenshot bug, end to end: "Replace 2 existing double
// GPOs in the bedroom" — priced ($22/0.3h) but only 0.6h labour, so it
// fell under the min-labour floor and (sometimes) the GPO line missed the
// semantic check (core row had category=NULL). Migration 036 gives the
// row an explicit 'gpo' category; min-labour.ts tops the tier to the
// floor. Together: this auto-quotes instead of dumping to $99.
describe('mig 036 + min-labour floor — the 2-GPO screenshot scenario auto-quotes', () => {
  // 2 double GPOs @ 22×1.28 = 28.16; only 0.6h labour (2×0.3h).
  const twoGpoDraft = () => ({
    needs_inspection: false,
    good: {
      label: 'Standard',
      subtotal_ex_gst: 56.32 + 66,
      line_items: [
        { description: 'Replace 2 existing double GPOs in the bedroom', unit: 'each', quantity: 2, unit_price_ex_gst: 28.16, total_ex_gst: 56.32 },
        { description: 'Labour', unit: 'hr', quantity: 0.6, unit_price_ex_gst: 110, total_ex_gst: 66 },
      ],
    },
    better: null,
    best: null,
  })
  const candidates = () =>
    buildCandidatePrices(
      [],
      [{ name: 'Replace double GPO', price: 22, category: 'gpo' }], // mig 036
      pricingBook,
    )

  it('WITHOUT the min-labour floor it fails (0.6h < 2h) → would inspect', () => {
    const res = validateQuoteGrounding(twoGpoDraft(), pricingBook, candidates())
    expect(res.valid).toBe(false)
  })

  it('WITH the floor applied first, the same job GROUNDS (no inspection)', () => {
    const draft = twoGpoDraft()
    const { adjustedTiers } = applyMinLabourFloor(draft, pricingBook)
    expect(adjustedTiers).toContain('good') // 0.6h → topped to 2h
    const res = validateQuoteGrounding(draft, pricingBook, candidates())
    expect(res.valid).toBe(true)
  })

  it('explicit gpo category is not a bypass — a downlight line at the same price still fails', () => {
    const draft = twoGpoDraft()
    draft.good.line_items[0].description = 'Install 6 LED downlights'
    applyMinLabourFloor(draft, pricingBook)
    const res = validateQuoteGrounding(draft, pricingBook, candidates())
    expect(res.valid).toBe(false)
  })
})
