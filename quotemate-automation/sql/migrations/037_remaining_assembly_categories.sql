-- ════════════════════════════════════════════════════════════════════
-- Migration 037 — backfill the LAST 11 NULL-category assemblies
--
-- After 029 (10 extras) + 036 (22 cores), 11 rows were still
-- category=NULL — migration-021 extras whose NAME the regex already
-- categorises (e.g. "Hardwire oven"→oven, "Install aircon power
-- point"→power point), so the 029 audit skipped them. But relying on the
-- name regex is exactly the fragility behind the intermittent "it has a
-- price but still wants a $199 inspection" failures (the row name and
-- Opus's free-text line wording can categorise differently). Making
-- these explicit completes the single-source category model: every
-- shared_assemblies row now carries an explicit category (0 NULL).
--
-- Each value below equals what categorise() already derives from the
-- name, so this is strictly additive / non-regressive (validate.ts
-- unions row.category with the name tags) — it only removes the
-- dependency on the wording matching. Idempotent, deploy-order-safe.
-- ════════════════════════════════════════════════════════════════════

alter table shared_assemblies
  add column if not exists category text;

-- ── Electrical (mig-021 extras) ──────────────────────────────────────
update shared_assemblies set category = 'oven_cooktop' where trade='electrical' and name='Hardwire induction cooktop';
update shared_assemblies set category = 'oven_cooktop' where trade='electrical' and name='Hardwire oven';
update shared_assemblies set category = 'gpo'          where trade='electrical' and name='Install aircon power point';
update shared_assemblies set category = 'fan'          where trade='electrical' and name='Install bathroom exhaust fan';
update shared_assemblies set category = 'ev_charger'   where trade='electrical' and name='Install EV charger';
update shared_assemblies set category = 'gpo'          where trade='electrical' and name='Install outdoor IP-rated GPO';

-- ── Plumbing (mig-021 extras) ────────────────────────────────────────
update shared_assemblies set category = 'tap'    where trade='plumbing' and name='Install external garden tap';
update shared_assemblies set category = 'sundry' where trade='plumbing' and name='Install garbage disposal';
update shared_assemblies set category = 'tap'    where trade='plumbing' and name='Install washing machine taps';
update shared_assemblies set category = 'toilet' where trade='plumbing' and name='Replace toilet seat';
update shared_assemblies set category = 'drain'  where trade='plumbing' and name='Stormwater drain unblock';
