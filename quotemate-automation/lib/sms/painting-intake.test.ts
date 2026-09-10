// SMS painting receptionist — pure intake state machine tests.

import { describe, expect, it } from 'vitest'
import {
  applyPaintingAnswer,
  isAffirmative,
  isNegative,
  isStopRequest,
  looksLikePaintingEnquiry,
  mapCeilingHeight,
  mapCoats,
  mapColourChange,
  mapCondition,
  mapScopes,
  mapStoreys,
  nextPaintingStep,
  paintingReadiness,
  parseAuState,
  parseCeilingMetres,
  parseFloorAreaM2,
  parsePostcode,
  toPaintingRequest,
  type PaintingSlots,
} from './painting-intake'

describe('looksLikePaintingEnquiry', () => {
  it.each(['repaint', 'repaints', 'repainting', 're-paint', 're-paints', 're-painting', 'paint', 'painting'])(
    'recognises a targeted %s enquiry', (word) => {
      expect(looksLikePaintingEnquiry(`Please quote ${word} interior walls at 12 Example Road, Sydney NSW 2000.`)).toBe(true)
    },
  )
  it.each(['Do you do repainting?', 'Do you offer re-painting?', 'Please quote repainting the roof.', 'A complaint about my power points', 'An unrepainting software task'])(
    'keeps non-painting-flow wording out: %s', (message) => {
      expect(looksLikePaintingEnquiry(message)).toBe(false)
    },
  )
  it('matches clear painting terms', () => {
    expect(looksLikePaintingEnquiry('I need a painting quote')).toBe(true)
    expect(looksLikePaintingEnquiry('can you repaint my house')).toBe(true)
    expect(looksLikePaintingEnquiry('paint the bedroom please')).toBe(true)
    expect(looksLikePaintingEnquiry('after a painter for the exterior')).toBe(true)
    expect(looksLikePaintingEnquiry('quote to paint my interior walls')).toBe(true)
    expect(looksLikePaintingEnquiry('the paintwork is looking tired')).toBe(true)
  })
  // Round 5 (live 2026-07-25, QM Sparky): "You do paint?" started a painting
  // intake + form link. A capability QUESTION must be answered, not converted
  // into a job; a request that names a target is still a job.
  it('does not engage on a bare capability question', () => {
    expect(looksLikePaintingEnquiry('You do paint?')).toBe(false)
    expect(looksLikePaintingEnquiry('do you do painting?')).toBe(false)
    expect(looksLikePaintingEnquiry('do you paint')).toBe(false)
  })
  it('still engages on every real lead, including question-shaped ones', () => {
    for (const msg of [
      'can you repaint my house',
      'can you also repaint the back deck?',
      'how much for painting?',
      'can you paint kitchen cupboards?',
      'do you paint fences?',
      'what would it cost to repaint a house',
      'keen to get painting done, how much?',
    ]) {
      expect(looksLikePaintingEnquiry(msg), msg).toBe(true)
    }
  })
  it('leaves roof work to the roofing slice (does not poach)', () => {
    expect(looksLikePaintingEnquiry('repaint the roof')).toBe(false)
    expect(looksLikePaintingEnquiry('paint my roof restoration')).toBe(false)
  })
  it('does not trip on electrical/plumbing messages', () => {
    expect(looksLikePaintingEnquiry('I need 6 downlights')).toBe(false)
    expect(looksLikePaintingEnquiry('my hot water system is leaking')).toBe(false)
    expect(looksLikePaintingEnquiry('a complaint about the power points')).toBe(false)
  })
  it('is empty-safe', () => {
    expect(looksLikePaintingEnquiry('')).toBe(false)
  })
})

