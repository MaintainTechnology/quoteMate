-- Migration 013 — multi-trade expansion: plumbing alongside electrical
--
-- Rationale: see docs/strategy.md v5 (2026-05-11) — Brisbane plumber pilot
-- onboarding. Adds `trade` column to pricing_book (so electrical and
-- plumbing can have separate rates/licences in the same DB) and seeds
-- 12 plumbing assemblies + 13 plumbing materials covering the auto-quote
-- "easy 5" (blocked_drain, hot_water, tap_repair, tap_replace, toilet_repair)
-- plus the inspection-route adjacent services (CCTV, gas connection, PRV).
--
-- Gas leak / burst pipe / bathroom-rough-in / bathroom-fit-off remain
-- inspection-route only — no assembly rows because they cannot be
-- auto-quoted under the strict-grounding rule (rule #10 in
-- lib/estimate/electrical-prompt.ts, mirrored in plumbing-prompt.ts).
--
-- Idempotent — uses `where not exists` guards and `if not exists` so
-- re-running is a no-op.

-- ── 1. pricing_book: add trade column ─────────────────────────────
-- The existing single row (NSW/NECA electrical) becomes the
-- electrical pricing_book; plumbing gets its own row.

alter table pricing_book add column if not exists trade text;
update pricing_book set trade = 'electrical' where trade is null;
alter table pricing_book alter column trade set not null;
alter table pricing_book alter column trade set default 'electrical';
create unique index if not exists pricing_book_trade_unique on pricing_book (trade);

-- ── 1b. intakes: add trade column ─────────────────────────────────
-- The estimator route reads intake.trade to pick the right pricing_book
-- row and prompt. Pre-v5 intake rows back-fill to 'electrical' (the
-- NSW/NECA pilot tenant). New intakes set trade via the intake structurer
-- (lib/intake/structure.ts) which derives it from job_type.

alter table intakes add column if not exists trade text default 'electrical';
update intakes set trade = 'electrical' where trade is null;

-- ── 2. Seed plumbing pricing_book row ─────────────────────────────
-- Brisbane owner-operator plumber, QBCC-licensed.
--   hourly_rate         $120 (mid-AU plumber standard)
--   call_out_minimum    $110 (absorbed into jobs >$800)
--   apprentice_rate     $65
--   default_markup_pct  20% (vs 28% for electrical — plumber JSON spec)
--   risk_buffer_pct     15% (matches electrical default)
--   min_labour_hours    1.5 (no plumber attends for under 1.5hr)

insert into pricing_book (
  trade, hourly_rate, call_out_minimum, apprentice_rate,
  default_markup_pct, risk_buffer_pct, min_labour_hours,
  gst_registered, licence_type, licence_state
)
select 'plumbing', 120, 110, 65, 20, 15, 1.5, true, 'QBCC', 'QLD'
where not exists (select 1 from pricing_book where trade = 'plumbing');

-- ── 3. Seed plumbing assemblies ───────────────────────────────────
-- default_unit_price_ex_gst = the sundries/equipment portion (NOT the
-- product itself — products live in shared_materials and Opus picks
-- the tier-appropriate one via lookup_material).
-- default_labour_hours = typical onsite time; multiplied by
-- pricing_book.hourly_rate at estimation time.

