'use client'

// ════════════════════════════════════════════════════════════════════
// /dashboard/roofing — Esri-tiled MapLibre map widget.
//
// Renders the Geoscape building polygon on top of free Esri World
// Imagery raster tiles. Three interaction features:
//   • Stat strip in the top-right shows m² / hips / valleys / storeys.
//   • Edges colour-coded by visual class (eave / ridge / hip / valley)
//     using the form-based heuristics in lib/roofing/map-utils.ts.
//   • Click anywhere on the map → onRecenter(lng, lat) fires so the
//     parent page can reverse-geocode + re-measure that address.
//
// Tiles licence: Esri World Imagery is provided under terms that
// permit non-commercial AND commercial use as long as attribution is
// shown — the attribution is wired into the MapLibre control. See:
// https://www.esri.com/en-us/legal/terms/data-attributions
//
// MapLibre is dynamically imported inside useEffect so SSR doesn't try
// to evaluate it (it depends on `window`, Canvas, WebGL). The 'use
// client' directive isn't sufficient on its own — Next 16's RSC tree
// can still parse the import in a server context.
// ════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import type { GeoJSONPolygon, RoofForm, RoofMetrics } from '@/lib/roofing/types'
import {
  classifyEdges,
  paddedBBox,
  polygonBBox,
  polygonCentroid,
  type ClassifiedEdge,
  type EdgeKind,
} from '@/lib/roofing/map-utils'

// ── Edge / fill colours (Maintain palette) ──────────────────────────
const FILL_COLOUR = '#FF5A1F' // accent
const FILL_OPACITY = 0.18
const OUTLINE_COLOUR = '#FF5A1F'
// Paint colours for the MapLibre line layer — these hex values are
// referenced by the GL 'match' expression and cannot be Tailwind classes.
const EDGE_COLOURS: Record<EdgeKind, string> = {
  eave:    '#FFFFFF',
  ridge:   '#FF7A45',
  hip:     '#FF5A1F',
  valley:  '#14B8A6',
  unknown: '#7A8699',
}

// Tailwind classes for the legend swatches — mirror the MapLibre paint
// colours above. Kept as a separate map so the DOM legend can use a
// className-based swatch instead of inline-style backgroundColor.
const EDGE_SWATCH_CLASS: Record<EdgeKind, string> = {
  eave:    'bg-white',
  ridge:   'bg-accent-soft',
  hip:     'bg-accent',
  valley:  'bg-teal-glow',
  unknown: 'bg-text-dim',
}

// Esri World Imagery — raster XYZ tiles, free with attribution.
const ESRI_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const ESRI_ATTRIBUTION =
  '© Esri, Maxar, Earthstar Geographics, and the GIS user community'

type Stats = Pick<RoofMetrics, 'sloped_area_m2' | 'hips' | 'valleys' | 'storeys'> | null

export type RoofMapProps = {
  polygon: GeoJSONPolygon | null
  form: RoofForm
  stats: Stats
  /** Fires when the tradie clicks a different point on the map. */
  onRecenter?: (lng: number, lat: number) => void
  /** Optional CSS class applied to the wrapper. */
  className?: string
}

