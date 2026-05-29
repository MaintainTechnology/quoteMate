'use client'

// /dashboard/roofing/measure — standalone roofing-measurement tool.
//
// Tradie types an address + picks material/pitch/intent → hits the
// /api/roofing/measure route → sees the structured measurement +
// 3-tier price band on screen. No customer involvement; this is the
// tradie's own discovery surface for cold-lead estimates.
//
// Maintain Technology design system — dark navy command-centre, orange
// accent, generous typography, numbered cards.

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { getBrowserSupabase } from '@/lib/supabase/client'
import type { RoofMetrics, RoofingQuotePrice } from '@/lib/roofing/types'
import { RoofMap } from '../_components/RoofMap'

type MeasureResponse =
  | {
      ok: true
      provider: 'geoscape' | 'lidar' | 'mock' | 'manual'
      metrics: RoofMetrics
      price: RoofingQuotePrice
      warnings: string[]
    }
  | { ok: false; code: string; detail: string }
  | { ok: false; error: string }

const MATERIALS = [
  ['colorbond_trimdek',  'Colorbond Trimdek'],
  ['colorbond_kliplok',  'Colorbond Klip-Lok 700'],
  ['concrete_tile',      'Concrete tile'],
  ['terracotta_tile',    'Terracotta tile'],
  ['cement_sheet',       'Cement sheet (asbestos-suspect)'],
  ['unknown',            'Unknown — confirm on-site'],
] as const

const PITCHES = [
  ['shallow',     'Shallow (under 20°)'],
  ['standard',    'Standard (20–25°, the AU norm)'],
  ['steep',       'Steep (26–35°)'],
  ['very_steep',  'Very steep (over 35°) — forces inspection'],
  ['unknown',     'Unknown — forces inspection'],
] as const

const INTENTS = [
  ['full_reroof',     'Full re-roof'],
  ['patch_repair',    'Patch / spot repair'],
  ['leak_trace',      'Leak trace + minor repair'],
  ['gutter_replace',  'Gutter + downpipe replace'],
  ['ridge_cap',       'Ridge / hip cap rebed'],
  ['flashing_repair', 'Flashing repair'],
] as const

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'] as const

