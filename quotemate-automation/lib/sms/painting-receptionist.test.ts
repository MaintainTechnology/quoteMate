// SMS painting receptionist — pure per-turn decision tests.

import { describe, expect, it } from 'vitest'
import {
  advancePainting,
  customerWantsForm,
  expireIdlePaintingState,
  isActivePaintingFlow,
  nextPaintingConversationState,
  paintingTurnIsDeterministic,
  shouldEngagePainting,
  type PaintingConversationState,
  type PaintingTurnDecision,
} from './painting-receptionist'
import { toPaintingRequest } from './painting-intake'
import type { PaintScope } from '@/lib/painting/types'

function drive(messages: Array<string>): {
  decisions: PaintingTurnDecision[]
  finalState: PaintingConversationState
} {
  let state: PaintingConversationState | null = null
  const decisions: PaintingTurnDecision[] = []
  for (const m of messages) {
    const d = advancePainting(state, m)
    decisions.push(d)
    state = nextPaintingConversationState(d)
  }
  return { decisions, finalState: state as PaintingConversationState }
}

describe('advancePainting — opener offers the form first', () => {
  it('engages the fresh specialist for repainting while retaining gather and decline guards', () => {
    const message = 'Please quote repainting interior walls at 12 Example Road, Sydney NSW 2000.'
    expect(shouldEngagePainting(null, message, false)).toBe(true)
    expect(advancePainting(null, message).action).toBe('offer_form')
    expect(shouldEngagePainting(null, message, false, true)).toBe(false)
    expect(shouldEngagePainting({ slots: {}, last_step: 'closed', declined_trades: ['painting'] }, message, false)).toBe(false)
  })
  it('offers the form on a fresh painting enquiry', () => {
    const d = advancePainting(null, 'I want to paint my house')
    expect(d.action).toBe('offer_form')
  })
  it('passes through a non-painting opener (route should not have called us)', () => {
    const d = advancePainting(null, 'I need 6 downlights')
    expect(d.action).toBe('passthrough')
  })
})

describe('advancePainting — replying to the form offer', () => {
  const offered: PaintingConversationState = { slots: {}, last_step: 'offer_form' }

  it('acknowledges + waits when the customer chooses the form', () => {
    const d = advancePainting(offered, 'send me the form link')
    expect(d.action).toBe('await_form')
    if (d.action === 'await_form') {
      expect(d.reply).toMatch(/painter to review before sending/)
      expect(d.reply).not.toMatch(/straight back|straight over|on.*way/)
    }
  })
  it('starts the questions when the customer declines the link', () => {
    const d = advancePainting(offered, 'just ask me here')
    expect(d).toMatchObject({ action: 'ask', step: 'address' })
  })
  it('captures an address volunteered with the decline (jumps to confirm)', () => {
    const d = advancePainting(offered, "nah it's 5 Smith St, Bondi NSW 2026")
    expect(d).toMatchObject({ action: 'ask', step: 'confirm_address' })
    if (d.action === 'ask') expect(d.reply).toMatch(/Smith St/)
  })
})

describe('advancePainting — switching from await_form to questions', () => {
  it('starts Q&A when a form-waiting customer texts back', () => {
    const d = advancePainting({ slots: {}, last_step: 'await_form' }, 'actually can we just do it here')
    expect(d).toMatchObject({ action: 'ask', step: 'address' })
  })
})

describe('advancePainting — stop is honoured first', () => {
  it('cancels from any step', () => {
    expect(advancePainting({ slots: {}, last_step: 'coats' }, 'stop').action).toBe('cancel')
    expect(advancePainting({ slots: {}, last_step: 'offer_form' }, 'not interested').action).toBe('cancel')
  })
})

