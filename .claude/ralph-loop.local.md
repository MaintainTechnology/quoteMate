---
active: true
iteration: 1
session_id: 1a51fb51-fddf-4480-880e-5fcd3453b5b2
max_iterations: 0
completion_promise: "All tests pass"
started_at: "2026-05-29T04:33:14Z"
---

Build roofing trade Phase 1 step by step: first the DB migration adding roofing to pricing_book and seeding shared_assemblies, then lib/roofing/measure.ts with a Geoscape adapter behind a provider-agnostic interface, then the Roof dashboard tab and standalone measurement page. Every step ships with vitest tests and clean TypeScript.
