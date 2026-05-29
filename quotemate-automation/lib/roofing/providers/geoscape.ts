// ════════════════════════════════════════════════════════════════════
// Roofing — Geoscape Addresses + Buildings adapter (link-based flow).
//
// CONFIRMED 2026-05-29 by probing the live API:
//
//   Host:    https://api.psma.com.au/v1
//   Auth:    Authorization: <key>  (raw — NO 'Bearer ' prefix)
//
//   Addresses search:
//     GET /addresses?addressString=<text>&state=<NSW|VIC|…>&perPage=N
//     200 { "data": [{ "addressId":"GANSW…", "addressString":"…",
//                       "formattedAddress":"…", "matchConfidence":100 }],
//           "links": {…} }
//
//   Buildings summary by address:
//     GET /buildings?addressId=<id>
//     200 { "countByCoverageType": {…},
//           "data": [
//             { "buildingId":"bld…",
//               "coverageType":"Urban",
//               "relatedAddressIds": ["GANSW…", …],
//               "links": {
//                 "footprint2d": "/v1/buildings/<id>/footprint2d",
//                 "roofShape":   "/v1/buildings/<id>/roofShape",
//                 "estimatedLevels": "/v1/buildings/<id>/estimatedLevels",
//                 "area":        "/v1/buildings/<id>/area",
//                 …
//               }
//             }, …
//           ] }
//
// The polygon is NOT inline — each attribute lives at its own sub-URL
// (HATEOAS). We follow up with parallel calls to:
//   • footprint2d      → polygon (GeoJSON)
//   • roofShape        → roof form ('hip' / 'gable' / …)
//   • estimatedLevels  → storeys
//   • area             → planar area (m²)
//
// MULTIPLE buildings may come back at one address (terraces, apartment
// blocks). We pick the one with the FEWEST related addresses — the most
// specific match for the queried address.
//
// CREDIT COST: a complete measurement = 1 address + 1 buildings list +
// 4 sub-resource calls = 6 credits. Premium tier (30k+ credits/mo)
// comfortably covers ~5000 measurements/month.
// ════════════════════════════════════════════════════════════════════

import type { RoofingMeasurementProvider } from './base'
import type {
  GeoJSONPolygon,
  PitchBucket,
  RoofAddressInput,
  RoofForm,
  RoofMetrics,
  RoofingMeasurementFailureCode,
  RoofingMeasurementResult,
} from '../types'
import { slopedAreaFromFootprint } from '../pricing'

const DEFAULT_BASE_URL =
  process.env.GEOSCAPE_API_BASE_URL ?? 'https://api.psma.com.au/v1'

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type GeoscapeProviderOpts = {
  apiKey?: string
  baseUrl?: string
  fetchImpl?: FetchLike
  defaultPitch?: PitchBucket
}

export class GeoscapeProvider implements RoofingMeasurementProvider {
  readonly name = 'geoscape' as const

  private readonly apiKey: string | undefined
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly defaultPitch: PitchBucket

  constructor(opts: GeoscapeProviderOpts = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEOSCAPE_API_KEY
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl =
      opts.fetchImpl ??
      ((input, init) => fetch(input, init))
    this.defaultPitch = opts.defaultPitch ?? 'standard'
  }

  async measure(input: RoofAddressInput): Promise<RoofingMeasurementResult> {
    if (!input || !input.address?.trim()) {
      throw new Error('GeoscapeProvider.measure: address is required')
    }
    if (!this.apiKey) {
      return {
        ok: false,
        code: 'provider_unavailable',
        detail:
          'GEOSCAPE_API_KEY is not set — Geoscape adapter cannot make requests. Set the env var or use the mock provider for local development.',
      }
    }

    const addressIdRes = await this.resolveAddressId(input)
    if (!addressIdRes.ok) return addressIdRes

    const buildingRes = await this.fetchBuildingDetails(addressIdRes.addressId)
    if (!buildingRes.ok) return buildingRes

    const metrics = buildingDetailsToMetrics(buildingRes.details, this.defaultPitch)
    if (!metrics) {
      return {
        ok: false,
        code: 'provider_invalid_response',
        detail:
          'Geoscape returned a building but no usable polygon — cannot compute area.',
      }
    }

    const warnings: string[] = []
    if (metrics.form === 'complex') {
      warnings.push(
        'Geoscape classified the roof as complex — orchestrator will route to inspection.',
      )
    }
    if (metrics.storeys !== null && metrics.storeys >= 2) {
      warnings.push(
        `Building has ${metrics.storeys} storeys — multi-storey loading will apply.`,
      )
    }

    return { ok: true, metrics, provider: 'geoscape', warnings }
  }

