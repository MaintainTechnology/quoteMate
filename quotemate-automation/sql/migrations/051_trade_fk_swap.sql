-- ════════════════════════════════════════════════════════════════════
-- Migration 051 — trade CHECK→FK swap + shared_assemblies.retired_at
--                  (Phase 0 · admin bulk loader — the risky ALTER)
--
-- This is the ONE Phase 0 migration that ALTERs existing tables. It:
--   1. Adds `shared_assemblies.retired_at` (soft-delete; spec §11).
--   2. Drops the `trade in ('electrical','plumbing')` CHECK constraints
--      and replaces each with a foreign key to trades(name).
--
-- CORRECTED LIST (2026-05-21): an authoritative pg_constraint query
-- found SEVEN tables carry the trade CHECK, not the four the spec named.
-- The spec's earlier list came from a narrow 3-file grep and missed
-- tenant_custom_assemblies, tenant_licences, and — critically — `tenants`
-- itself. Without `tenants` in the swap, a new trade could not have a
-- tenant. The seven:
--   shared_assembly_bom, supplier_catalogue, tenant_assembly_bom,
--   tenant_custom_assemblies, tenant_licences, tenant_material_catalogue,
--   tenants.
-- (`tenant_assembly_overrides` has no trade column — it was a spec typo.)
--
-- Safe because: every existing `trade` value is already 'electrical' or
-- 'plumbing' (the CHECK guaranteed it), and migration 046 backfilled
-- both into `trades`. The FK ADD validates against rows that all
-- already match — it cannot fail on existing data.
--
-- Wrapped in BEGIN/COMMIT — all-or-nothing. CHECK constraints are found
-- by inspecting pg_constraint, robust against auto-generated names.
--
-- DEFERRED (spec §5 also listed "shared_assemblies.category → FK to
-- categories"): `categories` has a COMPOSITE unique key (trade_id,
-- name), so a hard FK from the bare `shared_assemblies.category` text
-- column needs a `category_id` column + backfill first. The spec's
-- actual goal (§9 Rule 1 — category validated against the categories
-- table) is met by application-layer validation in the loader. A hard
-- DB FK can be added later via `category_id`. Documented, not silent.
--
-- Idempotent: add-column-if-not-exists; DO blocks no-op if the CHECK is
-- gone / the FK exists.
-- Apply with: node --env-file=.env.local scripts/run-migration-051.mjs
-- ════════════════════════════════════════════════════════════════════

begin;

-- 1. shared_assemblies soft-delete column.
alter table shared_assemblies
  add column if not exists retired_at timestamptz;

-- 2. For each of the 7 tables: drop the trade CHECK, add the trade FK.
do $$
declare
  tbl   text;
  cname text;
  tables text[] := array[
    'shared_assembly_bom',
    'supplier_catalogue',
    'tenant_assembly_bom',
    'tenant_custom_assemblies',
    'tenant_licences',
    'tenant_material_catalogue',
    'tenants'
  ];
begin
  foreach tbl in array tables loop
    -- Drop any CHECK constraint on this table whose definition
    -- references the `trade` column (robust against auto-named checks).
    for cname in
      select conname from pg_constraint
       where conrelid = tbl::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) ilike '%trade%'
    loop
      execute format('alter table %I drop constraint %I', tbl, cname);
      raise notice 'dropped CHECK % on %', cname, tbl;
    end loop;

    -- Add the FK to trades(name) if it is not already there.
    if not exists (
      select 1 from pg_constraint
       where conrelid = tbl::regclass
         and contype = 'f'
         and conname = tbl || '_trade_fk'
    ) then
      execute format(
        'alter table %I add constraint %I foreign key (trade) references trades(name)',
        tbl, tbl || '_trade_fk'
      );
      raise notice 'added FK %_trade_fk', tbl;
    end if;
  end loop;
end $$;

-- Keep PostgREST's schema cache fresh.
notify pgrst, 'reload schema';

commit;
