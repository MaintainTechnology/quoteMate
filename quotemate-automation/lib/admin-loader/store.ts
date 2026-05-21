// Staging-table persistence for the admin bulk loader (spec §8 steps 4-5).
//
// This is the thin DB layer between the pure batch planner (batch.ts) and
// the live tables. It only ever writes the STAGING tables — import_batches
// and import_staged_rows. No live table (shared_assemblies, …) is touched
// here; that happens exclusively in the §8 commit (a later increment).
//
// All writes use the service-role client from inside the admin API route,
// which has already passed the isAdminUser() gate.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { StagedRow } from './batch'

export type CreateBatchResult =
  | { ok: true; batchId: string; alreadyExists: boolean }
  | { ok: false; error: string }

/**
 * Create the import_batches row for an upload.
 *
 * idempotency_key is UNIQUE (migration 049). A retry / double-submit with
 * the same key must NOT create a second batch (§9 rule 12) — so this looks
 * the key up first and returns the existing batch if present, and also
 * re-selects if a concurrent insert wins the race.
 */
export async function createBatch(
  client: SupabaseClient,
  args: { idempotencyKey: string; adminUserId: string; source: string | null },
): Promise<CreateBatchResult> {
  const existing = await client
    .from('import_batches')
    .select('id, status')
    .eq('idempotency_key', args.idempotencyKey)
    .maybeSingle()
  if (existing.data?.id) {
    return { ok: true, batchId: existing.data.id as string, alreadyExists: true }
  }

  const inserted = await client
    .from('import_batches')
    .insert({
      idempotency_key: args.idempotencyKey,
      admin_user_id: args.adminUserId,
      source: args.source,
      status: 'staged',
    })
    .select('id')
    .single()

  if (!inserted.error && inserted.data?.id) {
    return { ok: true, batchId: inserted.data.id as string, alreadyExists: false }
  }

  // A concurrent request may have inserted the same idempotency_key between
  // our lookup and insert — the UNIQUE constraint rejects ours. Re-select.
  const raced = await client
    .from('import_batches')
    .select('id')
    .eq('idempotency_key', args.idempotencyKey)
    .maybeSingle()
  if (raced.data?.id) {
    return { ok: true, batchId: raced.data.id as string, alreadyExists: true }
  }
  return {
    ok: false,
    error: inserted.error?.message ?? 'could not create import batch',
  }
}

export type StageRowsResult =
  | { ok: true; staged: number }
  | { ok: false; error: string }

/**
 * Write a plan's NEW/UPDATE rows into import_staged_rows. Every row is
 * stored validation_status='passed' — only rows that passed validation are
 * staged; REJECT rows are reported in the preview but never persisted
 * (migration 049's row_class CHECK is NEW|UPDATE only).
 *
 * smoke_status='skipped': the §8-step-7 smoke-test harness is a later
 * increment. commit_import_batch commits rows whose smoke_status is
 * 'passed' OR 'skipped', so staging 'skipped' lets a validated batch
 * commit today. When the harness ships it will stage 'pending', run the
 * sample-quote drafts, and move each row to 'passed' / 'failed'.
 */
export async function stageRows(
  client: SupabaseClient,
  batchId: string,
  rows: StagedRow[],
): Promise<StageRowsResult> {
  if (rows.length === 0) return { ok: true, staged: 0 }
  const { error } = await client.from('import_staged_rows').insert(
    rows.map((r) => ({
      batch_id: batchId,
      target_table: r.target_table,
      row_class: r.row_class,
      payload: r.payload,
      validation_status: 'passed',
      smoke_status: 'skipped',
    })),
  )
  if (error) return { ok: false, error: error.message }
  return { ok: true, staged: rows.length }
}

export type StagedRowRecord = {
  id: string
  target_table: string
  row_class: 'NEW' | 'UPDATE'
  payload: Record<string, unknown>
  validation_status: string
  smoke_status: string
  smoke_reason: string | null
}

export type BatchRecord = {
  id: string
  status: string
  source: string | null
  created_at: string
  committed_at: string | null
  rows: StagedRowRecord[]
}

/** Load a batch and its staged rows — for the preview screen and commit. */
export async function loadBatch(
  client: SupabaseClient,
  batchId: string,
): Promise<{ ok: true; batch: BatchRecord } | { ok: false; error: string }> {
  const batch = await client
    .from('import_batches')
    .select('id, status, source, created_at, committed_at')
    .eq('id', batchId)
    .maybeSingle()
  if (batch.error) return { ok: false, error: batch.error.message }
  if (!batch.data) return { ok: false, error: 'batch not found' }

  const rows = await client
    .from('import_staged_rows')
    .select(
      'id, target_table, row_class, payload, validation_status, smoke_status, smoke_reason',
    )
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true })
  if (rows.error) return { ok: false, error: rows.error.message }

  return {
    ok: true,
    batch: {
      id: batch.data.id as string,
      status: batch.data.status as string,
      source: (batch.data.source as string | null) ?? null,
      created_at: batch.data.created_at as string,
      committed_at: (batch.data.committed_at as string | null) ?? null,
      rows: (rows.data ?? []) as StagedRowRecord[],
    },
  }
}
