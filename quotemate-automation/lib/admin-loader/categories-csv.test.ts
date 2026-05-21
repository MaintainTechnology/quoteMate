import { describe, it, expect } from 'vitest'
import {
  parseCategoriesCsv,
  validateCategoriesRow,
  CATEGORIES_CSV_COLUMNS,
  type CategoriesRowContext,
} from './categories-csv'
import { tradeNameKey } from './csv'

const HEADER = CATEGORIES_CSV_COLUMNS.join(',') // trade,name,grounding_tag

describe('parseCategoriesCsv — structural validation', () => {
  it('accepts a well-formed file', () => {
    const res = parseCategoriesCsv(`${HEADER}\ncarpentry,decking,general\n`)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.records).toHaveLength(1)
      expect(res.records[0].name).toBe('decking')
    }
  })

  it('rejects a header missing a column', () => {
    const res = parseCategoriesCsv('trade,name\ncarpentry,decking')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors.join(' ')).toMatch(/Missing required column.*grounding_tag/)
    }
  })

  it('rejects a header with no data rows', () => {
    const res = parseCategoriesCsv(`${HEADER}\n`)
    expect(res.ok).toBe(false)
  })
})

function rec(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    trade: 'carpentry',
    name: 'decking',
    grounding_tag: 'general',
    ...over,
  }
}

function ctx(over: Partial<CategoriesRowContext> = {}): CategoriesRowContext {
  return {
    knownTrades: new Set(['electrical', 'plumbing', 'carpentry']),
    existingCategoryKeys: new Set<string>(),
    ...over,
  }
}

describe('validateCategoriesRow — accepts', () => {
  it('classifies an unknown (trade,name) as NEW', () => {
    const r = validateCategoriesRow(rec(), ctx(), new Set())
    expect(r.rowClass).toBe('NEW')
    if (r.rowClass !== 'REJECT') {
      expect(r.parsed.grounding_tag).toBe('general')
    }
  })

  it('classifies an existing (trade,name) as UPDATE', () => {
    const existing = new Set([tradeNameKey('carpentry', 'decking')])
    const r = validateCategoriesRow(
      rec(),
      ctx({ existingCategoryKeys: existing }),
      new Set(),
    )
    expect(r.rowClass).toBe('UPDATE')
  })
})

describe('validateCategoriesRow — rejects', () => {
  it('an unregistered trade', () => {
    const r = validateCategoriesRow(rec({ trade: 'wizardry' }), ctx(), new Set())
    expect(r.rowClass).toBe('REJECT')
    if (r.rowClass === 'REJECT') {
      expect(r.errors.join(' ')).toMatch(/not a registered trade/)
    }
  })

  it('a missing name', () => {
    expect(validateCategoriesRow(rec({ name: '' }), ctx(), new Set()).rowClass).toBe('REJECT')
  })

  it('a missing grounding_tag', () => {
    const r = validateCategoriesRow(rec({ grounding_tag: '' }), ctx(), new Set())
    expect(r.rowClass).toBe('REJECT')
    if (r.rowClass === 'REJECT') {
      expect(r.errors.join(' ')).toMatch(/grounding_tag is required/)
    }
  })

  it('a duplicate (trade,name) within the same batch', () => {
    const seen = new Set<string>()
    expect(validateCategoriesRow(rec(), ctx(), seen).rowClass).not.toBe('REJECT')
    const second = validateCategoriesRow(rec(), ctx(), seen)
    expect(second.rowClass).toBe('REJECT')
    if (second.rowClass === 'REJECT') {
      expect(second.errors.join(' ')).toMatch(/duplicate/)
    }
  })
})
