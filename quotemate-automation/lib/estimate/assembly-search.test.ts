import { describe, it, expect } from 'vitest'
import { expandAssemblyQuery, buildAssemblyOrFilter } from './assembly-search'

describe('expandAssemblyQuery', () => {
  it('THE BUG FIX: a "power point" query expands to include "gpo"', () => {
    // The intake job_type is `power_points`; the assembly is named
    // "Replace double GPO". Without synonym expansion the substring
    // search misses it and the estimator flags a bogus inspection.
    const terms = expandAssemblyQuery('replace 2 existing power points in bedroom')
    expect(terms).toContain('gpo')
    expect(terms).toContain('power point')
  })

  it('is bidirectional — a "GPO" query also expands to "power point"', () => {
    const terms = expandAssemblyQuery('replace double GPO')
    expect(terms).toContain('gpo')
    expect(terms).toContain('power point')
  })

  it('keeps the full phrase so exact matches still work', () => {
    const terms = expandAssemblyQuery('install outdoor IP-rated GPO')
    expect(terms).toContain('install outdoor ip-rated gpo')
  })

  it('keeps significant tokens but drops generic verbs/filler', () => {
    const terms = expandAssemblyQuery('install new smoke alarm')
    expect(terms).toContain('smoke')
    expect(terms).toContain('alarm')
    expect(terms).not.toContain('install')
    expect(terms).not.toContain('new')
  })

  it('expands other trade-vs-customer synonym classes', () => {
    expect(expandAssemblyQuery('fix my hot water')).toContain('hws')
    expect(expandAssemblyQuery('downlight install')).toContain('down light')
    expect(expandAssemblyQuery('ceiling fan')).toContain('exhaust fan')
  })

  it('handles an empty / whitespace query without throwing', () => {
    expect(expandAssemblyQuery('')).toEqual([])
    expect(expandAssemblyQuery('   ')).toEqual([])
  })

  it('strips PostgREST-breaking characters from the full phrase', () => {
    const terms = expandAssemblyQuery('replace GPO (double), kitchen')
    expect(terms.every((t) => !/[,()*%]/.test(t))).toBe(true)
  })
})

describe('buildAssemblyOrFilter', () => {
  it('builds a name.ilike OR filter covering every expanded term', () => {
    const f = buildAssemblyOrFilter('power point')
    expect(f).toMatch(/name\.ilike\.%gpo%/)
    expect(f).toMatch(/name\.ilike\.%power point%/)
    expect(f.split(',').every((c) => c.startsWith('name.ilike.%'))).toBe(true)
  })

  it('falls back to a match-anything clause for an empty query', () => {
    expect(buildAssemblyOrFilter('')).toBe('name.ilike.%%')
  })
})
