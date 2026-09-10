'use client'

// Editable confirmation table for the painting takeoff (spec phase 4).
// Grouped by room/area; every row shows its provenance (plan /
// measurements / both / manual), its reconciliation delta, and its
// confidence. The tradie edits quantities, switches paint systems,
// excludes lines, adds manual lines — then confirms. Nothing is priced
// before this step.

import { useMemo, useState } from 'react'
import { Loader2, Plus, RotateCcw } from 'lucide-react'
import type {
  PaintSystem,
  PaintTakeoffItem,
  ReconcileFlag,
} from '@/lib/commercial-painting/types'
import { PAINT_SYSTEMS, MAX_LABOUR_RATE_PER_HR } from '@/lib/commercial-painting/types'
import { StatusPill, type Tone } from '../quote-ui'
import { PaintCorrectionItemSchema } from '@/lib/commercial-painting/correction-contract'

const SYSTEM_LABELS: Record<PaintSystem, string> = {
  spray_matt: 'Spray matt (exposed ceiling)',
  flat: 'Flat (suspension/set ceiling)',
  low_sheen: 'Low sheen (walls)',
  semi_gloss: 'Semi-gloss (wet areas/trim)',
}

type Row = PaintTakeoffItem & { uid: number }

let nextUid = 1

function toRows(items: PaintTakeoffItem[]): Row[] {
  return items.map((i) => ({ ...i, uid: nextUid++ }))
}

function rowsToItems(rows: Row[]): PaintTakeoffItem[] {
  return rows
    .map((row) => {
      const { uid, ...item } = row
      void uid
      return item
    })
}

function SourceChip({ row }: { row: Row }) {
  const flaggedDelta = row.source === 'both' && row.delta_pct != null && Math.abs(row.delta_pct) > 10
  const label =
    row.source === 'both'
      ? flaggedDelta
        ? `Δ ${row.delta_pct! > 0 ? '+' : ''}${row.delta_pct}%`
        : 'Matched'
      : row.source === 'measurements'
        ? 'Measured'
        : row.source === 'plan'
          ? 'Plan only'
          : 'Manual'
  const tone: Tone = flaggedDelta
    ? 'warn'
    : row.source === 'manual'
      ? 'accent'
      : row.source === 'plan'
        ? 'dim'
        : 'good'
  return (
    <span title={row.note}>
      <StatusPill label={label} tone={tone} dot compact />
    </span>
  )
}

/** Coats range the bulk-set + per-row inputs accept. */
const COATS_MIN = 1
const COATS_MAX = 4

