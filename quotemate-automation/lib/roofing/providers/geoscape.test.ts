// Geoscape adapter — pure helpers + the public measure() via a stub
// fetch. Every branch of the response-parsing + form-normalisation
// logic gets its own assertion.

import { describe, expect, it, vi } from 'vitest'
import {
  GeoscapeProvider,
  buildingResponseToMetrics,
  estimateHipsFromForm,
  estimateValleysFromForm,
  extractArea,
  extractRoofShape,
  extractStoreys,
  friendlyFetchError,
  isEmptyDataEnvelope,
  isGeoscapeBuildingBody,
  normaliseBuildingBody,
  normaliseGeoscapeRoofForm,
  pickAddressId,
  pickBestSummary,
  pickBuildingIds,
  pickBuildingSummaries,
  pickPolygon,
  polygonAreaM2,
} from './geoscape'
import type { GeoJSONPolygon } from '../types'

const SQUARE_10M: GeoJSONPolygon = {
  type: 'Polygon',
  // ~10m × 10m square at lat -33.8 (Sydney).
  //   10m of latitude  ≈ 10 / 110574  = 0.0000904506°
  //   10m of longitude ≈ 10 / (111320 × cos(33.8°)) = 10 / 92480 ≈ 0.0001081°
  // Produces a polygon whose shoelace area should be ~100 m².
  coordinates: [[
    [151.2000, -33.8000],
    [151.2001081, -33.8000],
    [151.2001081, -33.8000905],
    [151.2000, -33.8000905],
    [151.2000, -33.8000],
  ]],
}

describe('pickAddressId — envelope variations', () => {
  it('reads { id }', () => {
    expect(pickAddressId({ id: 'abc' })).toBe('abc')
  })
  it('reads { addressId }', () => {
    expect(pickAddressId({ addressId: 'xyz' })).toBe('xyz')
  })
  it('reads { data: [ { id } ] }', () => {
    expect(pickAddressId({ data: [{ id: 'd1' }] })).toBe('d1')
  })
  it('reads { results: [ { addressId } ] }', () => {
    expect(pickAddressId({ results: [{ addressId: 'r1' }] })).toBe('r1')
  })
  it('reads GeoJSON FeatureCollection { features: [{ properties: { addressId } }] }', () => {
    expect(
      pickAddressId({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { addressId: 'g1' } }],
      }),
    ).toBe('g1')
  })
  it('reads { data: [{ pid }] } — PSMA legacy field', () => {
    expect(pickAddressId({ data: [{ pid: 'p1' }] })).toBe('p1')
  })
  it('returns null on empty / unparsable shapes', () => {
    expect(pickAddressId({})).toBeNull()
    expect(pickAddressId(null)).toBeNull()
    expect(pickAddressId({ data: [] })).toBeNull()
  })
})

describe('pickPolygon — lenient field lookup', () => {
  it('finds a polygon under `footprint`', () => {
    expect(pickPolygon({ footprint: SQUARE_10M })).toEqual(SQUARE_10M)
  })
  it('finds a polygon under `geometry` (GeoJSON Feature shape)', () => {
    expect(pickPolygon({ geometry: SQUARE_10M })).toEqual(SQUARE_10M)
  })
  it('finds a polygon under `polygon` (PSMA legacy)', () => {
    expect(pickPolygon({ polygon: SQUARE_10M })).toEqual(SQUARE_10M)
  })
  it('finds a polygon under `roofOutline` (Roof Insight Pack)', () => {
    expect(pickPolygon({ roofOutline: SQUARE_10M })).toEqual(SQUARE_10M)
  })
  it('returns null when none present', () => {
    expect(pickPolygon({})).toBeNull()
    expect(pickPolygon({ footprint: { type: 'Point', coordinates: [1, 2] } })).toBeNull()
  })
})

