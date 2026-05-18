import { describe, expect, it } from 'vitest'
import { friendlyTwilioError, friendlyCallError } from './twilio-error'

describe('friendlyTwilioError', () => {
  it('explains an opt-out (STOP) clearly and steers to calling', () => {
    const m = friendlyTwilioError('21610')
    expect(m).toMatch(/opted out/i)
    expect(m).toMatch(/call/i)
  })

  it('flags an unreachable / non-mobile number', () => {
    for (const code of ['21211', '21214', '21614', '21408']) {
      expect(friendlyTwilioError(code)).toMatch(/Australian mobile/i)
    }
  })

  it('explains a missing sender number', () => {
    expect(friendlyTwilioError('NO_FROM')).toMatch(/no SMS number/i)
  })

  it('treats 5xx as transient retry', () => {
    expect(friendlyTwilioError('503')).toMatch(/try again/i)
  })

  it('falls back to the raw reason when the code is unknown', () => {
    expect(friendlyTwilioError('99999', 'weird carrier thing')).toContain(
      'weird carrier thing',
    )
    expect(friendlyTwilioError(null)).toMatch(/couldn't send/i)
  })
})

describe('friendlyCallError', () => {
  it('explains no provisioned voice number', () => {
    expect(friendlyCallError('NO_VOICE_NUMBER')).toMatch(/no phone number/i)
  })
  it('explains no tradie mobile on file', () => {
    expect(friendlyCallError('NO_TRADIE_NUMBER')).toMatch(/no mobile on file/i)
  })
  it('falls back gracefully on unknown codes', () => {
    expect(friendlyCallError(null)).toMatch(/couldn't start the call/i)
  })
})