describe('isStopRequest', () => {
  it('catches explicit stop/cancel/opt-out and clear frustration', () => {
    for (const s of ['STOP PLEASE', 'cancel', "let's cancel now", 'unsubscribe', 'not interested', 'leave me alone', 'FUCK NO!', 'just stop this session', 'nevermind']) {
      expect(isStopRequest(s)).toBe(true)
    }
  })
  it('does NOT treat a bare yes/no or a normal address as a stop', () => {
    for (const s of ['yes', 'no', 'yeah thats right', '5 Smith St, Bondi NSW 2026', 'walls and ceilings', 'standard']) {
      expect(isStopRequest(s)).toBe(false)
    }
  })
  // F11 (shared shape): "stop leaking"/"stop the leak" is an outcome, not an opt-out.
  it('does NOT cancel when "stop" is asking to stop a leak', () => {
    for (const s of ['will the roof stop leaking after this?', 'can you make it stop leaking', 'how do we stop the leak']) {
      expect(isStopRequest(s)).toBe(false)
    }
  })
})

describe('applyPaintingAnswer address validation', () => {
  it('ignores a reply with no street number (does not store junk as address)', () => {
    expect(applyPaintingAnswer({}, 'address', 'somewhere in town').address).toBeUndefined()
  })
  it('ignores a stop sentence even when it contains a digit', () => {
    expect(applyPaintingAnswer({}, 'address', 'cancel my 2 quotes please').address).toBeUndefined()
  })
  it('accepts a real address with a street number and lifts postcode + state', () => {
    const s = applyPaintingAnswer({}, 'address', '5 Smith St, Bondi NSW 2026')
    expect(s.address).toBe('5 Smith St, Bondi NSW 2026')
    expect(s.postcode).toBe('2026')
    expect(s.state).toBe('NSW')
    expect(s.address_confirmed).toBe(false)
  })
})

describe('mapScopes', () => {
  it('maps single and multiple surfaces, in stable order', () => {
    expect(mapScopes('walls')).toEqual(['walls'])
    expect(mapScopes('walls and ceilings')).toEqual(['walls', 'ceilings'])
    expect(mapScopes('exterior and walls')).toEqual(['walls', 'exterior'])
    expect(mapScopes('just the trim')).toEqual(['trim'])
  })
  it('maps trim synonyms', () => {
    expect(mapScopes('skirting and architraves')).toEqual(['trim'])
    expect(mapScopes('the doors and door frames')).toEqual(['trim'])
  })
  it('maps "everything" to all four surfaces', () => {
    expect(mapScopes('everything')).toEqual(['walls', 'ceilings', 'trim', 'exterior'])
  })
  it('maps a bare "inside" / "interior" to walls + ceilings', () => {
    expect(mapScopes('inside')).toEqual(['walls', 'ceilings'])
    expect(mapScopes('just the interior')).toEqual(['walls', 'ceilings'])
  })
  it('returns null when no surface is recognised (re-ask)', () => {
    expect(mapScopes('the back garden')).toBeNull()
    expect(mapScopes('')).toBeNull()
  })
})

describe('mapCoats', () => {
  it('maps coat counts and synonyms', () => {
    expect(mapCoats('1 coat')).toBe(1)
    expect(mapCoats('just one')).toBe(1)
    expect(mapCoats('a refresh')).toBe(1)
    expect(mapCoats('2 coats')).toBe(2)
    expect(mapCoats('two')).toBe(2)
    expect(mapCoats('standard')).toBe(2)
    expect(mapCoats('3 coats')).toBe(3)
    expect(mapCoats('premium')).toBe(3)
  })
  it('maps an unsure answer to 2 (the AU default)', () => {
    expect(mapCoats('not sure, whatever you reckon')).toBe(2)
  })
  it('returns null on an unrecognised answer (re-ask)', () => {
    expect(mapCoats('purple')).toBeNull()
    expect(mapCoats('')).toBeNull()
  })
})