describe('normaliseBuildingBody — envelope variations', () => {
  it('unwraps { data: [{...}] }', () => {
    const n = normaliseBuildingBody({
      data: [{ footprint: SQUARE_10M, roofShape: 'gable', storeys: 1 }],
    })
    expect(n).not.toBeNull()
    expect(n!.roofForm).toBe('gable')
    expect(n!.storeys).toBe(1)
  })

  it('accepts a GeoJSON Feature with properties + geometry', () => {
    const n = normaliseBuildingBody({
      type: 'Feature',
      geometry: SQUARE_10M,
      properties: { roofShape: 'hip', numberOfStoreys: 2, planarArea: 175 },
    })
    expect(n).not.toBeNull()
    expect(n!.footprint).toEqual(SQUARE_10M)
    expect(n!.roofForm).toBe('hip')
    expect(n!.storeys).toBe(2)
    expect(n!.buildingArea).toBe(175)
  })

  it('accepts a GeoJSON FeatureCollection — uses first feature', () => {
    const n = normaliseBuildingBody({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: SQUARE_10M,
          properties: { roof_shape: 'skillion', floors: 1 },
        },
      ],
    })
    expect(n).not.toBeNull()
    expect(n!.roofForm).toBe('skillion')
    expect(n!.storeys).toBe(1)
  })

  it('tolerates snake_case field names', () => {
    const n = normaliseBuildingBody({
      footprint: SQUARE_10M,
      roof_shape: 'gable',
      number_of_storeys: 2,
      planar_area: 220,
      capture_date: '2024-03-01',
    })
    expect(n).not.toBeNull()
    expect(n!.roofForm).toBe('gable')
    expect(n!.storeys).toBe(2)
    expect(n!.buildingArea).toBe(220)
    expect(n!.captureDate).toBe('2024-03-01')
  })

  it('returns null when no polygon can be found', () => {
    expect(normaliseBuildingBody({})).toBeNull()
    expect(normaliseBuildingBody({ data: [{ roofShape: 'hip' }] })).toBeNull()
  })
})

describe('isGeoscapeBuildingBody', () => {
  it('accepts a body with a Polygon footprint', () => {
    expect(isGeoscapeBuildingBody({ footprint: SQUARE_10M })).toBe(true)
  })
  it('rejects bodies without a footprint', () => {
    expect(isGeoscapeBuildingBody({})).toBe(false)
    expect(isGeoscapeBuildingBody(null)).toBe(false)
  })
  it('rejects non-Polygon footprints', () => {
    expect(
      isGeoscapeBuildingBody({ footprint: { type: 'Point', coordinates: [1, 2] } }),
    ).toBe(false)
  })
})

describe('normaliseGeoscapeRoofForm', () => {
  it('maps strings onto our enum', () => {
    expect(normaliseGeoscapeRoofForm('Gable')).toBe('gable')
    expect(normaliseGeoscapeRoofForm('hip')).toBe('hip')
    expect(normaliseGeoscapeRoofForm('skillion')).toBe('skillion')
    expect(normaliseGeoscapeRoofForm('mono-pitch')).toBe('skillion')
    expect(normaliseGeoscapeRoofForm('gable + hip')).toBe('gable_hip')
    expect(normaliseGeoscapeRoofForm('complex')).toBe('complex')
    expect(normaliseGeoscapeRoofForm('mansard')).toBe('complex')
    expect(normaliseGeoscapeRoofForm(null)).toBe('unknown')
    expect(normaliseGeoscapeRoofForm('')).toBe('unknown')
    expect(normaliseGeoscapeRoofForm('something-else')).toBe('unknown')
  })
})

describe('polygonAreaM2', () => {
  it('computes ~100 m² for a 10m × 10m square at Sydney lat', () => {
    // Allow ±2% — equirectangular projection at residential scale is
    // accurate but not exact.
    const a = polygonAreaM2(SQUARE_10M)
    expect(a).toBeGreaterThan(98)
    expect(a).toBeLessThan(102)
  })
  it('returns 0 for malformed polygons', () => {
    expect(polygonAreaM2({ type: 'Polygon', coordinates: [] })).toBe(0)
    expect(polygonAreaM2({ type: 'Polygon', coordinates: [[[1, 1]]] })).toBe(0)
  })
})

