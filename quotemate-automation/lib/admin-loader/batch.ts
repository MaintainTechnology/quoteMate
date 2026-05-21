// Batch planning for the admin bulk loader (spec §8 steps 3-5).
//
// Bridges the CSV validation layer to the staging tables: takes an uploaded
// CSV + the DB-derived validation context, and produces a STAGE-ABLE plan —
// the NEW/UPDATE rows to write to import_staged_rows, plus the REJECT rows
// with reasons for the preview.
//
// Pure: every DB-derived input (known trades/categories, existing-row keys,
// the live-tenant predicate) is passed in, so this is unit-testable without
// a database. The admin API route fetches that context, calls a planner,
// then persists `stagedRows` and returns the whole plan as the preview.
//
// Staging model: import_staged_rows.row_class is NEW|UPDATE only (migration
// 049 CHECK), so only valid, classifiable rows are staged. A REJECT row is
// reported in the plan (and the preview response) but never persisted — it
// is "fix your CSV and re-upload" feedback, not part of the committable
// batch. The §8 non-destruction guarantee is unaffected: only valid rows
// are ever candidates for the commit.

import {
  parseServicesCsv,
  validateServicesRow,
  type ServicesRowContext,
} from './services-csv'
import {
  parseMaterialsCsv,
  validateMaterialsRow,
  type MaterialsRowContext,
} from './materials-csv'

export type StagedRow = {
  target_table: 'shared_assemblies' | 'shared_materials'
  row_class: 'NEW' | 'UPDATE'
  payload: Record<string, unknown>
}

export type RejectedRow = {
  /** 1-based CSV line number (includes the header row). */
  line: number
  errors: string[]
}

export type UploadPlan =
  | { ok: false; csv: string; structuralErrors: string[] }
  | {
      ok: true
      csv: string
      target_table: 'shared_assemblies' | 'shared_materials'
      stagedRows: StagedRow[]
      rejected: RejectedRow[]
      summary: { newCount: number; updateCount: number; rejectedCount: number }
      /** §9 rule 3 — how many rows had default_enabled forced false because
       *  the trade has live tenants. Surfaced so the preview can say so. */
      forcedDisabledCount: number
    }

/** Plan a Services CSV upload into shared_assemblies staged rows. */
export function planServicesUpload(
  csvText: string,
  ctx: ServicesRowContext,
): UploadPlan {
  const parsed = parseServicesCsv(csvText)
  if (!parsed.ok) {
    return { ok: false, csv: 'services', structuralErrors: parsed.errors }
  }

  const seen = new Set<string>()
  const stagedRows: StagedRow[] = []
  const rejected: RejectedRow[] = []
  let newCount = 0
  let updateCount = 0
  let forcedDisabledCount = 0

  parsed.records.forEach((rec, i) => {
    const result = validateServicesRow(rec, ctx, seen)
    if (result.rowClass === 'REJECT') {
      rejected.push({ line: i + 2, errors: result.errors })
      return
    }
    stagedRows.push({
      target_table: 'shared_assemblies',
      row_class: result.rowClass,
      payload: result.parsed as unknown as Record<string, unknown>,
    })
    if (result.rowClass === 'NEW') newCount++
    else updateCount++
    if (result.forcedDisabled) forcedDisabledCount++
  })

  return {
    ok: true,
    csv: 'services',
    target_table: 'shared_assemblies',
    stagedRows,
    rejected,
    summary: { newCount, updateCount, rejectedCount: rejected.length },
    forcedDisabledCount,
  }
}

/** Plan a Materials CSV upload into shared_materials staged rows. */
export function planMaterialsUpload(
  csvText: string,
  ctx: MaterialsRowContext,
): UploadPlan {
  const parsed = parseMaterialsCsv(csvText)
  if (!parsed.ok) {
    return { ok: false, csv: 'materials', structuralErrors: parsed.errors }
  }

  const seen = new Set<string>()
  const stagedRows: StagedRow[] = []
  const rejected: RejectedRow[] = []
  let newCount = 0
  let updateCount = 0

  parsed.records.forEach((rec, i) => {
    const result = validateMaterialsRow(rec, ctx, seen)
    if (result.rowClass === 'REJECT') {
      rejected.push({ line: i + 2, errors: result.errors })
      return
    }
    stagedRows.push({
      target_table: 'shared_materials',
      row_class: result.rowClass,
      payload: result.parsed as unknown as Record<string, unknown>,
    })
    if (result.rowClass === 'NEW') newCount++
    else updateCount++
  })

  return {
    ok: true,
    csv: 'materials',
    target_table: 'shared_materials',
    stagedRows,
    rejected,
    summary: { newCount, updateCount, rejectedCount: rejected.length },
    forcedDisabledCount: 0, // materials have no default_enabled flag
  }
}
