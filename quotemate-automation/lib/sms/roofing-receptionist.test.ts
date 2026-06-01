// SMS roofing receptionist — per-turn decision tests: gathering, the
// "is this your roof?" confirm gate, structure picking, stop/cancel,
// inspection booking, closed-flow reopen, and address validation.

import { describe, expect, it } from 'vitest'
import {
  advanceRoofing,
  isActiveRoofingFlow,
  nextRoofingConversationState,
  parseStructureChoice,
  type RoofingConversationState,
} from './roofing-receptionist'

/** Simulate the route loop up to the first non-ask outcome. */
function runConversation(messages: string[]) {
  let state: RoofingConversationState | null = null
  const decisions = []
  for (const m of messages) {
    const decision = advanceRoofing(state, m)
    decisions.push(decision)
    state = nextRoofingConversationState(decision)
    if (decision.action !== 'ask') break
  }
  return { decisions, state }
}

describe('advanceRoofing — gather then measure', () => {
  it('gathers all inputs across turns then signals measure', () => {
    const { decisions } = runConversation([
      'Hi, I need a re-roof quote',
      '670 London Rd, Chandler QLD 4155',
      'yes',
      'full re-roof',
      'colorbond',
      'standard',
    ])
    const steps = decisions.map((d) => (d.action === 'ask' ? d.step : d.action))
    expect(steps[0]).toBe('address')
    expect(steps).toContain('confirm_address')
    expect(steps).toContain('material')
    expect(steps).toContain('pitch')
    expect(steps[steps.length - 1]).toBe('measure')
  })

  it('opener gleans intent so it is not asked again', () => {
    const d = advanceRoofing(null, 'my roof is leaking badly')
    expect(d.slots.intent).toBe('leak_trace')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') expect(d.step).toBe('address')
  })
})

describe('advanceRoofing — inspection fallback', () => {
  it('routes fibro/asbestos to inspection', () => {
    const { decisions } = runConversation([
      'need a roof repair quote',
      '12 Smith St, Bondi NSW 2026',
      'yes',
      'repair a few spots',
      'fibro',
    ])
    const last = decisions[decisions.length - 1]
    expect(last.action).toBe('inspection')
    if (last.action === 'inspection') expect(last.reason).toMatch(/asbestos/i)
  })
})

describe('parseStructureChoice', () => {
  it('reads a bare number, #n, "number n", and ordinals within range', () => {
    expect(parseStructureChoice('2', 3)).toBe(2)
    expect(parseStructureChoice('#1', 3)).toBe(1)
    expect(parseStructureChoice('number 3', 3)).toBe(3)
    expect(parseStructureChoice('the second one', 3)).toBe(2)
  })
  it('returns null out of range or when no number', () => {
    expect(parseStructureChoice('5', 2)).toBeNull()
    expect(parseStructureChoice('yes please', 2)).toBeNull()
  })
})

describe('advanceRoofing — confirm_roof gate', () => {
  const measured: RoofingConversationState = {
    slots: { address: '1 A St', address_confirmed: true, intent: 'full_reroof', material: 'colorbond_trimdek', pitch: 'standard' },
    last_step: 'confirm_roof',
    pending_quote_token: 'tok123',
    pending_structure_count: 2,
  }

  it('YES → send_saved (all structures)', () => {
    const d = advanceRoofing(measured, 'yes thats my roof')
    expect(d.action).toBe('send_saved')
    if (d.action === 'send_saved') expect(d.structureChoice).toBeNull()
  })
  it('a number → send_saved for that structure', () => {
    const d = advanceRoofing(measured, '2')
    expect(d.action).toBe('send_saved')
    if (d.action === 'send_saved') expect(d.structureChoice).toBe(2)
  })
  it('NO → re-ask the address and reset it', () => {
    const d = advanceRoofing(measured, 'no thats the wrong building')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') {
      expect(d.step).toBe('address')
      expect(d.slots.address).toBeNull()
    }
  })
  it('unclear reply → reconfirm', () => {
    const d = advanceRoofing(measured, 'hmm maybe')
    expect(d.action).toBe('reconfirm')
  })
})

