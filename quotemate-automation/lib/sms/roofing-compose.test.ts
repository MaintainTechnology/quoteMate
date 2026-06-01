// SMS roofing receptionist — reply composer tests. Fixtures come from the
// real priceMultiRoof so the SMS body is cross-checked against the
// deterministic pricer's output.

import { describe, expect, it } from 'vitest'
import { priceMultiRoof, type RoofStructureInput } from '@/lib/roofing/pricing'
import type { RoofMetrics, RoofUserInputs } from '@/lib/roofing/types'
import {
  buildRoofingReplyMessage,
  composeConfirmMessage,
  composeEstimateMessage,
  composeInspectionMessage,
  fmtAud,
  narrowQuoteToStructure,
} from './roofing-compose'

function metrics(o: Partial<RoofMetrics> = {}): RoofMetrics {
  return {
    footprint_m2: 200, sloped_area_m2: 220, storeys: 1, form: 'hip',
    hips: 4, valleys: 0, ridge_lm: null, polygon_geojson: null, capture_date: null,
    buildingId: 'b1', ...o,
  }
}
function inputs(o: Partial<RoofUserInputs> = {}): RoofUserInputs {
  return { material: 'colorbond_trimdek', pitch: 'standard', building_year_built: 2005, intent: 'full_reroof', ...o }
}

const house: RoofStructureInput = { buildingId: 'house', role: 'primary', metrics: metrics({ buildingId: 'house' }), inputs: inputs() }
const shed: RoofStructureInput = {
  buildingId: 'shed', role: 'secondary',
  metrics: metrics({ buildingId: 'shed', footprint_m2: 45, sloped_area_m2: 50, form: 'gable' }),
  inputs: inputs({ material: 'colorbond_trimdek' }),
}

const CTX = { address: '670 London Rd, Chandler QLD 4155', quoteUrl: 'https://quote-mate-rho.vercel.app/q/roof/abc123', firstName: 'James' }

describe('fmtAud', () => {
  it('formats whole-dollar AUD with no cents', () => {
    expect(fmtAud(20900)).toBe('$20,900')
    expect(fmtAud(1140.4)).toBe('$1,140')
    expect(fmtAud(Number.NaN)).toBe('$0')
  })
})

describe('composeEstimateMessage', () => {
  const quote = priceMultiRoof({ structures: [house, shed] })
  const msg = composeEstimateMessage({ ...CTX, quote })

  it('uses the deterministic combined tier prices verbatim (inc GST)', () => {
    expect(msg).toContain(fmtAud(quote.combined.tiers[0].inc_gst))
    expect(msg).toContain(fmtAud(quote.combined.tiers[1].inc_gst))
    expect(msg).toContain(fmtAud(quote.combined.tiers[2].inc_gst))
  })
  it('notes structure count + total area and includes the link', () => {
    expect(msg).toMatch(/2 structures/)
    expect(msg).toContain('270 m²') // 220 + 50
    expect(msg).toContain(CTX.quoteUrl)
    expect(msg).toMatch(/inc GST/i)
  })
  it('greets by first name', () => {
    expect(msg.startsWith('Hi James —')).toBe(true)
  })
  it('greets generically with no name', () => {
    const m2 = composeEstimateMessage({ ...CTX, firstName: null, quote })
    expect(m2.startsWith('Hi —')).toBe(true)
  })
  it('says "1 structure" / "of roof" for a single building', () => {
    const single = priceMultiRoof({ structures: [house] })
    const m = composeEstimateMessage({ ...CTX, quote: single })
    expect(m).toMatch(/of roof/)
    expect(m).not.toMatch(/structures/)
  })
})

describe('composeInspectionMessage + routing', () => {
  // The PRIMARY (cement_sheet house) forces the whole job to inspection.
  const asbestosHouse: RoofStructureInput = { ...house, inputs: inputs({ material: 'cement_sheet' }) }
  const quote = priceMultiRoof({ structures: [asbestosHouse, shed] })

  it('routes to inspection when the PRIMARY needs it', () => {
    expect(quote.routing.decision).toBe('inspection_required')
  })
  it('the message states the next step + reason, with no tier price', () => {
    const msg = composeInspectionMessage({ ...CTX, quote })
    expect(msg).toMatch(/on-site inspection/i)
    expect(msg).toContain(quote.routing.reason)
    expect(msg).toContain(CTX.quoteUrl)
    expect(msg).toMatch(/reply yes/i)
  })
  it('buildRoofingReplyMessage dispatches by routing decision', () => {
    const clean = priceMultiRoof({ structures: [house, shed] })
    expect(buildRoofingReplyMessage({ ...CTX, quote: clean })).toMatch(/here's your roofing estimate/)
    expect(buildRoofingReplyMessage({ ...CTX, quote })).toMatch(/on-site inspection/i)
  })
})

describe('estimate flags an inspection-needed secondary (quote the rest)', () => {
  it('a cement_sheet SECONDARY does not block the quote — primary is quoted, secondary flagged', () => {
    const asbestosShed: RoofStructureInput = { ...shed, inputs: inputs({ material: 'cement_sheet' }) }
    const quote = priceMultiRoof({ structures: [house, asbestosShed] })
    expect(quote.routing.decision).toBe('tradie_review') // not blocked
    const msg = buildRoofingReplyMessage({ ...CTX, quote })
    expect(msg).toMatch(/here's your roofing estimate/) // estimate, not inspection
    expect(msg).toMatch(/heads-up/i) // flags the secondary
    expect(msg).toMatch(/on-site look/i)
  })
})

describe('composeConfirmMessage', () => {
  it('single building → simple yes/no + link, no price', () => {
    const quote = priceMultiRoof({ structures: [house] })
    const msg = composeConfirmMessage({ ...CTX, quote })
    expect(msg).toMatch(/is this your roof/i)
    expect(msg).toMatch(/reply yes/i)
    expect(msg).toContain(CTX.quoteUrl)
    // No dollar amounts in the confirm step.
    expect(msg).not.toMatch(/\$\d/)
  })

  it('multiple buildings → numbered list + pick instructions', () => {
    const quote = priceMultiRoof({ structures: [house, shed] })
    const msg = composeConfirmMessage({ ...CTX, quote })
    expect(msg).toMatch(/2 buildings/)
    expect(msg).toMatch(/1\)/)
    expect(msg).toMatch(/2\)/)
    expect(msg).toMatch(/number for just one/i)
    expect(msg).not.toMatch(/\$\d/)
  })
})

describe('narrowQuoteToStructure', () => {
  it('narrows to the picked structure and recomputes combined', () => {
    const quote = priceMultiRoof({ structures: [house, shed] })
    const narrowed = narrowQuoteToStructure(quote, 2) // the shed
    expect(narrowed.structures).toHaveLength(1)
    expect(narrowed.structures[0].buildingId).toBe('shed')
    expect(narrowed.combined.tiers[1].ex_gst).toBe(quote.structures[1].price.tiers[1].ex_gst)
  })
  it('returns the original quote for an out-of-range index', () => {
    const quote = priceMultiRoof({ structures: [house, shed] })
    expect(narrowQuoteToStructure(quote, 9).structures).toHaveLength(2)
  })
})