describe('mapCondition', () => {
  it('maps the four conditions', () => {
    expect(mapCondition('already painted, just tired')).toBe('sound')
    expect(mapCondition('a few nail holes to fill')).toBe('minor')
    expect(mapCondition('bare plaster, never painted')).toBe('bare')
    expect(mapCondition('flaking and peeling badly')).toBe('poor')
  })
  it('lets poor (inspection trigger) win over any other token', () => {
    expect(mapCondition('previously painted but flaking now')).toBe('poor')
  })
  it('returns null on unsure / unrecognised (never guesses the prep lever)', () => {
    expect(mapCondition('not sure really')).toBeNull()
    expect(mapCondition('it is blue')).toBeNull()
  })
})

describe('parseCeilingMetres', () => {
  it('reads metres with and without a unit', () => {
    expect(parseCeilingMetres('3.2m')).toBe(3.2)
    expect(parseCeilingMetres('3.2 m')).toBe(3.2)
    expect(parseCeilingMetres('about 2.4m')).toBe(2.4)
    expect(parseCeilingMetres('2.7 metres')).toBe(2.7)
    expect(parseCeilingMetres('2.7')).toBe(2.7)
  })
  it('reads millimetres (explicit and bare 4-digit)', () => {
    expect(parseCeilingMetres('2700mm')).toBe(2.7)
    expect(parseCeilingMetres('2400')).toBe(2.4)
    expect(parseCeilingMetres('3200')).toBe(3.2)
  })
  it('ignores non-height / out-of-band numbers', () => {
    expect(parseCeilingMetres('9ft')).toBeNull() // imperial → handled by keyword
    expect(parseCeilingMetres('high, 2nd floor')).toBeNull() // bare integer, not a height
    expect(parseCeilingMetres('standard')).toBeNull()
    expect(parseCeilingMetres('10')).toBeNull() // 10 m is not a residential ceiling
  })
  it('prefers the unit-bearing token over a leading unrelated number', () => {
    expect(parseCeilingMetres('2nd floor 2.7m')).toBe(2.7)
    expect(parseCeilingMetres('2 storeys, 2.7m ceilings')).toBe(2.7)
    expect(parseCeilingMetres('the 1st room is 2.7m')).toBe(2.7)
    expect(parseCeilingMetres('4000 sqft house, 2.7m ceilings')).toBe(2.7) // not 4 m
    expect(parseCeilingMetres('3000 sq ft, ceilings 2.7m')).toBe(2.7)
  })
})

describe('mapCeilingHeight', () => {
  it('maps the word buckets', () => {
    expect(mapCeilingHeight('standard')).toBe('standard')
    expect(mapCeilingHeight('about 2.4m')).toBe('standard')
    expect(mapCeilingHeight('high ceilings, a Queenslander')).toBe('high')
    expect(mapCeilingHeight('cathedral ceilings')).toBe('raked')
    expect(mapCeilingHeight('raked / vaulted')).toBe('raked')
  })
  it('bands a stated numeric height', () => {
    expect(mapCeilingHeight('2.4m')).toBe('standard')
    expect(mapCeilingHeight('2.7m')).toBe('high')
    expect(mapCeilingHeight('2700')).toBe('high')
    expect(mapCeilingHeight('2.9m')).toBe('high')
  })
  it('routes ceilings materially above 2.7 m to extra_high (the inspection bucket)', () => {
    // The reported bug: "3.2m" higher than 2.7 m used to fall through to null.
    expect(mapCeilingHeight('3.2m')).toBe('extra_high')
    expect(mapCeilingHeight('3.2 m')).toBe('extra_high')
    expect(mapCeilingHeight('3200mm')).toBe('extra_high')
    expect(mapCeilingHeight('about 3 metres')).toBe('extra_high')
  })
  it('does not dead-end or mis-band when a non-height number leads the reply', () => {
    // Regression: a leading "2nd"/"2 storeys"/"4000 sqft" used to anchor the
    // parser and either loop (re-ask) or silently force inspection.
    expect(mapCeilingHeight('2nd floor 2.7m')).toBe('high')
    expect(mapCeilingHeight('2 storeys, 2.7m ceilings')).toBe('high')
    expect(mapCeilingHeight('4000 sqft house, 2.7m ceilings')).toBe('high')
  })
  it('maps unsure to standard, gibberish to null', () => {
    expect(mapCeilingHeight('no idea')).toBe('standard')
    expect(mapCeilingHeight('orange')).toBeNull()
  })
})

