// ════════════════════════════════════════════════════════════════════
// Roofing — reverse-geocoding helper.
//
// When the tradie clicks a different building on the map, we need to
// turn the {lng, lat} pair back into a street address so the existing
// /api/roofing/measure pipeline can be re-run with a new address.
//
// Phase 1: Nominatim (OSM-based, free, no API key). Two things to know
// about Nominatim's terms of service:
//   • Recommended max ~1 req/sec — fine for a manual tradie click.
//   • A User-Agent identifying the app is requested. Browsers can't
//     set User-Agent, so this helper runs SERVER-SIDE only and we set
//     it explicitly. The route at /api/roofing/reverse-geocode wraps
//     this and the client never calls Nominatim directly.
//
// PURE-ish: I/O lives behind an injectable fetch impl, so the
// response-parsing logic is unit-testable without network.
// ════════════════════════════════════════════════════════════════════

const DEFAULT_NOMINATIM_URL =
  process.env.NOMINATIM_API_URL ?? 'https://nominatim.openstreetmap.org/reverse'

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type ReverseGeocodeInput = {
  lng: number
  lat: number
}

export type ReverseGeocodeResult =
  | {
      ok: true
      address: string
      postcode: string | null
      state: 'NSW' | 'VIC' | 'QLD' | 'SA' | 'WA' | 'TAS' | 'ACT' | 'NT' | null
      raw: NominatimAddress | null
    }
  | {
      ok: false
      code: 'invalid_input' | 'no_result' | 'network_error' | 'provider_error'
      detail: string
    }

export type ReverseGeocodeOpts = {
  fetchImpl?: FetchLike
  baseUrl?: string
  userAgent?: string
}

/** Raw Nominatim address sub-object — the bits we use. */
export type NominatimAddress = {
  house_number?: string
  road?: string
  suburb?: string
  city?: string
  town?: string
  village?: string
  state?: string
  postcode?: string
  country_code?: string
}

/** PURE — coerce Nominatim's state name onto our AU state enum. */
export function normaliseAuState(
  state: string | undefined | null,
): ReverseGeocodeResult extends { ok: true; state: infer S } ? S : never {
  if (!state) return null as never
  const s = state.trim().toUpperCase()
  if (s === 'NEW SOUTH WALES' || s === 'NSW') return 'NSW' as never
  if (s === 'VICTORIA' || s === 'VIC') return 'VIC' as never
  if (s === 'QUEENSLAND' || s === 'QLD') return 'QLD' as never
  if (s === 'SOUTH AUSTRALIA' || s === 'SA') return 'SA' as never
  if (s === 'WESTERN AUSTRALIA' || s === 'WA') return 'WA' as never
  if (s === 'TASMANIA' || s === 'TAS') return 'TAS' as never
  if (s === 'AUSTRALIAN CAPITAL TERRITORY' || s === 'ACT') return 'ACT' as never
  if (s === 'NORTHERN TERRITORY' || s === 'NT') return 'NT' as never
  return null as never
}

/** PURE — compose the human-readable street address from Nominatim's
 *  fragmented fields. Used when display_name is missing or too noisy. */
export function composeAddress(addr: NominatimAddress | undefined | null): string {
  if (!addr) return ''
  const parts: string[] = []
  const number = addr.house_number?.trim() ?? ''
  const road = addr.road?.trim() ?? ''
  if (number && road) parts.push(`${number} ${road}`)
  else if (road) parts.push(road)
  const locality = addr.suburb?.trim() ?? addr.city?.trim() ?? addr.town?.trim() ?? addr.village?.trim() ?? ''
  if (locality) parts.push(locality)
  if (addr.state?.trim()) parts.push(addr.state.trim())
  if (addr.postcode?.trim()) parts.push(addr.postcode.trim())
  return parts.join(', ')
}

/** PURE — parse a Nominatim reverse-geocode response body. */
export function parseNominatimResponse(body: unknown): ReverseGeocodeResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'provider_error', detail: 'Nominatim returned a non-object body.' }
  }
  const b = body as Record<string, unknown>
  if (typeof b.error === 'string') {
    return { ok: false, code: 'no_result', detail: b.error }
  }
  const addr = b.address as NominatimAddress | undefined
  // Only accept AU results — we are a roofing tool for Australia.
  if (addr?.country_code && addr.country_code.toLowerCase() !== 'au') {
    return { ok: false, code: 'no_result', detail: 'Coordinate is outside Australia.' }
  }
  const composed = composeAddress(addr)
  const display = typeof b.display_name === 'string' ? b.display_name : ''
  const address = composed || display
  if (!address) {
    return { ok: false, code: 'no_result', detail: 'No address returned for the supplied coordinate.' }
  }
  const postcode = addr?.postcode?.trim() || null
  const state = normaliseAuState(addr?.state)
  return {
    ok: true,
    address,
    postcode,
    state: (state ?? null) as ReverseGeocodeResult extends { ok: true; state: infer S } ? S : never,
    raw: addr ?? null,
  }
}

/** PURE — validate the input coords are reasonable. */
export function validateCoords(input: ReverseGeocodeInput): string | null {
  if (!Number.isFinite(input.lng) || !Number.isFinite(input.lat)) return 'Coordinates must be finite numbers.'
  if (input.lng < -180 || input.lng > 180) return 'Longitude is out of range (−180 to 180).'
  if (input.lat < -90 || input.lat > 90) return 'Latitude is out of range (−90 to 90).'
  // AU is roughly 110°E to 155°E and -10°S to -44°S. Reject anything
  // wildly outside this so a typo doesn't burn a Nominatim call.
  if (input.lng < 110 || input.lng > 155 || input.lat < -45 || input.lat > -9) {
    return 'Coordinate is outside the Australian bounding box.'
  }
  return null
}

/** Reverse-geocode the supplied coordinate. Best-effort surface —
 *  any network/provider failure surfaces as { ok: false, code }. */
export async function reverseGeocode(
  input: ReverseGeocodeInput,
  opts: ReverseGeocodeOpts = {},
): Promise<ReverseGeocodeResult> {
  const invalid = validateCoords(input)
  if (invalid) {
    return { ok: false, code: 'invalid_input', detail: invalid }
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_NOMINATIM_URL
  const url =
    `${baseUrl}?lat=${encodeURIComponent(input.lat.toFixed(6))}` +
    `&lon=${encodeURIComponent(input.lng.toFixed(6))}` +
    `&format=jsonv2&addressdetails=1&countrycodes=au`
  const ua = opts.userAgent ?? 'QuoteMate/1.0 (https://quote-mate-rho.vercel.app)'
  const fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init))

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': ua, Accept: 'application/json' },
    })
  } catch (e) {
    return {
      ok: false,
      code: 'network_error',
      detail: e instanceof Error ? e.message : String(e),
    }
  }
  if (!res.ok) {
    return { ok: false, code: 'provider_error', detail: `Nominatim HTTP ${res.status}` }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, code: 'provider_error', detail: 'Nominatim returned non-JSON.' }
  }
  return parseNominatimResponse(body)
}
