-- ════════════════════════════════════════════════════════════════════
-- Migration 031 — tenant-owned bills of materials (the editable "recipe
-- book", WP3 made fully tradie-controllable from the dashboard).
--
-- WHY a separate table (not edits to shared_assembly_bom):
--   shared_assembly_bom is GLOBAL — one recipe per shared job, used by
--   every tradie. Letting a tradie edit it from their dashboard would
--   change everyone's quotes. So each tradie gets their OWN parts list
--   per job here — exactly the migration-023 / migration-028 pattern
--   (tenant-owned, physically partitioned, RLS-trivial later, a bug or
--   rogue tradie can't leak rows into another tradie's quote).
--
-- Estimator behaviour (run.ts buildBomHint): a tenant's own BOM for a
-- job is preferred; if they have none, it falls back to the shared
-- baseline. Empty table => no change for anyone (purely additive).
--
-- THIS IS THE ONLY MIGRATION the recipe feature needs. After it, every
-- add/edit/remove is done in the dashboard UI via /api/tenant/bom —
-- no more scripts or migrations to manage recipe DATA.
--
-- Idempotent. NOT auto-applied to prod — apply with:
--   node --env-file=.env.local scripts/run-migration-031.mjs --apply
-- ════════════════════════════════════════════════════════════════════

create table if not exists tenant_assembly_bom (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  assembly_id uuid not null references shared_assemblies(id) on delete cascade,
  trade text not null check (trade in ('electrical', 'plumbing')),

  -- Which material category this line needs; the estimator resolves it
  -- against the tenant catalogue first, then shared materials.
  material_category text not null,
  description text,
  quantity numeric(10,2) not null default 1,
  -- Required parts are always quoted; optional parts are tier-dependent.
  required boolean not null default true,
  sort int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tenant_assembly_bom_unique
  on tenant_assembly_bom (tenant_id, assembly_id, lower(material_category), lower(coalesce(description, '')));

create index if not exists tenant_assembly_bom_lookup_idx
  on tenant_assembly_bom (tenant_id, assembly_id);

create or replace function tenant_assembly_bom_set_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tenant_assembly_bom_set_updated_at on tenant_assembly_bom;
create trigger tenant_assembly_bom_set_updated_at
  before update on tenant_assembly_bom
  for each row
  execute function tenant_assembly_bom_set_updated_at();

notify pgrst, 'reload schema';
