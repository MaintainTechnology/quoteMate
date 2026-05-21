-- ════════════════════════════════════════════════════════════════════
-- Migration 050 — admin_users (Phase 0 · admin bulk loader)
--
-- The admin-auth gate (spec §5, Safety Rule 4). "Admin" = an auth user
-- whose id is in this table. The admin dashboard route and every
-- upload/approve API check membership SERVER-SIDE before doing anything.
--
-- Deliberately a separate table, not a flag on `tenants`: an admin is
-- internal QuoteMate staff, not a tradie tenant — keeping the two
-- identities separate avoids any chance of a tenant escalating to admin.
-- Rows are inserted by hand (internal staff only); no UI creates them.
--
-- ADDITIVE ONLY. No dependency on other Phase 0 migrations.
-- Apply with: node --env-file=.env.local scripts/run-migration-050.mjs
-- ════════════════════════════════════════════════════════════════════

create table if not exists admin_users (
  user_id uuid primary key,             -- references auth.users(id)
  note text,                            -- who this is, for the audit trail
  created_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
