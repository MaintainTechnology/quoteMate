
## Iteration: WP2 LOCKSTEP wired (money path) — safe, additive, proven
- tools.ts: makeLookupMaterial(tenantId) unions active tenant_material_catalogue ahead of
  shared (mirrors makeLookupAssembly); makeTools() uses it; static export = makeLookupMaterial(null).
- run.ts loadCandidatePrices: tenantCataloguePromise + catalogueCandidateRows() merged into
  material candidates BEFORE buildCandidatePrices (THE TRAP, same change as the lookup).
- run.ts: import { catalogueCandidateRows } from './catalogue'.
- New catalogue-trap.test.ts (3): proves branded tenant line GROUNDS with feed, DUMPS without
  it (trap real+closed), customer-supply variant grounds. Full vitest 177/177, parity 70/0.
- Safe: absent table (prod pre-028) → supabase {data:null} (no throw) → [] → identical to
  pre-WP2; no pricing-math/Stripe change; existing quotes unaffected.
- init.sql NOT updated: 022/023 tenant tables aren't in init.sql either — matched that
  established precedent rather than introduce partial-representativeness drift.
- STILL TODO (next iterations, additive, gates-green, NO prod apply, NO promise yet):
  1) run.ts buildPreferencesBlock — surface tenant catalogue brand+range->tier hint.
  2) WP3: wire buildBomQuoteLines + shared_assembly_bom into the estimate path
     (deterministic lines instead of model free-decide).
  3) Dashboard: full service catalog list + per-service on/off toggle +
     per-service estimation-process visibility (global vs local).
  4) Human-gated: apply migration 028 (scripts/run-migration-028.mjs --apply).
- NOT emitting promise: WP2/WP3 not fully applied (lookup+trap done; pref/BOM-wire/UI remain).
mitting now would circumvent the loop intent. Quality > velocity.
ull vitest suite + scripts/test-sms-parity.mjs all pass. Don't touch brief
  docs or WP numbering. Migrations now exist through 027 (WP7). Prior shipped: WP1(025), WP6(026).
