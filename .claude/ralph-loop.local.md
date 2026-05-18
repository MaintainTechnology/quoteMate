
## Iteration: WP2/WP3 BACKEND APPLIED + INTEGRATED (engine complete, UI remains)
- Migration 028 APPLIED TO PROD (user-authorised): tenant_material_catalogue,
  shared_assembly_bom, tenant_assembly_overrides — 3 tables live.
- WP2 lockstep now FUNCTIONAL against live tables (lookupMaterial unions tenant
  catalogue; run.ts loadCandidatePrices trap-fix grounds those prices).
- WP2 brand+range->tier hint: catalogue.ts formatCatalogueHint + run.ts buildCatalogueHint
  wired into userPrompt (soft, additive, null when no catalogue).
- WP3 structured-BOM hint: catalogue.ts formatBomHint + run.ts buildBomHint wired in
  (soft, additive, null when shared_assembly_bom unseeded).
- Tests: +5 catalogue-hints; FULL vitest 182/182, parity 70/0. Zero regression.
- Engine is end-to-end: lookup -> ground -> brand/range+BOM hinted.
- GENUINELY REMAINING (honest, NOT done; do NOT emit promise):
  A) Dashboard UI in app/dashboard/page.tsx (4,242 lines) + app/api/tenant/services:
     full catalogue list, per-row on/off toggle, add/edit, per-service estimation-
     process visibility (global vs local). Operator self-service surface — its own
     focused iteration; rushing a 4.2k-line UI on a live product = the mess WP2 warns of.
  B) WP3 BOM DATA seeding (data task per brief: validate source first). buildBomQuoteLines
     (deterministic generator) built+tested, available for a later controlled switch.
- Promise NOT emitted: backend applied/integrated/green, but operator UI + BOM data
  are real WP2/WP3 gaps. tests-green != feature-complete; emitting = circumventing intent.
3 not fully applied (lookup+trap done; pref/BOM-wire/UI remain).
mitting now would circumvent the loop intent. Quality > velocity.
ull vitest suite + scripts/test-sms-parity.mjs all pass. Don't touch brief
  docs or WP numbering. Migrations now exist through 027 (WP7). Prior shipped: WP1(025), WP6(026).