describe('buildingResponseToMetrics', () => {
  it('builds RoofMetrics from a typical hip-roof body', () => {
    const m = buildingResponseToMetrics(
      {
        footprint: SQUARE_10M,
        roofForm: 'hip',
        storeys: 1,
        buildingArea: 200,
        captureDate: '2024-08-15',
      },
      'standard',
    )
    expect(m).not.toBeNull()
    expect(m!.footprint_m2).toBe(200)
    expect(m!.sloped_area_m2).toBe(220) // 200 × 1.10
    expect(m!.form).toBe('hip')
    expect(m!.hips).toBe(4)
    expect(m!.valleys).toBe(0)
    expect(m!.storeys).toBe(1)
    expect(m!.capture_date).toBe('2024-08-15')
  })

  it('falls back to computed footprint when buildingArea is missing', () => {
    const m = buildingResponseToMetrics(
      { footprint: SQUARE_10M, roofForm: 'gable', storeys: 1 },
      'standard',
    )
    expect(m).not.toBeNull()
    expect(m!.footprint_m2).toBeGreaterThan(95)
    expect(m!.footprint_m2).toBeLessThan(105)
  })

  it('returns null when polygon area is zero', () => {
    expect(
      buildingResponseToMetrics(
        { footprint: { type: 'Polygon', coordinates: [] } },
        'standard',
      ),
    ).toBeNull()
  })

  it('does not guess hips/valleys when form is complex', () => {
    const m = buildingResponseToMetrics(
      { footprint: SQUARE_10M, roofForm: 'complex', buildingArea: 200 },
      'standard',
    )
    expect(m!.hips).toBeNull()
    expect(m!.valleys).toBeNull()
  })
})

describe('estimate{Hips,Valleys}FromForm', () => {
  it('gable: 0 hips, 0 valleys', () => {
    expect(estimateHipsFromForm('gable')).toBe(0)
    expect(estimateValleysFromForm('gable')).toBe(0)
  })
  it('hip: 4 hips, 0 valleys', () => {
    expect(estimateHipsFromForm('hip')).toBe(4)
    expect(estimateValleysFromForm('hip')).toBe(0)
  })
  it('gable_hip: 2 hips, 1 valley', () => {
    expect(estimateHipsFromForm('gable_hip')).toBe(2)
    expect(estimateValleysFromForm('gable_hip')).toBe(1)
  })
  it('complex / unknown: nulls (no guessing)', () => {
    expect(estimateHipsFromForm('complex')).toBeNull()
    expect(estimateHipsFromForm('unknown')).toBeNull()
    expect(estimateValleysFromForm('complex')).toBeNull()
  })
})

describe('isEmptyDataEnvelope', () => {
  it('recognises { data: [] } as an empty result', () => {
    expect(isEmptyDataEnvelope({ data: [], links: { count: 0 } })).toBe(true)
  })
  it('recognises { results: [] } and { features: [] }', () => {
    expect(isEmptyDataEnvelope({ results: [] })).toBe(true)
    expect(isEmptyDataEnvelope({ features: [] })).toBe(true)
  })
  it('recognises a bare empty array', () => {
    expect(isEmptyDataEnvelope([])).toBe(true)
  })
  it('returns false for populated envelopes', () => {
    expect(isEmptyDataEnvelope({ data: [{ id: 'x' }] })).toBe(false)
  })
  it('returns false for unrelated shapes', () => {
    expect(isEmptyDataEnvelope(null)).toBe(false)
    expect(isEmptyDataEnvelope({})).toBe(false)
  })
})