  // ── Small fetch wrapper ────────────────────────────────────────────
  private async tryGet(
    url: string,
  ): Promise<
    | { ok: true; body: unknown }
    | { ok: false; kind: 'fetch_failed'; cause: unknown }
    | { ok: false; kind: 'http_error'; status: number; bodyText: string }
  > {
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: this.apiKey!, Accept: 'application/json' },
      })
    } catch (e) {
      return { ok: false, kind: 'fetch_failed', cause: e }
    }
    if (!res.ok) {
      let txt = ''
      try {
        txt = await res.text()
      } catch {
        /* ignore */
      }
      return { ok: false, kind: 'http_error', status: res.status, bodyText: txt }
    }
    try {
      const body = await res.json()
      return { ok: true, body }
    } catch {
      return { ok: false, kind: 'http_error', status: res.status, bodyText: '(non-JSON 200)' }
    }
  }

  /** PURE — turn a relative `/v1/…` link into an absolute URL on the
   *  host of `this.baseUrl`. */
  private absoluteLink(relative: string): string {
    try {
      const base = new URL(this.baseUrl)
      return new URL(relative, `${base.protocol}//${base.host}`).toString()
    } catch {
      // baseUrl wasn't a valid URL — fall back to concat.
      return this.baseUrl.replace(/\/v1\/?$/, '') + relative
    }
  }

  // ── Step 1 — address → addressId ───────────────────────────────────
  private async resolveAddressId(
    input: RoofAddressInput,
  ): Promise<
    | { ok: true; addressId: string }
    | (RoofingMeasurementResult & { ok: false })
  > {
    const url =
      `${this.baseUrl}/addresses?addressString=${encodeURIComponent(input.address)}` +
      `&state=${encodeURIComponent(input.state)}&perPage=1`
    const res = await this.tryGet(url)
    if (!res.ok) {
      if (res.kind === 'fetch_failed') {
        return failure('provider_unavailable', friendlyFetchError(res.cause, this.baseUrl))
      }
      if (res.status === 429) return failure('provider_rate_limited', 'Geoscape rate-limited (429).')
      if (res.status === 401 || res.status === 403) {
        return failure(
          'provider_unavailable',
          `Geoscape auth failed (HTTP ${res.status}) — check the API key has Addresses + Buildings products enabled.`,
        )
      }
      return failure('provider_unavailable', `Geoscape address lookup HTTP ${res.status}.`)
    }
    const addressId = pickAddressId(res.body)
    if (!addressId) {
      return failure(
        'address_not_resolved',
        `Geoscape could not resolve the address "${input.address}".`,
      )
    }
    return { ok: true, addressId }
  }

  // ── Step 2 — addressId → building summary → sub-resources ─────────
  private async fetchBuildingDetails(
    addressId: string,
  ): Promise<
    | { ok: true; details: BuildingDetails }
    | (RoofingMeasurementResult & { ok: false })
  > {
    const listUrl = `${this.baseUrl}/buildings?addressId=${encodeURIComponent(addressId)}`
    const listRes = await this.tryGet(listUrl)
    if (!listRes.ok) {
      if (listRes.kind === 'fetch_failed') {
        return failure('provider_unavailable', friendlyFetchError(listRes.cause, this.baseUrl))
      }
      if (listRes.status === 429) return failure('provider_rate_limited', 'Geoscape rate-limited (429).')
      if (listRes.status === 404) {
        return failure('no_building_at_address', 'Geoscape has no building record at this address.')
      }
      if (listRes.status === 401 || listRes.status === 403) {
        return failure(
          'provider_unavailable',
          `Geoscape auth failed (HTTP ${listRes.status}) on Buildings — check the Buildings product is enabled on the key.`,
        )
      }
      return failure('provider_unavailable', `Geoscape buildings list HTTP ${listRes.status}.`)
    }

    const summaries = pickBuildingSummaries(listRes.body)
    if (summaries.length === 0) {
      if (isEmptyDataEnvelope(listRes.body)) {
        return failure('no_building_at_address', 'Geoscape Buildings API returned no records for this address.')
      }
      return failure(
        'provider_invalid_response',
        `Geoscape buildings list returned an unexpected shape. Sample: ${JSON.stringify(listRes.body).slice(0, 280)}`,
      )
    }
    const best = pickBestSummary(summaries)
    if (!best) {
      return failure('provider_invalid_response', 'Geoscape buildings list had no usable summary.')
    }

    // Step 3 — parallel sub-resource fetches.
    // Missing links fall back to canonical paths derived from buildingId.
    const links = best.links
    const footprintLink =
      links.footprint2d ??
      `/v1/buildings/${encodeURIComponent(best.buildingId)}/footprint2d`
    const roofShapeLink =
      links.roofShape ??
      `/v1/buildings/${encodeURIComponent(best.buildingId)}/roofShape`
    const levelsLink =
      links.estimatedLevels ??
      `/v1/buildings/${encodeURIComponent(best.buildingId)}/estimatedLevels`
    const areaLink =
      links.area ??
      `/v1/buildings/${encodeURIComponent(best.buildingId)}/area`

    const [footRes, roofRes, levelsRes, areaRes] = await Promise.all([
      this.tryGet(this.absoluteLink(footprintLink)),
      this.tryGet(this.absoluteLink(roofShapeLink)),
      this.tryGet(this.absoluteLink(levelsLink)),
      this.tryGet(this.absoluteLink(areaLink)),
    ])

    const footprint = footRes.ok ? pickPolygon(footRes.body) : null
    const roofShape = roofRes.ok ? extractRoofShape(roofRes.body) : null
    const storeys = levelsRes.ok ? extractStoreys(levelsRes.body) : null
    const planarArea = areaRes.ok ? extractArea(areaRes.body) : null

    if (!footprint) {
      const sample = footRes.ok
        ? JSON.stringify(footRes.body).slice(0, 280)
        : footRes.kind === 'http_error'
          ? `HTTP ${footRes.status}: ${footRes.bodyText.slice(0, 200)}`
          : 'fetch failed'
      return failure(
        'provider_invalid_response',
        `Geoscape footprint2d returned no polygon. URL: ${this.absoluteLink(footprintLink)} · Sample: ${sample}`,
      )
    }

    return {
      ok: true,
      details: {
        buildingId: best.buildingId,
        footprint,
        roofShape,
        storeys,
        planarArea,
      },
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Pure helpers — exported for unit testing.
// ════════════════════════════════════════════════════════════════════

/** What we end up with after walking the link-based flow. */
export type BuildingDetails = {
  buildingId: string
  footprint: GeoJSONPolygon
  roofShape: string | null
  storeys: number | null
  planarArea: number | null
  /** Optional — present when caller built the shape from a legacy
   *  inline-polygon response that carried a capture date. The live
   *  link-based flow does not expose one. */
  captureDate?: string | null
}

/** Summary returned by /buildings?addressId=. */
export type BuildingSummary = {
  buildingId: string
  relatedAddressCount: number
  links: Record<string, string>
}

/**
 * PURE — pluck the first address id from an Addresses API response.
 * Handles {data:[{addressId|id|pid}]}, {results:[...]}, GeoJSON FeatureCollection,
 * or bare {id|addressId|pid}.
 */
export function pickAddressId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.id === 'string') return b.id
  if (typeof b.addressId === 'string') return b.addressId
  if (typeof b.address_id === 'string') return b.address_id
  if (typeof b.pid === 'string') return b.pid
  const data = (b as { data?: unknown }).data
  if (Array.isArray(data) && data.length > 0) {
    const id = pickAddressId(data[0])
    if (id) return id
  }
  const results = (b as { results?: unknown }).results
  if (Array.isArray(results) && results.length > 0) {
    const id = pickAddressId(results[0])
    if (id) return id
  }
  const features = (b as { features?: unknown }).features
  if (Array.isArray(features) && features.length > 0) {
    const first = features[0] as { properties?: unknown }
    if (first?.properties) {
      const id = pickAddressId(first.properties)
      if (id) return id
    }
  }
  return null
}

