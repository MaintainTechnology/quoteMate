// SMS roofing receptionist — pure intake state machine tests.

import { describe, expect, it } from 'vitest'
import {
  applyRoofingAnswer,
  isAffirmative,
  isNegative,
  looksLikeRoofingEnquiry,
  mapIntent,
  mapMaterial,
  mapPitch,
  nextRoofingStep,
  parseAuState,
  parsePostcode,
  parseYearBuilt,
  roofingReadiness,
  toRoofingRequest,
  type RoofingSlots,
} from './roofing-intake'

describe('looksLikeRoofingEnquiry', () => {
  it('matches clear roofing terms', () => {
    expect(looksLikeRoofingEnquiry('I need a re-roof quote')).toBe(true)
    expect(looksLikeRoofingEnquiry('my gutter is falling off')).toBe(true)
    expect(looksLikeRoofingEnquiry('leaking roof after the storm')).toBe(true)
    expect(looksLikeRoofingEnquiry('need the ridge caps repointed')).toBe(true)
    expect(looksLikeRoofingEnquiry('quote to replace my roof')).toBe(true)
  })
  it('does not trip on incidental "roof" in an electrical context', () => {
    expect(looksLikeRoofingEnquiry('the downlight near the roof cavity flickers')).toBe(false)
    expect(looksLikeRoofingEnquiry('I need 6 downlights')).toBe(false)
  })
  it('is empty-safe', () => {
    expect(looksLikeRoofingEnquiry('')).toBe(false)
  })
})

describe('mapMaterial', () => {
  it('maps metal/colorbond synonyms to colorbond_trimdek', () => {
    for (const s of ['colorbond', 'metal roof', 'tin', 'corrugated', 'zincalume', 'colourbond']) {
      expect(mapMaterial(s)).toBe('colorbond_trimdek')
    }
  })
  it('maps klip-lok / standing seam to colorbond_kliplok', () => {
    expect(mapMaterial('klip-lok')).toBe('colorbond_kliplok')
    expect(mapMaterial('standing seam metal')).toBe('colorbond_kliplok')
  })
  it('maps terracotta and concrete tiles distinctly', () => {
    expect(mapMaterial('terracotta tiles')).toBe('terracotta_tile')
    expect(mapMaterial('concrete tile')).toBe('concrete_tile')
  })
  it('maps generic "tiles" to concrete_tile (AU default)', () => {
    expect(mapMaterial('just tiles')).toBe('concrete_tile')
  })
  it('flags asbestos/fibro/cement sheet — safety wins over any metal token', () => {
    expect(mapMaterial('fibro')).toBe('cement_sheet')
    expect(mapMaterial('asbestos cement sheet')).toBe('cement_sheet')
    expect(mapMaterial('super six')).toBe('cement_sheet')
  })
  it("returns 'unknown' when the customer can't tell", () => {
    expect(mapMaterial('not sure')).toBe('unknown')
    expect(mapMaterial("dunno really")).toBe('unknown')
  })
  it('returns null on an unrecognised answer (re-ask)', () => {
    expect(mapMaterial('it is blue')).toBeNull()
    expect(mapMaterial('')).toBeNull()
  })
})

describe('mapPitch', () => {
  it('maps the buckets', () => {
    expect(mapPitch('pretty flat')).toBe('shallow')
    expect(mapPitch('standard')).toBe('standard')
    expect(mapPitch('average really')).toBe('standard')
    expect(mapPitch('quite steep')).toBe('steep')
    expect(mapPitch('very steep')).toBe('very_steep')
  })
  it("returns 'unknown' on unsure, null on gibberish", () => {
    expect(mapPitch('no idea')).toBe('unknown')
    expect(mapPitch('purple')).toBeNull()
  })
})

describe('mapIntent', () => {
  it('maps the job intents', () => {
    expect(mapIntent('whole roof needs doing')).toBe('full_reroof')
    expect(mapIntent('replace the roof')).toBe('full_reroof')
    expect(mapIntent("it's leaking")).toBe('leak_trace')
    expect(mapIntent('new gutters')).toBe('gutter_replace')
    expect(mapIntent('ridge caps need repointing')).toBe('ridge_cap')
    expect(mapIntent('flashing repair')).toBe('flashing_repair')
    expect(mapIntent('a few broken tiles to fix')).toBe('patch_repair')
  })
  it('returns null when nothing matches', () => {
    expect(mapIntent('hello there')).toBeNull()
  })
})

describe('parseYearBuilt / parsePostcode / parseAuState', () => {
  it('extracts explicit years and decades, ignores relative ages', () => {
    expect(parseYearBuilt('built in 1985')).toBe(1985)
    expect(parseYearBuilt('1970s home')).toBe(1970)
    expect(parseYearBuilt('about 30 years old')).toBeNull()
    expect(parseYearBuilt('3012')).toBeNull() // out of range
  })
  it('extracts postcode + state', () => {
    expect(parsePostcode('670 London Rd, Chandler QLD 4155')).toBe('4155')
    expect(parseAuState('670 London Rd, Chandler QLD 4155')).toBe('QLD')
    expect(parseAuState('no state here')).toBeNull()
  })
})

