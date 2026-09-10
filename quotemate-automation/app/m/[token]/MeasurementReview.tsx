'use client'

// Interactive structure picker for the Measurement Results page (/m/[token]).
// Each structure has an include/exclude toggle; toggling persists to
// PATCH /api/roofing/measurement/[token] (which recomputes the denormalised
// summary and invalidates the cached PDF), so the customer quote + PDF always
// reflect the tradie's selection. At least one structure must stay included.
//
// Indices are 1-based (matches included_indices + narrowQuoteToStructures).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { MultiRoofQuote, RoofMetrics, RoofStructurePrice } from '@/lib/roofing/types'
import type { SolarQuoteAddon } from '@/lib/roofing/solar'
import type { SaveAsQuoteRequest } from '@/lib/roofing/save-as-quote-schema'
import { combinedTotalsForIndices } from '@/lib/roofing/selection'
// Pure pricing helpers — the SAME functions the server reprice uses, so the
// dependent-value preview can never drift from what saving will produce.
import {
  footprintPerimeterM,
  perEdgeLength,
  pitchBucketFromDegrees,
  slopedAreaFromFootprint,
} from '@/lib/roofing/pricing'
import { getAuthToken } from '@/lib/auth/client-token'

/** The PATCH `edges` entry (sans index) — dirty fields only for the new
 *  measurement/accessory overrides; undefined = keep the stored value. */
type EdgePatch = {
  hips: number | null
  valleys: number | null
  box_gutter_lm: number | null
  gutter_lm?: number | null
  downpipe_count?: number | null
  fascia_lm?: number | null
  soffit_lm?: number | null
  pitch_degrees?: number
  sloped_area_m2?: number
  form?: RoofMetrics['form']
  storeys?: number
}

