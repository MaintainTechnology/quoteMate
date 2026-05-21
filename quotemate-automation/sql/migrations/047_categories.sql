-- ════════════════════════════════════════════════════════════════════
-- Migration 047 — categories table (Phase 0 · admin bulk loader)
--
-- Replaces the hardcoded `Category` set in lib/estimate/validate.ts /
-- lib/estimate/categories.ts with a data table, so a new trade's
-- categories can be added without a TypeScript edit (spec §5, §9).
--
-- Backfills every distinct (trade, category) currently on
-- shared_assemblies, so the FK added in migration 051
-- (shared_assemblies.category → categories) has a target for every
-- existing row. grounding_tag defaults to the category name — they are
-- the same value today; the granular-vs-grounding vocab reconciliation
-- is a §14 open item, deliberately not done here.
--
-- ADDITIVE ONLY — nothing reads this table until the Phase 0 code
-- refactor + migration 051. Depends on migration 046 (trades).
--
-- Idempotent: create table if not exists + on-conflict-do-nothing.
-- Apply with: node --env-file=.env.local scripts/run-migration-047.mjs
-- ════════════════════════════════════════════════════════════════════

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references trades(id) on delete cascade,
  name text not null,                   -- the category value used today
  grounding_tag text not null,          -- the validator tag it grounds against
  created_at timestamptz not null default now(),
  unique (trade_id, name)
);

-- Backfill: every distinct (trade, category) on shared_assemblies.
insert into categories (trade_id, name, grounding_tag)
select t.id, src.category, src.category
  from (
    select distinct trade, category
      from shared_assemblies
     where category is not null and trade is not null
  ) src
  join trades t on t.name = src.trade
on conflict (trade_id, name) do nothing;

notify pgrst, 'reload schema';
