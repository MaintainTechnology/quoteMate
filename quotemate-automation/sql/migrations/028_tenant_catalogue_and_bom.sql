-- ════════════════════════════════════════════════════════════════════
-- Migration 028 — WP2 (operator materials catalogue + brand/range pricing)
--                + WP3 (structured bills of materials)
--                + global-vs-local estimation overrides
--
-- Mirrors the migration-023 design (tenant_custom_assemblies): tenant-owned
-- data lives in SEPARATE physically-partitioned tables, never as a nullable
-- tenant_id on a shared table — so a bug/rogue tradie cannot leak rows into
-- another tradie's quote, and RLS is trivial later (tenant_id = auth.tenant_id()).
--
-- THREE tables:
--   tenant_material_catalogue  — WP2 keystone. Each operator's real products:
--       brand (Clipsal), range/series (Iconic vs 2000), supplier, photo,
--       operator-specific prices, an `active` on/off toggle, an optional
--       tier_hint (brand+range -> Good/Better/Best). customer_supply price
--       is nullable now (WP5-compat) but not yet read by the estimator.
--   shared_assembly_bom        — WP3. The fixed, structured bill of materials
--       per shared assembly: which material categories, qty, required vs
--       optional. The estimator builds lines from THIS instead of letting
--       the model re-decide parts every time (price-wobble fix).
--   tenant_assembly_overrides  — global-vs-local. A global estimate + BOM
--       exists; a tradie toggles a service on/off (the "full catalogue they
--       choose from") and can localise labour hours / markup for their book.
--
-- TRAP (WP2): the grounding validator must accept prices that derive from
-- tenant_material_catalogue or it dumps every branded quote to inspection.
-- The validator (lib/estimate/validate.ts) is already row-agnostic — the
-- fix is feeding these rows into run.ts loadCandidatePrices, done in the
-- estimator-wiring step (NOT this migration).
--
-- Idempotent: create table if not exists + if-not-exists indexes.
-- NOT auto-applied to prod — apply with:
--   node --env-file=.env.local scripts/run-migration-028.mjs --apply
-- (only after human approval — keystone money-path schema).
-- ════════════════════════════════════════════════════════════════════

-- ── WP2 · tenant-owned materials / products catalogue ────────────────
create table if not exists tenant_material_catalogue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  trade text not null check (trade in ('electrical', 'plumbing')),

  -- Semantic grouping — aligns with shared_materials.category (migration
  -- 022) and the grounding validator's category tags so tenant rows
  -- ground + rerank exactly like shared rows.
  category text not null,

  name text not null,
  brand text,             -- e.g. Clipsal
  range_series text,      -- e.g. Iconic, 2000  (WP2 "range within a brand")
  supplier text,          -- e.g. Reece, Bunnings, Tradelink

  unit text default 'each',
  -- Operator-specific price when the tradie supplies the product.
  unit_price_ex_gst numeric(10,2) not null,
  -- Install-only price when the customer supplies it (WP5-compat;
  -- nullable, not yet read by the estimator).
  customer_supply_price_ex_gst numeric(10,2),

  -- brand+range -> tier hint. NULL = let resolveTierForBrandRange()
  -- in lib/estimate/catalogue.ts infer it.
  tier_hint text check (tier_hint in ('good', 'better', 'best')),

  image_path text,        -- product photo (WP4 render compatibility)
  properties jsonb default '{}'::jsonb,  -- shape parity w/ shared_materials filters

  -- The on/off toggle. Inactive rows are never offered to the estimator.
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tenant_material_catalogue_unique_name
  on tenant_material_catalogue (tenant_id, trade, lower(name));

create index if not exists tenant_material_catalogue_lookup_idx
  on tenant_material_catalogue (tenant_id, trade, category)
  where active = true;

create or replace function tenant_material_catalogue_set_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tenant_material_catalogue_set_updated_at
  on tenant_material_catalogue;
create trigger tenant_material_catalogue_set_updated_at
  before update on tenant_material_catalogue
  for each row
  execute function tenant_material_catalogue_set_updated_at();

-- ── WP3 · structured bill of materials per shared assembly ───────────
create table if not exists shared_assembly_bom (
  id uuid primary key default gen_random_uuid(),
  assembly_id uuid not null references shared_assemblies(id) on delete cascade,
  trade text not null check (trade in ('electrical', 'plumbing')),

  -- Which material category this BOM line needs. The estimator resolves
  -- it against tenant_material_catalogue first, then shared_materials.
  material_category text not null,
  description text,
  quantity numeric(10,2) not null default 1,
  -- Required parts are always quoted; optional parts are tier-dependent.
  required boolean not null default true,
  sort int not null default 0,

  created_at timestamptz not null default now()
);

create unique index if not exists shared_assembly_bom_unique
  on shared_assembly_bom (assembly_id, lower(material_category), lower(coalesce(description, '')));

create index if not exists shared_assembly_bom_assembly_idx
  on shared_assembly_bom (assembly_id);

-- ── global-vs-local · per-tenant override of a shared assembly ───────
create table if not exists tenant_assembly_overrides (
  tenant_id uuid not null references tenants(id) on delete cascade,
  assembly_id uuid not null references shared_assemblies(id) on delete cascade,

  -- The "full catalogue they choose from" toggle: a tradie enables/
  -- disables a global service for their own book.
  enabled boolean not null default true,

  -- Localise the global estimation parameters (NULL = use global).
  labour_hours_override numeric(6,2),
  markup_pct_override numeric(5,2),
  notes text,

  updated_at timestamptz not null default now(),
  primary key (tenant_id, assembly_id)
);

create or replace function tenant_assembly_overrides_set_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tenant_assembly_overrides_set_updated_at
  on tenant_assembly_overrides;
create trigger tenant_assembly_overrides_set_updated_at
  before update on tenant_assembly_overrides
  for each row
  execute function tenant_assembly_overrides_set_updated_at();

-- Keep PostgREST's schema cache fresh (mirrors migration 024/026 pattern).
notify pgrst, 'reload schema';
