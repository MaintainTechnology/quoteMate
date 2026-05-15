-- ════════════════════════════════════════════════════════════════════
-- Migration 022 — tenant material preferences (preferred brands per
-- category)
--
-- Background: pre-022 the LLM picked materials from shared_materials
-- by a name+brand ilike search re-ranked with a cross-encoder. Every
-- tradie on the platform got the same picks. Tradies have brand
-- loyalties (one electrician always installs Clipsal, another always
-- Deta; one plumber prefers Rheem gas storage, another prefers
-- Rinnai). To make the catalogue actually reflect each tradie's
-- supply chain, we need a per-tenant preference layer.
--
-- Design:
--   • `category` column on shared_materials — semantic grouping
--     (downlight, gpo, hws_gas, tapware_basin, toilet, etc.) so a
--     single preference row can bias all candidates in that category
--     toward the tradie's brand. Without categories every preference
--     would have to be per-SKU, which is heavy on UX and storage.
--   • `tenant_material_preferences` table — (tenant_id, category,
--     preferred_brand). Composite PK so each tenant has at most one
--     preferred brand per category. "Soft" preference — Opus is
--     instructed in the system prompt to prefer the brand when a
--     matching candidate exists, but fall back to other brands when
--     the customer's tier/spec requirement can only be met by another
--     brand. Never starves a quote.
--   • No tenant-specific price override yet — that's a future
--     enhancement once we have real-tradie buying data to validate
--     against. For now preferences only influence brand selection.
--
-- Idempotent: column add uses `if not exists`; backfills use
-- `where category is null` so re-running won't clobber manual edits;
-- preferences table is `create table if not exists`.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. category column on shared_materials ────────────────────────
alter table shared_materials
  add column if not exists category text;

-- Index for category lookups (used by the dashboard to enumerate
-- distinct brands per category, and by the estimator to scope
-- preference matches).
create index if not exists shared_materials_category_idx
  on shared_materials (trade, category)
  where category is not null;

-- ── 2. Backfill categories — electrical ───────────────────────────
update shared_materials set category = 'downlight'
  where category is null and trade = 'electrical'
    and name ilike '%downlight%';

update shared_materials set category = 'gpo'
  where category is null and trade = 'electrical'
    and name ilike '%gpo%';

update shared_materials set category = 'smoke_alarm'
  where category is null and trade = 'electrical'
    and name ilike '%smoke alarm%';

update shared_materials set category = 'safety_switch'
  where category is null and trade = 'electrical'
    and (name ilike '%rcbo%' or name ilike '%safety switch%');

update shared_materials set category = 'ceiling_fan'
  where category is null and trade = 'electrical'
    and name ilike '%ceiling fan%';

update shared_materials set category = 'outdoor_light'
  where category is null and trade = 'electrical'
    and name ilike '%outdoor%'
    and name ilike '%light%';

update shared_materials set category = 'sundries'
  where category is null and trade = 'electrical'
    and name ilike '%sundries%';

-- ── 3. Backfill categories — plumbing ─────────────────────────────
update shared_materials set category = 'hws_electric'
  where category is null and trade = 'plumbing'
    and name ilike '%electric hws%';

-- Gas storage AND continuous-flow both roll up under hws_gas — most
-- tradies have a single preferred gas-HWS brand regardless of style.
update shared_materials set category = 'hws_gas'
  where category is null and trade = 'plumbing'
    and (name ilike '%gas storage hws%' or name ilike '%gas continuous-flow%');

update shared_materials set category = 'hws_heat_pump'
  where category is null and trade = 'plumbing'
    and name ilike '%heat pump hws%';

-- Tapware sub-categories. "Premium wall-mounted mixer" rolls under
-- tapware_basin per the seed comment in init.sql (the basin/bath
-- best-tier mixer).
update shared_materials set category = 'tapware_basin'
  where category is null and trade = 'plumbing'
    and (name ilike '%basin tap%' or name ilike '%wall-mounted mixer%');

update shared_materials set category = 'tapware_kitchen'
  where category is null and trade = 'plumbing'
    and name ilike '%kitchen%';

update shared_materials set category = 'tapware_laundry'
  where category is null and trade = 'plumbing'
    and name ilike '%laundry tap%';

update shared_materials set category = 'tapware_outdoor'
  where category is null and trade = 'plumbing'
    and name ilike '%garden tap%';

update shared_materials set category = 'toilet'
  where category is null and trade = 'plumbing'
    and (name ilike '%toilet suite%' or name ilike '%smart toilet%');

update shared_materials set category = 'toilet_repair'
  where category is null and trade = 'plumbing'
    and name ilike '%cistern internals%';

update shared_materials set category = 'sundries'
  where category is null and trade = 'plumbing'
    and name ilike '%sundries%';

-- ── 4. tenant_material_preferences table ──────────────────────────
-- One preferred brand per (tenant, category). NULL preferred_brand
-- means "no preference set" — handled by simply not inserting a row
-- for that category. The route reads only present rows.
create table if not exists tenant_material_preferences (
  tenant_id uuid not null references tenants(id) on delete cascade,
  category text not null,
  preferred_brand text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, category)
);

-- Index for tenant-scoped lookups (the only access pattern: fetch
-- every preference for a given tenant when building the estimator
-- prompt or rendering the dashboard).
create index if not exists tenant_material_preferences_tenant_idx
  on tenant_material_preferences (tenant_id);
