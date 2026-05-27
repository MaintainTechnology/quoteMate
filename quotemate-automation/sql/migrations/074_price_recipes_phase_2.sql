-- ════════════════════════════════════════════════════════════════════
-- Migration 074 — Phase 2 of the price-bands recipe framework.
--                  (Numbered 074 because an in-flight 073 covers a
--                  separate workpiece — quotes display_mode override.)
--
-- Background: Phase 1 (lib/estimate/price-bands.ts + tests, 2026-05-27)
-- shipped a pure-module recipe interpreter. This migration lands the
-- DB shape it consumes and seeds the first end-to-end recipe — the
-- "Replace double GPO" assembly — so that GPO installs which previously
-- routed to a $99 inspection (because the customer mentioned "no power
-- within 5 metres" or a 20A appliance) now auto-quote with the right
-- scope.
--
-- Operations:
--   1. Add price_recipe jsonb column to shared_assemblies AND
--      tenant_custom_assemblies (parity — tenants may want to override
--      a shared recipe later). NULL = no recipe; estimator behaviour is
--      unchanged for that row.
--   2. Insert new shared_materials row: "TPS cable 2.5mm² per metre"
--      ($5/m raw). Used by the cable-extension bands on GPO recipes.
--   3. Insert new shared_assemblies rows:
--        • "Install 20A dedicated GPO" ($80 sundries + 2.0hr labour)
--        • "Install 32A three-phase outlet" ($120 sundries + 3.0hr)
--      These are the assembly-swap targets when the customer picks
--      circuit_required = '20A' or 'three-phase' on the recipe.
--   4. Seed price_recipe on "Replace double GPO" with two questions:
--        • distance_to_existing_power (numeric, 4 bands)
--        • circuit_required (select, 3 bands with assembly overrides)
--
-- Idempotent:
--   • ADD COLUMN IF NOT EXISTS for both schema changes.
--   • Material/assembly inserts use ON CONFLICT or WHERE NOT EXISTS so
--     re-running matches zero rows.
--   • The price_recipe update uses jsonb assignment; re-running
--     overwrites with the same canonical value.
--
-- IDs:
--   New rows use predeclared deterministic UUIDs so the price_recipe
--   JSON can reference them as material:<id> / assembly:<id> in the
--   same migration without needing a CTE round-trip:
--     TPS cable 2.5mm²:           7c2a4561-8b9d-4e1c-a3f4-b5d6e7f80250
--     Install 20A dedicated GPO:  5b48eed9-3f37-4d1c-a3e2-d4afae0a5e20
--     Install 32A 3-phase outlet: 5b48eed9-3f37-4d1c-a3e2-d4afae0a5e32
--
-- Apply with:
--   node --env-file=.env.local scripts/run-migration-074.mjs
-- ════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Schema: add price_recipe column ──────────────────────────────
alter table shared_assemblies
  add column if not exists price_recipe jsonb;

alter table tenant_custom_assemblies
  add column if not exists price_recipe jsonb;

comment on column shared_assemblies.price_recipe is
  'Phase 2 (mig 073) — PriceQuestion[] for the recipe engine in '
  'lib/estimate/price-bands.ts. When set, the estimator post-processes '
  'the LLM''s draft for this assembly by feeding the customer''s slot '
  'answers through applyPriceBands(), appending extra labour/material '
  'lines and (optionally) swapping the base assembly. NULL = no recipe; '
  'auto-quote behaves as today. Material prices stored as RAW (tenant '
  'markup applied at runtime).';

comment on column tenant_custom_assemblies.price_recipe is
  'Phase 2 (mig 073) — per-tenant override for the recipe engine, '
  'parallel to shared_assemblies.price_recipe. NULL = inherit the '
  'shared recipe (if any).';

-- ── 2. Seed new material: TPS cable 2.5mm² per metre ───────────────
insert into shared_materials (
  id, trade, name, brand, unit, default_unit_price_ex_gst, category
)
select
  '7c2a4561-8b9d-4e1c-a3f4-b5d6e7f80250'::uuid,
  'electrical',
  'TPS cable 2.5mm² per metre',
  null,
  'lm',
  5.00,
  'sundries'
where not exists (
  select 1 from shared_materials
  where id = '7c2a4561-8b9d-4e1c-a3f4-b5d6e7f80250'::uuid
);

-- ── 3. Seed new assemblies: 20A dedicated GPO + 32A 3-phase outlet ─
insert into shared_assemblies (
  id, trade, name, description, default_unit,
  default_unit_price_ex_gst, default_labour_hours, default_exclusions,
  category
)
select
  '5b48eed9-3f37-4d1c-a3e2-d4afae0a5e20'::uuid,
  'electrical',
  'Install 20A dedicated GPO',
  'Install a new dedicated 20A circuit + GPO from the switchboard. '
  'Includes RCBO, dedicated isolation, and certification. For appliances '
  'requiring more than 10A (large heat pumps, kilns, workshop tools).',
  'each',
  80.00,
  2.00,
  'Excludes switchboard upgrades if no spare way is available, and '
  'underground / through-wall conduit runs beyond standard cavity routes.',
  'gpo'
where not exists (
  select 1 from shared_assemblies
  where id = '5b48eed9-3f37-4d1c-a3e2-d4afae0a5e20'::uuid
);

insert into shared_assemblies (
  id, trade, name, description, default_unit,
  default_unit_price_ex_gst, default_labour_hours, default_exclusions,
  category
)
select
  '5b48eed9-3f37-4d1c-a3e2-d4afae0a5e32'::uuid,
  'electrical',
  'Install 32A three-phase outlet',
  'Install a new 32A three-phase outlet — for EV chargers, three-phase '
  'workshop equipment, or commercial ovens. Includes new circuit, 3φ '
  'RCBO, and certification.',
  'each',
  120.00,
  3.00,
  'Excludes single-phase to three-phase supply upgrade if the property '
  'is single-phase only, and any switchboard rewiring beyond a spare way.',
  'gpo'
where not exists (
  select 1 from shared_assemblies
  where id = '5b48eed9-3f37-4d1c-a3e2-d4afae0a5e32'::uuid
);

-- ── 4. Seed price_recipe on "Replace double GPO" ────────────────────
-- Two questions: distance to existing power (numeric bands), and circuit
-- amperage (select bands with assembly overrides to the new 20A / 3φ rows
-- inserted above).
update shared_assemblies
   set price_recipe = '[
  {
    "id": "distance_to_existing_power",
    "question": "How far is the new GPO from the nearest existing power point? (in metres)",
    "variant": "numeric",
    "default_when_unanswered": 2,
    "bands": [
      {
        "max": 2,
        "label": "near existing power"
      },
      {
        "max": 5,
        "label": "short extension",
        "extra_labour_hr": 0.5
      },
      {
        "max": 10,
        "label": "longer run",
        "extra_labour_hr": 1.0,
        "extra_materials": [
          {
            "description": "TPS cable 2.5mm² × 10m (longer run)",
            "quantity": 10,
            "unit": "lm",
            "unit_price_ex_gst": 5,
            "source": "material:7c2a4561-8b9d-4e1c-a3f4-b5d6e7f80250"
          }
        ]
      },
      {
        "max": null,
        "label": "extended run (up to 20m assumed)",
        "extra_labour_hr": 2.0,
        "extra_materials": [
          {
            "description": "TPS cable 2.5mm² × up to 20m (final length verified onsite)",
            "quantity": 20,
            "unit": "lm",
            "unit_price_ex_gst": 5,
            "source": "material:7c2a4561-8b9d-4e1c-a3f4-b5d6e7f80250"
          }
        ],
        "risk_flag": "Cable run assumed up to 20m. Longer runs adjusted onsite with the tradie."
      }
    ]
  },
  {
    "id": "circuit_required",
    "question": "Standard 10A is fine for most appliances. Do you need a dedicated 20A circuit (large heat pumps, workshop tools), or a 32A three-phase outlet (EV charger, commercial gear)?",
    "variant": "select",
    "default_when_unanswered": "10A",
    "bands": [
      {
        "value": "10A",
        "label": "standard 10A"
      },
      {
        "value": "20A",
        "label": "20A dedicated circuit",
        "use_assembly_id": "5b48eed9-3f37-4d1c-a3e2-d4afae0a5e20",
        "risk_flag": "Dedicated 20A circuit added — switchboard spare way required (verified onsite)."
      },
      {
        "value": "three-phase",
        "label": "32A three-phase outlet",
        "use_assembly_id": "5b48eed9-3f37-4d1c-a3e2-d4afae0a5e32",
        "risk_flag": "32A three-phase outlet — switchboard capacity and supply phase verified onsite."
      }
    ]
  }
]'::jsonb
 where name = 'Replace double GPO'
   and trade = 'electrical';

-- Keep PostgREST's schema cache fresh (matches the house pattern).
notify pgrst, 'reload schema';

commit;