describe('mapStoreys', () => {
  it('maps the storey counts', () => {
    expect(mapStoreys('single storey')).toBe(1)
    expect(mapStoreys('one level')).toBe(1)
    expect(mapStoreys('double storey')).toBe(2)
    expect(mapStoreys('two')).toBe(2)
    expect(mapStoreys('3 storeys')).toBe(3)
    expect(mapStoreys('triple storey')).toBe(3)
  })
  it('maps unsure to 1, gibberish to null', () => {
    expect(mapStoreys('not sure')).toBe(1)
    expect(mapStoreys('banana')).toBeNull()
  })
})

describe('parseFloorAreaM2', () => {
  it('reads a stated area with or without a unit', () => {
    expect(parseFloorAreaM2('180')).toBe(180)
    expect(parseFloorAreaM2('180m2')).toBe(180)
    expect(parseFloorAreaM2('180 sqm')).toBe(180)
    expect(parseFloorAreaM2('about 180')).toBe(180)
    expect(parseFloorAreaM2('roughly 220 square metres')).toBe(220)
    expect(parseFloorAreaM2('95.5')).toBe(95.5)
  })
  it('returns null on "not sure", gibberish, empty, and out-of-band numbers', () => {
    expect(parseFloorAreaM2('not sure')).toBeNull()
    expect(parseFloorAreaM2('no idea sorry')).toBeNull()
    expect(parseFloorAreaM2('')).toBeNull()
    expect(parseFloorAreaM2('2500')).toBeNull() // above the 2000 m² band
    expect(parseFloorAreaM2('0')).toBeNull()
  })
})

describe('mapColourChange', () => {
  it('reads yes/no and synonyms, defaulting ambiguous to false', () => {
    expect(mapColourChange('yes, going darker')).toBe(true)
    expect(mapColourChange('different colour')).toBe(true)
    expect(mapColourChange('no')).toBe(false)
    expect(mapColourChange('same colour')).toBe(false)
    expect(mapColourChange('not changing it')).toBe(false)
    expect(mapColourChange('hmm')).toBe(false)
  })
})

