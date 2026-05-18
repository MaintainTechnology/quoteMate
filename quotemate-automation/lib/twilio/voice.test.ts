import { describe, expect, it } from 'vitest'
import { signBridge, verifyBridge, buildBridgeTwiml } from './voice'

const SECRET = 'test-secret-token'
const CUST = '+61480808517'
const CID = '+61482025950'

describe('signBridge / verifyBridge', () => {
  it('round-trips a valid signature', () => {
    const sig = signBridge(CUST, CID, SECRET)
    expect(verifyBridge(CUST, CID, sig, SECRET)).toBe(true)
  })

  it('rejects a tampered customer number (anti-toll-fraud)', () => {
    const sig = signBridge(CUST, CID, SECRET)
    expect(verifyBridge('+61400000000', CID, sig, SECRET)).toBe(false)
  })

  it('rejects a tampered caller ID', () => {
    const sig = signBridge(CUST, CID, SECRET)
    expect(verifyBridge(CUST, '+61499999999', sig, SECRET)).toBe(false)
  })

  it('rejects a wrong/empty signature without throwing', () => {
    expect(verifyBridge(CUST, CID, 'deadbeef', SECRET)).toBe(false)
    expect(verifyBridge(CUST, CID, null, SECRET)).toBe(false)
    expect(verifyBridge(CUST, CID, '', SECRET)).toBe(false)
  })

  it('rejects a signature made with a different secret', () => {
    const sig = signBridge(CUST, CID, 'other-secret')
    expect(verifyBridge(CUST, CID, sig, SECRET)).toBe(false)
  })
})

describe('buildBridgeTwiml', () => {
  it('dials the customer with the tenant caller ID and answerOnBridge', () => {
    const xml = buildBridgeTwiml({ customerE164: CUST, callerIdE164: CID })
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain(`callerId="${CID}"`)
    expect(xml).toContain('answerOnBridge="true"')
    expect(xml).toContain(`<Number>${CUST}</Number>`)
  })
})
