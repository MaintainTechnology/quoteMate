// Tests for the EV charger estimate document — spec ev-charger-estimate-template R17.
//
// House pattern: vitest, node env, toContain / index-ordering assertions, no
// golden files. The builder is pure, so every case here is a direct call.

import { describe, it, expect } from 'vitest'
import {
  buildEvChargerEstimateHtml,
  evChargerPhase,
  evEstimateTerms,
  deriveEvDescriptionOfWorks,
  deriveEvExclusions,
  isEvChargerJob,
  EV_ESTIMATE_TEMPLATE_KEY,
  EV_PHASE_1_TITLE,
  EV_PHASE_2_TITLE,
  type EvChargerEstimateInput,
  type EvEstimateLineItem,
} from './report-html-ev-charger'

/** Fixed date ⇒ deterministic output (the builder never calls Date.now()). */
const ISSUED = new Date('2026-08-13T02:00:00.000Z')

function li(
  description: string,
  quantity: number,
  unit: string,
  unitPrice: number,
  extra: Partial<EvEstimateLineItem> = {},
): EvEstimateLineItem {
  return {
    description,
    quantity,
    unit,
    unit_price_ex_gst: unitPrice,
    total_ex_gst: Math.round(quantity * unitPrice * 100) / 100,
    ...extra,
  }
}

// The EST-0534 line set (spec Appendix A), verbatim.
const EST_0534_PHASE_1 = [
  li('40A 3-Pole RCBO 6kA', 1, 'each', 195),
  li('6mm 4 Core + Earth Orange Circular standard cable', 10, 'metre', 11.34),
  li('25mm Medium-duty conduit - 4m lengths', 3, 'length', 16.8),
  li('Conduit fittings, saddles, and fixings', 1, 'lot', 67.5),
  li('Install 3-phase RCBO and rough-in 10m cable run', 3, 'hr', 100),
]
const EST_0534_PHASE_2 = [
  li('Mount and terminate client-supplied EV charger', 1.5, 'hr', 100),
  li('Testing, commissioning, and site cleanup', 1, 'hr', 100),
]

function baseInput(over: Partial<EvChargerEstimateInput> = {}): EvChargerEstimateInput {
  const items = [...EST_0534_PHASE_1, ...EST_0534_PHASE_2]
  return {
    businessName: 'Electrical3',
    estimateRef: 'EST-0534',
    customerName: 'Carlos Silva Junior',
    customerEmail: 'carsilvajunior@gmail.com',
    customerPhone: '0467 420 321',
    siteAddress: 'Frenchs Forest NSW 2086',
    scopeOfWorks: 'Installation of the Standard 3-Phase EV charger.',
    descriptionOfWorks: ['Isolate power and install the RCBO.'],
    assumptions: ['The existing switchboard has sufficient physical space.'],
    exclusions: ['Underground trenching or complex containment systems.'],
    good: {
      label: 'Standard install',
      subtotal_ex_gst: items.reduce((s, i) => s + i.total_ex_gst, 0),
      line_items: items,
    },
    better: null,
    best: null,
    generatedAt: ISSUED,
    ...over,
  }
}

