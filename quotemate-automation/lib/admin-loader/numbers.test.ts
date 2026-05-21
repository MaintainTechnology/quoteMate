import { describe, it, expect } from 'vitest'
import { parseCsvNumber, parseCsvBoolean } from './numbers'

describe('parseCsvNumber', () => {
  it('strips a currency symbol and thousand separators', () => {
    expect(parseCsvNumber('$1,050.00')).toEqual({ ok: true, value: 1050 })
    expect(parseCsvNumber('1,200')).toEqual({ ok: true, value: 1200 })
    expect(parseCsvNumber('$99')).toEqual({ ok: true, value: 99 })
  })

  it('parses plain integers and decimals', () => {
    expect(parseCsvNumber('12')).toEqual({ ok: true, value: 12 })
    expect(parseCsvNumber('1.5')).toEqual({ ok: true, value: 1.5 })
    expect(parseCsvNumber('0')).toEqual({ ok: true, value: 0 })
  })

  it('treats a blank cell as null', () => {
    expect(parseCsvNumber('')).toEqual({ ok: true, value: null })
    expect(parseCsvNumber('   ')).toEqual({ ok: true, value: null })
    expect(parseCsvNumber(null)).toEqual({ ok: true, value: null })
    expect(parseCsvNumber(undefined)).toEqual({ ok: true, value: null })
  })

  it('rejects non-numeric and malformed values', () => {
    expect(parseCsvNumber('abc').ok).toBe(false)
    expect(parseCsvNumber('1.2.3').ok).toBe(false)
    expect(parseCsvNumber('12px').ok).toBe(false)
    expect(parseCsvNumber('1 050').ok).toBe(false)
  })

  it('accepts a negative (range checks belong to the row validator)', () => {
    expect(parseCsvNumber('-5')).toEqual({ ok: true, value: -5 })
  })
})

describe('parseCsvBoolean', () => {
  it('accepts the common truthy spellings', () => {
    for (const t of ['true', 'TRUE', 'Yes', 'y', '1']) {
      expect(parseCsvBoolean(t)).toEqual({ ok: true, value: true })
    }
  })

  it('accepts the common falsy spellings and treats blank as false', () => {
    for (const f of ['false', 'No', 'n', '0', '']) {
      expect(parseCsvBoolean(f)).toEqual({ ok: true, value: false })
    }
  })

  it('rejects an unrecognised value rather than guessing', () => {
    expect(parseCsvBoolean('maybe').ok).toBe(false)
    expect(parseCsvBoolean('on').ok).toBe(false)
  })
})