describe('advanceRoofing — stop / cancel / booking / closed', () => {
  const midFlow: RoofingConversationState = {
    slots: { address: '1 A St', address_confirmed: true, intent: 'full_reroof' },
    last_step: 'material',
  }

  it('a stop/cancel request at any step → cancel', () => {
    expect(advanceRoofing(midFlow, 'STOP PLEASE').action).toBe('cancel')
    expect(advanceRoofing(null, "let's cancel now and stop this session").action).toBe('cancel')
    expect(advanceRoofing(null, 'FUCK NO!').action).toBe('cancel')
    expect(advanceRoofing(midFlow, 'not interested anymore').action).toBe('cancel')
  })

  it('bare "no" is NOT a stop — it answers the confirm', () => {
    const confirm: RoofingConversationState = { slots: { address: '1 A St', address_confirmed: true, intent: 'full_reroof', material: 'colorbond_trimdek', pitch: 'standard' }, last_step: 'confirm_roof', pending_structure_count: 1 }
    expect(advanceRoofing(confirm, 'no').action).toBe('ask') // wrong building → re-ask
  })

  it('await_booking: yes → booking confirmed; otherwise not confirmed', () => {
    const base: RoofingConversationState = { slots: {}, last_step: 'await_booking' }
    const yes = advanceRoofing(base, 'yes please book it')
    expect(yes.action).toBe('booking')
    if (yes.action === 'booking') expect(yes.confirmed).toBe(true)
    const no = advanceRoofing(base, 'not right now')
    expect(no.action).toBe('booking')
    if (no.action === 'booking') expect(no.confirmed).toBe(false)
  })

  it('a closed flow re-opens only on a fresh enquiry and resets slots', () => {
    const closed: RoofingConversationState = { slots: { address: 'old place', intent: 'full_reroof' }, last_step: 'closed' }
    const d = advanceRoofing(closed, 'I need a re-roof quote')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') {
      expect(d.step).toBe('address')
      expect(d.slots.address).toBeFalsy() // old slots wiped
    }
  })
})

describe('advanceRoofing — address validation', () => {
  it('rejects a non-address reply (no street number) and re-asks clearly', () => {
    const d = advanceRoofing({ slots: {}, last_step: 'address' }, 'somewhere in town thanks')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') {
      expect(d.step).toBe('address')
      expect(d.reply).toMatch(/didn't catch/i)
      expect(d.slots.address).toBeFalsy()
    }
  })
  it('accepts a real address with a street number', () => {
    const d = advanceRoofing({ slots: {}, last_step: 'address' }, '5 Smith St, Bondi NSW 2026')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') expect(d.step).toBe('confirm_address')
  })
})

describe('isActiveRoofingFlow', () => {
  it('true mid-gather/awaiting, false when closed or empty', () => {
    expect(isActiveRoofingFlow({ slots: {}, last_step: 'material' })).toBe(true)
    expect(isActiveRoofingFlow({ slots: {}, last_step: 'confirm_roof' })).toBe(true)
    expect(isActiveRoofingFlow({ slots: {}, last_step: 'await_booking' })).toBe(true)
    expect(isActiveRoofingFlow({ slots: {}, last_step: 'closed' })).toBe(false)
    expect(isActiveRoofingFlow({ slots: {}, last_step: null })).toBe(false)
    expect(isActiveRoofingFlow(null)).toBe(false)
  })
})

describe('nextRoofingConversationState', () => {
  it('parks each action at the right step', () => {
    const ask = advanceRoofing(null, 'hello')
    expect(nextRoofingConversationState(ask).last_step).toBe('address')
    expect(nextRoofingConversationState({ action: 'measure', slots: {} }).last_step).toBe('confirm_roof')
    expect(nextRoofingConversationState({ action: 'inspection', slots: {}, reason: 'x' }).last_step).toBe('await_booking')
    expect(nextRoofingConversationState({ action: 'send_saved', slots: {}, structureChoice: null }).last_step).toBe('closed')
    expect(nextRoofingConversationState({ action: 'cancel', slots: {} }).last_step).toBe('closed')
    expect(nextRoofingConversationState({ action: 'booking', slots: {}, confirmed: true }).last_step).toBe('closed')
  })
})