describe('parsePostcode / parseAuState', () => {
  it('extracts postcode + state', () => {
    expect(parsePostcode('5 Smith St, Bondi NSW 2026')).toBe('2026')
    expect(parseAuState('5 Smith St, Bondi NSW 2026')).toBe('NSW')
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

function freshThrough(messages: Array<string>): PaintingSlots {
  // Drive the machine: at each turn, ask nextPaintingStep, apply the answer.
  let slots: PaintingSlots = {}
  for (const m of messages) {
    const { step } = nextPaintingStep(slots)
    if (step === 'ready' || step === 'inspection') break
    slots = applyPaintingAnswer(slots, step, m)
  }
  return slots
}

describe('nextPaintingStep — gathering order', () => {
  it('asks address → confirm → scopes → coats → condition → ceiling → storeys → floor area → colour → ready', () => {
    let slots: PaintingSlots = {}
    expect(nextPaintingStep(slots).step).toBe('address')

    slots = applyPaintingAnswer(slots, 'address', '5 Smith St, Bondi NSW 2026')
    expect(nextPaintingStep(slots).step).toBe('confirm_address')
    expect(nextPaintingStep(slots).question).toMatch(/5 Smith St/)

    slots = applyPaintingAnswer(slots, 'confirm_address', 'yes')
    expect(nextPaintingStep(slots).step).toBe('scopes')

    slots = applyPaintingAnswer(slots, 'scopes', 'walls and ceilings')
    expect(nextPaintingStep(slots).step).toBe('coats')

    slots = applyPaintingAnswer(slots, 'coats', '2 coats')
    expect(nextPaintingStep(slots).step).toBe('condition')

    slots = applyPaintingAnswer(slots, 'condition', 'already painted')
    expect(nextPaintingStep(slots).step).toBe('ceiling_height')

    slots = applyPaintingAnswer(slots, 'ceiling_height', 'standard')
    expect(nextPaintingStep(slots).step).toBe('storeys')

    slots = applyPaintingAnswer(slots, 'storeys', 'single storey')
    expect(nextPaintingStep(slots).step).toBe('floor_area')
    expect(nextPaintingStep(slots).question).toMatch(/not sure/i)

    slots = applyPaintingAnswer(slots, 'floor_area', 'about 180')
    expect(slots.manual_floor_area_m2).toBe(180)
    // colour_change stays LAST, so its "Last one —" wording stays true.
    expect(nextPaintingStep(slots).step).toBe('colour_change')

    slots = applyPaintingAnswer(slots, 'colour_change', 'no')
    expect(nextPaintingStep(slots).step).toBe('ready')
  })

  // The floor-area ask is optional and asked exactly once: a skip records
  // null (the address lookup supplies the area) and the step never re-asks.
  it('floor_area: "not sure" skips (null) and moves on to colour_change, never re-asked', () => {
    let slots: PaintingSlots = {
      address: '1 A St', address_confirmed: true, postcode: '4000', state: 'QLD',
      scopes: ['walls'], coats: 2, condition: 'sound', ceiling_height: 'standard', storeys: 1,
    }
    expect(nextPaintingStep(slots).step).toBe('floor_area')
    slots = applyPaintingAnswer(slots, 'floor_area', 'not sure')
    expect(slots.manual_floor_area_m2).toBeNull()
    expect(nextPaintingStep(slots).step).toBe('colour_change')

    slots = applyPaintingAnswer(slots, 'colour_change', 'no')
    expect(nextPaintingStep(slots).step).toBe('ready')
  })

  it('asks for postcode + state when the address line did not include them', () => {
    let slots: PaintingSlots = {}
    slots = applyPaintingAnswer(slots, 'address', '12 Smith Street')
    slots = applyPaintingAnswer(slots, 'confirm_address', 'yes')
    expect(nextPaintingStep(slots).step).toBe('location')

    slots = applyPaintingAnswer(slots, 'location', '4151 QLD')
    expect(slots.postcode).toBe('4151')
    expect(slots.state).toBe('QLD')
    expect(nextPaintingStep(slots).step).toBe('scopes')
  })

  it('re-asks the address when the customer says the read-back is wrong', () => {
    let slots: PaintingSlots = {}
    slots = applyPaintingAnswer(slots, 'address', '12 Wrong St, Bondi NSW 2026')
    slots = applyPaintingAnswer(slots, 'confirm_address', 'no')
    expect(nextPaintingStep(slots).step).toBe('address')
  })

  it('re-asks scopes / coats on an unrecognised answer (does not advance)', () => {
    let slots: PaintingSlots = { address: '1 A St', address_confirmed: true, postcode: '4000', state: 'QLD' }
    slots = applyPaintingAnswer(slots, 'scopes', 'the garden')
    expect(nextPaintingStep(slots).step).toBe('scopes')

    slots = { ...slots, scopes: ['walls'] }
    slots = applyPaintingAnswer(slots, 'coats', 'purple')
    expect(nextPaintingStep(slots).step).toBe('coats')
  })
})

describe('nextPaintingStep — inspection short-circuits', () => {
  const partial: PaintingSlots = {
    address: '1 A St', address_confirmed: true, postcode: '4000', state: 'QLD',
    scopes: ['walls'], coats: 2,
  }
  it('routes poor condition straight to inspection (skips ceiling/storeys)', () => {
    const s = { ...partial, condition: 'poor' as const }
    expect(nextPaintingStep(s)).toMatchObject({ step: 'inspection', reason: expect.stringMatching(/flaking|damaged/i) })
  })
  it('routes raked ceilings to inspection', () => {
    const s = { ...partial, condition: 'sound' as const, ceiling_height: 'raked' as const }
    expect(nextPaintingStep(s)).toMatchObject({ step: 'inspection', reason: expect.stringMatching(/raked|cathedral/i) })
  })
  it('routes 3+ storeys to inspection', () => {
    const s = { ...partial, condition: 'sound' as const, ceiling_height: 'standard' as const, storeys: 3 as const }
    expect(nextPaintingStep(s)).toMatchObject({ step: 'inspection', reason: expect.stringMatching(/storeys|access/i) })
  })
})

describe('paintingReadiness + inspection fallback', () => {
  const base: PaintingSlots = {
    address: '1 A St', address_confirmed: true, postcode: '4000', state: 'QLD',
    scopes: ['walls', 'ceilings'], coats: 2, condition: 'sound',
    ceiling_height: 'standard', storeys: 1, manual_floor_area_m2: null, colour_change: false,
  }
  it('ready on a clean job', () => {
    expect(paintingReadiness(base)).toBe('ready')
    expect(nextPaintingStep(base).step).toBe('ready')
  })
  it('routes poor condition to inspection', () => {
    expect(paintingReadiness({ ...base, condition: 'poor' })).toBe('inspection')
  })
  it('routes raked ceiling to inspection', () => {
    expect(paintingReadiness({ ...base, ceiling_height: 'raked' })).toBe('inspection')
  })
  it('routes 3+ storeys to inspection', () => {
    expect(paintingReadiness({ ...base, storeys: 3 })).toBe('inspection')
  })
  it('need_more until the address is confirmed', () => {
    expect(paintingReadiness({ ...base, address_confirmed: false })).toBe('need_more')
  })
  it('need_more until postcode + state are known', () => {
    expect(paintingReadiness({ ...base, postcode: null })).toBe('need_more')
  })
  it('need_more until the colour-change question is answered', () => {
    expect(paintingReadiness({ ...base, colour_change: undefined })).toBe('need_more')
  })
  // Tri-state on the optional floor area: undefined = not asked yet
  // (need_more), null = asked and skipped (complete), number = provided.
  it('need_more until the floor-area question has been ASKED; skipped or stated are both complete', () => {
    expect(paintingReadiness({ ...base, manual_floor_area_m2: undefined })).toBe('need_more')
    expect(paintingReadiness({ ...base, manual_floor_area_m2: null })).toBe('ready')
    expect(paintingReadiness({ ...base, manual_floor_area_m2: 180 })).toBe('ready')
  })
})

describe('toPaintingRequest', () => {
  it('builds the estimate request from gathered slots, defaulting to the Other-tools path', () => {
    const slots = freshThrough([
      '5 Smith St, Bondi NSW 2026',
      'yes',
      'walls and ceilings',
      '2 coats',
      'already painted',
      'standard',
      'single storey',
      'not sure', // floor area skipped → the address lookup supplies it
      'no',
    ])
    const req = toPaintingRequest(slots)
    expect(req).not.toBeNull()
    expect(req!.address).toEqual({ address: '5 Smith St, Bondi NSW 2026', postcode: '2026', state: 'NSW' })
    expect(req!.inputs).toEqual({
      scopes: ['walls', 'ceilings'],
      coats: 2,
      condition: 'sound',
      ceiling_height: 'standard',
      colour_change: false,
      storeys: 1,
      manual_floor_area_m2: null,
    })
  })
  it('passes a customer-stated floor area through to the request', () => {
    const slots = freshThrough([
      '5 Smith St, Bondi NSW 2026',
      'yes',
      'walls and ceilings',
      '2 coats',
      'already painted',
      'standard',
      'single storey',
      '180 sqm',
      'no',
    ])
    expect(toPaintingRequest(slots)!.inputs.manual_floor_area_m2).toBe(180)
  })
  it('returns null when not enough is gathered', () => {
    expect(toPaintingRequest({ address: '1 A St' })).toBeNull()
  })
})
