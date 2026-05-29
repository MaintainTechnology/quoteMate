import { describe, expect, it, vi } from 'vitest'
import {
  composeAddress,
  normaliseAuState,
  parseNominatimResponse,
  reverseGeocode,
  validateCoords,
} from './geocode'

describe('validateCoords', () => {
  it('accepts a Sydney coordinate', () => {
    expect(validateCoords({ lng: 151.2093, lat: -33.8688 })).toBeNull()
  })
  it('rejects NaN / Infinity', () => {
    expect(validateCoords({ lng: Number.NaN, lat: -33 })).toMatch(/finite/i)
    expect(validateCoords({ lng: 151, lat: Number.POSITIVE_INFINITY })).toMatch(/finite/i)
  })
  it('rejects coordinates outside the AU bounding box', () => {
    expect(validateCoords({ lng: -74, lat: 40 })).toMatch(/Australian/i) // New York
    expect(validateCoords({ lng: 2.35, lat: 48.85 })).toMatch(/Australian/i) // Paris
  })
  it('rejects out-of-range longitude / latitude', () => {
    // Error message uses the en-dash (−180) — match the digits, not the dash.
    expect(validateCoords({ lng: 200, lat: 0 })).toMatch(/180/)
    expect(validateCoords({ lng: 0, lat: 200 })).toMatch(/90/i)
  })
})

describe('composeAddress', () => {
  it('joins fragments into a plain street address', () => {
    const a = composeAddress({
      house_number: '27',
      road: 'Smith Street',
      suburb: 'Penrith',
      state: 'New South Wales',
      postcode: '2750',
    })
    expect(a).toBe('27 Smith Street, Penrith, New South Wales, 2750')
  })
  it('skips the house number when only the road is known', () => {
    expect(composeAddress({ road: 'Smith Street', postcode: '2750' })).toBe('Smith Street, 2750')
  })
  it('falls back to town / village when suburb / city are missing', () => {
    expect(composeAddress({ road: 'Main Rd', village: 'Burraga', postcode: '2795' })).toMatch(/Burraga/)
  })
  it('returns empty string for null / empty inputs', () => {
    expect(composeAddress(null)).toBe('')
    expect(composeAddress({})).toBe('')
  })
})

describe('normaliseAuState', () => {
  it('maps long and short names alike', () => {
    expect(normaliseAuState('New South Wales')).toBe('NSW')
    expect(normaliseAuState('VIC')).toBe('VIC')
    expect(normaliseAuState('Queensland')).toBe('QLD')
  })
  it('returns null for non-AU / unknown', () => {
    expect(normaliseAuState('California')).toBeNull()
    expect(normaliseAuState(undefined)).toBeNull()
  })
})

describe('parseNominatimResponse', () => {
  it('returns ok with address + postcode + state for a typical AU result', () => {
    const r = parseNominatimResponse({
      display_name: '27 Smith Street, Penrith NSW 2750, Australia',
      address: {
        house_number: '27',
        road: 'Smith Street',
        suburb: 'Penrith',
        state: 'New South Wales',
        postcode: '2750',
        country_code: 'au',
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.address).toContain('Smith Street')
      expect(r.postcode).toBe('2750')
      expect(r.state).toBe('NSW')
    }
  })

  it('rejects non-AU country codes', () => {
    const r = parseNominatimResponse({
      address: { country_code: 'us', road: 'Madison Ave' },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('no_result')
  })

  it('rejects errors that Nominatim returns inline', () => {
    const r = parseNominatimResponse({ error: 'Unable to geocode' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/unable/i)
  })

  it('falls back to display_name when address fragments are missing', () => {
    const r = parseNominatimResponse({
      display_name: 'A street, Australia',
      address: { country_code: 'au' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.address).toMatch(/street/i)
  })
})

describe('reverseGeocode — with injected fetch', () => {
  it('returns invalid_input on bad coordinates', async () => {
    const r = await reverseGeocode(
      { lng: 0, lat: 0 },
      { fetchImpl: vi.fn() as never },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_input')
  })

  it('handles a happy 200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          display_name: '27 Smith Street, Penrith NSW 2750, Australia',
          address: {
            house_number: '27',
            road: 'Smith Street',
            suburb: 'Penrith',
            state: 'New South Wales',
            postcode: '2750',
            country_code: 'au',
          },
        }),
        { status: 200 },
      ),
    )
    const r = await reverseGeocode(
      { lng: 150.6987, lat: -33.7506 },
      { fetchImpl },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.address).toContain('Smith Street')
      expect(r.state).toBe('NSW')
    }
  })

  it('returns provider_error on non-200', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
    const r = await reverseGeocode(
      { lng: 150.6987, lat: -33.7506 },
      { fetchImpl },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('provider_error')
  })

  it('returns network_error when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('socket reset'))
    const r = await reverseGeocode(
      { lng: 150.6987, lat: -33.7506 },
      { fetchImpl },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('network_error')
  })
})
