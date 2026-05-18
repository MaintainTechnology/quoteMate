import { describe, expect, it } from 'vitest'
import { normaliseAuMobile, isValidAuMobile, formatAuLocal } from './au'

describe('normaliseAuMobile', () => {
  it('accepts the common AU mobile formats and returns E.164', () => {
    for (const input of [
      '0480808517',
      '+61480808517',
      '61480808517',
      '0480 808 517',
      '+61 480 808 517',
      '(0480) 808-517',
      '480808517',
    ]) {
      expect(normaliseAuMobile(input)).toBe('+61480808517')
    }
  })

  it('rejects non-mobile / non-AU / junk', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      '0298765432', // Sydney landline (02)
      '+61298765432', // landline E.164
      '+14155238886', // US number
      '12345', // too short
      'not a phone',
      '+6148080851', // one digit short
      '+614808085177', // one digit long
    ]) {
      expect(normaliseAuMobile(bad)).toBeNull()
    }
  })

  it('is idempotent on already-normalised input', () => {
    expect(normaliseAuMobile('+61480808517')).toBe('+61480808517')
  })
})

describe('isValidAuMobile', () => {
  it('mirrors normaliseAuMobile success/failure', () => {
    expect(isValidAuMobile('0480808517')).toBe(true)
    expect(isValidAuMobile('+61298765432')).toBe(false)
    expect(isValidAuMobile(null)).toBe(false)
  })
})

describe('formatAuLocal', () => {
  it('formats a valid mobile for display', () => {
    expect(formatAuLocal('+61480808517')).toBe('0480 808 517')
    expect(formatAuLocal('0480808517')).toBe('0480 808 517')
  })
  it('returns null for invalid input', () => {
    expect(formatAuLocal('+61298765432')).toBeNull()
    expect(formatAuLocal('')).toBeNull()
  })
})