export function PaintTakeoffEditor({
  initialItems,
  flags,
  finishesSchedule,
  overallNote,
  pricing,
  disabled = false,
  defaultLabourRate,
  onConfirm,
  onDirty,
}: {
  initialItems: PaintTakeoffItem[]
  flags: ReconcileFlag[]
  finishesSchedule: Array<{ code: string; product: string; sheen: string; surfaces: string }>
  overallNote: string
  pricing: boolean
  disabled?: boolean
  /** The labour $/hr the last price used (tenant/seed default or a prior
   *  override) — shown as the placeholder so the field reflects reality. */
  defaultLabourRate?: number | null
  onConfirm: (items: PaintTakeoffItem[], labourRatePerHr: number | null) => void
  onDirty?: () => void
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(initialItems))
  const [showFlags, setShowFlags] = useState(true)
  // Bulk "set all coats" value, and the per-quote labour-rate override.
  const [bulkCoats, setBulkCoats] = useState('')
  // Always start blank: blank = "use my saved rate". defaultLabourRate is the
  // last-priced rate, shown only as the placeholder — never pre-filled as a
  // value, so a resumed run can't silently re-send a stale rate as an override.
  const [labourRate, setLabourRate] = useState('')
  const [labourRateError, setLabourRateError] = useState<string | null>(null)

  function patch(uid: number, partial: Partial<Row>) {
    onDirty?.()
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...partial } : r)))
  }

  /** Set every line's coats to the entered value (clamped to COATS_MIN..MAX). */
  function applyBulkCoats() {
    const n = Math.round(Number(bulkCoats))
    if (!Number.isFinite(n) || n < COATS_MIN) return
    const coats = Math.min(COATS_MAX, Math.max(COATS_MIN, n))
    onDirty?.()
    setRows((prev) => prev.map((r) => ({ ...r, coats })))
  }

  /**
   * Validate the labour-rate field, then price. Blank → null (use the saved
   * rate). A non-blank value must be a number in (0, MAX]; anything else blocks
   * pricing with an inline error rather than silently falling back to the
   * default (which the server would do for an out-of-range value).
   */
  function handleConfirm() {
    const items = rowsToItems(rows)
    if (!items.length || items.length > 5000 || items.some(item => !PaintCorrectionItemSchema.safeParse(item).success)) {
      setLabourRateError('Check every line: a named surface, non-negative quantity, 1–4 whole coats, and any supplied height above 0 and below 30 metres are required. No rows have been removed.')
      return
    }
    const raw = labourRate.trim()
    if (raw === '') {
      setLabourRateError(null)
      onConfirm(items, null)
      return
    }
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0 || n > MAX_LABOUR_RATE_PER_HR) {
      setLabourRateError(
        `Enter a labour rate between $1 and $${MAX_LABOUR_RATE_PER_HR}/hr, or clear it to use your saved rate.`,
      )
      return
    }
    setLabourRateError(null)
    onConfirm(items, n)
  }

  function addRow(room: string) {
    onDirty?.()
    setRows((prev) => [
      ...prev,
      {
        uid: nextUid++,
        surface: '',
        room,
        substrate: 'unknown',
        system: 'low_sheen',
        unit: 'm2',
        quantity: 0,
        coats: 2,
        confidence: 'high',
        source: 'manual',
      },
    ])
  }

  const groups = useMemo(() => {
    const byRoom = new Map<string, Row[]>()
    for (const r of rows) {
      const key = r.room || 'General'
      const list = byRoom.get(key) ?? []
      list.push(r)
      byRoom.set(key, list)
    }
    return [...byRoom.entries()]
  }, [rows])

  const includedArea = rows
    .filter((r) => !r.excluded && r.unit === 'm2')
    .reduce((s, r) => s + (Number.isFinite(r.quantity) ? r.quantity : 0), 0)

  const numClass =
    'w-20 border border-ink-line bg-ink-deep px-2 py-1.5 text-right font-mono text-sm tabular-nums text-text-pri outline-none transition-colors focus:border-accent'

  return (
    <div className="mt-5">
      {/* Reconciliation flags */}
      {flags.length > 0 && (
        <div className="rounded-card border border-ink-line bg-ink-deep">
          <button
            type="button"
            onClick={() => setShowFlags((v) => !v)}
            aria-expanded={showFlags}
            className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left"
          >
            <span className=" text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-warning">
              {flags.length} reconciliation flag{flags.length === 1 ? '' : 's'}
            </span>
            <span className="h-px flex-1 bg-ink-line" aria-hidden />
            <span className="font-mono text-sm text-warning" aria-hidden>{showFlags ? '−' : '+'}</span>
          </button>
          {showFlags && (
            <ul className="border-t border-ink-line px-4 py-3 text-sm text-text-sec">
              {flags.map((f, i) => (
                <li key={i} className="flex gap-2 py-0.5">
                  <span className=" text-[0.62rem] uppercase tracking-[0.08em] text-text-dim">
                    {f.kind === 'delta' ? 'Δ' : f.kind === 'plan_only' ? 'PLAN' : 'DOC'}
                  </span>
                  <span>{f.room} · {f.surface} — {f.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Finishes schedule reference */}
      {finishesSchedule.length > 0 && (
        <details className="rounded-card mt-3 border border-ink-line bg-ink-deep">
          <summary className="cursor-pointer list-none px-4 py-2.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-text-sec [&::-webkit-details-marker]:hidden">
            Finishes schedule from the plans · {finishesSchedule.length} entries
          </summary>
          <div className="overflow-x-auto border-t border-ink-line">
            <table className="w-full text-sm">
              <tbody>
                {finishesSchedule.map((f, i) => (
                  <tr key={i} className="border-b border-ink-line last:border-0">
                    <td className="px-4 py-2 font-mono text-xs text-accent">{f.code}</td>
                    <td className="px-4 py-2 text-text-pri">{f.product}</td>
                    <td className="px-4 py-2 text-text-sec">{f.sheen}</td>
                    <td className="px-4 py-2 text-text-dim">{f.surfaces}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Bulk edit — set the coats on every line at once. */}
      <div className="rounded-card mt-4 flex flex-wrap items-center gap-3 border border-ink-line bg-ink-deep px-4 py-3">
        <span className=" text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
          Bulk edit
        </span>
        <label className="flex items-center gap-2 text-sm text-text-sec">
          Set all coats to
          <input
            type="number"
            step="1"
            min={COATS_MIN}
            max={COATS_MAX}
            value={bulkCoats}
            onChange={(e) => setBulkCoats(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyBulkCoats() } }}
            placeholder="3"
            aria-label="Set all coats to"
            className="rounded-ctl w-16 border border-ink-line bg-ink-deep px-2 py-1.5 text-right font-mono text-sm tabular-nums text-text-pri outline-none transition-colors focus:border-accent"
          />
        </label>
        <button
          type="button"
          onClick={applyBulkCoats}
          disabled={bulkCoats.trim() === ''}
          className="rounded-ctl inline-flex cursor-pointer items-center gap-1.5 border border-ink-line bg-ink-card px-3 py-1.5 text-[0.64rem] font-semibold uppercase tracking-[0.08em] text-text-sec transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          Apply to all lines
        </button>
        <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
          {COATS_MIN}–{COATS_MAX} coats
        </span>
      </div>

      {/* Grouped editable table */}
      <div className="mt-4 space-y-5">
        {groups.map(([room, groupRows]) => (
          <div key={room}>
            <div className="flex items-center gap-3">
              <h4 className=" text-xs font-bold uppercase tracking-[0.08em] text-accent">{room}</h4>
              <span className="h-px flex-1 bg-ink-line" aria-hidden />
              <button
                type="button"
                onClick={() => addRow(room)}
                className="inline-flex cursor-pointer items-center gap-1 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-accent"
              >
                <Plus className="h-3 w-3" aria-hidden /> Line
              </button>
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead>
                  <tr className="text-left text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
                    <th className="py-1.5 pr-3 font-semibold">Surface</th>
                    <th className="py-1.5 pr-3 font-semibold">System</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Qty</th>
                    <th className="py-1.5 pr-3 font-semibold">Unit</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Coats</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Height m</th>
                    <th className="py-1.5 pr-3 font-semibold">Source</th>
                    <th className="py-1.5 pr-3 text-center font-semibold" title="Price separately">Sep.</th>
                    <th className="py-1.5 text-center font-semibold" title="Exclude from the quote">Excl.</th>
                  </tr>
                </thead>
                <tbody>
                  {groupRows.map((r) => (
                    <tr
                      key={r.uid}
                      className={`border-t border-ink-line ${r.excluded ? 'opacity-45' : ''} ${
                        r.confidence === 'low' && !r.excluded ? 'bg-warning/5' : ''
                      }`}
                    >
                      <td className="py-1.5 pr-3">
                        <input
                          value={r.surface}
                          onChange={(e) => patch(r.uid, { surface: e.target.value })}
                          placeholder="Surface"
                          aria-label="Surface"
                          title={r.note}
                          className="rounded-ctl w-full min-w-44 border border-transparent bg-transparent px-1.5 py-1 text-text-pri outline-none transition-colors focus:border-accent"
                        />
                      </td>
                      <td className="py-1.5 pr-3">
                        <select
                          value={r.system}
                          onChange={(e) => patch(r.uid, { system: e.target.value as PaintSystem })}
                          aria-label="Paint system"
                          className="rounded-ctl cursor-pointer border border-ink-line bg-ink-deep px-2 py-1.5 text-xs text-text-sec outline-none focus:border-accent"
                        >
                          {PAINT_SYSTEMS.map((s) => (
                            <option key={s} value={s}>{SYSTEM_LABELS[s]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={Number.isFinite(r.quantity) ? r.quantity : ''}
                          onChange={(e) => patch(r.uid, { quantity: Number(e.target.value) })}
                          aria-label="Quantity"
                          className={numClass}
                        />
                      </td>
                      <td className="py-1.5 pr-3">
                        <select
                          value={r.unit}
                          onChange={(e) => patch(r.uid, { unit: e.target.value as 'm2' | 'item' })}
                          aria-label="Unit"
                          className="rounded-ctl cursor-pointer border border-ink-line bg-ink-deep px-2 py-1.5 font-mono text-xs text-text-sec outline-none focus:border-accent"
                        >
                          <option value="m2">m²</option>
                          <option value="item">item</option>
                        </select>
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        <input
                          type="number"
                          step="1"
                          min={COATS_MIN}
                          max={COATS_MAX}
                          value={r.coats}
                          onChange={(e) => patch(r.uid, { coats: Number(e.target.value) })}
                          aria-label="Coats"
                          className="rounded-ctl w-14 border border-ink-line bg-ink-deep px-2 py-1.5 text-right font-mono text-sm tabular-nums text-text-pri outline-none transition-colors focus:border-accent"
                        />
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={r.height_m ?? ''}
                          placeholder="—"
                          onChange={(e) =>
                            patch(r.uid, { height_m: e.target.value === '' ? undefined : Number(e.target.value) })
                          }
                          aria-label="Height in metres"
                          className={numClass}
                        />
                      </td>
                      <td className="py-1.5 pr-3"><SourceChip row={r} /></td>
                      <td className="py-1.5 pr-3 text-center">
                        <input
                          type="checkbox"
                          checked={r.separate_price === true}
                          onChange={(e) => patch(r.uid, { separate_price: e.target.checked })}
                          aria-label="Price separately"
                          className="cursor-pointer accent-accent"
                        />
                      </td>
                      <td className="py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={r.excluded === true}
                          onChange={(e) => patch(r.uid, { excluded: e.target.checked })}
                          aria-label="Exclude from the quote"
                          className="cursor-pointer accent-accent"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {overallNote && (
        <p className="mt-4 text-xs leading-relaxed text-text-dim">Model note · {overallNote}</p>
      )}

      {/* Confirm bar */}
      <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-ink-line pt-4">
        <label className="flex items-center gap-2 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
          Labour rate $/hr
          <input
            type="number"
            step="1"
            min="1"
            max={MAX_LABOUR_RATE_PER_HR}
            value={labourRate}
            onChange={(e) => {
              onDirty?.()
              setLabourRate(e.target.value)
              if (labourRateError) setLabourRateError(null)
            }}
            placeholder={defaultLabourRate != null ? String(defaultLabourRate) : '75'}
            aria-label="Labour rate in dollars per hour"
            title="Per-quote override. Leave blank to use your saved rate."
            className={`rounded-ctl w-20 border bg-ink-deep px-2 py-1.5 text-right font-mono text-sm tabular-nums normal-case tracking-normal text-text-pri outline-none transition-colors focus:border-accent ${
              labourRateError ? 'border-warning' : 'border-ink-line'
            }`}
          />
        </label>
        <button
          type="button"
          disabled={pricing || disabled}
          aria-busy={pricing}
          onClick={handleConfirm}
          className="rounded-ctl inline-flex cursor-pointer items-center gap-2.5 bg-accent px-5 py-3 text-sm font-bold uppercase tracking-[0.08em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pricing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Pricing…
            </>
          ) : (
            'Confirm takeoff & price'
          )}
        </button>
        <span className="font-mono text-xs tabular-nums text-text-dim">
          {rows.filter((r) => !r.excluded).length} lines · {includedArea.toFixed(0)} m² included
        </span>
        <button
          type="button"
          onClick={() => { onDirty?.(); setRows(toRows(initialItems)) }}
          className="inline-flex cursor-pointer items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-text-sec"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset edits
        </button>
        {labourRateError && (
          <p role="alert" className="w-full text-sm text-warning">
            {labourRateError}
          </p>
        )}
      </div>
    </div>
  )
}