describe('pickBuildingIds', () => {
  it('reads { data: ["BLDSA0001..."] } (bare-string list)', () => {
    expect(pickBuildingIds({ data: ['BLDSA0001095169', 'BLDSA0001095170'] })).toEqual([
      'BLDSA0001095169',
      'BLDSA0001095170',
    ])
  })
  it('reads { data: [{ buildingId: "BLDSA..." }] }', () => {
    expect(pickBuildingIds({ data: [{ buildingId: 'BLDSA0001095169' }] })).toEqual([
      'BLDSA0001095169',
    ])
  })
  it('reads nested GeoJSON FeatureCollection { features: [{ properties: { pid } }] }', () => {
    expect(
      pickBuildingIds({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { pid: 'BLDSA0001095169' } },
          { type: 'Feature', properties: { pid: 'BLDSA0001095170' } },
        ],
      }),
    ).toEqual(['BLDSA0001095169', 'BLDSA0001095170'])
  })
  it('returns [] when nothing id-shaped present', () => {
    expect(pickBuildingIds({})).toEqual([])
    expect(pickBuildingIds({ data: [] })).toEqual([])
    expect(pickBuildingIds(null)).toEqual([])
  })
  it('dedupes repeated ids', () => {
    expect(
      pickBuildingIds({
        data: [{ id: 'BLDSA1', buildingId: 'BLDSA1' }, { id: 'BLDSA1' }],
      }),
    ).toEqual(['BLDSA1'])
  })
})

describe('friendlyFetchError — DNS / connection failures', () => {
  it('detects the typical undici "fetch failed" string and points at the env var', () => {
    const e = new Error('fetch failed')
    const msg = friendlyFetchError(e, 'https://api.geoscape.com.au/v1')
    expect(msg).toMatch(/api\.psma\.com\.au/)
    expect(msg).toMatch(/GEOSCAPE_API_BASE_URL/)
  })
  it('detects an ECONNREFUSED root cause', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:443')
    const e = Object.assign(new Error('fetch failed'), { cause })
    expect(friendlyFetchError(e, 'https://api.example.com')).toMatch(/not reachable/i)
  })
  it('falls back to the raw error message for unknown errors', () => {
    const e = new Error('socket: SSL handshake failed')
    expect(friendlyFetchError(e, 'https://api.example.com')).toMatch(/SSL handshake/)
  })
})

describe('pickBuildingSummaries — link-based Buildings list parser', () => {
  it('reads the documented response shape and pulls buildingId + related count + links', () => {
    const summaries = pickBuildingSummaries({
      countByCoverageType: { urban: 3 },
      data: [
        {
          buildingId: 'bldD2cumz7aKoXT',
          coverageType: 'Urban',
          relatedAddressIds: ['GANSW1', 'GANSW2', 'GANSW3'],
          links: {
            footprint2d: '/v1/buildings/bldD2cumz7aKoXT/footprint2d',
            roofShape: '/v1/buildings/bldD2cumz7aKoXT/roofShape',
            estimatedLevels: '/v1/buildings/bldD2cumz7aKoXT/estimatedLevels',
            area: '/v1/buildings/bldD2cumz7aKoXT/area',
          },
        },
        {
          buildingId: 'bldTVTLhmaVdXFL',
          coverageType: 'Urban',
          relatedAddressIds: Array.from({ length: 50 }, (_, i) => `addr-${i}`),
          links: { footprint2d: '/v1/buildings/bldTVTLhmaVdXFL/footprint2d' },
        },
      ],
    })
    expect(summaries).toHaveLength(2)
    expect(summaries[0].buildingId).toBe('bldD2cumz7aKoXT')
    expect(summaries[0].relatedAddressCount).toBe(3)
    expect(summaries[0].links.footprint2d).toMatch(/footprint2d$/)
    expect(summaries[1].buildingId).toBe('bldTVTLhmaVdXFL')
    expect(summaries[1].relatedAddressCount).toBe(50)
  })

  it('returns [] for empty data', () => {
    expect(pickBuildingSummaries({ data: [] })).toEqual([])
  })

  it('returns [] for unrecognised shapes', () => {
    expect(pickBuildingSummaries(null)).toEqual([])
    expect(pickBuildingSummaries({})).toEqual([])
  })

  it('drops items missing buildingId', () => {
    expect(pickBuildingSummaries({ data: [{ coverageType: 'Urban' }] })).toEqual([])
  })

  it('ignores non-string link values defensively', () => {
    const s = pickBuildingSummaries({
      data: [{ buildingId: 'b1', links: { footprint2d: '/x', area: 123, junk: null } }],
    })
    expect(s[0].links).toEqual({ footprint2d: '/x' })
  })
})

