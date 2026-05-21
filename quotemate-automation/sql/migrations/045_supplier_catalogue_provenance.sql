-- ════════════════════════════════════════════════════════════════════
-- Migration 045 — supplier_catalogue provenance (CSV bulk-upload)
--
-- The CSV bulk-upload feature lets a tradie populate the SHARED
-- supplier_catalogue library (the "Browse supplier catalogue" UI). Rows
-- a tradie uploads become visible to EVERY other tenant — so we need to
-- know where each row came from. Two columns:
--
--   • created_by_tenant_id — the tenant whose self-serve upload created
--     this row. NULL = operator-curated (seed script or operator CSV).
--     ON DELETE SET NULL so removing a tenant never orphans library rows.
--   • source — coarse provenance tag, NOT NULL default 'admin':
--       'seed'       — original seed-supplier-catalogue.mjs rows.
--       'admin'      — operator CSV / operator-curated (the default).
--       'tenant_csv' — uploaded by a tradie via /api/supplier-catalogue/import.
--
-- Why provenance and not full moderation: the product decision (2026-05-21)
-- is that tradie uploads are visible immediately. These columns are the
-- minimum that keeps that auditable — a future review gate can filter on
-- `source = 'tenant_csv'` cheaply without another migration.
--
-- Money-path impact: NONE. supplier_catalogue is never read by the
-- grounding validator (see migration 041's header) — money flows only
-- through tenant_material_catalogue + shared_materials. Adding two
-- nullable/defaulted columns to a library table cannot regress a quote.
--
-- Idempotent: add column if not exists + if-not-exists index/constraint.
--
-- NOT auto-applied to prod — apply with:
--   node --env-file=.env.local scripts/run-migration-045.mjs
-- ════════════════════════════════════════════════════════════════════

alter table supplier_catalogue
  add column if not exists created_by_tenant_id uuid
    references tenants (id) on delete set null;

alter table supplier_catalogue
  add column if not exists source text not null default 'admin';

-- Enum guard on `source`. Added separately so re-running the migration
-- doesn't error on an already-present constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'supplier_catalogue_source_check'
  ) then
    alter table supplier_catalogue
      add constraint supplier_catalogue_source_check
      check (source in ('seed', 'admin', 'tenant_csv'));
  end if;
end $$;

-- Lets the (future) moderation view and "rows I uploaded" filters scan
-- by uploading tenant without a seq-scan of the whole library.
create index if not exists supplier_catalogue_created_by_idx
  on supplier_catalogue (created_by_tenant_id)
  where created_by_tenant_id is not null;