export function RoofMap({
  polygon,
  form,
  stats,
  onRecenter,
  className,
}: RoofMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // `unknown` here because the MapLibre type is loaded asynchronously
  // — we only ever read .remove() / .fitBounds() / .on() off it.
  const mapRef = useRef<unknown>(null)
  const [ready, setReady] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  // ── Boot MapLibre once on mount ───────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | null = null

    void (async () => {
      if (!containerRef.current) return
      try {
        // Dynamic import — keeps the SSR pass clean and the bundle
        // off the critical path.
        const maplibre = (await import('maplibre-gl')).default
        await import('maplibre-gl/dist/maplibre-gl.css')
        if (cancelled || !containerRef.current) return

        // Default centre: Sydney CBD (we re-fit immediately when a
        // polygon arrives).
        const centroid = polygonCentroid(polygon) ?? [151.2093, -33.8688]

        const map = new maplibre.Map({
          container: containerRef.current,
          style: {
            version: 8,
            sources: {
              'esri-imagery': {
                type: 'raster',
                tiles: [ESRI_TILE_URL],
                tileSize: 256,
                attribution: ESRI_ATTRIBUTION,
                maxzoom: 19,
              },
            },
            layers: [
              { id: 'esri-imagery', type: 'raster', source: 'esri-imagery' },
            ],
          },
          center: centroid,
          zoom: polygon ? 18 : 12,
          // MapLibre v5 — pass an options object (or omit for default-on).
          // `true` is no longer valid here.
          attributionControl: { compact: true },
        })

        map.addControl(new maplibre.NavigationControl(), 'top-left')
        map.on('click', (e: { lngLat: { lng: number; lat: number } }) => {
          onRecenter?.(e.lngLat.lng, e.lngLat.lat)
        })

        map.on('load', () => {
          if (cancelled) return
          setReady(true)
          mapRef.current = map
        })

        cleanup = () => map.remove()
      } catch (e) {
        if (!cancelled) {
          setLoadErr(e instanceof Error ? e.message : String(e))
        }
      }
    })()

    return () => {
      cancelled = true
      if (cleanup) cleanup()
      mapRef.current = null
    }
    // We deliberately boot once and update layers / camera below as
    // props change, so polygon/form are NOT in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Refresh polygon + edges layers whenever polygon/form changes ──
  useEffect(() => {
    if (!ready) return
    const map = mapRef.current as
      | (Record<string, unknown> & {
          getSource: (id: string) => unknown
          addSource: (id: string, src: unknown) => unknown
          getLayer: (id: string) => unknown
          addLayer: (layer: unknown) => unknown
          removeLayer: (id: string) => unknown
          removeSource: (id: string) => unknown
          fitBounds: (
            bounds: [[number, number], [number, number]],
            opts?: { padding?: number; duration?: number; maxZoom?: number },
          ) => unknown
        })
      | null
    if (!map) return

    // Always tear down the prior polygon/edge layers before redrawing.
    safeRemoveLayer(map, 'roof-edges')
    safeRemoveLayer(map, 'roof-outline')
    safeRemoveLayer(map, 'roof-fill')
    safeRemoveSource(map, 'roof-polygon')
    safeRemoveSource(map, 'roof-edges-source')

    if (!polygon) return

    map.addSource('roof-polygon', {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: polygon },
    })
    map.addLayer({
      id: 'roof-fill',
      type: 'fill',
      source: 'roof-polygon',
      paint: { 'fill-color': FILL_COLOUR, 'fill-opacity': FILL_OPACITY },
    })
    map.addLayer({
      id: 'roof-outline',
      type: 'line',
      source: 'roof-polygon',
      paint: { 'line-color': OUTLINE_COLOUR, 'line-width': 2 },
    })

    // Per-edge classified lines — each edge is its own LineString
    // feature so we can colour them independently. Skip when the form
    // is too complex to classify (avoids a confusing rainbow).
    const edges = classifyEdges(polygon, form)
    const features = edges.map((e: ClassifiedEdge, i: number) => ({
      type: 'Feature' as const,
      properties: { kind: e.kind, idx: i, length_m: e.length_m },
      geometry: {
        type: 'LineString' as const,
        coordinates: [e.from, e.to],
      },
    }))
    map.addSource('roof-edges-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    })
    map.addLayer({
      id: 'roof-edges',
      type: 'line',
      source: 'roof-edges-source',
      paint: {
        'line-color': [
          'match',
          ['get', 'kind'],
          'eave',    EDGE_COLOURS.eave,
          'ridge',   EDGE_COLOURS.ridge,
          'hip',     EDGE_COLOURS.hip,
          'valley',  EDGE_COLOURS.valley,
          /* default */ EDGE_COLOURS.unknown,
        ],
        'line-width': 4,
        'line-opacity': 0.92,
      },
    })

    const bb = polygonBBox(polygon)
    if (bb) {
      const padded = paddedBBox(bb, 0.5)
      map.fitBounds(
        [
          [padded.west, padded.south],
          [padded.east, padded.north],
        ],
        { padding: 24, duration: 400, maxZoom: 19 },
      )
    }
  }, [ready, polygon, form])

  return (
    <div className={`relative w-full ${className ?? ''}`}>
      <div
        ref={containerRef}
        role="presentation"
        className="h-112 w-full border border-ink-line bg-ink-card sm:h-128"
      />

      {/* Stat strip — top-right floating panel */}
      {stats && (
        <div className="pointer-events-none absolute right-4 top-4 max-w-[18rem] border border-ink-line bg-ink-deep/95 p-4 backdrop-blur">
          <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
            Geoscape measurement
          </div>
          <ul className="mt-3 space-y-2 font-mono text-base">
            <StatRow label="Sloped area" value={
              stats.sloped_area_m2 !== null ? `${stats.sloped_area_m2.toFixed(0)} m²` : '—'
            } />
            <StatRow label="Hips" value={fmtCount(stats.hips)} />
            <StatRow label="Valleys" value={fmtCount(stats.valleys)} />
            <StatRow label="Storeys" value={fmtCount(stats.storeys)} />
          </ul>
        </div>
      )}

      {/* Legend — bottom-left edge colours */}
      {polygon && (
        <div className="pointer-events-none absolute bottom-4 left-4 border border-ink-line bg-ink-deep/95 p-3 backdrop-blur">
          <div className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
            Edge legend
          </div>
          <ul className="mt-2 grid gap-1.5 text-xs text-text-sec">
            <Legend swatchClass={EDGE_SWATCH_CLASS.eave}    label="Eave" />
            <Legend swatchClass={EDGE_SWATCH_CLASS.ridge}   label="Ridge / gable end" />
            <Legend swatchClass={EDGE_SWATCH_CLASS.hip}     label="Hip (heuristic)" />
            <Legend swatchClass={EDGE_SWATCH_CLASS.valley}  label="Valley (heuristic)" />
          </ul>
        </div>
      )}

      {/* Click-to-recenter hint */}
      {onRecenter && (
        <div className="pointer-events-none absolute bottom-4 right-4 border border-ink-line bg-ink-deep/95 px-3 py-2 backdrop-blur">
          <span className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
            Click any building to re-measure
          </span>
        </div>
      )}

      {loadErr && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink-deep/80 p-4 text-center">
          <p className="max-w-md text-base text-text-sec">
            Map could not load: {loadErr}
          </p>
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-baseline justify-between gap-4">
      <span className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-text-dim">
        {label}
      </span>
      <span className="font-bold text-text-pri">{value}</span>
    </li>
  )
}

function Legend({ swatchClass, label }: { swatchClass: string; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden="true" className={`inline-block h-1 w-5 ${swatchClass}`} />
      <span>{label}</span>
    </li>
  )
}

function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return String(n)
}

function safeRemoveLayer(
  map: { getLayer: (id: string) => unknown; removeLayer: (id: string) => unknown },
  id: string,
) {
  try {
    if (map.getLayer(id)) map.removeLayer(id)
  } catch {
    /* ignore — MapLibre throws when the map is mid-teardown */
  }
}

function safeRemoveSource(
  map: { getSource: (id: string) => unknown; removeSource: (id: string) => unknown },
  id: string,
) {
  try {
    if (map.getSource(id)) map.removeSource(id)
  } catch {
    /* ignore */
  }
}
