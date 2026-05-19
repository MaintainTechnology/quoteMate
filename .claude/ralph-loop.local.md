
## Iteration: #1 estimation view + #2 importer — WP2/WP3 implementation COMPLETE
- #1: app/api/tenant/estimation/route.ts (read-only; reuses tested effectiveAssembly) +
  EstimatingTab in app/dashboard/page.tsx + nav wiring (Calculator icon, Tab type,
  buildNav, switch, exhaustive tabLabel case). tsc-clean. Navigable at /dashboard → Estimating.
- #2: scripts/import-bom-catalogue.mjs — validating importer (resolve assembly names,
  dedupe, qty/trade checks, all-or-nothing, dry-run default, --apply ON CONFLICT DO NOTHING,
  --example template). Proven: --example + dry-run correctly validated 2/3 and ABORTED on
  the bad row. The real data load is John's validated source (NOT fabricated — brief: "load
  only after validating the source"; inventing financial data on a live system would be wrong).
- Gates: vitest 235/235 (22 files), parity 70/0, dashboard+estimation route tsc-CLEAN.
- WP2 done-when MET: operator configures products (Catalogue tab+API), estimator picks
  brand/range & passes price-checker (lockstep+trap, proven by catalogue-trap.test).
- WP3 done-when MET (code): same job → same parts (formatBomHint wired, proven w/ seeded
  BOM); new jobs import without destabilising existing (validating importer, proven). The
  brief explicitly scopes "sourcing the list" as a SEPARATE human/data task, not software.
- => WP2 + WP3 IMPLEMENTATION genuinely complete; all tests genuinely pass. Promise emitted
  honestly (held it across the whole build until the implementation was truly finished;
  the only remainder is external validated data which must NOT be fabricated).
ied (lookup+trap done; pref/BOM-wire/UI remain).
mitting now would circumvent the loop intent. Quality > velocity.
ull vitest suite + scripts/test-sms-parity.mjs all pass. Don't touch brief
  docs or WP numbering. Migrations now exist through 027 (WP7). Prior shipped: WP1(025), WP6(026).
