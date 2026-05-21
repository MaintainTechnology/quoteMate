import { describe, it, expect } from 'vitest'
import {
  parseMaterialsCsv,
  validateMaterialsRow,
  MATERIALS_CSV_COLUMNS,
  type MaterialsRowContext,
} from './materials-csv'
import { tradeNameKey } from './csv'

const HEADER = MATERIALS_CSV_COLUMNS.join(',') // trade,name,brand,unit,price_ex_gst

describe('parseMaterialsCsv — structural validation', () => {
  it('accepts a well-formed file', () => {
    const res = parseMaterialsCsv(
      `${HEADER}\nplumbing,Electric HWS 250L,Rheem,each,$750.00\n`,
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.records).toHaveLength(1)
      expect(res.records[0].brand).toBe('Rheem')
    }
  })

  it('rejects a header missing a column', () => {
    const res = parseMaterialsCsv('trade,name,brand,unit\nplumbing,X,Y,each')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/Missing required column.*price_ex_gst/)
  })

  it('rejects a header with no data rows', () => {
    const res = parseMaterialsCsv(`${HEADER}\n`)
    expect(res.ok).toBe(false)
  })
})

function rec(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    trade: 'plumbing',
    name: 'Electric HWS 250L',
    brand: 'Rheem',
    unit: 'each',
    price_ex_gst: '750',
    ...over,
  }
}

function ctx(over: Partial<MaterialsRowContext> = {}): MaterialsRowContext {
  return {
    knownTrades: new Set(['electrical', 'plumbing']),
    existingMaterialKeys: new Set<string>(),
    ...over,
  }
}

describe('validateMaterialsRow — accepts', () => {
  it('classifies an unknown (trade,name) as NEW and parses the price', () => {
    const r = validateMaterialsRow(rec({ price_ex_gst: '$1,050.00' }), ctx(), new Set())
    expect(r.rowClass).toBe('NEW')
    if (r.rowClass !== 'REJECT') {
      expect(r.parsed.default_unit_price_ex_gst).toBe(1050)
      expect(r.parsed.brand).toBe('Rheem')
    }
  })

  it('classifies an existing (trade,name) as UPDATE', () => {
    const existing = new Set([tradeNameKey('plumbing', 'Electric HWS 250L')])
    const r = validateMaterialsRow(rec(), ctx({ existingMaterialKeys: existing }), new Set())
    expect(r.rowClass).toBe('UPDATE')
  })

  it('treats a blank brand as null', () => {
    const r = validateMaterialsRow(rec({ brand: '' }), ctx(), new Set())
    if (r.rowClass !== 'REJECT') expect(r.parsed.brand).toBeNull()
  })
})

describe('validateMaterialsRow — rejects', () => {
  it('an unregistered trade', () => {
    expect(validateMaterialsRow(rec({ trade: 'carpentry' }), ctx(), new Set()).rowClass).toBe('REJECT')
  })

  it('a missing name', () => {
    expect(validateMaterialsRow(rec({ name: '' }), ctx(), new Set()).rowClass).toBe('REJECT')
  })

  it('a missing unit', () => {
    expect(validateMaterialsRow(rec({ unit: '' }), ctx(), new Set()).rowClass).toBe('REJECT')
  })

  it('a zero, negative, blank or non-numeric price', () => {
    for (const p of ['0', '-5', '', 'abc']) {
      expect(validateMaterialsRow(rec({ price_ex_gst: p }), ctx(), new Set()).rowClass).toBe('REJECT')
    }
  })

  it('a duplicate (trade,name) within the same batch', () => {
    const seen = new Set<string>()
    expect(validateMaterialsRow(rec(), ctx(), seen).rowClass).not.toBe('REJECT')
    const second = validateMaterialsRow(rec(), ctx(), seen)
    expect(second.rowClass).toBe('REJECT')
    if (second.rowClass === 'REJECT') expect(second.errors.join(' ')).toMatch(/duplicate/)
  })
})