insert into shared_assemblies (
  trade, name, description, default_unit,
  default_unit_price_ex_gst, default_labour_hours, default_exclusions
)
select * from (values
  ('plumbing', 'Hand rod blocked drain',          'Mechanical clearing of a blocked pipe using a drain snake or rod',  'each',  30.00, 1.00, 'Excludes jet blasting and CCTV inspection'),
  ('plumbing', 'Jet blast blocked drain',         'High-pressure water jet for grease, tree roots, or heavy buildup', 'each',  80.00, 1.50, 'Excludes pipe repair if damage found'),
  ('plumbing', 'CCTV drain inspection',           'Camera inspection of drain or sewer line with written report',     'each', 150.00, 1.00, 'Excludes clearing or repair'),
  ('plumbing', 'Install electric HWS',            'Remove existing and install new electric storage hot water unit',  'each',  45.00, 3.00, 'Excludes electrical upgrades and disposal of old unit'),
  ('plumbing', 'Install gas HWS',                 'Remove and install gas storage or continuous-flow hot water unit', 'each',  60.00, 3.50, 'Excludes gas line upgrades if existing supply insufficient'),
  ('plumbing', 'Install heat pump HWS',           'Supply + install heat pump hot water (QLD rebate eligible)',       'each',  80.00, 4.00, 'Electrical upgrades not included; rebate eligibility confirmed onsite'),
  ('plumbing', 'Tap washer replacement',          'Replace worn washer on a dripping tap',                            'each',   8.00, 0.50, 'Excludes tap body replacement if damaged'),
  ('plumbing', 'Tap replacement',                 'Remove existing and install new tap or mixer',                     'each',  25.00, 1.00, 'Customer-supplied tapware: plumber not responsible for product warranty'),
  ('plumbing', 'Toilet suite install',            'Remove existing and install new close-coupled or wall-faced toilet','each',  35.00, 2.00, 'In-wall cistern installs priced separately'),
  ('plumbing', 'Toilet cistern repair',           'Replace fill valve, flush valve, or flapper on running toilet',    'each',  25.00, 0.75, 'Excludes base seal repair if leaking at floor'),
  ('plumbing', 'Gas appliance connection',        'Connect gas cooktop or oven to existing gas supply',               'each',  30.00, 1.50, 'Excludes new gas point or line runs'),
  ('plumbing', 'Pressure reduction valve install','Supply and install PRV to protect fixtures and pipework',          'each',  80.00, 1.50, 'Excludes water-hammer arrestors if also required')
) as v(trade, name, description, default_unit, default_unit_price_ex_gst, default_labour_hours, default_exclusions)
where not exists (
  select 1 from shared_assemblies sa
   where sa.name = v.name and sa.trade = v.trade
);

-- ── 4. Seed plumbing materials ────────────────────────────────────
-- HWS units, tapware tiers, toilet suites, and cistern internals.
-- Opus selects tier-appropriate material via lookup_material at quote time.

insert into shared_materials (
  trade, name, brand, unit, default_unit_price_ex_gst
)
select * from (values
  -- Hot water systems (Good / Better / Best by fuel type)
  ('plumbing', 'Electric HWS 250L basic',                       'Rheem',           'each',  750.00),
  ('plumbing', 'Electric HWS 315L premium',                     'Rheem Stellar',   'each', 1100.00),
  ('plumbing', 'Gas storage HWS 170L',                          'Rheem',           'each',  950.00),
  ('plumbing', 'Gas continuous-flow HWS 26L/min',               'Rinnai Infinity', 'each', 1350.00),
  ('plumbing', 'Heat pump HWS 270L',                            'Reclaim Energy',  'each', 2200.00),
  -- Tapware (Good / Better / Best)
  ('plumbing', 'Standard chrome basin tap',                     'Caroma',          'each',   80.00),
  ('plumbing', 'Kitchen mixer tap',                             'Methven',         'each',  220.00),
  ('plumbing', 'Premium wall-mounted mixer',                    'Phoenix Tapware', 'each',  380.00),
  -- Toilet suites (Good / Better / Best)
  ('plumbing', 'Standard close-coupled toilet suite',           'Caroma',          'each',  350.00),
  ('plumbing', 'Wall-faced toilet suite',                       'Caroma Liano',    'each',  580.00),
  ('plumbing', 'In-wall cistern toilet suite',                  'Caroma Cube',     'each',  850.00),
  -- Repair-only parts
  ('plumbing', 'Cistern internals kit (fill + flush valve)',    'Caroma',          'each',   45.00),
  -- Universal sundries
  ('plumbing', 'Plumbing sundries (fittings, seals, tape)',     null::text,        'each',   35.00)
) as v(trade, name, brand, unit, default_unit_price_ex_gst)
where not exists (
  select 1 from shared_materials sm
   where sm.name = v.name and sm.trade = v.trade
);
