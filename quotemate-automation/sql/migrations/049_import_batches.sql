-- ════════════════════════════════════════════════════════════════════
-- Migration 049 — import_batches + import_staged_rows (Phase 0)
--
-- The audit + staging tables for the admin bulk loader (spec §5, §8).
--
-- import_batches — one row per Approve. `idempotency_key` makes Approve
-- safe against a double-click / retry (Safety Rule 12). `changes` holds
-- the before-values of every updated row, so a committed batch can be
-- rolled back (Safety Rule 9).
--
-- import_staged_rows — the staging area. Uploaded + manually-added rows
-- land HERE first; no live table is touched until the §8 commit. This
-- is the mechanism behind the non-destruction guarantee.
--
-- Both hold admin audit data — Safety Rule 15: never anon-readable.
-- They are reached only via service-role from the admin API, so
-- RLS-off is acceptable for now (mirrors supplier_catalogue / mig 041).
--
-- ADDITIVE ONLY. No dependency on other Phase 0 migrations.
-- Apply with: node --env-file=.env.local scripts/run-migration-049.mjs
-- ════════════════════════════════════════════════════════════════════

create table if not exists import_batches (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  admin_user_id uuid not null,
  source text,                          -- CSV filename / 'manual'
  status text not null default 'staged'
    check (status in ('staged', 'committed', 'rolled_back', 'failed')),
  -- before-values of every UPDATE row, keyed for rollback.
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  committed_at timestamptz
);

create table if not exists import_staged_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references import_batches(id) on delete cascade,
  target_table text not null,           -- shared_assemblies / shared_materials / …
  row_class text not null check (row_class in ('NEW', 'UPDATE')),
  payload jsonb not null,               -- the parsed, normalised row
  validation_status text not null default 'pending'
    check (validation_status in ('pending', 'passed', 'rejected')),
  validation_reason text,
  smoke_status text not null default 'pending'
    check (smoke_status in ('pending', 'passed', 'failed', 'skipped')),
  smoke_reason text,
  created_at timestamptz not null default now()
);

create index if not exists import_staged_rows_batch_idx
  on import_staged_rows (batch_id);

notify pgrst, 'reload schema';
