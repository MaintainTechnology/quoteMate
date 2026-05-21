import { describe, it, expect } from 'vitest'
import {
  parseServicesCsv,
  validateServicesRow,
  serviceKey,
  SERVICES_CSV_COLUMNS,
  SERVICES_CSV_MAX_ROWS,
  type ServicesRowContext,
} from './services-csv'

const HEADER = SERVICES_CSV_COLUMNS.join(',')
// trade,name,description,unit,service_fee_ex_gst,labour_hours,exclusions,
// category,cq1,cq2,cq3,cq4,cq5,default_enabled
const GOOD_ROW =
  'electrical,Install downlight,Swap a downlight,each,35,1.5,none,downlight,,,,,,false'

describe('parseServicesCsv — structural validation', () => {
  it('accepts a well-formed file', () => {
    const res = parseServicesCsv(`${HEADER}\n${GOOD_ROW}\n`)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.records).toHaveLength(1)
      expect(res.records[0].name).toBe('Install downlight')
    }
  })

  it('rejects a missing column whole-file', () => {
    const badHeader = SERVICES_CSV_COLUMNS.filter((c) => c !== 'category').join(
      ',',
    )
    const res = parseServicesCsv(`${badHeader}\nelectrical,X`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/Missing required column.*category/)
  })

  it('rejects an unexpected column', () => {
    const res = parseServicesCsv(`${HEADER},surprise\n${GOOD_ROW},x`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/Unexpected column.*surprise/)
  })

  it('rejects a header with no data rows', () => {
    const res = parseServicesCsv(`${HEADER}\n`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/no data rows/)
  })

  it('rejects a blank row', () => {
    const blank = ','.repeat(SERVICES_CSV_COLUMNS.length - 1)
    const res = parseServicesCsv(`${HEADER}\n${GOOD_ROW}\n${blank}\n`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/blank row/)
  })

  it('rejects a row with the wrong column count', () => {
    const res = parseServicesCsv(`${HEADER}\nelectrical,Only two`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/columns, expected/)
  })

  it('rejects a file over the row cap', () => {
    const rows = Array.from(
      { length: SERVICES_CSV_MAX_ROWS + 1 },
      (_, i) =>
        `electrical,Svc ${i},d,each,35,1,none,downlight,,,,,,false`,
    ).join('\n')
    const res = parseServicesCsv(`${HEADER}\n${rows}`)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/Too many rows/)
  })

  it('tolerates a trailing newline (not a blank row)', () => {
    const res = parseServicesCsv(`${HEADER}\n${GOOD_ROW}\n\n`)
    expect(res.ok).toBe(true)
  })
})

// ── Row validation ────────────────────────────────────────────────────

function rec(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    trade: 'electrical',
    name: 'Install downlight',
    description: 'Swap a downlight',
    unit: 'each',
    service_fee_ex_gst: '35',
    labour_hours: '1.5',
    exclusions: 'none',
    category: 'downlight',
    clarifying_question_1: '',
    clarifying_question_2: '',
    clarifying_question_3: '',
    clarifying_question_4: '',
    clarifying_question_5: '',
    default_enabled: 'false',
    ...over,
  }
}

function ctx(over: Partial<ServicesRowContext> = {}): ServicesRowContext {
  return {
    knownTrades: new Set(['electrical', 'plumbing']),
    knownCategories: new Set(['downlight', 'hot_water']),
    existingServiceKeys: new Set<string>(),
    tradeHasLiveTenants: () => false,
    ...over,
  }
}

