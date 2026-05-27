-- Migration 074 · Quality-agent findings tables
--
-- Adds the three Supabase tables the mt-qm-quality-agents service
-- writes its outputs to:
--   eval_runs               — top-level run record + total/per-category score
--   eval_run_items          — per-fixture scoring breakdown
--   catalogue_findings      — suggested catalogue edits from Catalogue QA
--   tradie_edit_patterns    — clustered edit signals from Tradie-Learn
--
-- IMPORTANT: agents NEVER auto-apply changes. Every finding is a
-- review-queue item. The QuoteMate admin dashboard reads from these
-- tables and provides approve/reject controls. Approving a catalogue
-- finding triggers a separate "apply" step that writes the suggested
-- value to the live shared_materials / shared_assemblies row.
--
-- RLS: enabled, no positive policies (service-role-only). Matches the
-- post-migration-040 convention for new tables.

begin;

-- ───────────────────────────────────────────────────────────────────
-- Eval Agent — runs + per-fixture items
-- ───────────────────────────────────────────────────────────────────

create table if not exists public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  prompt_version text not null,
  catalogue_version text not null,
  total_score numeric(5,2) not null,
  per_category jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists eval_runs_started_at_idx
  on public.eval_runs (started_at desc);

create table if not exists public.eval_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.eval_runs(id) on delete cascade,
  intake_fixture_id text not null,
  expected jsonb not null,
  actual jsonb not null,
  dim_price numeric(5,2),
  dim_material numeric(5,2),
  dim_tier numeric(5,2),
  dim_scope numeric(5,2),
  dim_routing numeric(5,2),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists eval_run_items_run_idx
  on public.eval_run_items (run_id);

-- ───────────────────────────────────────────────────────────────────
-- Catalogue QA — suggested catalogue edits
-- ───────────────────────────────────────────────────────────────────

create table if not exists public.catalogue_findings (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  source_table text not null
    check (source_table in (
      'shared_materials',
      'shared_assemblies',
      'supplier_catalogue',
      'tenant_material_catalogue'
    )),
  source_row_id uuid not null,
  finding_type text not null
    check (finding_type in (
      'price_drift',
      'description_mismatch',
      'sku_missing',
      'category_mismatch'
    )),
  current_value jsonb,
  suggested_value jsonb,
  confidence numeric(3,2),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','applied')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists catalogue_findings_status_idx
  on public.catalogue_findings (status, created_at desc);

create index if not exists catalogue_findings_row_idx
  on public.catalogue_findings (source_row_id, finding_type, created_at desc);

-- ───────────────────────────────────────────────────────────────────
-- Tradie-Learn — clustered edit patterns
-- ───────────────────────────────────────────────────────────────────

create table if not exists public.tradie_edit_patterns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  trade text not null,
  job_type text not null,
  field text not null,
  edit_direction text not null
    check (edit_direction in ('up','down','rename','swap')),
  median_delta numeric(10,2),
  sample_count int not null,
  observed_period_start timestamptz,
  observed_period_end timestamptz,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','applied')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists tradie_edit_patterns_tenant_idx
  on public.tradie_edit_patterns (tenant_id, status, created_at desc);

-- ───────────────────────────────────────────────────────────────────
-- RLS — service-role-only (no positive policies). Matches the
-- post-040 convention for new tables.
-- ───────────────────────────────────────────────────────────────────

alter table public.eval_runs            enable row level security;
alter table public.eval_run_items       enable row level security;
alter table public.catalogue_findings   enable row level security;
alter table public.tradie_edit_patterns enable row level security;

commit;