describe('evChargerPhase', () => {
  it('puts rough-in materials and labour in phase 1 (EST-0534)', () => {
    for (const line of EST_0534_PHASE_1) {
      expect(evChargerPhase(line), line.description).toBe(1)
    }
  })

  it('puts mounting, terminating, testing and commissioning in phase 2 (EST-0534)', () => {
    for (const line of EST_0534_PHASE_2) {
      expect(evChargerPhase(line), line.description).toBe(2)
    }
  })

  it('classifies the EST-0565 works lines the same way', () => {
    const phase1 = [
      'Isolate power and install 40A single-pole RCBO into existing switchboard',
      'Supply and install 25mm medium-duty PVC surface conduit route (approx. 6 metres)',
      'Draw 6mm 2 Core + Earth standard cable through conduit',
    ]
    const phase2 = [
      'Securely mount and terminate Tesla Wall Connector Gen 3 unit',
      'Commission EV charger, perform initial operational testing, and clean up work area',
    ]
    for (const d of phase1) expect(evChargerPhase(li(d, 1, 'each', 1)), d).toBe(1)
    for (const d of phase2) expect(evChargerPhase(li(d, 1, 'each', 1)), d).toBe(2)
  })

  it('puts the charger unit itself in phase 2 via the catalogue id, not its wording', () => {
    const unit = li('Tesla Wall Connector Gen 3', 1, 'each', 750, {
      source: 'material:11111111-2222-3333-4444-555555555555',
    })
    // Its description matches no fit-off keyword, so without the catalogue
    // signal it would land in the rough-in.
    expect(evChargerPhase(unit)).toBe(1)
    expect(
      evChargerPhase(unit, { chargerUnitIds: ['11111111-2222-3333-4444-555555555555'] }),
    ).toBe(2)
  })

  it('reads catalogue_id as well as a typed source', () => {
    const unit = li('BYD wallbox 7kW', 1, 'each', 690, { catalogue_id: 'cat-1' })
    expect(evChargerPhase(unit, { chargerUnitIds: ['cat-1'] })).toBe(2)
  })

  it('keeps "surface mount" containment in the rough-in', () => {
    // "mount" is a material descriptor here, not the act of fixing the charger.
    // Matching it would print conduit under Fit-off on the customer's estimate.
    for (const d of [
      '25mm surface mount conduit - 4m lengths',
      'Surface mount enclosure',
      'Surface-mount cable tray',
      'Wall mount ducting 50mm',
    ]) {
      expect(evChargerPhase(li(d, 1, 'each', 20)), d).toBe(1)
    }
  })

  it('still treats a genuine fit-off line as phase 2 when it names cable', () => {
    // The unambiguous verbs win over the containment noun — otherwise the
    // containment guard would drag real fit-off labour back into the rough-in.
    for (const d of [
      'Mount and terminate the charger, make off cable glands',
      'Testing and commissioning of the cable run',
    ]) {
      expect(evChargerPhase(li(d, 1, 'hr', 100)), d).toBe(2)
    }
  })

  it('treats mounting the charger itself as phase 2 when no containment is named', () => {
    expect(evChargerPhase(li('Mount charger bracket to masonry', 1, 'hr', 100))).toBe(2)
  })
})

