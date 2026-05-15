-- ════════════════════════════════════════════════════════════════════
-- Migration 021 — services catalogue extras
--
-- Background: the Services tab on the tradie dashboard sources its
-- list from `shared_assemblies` scoped to the tenant's trade(s). Pre-
-- 021 each trade only carried the "easy 5" auto-quote wedge plus a
-- handful of inspection-route adjacents (CCTV, gas connection, PRV).
-- Real electricians and plumbers handle a wider range of jobs:
--   • Electricians: aircon power-points, EV chargers, hardwired ovens,
--     exhaust fans, LED strip, security cameras, etc.
--   • Plumbers: rainwater tanks, dishwasher installs, garbage disposals,
--     external taps, leak detection, etc.
-- The dashboard now lets a tradie claim "yes I do air conditioning"
-- without QuoteMate having to ship new auto-quote prompts for every
-- service. Unticked extras stay invisible; ticked extras tell the
-- tenant's customers (via the inspection-route messaging) that the
-- tradie handles that work, but the AI still only AUTO-quotes the
-- existing easy-5 per trade (see docs/strategy.md v5).
--
-- Why a `default_enabled` column rather than just inserting rows?
-- The existing 13 assemblies are CORE — every electrician does
-- downlights, every plumber does blocked drains. They default to ON
-- so a newly-onboarded tradie sees their wedge enabled out-of-box.
-- The extras are OPT-IN — only some electricians install aircon,
-- only some plumbers do leak detection. Defaulting them to OFF means
-- the dashboard prompt ("Tick the work your AI can auto-quote") is
-- honest: the tradie actively claims each extra.
--
-- Existing tenants (Pilot Sparky, Pilot Plumber, any pre-021 sign-ups)
-- have ALL their offering rows for the original 13 still flagged as
-- enabled=true. The new extras land with NO offering row at all, so
-- the tenant/me route's catalogue-merge fallback (now reading
-- shared_assemblies.default_enabled instead of a hardcoded true)
-- shows them as OFF. The tradie ticks what they do.
--
-- Idempotent: `if not exists` for the column and `where not exists`
-- per (trade, name) for the inserts.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. default_enabled column ─────────────────────────────────────
-- TRUE = catalogue row is enabled-by-default when a new tenant
-- activates or when no offering row exists for an existing tenant.
-- FALSE = opt-in. Tradie must tick the row before it shows as enabled.
alter table shared_assemblies
  add column if not exists default_enabled boolean not null default true;

-- ── 2. Electrical extras (default_enabled = false) ────────────────
-- All pricing is wholesale ex-GST sundries/equipment portion only.
-- Products (aircon unit, EV charger, camera, etc.) live in
-- shared_materials when/if Opus needs to price them, but most of
-- these are inspection-route services in v1 so the AI doesn't auto-
-- quote them anyway — the rates here are for tradies who configure
-- their pricing book and want a reasonable starting point.
insert into shared_assemblies (
  trade, name, description, default_unit,
  default_unit_price_ex_gst, default_labour_hours,
  default_exclusions, default_enabled
)
select * from (values
  ('electrical', 'Install aircon power point',         'Dedicated 15A or 20A power point + circuit for split-system head unit', 'each',  80.00, 2.00, 'Excludes refrigerant work, mounting brackets, and core drilling beyond standard 65mm',          false),
  ('electrical', 'Install EV charger',                 'Single-phase 7kW home charger install on dedicated circuit',             'each', 120.00, 3.00, 'Excludes switchboard upgrades, load-balancing, and supply of the charger unit itself',         false),
  ('electrical', 'Hardwire oven',                      'Disconnect and reconnect customer-supplied oven on existing circuit',    'each',  35.00, 1.00, 'Excludes new circuit; customer-supplied oven warranty not covered by tradie',                  false),
  ('electrical', 'Hardwire induction cooktop',         'Connect customer-supplied induction cooktop to existing circuit',        'each',  40.00, 1.50, 'Excludes benchtop cutout, new circuit, and customer-supplied unit warranty',                   false),
  ('electrical', 'Install bathroom exhaust fan',       'Mount and wire ceiling-mounted exhaust fan on existing lighting circuit','each',  30.00, 1.50, 'Excludes ducting beyond 3m and roof penetrations',                                             false),
  ('electrical', 'Install outdoor IP-rated GPO',       'Weatherproof IP56 GPO on existing nearby circuit',                       'each',  35.00, 1.00, 'Excludes new circuit and underground conduit runs',                                            false),
  ('electrical', 'Install LED strip lighting',         'Mount aluminium channel, run strip, terminate at driver',                'metre', 15.00, 0.50, 'Excludes driver replacement and recessed channel routing in plasterboard',                    false),
  ('electrical', 'Install wired doorbell or intercom', 'Mount and wire customer-supplied unit; bell push at front door',         'each',  40.00, 1.50, 'Excludes external wiring runs beyond 5m and supply of the unit',                              false),
  ('electrical', 'Install security camera (single)',   'Mount one IP camera and run cable to existing NVR or PoE point',         'each',  50.00, 1.50, 'Excludes pole/roof mounting reinforcement and NVR or storage hardware',                       false),
  ('electrical', 'Install motion sensor flood light',  'Mount and wire eave-mounted 240V LED flood with PIR sensor',             'each',  35.00, 1.00, 'Excludes new circuit and eave reinforcement if mounting surface is insufficient',             false)
) as v(trade, name, description, default_unit, default_unit_price_ex_gst, default_labour_hours, default_exclusions, default_enabled)
where not exists (
  select 1 from shared_assemblies sa
   where sa.name = v.name and sa.trade = v.trade
);