describe('isAffirmative / isNegative', () => {
  it('reads yes/no', () => {
    expect(isAffirmative('yes thats right')).toBe(true)
    expect(isNegative('no thats wrong')).toBe(true)
    expect(isAffirmative('maybe')).toBe(false)
  })
})

function freshThrough(messages: Array<string>): RoofingSlots {
  // Drive the machine: at each turn, ask nextRoofingStep, apply the answer.
  let slots: RoofingSlots = {}
  for (const m of messages) {
    const { step } = nextRoofingStep(slots)
    if (step === 'ready' || step === 'inspection') break
    slots = applyRoofingAnswer(slots, step, m)
  }
  return slots
}

describe('nextRoofingStep — gathering order', () => {
  it('asks address → confirm → intent → material → pitch → ready', () => {
    let slots: RoofingSlots = {}
    expect(nextRoofingStep(slots).step).toBe('address')

    slots = applyRoofingAnswer(slots, 'address', '670 London Rd, Chandler QLD 4155')
    expect(nextRoofingStep(slots).step).toBe('confirm_address')
    expect(nextRoofingStep(slots).question).toMatch(/670 London Rd/)

    slots = applyRoofingAnswer(slots, 'confirm_address', 'yes')
    expect(nextRoofingStep(slots).step).toBe('intent')

    slots = applyRoofingAnswer(slots, 'intent', 'full re-roof')
    expect(nextRoofingStep(slots).step).toBe('material')

    slots = applyRoofingAnswer(slots, 'material', 'colorbond')
    expect(nextRoofingStep(slots).step).toBe('pitch')

    slots = applyRoofingAnswer(slots, 'pitch', 'standard')
    expect(nextRoofingStep(slots).step).toBe('ready')
  })

  it('re-asks the address when the customer says the read-back is wrong', () => {
    let slots: RoofingSlots = {}
    slots = applyRoofingAnswer(slots, 'address', '12 Wrong St, Bondi NSW 2026')
    slots = applyRoofingAnswer(slots, 'confirm_address', 'no')
    expect(nextRoofingStep(slots).step).toBe('address')
  })

  it('re-asks material on an unrecognised answer (does not advance)', () => {
    let slots: RoofingSlots = { address: '1 A St', address_confirmed: true, intent: 'full_reroof' }
    slots = applyRoofingAnswer(slots, 'material', 'it is greenish')
    expect(nextRoofingStep(slots).step).toBe('material')
  })
})

describe('roofingReadiness + inspection fallback', () => {
  const base: RoofingSlots = {
    address: '1 A St', address_confirmed: true, intent: 'full_reroof',
    material: 'colorbond_trimdek', pitch: 'standard',
  }
  it('ready on a clean metal/standard job', () => {
    expect(roofingReadiness(base)).toBe('ready')
    expect(nextRoofingStep(base).step).toBe('ready')
  })
  it('routes cement_sheet to inspection (asbestos)', () => {
    const s = { ...base, material: 'cement_sheet' as const }
    expect(roofingReadiness(s)).toBe('inspection')
    expect(nextRoofingStep(s)).toMatchObject({ step: 'inspection', reason: expect.stringMatching(/asbestos/i) })
  })
  it('routes unknown material to inspection', () => {
    const s = { ...base, material: 'unknown' as const }
    expect(roofingReadiness(s)).toBe('inspection')
  })
  it('routes very_steep / unknown pitch to inspection', () => {
    expect(roofingReadiness({ ...base, pitch: 'very_steep' })).toBe('inspection')
    expect(roofingReadiness({ ...base, pitch: 'unknown' })).toBe('inspection')
  })
  it('need_more until the address is confirmed', () => {
    expect(roofingReadiness({ ...base, address_confirmed: false })).toBe('need_more')
  })
})

describe('applyRoofingAnswer — opportunistic year capture', () => {
  it('captures a year mentioned during any step', () => {
    const s = applyRoofingAnswer({}, 'address', '5 Old Rd, built 1965, Perth WA 6000')
    expect(s.year_built).toBe(1965)
    expect(s.postcode).toBe('6000')
    expect(s.state).toBe('WA')
  })
})

describe('toRoofingRequest', () => {
  it('builds the pipeline request from gathered slots', () => {
    const slots = freshThrough([
      '670 London Rd, Chandler QLD 4155',
      'yes',
      'full re-roof',
      'colorbond',
      'standard',
    ])
    const req = toRoofingRequest(slots)
    expect(req).not.toBeNull()
    expect(req!.address).toEqual({ address: '670 London Rd, Chandler QLD 4155', postcode: '4155', state: 'QLD' })
    expect(req!.inputs).toEqual({ material: 'colorbond_trimdek', pitch: 'standard', intent: 'full_reroof', building_year_built: null })
  })
  it('returns null when not enough gathered', () => {
    expect(toRoofingRequest({ address: '1 A St' })).toBeNull()
  })
})
