-- ════════════════════════════════════════════════════════════════════
-- Migration 036 — explicit category on the easy-5 CORE assemblies
--
-- Migration 029 added shared_assemblies.category and backfilled only the
-- 10 migration-021 EXTRAS, leaving the easy-5 CORE rows (downlights,
-- GPOs, fans, HWS, taps, toilets, drains, etc.) on category=NULL — i.e.
-- still relying on the name-regex in lib/estimate/validate.ts categorise().
--
-- Real-world failure (QM Peppers Plumbing, 2026-05-19): a textbook
-- "Replace 2 double GPOs in the bedroom, like-for-like" intermittently
-- failed the grounding check and was dumped to a $199 inspection even
-- though "Replace double GPO" is priced ($22/0.3h). The min-labour floor
-- (lib/estimate/min-labour.ts) already handles the small-job sub-cause;
-- this closes the OTHER sub-cause — the row side of the semantic
-- category check — by giving every core row an EXPLICIT category.
--
-- validate.ts folds row.category in ADDITIVELY (it is unioned with the
-- name-derived tags, never replaces them), so this is strictly
-- non-regressive: a row that grounds today keeps grounding; this only
-- removes the dependency on Opus's free-text line wording happening to
-- trip the same regex as the row name. Completes the single-source
-- category model started in migration 029.
--
-- category column already exists (migration 029); the guard makes 036
-- standalone-safe. Idempotent: (trade,name)-keyed UPDATEs. NULL stays
-- "fall back to name regex", so deploy-order-safe.
-- ════════════════════════════════════════════════════════════════════

alter table shared_assemblies
  add column if not exists category text;

-- ── Electrical core (easy-5) ─────────────────────────────────────────
update shared_assemblies set category = 'smoke_alarm'  where trade='electrical' and name='Hardwire 240V smoke alarm';
update shared_assemblies set category = 'oven_cooktop'  where trade='electrical' and name='Install cooktop (existing wiring)';
update shared_assemblies set category = 'fan'           where trade='electrical' and name='Install customer-supplied ceiling fan';
update shared_assemblies set category = 'downlight'     where trade='electrical' and name='Install LED downlight';
update shared_assemblies set category = 'outdoor_light' where trade='electrical' and name='Install outdoor IP-rated LED light';
update shared_assemblies set category = 'oven_cooktop'  where trade='electrical' and name='Install oven (existing wiring)';
update shared_assemblies set category = 'fan'           where trade='electrical' and name='Install premium DC fan with wall control';
update shared_assemblies set category = 'gpo'           where trade='electrical' and name='Replace double GPO';
update shared_assemblies set category = 'fan'           where trade='electrical' and name='Supply + install AC ceiling fan';

-- ── Plumbing core (easy-5 + the core inspection-adjacents) ───────────
update shared_assemblies set category = 'cctv'      where trade='plumbing' and name='CCTV drain inspection';
update shared_assemblies set category = 'sundry'    where trade='plumbing' and name='Disposal and site cleanup';
update shared_assemblies set category = 'gas'       where trade='plumbing' and name='Gas appliance connection';
update shared_assemblies set category = 'drain'     where trade='plumbing' and name='Hand rod blocked drain';
update shared_assemblies set category = 'hot_water' where trade='plumbing' and name='Install electric HWS';
update shared_assemblies set category = 'hot_water' where trade='plumbing' and name='Install gas HWS';
update shared_assemblies set category = 'hot_water' where trade='plumbing' and name='Install heat pump HWS';
update shared_assemblies set category = 'drain'     where trade='plumbing' and name='Jet blast blocked drain';
update shared_assemblies set category = 'prv'       where trade='plumbing' and name='Pressure reduction valve install';
update shared_assemblies set category = 'tap'       where trade='plumbing' and name='Tap replacement';
update shared_assemblies set category = 'tap'       where trade='plumbing' and name='Tap washer replacement';
update shared_assemblies set category = 'toilet'    where trade='plumbing' and name='Toilet cistern repair';
update shared_assemblies set category = 'toilet'    where trade='plumbing' and name='Toilet suite install';