describe('pickBestSummary — pick the most specific building', () => {
  it('returns null for empty input', () => {
    expect(pickBestSummary([])).toBeNull()
  })
  it('returns the only summary when there is one', () => {
    expect(pickBestSummary([{ buildingId: 'b1', relatedAddressCount: 9, links: {} }])).toEqual({
      buildingId: 'b1',
      relatedAddressCount: 9,
      links: {},
    })
  })
  it('prefers the summary with the SMALLEST related-address count (most specific)', () => {
    const best = pickBestSummary([
      { buildingId: 'big',   relatedAddressCount: 70, links: {} },
      { buildingId: 'small', relatedAddressCount: 5,  links: {} },
      { buildingId: 'mid',   relatedAddressCount: 30, links: {} },
    ])
    expect(best?.buildingId).toBe('small')
  })
})

describe('extractRoofShape', () => {
  it('reads { roofShape: "hip" } and the snake-case variants', () => {
    expect(extractRoofShape({ roofShape: 'hip' })).toBe('hip')
    expect(extractRoofShape({ roof_shape: 'gable' })).toBe('gable')
  })
  it('unwraps { data: { ... } }', () => {
    expect(extractRoofShape({ data: { roofShape: 'skillion' } })).toBe('skillion')
  })
  it('accepts a bare string', () => {
    expect(extractRoofShape('hip')).toBe('hip')
  })
  it('returns null for unknown shapes', () => {
    expect(extractRoofShape(null)).toBeNull()
    expect(extractRoofShape({})).toBeNull()
    expect(extractRoofShape({ foo: 'bar' })).toBeNull()
  })
})

describe('extractStoreys', () => {
  it('reads { estimatedLevels: 2 } and the variants', () => {
    expect(extractStoreys({ estimatedLevels: 2 })).toBe(2)
    expect(extractStoreys({ storeys: 3 })).toBe(3)
    expect(extractStoreys({ floors: 1 })).toBe(1)
  })
  it('unwraps { data: { ... } }', () => {
    expect(extractStoreys({ data: { estimatedLevels: 2 } })).toBe(2)
  })
  it('accepts a bare number', () => {
    expect(extractStoreys(2)).toBe(2)
  })
  it('accepts numeric strings', () => {
    expect(extractStoreys({ estimatedLevels: '2.0' })).toBe(2)
  })
  it('returns null on non-positive / missing', () => {
    expect(extractStoreys({ estimatedLevels: 0 })).toBeNull()
    expect(extractStoreys({})).toBeNull()
  })
})

describe('extractArea', () => {
  it('reads { area: 220.5 } and the variants', () => {
    expect(extractArea({ area: 220.5 })).toBe(220.5)
    expect(extractArea({ planarArea: 175 })).toBe(175)
    expect(extractArea({ planar_area: 175 })).toBe(175)
  })
  it('unwraps { data: { ... } }', () => {
    expect(extractArea({ data: { area: 220 } })).toBe(220)
  })
  it('accepts a bare number', () => {
    expect(extractArea(220)).toBe(220)
  })
  it('returns null on missing / non-positive', () => {
    expect(extractArea(null)).toBeNull()
    expect(extractArea({})).toBeNull()
    expect(extractArea({ area: -5 })).toBeNull()
  })
})