/** PURE — does the response represent "no building records"? */
export function isEmptyDataEnvelope(body: unknown): boolean {
  if (Array.isArray(body) && body.length === 0) return true
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (Array.isArray(b.data) && b.data.length === 0) return true
  if (Array.isArray(b.results) && b.results.length === 0) return true
  if (Array.isArray(b.features) && b.features.length === 0) return true
  return false
}

/** PURE — parse the Buildings summary list into BuildingSummary objects. */
export function pickBuildingSummaries(body: unknown): BuildingSummary[] {
  if (!body || typeof body !== 'object') return []
  const b = body as Record<string, unknown>
  const raw =
    (Array.isArray(b.data) && (b.data as unknown[])) ||
    (Array.isArray(b.results) && (b.results as unknown[])) ||
    (Array.isArray(b.buildings) && (b.buildings as unknown[])) ||
    []
  const out: BuildingSummary[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const buildingId =
      pickString(r, ['buildingId', 'building_id', 'buildingPid', 'building_pid', 'pid', 'id'])
    if (!buildingId) continue
    const related = (r.relatedAddressIds ?? r.related_address_ids) as unknown
    const relatedCount = Array.isArray(related) ? related.length : 0
    const links =
      r.links && typeof r.links === 'object' && !Array.isArray(r.links)
        ? Object.fromEntries(
            Object.entries(r.links as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          )
        : {}
    out.push({ buildingId, relatedAddressCount: relatedCount, links })
  }
  return out
}

/**
 * PURE — pick the summary most specific to the queried address.
 *
 * Heuristic: fewest related addresses = tightest scope = most likely
 * the actual property the customer asked about. Tie → first (Geoscape
 * appears to return them in relevance order anyway).
 */
export function pickBestSummary(summaries: BuildingSummary[]): BuildingSummary | null {
  if (summaries.length === 0) return null
  if (summaries.length === 1) return summaries[0]
  return summaries.reduce((best, s) =>
    s.relatedAddressCount < best.relatedAddressCount ? s : best,
  )
}

/** PURE — find a GeoJSON Polygon nested under any documented field. */
export function pickPolygon(b: unknown): GeoJSONPolygon | null {
  if (!b || typeof b !== 'object') return null
  // Bare polygon at the top level
  const top = b as Record<string, unknown>
  if (top.type === 'Polygon' && Array.isArray(top.coordinates)) {
    return { type: 'Polygon', coordinates: top.coordinates as number[][][] }
  }
  // GeoJSON Feature shape
  if (top.type === 'Feature' && top.geometry && typeof top.geometry === 'object') {
    const g = top.geometry as Record<string, unknown>
    if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
      return { type: 'Polygon', coordinates: g.coordinates as number[][][] }
    }
  }
  // Various named keys
  const tryPaths = ['footprint', 'footprint2d', 'geometry', 'polygon', 'roofOutline', 'roof_outline']
  for (const key of tryPaths) {
    const v = top[key]
    if (v && typeof v === 'object') {
      const g = v as Record<string, unknown>
      if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
        return { type: 'Polygon', coordinates: g.coordinates as number[][][] }
      }
    }
  }
  // Wrapped in { data: {...} }
  const data = top.data
  if (data && typeof data === 'object') {
    return pickPolygon(data)
  }
  return null
}