describe('buildEvChargerEstimateHtml — sections', () => {
  it('renders every section in the spec R3 order', () => {
    const html = buildEvChargerEstimateHtml(
      baseInput({ optionalUpsells: [{ name: 'Surge protection device' }] }),
    )
    const order = [
      'ESTIMATE',
      'Prepared For:',
      'Proposal Details:',
      'Scope of Work',
      'Description of Works',
      'Assumptions',
      'Inclusions',
      'Exclusions',
      'Optional Upgrades &amp; Recommendations',
      `Phase 1 - ${EV_PHASE_1_TITLE}`,
      `Phase 2 - ${EV_PHASE_2_TITLE}`,
      'Subtotal (ex GST):',
      'Terms &amp; Conditions',
    ]
    let cursor = -1
    for (const token of order) {
      const at = html.indexOf(token)
      expect(at, `${token} present`).toBeGreaterThan(-1)
      expect(at, `${token} in order`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('prints the estimate number and the source documents column headers', () => {
    const html = buildEvChargerEstimateHtml(baseInput())
    expect(html).toContain('EST-0534')
    expect(html).toContain('<th>Description</th>')
    expect(html).toContain('>Qty</th>')
    expect(html).toContain('>Rate</th>')
    expect(html).toContain('>Amount</th>')
    // Not the generic report's headers.
    expect(html).not.toContain('Unit (ex GST)')
  })

  it('prints quantity and unit in one upper-cased cell', () => {
    const html = buildEvChargerEstimateHtml(baseInput())
    expect(html).toContain('10 METRE')
    expect(html).toContain('1.5 HOUR'.replace('HOUR', 'HR'))
    expect(html).toContain('3 LENGTH')
    expect(html).toContain('1 LOT')
  })

  it('prints Date and a Valid Until 30 days later', () => {
    const html = buildEvChargerEstimateHtml(baseInput())
    expect(html).toContain('13 Aug 2026')
    expect(html).toContain('Valid Until')
    expect(html).toContain('12 Sept 2026')
  })

  it('omits a section entirely — heading included — when it has no content', () => {
    const html = buildEvChargerEstimateHtml(
      baseInput({ assumptions: [], exclusions: [], descriptionOfWorks: [] }),
    )
    expect(html).not.toContain('Assumptions')
    expect(html).not.toContain('>Exclusions<')
    expect(html).not.toContain('Description of Works')
    // The sections that always have content still render.
    expect(html).toContain('Inclusions')
  })

  it('escapes user-influenced strings', () => {
    const html = buildEvChargerEstimateHtml(
      baseInput({
        customerName: '<script>alert(1)</script>',
        scopeOfWorks: 'Fit "the" charger & test <b>now</b>',
      }),
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('is deterministic for a fixed generatedAt', () => {
    const input = baseInput()
    expect(buildEvChargerEstimateHtml(input)).toBe(buildEvChargerEstimateHtml(input))
  })
})

describe('buildEvChargerEstimateHtml — phases and totals', () => {
  it('renders two phase tables whose Group Totals sum to the tier subtotal', () => {
    const html = buildEvChargerEstimateHtml(baseInput())
    const p1 = EST_0534_PHASE_1.reduce((s, i) => s + i.total_ex_gst, 0)
    const p2 = EST_0534_PHASE_2.reduce((s, i) => s + i.total_ex_gst, 0)
    expect(p1).toBeCloseTo(726.3, 2)
    expect(p2).toBeCloseTo(250, 2)
    expect(html).toContain('$726.30')
    expect(html).toContain('$250.00')
    // …and that sum is the subtotal the totals block prints.
    expect(p1 + p2).toBeCloseTo(976.3, 2)
    expect(html).toContain('$976.30')
    expect((html.match(/Group Total:/g) ?? []).length).toBe(2)
  })

  it('collapses to a single Phase 1 table when only one phase has lines', () => {
    const items = EST_0534_PHASE_1
    const html = buildEvChargerEstimateHtml(
      baseInput({
        good: {
          label: 'Switchboard RCBO conversion',
          subtotal_ex_gst: items.reduce((s, i) => s + i.total_ex_gst, 0),
          line_items: items,
        },
      }),
    )
    expect(html).toContain(`Phase 1 - ${EV_PHASE_1_TITLE}`)
    expect(html).not.toContain(`Phase 2 - ${EV_PHASE_2_TITLE}`)
    expect((html.match(/Group Total:/g) ?? []).length).toBe(1)
  })

  it('reconciles Subtotal + GST = Total', () => {
    const html = buildEvChargerEstimateHtml(baseInput())
    // 976.30 ex → 1073.93 inc, GST 97.63 — exactly the source estimate.
    expect(html).toContain('$976.30')
    expect(html).toContain('$97.63')
    expect(html).toContain('$1,073.93')
  })

  it('omits the GST row entirely for a tenant that is not registered', () => {
    const html = buildEvChargerEstimateHtml(baseInput({ gstRegistered: false }))
    expect(html).not.toContain('GST (10%)')
    // Total equals the subtotal.
    expect(html).toContain('$976.30')
    expect(html).not.toContain('$1,073.93')
    expect(html).toContain('are not subject to GST')
  })

  it('renders each visible tier with its own tables and totals', () => {
    const html = buildEvChargerEstimateHtml(
      baseInput({
        better: {
          label: 'With surge protection',
          subtotal_ex_gst: 1200,
          line_items: [li('Surge protection device', 1, 'each', 1200)],
        },
        selectedTier: 'better',
      }),
    )
    expect(html).toContain('Standard install')
    expect(html).toContain('With surge protection')
    expect(html).toContain('Recommended')
    expect((html.match(/Subtotal \(ex GST\):/g) ?? []).length).toBe(2)
  })
})

describe('buildEvChargerEstimateHtml — optional upgrades and terms', () => {
  it('carries the advisory copy with no invented dollar figures', () => {
    const html = buildEvChargerEstimateHtml(baseInput())
    expect(html).toContain('Surge protection option')
    expect(html).toContain('Switchboard capacity note')
    // Scoped to the section itself: the document legitimately contains other
    // dollar amounts (a $150.00 labour line, for one) that came from priced
    // rows. What must never appear is a figure this template invented.
    const start = html.indexOf('Optional Upgrades')
    const end = html.indexOf('<section class="part ev-phase"', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const section = html.slice(start, end)
    for (const figure of ['$360', '$580', '$150', '$400', '+ GST']) {
      expect(section, `Optional Upgrades must not print ${figure}`).not.toContain(figure)
    }
    // No dollar figure at all when nothing is catalogue-backed.
    expect(section).not.toContain('$')
  })

  it('prints "quoted on site" for an upsell with no catalogue-backed price', () => {
    const html = buildEvChargerEstimateHtml(
      baseInput({ optionalUpsells: [{ name: 'Switchboard health check', price_ex_gst: null }] }),
    )
    expect(html).toContain('Switchboard health check')
    expect(html).toContain('quoted on site')
  })

  it('prints an inc-GST price when a catalogue row backed the upsell', () => {
    const html = buildEvChargerEstimateHtml(
      baseInput({ optionalUpsells: [{ name: 'Surge protection device', price_ex_gst: 360 }] }),
    )
    expect(html).toContain('$396 inc GST')
  })

  it('prints the five terms, with the deposit and include-GST lines replaced', () => {
    const html = buildEvChargerEstimateHtml(baseInput())
    const terms = evEstimateTerms(true)
    expect(terms).toHaveLength(5)
    for (const t of terms) expect(html).toContain(t.replace(/&/g, '&amp;'))
    expect(html).toContain('This is an estimate, not a contract.')
    expect(html).toContain('Prices are valid for 30 days')
    expect(html).toContain('Final price may vary based on actual work performed.')
    // Replaced.
    expect(html).not.toContain('50% deposit')
    expect(html).toContain('$99 refundable site visit fee')
    expect(html).not.toContain('All prices are in AUD and include GST')
    expect(html).toContain('Line items are shown ex GST')
  })
})

describe('derivations', () => {
  it('derives inclusions from the priced line items, de-duplicated', () => {
    const html = buildEvChargerEstimateHtml(baseInput())
    expect(html).toContain('40A 3-Pole RCBO 6kA')
    expect(html).toContain('Testing, commissioning, and site cleanup')
  })

  it('adds the charger unit to exclusions when the customer supplies it', () => {
    const out = deriveEvExclusions(baseInput({ suppliedBy: 'customer' }))
    expect(out[0]).toBe('Supply of the EV charger unit itself.')
  })

  it('does not add that exclusion when the tradie supplies the unit', () => {
    const out = deriveEvExclusions(baseInput({ suppliedBy: 'tradie' }))
    expect(out).not.toContain('Supply of the EV charger unit itself.')
  })

  it('prefers the customer description, then the authored method, then labour lines', () => {
    expect(
      deriveEvDescriptionOfWorks({ scopeDescription: 'One. Two.', methodSteps: ['M'] }),
    ).toEqual(['One.', 'Two.'])
    expect(deriveEvDescriptionOfWorks({ scopeDescription: '', methodSteps: ['M'] })).toEqual(['M'])
    expect(
      deriveEvDescriptionOfWorks({
        lineItems: [li('Install RCBO', 3, 'hr', 100), li('Cable', 10, 'metre', 11)],
      }),
    ).toEqual(['Install RCBO'])
  })
})

describe('template key', () => {
  it('is stable so cached EV PDFs regenerate only on a deliberate bump', () => {
    // ev3 — direction 1B "Numbered & banded" (EST-0006 redesign). The bump is
    // what makes already-cached EV PDFs re-render into the new template; it
    // must never be changed casually, which is why this pin exists.
    expect(EV_ESTIMATE_TEMPLATE_KEY).toBe('ev3')
  })
})

describe('isEvChargerJob — which quotes get this document (R1)', () => {
  it('selects only an electrical ev_charger job', () => {
    expect(isEvChargerJob('ev_charger', 'electrical')).toBe(true)
  })

  it('leaves every other trade on the generic report', () => {
    for (const trade of ['plumbing', 'roofing', 'painting', 'solar', 'commercial_painting']) {
      expect(isEvChargerJob('ev_charger', trade), trade).toBe(false)
    }
  })

  it('leaves every other electrical job type on the generic report', () => {
    for (const jobType of ['downlights', 'power_points', 'switchboard', 'fault_finding', 'job']) {
      expect(isEvChargerJob(jobType, 'electrical'), jobType).toBe(false)
    }
  })

  it('is safe for a null or undefined job type and trade', () => {
    expect(isEvChargerJob(null, 'electrical')).toBe(false)
    expect(isEvChargerJob(undefined, 'electrical')).toBe(false)
    expect(isEvChargerJob('ev_charger', null)).toBe(false)
    expect(isEvChargerJob('ev_charger', undefined)).toBe(false)
    expect(isEvChargerJob(null, null)).toBe(false)
  })
})