-- ── 3. Plumbing extras (default_enabled = false) ──────────────────
insert into shared_assemblies (
  trade, name, description, default_unit,
  default_unit_price_ex_gst, default_labour_hours,
  default_exclusions, default_enabled
)
select * from (values
  ('plumbing', 'Install rainwater tank',           'Connect above-ground tank on prepared pad to downpipe and overflow',     'each', 80.00, 3.00, 'Excludes tank supply, base preparation, and connection to mains plumbing',                false),
  ('plumbing', 'Install dishwasher',               'Connect cold water supply and drain to customer-supplied dishwasher',    'each', 30.00, 1.00, 'Excludes benchtop cutout and customer-supplied unit warranty',                           false),
  ('plumbing', 'Install washing machine taps',     'Replace or install hot + cold isolating taps with hose connections',     'each', 25.00, 1.00, 'Excludes wall repair behind taps and replacement of WM supply hoses',                    false),
  ('plumbing', 'Install garbage disposal',         'Mount under-sink waste disposal unit and connect to drain',              'each', 30.00, 1.00, 'Excludes electrical work and sink modifications',                                        false),
  ('plumbing', 'Install whole-house water filter', 'Cut into mains, install bypass, mount filter housing',                   'each', 80.00, 2.00, 'Excludes filter cartridge replacement schedule; cartridges quoted separately',           false),
  ('plumbing', 'Install external garden tap',      'Cut in and install new outdoor tap with vacuum-breaker',                 'each', 30.00, 1.00, 'Excludes wall penetrations through brick or rendered surfaces',                          false),
  ('plumbing', 'Replace shower head',              'Remove and replace shower head on existing arm',                         'each', 15.00, 0.50, 'Excludes shower mixer replacement if leaking',                                           false),
  ('plumbing', 'Replace toilet seat',              'Remove old seat and fit customer-supplied or supplied new seat',         'each', 10.00, 0.50, 'Excludes seat-fixing thread repair if damaged or stripped',                              false),
  ('plumbing', 'Stormwater drain unblock',         'Jet blast or rod stormwater line to clear leaves, silt, or roots',       'each', 80.00, 1.50, 'Excludes excavation if blockage is below ground or pipe is collapsed',                   false),
  ('plumbing', 'Leak detection',                   'Acoustic listening and pressure test to locate hidden leak',             'each', 60.00, 1.50, 'Excludes repair — repair quoted separately once leak is located',                        false)
) as v(trade, name, description, default_unit, default_unit_price_ex_gst, default_labour_hours, default_exclusions, default_enabled)
where not exists (
  select 1 from shared_assemblies sa
   where sa.name = v.name and sa.trade = v.trade
);