function money(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  return n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

/** Read a browser File into base64 (no data: prefix) + its mime, for the
 *  solar photo re-scan POST. */
function fileToBase64(file: File): Promise<{ base64: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const base64 = result.includes(',') ? result.split(',')[1] : result
      resolve({ base64, mime: file.type || 'image/jpeg' })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function formLabel(form: RoofMetrics['form']): string {
  switch (form) {
    case 'gable': return 'Gable'
    case 'hip': return 'Hip'
    case 'skillion': return 'Skillion'
    case 'gable_hip': return 'Gable + hip'
    case 'complex': return 'Complex'
    default: return 'Not classified'
  }
}

/** Friendly provenance for a measured field's source. */
function sourceLabel(s: string | undefined): string {
  switch (s) {
    case 'google_solar': return 'Google Solar'
    case 'geoscape': return 'Geoscape estimate'
    case 'declared': return 'you declared'
    case 'derived': return 'derived'
    default: return ''
  }
}

const TIER_NAME: Record<'good' | 'better' | 'best', string> = {
  good: 'Patch',
  better: 'Full roof replacement',
  best: 'Upgraded roof replacement',
}

/**
 * PURE — combined inc/ex-GST + area over the INCLUDED structures (1-based).
 * Delegates to THE canonical helper so this tradie-facing total matches the
 * customer quote page + PDF exactly: inspection-routed structures stay listed
 * but are never priced into the headline total, and the job-level solar
 * detach & reinstate allowance is included on the replacement tiers (the
 * customer sees those solar-inclusive totals — so must the tradie).
 */
function combine(
  structures: RoofStructurePrice[],
  included: number[],
  solar: SolarQuoteAddon | null,
): { count: number; area: number; exGst: [number, number, number]; incGst: [number, number, number] } {
  return combinedTotalsForIndices({ structures, solar } as unknown as MultiRoofQuote, included)
}

export function MeasurementReview({
  measurementVersion,
  measureToken,
  publicToken,
  routing,
  structures,
  solar,
  initialIncluded,
  primaryIndices,
  selectionWasPersisted,
  quoteShareToken,
  saveAsQuoteBody,
}: {
  measurementVersion: string
  measureToken: string
  publicToken: string
  routing: string | null
  structures: RoofStructurePrice[]
  initialIncluded: number[]
  /** 1-based index of the main dwelling (the roof-only default selection). */
  primaryIndices: number[]
  /** Persisted existing-solar/skylight detection + allowance (job level). */
  solar: SolarQuoteAddon | null
  /** True when included_indices was actually saved (vs the read-time default). */
  selectionWasPersisted: boolean
  /** Set once this measurement was promoted to an editable quotes row (R6). */
  quoteShareToken: string | null
  /** Server-flattened save-as-quote body; null when the row can't produce one. */
  saveAsQuoteBody: Pick<SaveAsQuoteRequest, 'expected_pricing_revision'> | null
}) {
  const [included, setIncluded] = useState<number[]>(initialIncluded)
  // Broadcast the live selection to sibling client islands — the roof layout
  // map (RoofLayoutSection) re-frames and re-zones itself on every toggle.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('qm:roof-selection', { detail: { indices: included } }))
  }, [included])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const router = useRouter()
  const [photos, setPhotos] = useState<File[]>([])
  const [rescanState, setRescanState] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')
  const [rescanMsg, setRescanMsg] = useState<string | null>(null)
  const [promoteState, setPromoteState] = useState<'idle' | 'working'>('idle')
  const [promoteErr, setPromoteErr] = useState<string | null>(null)
  // Index (1-based) of the structure whose edge counts are being re-priced.
  const [edgeSaving, setEdgeSaving] = useState<number | null>(null)

  // Promote this measurement to an editable quotes row (spec R6e), then land
  // on the dashboard editor. Idempotent server-side: a second promotion
  // returns the existing quote's shareToken. Bearer-authed — the promotion
  // attributes the quote to the signed-in tradie's tenant.
  const promote = useCallback(async () => {
    if (!saveAsQuoteBody) return
    setPromoteErr(null)
    const token = await getAuthToken()
    if (!token) {
      setPromoteErr('Sign in on the dashboard to edit this quote.')
      return
    }
    setPromoteState('working')
    try {
      const res = await fetch('/api/roofing/save-as-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...saveAsQuoteBody, measure_token: measureToken }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        shareToken?: string
        error?: string
        detail?: string
      }
      if (res.status === 401) {
        setPromoteErr('Sign in on the dashboard to edit this quote.')
        setPromoteState('idle')
        return
      }
      if (!res.ok || !json.ok || !json.shareToken) {
        setPromoteErr(json.detail ?? json.error ?? `Couldn't create the editable quote (HTTP ${res.status})`)
        setPromoteState('idle')
        return
      }
      router.push(`/dashboard/quote/${json.shareToken}${routing === 'inspection_required' ? '' : '?edit=1'}`)
    } catch (e) {
      setPromoteErr(e instanceof Error ? e.message : String(e))
      setPromoteState('idle')
    }
  }, [saveAsQuoteBody, measureToken, router, routing])

  // Tradie photo source (R2): attach close-up roof photos and re-scan. The POST
  // merges the Anthropic photo pass with the per-structure aerial read and
  // persists onto roofing_measurements.quote.solar; router.refresh() reloads
  // the server page with the updated detection.
  const rescan = useCallback(async () => {
    if (photos.length === 0) {
      setRescanMsg('Attach at least one roof photo first.')
      setRescanState('error')
      return
    }
    setRescanState('scanning')
    setRescanMsg(null)
    try {
      const encoded = await Promise.all(photos.slice(0, 6).map(fileToBase64))
      const res = await fetch(`/api/roofing/measurement/${measureToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getAuthToken() ?? ''}` },
        body: JSON.stringify({ expected_revision: measurementVersion, photos: encoded }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        successor?: boolean
        measureToken?: string
        solar?: unknown
        detail?: string
        error?: string
      }
      if (!res.ok || !json.ok) {
        setRescanState('error')
        setRescanMsg(json.detail ?? json.error ?? 'Re-scan failed.')
        return
      }
      if (json.successor && json.measureToken) { router.push(`/m/${json.measureToken}`); return }
      setRescanState('done')
      setRescanMsg(json.solar ? 'Updated from your photos.' : json.detail ?? 'No solar or skylights found.')
      setPhotos([])
      router.refresh()
    } catch (e) {
      setRescanState('error')
      setRescanMsg(e instanceof Error ? e.message : String(e))
    }
  }, [photos, measureToken, router, measurementVersion])

  // Tradie edge override (R3.1) — PATCH the confirmed hip/valley/box-gutter
  // counts for one structure; the server re-prices in place and we refresh to
  // show the new tiers + box-gutter line.
  const applyEdges = useCallback(
    async (index1: number, edges: EdgePatch) => {
      setEdgeSaving(index1)
      setErr(null)
      try {
        const res = await fetch(`/api/roofing/measurement/${measureToken}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getAuthToken() ?? ''}` },
          body: JSON.stringify({ expected_revision: measurementVersion, edges: [{ index: index1, ...edges }] }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string; successor?: boolean; measureToken?: string }
        if (!res.ok || !json.ok) {
          setErr(json.detail ?? json.error ?? 'Could not update the counts.')
          return
        }
        if (json.successor && json.measureToken) { router.push(`/m/${json.measureToken}`); return }
        router.refresh()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setEdgeSaving(null)
      }
    },
    [measureToken, router, measurementVersion],
  )

  const combined = useMemo(() => combine(structures, included, solar), [structures, included, solar])
  const inspection = routing === 'inspection_required'
  const solarApplies = solar?.allowance?.applies === true

  // Secondary-structure contribution. The headline total is canonical
  // (combinedTotalsForIndices); the secondaries' marginal $ is derived as
  // combined(included) − combined(included ∩ primary) through the SAME helper,
  // never a free-form re-sum — so it can never drift from the headline. An
  // included-but-inspection secondary contributes $0 (the helper prices only
  // quotable structures), so the delta is honest about what actually adds money.
  const secondaryIncluded = useMemo(
    () => included.filter((i) => !primaryIndices.includes(i)),
    [included, primaryIndices],
  )
  const secondaryCount = secondaryIncluded.length
  // The delta is computed from SOLAR-LESS totals on both sides: the marginal
  // $ of the secondaries is structural only. With solar in the operands the
  // job-level allowance cancels when the primary is priced, but leaks into the
  // delta when the primary is excluded/inspection-routed (base = $0, no solar)
  // — overstating the secondaries by the whole allowance.
  const secondaryDeltaIncGst = useMemo(() => {
    const primaryWithin = included.filter((i) => primaryIndices.includes(i))
    const all = combine(structures, included, null)
    const base = combine(structures, primaryWithin, null)
    return all.incGst.map((v, i) => v - base.incGst[i]) as [number, number, number]
  }, [structures, included, primaryIndices])
  const secondaryAddsMoney = secondaryDeltaIncGst.some((v) => v > 0)

  // The non-default-selection notice fires only when the current set differs
  // from the roof-only default (i.e. ≥1 secondary is in) and there is more than
  // one structure to choose from — so it never nags on a primary-only or
  // single-structure job.
  const isPrimaryOnly = useMemo(() => {
    const primarySet = new Set(primaryIndices)
    return included.length === primaryIndices.length && included.every((i) => primarySet.has(i))
  }, [included, primaryIndices])
  const showSelectionNotice = structures.length > 1 && !isPrimaryOnly

  const persist = useCallback(
    async (next: number[]): Promise<boolean> => {
      setSaving(true)
      setErr(null)
      try {
        const res = await fetch(`/api/roofing/measurement/${measureToken}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getAuthToken() ?? ''}` },
          body: JSON.stringify({ expected_revision: measurementVersion, included_indices: next }),
        })
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          successor?: boolean
          measureToken?: string
          error?: string
          detail?: string
        }
        if (!res.ok || !json.ok) {
          setErr(json.detail ?? json.error ?? `Couldn't save (HTTP ${res.status})`)
          return false
        }
        if (json.successor && json.measureToken) router.push(`/m/${json.measureToken}`)
        return true
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        setSaving(false)
      }
    },
    [measureToken, measurementVersion, router],
  )

  const onToggle = useCallback(
    async (index1: number) => {
      const isIn = included.includes(index1)
      if (isIn && included.length === 1) {
        setErr('Keep at least one structure in the job.')
        return
      }
      const next = isIn
        ? included.filter((x) => x !== index1)
        : [...included, index1].sort((a, b) => a - b)
      const prev = included
      setIncluded(next) // optimistic
      const ok = await persist(next)
      if (!ok) {
        setIncluded(prev) // revert on failure
        return
      }
      // Re-render the server page so the promotion payload (saveAsQuoteBody,
      // flattened server-side from included_indices) reflects THIS toggle —
      // otherwise "Edit & send quote" would promote the stale selection.
      router.refresh()
    },
    [included, persist, router],
  )

  return (
    <div className="mt-10">
      {/* Cross-links to the customer-facing views of the SAME record. */}
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={`/q/roof/${publicToken}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 bg-accent px-4 py-2.5 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-white hover:bg-accent-press"
        >
          Open customer quote <span aria-hidden="true">&rarr;</span>
        </a>
        {!inspection && (
          <a
            href={`/api/q/roof/${publicToken}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 border border-ink-line px-4 py-2.5 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-text-sec hover:border-accent hover:text-accent"
          >
            Download PDF <span aria-hidden="true">&darr;</span>
          </a>
        )}
        {/* On-site edit path (spec R6e): already promoted → straight to the
            dashboard editor; otherwise promote-then-navigate. */}
        {quoteShareToken ? (
          <a
            href={`/dashboard/quote/${quoteShareToken}${inspection ? '' : '?edit=1'}`}
            className="inline-flex items-center gap-2 border border-ink-line px-4 py-2.5 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-text-sec hover:border-accent hover:text-accent"
          >
            Edit &amp; send quote <span aria-hidden="true">&rarr;</span>
          </a>
        ) : saveAsQuoteBody ? (
          <button
            type="button"
            onClick={() => void promote()}
            disabled={promoteState === 'working'}
            className="inline-flex items-center gap-2 border border-ink-line px-4 py-2.5 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-text-sec transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {promoteState === 'working' ? 'Preparing…' : (<>Edit &amp; send quote <span aria-hidden="true">&rarr;</span></>)}
          </button>
        ) : null}
        {promoteErr && (
          <span className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-warning-bright">
            {promoteErr}
          </span>
        )}
        {saving && (
          <span className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-text-dim">
            Saving…
          </span>
        )}
      </div>

      {err && (
        <div className="mt-4 border border-ink-line border-l-4 border-l-warning bg-ink-card px-5 py-3">
          <p className="font-mono text-[0.74rem] font-semibold uppercase tracking-[0.14em] text-warning-bright">{err}</p>
        </div>
      )}

      {/* Non-default selection notice — only when ≥1 secondary is in the job. */}
      {showSelectionNotice && (
        <div className="mt-6 border border-ink-line border-l-4 border-l-accent bg-ink-card px-5 py-3">
          <p className="text-sm text-text-sec">
            {selectionWasPersisted
              ? `Showing your saved selection: main dwelling + ${secondaryCount} secondary structure${secondaryCount === 1 ? '' : 's'}. Untick any to remove it from the quote.`
              : `Including ${secondaryCount} secondary structure${secondaryCount === 1 ? '' : 's'} by default — untick any you don’t want in the quote.`}
          </p>
        </div>
      )}

      {/* Per-structure cards */}
      <div className="mt-6 space-y-5">
        {structures.map((s, i) => {
          const index1 = i + 1
          const isIncluded = included.includes(index1)
          return (
            <StructureCard
              key={`${s.buildingId ?? i}-${s.metrics.hips ?? ''}-${s.metrics.valleys ?? ''}-${s.metrics.box_gutter_lm ?? ''}-${s.metrics.pitch_degrees ?? ''}-${s.metrics.sloped_area_m2 ?? ''}-${s.metrics.form}-${s.metrics.storeys ?? ''}-${s.metrics.gutter_lm ?? ''}-${s.metrics.downpipe_count ?? ''}-${s.metrics.fascia_lm ?? ''}-${s.metrics.soffit_lm ?? ''}`}
              structure={s}
              index={i}
              isIncluded={isIncluded}
              disabled={saving || edgeSaving !== null}
              savingEdges={edgeSaving === index1}
              onToggle={() => void onToggle(index1)}
              onApplyEdges={applyEdges}
            />
          )
        })}
      </div>

      {/* Combined total of the included structures */}
      <div className="mt-8 border border-ink-line border-l-4 border-l-accent bg-ink-card p-6 sm:p-8">
        <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
          Combined total · {combined.count} structure{combined.count === 1 ? '' : 's'} included
          {combined.area ? ` · ${combined.area.toFixed(0)} m²` : ''}
        </div>
        {secondaryCount > 0 && (
          <div className="mt-1.5 font-mono text-[0.72rem] uppercase tracking-[0.14em] text-text-dim">
            Includes {secondaryCount} secondary structure{secondaryCount === 1 ? '' : 's'}
            {secondaryAddsMoney
              ? ` adding $${money(secondaryDeltaIncGst[1])} (re-roof, inc GST)`
              : ' — quoted on site'}
          </div>
        )}
        <div className="mt-5 grid gap-5 sm:grid-cols-3">
          {(['good', 'better', 'best'] as const).map((tier, i) => (
            <div key={tier} className="border border-ink-line bg-ink-deep p-5">
              <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
                {TIER_NAME[tier]}
              </div>
              <div className="mt-2 font-mono text-3xl font-bold tabular-nums text-accent sm:text-4xl">
                ${money(combined.incGst[i])}
              </div>
              <div className="mt-1 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">
                inc GST · ${money(combined.exGst[i])} ex GST
              </div>
              {secondaryCount > 0 && secondaryDeltaIncGst[i] > 0 && (
                <div className="mt-1 font-mono text-[0.66rem] uppercase tracking-[0.12em] text-text-dim">
                  incl. +${money(secondaryDeltaIncGst[i])} from secondaries
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Existing solar / skylights — persisted detection (save-time aerial +
          any tradie photo re-scan). Applied solar is added to the replacement
          tiers (never Patch) on the customer quote AND the combined totals
          above; skylights are flagged only (never auto-priced). */}
      <div className="mt-6 border border-ink-line border-l-4 border-l-accent bg-ink-card p-6 sm:p-7">
        <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
          Existing solar &amp; skylights
        </div>
        <p className="mt-2 text-base text-text-sec">
          {solar?.detection
            ? solar.detection.summary_note
            : 'Not scanned yet — attach close-up roof photos below to check for panels and skylights.'}
        </p>

        {solar?.detection?.has_solar && solar.allowance && (
          <div className={`mt-4 border border-ink-line border-l-4 ${solarApplies ? 'border-l-accent' : 'border-l-warning'} bg-ink-deep p-4`}>
            <div className={`font-mono text-[0.74rem] font-semibold uppercase tracking-[0.16em] ${solarApplies ? 'text-accent' : 'text-warning-bright'}`}>
              {solarApplies
                ? combined.incGst[1] > 0
                  ? `Solar detach & reinstate · +$${money(solar.allowance.inc_gst)} inc GST added to the replacement options (included in the combined totals above)`
                  : `Solar detach & reinstate · +$${money(solar.allowance.inc_gst)} inc GST applies once a replacement price is confirmed on site`
                : 'Solar flagged — not auto-priced (low confidence or not a full re-roof)'}
            </div>
            <p className="mt-2 text-sm text-text-sec">{solar.allowance.electrician_note}</p>
          </div>
        )}

        {solar?.detection?.has_skylight && (
          <p className="mt-3 text-sm text-text-sec">
            {solar.detection.skylight_count} skylight{solar.detection.skylight_count === 1 ? '' : 's'} flagged — add a re-flash line if the re-roof disturbs {solar.detection.skylight_count === 1 ? 'it' : 'them'} (not auto-priced).
          </p>
        )}

        {/* Per-structure attribution — which building each read came from (R3). */}
        {solar?.perStructure && solar.perStructure.length > 0 && (
          <div className="mt-4 space-y-2">
            {solar.perStructure.map((ps, i) => (
              <div key={ps.buildingId ?? i} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-ink-line pt-2 text-sm">
                <span className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-text-dim">{ps.label}</span>
                <span className="text-text-sec">{ps.detection.summary_note}</span>
              </div>
            ))}
          </div>
        )}

        {solar?.structuresSkipped ? (
          <p className="mt-3 font-mono text-[0.72rem] uppercase tracking-[0.14em] text-warning-bright">
            {solar.structuresSkipped} more structure{solar.structuresSkipped === 1 ? '' : 's'} not scanned — re-scan with photos to cover {solar.structuresSkipped === 1 ? 'it' : 'them'}.
          </p>
        ) : null}

        {/* Tradie photo source (R2) — attach close-up roof photos and re-scan. */}
        <div className="mt-5 border-t border-ink-line pt-4">
          <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
            Attach roof photos &amp; re-scan
          </div>
          <p className="mt-1 text-sm text-text-sec">
            Close-up photos sharpen the read. We merge them with the aerial scan and update the quote.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="image/*"
              multiple
              aria-label="Attach roof photos"
              onChange={(e) => setPhotos(Array.from(e.target.files ?? []).slice(0, 6))}
              className="text-sm text-text-sec file:mr-3 file:border file:border-ink-line file:bg-ink-deep file:px-3 file:py-1.5 file:font-mono file:text-[0.72rem] file:font-semibold file:uppercase file:tracking-[0.14em] file:text-text-pri"
            />
            <button
              type="button"
              onClick={rescan}
              disabled={rescanState === 'scanning' || photos.length === 0}
              className="inline-flex items-center gap-2 bg-accent px-4 py-2 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rescanState === 'scanning' ? 'Scanning…' : `Re-scan${photos.length ? ` (${photos.length})` : ''}`}
            </button>
          </div>
          {rescanMsg && (
            <p className={`mt-2 text-sm ${rescanState === 'error' ? 'text-warning-bright' : 'text-text-sec'}`}>{rescanMsg}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function StructureCard({
  structure,
  index,
  isIncluded,
  disabled,
  savingEdges,
  onToggle,
  onApplyEdges,
}: {
  structure: RoofStructurePrice
  index: number
  isIncluded: boolean
  disabled: boolean
  savingEdges: boolean
  onToggle: () => void
  onApplyEdges: (index1: number, edges: EdgePatch) => void | Promise<void>
}) {
  const m = structure.metrics
  const p = structure.price
  const inspection = p.routing?.decision === 'inspection_required'
  const [hips, setHips] = useState(m.hips != null ? String(m.hips) : '')
  const [valleys, setValleys] = useState(m.valleys != null ? String(m.valleys) : '')
  const [boxGutter, setBoxGutter] = useState(m.box_gutter_lm != null ? String(m.box_gutter_lm) : '')
  // Measurement corrections — initialised from the stored metrics; sent
  // only when changed so an untouched field never stomps a measured value.
  const initialPitch = m.pitch_degrees != null ? String(m.pitch_degrees) : ''
  const initialArea = m.sloped_area_m2 != null ? String(Math.round(m.sloped_area_m2)) : ''
  const initialStoreys = m.storeys != null ? String(m.storeys) : ''
  const [pitchDeg, setPitchDeg] = useState(initialPitch)
  const [areaM2, setAreaM2] = useState(initialArea)
  const [form, setForm] = useState<RoofMetrics['form']>(m.form)
  const [storeys, setStoreys] = useState(initialStoreys)
  // Accessory quantities — explicit tradie inputs (blank = not selected).
  const [gutterLm, setGutterLm] = useState(m.gutter_lm != null ? String(m.gutter_lm) : '')
  const [downpipes, setDownpipes] = useState(m.downpipe_count != null ? String(m.downpipe_count) : '')
  const [fasciaLm, setFasciaLm] = useState(m.fascia_lm != null ? String(m.fascia_lm) : '')
  const [soffitLm, setSoffitLm] = useState(m.soffit_lm != null ? String(m.soffit_lm) : '')
  const num = (v: string): number | null => {
    const n = Number(v)
    return v.trim() === '' || !Number.isFinite(n) ? null : Math.max(0, n)
  }

  // Suggested accessory quantities from the footprint perimeter — shown as
  // hints only, NEVER auto-priced (gutter scope is an explicit selection).
  const perimeter = footprintPerimeterM(m)
  const suggestedDownpipes = perimeter != null ? Math.ceil(perimeter / 12) : null

  // Dependent-value preview — the SAME pure maths the server reprice runs,
  // so the tradie sees what a pitch/area edit will change before saving.
  const pitchDirty = pitchDeg !== initialPitch && pitchDeg.trim() !== ''
  const areaDirty = areaM2 !== initialArea && areaM2.trim() !== ''
  const preview = (() => {
    if (!pitchDirty) return null
    const deg = num(pitchDeg)
    if (deg === null || deg <= 0) return null
    const bucket = pitchBucketFromDegrees(deg)
    const newArea = slopedAreaFromFootprint(m.footprint_m2, bucket)
    const edge = perEdgeLength({ ...m, pitch_degrees: deg }, bucket)
    const areaNote = areaDirty
      ? 'sloped area uses your entered value'
      : newArea != null
        ? `sloped area recomputes to ${Math.round(newArea)} m²`
        : 'sloped area cannot be derived — routes to inspection'
    return `Pitch ${deg}° = ${bucket.replace('_', ' ')} · ${areaNote} · hip/valley basis ${edge.lengthM} m per edge`
  })()

  const submitEdges = () => {
    const patch: EdgePatch = {
      hips: hips.trim() === '' ? null : Math.round(num(hips) ?? 0),
      valleys: valleys.trim() === '' ? null : Math.round(num(valleys) ?? 0),
      box_gutter_lm: num(boxGutter),
      // Accessories are always sent (blank = null removes the line).
      gutter_lm: num(gutterLm),
      downpipe_count: downpipes.trim() === '' ? null : Math.round(num(downpipes) ?? 0),
      fascia_lm: num(fasciaLm),
      soffit_lm: num(soffitLm),
    }
    // Measurement corrections only when actually edited to a value.
    if (pitchDirty) {
      const v = num(pitchDeg)
      if (v !== null && v > 0) patch.pitch_degrees = v
    }
    if (areaDirty) {
      const v = num(areaM2)
      if (v !== null && v > 0) patch.sloped_area_m2 = v
    }
    if (form !== m.form) patch.form = form
    if (storeys !== initialStoreys && storeys.trim() !== '') {
      const v = num(storeys)
      if (v !== null && v >= 1) patch.storeys = Math.round(v)
    }
    void onApplyEdges(index + 1, patch)
  }
  return (
    <article
      className={`border bg-ink-card p-6 transition-colors sm:p-7 ${
        isIncluded ? 'border-ink-line' : 'border-ink-line opacity-55'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
              {structure.role === 'primary' ? 'Main dwelling' : 'Secondary structure'} · {String(index + 1).padStart(2, '0')}
            </div>
            {/* Explicit state — legible from text alone, not just the card opacity. */}
            <span
              className={`inline-flex items-center border px-2 py-0.5 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.14em] ${
                isIncluded ? 'border-accent text-accent' : 'border-ink-line text-text-dim'
              }`}
            >
              {isIncluded ? 'In job' : 'Not in job'}
            </span>
          </div>
          <h3 className="mt-1.5 font-extrabold uppercase tracking-[-0.02em] text-xl text-text-pri">{structure.label}</h3>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-text-sec">
          <input
            type="checkbox"
            checked={isIncluded}
            disabled={disabled}
            onChange={onToggle}
            className="h-4 w-4 accent-accent"
          />
          <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em]">Include in job</span>
        </label>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-5">
        <MiniStat
          label="Sloped area"
          value={m.sloped_area_m2 != null ? `${Math.round(m.sloped_area_m2)} m²` : '—'}
          hint={m.footprint_m2 ? `Footprint ${Math.round(m.footprint_m2)} m²` : ''}
        />
        <MiniStat label="Roof form" value={formLabel(m.form)} hint={sourceLabel(m.field_sources?.form)} />
        <MiniStat label="Storeys" value={m.storeys != null ? String(m.storeys) : '—'} hint={sourceLabel(m.field_sources?.storeys)} />
        <MiniStat label="Hips · valleys" value={`${m.hips ?? '?'} · ${m.valleys ?? '?'}`} />
        <MiniStat
          label="Pitch"
          value={m.pitch_source === 'measured' && m.pitch_degrees != null ? `${m.pitch_degrees}°` : structure.inputs.pitch}
          hint={m.pitch_source === 'measured' ? 'measured' : 'declared'}
        />
      </div>

      {/* Tradie-confirmed measurement + accessory edits — edit + re-price
          (R3.1). Box gutter and accessories are not auto-detected (invisible
          in the 2D footprint), so they start blank. */}
      <div className="mt-5 border-t border-ink-line pt-4">
        <div className="mb-2 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
          Confirm counts — edit to correct, then update prices
        </div>
        <div className="grid max-w-md grid-cols-3 gap-3">
          <EditField label="Hips" value={hips} onChange={setHips} disabled={disabled} step={1} />
          <EditField label="Valleys" value={valleys} onChange={setValleys} disabled={disabled} step={1} />
          <EditField label="Box gutter (lm)" value={boxGutter} onChange={setBoxGutter} disabled={disabled} step={0.1} />
        </div>

        {/* Measurement corrections — interconnected: pitch re-buckets and
            re-derives sloped area + hip/valley lengths; explicit area wins. */}
        <div className="mt-4 mb-2 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
          Measurements — adjust after inspection
        </div>
        <div className="grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
          <EditField
            label="Pitch (°)" value={pitchDeg} onChange={setPitchDeg} disabled={disabled}
            step={0.5} placeholder={structure.inputs.pitch}
          />
          <EditField
            label="Sloped area (m²)" value={areaM2} onChange={setAreaM2} disabled={disabled}
            step={1} placeholder={m.footprint_m2 ? `fp ${Math.round(m.footprint_m2)}` : undefined}
          />
          <label className="flex flex-col gap-1 text-text-sec">
            <span className="font-mono text-[0.62rem] uppercase tracking-[0.12em]">Roof form</span>
            <select
              value={form} disabled={disabled}
              onChange={(e) => setForm(e.target.value as RoofMetrics['form'])}
              className="border border-ink-line bg-ink-deep px-3 py-2 font-mono text-text-pri disabled:opacity-50"
            >
              <option value="gable">Gable</option>
              <option value="hip">Hip</option>
              <option value="skillion">Skillion</option>
              <option value="gable_hip">Gable + hip</option>
              <option value="complex">Complex (inspect)</option>
              {m.form === 'unknown' && <option value="unknown">Not classified</option>}
            </select>
          </label>
          <EditField label="Storeys" value={storeys} onChange={setStoreys} disabled={disabled} step={1} />
        </div>
        {preview && (
          <p className="mt-2 max-w-2xl font-mono text-[0.68rem] uppercase tracking-[0.1em] text-accent">
            Will update · {preview}
          </p>
        )}

        {/* Gutters, downpipes + extras — explicit selections, never inferred
            from the footprint. Perimeter shown as a hint only. */}
        <div className="mt-4 mb-2 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
          Gutters, downpipes &amp; extras — leave blank to exclude
        </div>
        <div className="grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
          <EditField
            label="Gutter (lm)" value={gutterLm} onChange={setGutterLm} disabled={disabled}
            step={0.1} placeholder={perimeter != null ? `≈${perimeter}` : undefined}
          />
          <EditField
            label="Downpipes" value={downpipes} onChange={setDownpipes} disabled={disabled}
            step={1} placeholder={suggestedDownpipes != null ? `≈${suggestedDownpipes}` : undefined}
          />
          <EditField
            label="Fascia (lm)" value={fasciaLm} onChange={setFasciaLm} disabled={disabled}
            step={0.1} placeholder={perimeter != null ? `≈${perimeter}` : undefined}
          />
          <EditField
            label="Soffits (lm)" value={soffitLm} onChange={setSoffitLm} disabled={disabled}
            step={0.1} placeholder={perimeter != null ? `≈${perimeter}` : undefined}
          />
        </div>
        {perimeter != null && (
          <p className="mt-2 text-xs text-text-dim">
            Footprint perimeter ≈ {perimeter} m — a starting point only; enter the lengths you measured.
          </p>
        )}

        <button
          type="button" onClick={submitEdges} disabled={disabled}
          className="mt-4 border border-accent bg-accent/10 px-4 py-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-accent disabled:opacity-50"
        >
          {savingEdges ? 'Updating…' : 'Update prices'}
        </button>
      </div>

      {/* Per-structure tier prices */}
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {p.tiers.map((t) => (
          <div key={t.tier} className="border border-ink-line bg-ink-deep p-5">
            <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
              {TIER_NAME[t.tier]}
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-accent">${money(t.inc_gst)}</div>
            <div className="mt-1 font-mono text-[0.68rem] uppercase tracking-[0.14em] text-text-dim">inc GST</div>
          </div>
        ))}
      </div>

      {inspection && (
        <div className="mt-5 border border-ink-line border-l-4 border-l-warning bg-ink-deep px-4 py-3 text-sm text-text-sec">
          <span className="font-semibold text-text-pri">Indicative — confirmed on site.</span>{' '}
          {p.routing?.reason ?? 'This structure needs a quick look on site before we can price it.'}{' '}
          The customer sees these prices as an indicative estimate, subject to the on-site visit.
        </div>
      )}
    </article>
  )
}

function EditField({
  label,
  value,
  onChange,
  disabled,
  step,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
  step: number
  placeholder?: string
}) {
  return (
    <label className="flex flex-col gap-1 text-text-sec">
      <span className="font-mono text-[0.62rem] uppercase tracking-[0.12em]">{label}</span>
      <input
        type="number" min={0} step={step} value={value} disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="border border-ink-line bg-ink-deep px-3 py-2 font-mono text-text-pri placeholder:text-text-dim disabled:opacity-50"
      />
    </label>
  )
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-ink-line bg-ink-deep p-4">
      <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">{label}</div>
      <div className="mt-2 font-mono text-lg font-bold tabular-nums text-text-pri">{value}</div>
      {hint && <div className="mt-1 text-xs text-text-dim">{hint}</div>}
    </div>
  )
}
