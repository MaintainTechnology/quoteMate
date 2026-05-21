-- ════════════════════════════════════════════════════════════════════
-- Migration 046 — trades registry (Phase 0 · admin bulk loader)
--
-- See quotemate-automation/docs/admin-bulk-loader-spec.md §5 and
-- docs/strategy.md v9. Today `trade` is a hardcoded 'electrical' |
-- 'plumbing' string enforced by CHECK constraints across migrations
-- 028/031/041. This table makes a trade a DATA ROW so new install-type
-- trades (carpentry, handyman, …) can be added without code.
--
-- ADDITIVE ONLY. It creates the registry and backfills the two live
-- trades. The CHECK→FK swap is a LATER migration (051) which must run
-- only after this backfill exists. Applying 046 alone changes no
-- behaviour — nothing reads `trades` until the Phase 0 code refactor.
--
-- Idempotent: create table if not exists + on-conflict-do-nothing seed.
-- Apply with: node --env-file=.env.local scripts/run-migration-046.mjs
-- ════════════════════════════════════════════════════════════════════

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,            -- 'electrical', 'plumbing', 'carpentry'
  display_name text not null,           -- 'Electrical', 'Plumbing'
  -- §2.1 — the loader only serves trades that quote a discrete job
  -- (assemblies + materials + Good/Better/Best). Recurring-service
  -- trades (pool/garden cleaning) are a separate future project.
  is_job_based boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Backfill the two live trades. electrical + plumbing must exist as
-- rows before migration 051 can point the FK constraints at them.
insert into trades (name, display_name, is_job_based, active)
values
  ('electrical', 'Electrical', true, true),
  ('plumbing',   'Plumbing',   true, true)
on conflict (name) do nothing;

-- Keep PostgREST's schema cache fresh (mirrors migration 041 pattern).
notify pgrst, 'reload schema';
