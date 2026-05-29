import { describe, expect, it } from 'vitest'
import {
  classifyEdges,
  edgeLengthM,
  paddedBBox,
  polygonBBox,
  polygonCentroid,
} from './map-utils'
import type { GeoJSONPolygon } from './types'

const SQUARE: GeoJSONPolygon = {
  type: 'Polygon',
  coordinates: [[
    [151.2, -33.8],
    [151.2002, -33.8],
    [151.2002, -33.8002],
    [151.2, -33.8002],
    [151.2, -33.8],
  ]],
}

// A taller-than-it-is-wide rectangle (gable house shape: long sides
// = eaves; short sides = gable ends).
const RECT: GeoJSONPolygon = {
  type: 'Polygon',
  coordinates: [[
    [151.2, -33.8],          // bottom-left
    [151.20005, -33.8],      // bottom-right (short side)
    [151.20005, -33.80020],  // top-right
    [151.2, -33.80020],      // top-left (short side)
    [151.2, -33.8],
  ]],
}

describe('polygonBBox', () => {
  it('computes the exact bbox of a simple square', () => {
    const b = polygonBBox(SQUARE)
    expect(b).toEqual({
      west: 151.2,
      south: -33.8002,
      east: 151.2002,
      north: -33.8,
    })
  })
  it('returns null for malformed polygons', () => {
    expect(polygonBBox(null)).toBeNull()
    expect(polygonBBox({ type: 'Polygon', coordinates: [[[1, 1]]] })).toBeNull()
  })
})

describe('polygonCentroid', () => {
  it('returns the mean of the unique vertices', () => {
    const c = polygonCentroid(SQUARE)
    expect(c).not.toBeNull()
    expect(c![0]).toBeCloseTo(151.2001, 6)
    expect(c![1]).toBeCloseTo(-33.8001, 6)
  })
  it('returns null for empty input', () => {
    expect(polygonCentroid(null)).toBeNull()
  })
})

describe('edgeLengthM', () => {
  it('returns a positive metre value for a small AU edge', () => {
    const d = edgeLengthM([151.2, -33.8], [151.20005, -33.8])
    // ~0.00005° lng at lat -33.8 ≈ 4.6 m
    expect(d).toBeGreaterThan(3)
    expect(d).toBeLessThan(6)
  })
  it('returns 0 for identical points', () => {
    expect(edgeLengthM([151.2, -33.8], [151.2, -33.8])).toBe(0)
  })
})

describe('classifyEdges', () => {
  it('marks the two long edges of a gable rectangle as eaves and the short ones as ridge', () => {
    const edges = classifyEdges(RECT, 'gable')
    expect(edges).toHaveLength(4)
    const eaves = edges.filter((e) => e.kind === 'eave')
    const ridges = edges.filter((e) => e.kind === 'ridge')
    expect(eaves).toHaveLength(2)
    expect(ridges).toHaveLength(2)
    // The eave edges should be the longer pair.
    const avgEave = eaves.reduce((s, e) => s + e.length_m, 0) / eaves.length
    const avgRidge = ridges.reduce((s, e) => s + e.length_m, 0) / ridges.length
    expect(avgEave).toBeGreaterThan(avgRidge)
  })

  it('marks every edge of a hip roof as eave', () => {
    const edges = classifyEdges(SQUARE, 'hip')
    expect(edges.every((e) => e.kind === 'eave')).toBe(true)
  })

  it('marks every edge as unknown when the form is complex', () => {
    const edges = classifyEdges(SQUARE, 'complex')
    expect(edges.every((e) => e.kind === 'unknown')).toBe(true)
  })

  it('returns an empty array for malformed polygons', () => {
    expect(classifyEdges(null, 'gable')).toEqual([])
  })
})

describe('paddedBBox', () => {
  it('pads symmetrically by the requested fraction', () => {
    const b = paddedBBox(
      { west: 0, south: 0, east: 10, north: 10 },
      0.2,
    )
    expect(b).toEqual({ west: -2, south: -2, east: 12, north: 12 })
  })
})