/** PURE — extract the roof shape value from a /roofShape sub-resource
 *  response. The endpoint typically returns `{ roofShape: "hip" }` or
 *  `{ data: { roofShape: "hip" } }`; we also accept a bare string. */
export function extractRoofShape(body: unknown): string | null {
  if (body == null) return null
  if (typeof body === 'string' && body.trim()) return body.trim()
  if (typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const candidates = [
    b.roofShape, b.roof_shape, b.roofForm, b.roof_form, b.form, b.shape,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  if (b.data && typeof b.data === 'object') return extractRoofShape(b.data)
  return null
}

/** PURE — extract a positive integer storey count from the
 *  /estimatedLevels sub-resource. */
export function extractStoreys(body: unknown): number | null {
  if (body == null) return null
  if (typeof body === 'number' && Number.isFinite(body) && body > 0) return Math.round(body)
  if (typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const candidates = [
    b.estimatedLevels, b.estimated_levels, b.storeys, b.numberOfStoreys,
    b.number_of_storeys, b.floors, b.numberOfFloors, b.levels,
  ]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return Math.round(c)
    if (typeof c === 'string') {
      const n = parseFloat(c)
      if (Number.isFinite(n) && n > 0) return Math.round(n)
    }
  }
  if (b.data && typeof b.data === 'object') return extractStoreys(b.data)
  return null
}

/** PURE — extract a positive m² area from the /area sub-resource. */
export function extractArea(body: unknown): number | null {
  if (body == null) return null
  if (typeof body === 'number' && Number.isFinite(body) && body > 0) return body
  if (typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const candidates = [
    b.area, b.planarArea, b.planar_area, b.groundArea, b.ground_area,
    b.buildingArea, b.building_area, b.value,
  ]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c
    if (typeof c === 'string') {
      const n = parseFloat(c)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  if (b.data && typeof b.data === 'object') return extractArea(b.data)
  return null
}

/** PURE — map Geoscape's roof shape string onto our RoofForm enum. */
export function normaliseGeoscapeRoofForm(raw: string | null | undefined): RoofForm {
  if (!raw) return 'unknown'
  const r = raw.toLowerCase()
  if (r.includes('skillion') || r.includes('mono')) return 'skillion'
  if (r.includes('gable') && r.includes('hip')) return 'gable_hip'
  if (r.includes('gable')) return 'gable'
  if (r.includes('hip')) return 'hip'
  if (r.includes('complex') || r.includes('irregular') || r.includes('mansard') || r.includes('dome') || r.includes('flat')) return 'complex'
  return 'unknown'
}

/** PURE — polygon area in m² via shoelace + equirectangular projection. */
export function polygonAreaM2(polygon: GeoJSONPolygon): number {
  const ring = polygon.coordinates?.[0]
  if (!Array.isArray(ring) || ring.length < 4) return 0
  let lat0 = 0
  for (const [, lat] of ring) lat0 += lat
  lat0 /= ring.length
  const cos = Math.cos((lat0 * Math.PI) / 180)
  const mPerDegLat = 110_574
  const mPerDegLng = 111_320 * cos
  let acc = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    const px1 = x1 * mPerDegLng
    const py1 = y1 * mPerDegLat
    const px2 = x2 * mPerDegLng
    const py2 = y2 * mPerDegLat
    acc += px1 * py2 - px2 * py1
  }
  return Math.abs(acc) / 2
}

/** PURE — assemble final RoofMetrics from the sub-resource results. */
export function buildingDetailsToMetrics(
  d: BuildingDetails,
  defaultPitch: PitchBucket,
): RoofMetrics | null {
  const polygon = d.footprint
  const computed = polygonAreaM2(polygon)
  const footprint =
    d.planarArea && d.planarArea > 0 ? d.planarArea : Math.round(computed * 10) / 10
  if (!footprint || footprint <= 0) return null
  const form = normaliseGeoscapeRoofForm(d.roofShape)
  return {
    footprint_m2: Math.round(footprint * 10) / 10,
    sloped_area_m2: slopedAreaFromFootprint(footprint, defaultPitch),
    storeys: d.storeys ?? null,
    form,
    hips: estimateHipsFromForm(form),
    valleys: estimateValleysFromForm(form),
    ridge_lm: null,
    polygon_geojson: polygon,
    capture_date: d.captureDate ?? null,
  }
}

export function estimateHipsFromForm(form: RoofForm): number | null {
  switch (form) {
    case 'gable':     return 0
    case 'hip':       return 4
    case 'skillion':  return 0
    case 'gable_hip': return 2
    case 'complex':   return null
    case 'unknown':   return null
  }
}

export function estimateValleysFromForm(form: RoofForm): number | null {
  switch (form) {
    case 'gable':     return 0
    case 'hip':       return 0
    case 'skillion':  return 0
    case 'gable_hip': return 1
    case 'complex':   return null
    case 'unknown':   return null
  }
}

// ── tiny helpers ─────────────────────────────────────────────────────

function pickString(b: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = b[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

function failure(
  code: RoofingMeasurementFailureCode,
  detail: string,
): RoofingMeasurementResult & { ok: false } {
  return { ok: false, code, detail }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** PURE — turn an undici "fetch failed" into an actionable message. */
export function friendlyFetchError(e: unknown, baseUrl: string): string {
  const msg = errorMessage(e).toLowerCase()
  const causeMsg =
    e && typeof e === 'object' && 'cause' in e
      ? errorMessage((e as { cause?: unknown }).cause).toLowerCase()
      : ''
  const combined = `${msg} ${causeMsg}`
  if (
    combined.includes('enotfound') ||
    combined.includes('econnrefused') ||
    combined.includes('eai_again') ||
    combined.includes('etimedout') ||
    combined.includes('fetch failed')
  ) {
    return (
      `Geoscape host not reachable at ${baseUrl}. ` +
      `Confirm GEOSCAPE_API_BASE_URL in .env.local — the live host is ` +
      `https://api.psma.com.au/v1 (the api.geoscape.com.au domain does not ` +
      `accept API traffic).`
    )
  }
  return `Geoscape network error: ${errorMessage(e)}`
}

// ── Back-compat exports for existing imports + tests ────────────────

export type GeoscapeBuildingBody = {
  footprint: GeoJSONPolygon
  roofForm?: string | null
  storeys?: number | null
  buildingArea?: number | null
  captureDate?: string | null
}

/** Back-compat shim — the previous adapter's body shape, used by some tests. */
export function isGeoscapeBuildingBody(body: unknown): body is GeoscapeBuildingBody {
  return normaliseBuildingBody(body) !== null
}

/**
 * Back-compat — pre-link-flow normaliser that some tests still hit.
 * Handles inline-polygon shapes only; the live flow uses
 * fetchBuildingDetails() + buildingDetailsToMetrics() instead.
 */
export function normaliseBuildingBody(body: unknown): GeoscapeBuildingBody | null {
  if (!body || typeof body !== 'object') return null
  let b = body as Record<string, unknown>
  if (Array.isArray((b as { data?: unknown }).data) && (b as { data: unknown[] }).data.length > 0) {
    const first = (b as { data: unknown[] }).data[0]
    if (first && typeof first === 'object') b = first as Record<string, unknown>
  }
  if ((b as { type?: unknown }).type === 'Feature' && (b as { properties?: unknown }).properties) {
    const props = (b as { properties: Record<string, unknown> }).properties
    const geom = (b as { geometry?: unknown }).geometry
    b = { ...props, geometry: geom }
  }
  if ((b as { type?: unknown }).type === 'FeatureCollection') {
    const feats = (b as { features?: unknown[] }).features ?? []
    if (feats.length > 0) return normaliseBuildingBody(feats[0])
    return null
  }
  const polygon = pickPolygon(b)
  if (!polygon) return null
  return {
    footprint: polygon,
    roofForm: pickString(b, ['roofShape', 'roof_shape', 'roofForm', 'roof_form', 'form']) ?? null,
    storeys: extractStoreys(b),
    buildingArea: extractArea(b),
    captureDate: pickString(b, ['captureDate', 'capture_date', 'imageDate']) ?? null,
  }
}

/** Back-compat — old test imports this. */
export function buildingResponseToMetrics(
  body: GeoscapeBuildingBody,
  defaultPitch: PitchBucket,
): RoofMetrics | null {
  return buildingDetailsToMetrics(
    {
      buildingId: 'legacy',
      footprint: body.footprint,
      roofShape: body.roofForm ?? null,
      storeys: body.storeys ?? null,
      planarArea: body.buildingArea ?? null,
      captureDate: body.captureDate ?? null,
    },
    defaultPitch,
  )
}

/** Back-compat — list-of-ids extractor used by older tests. */
export function pickBuildingIds(body: unknown): string[] {
  const out: string[] = []
  const ID_KEYS = ['buildingId', 'building_id', 'buildingPid', 'building_pid', 'pid', 'id']
  function visit(node: unknown) {
    if (!node) return
    if (typeof node === 'string') {
      if (/^BLD[A-Z]{0,3}\d+/i.test(node) || /^bld[A-Za-z0-9]+/i.test(node) || /^[A-Z]{4,8}\d{6,}/i.test(node)) {
        out.push(node)
      }
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>
      for (const k of ID_KEYS) {
        const v = obj[k]
        if (typeof v === 'string' && v.length > 4) out.push(v)
      }
      for (const k of ['data', 'results', 'buildings', 'features', 'properties']) {
        if (k in obj) visit(obj[k])
      }
    }
  }
  visit(body)
  return Array.from(new Set(out))
}