describe('advancePainting — full Q&A path to an estimate', () => {
  it('gathers every field then asks the route to run the estimate', () => {
    const { decisions, finalState } = drive([
      'paint my house',
      'just ask me',
      '5 Smith St, Bondi NSW 2026',
      'yes',
      'walls and ceilings',
      '2 coats',
      'already painted',
      'standard',
      'single storey',
      'about 180', // the optional floor-area ask (form parity)
      'no',
    ])
    const steps = decisions.map((d) => d.action)
    expect(steps[0]).toBe('offer_form')
    expect(steps[steps.length - 1]).toBe('estimate')
    const last = decisions[decisions.length - 1]
    if (last.action === 'estimate') {
      const req = toPaintingRequest(last.slots)
      expect(req).not.toBeNull()
      expect(req!.inputs.scopes).toEqual(['walls', 'ceilings'])
      expect(req!.inputs.manual_floor_area_m2).toBe(180)
    }
    expect(finalState.last_step).toBe('quoted')
  })

  it('a skipped floor area ("not sure") still reaches the estimate, area from the lookup', () => {
    const d = advancePainting(
      {
        slots: {
          address: '1 A St', address_confirmed: true, postcode: '4000', state: 'QLD',
          scopes: ['walls'], coats: 2, condition: 'sound', ceiling_height: 'standard', storeys: 1,
        },
        last_step: 'floor_area',
      },
      'not sure',
    )
    expect(d).toMatchObject({ action: 'ask', step: 'colour_change' })
    expect(d.slots.manual_floor_area_m2).toBeNull()
  })
})

describe('advancePainting — inspection + booking', () => {
  it('routes a poor-condition job to inspection, then handles the booking reply', () => {
    const insp = advancePainting(
      {
        slots: { address: '1 A St', address_confirmed: true, postcode: '4000', state: 'QLD', scopes: ['walls'], coats: 2 },
        last_step: 'condition',
      },
      'the walls are flaking and peeling',
    )
    expect(insp).toMatchObject({ action: 'inspection', reason: expect.stringMatching(/flaking|damaged/i) })
    const parked = nextPaintingConversationState(insp)
    expect(parked.last_step).toBe('await_booking')

    expect(advancePainting(parked, 'yes please book it').action).toBe('booking')
    expect(advancePainting(parked, 'yes please book it')).toMatchObject({ action: 'booking', confirmed: true })
    expect(advancePainting(parked, 'no thanks')).toMatchObject({ action: 'booking', confirmed: false })
    // Same single-shot drop the roofing receptionist had (audit 2026-07-23):
    // a question or a proposed time is a LIVE LEAD, not a decline.
    expect(advancePainting(parked, 'what does it cost?')).toMatchObject({ action: 'booking', confirmed: true })
    expect(advancePainting(parked, 'Tuesday works for me')).toMatchObject({ action: 'booking', confirmed: true })
  })

  // Live 2026-08-05: "3" storeys routed to inspection, the customer corrected
  // to "Oh sorry its 1 storey only", and because that is not a decline it was
  // read as "yes, book it". The correction was discarded and a painter was
  // promised for a job that no longer needed a site visit.
  it('a correction that removes the inspection trigger does NOT book', () => {
    const parked = {
      slots: {
        address: '28 Greens Rd, Coorparoo QLD 4151',
        scopes: ['walls', 'ceilings'] as PaintScope[],
        coats: 3 as const,
        condition: 'sound' as const,
        ceiling_height: 'standard' as const,
        storeys: 3 as const,
      },
      last_step: 'await_booking' as const,
      pending_form_token: null,
      pending_quote_token: null,
    }
    // Sanity: an ordinary reply still books, so this test cannot pass vacuously.
    expect(advancePainting(parked, 'yes please')).toMatchObject({ action: 'booking', confirmed: true })

    const fixed = advancePainting(parked, 'Oh sorry its 1 storey only')
    expect(fixed.action).not.toBe('booking')
    expect(fixed.slots.storeys).toBe(1)
  })

  // The other inspection trigger. "poor" condition routes to inspection; the
  // customer correcting it to sound must reopen the quote, not book a visit.
  it('a condition correction also reopens instead of booking', () => {
    const parked = {
      slots: {
        address: '28 Greens Rd, Coorparoo QLD 4151',
        scopes: ['walls'] as PaintScope[],
        coats: 2 as const,
        condition: 'poor' as const,
      },
      last_step: 'await_booking' as const,
      pending_form_token: null,
      pending_quote_token: null,
    }
    const fixed = advancePainting(parked, 'sorry the condition is sound not poor')
    expect(fixed.action).not.toBe('booking')
    expect(fixed.slots.condition).toBe('sound')
  })
})