describe('pickPolygon — handles footprint2d sub-resource shapes', () => {
  it('accepts a bare Polygon at the top level', () => {
    const p = pickPolygon(SQUARE_10M)
    expect(p).toEqual(SQUARE_10M)
  })
  it('accepts a GeoJSON Feature wrapper', () => {
    expect(pickPolygon({ type: 'Feature', geometry: SQUARE_10M })).toEqual(SQUARE_10M)
  })
  it('accepts { data: <Polygon> } from the sub-resource', () => {
    expect(pickPolygon({ data: SQUARE_10M })).toEqual(SQUARE_10M)
  })
  it('finds it under `footprint2d`', () => {
    expect(pickPolygon({ footprint2d: SQUARE_10M })).toEqual(SQUARE_10M)
  })
})

describe('GeoscapeProvider.measure — full link-based flow with stubbed fetch', () => {
  it('walks address → buildings list → 4 parallel sub-resources → metrics', async () => {
    const fetchImpl = vi
      .fn()
      // 1. Addresses search
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                addressId: 'GANSW710377076',
                addressString: '1 Oxford St',
                formattedAddress: '1 OXFORD ST',
                matchConfidence: 100,
              },
            ],
            links: {},
          }),
          { status: 200 },
        ),
      )
      // 2. Buildings list
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            countByCoverageType: { urban: 1 },
            data: [
              {
                buildingId: 'bldD2cumz7aKoXT',
                coverageType: 'Urban',
                relatedAddressIds: ['GANSW710377076'],
                links: {
                  footprint2d: '/v1/buildings/bldD2cumz7aKoXT/footprint2d',
                  roofShape: '/v1/buildings/bldD2cumz7aKoXT/roofShape',
                  estimatedLevels: '/v1/buildings/bldD2cumz7aKoXT/estimatedLevels',
                  area: '/v1/buildings/bldD2cumz7aKoXT/area',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      // 3-6 — the 4 sub-resource fetches run in parallel. Promise.all
      // doesn't guarantee a fixed iteration order on the mock, so to
      // keep the test deterministic we stub fetchImpl to route by URL
      // suffix instead of by call order.
      .mockImplementation((url: RequestInfo | URL) => {
        const s = String(url)
        if (s.endsWith('/footprint2d')) {
          return Promise.resolve(new Response(JSON.stringify({ data: SQUARE_10M }), { status: 200 }))
        }
        if (s.endsWith('/roofShape')) {
          return Promise.resolve(new Response(JSON.stringify({ roofShape: 'hip' }), { status: 200 }))
        }
        if (s.endsWith('/estimatedLevels')) {
          return Promise.resolve(new Response(JSON.stringify({ estimatedLevels: 1 }), { status: 200 }))
        }
        if (s.endsWith('/area')) {
          return Promise.resolve(new Response(JSON.stringify({ area: 200 }), { status: 200 }))
        }
        return Promise.resolve(new Response('not found', { status: 404 }))
      })

    const p = new GeoscapeProvider({ apiKey: 'fake', fetchImpl })
    const r = await p.measure({ address: '1 Oxford St', postcode: '2021', state: 'NSW' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.metrics.form).toBe('hip')
      expect(r.metrics.footprint_m2).toBe(200)
      expect(r.metrics.sloped_area_m2).toBe(220) // 200 × 1.10 (standard pitch)
      expect(r.metrics.storeys).toBe(1)
      expect(r.metrics.hips).toBe(4)
      expect(r.metrics.polygon_geojson).toEqual(SQUARE_10M)
    }
  })

  it('picks the smallest-related-addresses building when multiple come back', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ addressId: 'a1' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                buildingId: 'big',
                relatedAddressIds: Array.from({ length: 60 }, (_, i) => `${i}`),
                links: {
                  footprint2d: '/v1/buildings/big/footprint2d',
                  roofShape: '/v1/buildings/big/roofShape',
                  estimatedLevels: '/v1/buildings/big/estimatedLevels',
                  area: '/v1/buildings/big/area',
                },
              },
              {
                buildingId: 'small',
                relatedAddressIds: ['a1'],
                links: {
                  footprint2d: '/v1/buildings/small/footprint2d',
                  roofShape: '/v1/buildings/small/roofShape',
                  estimatedLevels: '/v1/buildings/small/estimatedLevels',
                  area: '/v1/buildings/small/area',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockImplementation((url: RequestInfo | URL) => {
        const s = String(url)
        // Only the SMALL building's footprint should be requested.
        if (s.includes('/buildings/small/')) {
          if (s.endsWith('/footprint2d')) return Promise.resolve(new Response(JSON.stringify(SQUARE_10M), { status: 200 }))
          if (s.endsWith('/roofShape')) return Promise.resolve(new Response(JSON.stringify({ roofShape: 'gable' }), { status: 200 }))
          if (s.endsWith('/estimatedLevels')) return Promise.resolve(new Response(JSON.stringify({ estimatedLevels: 1 }), { status: 200 }))
          if (s.endsWith('/area')) return Promise.resolve(new Response(JSON.stringify({ area: 150 }), { status: 200 }))
        }
        // If the test logic ever hits 'big', return a sentinel that
        // would produce a wrong form so the assertion below catches it.
        if (s.includes('/buildings/big/')) {
          if (s.endsWith('/roofShape')) return Promise.resolve(new Response(JSON.stringify({ roofShape: 'complex' }), { status: 200 }))
        }
        return Promise.resolve(new Response('miss', { status: 404 }))
      })

    const p = new GeoscapeProvider({ apiKey: 'fake', fetchImpl })
    const r = await p.measure({ address: '1 Test St', postcode: '2000', state: 'NSW' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // gable would NOT be returned if we used the 'big' building (it returned 'complex').
      expect(r.metrics.form).toBe('gable')
      expect(r.metrics.footprint_m2).toBe(150)
    }
  })

  it('surfaces a useful trace when footprint2d returns no polygon', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ addressId: 'a1' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                buildingId: 'b1',
                relatedAddressIds: ['a1'],
                links: {
                  footprint2d: '/v1/buildings/b1/footprint2d',
                  roofShape: '/v1/buildings/b1/roofShape',
                  estimatedLevels: '/v1/buildings/b1/estimatedLevels',
                  area: '/v1/buildings/b1/area',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockImplementation((url: RequestInfo | URL) => {
        const s = String(url)
        // Footprint endpoint returns something WITHOUT a Polygon
        if (s.endsWith('/footprint2d')) return Promise.resolve(new Response(JSON.stringify({ data: { type: 'GeometryCollection' } }), { status: 200 }))
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
      })

    const p = new GeoscapeProvider({ apiKey: 'fake', fetchImpl })
    const r = await p.measure({ address: '1 Test St', postcode: '2000', state: 'NSW' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('provider_invalid_response')
      expect(r.detail).toMatch(/footprint2d/i)
    }
  })
})

describe('GeoscapeProvider.measure — error envelope (with stub fetch)', () => {
  it('returns provider_unavailable when API key is missing', async () => {
    const p = new GeoscapeProvider({ apiKey: '', fetchImpl: vi.fn() as never })
    const r = await p.measure({ address: '1 Test St', postcode: '2000', state: 'NSW' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('provider_unavailable')
  })

  it('throws on programmer error — empty address', async () => {
    const p = new GeoscapeProvider({ apiKey: 'fake' })
    await expect(
      p.measure({ address: '', postcode: '2000', state: 'NSW' }),
    ).rejects.toThrow(/address is required/)
  })

  it('returns rate_limited on 429 from the address lookup', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
    const p = new GeoscapeProvider({ apiKey: 'fake', fetchImpl })
    const r = await p.measure({ address: '1 Test St', postcode: '2000', state: 'NSW' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('provider_rate_limited')
  })

  it('returns address_not_resolved on empty address result', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const p = new GeoscapeProvider({ apiKey: 'fake', fetchImpl })
    const r = await p.measure({ address: 'gibberish', postcode: '2000', state: 'NSW' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('address_not_resolved')
  })

  it('returns no_building_at_address when Buildings list is empty', async () => {
    // The Buildings adapter calls /buildings?addressId= once. An
    // empty `{ data: [], links: {...} }` envelope is the documented
    // "no record" response — surface that as no_building_at_address.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'addr-1' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], links: { count: 0 } }), { status: 200 }),
      )
    const p = new GeoscapeProvider({ apiKey: 'fake', fetchImpl })
    const r = await p.measure({ address: '1 Test St', postcode: '2000', state: 'NSW' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('no_building_at_address')
  })

  // Helper for the legacy happy-path tests below — wires a mock that
  // serves the link-based flow with the supplied roof shape + storeys.
  function makeLinkBasedFetch(opts: {
    roofShape: string
    storeys: number
    area?: number
  }) {
    return vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ addressId: 'addr-1' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                buildingId: 'b1',
                coverageType: 'Urban',
                relatedAddressIds: ['addr-1'],
                links: {
                  footprint2d: '/v1/buildings/b1/footprint2d',
                  roofShape: '/v1/buildings/b1/roofShape',
                  estimatedLevels: '/v1/buildings/b1/estimatedLevels',
                  area: '/v1/buildings/b1/area',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockImplementation((url: RequestInfo | URL) => {
        const s = String(url)
        if (s.endsWith('/footprint2d')) return Promise.resolve(new Response(JSON.stringify({ data: SQUARE_10M }), { status: 200 }))
        if (s.endsWith('/roofShape')) return Promise.resolve(new Response(JSON.stringify({ roofShape: opts.roofShape }), { status: 200 }))
        if (s.endsWith('/estimatedLevels')) return Promise.resolve(new Response(JSON.stringify({ estimatedLevels: opts.storeys }), { status: 200 }))
        if (s.endsWith('/area')) return Promise.resolve(new Response(JSON.stringify({ area: opts.area ?? 200 }), { status: 200 }))
        return Promise.resolve(new Response('miss', { status: 404 }))
      })
  }

  it('returns ok with metrics on the full happy path', async () => {
    const p = new GeoscapeProvider({ apiKey: 'fake', fetchImpl: makeLinkBasedFetch({ roofShape: 'hip', storeys: 1 }) })
    const r = await p.measure({ address: '1 Test St', postcode: '2000', state: 'NSW' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.metrics.footprint_m2).toBe(200)
      expect(r.metrics.sloped_area_m2).toBe(220)
      expect(r.metrics.form).toBe('hip')
      expect(r.provider).toBe('geoscape')
    }
  })

  it('emits warnings for 2-storey buildings', async () => {
    const p = new GeoscapeProvider({ apiKey: 'fake', fetchImpl: makeLinkBasedFetch({ roofShape: 'hip', storeys: 2 }) })
    const r = await p.measure({ address: '1 Test St', postcode: '2000', state: 'NSW' })
    if (r.ok) {
      expect(r.warnings.some((w) => /multi-storey/i.test(w))).toBe(true)
    }
  })

  it('emits warnings for complex roof form', async () => {
    const p = new GeoscapeProvider({ apiKey: 'fake', fetchImpl: makeLinkBasedFetch({ roofShape: 'complex', storeys: 1 }) })
    const r = await p.measure({ address: '1 Test St', postcode: '2000', state: 'NSW' })
    if (r.ok) {
      expect(r.warnings.some((w) => /complex/i.test(w))).toBe(true)
    }
  })
})
