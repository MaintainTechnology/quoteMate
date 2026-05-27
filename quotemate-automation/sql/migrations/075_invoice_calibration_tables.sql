-- A5 — Invoice-history calibration tables.
--
-- Three new tables that back the dashboard's "upload your past invoices,
-- we tune your prices" workflow. The math + suggestion logic lives in
-- lib/dashboard/invoice-calibration.ts (pure, unit-tested); these tables
-- are the durable store of:
--
--   invoice_uploads       — raw uploaded files + status
--   invoice_extractions   — Opus-structured contents of each upload
--   pricing_suggestions   — proposed pricing_book deltas (with audit
--                           trail of accept/reject)
--
-- All three are RLS-on (no policies — service role bypasses; matches the
-- Phase 1.5 pattern from migration 060). Service-role API routes do the
-- tenant-scoping in code.

create extension if not exists "pgcrypto";

-- ────────────────────────────────────────────────────────────────────
-- invoice_uploads — raw file + state machine
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.invoice_uploads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- Supabase Storage path; null when the upload predates storage write
  -- (e.g. inline-base64 uploads for v1 testing).
  storage_path text,
  -- "image/jpeg" | "image/png" | "application/pdf"
  mime_type text,
  -- "uploaded" | "extracting" | "extracted" | "failed"
  status text not null default 'uploaded',
  -- Surface upstream errors when extraction fails.
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invoice_uploads_tenant_idx
  on public.invoice_uploads(tenant_id, created_at desc);

alter table public.invoice_uploads enable row level security;

-- ────────────────────────────────────────────────────────────────────
-- invoice_extractions — the structured form of an upload
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.invoice_extractions (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid not null references public.invoice_uploads(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- The shape this fits is lib/dashboard/invoice-calibration.ts ::
  -- InvoiceExtraction. We keep the whole blob for forward-compat and
  -- mirror the heavy-use fields into typed columns for fast filtering.
  raw jsonb not null,
  scope_description text,
  total_inc_gst numeric,
  job_type_guess text,
  quantity numeric,
  customer_name text,
  customer_suburb text,
  invoice_date date,
  -- The recipe match outcome — populated by buildCalibrationReport on
  -- read, NOT on write, so we don't need to re-extract when the
  -- catalogue changes. Kept here only for audit log convenience.
  matched_assembly_id uuid,
  match_confidence text, -- 'high'|'medium'|'low'|null
  created_at timestamptz not null default now()
);

create index if not exists invoice_extractions_tenant_idx
  on public.invoice_extractions(tenant_id, created_at desc);

create index if not exists invoice_extractions_upload_idx
  on public.invoice_extractions(upload_id);

alter table public.invoice_extractions enable row level security;

-- ────────────────────────────────────────────────────────────────────
-- pricing_suggestions — proposed pricing_book deltas
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.pricing_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- v1 always 'plumbing' or 'electrical'; future-proof against trades-as-data.
  trade text not null,
  -- Single-field suggestions today; widen to enum if more fields land.
  field text not null check (field in ('hourly_rate')),
  current_value numeric not null,
  suggested_value numeric not null,
  delta numeric not null,
  delta_pct numeric not null,
  -- Trust label from suggestHourlyRateAdjustment.
  trust text not null check (trust in ('high','medium','low','reject')),
  reject_reason text,
  -- Human-readable explanation surfaced to the tradie.
  reason text not null,
  -- Diagnostic stats for the UI ("range +5% to +8%, median +6%").
  invoices_used integer not null default 0,
  diff_pct_min numeric,
  diff_pct_max numeric,
  diff_pct_median numeric,
  -- Lifecycle: 'pending' | 'accepted' | 'rejected' | 'superseded'.
  status text not null default 'pending'
    check (status in ('pending','accepted','rejected','superseded')),
  -- Audit trail.
  accepted_at timestamptz,
  rejected_at timestamptz,
  accepted_by_user_id uuid,
  rejected_by_user_id uuid,
  -- The pricing_book row that was updated when accepted; lets us reverse
  -- the suggestion if a tradie regrets it.
  applied_pricing_book_id uuid,
  prior_pricing_book_value numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pricing_suggestions_tenant_pending_idx
  on public.pricing_suggestions(tenant_id, status, created_at desc);

alter table public.pricing_suggestions enable row level security;

-- ────────────────────────────────────────────────────────────────────
-- Touch trigger — keep updated_at fresh on update for both mutable tables
-- ────────────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists invoice_uploads_touch on public.invoice_uploads;
create trigger invoice_uploads_touch
  before update on public.invoice_uploads
  for each row execute procedure public.touch_updated_at();

drop trigger if exists pricing_suggestions_touch on public.pricing_suggestions;
create trigger pricing_suggestions_touch
  before update on public.pricing_suggestions
  for each row execute procedure public.touch_updated_at();
