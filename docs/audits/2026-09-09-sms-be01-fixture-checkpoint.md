# BE01 offline fixture compatibility checkpoint

The 93 + 2 results below are preserved historical checkpoints. The final [five-group CI](2026-09-09-sms-standalone-ci-evidence.md) now passes 121/121, including both refreshed configurations. For that run, the shared fixture now applies actual migrations 215 and 217, and all affected named source inventories include them. Its settlement lookup and RPC execute real local SQL; baseline payment types and defaults match SQL 02, 160 and 194. Scoped lint, independent source review and the final integrated execution pass.

The later immutable-PDF repair also requires a content-hash storage key. The owner fixture now saves its unchanged $550/$880 PDF byte strings as `quotes/<quote-id>/<SHA-256-of-bytes>.pdf`, with the existing actual signature. The renderer remains forbidden, and held/stale/released/exact-byte assertions are unchanged. This is a fixture update for the strengthened cache contract, not evidence that PDF rendering has run. The pre-update test is archived under `immutable-pdf-fixture-refresh/`; the updated test SHA-256 is `7a43f095f0f2df4658c4157804f2328bfb8f2b1c180722061903d7b13e635f94`. Root independent review and scoped lint pass.

**93 owner tests and two created-tool cases pass** in separate serial runs. Both shared offline-runner results report success, exit 0, confirmed child shutdown, empty errors/blocked calls and fresh completed composition reports. All owned processes closed. These are checkpoints before the coordinated recipient/release-schema freeze and final five-group CI; no SMS runtime, pricing policy or migration was changed by this fixture increment.

| Checkpoint | Observed result | Meaning |
| --- | --- | --- |
| `be01-fixture-checkpoint-01/owner` | 69 passed, 24 failed; outer exit 1; created cases not started | Real strict pricing/PDF execution exposed old fixture fields and a full-row adapter response where production projects columns. Failures remain preserved. |
| `be01-fixture-checkpoint-02/owner` | 93 passed; seven base journeys plus four additions; 30 carrier calls | Canonical fixture fields and a valid projected PDF cache preserve held denial, released bytes, origin isolation and immutable-plan checks. |
| `be01-fixture-checkpoint-02/created` | One passed, one failed; combined outer exit 1 | Commercial creation/approval reached the actual generic page, which now prints $2,481.95. Its old expectation was rounded $2,482. No runtime price error was established. |
| `be01-created-checkpoint-03/created` | Two passed; five carrier calls; outer exit 0 | Generic exact-cent and rich-document rounded displays are asserted separately, with unchanged real BOM/pricer/saved-row checks. |

The repairs are limited to four test/fixture files. Generic line items now use the real `quantity` and `unit_price_ex_gst` fields with the same values; the separate origin fixture now provides `subtotal_ex_gst: 500` for its saved $550 total. Neither a pricing version nor an inspection flag was invented to bypass review. Commercial creation receives the database's actual baseline `deposit_pct DEFAULT 30` before inserting its quote; no saved price or deposit is patched afterward.

The generic cached-PDF input now uses the actual signature helper, template version and saved quote revision. The local adapter normally returns complete rows; a narrow wrapper models the real PDF context's selected fields, keeping lifecycle fields out of that hash. Its undefined-to-null handling is a minimal fixture-schema accommodation, not a production-column test. The actual strict cache check executes; the renderer remains a recorded, forbidden boundary. Released downloads must still return HTTP 200 and the exact saved fixture bytes. This is not PDF generation, visual rendering, full PostgREST/schema/RLS or deployed-provider proof.

GitNexus reported the new/unindexed fixture consumers UNKNOWN. Direct source confirmed their dedicated test configurations and callers before changes. Root and independent reviewer source checks pass for the canonical fields, signature/projection and database default; all four edited files pass scoped lint, with the final display-only test change linted again.

The evidence root is `C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09`. Prior fixed-path composition reports were copied into each checkpoint's `previous-reports` before regeneration. The owner proof binds 42 named sources; created-tool proof binds 34. Both assert those bytes unchanged during their own runs. This is not a whole-import-closure or latest-release attestation.

`be01-fixture-checkpoint-summary.json` records observed exits, counts and hashes:

| Artifact | SHA-256 |
| --- | --- |
| Historical BE01 owner composition | `383d846fe863668bf80da17c58f99958baf393f32428141a6e954594eca4f696` |
| Owner offline result | `c7f5411fb130ebe97301ddb73b940180ab72960cad013137a328a3a49f00dda7` |
| Owner Vitest result | `537f515549deed5f7a3f178a3e1422fe308f97bf4672cff51a1561e4412f9487` |
| Historical BE01 created-tool composition | `443074ed9e66aeb3fb56e4976380ea48cc2e7025c251282ac168e4e017540cd6` |
| Created-tool offline result | `d61c3e3ce6eb277f08bc07c531c08ed49a1c9359d1032f38e0c86efcb83bb099` |
| Created-tool Vitest result | `7e3da444e91958c0870e7af3b3e41fe1f2b1a15fdccab524a0da781691b01132` |

The complete acceptance scope and fixture limitations remain in the [owner-release evidence](2026-09-09-sms-owner-release-evidence.md) and [created-tool evidence](2026-09-09-sms-created-tool-release-evidence.md). The historical four-group 118-test CI result remains separately archived and is not replaced by these two-group checkpoints.
