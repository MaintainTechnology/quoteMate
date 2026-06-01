// Customer-facing public roofing quote page.
// Reached via the SMS link "Full breakdown + your roof image: {url}".
// Token-gated against roofing_measurements.public_token (unguessable);
// the service-role client is used because this is a public sharing
// surface — only the columns rendered below are exposed.
//
// This mirrors the dashboard /dashboard/roofing/measure result: the
// Geoscape roof outline on satellite (RoofMap, free Esri tiles), the
// Google satellite "second eye", and a full per-structure pricing
// breakdown (metrics, every tier with its scope, effective rate +
// loadings) plus the combined total. Read-only — no editing.
//
// Maintain Technology brand: dark navy, vibrant orange, all-caps display.

import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import type {
  MultiRoofQuote,
  RoofMaterial,
  RoofMetrics,
  RoofStructurePrice,
} from '@/lib/roofing/types'
import { RoofMap, type RoofMapBuilding } from '@/app/dashboard/roofing/_components/RoofMap'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Row = {
  address: string | null
  state: string | null
  provider: string | null
  routing: string | null
  combined_area_m2: number | null
  quote: MultiRoofQuote | null
  public_token: string
}

function money(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  return n.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

const MATERIAL_LABEL: Record<RoofMaterial, string> = {
  colorbond_trimdek: 'Colorbond Trimdek',
  colorbond_kliplok: 'Colorbond Klip-Lok 700',
  concrete_tile: 'Concrete tile',
  terracotta_tile: 'Terracotta tile',
  cement_sheet: 'Cement sheet',
  unknown: 'To confirm on site',
}

function formLabel(form: RoofMetrics['form']): string {
  switch (form) {
    case 'gable': return 'Gable'
    case 'hip': return 'Hip'
    case 'skillion': return 'Skillion'
    case 'gable_hip': return 'Gable + hip'
    case 'complex': return 'Complex'
    default: return 'To confirm'
  }
}

const TIER_NAME: Record<'good' | 'better' | 'best', string> = {
  good: 'Patch / repair',
  better: 'Re-roof',
  best: 'Upgrade',
}

export default async function RoofingQuotePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  if (!token || token.length < 8) notFound()

  const { data, error } = await supabase
    .from('roofing_measurements')
    .select('address, state, provider, routing, combined_area_m2, quote, public_token')
    .eq('public_token', token)
    .maybeSingle()

  if (error || !data) notFound()
  const row = data as Row
  const quote = row.quote
  const structures: RoofStructurePrice[] = Array.isArray(quote?.structures) ? quote!.structures : []
  const isInspection = row.routing === 'inspection_required' || quote?.routing?.decision === 'inspection_required'
  const flagged = new Set(quote?.inspection_structures ?? [])

  const mapBuildings: RoofMapBuilding[] = structures.map((s, i) => ({
    id: s.buildingId ?? `s-${i}`,
    polygon: s.metrics?.polygon_geojson ?? null,
    role: s.role,
    included: true,
  }))
  const primary = structures.find((s) => s.role === 'primary') ?? structures[0]
  const primaryStats = primary
    ? {
        sloped_area_m2: primary.metrics.sloped_area_m2,
        hips: primary.metrics.hips,
        valleys: primary.metrics.valleys,
        storeys: primary.metrics.storeys,
      }
    : null

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      <section className="mx-auto max-w-4xl px-6 pt-14 pb-10 sm:px-10">
        <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-accent">
          QuoteMate · Roofing
        </div>
        <h1 className="mt-3 font-extrabold uppercase leading-[0.95] tracking-[-0.035em] text-[clamp(2rem,5vw,3.5rem)]">
          Your roof <span className="text-accent">quote</span>
        </h1>
        {row.address && <p className="mt-4 text-lg text-text-sec">{row.address}</p>}

        {/* Two-source view — Geoscape roof outline (Esri) + Google satellite */}
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <RoofMap
            polygon={null}
            form={primary?.metrics.form ?? 'unknown'}
            stats={primaryStats}
            buildings={mapBuildings}
            selectedId={mapBuildings[0]?.id ?? null}
          />
          <div className="overflow-hidden border border-ink-line bg-ink-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/roofing/q/${row.public_token}/static-map`}
              alt={`Satellite view of the roof at ${row.address ?? 'the property'}`}
              className="h-112 w-full object-cover sm:h-128"
            />
            <div className="px-5 py-3 font-mono text-xs uppercase tracking-[0.16em] text-text-dim">
              Google satellite view
            </div>
          </div>
        </div>

        {isInspection && (
          <div className="mt-8 border border-ink-line border-l-4 border-l-warning bg-ink-card px-6 py-5">
            <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-warning">
              On-site inspection needed
            </div>
            <p className="mt-2 text-base text-text-sec">
              {quote?.routing?.reason ??
                'This roof needs a quick inspection on site before we can give an accurate price.'}
            </p>
          </div>
        )}

        {/* Combined total (only when there's something quotable) */}
        {!isInspection && quote?.combined?.tiers && (
          <div className="mt-8 border border-ink-line border-l-4 border-l-accent bg-ink-card p-6 sm:p-8">
            <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
              Combined estimate
              {row.combined_area_m2 ? ` · ${Math.round(row.combined_area_m2)} m²` : ''}
            </div>
            <div className="mt-5 grid gap-5 sm:grid-cols-3">
              {quote.combined.tiers.map((t, i) => (
                <div key={i} className="border border-ink-line bg-ink-deep p-5">
                  <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
                    {TIER_NAME[t.tier]}
                  </div>
                  <div className="mt-2 font-mono text-3xl font-bold tabular-nums text-accent sm:text-4xl">
                    ${money(t.inc_gst)}
                  </div>
                  <div className="mt-1 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">
                    inc GST · ${money(t.ex_gst)} ex GST
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Per-structure detailed breakdown */}
        <div className="mt-10 space-y-6">
          <div className="font-mono text-[0.8rem] font-semibold uppercase tracking-[0.18em] text-accent">
            Detailed breakdown · {structures.length} structure{structures.length === 1 ? '' : 's'}
          </div>
          {structures.map((s, i) => (
            <StructureBreakdown key={s.buildingId ?? i} structure={s} index={i} flagged={flagged.has(s.label)} />
          ))}
        </div>

        <p className="mt-8 text-sm text-text-dim">
          Prices include GST and are indicative from a satellite measurement. A
          licensed roofer reviews every quote before any work is booked.
        </p>
      </section>

      <div className="bg-accent px-6 py-5 text-center text-white">
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.16em]">
          QuoteMate · Roofing
        </span>
      </div>
    </main>
  )
}

function StructureBreakdown({
  structure,
  index,
  flagged,
}: {
  structure: RoofStructurePrice
  index: number
  flagged: boolean
}) {
  const m = structure.metrics
  const p = structure.price
  const inspection = p.routing?.decision === 'inspection_required' || flagged
  return (
    <article className="border border-ink-line bg-ink-card p-6 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
            {structure.role === 'primary' ? 'Main dwelling' : 'Secondary structure'} · {String(index + 1).padStart(2, '0')}
          </div>
          <h3 className="mt-1.5 font-extrabold uppercase tracking-[-0.02em] text-xl text-text-pri">{structure.label}</h3>
        </div>
        <span className="font-mono text-xs text-text-dim">{MATERIAL_LABEL[structure.inputs.material]}</span>
      </div>

      {/* Geoscape metrics */}
      <div className="mt-5 grid gap-4 sm:grid-cols-4">
        <MiniStat label="Sloped area" value={m.sloped_area_m2 != null ? `${Math.round(m.sloped_area_m2)} m²` : '-'} hint={m.footprint_m2 ? `Footprint ${Math.round(m.footprint_m2)} m²` : ''} />
        <MiniStat label="Roof form" value={formLabel(m.form)} hint={m.storeys != null ? `${m.storeys}-storey` : ''} />
        <MiniStat label="Hips · valleys" value={`${m.hips ?? '?'} · ${m.valleys ?? '?'}`} />
        <MiniStat label="Rate" value={p.effective_rate_per_m2 ? `$${money(p.effective_rate_per_m2)}/m²` : '-'} hint={p.area_m2 ? `over ${Math.round(p.area_m2)} m²` : ''} />
      </div>

      {inspection ? (
        <div className="mt-5 border border-ink-line border-l-4 border-l-warning bg-ink-deep px-4 py-3 text-sm text-text-sec">
          ⚠ {p.routing?.reason ?? 'This structure needs a quick look on site before we can price it.'}
        </div>
      ) : (
        <>
          {/* Each tier with its scope of works */}
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {p.tiers.map((t) => (
              <div key={t.tier} className="flex flex-col border border-ink-line bg-ink-deep p-5">
                <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
                  {TIER_NAME[t.tier]}
                </div>
                <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-accent">${money(t.inc_gst)}</div>
                <div className="mt-1 font-mono text-[0.68rem] uppercase tracking-[0.14em] text-text-dim">
                  inc GST · ${money(t.ex_gst)} ex
                </div>
                <p className="mt-3 text-sm leading-relaxed text-text-sec">{t.scope}</p>
              </div>
            ))}
          </div>

          {/* Loadings + call-out floor */}
          {(p.loadings_applied.length > 0 || p.call_out_minimum_applied) && (
            <div className="mt-5 space-y-1.5 text-sm text-text-sec">
              {p.loadings_applied.map((l) => (
                <p key={l.code}>+ {l.detail}</p>
              ))}
              {p.call_out_minimum_applied && <p>Minimum job charge applied (small structure).</p>}
            </div>
          )}
        </>
      )}
    </article>
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
