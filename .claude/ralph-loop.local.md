---
active: true
iteration: 1
session_id: ef0b4c81-2c96-40f0-bb63-68cd7bce4d89
max_iterations: 0
completion_promise: "All"
started_at: "2026-05-21T06:37:10Z"
---

Build the admin bulk service and catalogue loader per the spec at quotemate-automation/docs/admin-bulk-loader-spec.md. Start with Phase 0 the foundation schema plus the prompt-router refactor, then Phase 1, following every spec safety rule. DB migrations are numbered SQL files plus runner scripts, applied to prod one at a time with human approval. Keep the vitest suite, the catalogue-trap tests and tsc green at every step. tests pass