// Cross-step intent — the same adaptivity the roofing receptionist got
// (2026-07-24). Painting had NO miss concept: an unmatched mid-flow message
// was silently dropped and the next scripted question asked. A mid-flow
// address change / topic switch / interrupt / question must now be handled.
describe('advancePainting — cross-step intent (adaptive mid-flow)', () => {
  const onScopes: PaintingConversationState = {
    slots: { address: '1 Old St', address_confirmed: true, postcode: '4000', state: 'QLD', scopes: ['walls'] },
    last_step: 'scopes',
  }

  it('P-S1: folds a mid-flow address correction and re-confirms the NEW address', () => {
    const d = advancePainting(onScopes, 'actually change the address to 22 New Road Bondi NSW 2026')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') {
      expect(d.step).toBe('confirm_address')
      expect(d.slots.address).toMatch(/22 New Road/i)
      expect(d.slots.address_confirmed).toBe(false)
    }
  })

  it('P-S1b: a correction ON confirm_address keeps the NEW address, not a bare re-ask', () => {
    const onConfirm: PaintingConversationState = {
      slots: { address: '1 Wrong St', address_confirmed: false },
      last_step: 'confirm_address',
    }
    const d = advancePainting(onConfirm, "no it's 22 New Road Bondi")
    expect(d.action).toBe('ask')
    if (d.action === 'ask') {
      expect(d.step).toBe('confirm_address')
      expect(d.slots.address).toMatch(/22 New Road/i)
    }
  })

  it('P-S2: a topic switch bails to the general dialog', () => {
    const d = advancePainting(onScopes, "also can you fix a leaking tap while you're there")
    expect(d.action).toBe('passthrough')
  })

  it('P-S6: an interrupt ("wait, hold on") bails, not cancel', () => {
    const d = advancePainting(onScopes, 'wait, hold on a sec')
    expect(d.action).toBe('passthrough')
  })

  it('P-S7: a clarification question on a non-address step bails to the dialog', () => {
    const d = advancePainting(onScopes, 'what did you ask me again?')
    expect(d.action).toBe('passthrough')
  })

  it('regression: a normal scopes answer still lands and moves on', () => {
    const d = advancePainting(onScopes, 'walls and ceilings')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') expect(d.step).not.toBe('scopes')
  })

  // Stage-3 review defects (2026-07-24).
  // C — "as well" is idiomatic for enumerating surfaces, NOT a topic switch.
  it('C: "walls as well as ceilings" lands as scopes, does not bail', () => {
    const d = advancePainting(onScopes, 'walls as well as ceilings')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') expect(d.step).not.toBe('scopes')
  })
  // D — an address correction opening with an interrupt word must still fold.
  it('D: "wait, change the address to 22 New Rd Bondi" folds the address', () => {
    const onCoats: PaintingConversationState = {
      slots: { address: '1 Old St', address_confirmed: true, postcode: '4000', state: 'QLD', scopes: ['walls'] },
      last_step: 'coats',
    }
    const d = advancePainting(onCoats, 'wait, change the address to 22 New Road Bondi NSW 2026')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') {
      expect(d.step).toBe('confirm_address')
      expect(d.slots.address).toMatch(/22 New Road/i)
    }
  })
  // E — a question containing a scope keyword must bail, not commit.
  it('E: "which walls did you mean?" at scopes bails, does not commit scopes', () => {
    const d = advancePainting(onScopes, 'which walls did you mean?')
    expect(d.action).toBe('passthrough')
  })

  // F2 (reorder defect) — a scopes answer that restates the address must NOT
  // clobber the confirmed address; take the scopes.
  it('F2: "walls and ceilings at 22 New Rd" keeps the confirmed address', () => {
    const d = advancePainting(onScopes, 'walls and ceilings at 22 New Rd')
    expect(d.slots.address).toBe('1 Old St')
    expect(d.action).not.toBe('passthrough')
  })

  // F3 (reorder defect) — "also" is idiomatic scope enumeration; a landing
  // multi-surface answer must NOT bail.
  it('F3: "walls and ceilings, also the doors" lands as scopes, does not bail', () => {
    const d = advancePainting(onScopes, 'walls and ceilings, also the doors')
    expect(d.action).not.toBe('passthrough')
    expect(d.action).toBe('ask')
  })

  // B (round-3) — the colour_change parser sets its slot unconditionally, so
  // the post-parse "changedNothing" bail was dead there: an interrupt at the
  // final yes/no question committed colour_change=false and fired an estimate.
  const onColour: PaintingConversationState = {
    slots: {
      address: '1 A St', address_confirmed: true, postcode: '4000', state: 'QLD',
      scopes: ['walls'], coats: 2, condition: 'sound', ceiling_height: 'standard', storeys: 1,
      manual_floor_area_m2: null,
    },
    last_step: 'colour_change',
  }
  it('B: an interrupt at colour_change bails, does not commit false + estimate', () => {
    const d = advancePainting(onColour, 'wait, hold on a sec')
    expect(d.action).toBe('passthrough')
  })
  it('B: a topic switch at colour_change bails, does not fire the estimate', () => {
    const d = advancePainting(onColour, 'also can you paint the fence')
    expect(d.action).toBe('passthrough')
  })
  // A genuine yes/no at colour_change must still land and proceed (regression).
  it('B-regression: "yes same colour" at colour_change still lands', () => {
    const d = advancePainting(onColour, 'yes keep it the same')
    expect(d.action).not.toBe('passthrough')
  })
})

