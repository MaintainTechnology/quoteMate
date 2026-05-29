// ════════════════════════════════════════════════════════════════════
// Roofing — pure helpers for the dashboard map widget.
//
// Pulled out of the React component so the geometry + edge-classification
// heuristics can be unit-tested without a MapLibre context.
//
// IMPORTANT — what these helpers can and cannot do:
//   • bbox + centroid are exact.
//   • edge classification is HEURISTIC. Geoscape's response does not tag
//     which polygon edges are ridges vs hips vs valleys vs eaves —
//     that's a 3D-topology question and Geoscape only ships a 2D
//     footprint. Phase 1 colours edges based on the roof FORM (gable
//     → long edges = eaves, short edges = gable ends; hip → all 4 edges
//     = eaves). Phase 2 LiDAR will derive real edge classification from
//     the DSM. Until then, hip/valley overlays on the map are visual
//     SUGGESTIONS, not measurement output — the numerical hip / valley
//     COUNTS still come from the orchestrator's form-based estimator.
// ════════════════════════════════════════════════════════════════════

import type { GeoJSONPolygon, RoofForm } from './types'

export type LngLat = [number, number]
export type BBox = { west: number; south: number; east: number; north: number }

/** PURE — bounding box of the polygon's outer ring. Returns null when
 *  the polygon is malformed. */
export function polygonBBox(polygon: GeoJSONPolygon | null | undefined): BBox | null {
  const ring = polygon?.coordinates?.[0]
  if (!Array.isArray(ring) || ring.length < 4) return null
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2) continue
    const [lng, lat] = pt
    if (typeof lng !== 'number' || typeof lat !== 'number') continue
    if (lng < west) west = lng
    if (lng > east) east = lng
    if (lat < south) south = lat
    if (lat > north) north = lat
  }
  if (!Number.isFinite(west) || !Number.isFinite(north)) return null
  return { west, south, east, north }
}

/** PURE — centroid of the polygon's outer ring as the mean of vertices.
 *  Good enough for map recentering on small residential footprints —
 *  exact area-weighted centroid not needed at this scale. */
export function polygonCentroid(polygon: GeoJSONPolygon | null | undefined): LngLat | null {
  const ring = polygon?.coordinates?.[0]
  if (!Array.isArray(ring) || ring.length < 4) return null
  let sx = 0
  let sy = 0
  let n = 0
  // Drop the closing repeat vertex when computing the mean.
  for (let i = 0; i < ring.length - 1; i++) {
    const pt = ring[i]
    if (!Array.isArray(pt) || pt.length < 2) continue
    const [lng, lat] = pt
    if (typeof lng !== 'number' || typeof lat !== 'number') continue
    sx += lng
    sy += lat
    n++
  }
  if (n === 0) return null
  return [sx / n, sy / n]
}

export type EdgeKind = 'eave' | 'hip' | 'valley' | 'ridge' | 'unknown'
export type ClassifiedEdge = {
  /** Pair of vertex indices into the outer ring. */
  from: LngLat
  to: LngLat
  /** Visual classification — heuristic, see file header. */
  kind: EdgeKind
  /** Edge length in metres (equirectangular projection at the polygon's centroid). */
  length_m: number
}

const M_PER_DEG_LAT = 110_574

/** PURE — straight-line distance in metres between two lng/lat points
 *  using equirectangular projection (accurate to <1% at residential
 *  scale). */
export function edgeLengthM(a: LngLat, b: LngLat): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  const lat0 = (a[1] + b[1]) / 2
  const cos = Math.cos((lat0 * Math.PI) / 180)
  const mPerDegLng = 111_320 * cos
  const dx = (b[0] - a[0]) * mPerDegLng
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * PURE — classify each polygon edge for VISUAL display.
 *
 * Heuristic per roof form:
 *   • gable      — two longest pairs of parallel edges = eaves; the
 *                  remaining edges = gable ends (labelled 'ridge' so
 *                  they pop in the eave/ridge colour).
 *   • hip        — all edges are eaves (the actual hips run from the
 *                  eaves up to the apex, which is INSIDE the polygon
 *                  and not visible from above).
 *   • skillion   — all edges are eaves; one edge is the high side, one
 *                  is the low side — without elevation data we cannot
 *                  tell which.
 *   • gable_hip  — all edges = eaves (mixed form has both gables and
 *                  hips internally; the polygon boundary itself is
 *                  still eaves).
 *   • complex    — leave every edge as 'unknown' so the map renders a
 *                  neutral outline (no claim about which edge is what).
 *   • unknown    — 'unknown' for every edge.
 *
 * NOTE: this is purely VISUAL. Numerical hip/valley COUNTS come from
 * the orchestrator (estimateHipsFromForm / estimateValleysFromForm).
 * Don't use these labels for pricing or scope.
 */
export function classifyEdges(
  polygon: GeoJSONPolygon | null | undefined,
  form: RoofForm,
): ClassifiedEdge[] {
  const ring = polygon?.coordinates?.[0]
  if (!Array.isArray(ring) || ring.length < 4) return []
  const edges: ClassifiedEdge[] = []
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i] as LngLat
    const b = ring[i + 1] as LngLat
    const length_m = edgeLengthM(a, b)
    edges.push({ from: a, to: b, kind: defaultKindForForm(form), length_m })
  }
  if (form === 'gable' && edges.length >= 4) {
    // Mark the two LONGEST edges as eaves; the others stay 'ridge' (gable end).
    const sorted = [...edges].sort((x, y) => y.length_m - x.length_m)
    const longTwo = new Set([sorted[0], sorted[1]])
    for (const e of edges) {
      e.kind = longTwo.has(e) ? 'eave' : 'ridge'
    }
  }
  return edges
}

function defaultKindForForm(form: RoofForm): EdgeKind {
  switch (form) {
    case 'gable':     return 'eave'
    case 'hip':       return 'eave'
    case 'skillion':  return 'eave'
    case 'gable_hip': return 'eave'
    case 'complex':   return 'unknown'
    case 'unknown':   return 'unknown'
  }
}

/** PURE — the four lng/lat corners of the polygon's bbox, padded out
 *  by `padFrac` (fraction of bbox width / height). Used when fitting
 *  the map to a building so the polygon doesn't fill 100% of the
 *  viewport. */
export function paddedBBox(bbox: BBox, padFrac = 0.4): BBox {
  const w = bbox.east - bbox.west
  const h = bbox.north - bbox.south
  return {
    west: bbox.west - w * padFrac,
    south: bbox.south - h * padFrac,
    east: bbox.east + w * padFrac,
    north: bbox.north + h * padFrac,
  }
}