describe('validateServicesRow — accepts', () => {
  it('classifies an unknown (trade,name) as NEW', () => {
    const r = validateServicesRow(rec(), ctx(), new Set())
    expect(r.rowClass).toBe('NEW')
    if (r.rowClass !== 'REJECT') {
      expect(r.parsed.default_unit_price_ex_gst).toBe(35)
      expect(r.parsed.default_labour_hours).toBe(1.5)
    }
  })

  it('classifies an existing (trade,name) as UPDATE', () => {
    const existing = new Set([serviceKey('electrical', 'Install downlight')])
    const r = validateServicesRow(
      rec(),
      ctx({ existingServiceKeys: existing }),
      new Set(),
    )
    expect(r.rowClass).toBe('UPDATE')
  })

  it('assembles clarifying questions, dropping blanks', () => {
    const r = validateServicesRow(
      rec({ clarifying_question_1: 'How many?', clarifying_question_3: 'Ceiling type?' }),
      ctx(),
      new Set(),
    )
    if (r.rowClass !== 'REJECT') {
      expect(r.parsed.clarifying_questions).toEqual(['How many?', 'Ceiling type?'])
    }
  })

  it('accepts a category declared only in this batch', () => {
    const r = validateServicesRow(
      rec({ category: 'brand_new_cat' }),
      ctx({ batchCategories: new Set(['brand_new_cat']) }),
      new Set(),
    )
    expect(r.rowClass).not.toBe('REJECT')
  })
})

describe('validateServicesRow — rejects', () => {
  it('an unregistered trade', () => {
    const r = validateServicesRow(rec({ trade: 'carpentry' }), ctx(), new Set())
    expect(r.rowClass).toBe('REJECT')
    if (r.rowClass === 'REJECT') expect(r.errors.join(' ')).toMatch(/not a registered trade/)
  })

  it('an unknown category', () => {
    const r = validateServicesRow(rec({ category: 'nope' }), ctx(), new Set())
    expect(r.rowClass).toBe('REJECT')
    if (r.rowClass === 'REJECT') expect(r.errors.join(' ')).toMatch(/not a known category/)
  })

  it('a zero or negative service fee', () => {
    expect(validateServicesRow(rec({ service_fee_ex_gst: '0' }), ctx(), new Set()).rowClass).toBe('REJECT')
    expect(validateServicesRow(rec({ service_fee_ex_gst: '-10' }), ctx(), new Set()).rowClass).toBe('REJECT')
  })

  it('a blank required numeric', () => {
    expect(validateServicesRow(rec({ service_fee_ex_gst: '' }), ctx(), new Set()).rowClass).toBe('REJECT')
    expect(validateServicesRow(rec({ labour_hours: '' }), ctx(), new Set()).rowClass).toBe('REJECT')
  })

  it('a negative labour_hours', () => {
    expect(validateServicesRow(rec({ labour_hours: '-1' }), ctx(), new Set()).rowClass).toBe('REJECT')
  })

  it('an invalid unit', () => {
    const r = validateServicesRow(rec({ unit: 'box' }), ctx(), new Set())
    expect(r.rowClass).toBe('REJECT')
    if (r.rowClass === 'REJECT') expect(r.errors.join(' ')).toMatch(/unit must be/)
  })

  it('a duplicate (trade,name) within the same batch', () => {
    const seen = new Set<string>()
    const first = validateServicesRow(rec(), ctx(), seen)
    expect(first.rowClass).not.toBe('REJECT')
    const second = validateServicesRow(rec(), ctx(), seen)
    expect(second.rowClass).toBe('REJECT')
    if (second.rowClass === 'REJECT') expect(second.errors.join(' ')).toMatch(/duplicate/)
  })
})

describe('validateServicesRow — §9 rule 3 opt-in by default', () => {
  it('forces default_enabled false for a trade with live tenants', () => {
    const r = validateServicesRow(
      rec({ default_enabled: 'true' }),
      ctx({ tradeHasLiveTenants: () => true }),
      new Set(),
    )
    if (r.rowClass !== 'REJECT') {
      expect(r.parsed.default_enabled).toBe(false)
      expect(r.forcedDisabled).toBe(true)
    }
  })

  it('honours default_enabled for a trade with no live tenants', () => {
    const r = validateServicesRow(
      rec({ default_enabled: 'true' }),
      ctx({ tradeHasLiveTenants: () => false }),
      new Set(),
    )
    if (r.rowClass !== 'REJECT') {
      expect(r.parsed.default_enabled).toBe(true)
      expect(r.forcedDisabled).toBe(false)
    }
  })
})