describe('advancePainting — re-asks on junk', () => {
  it('re-asks the address when the reply has no street number', () => {
    const d = advancePainting({ slots: {}, last_step: 'address' }, 'somewhere in town')
    expect(d).toMatchObject({ action: 'ask', step: 'address' })
    if (d.action === 'ask') expect(d.reply).toMatch(/didn't catch/i)
  })
})

describe('advancePainting — warm quoted thread', () => {
  const quoted: PaintingConversationState = { slots: {}, last_step: 'quoted' }
  it('hands an unrelated message back to the general dialog', () => {
    expect(advancePainting(quoted, 'how much for some downlights?').action).toBe('passthrough')
  })
  it('reopens (re-offers the form) on a fresh painting enquiry', () => {
    expect(advancePainting(quoted, 'can you also repaint the back deck?').action).toBe('offer_form')
  })
})

describe('customerWantsForm', () => {
  it('is true only on an explicit form cue', () => {
    expect(customerWantsForm('send me the form')).toBe(true)
    expect(customerWantsForm('the link please')).toBe(true)
    expect(customerWantsForm("i'll fill it out")).toBe(true)
  })
  it('is false on a decline, a bare yes, or empty', () => {
    expect(customerWantsForm('just ask me here')).toBe(false)
    expect(customerWantsForm('no thanks')).toBe(false)
    expect(customerWantsForm('yes')).toBe(false)
    expect(customerWantsForm('')).toBe(false)
  })
})

// R1/R2 (spec 2026-08-05): the route pre-empts the LLM receptionist on these
// turns so the opener always offers BOTH paths (form link + reply-here) and an
// explicit "use the form" reply always resolves to await_form.
describe('paintingTurnIsDeterministic', () => {
  it('true on the opener (no active painting flow), including closed/absent state', () => {
    expect(paintingTurnIsDeterministic(null, 'paint my house')).toBe(true)
    expect(paintingTurnIsDeterministic({ slots: {}, last_step: null }, 'paint my house')).toBe(true)
    expect(paintingTurnIsDeterministic({ slots: {}, last_step: 'closed' }, 'repaint the deck')).toBe(true)
  })
  it('true when the customer explicitly chooses the form after the offer', () => {
    const offered: PaintingConversationState = { slots: {}, last_step: 'offer_form' }
    expect(paintingTurnIsDeterministic(offered, 'send me the form')).toBe(true)
    expect(paintingTurnIsDeterministic(offered, 'the link please')).toBe(true)
  })
  it('false on a non-form reply to the offer (Q&A may run on either path)', () => {
    const offered: PaintingConversationState = { slots: {}, last_step: 'offer_form' }
    expect(paintingTurnIsDeterministic(offered, 'just ask me here')).toBe(false)
    expect(paintingTurnIsDeterministic(offered, "it's 5 Smith St, Bondi NSW 2026")).toBe(false)
  })
  it('false mid-gather and on warm threads (the flag decides the layer)', () => {
    expect(paintingTurnIsDeterministic({ slots: {}, last_step: 'scopes' }, '180 sqm')).toBe(false)
    expect(paintingTurnIsDeterministic({ slots: {}, last_step: 'quoted' }, 'thanks')).toBe(false)
    expect(paintingTurnIsDeterministic({ slots: {}, last_step: 'await_form' }, 'send me the form')).toBe(false)
  })
})

describe('isActivePaintingFlow', () => {
  it('is true mid-flow, false when empty or closed', () => {
    expect(isActivePaintingFlow(null)).toBe(false)
    expect(isActivePaintingFlow({ slots: {}, last_step: 'offer_form' })).toBe(true)
    expect(isActivePaintingFlow({ slots: {}, last_step: 'scopes' })).toBe(true)
    expect(isActivePaintingFlow({ slots: {}, last_step: 'closed' })).toBe(false)
    expect(isActivePaintingFlow({ slots: {}, last_step: null })).toBe(false)
  })
})

// Same idle-session incident as roofing (live 2026-07-24): a painting flow
// parked at await_form / quoted / await_booking and reused hours later must be
// treated as stale, not resumed. Mirrors expireIdleRoofingState.
describe('expireIdlePaintingState — a parked flow left idle is stale', () => {
  const HOUR = 60 * 60 * 1000
  // Only the warm 'quoted' thread re-serves on resume, so only it goes stale.
  it('closes the warm quoted thread idle beyond the threshold', () => {
    const expired = expireIdlePaintingState(
      { slots: { address: 'x' }, last_step: 'quoted', pending_form_token: 'f', pending_quote_token: 'q' },
      3 * HOUR,
    )
    expect(expired).not.toBeNull()
    expect(expired!.last_step).toBe('closed')
    expect(expired!.pending_form_token ?? null).toBeNull()
    expect(expired!.pending_quote_token ?? null).toBeNull()
  })
  // await_form (customer filling the self-serve form), await_booking (awaiting
  // "yes book it") and mid-gather must survive idle — a late reply still lands.
  it('does NOT expire await_form / await_booking / mid-gather', () => {
    for (const step of ['await_form', 'await_booking', 'scopes'] as const) {
      expect(
        expireIdlePaintingState({ slots: { address: 'x' }, last_step: step }, 3 * HOUR),
        step,
      ).toBeNull()
    }
  })
  it('leaves a still-fresh flow untouched, and nothing to do on closed/absent', () => {
    expect(expireIdlePaintingState({ slots: {}, last_step: 'quoted' }, 5 * 60 * 1000)).toBeNull()
    expect(expireIdlePaintingState(null, 10 * HOUR)).toBeNull()
    expect(expireIdlePaintingState({ slots: {}, last_step: 'closed' }, 10 * HOUR)).toBeNull()
  })
})

describe('nextPaintingConversationState', () => {
  it('maps each decision to the right parked step', () => {
    expect(nextPaintingConversationState({ action: 'offer_form', slots: {} }).last_step).toBe('offer_form')
    expect(nextPaintingConversationState({ action: 'await_form', slots: {}, reply: 'x' }).last_step).toBe('await_form')
    expect(nextPaintingConversationState({ action: 'ask', slots: {}, step: 'coats', reply: 'x' }).last_step).toBe('coats')
    expect(nextPaintingConversationState({ action: 'estimate', slots: {} }).last_step).toBe('quoted')
    expect(nextPaintingConversationState({ action: 'inspection', slots: {}, reason: 'x' }).last_step).toBe('await_booking')
    expect(nextPaintingConversationState({ action: 'cancel', slots: {} }).last_step).toBe('closed')
    expect(nextPaintingConversationState({ action: 'booking', slots: {}, confirmed: true }).last_step).toBe('closed')
  })
})

describe('shouldEngagePainting — follow-up pin guard (spec 2026-07-05 Part A2)', () => {
  // A mid-gather painting flow still parked on the thread (awaiting scopes).
  const activePainting: PaintingConversationState = { slots: {}, last_step: 'scopes' }
  const closedPainting: PaintingConversationState = { slots: {}, last_step: 'closed' }

  it('R-A3: stale active painting state + active pin + affirmative reply → does NOT engage (falls through to the general dialog)', () => {
    expect(shouldEngagePainting(activePainting, 'Yes', true)).toBe(false)
    expect(shouldEngagePainting(activePainting, 'yeah go for it', true)).toBe(false)
  })

  it('R-A4: active pin + a genuinely NEW painting enquiry → still engages', () => {
    expect(shouldEngagePainting(activePainting, 'I want the house painted', true)).toBe(true)
    expect(shouldEngagePainting(null, 'can you quote a repaint of the interior', true)).toBe(true)
  })

  it('no pin → behaviour is unchanged: active flow resumes, fresh enquiry engages, anything else passes through', () => {
    expect(shouldEngagePainting(activePainting, 'Yes', false)).toBe(true) // resume active flow
    expect(shouldEngagePainting(null, 'I want the house painted', false)).toBe(true) // fresh enquiry
    expect(shouldEngagePainting(null, 'Yes', false)).toBe(false) // neither
    expect(shouldEngagePainting(closedPainting, 'Yes', false)).toBe(false) // closed flow
  })
})
