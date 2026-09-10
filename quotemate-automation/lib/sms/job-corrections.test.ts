import { describe, expect, it } from 'vitest'
import { isExplicitJobCorrection } from './job-corrections'

describe('explicit saved-job correction recognition', () => {
  it.each([
    'Actually make it 4 power points instead of 2.',
    'I need 4 downlights instead of 2.',
    'Please change the address to 12 Jones Street NSW 2000.',
    'The address is 12 Jones Street NSW2000',
    'The postcode is3000',
    'It is three phase',
    'Actually it is three phase, premium panels.',
    'Please change to premium panels instead.',
    'Actually include ceilings too.',
    'Change the painting scope to walls and ceilings.',
    'Send the quote link again, and actually make it 4 power points.',
    'No, 12 Smith Street, Bondi NSW 2026.',
    'Please remove the garage from the scope.',
    'Add two taps to the scope please.',
  ])('recognises the supported explicit replacement: %s', text => expect(isExplicitJobCorrection(text)).toBe(true))
  it.each([
    'Correction: my first name is Alex, not Sam.',
    'Actually my surname is Jones.',
    'Where is my quote?',
    'Send the quote link again.',
    'How much would it cost to add ceilings?',
    'Does that quote include the gutters?',
    'Is three phase more expensive?',
    'What is the address on my quote?',
    'Can you quote another property at 12 Jones Street?',
    'Please start a new quote for four downlights.',
    'I have another job, please add two taps.',
    'Thanks, that is correct.',
    'Yes, the address is correct.',
    'Premium panels',
    'Not sure yet',
  ])('leaves a profile/status/question/new-job or ambiguous reply to its existing flow: %s', text => expect(isExplicitJobCorrection(text)).toBe(false))
})