export default function RoofingMeasurePage() {
  const [token, setToken] = useState<string | null>(null)
  const [authState, setAuthState] = useState<'loading' | 'signed-out' | 'ready'>(
    'loading',
  )

  const [address, setAddress] = useState('')
  const [postcode, setPostcode] = useState('')
  const [state, setState] = useState<(typeof STATES)[number]>('NSW')
  const [material, setMaterial] = useState<(typeof MATERIALS)[number][0]>('colorbond_trimdek')
  const [pitch, setPitch] = useState<(typeof PITCHES)[number][0]>('standard')
  const [intent, setIntent] = useState<(typeof INTENTS)[number][0]>('full_reroof')
  const [yearBuilt, setYearBuilt] = useState<string>('')
  const [useMock, setUseMock] = useState(false)

  const [busy, setBusy] = useState(false)
  const [resp, setResp] = useState<MeasureResponse | null>(null)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  useEffect(() => {
    const sb = getBrowserSupabase()
    sb.auth.getSession().then(({ data: { session } }) => {
      const t = session?.access_token ?? null
      setToken(t)
      setAuthState(t ? 'ready' : 'signed-out')
    })
  }, [])

  /** Single-source measure runner — both the form submit path and the
   *  click-on-map-to-recenter path call this with their own address
   *  triple. Keeps the request shape in one place. */
  const runMeasure = useCallback(
    async (overrides?: {
      address?: string
      postcode?: string
      state?: (typeof STATES)[number]
    }) => {
      if (!token) {
        setErrMsg('Sign in to use the measurement tool.')
        return
      }
      const a = overrides?.address ?? address
      const pc = overrides?.postcode ?? postcode
      const st = overrides?.state ?? state
      setBusy(true)
      setErrMsg(null)
      setResp(null)
      try {
        const res = await fetch('/api/roofing/measure', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            address: { address: a, postcode: pc, state: st },
            inputs: {
              material,
              pitch,
              intent,
              building_year_built: yearBuilt ? Number(yearBuilt) : null,
            },
            use_mock_provider: useMock,
          }),
        })
        const json = (await res.json()) as MeasureResponse
        setResp(json)
        if (!('ok' in json) || json.ok !== true) {
          if ('detail' in json) setErrMsg(json.detail)
          else if ('error' in json) setErrMsg(json.error)
        }
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [token, address, postcode, state, material, pitch, intent, yearBuilt, useMock],
  )

  const onMeasure = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      await runMeasure()
    },
    [runMeasure],
  )

  /** Click on the map → reverse-geocode → re-run measure with the new
   *  address. Failures fall back to a polite error message. */
  const onMapRecenter = useCallback(
    async (lng: number, lat: number) => {
      if (!token) {
        setErrMsg('Sign in to use the measurement tool.')
        return
      }
      try {
        const res = await fetch('/api/roofing/reverse-geocode', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ lng, lat }),
        })
        const json = (await res.json()) as
          | { ok: true; address: string; postcode: string | null; state: typeof STATES[number] | null }
          | { ok: false; code: string; detail: string }
        if (!json.ok) {
          setErrMsg(json.detail)
          return
        }
        const nextAddr = json.address
        const nextPc = json.postcode ?? postcode
        const nextSt = (json.state ?? state) as (typeof STATES)[number]
        setAddress(nextAddr)
        setPostcode(nextPc)
        setState(nextSt)
        await runMeasure({ address: nextAddr, postcode: nextPc, state: nextSt })
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : String(e))
      }
    },
    [token, postcode, state, runMeasure],
  )

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      <TopographicBackdrop />

      {/* ── Header ─────────────────────────────────────────────── */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 pt-14 pb-10 sm:px-10 md:pt-20">
        <Breadcrumb />

        <div className="mt-8 grid gap-10 md:grid-cols-[1.5fr_1fr] md:items-end md:gap-16">
          <h1 className="font-extrabold uppercase leading-[0.95] tracking-[-0.035em] text-[clamp(2.5rem,5.5vw,4.5rem)]">
            Roof <span className="text-accent">measure</span>
          </h1>
          <p className="max-w-md text-base leading-relaxed text-text-sec md:text-lg">
            Type an address, declare the material and pitch, get back a
            Geoscape-derived sloped area plus a three-tier price band at your
            current rates. Phase 1 — every roofing quote needs your sign-off
            before send.
          </p>
        </div>

        <AuthBadge state={authState} />
      </section>

      {/* ── Measurement form ───────────────────────────────────── */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 sm:px-10">
        <form
          onSubmit={onMeasure}
          className="grid gap-7 border border-ink-line bg-ink-card p-7 sm:p-9 md:grid-cols-2"
        >
          <div className="md:col-span-2">
            <Label>Property address</Label>
            <input
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="e.g. 27 Smith Street, Penrith"
              className={INPUT}
            />
          </div>

          <div>
            <Label>Postcode</Label>
            <input
              required
              value={postcode}
              onChange={(e) => setPostcode(e.target.value.trim())}
              placeholder="2750"
              pattern="\d{4}"
              maxLength={4}
              className={INPUT}
            />
          </div>

          <div>
            <Label>State</Label>
            <select
              aria-label="State"
              value={state}
              onChange={(e) => setState(e.target.value as (typeof STATES)[number])}
              className={INPUT}
            >
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label>Roof material</Label>
            <select
              aria-label="Roof material"
              value={material}
              onChange={(e) =>
                setMaterial(e.target.value as (typeof MATERIALS)[number][0])
              }
              className={INPUT}
            >
              {MATERIALS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label>Roof pitch</Label>
            <select
              aria-label="Roof pitch"
              value={pitch}
              onChange={(e) =>
                setPitch(e.target.value as (typeof PITCHES)[number][0])
              }
              className={INPUT}
            >
              {PITCHES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label>Job intent</Label>
            <select
              aria-label="Job intent"
              value={intent}
              onChange={(e) =>
                setIntent(e.target.value as (typeof INTENTS)[number][0])
              }
              className={INPUT}
            >
              {INTENTS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label>Year built (optional)</Label>
            <input
              type="number"
              min={1850}
              max={2100}
              value={yearBuilt}
              onChange={(e) => setYearBuilt(e.target.value)}
              placeholder="1985"
              className={INPUT}
            />
          </div>

          <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-5 pt-2">
            <label className="inline-flex cursor-pointer items-center gap-3 text-text-sec">
              <input
                type="checkbox"
                checked={useMock}
                onChange={(e) => setUseMock(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              <span className="font-mono text-sm font-semibold uppercase tracking-[0.14em]">
                Use mock provider (demo / no live Geoscape call)
              </span>
            </label>
            <button
              type="submit"
              disabled={busy || authState !== 'ready'}
              className="inline-flex items-center gap-2 bg-accent px-6 py-3.5 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Spinner /> Measuring…
                </>
              ) : (
                <>
                  Measure roof <span aria-hidden="true">&rarr;</span>
                </>
              )}
            </button>
          </div>
        </form>

        {errMsg && (
          <Notice tone="warn" label="Measurement could not complete">
            {errMsg}
          </Notice>
        )}
      </section>

      {/* ── Results ────────────────────────────────────────────── */}
      {resp && resp.ok === true && (
        <ResultBlock
          metrics={resp.metrics}
          price={resp.price}
          provider={resp.provider}
          warnings={resp.warnings}
          onMapRecenter={onMapRecenter}
        />
      )}

      <div className="relative z-10 bg-accent px-6 py-5 text-center text-white">
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.16em]">
          QuoteMate · Roof measure · Phase 1
        </span>
      </div>
    </main>
  )
}

// ─── Result panel ───────────────────────────────────────────────────

function ResultBlock({
  metrics,
  price,
  provider,
  warnings,
  onMapRecenter,
}: {
  metrics: RoofMetrics
  price: RoofingQuotePrice
  provider: 'geoscape' | 'lidar' | 'mock' | 'manual'
  warnings: string[]
  onMapRecenter: (lng: number, lat: number) => void | Promise<void>
}) {
  const routing = price.routing
  const routingTone =
    routing.decision === 'inspection_required' ? 'warn' :
    routing.decision === 'auto_quote' ? 'good' : 'accent'

  return (
    <section className="relative z-10 mx-auto mt-12 max-w-6xl px-6 pb-20 sm:px-10 md:pb-24">
      <SectionHeading
        eyebrow={`Measurement from ${provider}`}
        title="Roof metrics + price band"
      />

      {/* Map — Esri satellite + Geoscape polygon overlay */}
      <div className="mt-8">
        <RoofMap
          polygon={metrics.polygon_geojson}
          form={metrics.form}
          stats={{
            sloped_area_m2: metrics.sloped_area_m2,
            hips: metrics.hips,
            valleys: metrics.valleys,
            storeys: metrics.storeys,
          }}
          onRecenter={onMapRecenter}
        />
        {!metrics.polygon_geojson && (
          <p className="mt-3 text-sm text-text-dim">
            No polygon attached to this measurement — switch off the mock
            provider once Geoscape is wired to see the building outline on
            the map.
          </p>
        )}
      </div>

      {/* Routing strip */}
      <div className={`mt-8 border border-ink-line border-l-4 ${routingBorder(routingTone)} bg-ink-card px-6 py-5 sm:px-8`}>
        <div className={`font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] ${routingLabelColour(routingTone)}`}>
          Routing decision · {routing.decision.replace('_', ' ')}
        </div>
        <p className="mt-1 text-base text-text-sec">{routing.reason}</p>
      </div>

      {/* Metric grid */}
      <div className="mt-8 grid gap-6 sm:grid-cols-2 md:grid-cols-3">
        <Stat
          eyebrow="Sloped area"
          value={metrics.sloped_area_m2 !== null ? `${metrics.sloped_area_m2.toFixed(0)} m²` : '—'}
          hint={metrics.footprint_m2 ? `Footprint ${metrics.footprint_m2.toFixed(0)} m²` : ''}
        />
        <Stat eyebrow="Roof form" value={metrics.form} hint={metrics.capture_date ? `Captured ${metrics.capture_date}` : ''} />
        <Stat
          eyebrow="Hips · valleys"
          value={`${metrics.hips ?? '?'} · ${metrics.valleys ?? '?'}`}
          hint={metrics.storeys !== null ? `${metrics.storeys}-storey` : ''}
        />
      </div>

      {/* Tier price grid */}
      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {price.tiers.map((t, i) => (
          <article
            key={t.tier}
            className="flex h-full flex-col border border-ink-line bg-ink-card p-7 sm:p-8"
          >
            <span className="font-mono text-5xl font-bold leading-none text-accent">
              {['01', '02', '03'][i]}
            </span>
            <div className="mt-5 font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
              {t.tier} tier
            </div>
            <h3 className="mt-2 font-extrabold uppercase tracking-[-0.02em] text-2xl text-text-pri">
              {t.label}
            </h3>
            <div className="mt-6 border-t border-ink-line pt-5">
              <div className="font-mono text-4xl font-bold tabular-nums leading-none text-accent sm:text-5xl">
                ${formatMoney(t.inc_gst)}
              </div>
              <div className="mt-3 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-text-dim">
                inc GST · ${formatMoney(t.ex_gst)} ex GST
              </div>
            </div>
            <p className="mt-6 text-base leading-relaxed text-text-sec">{t.scope}</p>
          </article>
        ))}
      </div>

      {/* Loadings + warnings */}
      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <div className="border border-ink-line bg-ink-card p-7 sm:p-8">
          <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
            Effective rate
          </div>
          <div className="mt-3 font-mono text-3xl font-bold tabular-nums text-text-pri sm:text-4xl">
            ${formatMoney(price.effective_rate_per_m2)} <span className="text-base text-text-dim">/ m²</span>
          </div>
          <p className="mt-4 text-base text-text-sec">
            Applied to {price.area_m2.toFixed(0)} m² of sloped roof area.
          </p>
          {price.loadings_applied.length > 0 ? (
            <ul className="mt-5 space-y-2 text-base text-text-sec">
              {price.loadings_applied.map((l) => (
                <li key={l.code} className="flex items-baseline gap-3">
                  <span className="text-accent">+</span>
                  <span>{l.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-5 text-base text-text-dim">No loadings applied.</p>
          )}
        </div>

        <div className="border border-ink-line bg-ink-card p-7 sm:p-8">
          <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
            Provider warnings
          </div>
          {warnings.length === 0 ? (
            <p className="mt-3 text-base text-text-dim">
              No warnings — measurement looks clean.
            </p>
          ) : (
            <ul className="mt-3 space-y-2 text-base text-text-sec">
              {warnings.map((w, i) => (
                <li key={i} className="flex items-baseline gap-3">
                  <span className="text-accent">·</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

// ─── Small UI bits ──────────────────────────────────────────────────

function Breadcrumb() {
  return (
    <div className="flex flex-wrap items-center gap-3 font-mono text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-text-dim">
      <Link href="/dashboard" className="transition-colors hover:text-text-pri">
        Dashboard
      </Link>
      <span className="text-ink-line">/</span>
      <Link href="/dashboard?tab=roofing" className="transition-colors hover:text-text-pri">
        Roof
      </Link>
      <span className="text-ink-line">/</span>
      <span className="text-text-pri">Measure</span>
    </div>
  )
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="font-mono text-[0.8rem] font-semibold uppercase tracking-[0.18em] text-accent">
        {eyebrow}
      </div>
      <h2 className="mt-3 font-extrabold uppercase tracking-[-0.025em] text-[clamp(1.5rem,2.6vw,2.25rem)] leading-[1.1]">
        {title}
      </h2>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
      {children}
    </div>
  )
}

function Stat({
  eyebrow,
  value,
  hint,
}: {
  eyebrow: string
  value: string
  hint?: string
}) {
  return (
    <div className="border border-ink-line bg-ink-card p-6">
      <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
        {eyebrow}
      </div>
      <div className="mt-3 font-mono text-3xl font-bold tabular-nums text-text-pri">
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-sm text-text-dim">
          {hint}
        </div>
      )}
    </div>
  )
}

function Notice({
  tone,
  label,
  children,
}: {
  tone: 'warn' | 'accent'
  label: string
  children: React.ReactNode
}) {
  const border = tone === 'warn' ? 'border-l-warning' : 'border-l-accent'
  const labelColour = tone === 'warn' ? 'text-warning' : 'text-accent'
  return (
    <div className={`mt-6 border border-ink-line ${border} border-l-4 bg-ink-card px-5 py-4`}>
      <div className={`font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] ${labelColour}`}>
        {label}
      </div>
      <p className="mt-1 text-base text-text-sec">{children}</p>
    </div>
  )
}

function AuthBadge({
  state,
}: {
  state: 'loading' | 'signed-out' | 'ready'
}) {
  const label =
    state === 'loading' ? 'Checking session…' :
    state === 'signed-out' ? 'Not signed in — sign in to measure' :
    'Signed in — ready to measure'
  const dot =
    state === 'ready' ? 'bg-teal-glow' :
    state === 'signed-out' ? 'bg-accent' : 'bg-text-dim'
  return (
    <div className="mt-10 inline-flex items-center gap-3 border border-ink-line bg-ink-card px-5 py-3">
      <span className={`h-2.5 w-2.5 ${dot}`} aria-hidden="true" />
      <span className="font-mono text-sm font-semibold uppercase tracking-[0.14em] text-text-sec">
        {label}
      </span>
    </div>
  )
}

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin border-2 border-white/40 border-t-white"
      aria-hidden="true"
    />
  )
}

function routingBorder(t: 'warn' | 'good' | 'accent'): string {
  if (t === 'warn')   return 'border-l-warning'
  if (t === 'good')   return 'border-l-teal-glow'
  return 'border-l-accent'
}
function routingLabelColour(t: 'warn' | 'good' | 'accent'): string {
  if (t === 'warn')   return 'text-warning'
  if (t === 'good')   return 'text-teal-glow'
  return 'text-accent'
}

function formatMoney(n: number): string {
  return n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const INPUT =
  'w-full border border-ink-line bg-ink-deep px-4 py-3 font-mono text-base text-text-pri placeholder:text-text-dim focus:border-accent focus:outline-none'

function TopographicBackdrop() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.16]"
      viewBox="0 0 1920 1080"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="roof-topo-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#14B8A6" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#14B8A6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="url(#roof-topo-fade)" strokeWidth="1" fill="none">
        <path d="M0,820 Q220,700 460,760 T940,720 T1420,760 T1920,700" />
        <path d="M0,760 Q220,640 460,700 T940,660 T1420,700 T1920,640" />
        <path d="M0,700 Q220,580 460,640 T940,600 T1420,640 T1920,580" />
        <path d="M0,640 Q220,520 460,580 T940,540 T1420,580 T1920,520" />
        <path d="M0,580 Q220,460 460,520 T940,480 T1420,520 T1920,460" />
      </g>
    </svg>
  )
}
