-- ════════════════════════════════════════════════════════════════════
-- Migration 029 — explicit validator category on assemblies
--
-- Background: migration 021 added the catalogue "extras", but the
-- grounding validator's categorise() name-regex (lib/estimate/validate.ts)
-- was never extended to cover them. Result: 10 priced services had NO
-- recognised category, so an 'each'/'lm' quote line drafted from one of
-- them could fail the SEMANTIC grounding check (price correct, category
-- mismatch) and downgrade an otherwise-quotable job to the $199
-- inspection route. Not a wrong-price risk (the validator still blocks
-- fabricated prices) — a lost-instant-quote risk.
--
-- This adds an OPTIONAL `category` column so a row can declare its
-- grounding category explicitly. validate.ts folds it in ADDITIVELY —
-- it is added to the name-derived tags, never replaces them — so the
-- column can only ever make grounding recognise the correct category;
-- it can never drop a tag and regress a row that already grounds today.
--
-- Deploy-order-safe: NULL category = unchanged (name-regex) behaviour,
-- and lib/estimate/run.ts selects with `*` so a pre-029 prod without
-- this column simply yields category=undefined → regex fallback. The
-- migration may be applied before OR after the code deploy.
--
-- Idempotent: `add column if not exists` + deterministic backfill keyed
-- by (trade, name) — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

alter table shared_assemblies
  add column if not exists category text;
alter table tenant_custom_assemblies
  add column if not exists category text;

comment on column shared_assemblies.category is
  'Explicit grounding category — must be a value of the Category union in lib/estimate/validate.ts. NULL → fall back to categorise() name regex. Added migration 029.';
comment on column tenant_custom_assemblies.category is
  'Explicit grounding category — must be a value of the Category union in lib/estimate/validate.ts. NULL → fall back to categorise() name regex. Added migration 029.';

-- ── Backfill the 10 migration-021 extras the name regex could not tag.
-- Names are matched exactly as seeded in migration 021 (verified against
-- prod via scripts/audit-service-pricing.mjs, 2026-05-19).
update shared_assemblies set category = 'fault_find'        where trade = 'electrical' and name = 'Diagnostic call-out (fault finding)';
update shared_assemblies set category = 'strip_light'       where trade = 'electrical' and name = 'Install LED strip lighting';
update shared_assemblies set category = 'outdoor_light'     where trade = 'electrical' and name = 'Install motion sensor flood light';
update shared_assemblies set category = 'security_camera'   where trade = 'electrical' and name = 'Install security camera (single)';
update shared_assemblies set category = 'doorbell_intercom' where trade = 'electrical' and name = 'Install wired doorbell or intercom';
update shared_assemblies set category = 'dishwasher'        where trade = 'plumbing'   and name = 'Install dishwasher';
update shared_assemblies set category = 'rainwater_tank'    where trade = 'plumbing'   and name = 'Install rainwater tank';
update shared_assemblies set category = 'water_filter'      where trade = 'plumbing'   and name = 'Install whole-house water filter';
update shared_assemblies set category = 'leak_detection'    where trade = 'plumbing'   and name = 'Leak detection';
update shared_assemblies set category = 'shower'            where trade = 'plumbing'   and name = 'Replace shower head';
