# Specialist PDF object preservation

**Local repair verified:** all **115/115** focused PDF cases pass, including the **36** new specialist cases. Scoped lint exits **0**. Independent source review passes; production delivery and renderer validation remain outside this bounded result.

The roofing, solar and residential painting PDF generators reused a deterministic storage key with `upsert: true`. Invalidating `pdf_path` after a profile change, or explicitly requesting regeneration, could replace the bytes at a path already retained by a delivery. The local baseline reproduces that replacement in all three generators.

The bounded repair gives new specialist PDFs a SHA-256 filename beneath the existing trade, customer token, template/content revision and website-origin prefix. Uploads never overwrite an existing object. An upload error is recoverable only when a download confirms the exact intended bytes. Existing mutable paths refresh once without deleting or rewriting the old object; current immutable paths retain the existing cache behavior.

The generic quote PDF wrapper delegates to the same private uploader. Its `quotes/<id>/<sha256>.pdf` format, byte verification, error message, pricing signature and reviewed-release checks are preserved. Arbitrary asset uploads and all pricing, rendering, selection, public URL and cache-update APIs remain unchanged.

## Build/review evidence

| Check | Result |
|---|---|
| Original implementation, 36 specialist cases | **9 passed; 27 failed.** Parent/child exit 1, child termination confirmed, no skipped cases or blocked network calls. |
| Independent test and exact runtime-delta source review | **PASS**, including returned-path consumers and cache-prefix controls. |
| Repaired implementation and existing PDF regressions | **115/115 PASS**: specialist 36, generic pricing authority 38, reviewed-release binding 20, public origin 21. Parent/child exit 0, child termination confirmed, no failures, skips, blocked calls or runner errors. |
| Scoped lint | **PASS**, exit 0 with an empty log for the three edited code/test files. |

Final test execution: `2026-09-09T06:51:46.093Z`–`2026-09-09T06:52:13.812Z`. Lint finished at `2026-09-09T06:53:59.4862509Z`. No runtime or test edits followed these checks.

Baseline execution: `2026-09-09T06:40:14.849Z`–`2026-09-09T06:40:25.859Z`. The original source SHA-256 is `6a35e832508d043f09cc2730147df35805907467a20add3acd72b32b1e7b8e79`. The three profile-invalidation failures compare the old storage object's actual retained bytes after a new render; they are direct overwrite reproductions. The other failures cover explicit regeneration, duplicate/lost-acknowledgement readback, refused-readback behavior and current-revision mutable cache migration. The nine passing controls reject a hash-shaped cache under the wrong customer token, revision or website identity.

The original refusal paths already preserved their cache on a failed upload; the corresponding baseline assertions additionally fail because those paths never attempted the exact-byte readback now required. Those failures do not establish that the original code changed the cache after a refused upload.

Artifacts are under `C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/`:

- `specialized-pdf-immutability-baseline-01/`: full offline runner result, Vitest JSON, log and network-attempt log.
- `specialized-pdf-immutability-final-01/`: passing runner result, Vitest JSON/log, empty network log, scoped lint result/log and `source-inventory.json`.
- `specialized-pdf-immutability-inputs-01/before/` and `after/`: original and final runtime plus the exact four test source files. All five final source copies were checked against the current files; generic pricing/release test hashes are unchanged. These are bounded source snapshots, not the complete import closure.
- `specialized-pdf-immutability-independent-review.json`: independent PASS confirming all five source snapshots, six evidence hashes, exact assertion totals, confirmed child exit and lint result; SHA-256 `83dd76491539a490620578e2ef974cf4d73f11000a20c735ec20182b7fe40691`.

| Final input/evidence | SHA-256 |
|---|---|
| `lib/quote/pdf.ts` | `fa77170fefbf2d9353bcad2d5590da155ac9a9dc676b4d68ce1a85a02690cf8d` |
| `lib/quote/pdf-specialized-immutability.test.ts` | `7b902cb481768e1bf52a96e68351ec8782618a19ee7c57f5810a646a3836c9dd` |
| `lib/quote/pdf-public-origin.test.ts` | `ef92d6f0ec81e71d348eb10cfd8ff741a99076f4184291d40988e88047b304b1` |
| Final `offline-result.json` | `4fdbf87f5d2e7a0b12ec435e7af687a2f309b8f38c7c62325ba7a90d99f99f19` |
| Final `vitest-results.json` | `0446e30a0b3f85b793cfcafa3443c136653d50e661107d83ac192025d8419a91` |

The final command was run from `quotemate-automation/`, with the full fresh artifact directory above supplied to `--artifacts`:

```text
node scripts/test-sms-audit-offline.mjs --artifacts=<specialized-pdf-immutability-final-01> --maxWorkers=1 -- lib/quote/pdf-specialized-immutability.test.ts lib/quote/pdf-public-origin.test.ts lib/quote/pdf-pricing-authority.test.ts lib/quote/pdf-release-binding.test.ts
node node_modules/eslint/bin/eslint.js lib/quote/pdf.ts lib/quote/pdf-specialized-immutability.test.ts lib/quote/pdf-public-origin.test.ts
```

## Regression scope

Each specialist runs twelve cases through its actual exported `ensure` function:

- Profile cache invalidation renders new branding, preserves earlier object bytes and stored financial inputs, and reuses the new cache on the next call.
- Explicit regeneration produces a new immutable object when its bytes change.
- Concurrent identical renders reuse one object only after exact byte readback.
- A lost upload acknowledgement is accepted only after exact byte readback.
- Different bytes, a missing object, a read error and a thrown read failure retain the earlier cache and object.
- A mutable cache at the current revision is refreshed once without changing the earlier object.
- Valid SHA-256 paths under another token, revision or origin cause a fresh render and preserve the earlier object.

The existing public-origin cases additionally retain canonical URLs, template/enrichment markers, one-time cache migration, website changes and stored prices. Existing generic pricing-authority and reviewed-release PDF cases are included in the final focused command.

## Impact and limits

GitNexus returned `UNKNOWN` for all three specialist entry points and the recently added generic immutable wrapper. Source inspection resolves their actual callers: customer PDF downloads, roofing SMS/layout regeneration, solar release/estimate flows, painting MMS resolution and file-store ingestion. The stale graph marked the old mutable helper `LOW`; current source confirms its only callers are the three specialist generators. No empty graph result was treated as proof that the functions were unused.

The new tests substitute database transport, report HTML, branding, imagery and Gotenberg with local deterministic fixtures. Their storage model implements actual `upsert` conflict behavior and retains exact byte buffers. Profile invalidation is represented by clearing the real function's input cache column; the account-update route is not executed here. These tests establish object preservation at the PDF boundary, not production Supabase policy, actual PDF rendering, customer approval, carrier delivery or concurrent database ordering. No provider request, migration, deployment or price change was performed.
