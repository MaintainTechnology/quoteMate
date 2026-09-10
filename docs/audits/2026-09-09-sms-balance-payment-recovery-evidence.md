# Balance payment operation recovery — local evidence, 9 September 2026

**All 66 balance tests pass on their unchanged current inputs** in full-platform-06: 23 composed SMS recovery cases and 43 existing C09 handler cases. The [joined final-chain evidence](C:/Users/dalig/Downloads/QuoteMate/quoteMate/docs/audits/2026-09-09-sms-final-chain-evidence.md) selects them with nine final-creation/signed-callback cases, for 75 passing assertions and no subset skips. The 66 are a subset of 75, itself part of the full suite; no separate rerun or additional total is implied. The enclosing full06 runner and parent exited **1** after one unrelated browser assertion failed (10,273 passed, 24 skipped). Typecheck passed, the test child closed, and no blocked external calls occurred; full06 did not run a build. Its failed overall result and runner errors remain in the archive.

The current balance composition has 26 named source hashes, actual migration217 in the shared fixture, all 23 scenarios complete and no unexpected I/O. Its fresh report was written at `2026-09-09T10:37:47.172Z` within full06. Its deterministic bytes retain SHA256 `e63947fd000a8cb6cc08cc26ca4dfa5b33f8e476029bd9e9fd784cdb6b8b28eb` because all 26 named inputs are unchanged. The [full-platform-06 subset archive](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full-platform-06) binds that report to the exact passing assertions, in-run write time and matching before/after-test source snapshots. No balance-replay runtime change was made for this refresh. The joined scenarios execute final creation and credit settlement that this original balance fixture still seeds. Full04 and checkpoint06 preserve the earlier passes and original source archives. The [later typecheck07/build08 bridge](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full-platform-06/subsequent-tsc07-build08/verified-bridge.json) verifies unchanged named inputs through the successful separate typecheck and production build; it retains full06's failed overall test result and does not claim a complete suite rerun.

## Earlier checkpoint04 and original repair

The following evidence describes the original repair checkpoint. It passed **66 tests: 23 composed recovery cases and 43 existing C09 route cases**, with no failures or skips. The offline runner exited 0, recorded no blocked calls or errors, and closed its Vitest child. The composition reported `completed: true`, 23 passing results and an empty unexpected-I/O list. Its 25 simulated carrier attempts included accepted, definitely rejected and ambiguous outcomes; they were not live deliveries.

The [composition JSON](2026-09-09-sms-balance-payment-recovery.json) is refreshed by later checks. The original checkpoint's immutable output and all 25 named source files are preserved in `sms-balance-payment-checkpoint-04` under the fleet evidence directory:

`C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09`

| Artifact | SHA-256 |
| --- | --- |
| `checkpoint-04/composition.json` | `827b293306b5c41c97fea965fbaa94b98f8a4dad5c34e8213c1ab0f8006fa2e6` |
| `checkpoint-04/vitest.log` | `41078de7c92ede2d0664925212e594405da070718823dad224f550d1fc3322c4` |
| `checkpoint-04/offline-result.json` | `679eb2a9f54f4bda3fca1c60b83e14e5433c9cba32fa9a91e57a2d51f61e8ea1` |
| Request-final-payment route | `2c8cc8acd4a1b4cc2969341d96ded4f1765e21c87654dd910f41840f9cbae9cd` |
| New composition test | `ff0c56f7796fbeeff1ac62d86b648ad8ed6a0a05855a31b621b571f9e0db5fec` |
| New transport fixture | `cb9889a3bbcb8ce9dddfb12d98f308e99948e4b8a67ec3dbaafd8878f136cb9a` |
| Current release helper | `339c27f0f1052193a3bcfb2bb2aa15ad7ca94f6e9c866b03135397e4ee83ca5a` |
| Actual migration 215 | `43b8d452909c4128f3c45bab270399dca9c839d5d154d81720302cd532c8f2df` |

The table abbreviates the evidence folder as `checkpoint-04`; its exact name is `sms-balance-payment-checkpoint-04`.

Scoped ESLint for the route and two new test/fixture files also exited 0 with no warnings or errors. The exact command, exit and captured empty output are in `lint.log` beside the current test evidence.

## Reproduced problem and bounded repair

Before the repair, an accepted native UUID operation could be read correctly through GET, but replaying POST after the customer's current contact changed returned 409 against the new contact. The existing accepted intent and original recipient still existed. Checkpoint 02 executes this failure: nine cases passed and this tenth case failed. The changed-recipient refusal assertion following that failure was not reached in that run.

The new `retainedBalanceDelivery` path runs after the existing final revision, readiness, owned root/intake/child and money checks, and before fresh contact resolution. It loads the exact tenant/balance/operation key and verifies the saved resource, payload/column agreement, recipient and any attributed conversation. The caller's retained expectation is compared with the saved recipient. A mismatched expectation cannot retarget the operation.

This path only reads. Accepted/delivered operations return 200 with their saved SID and actual `deliveryStatus`; pending, retry, sending, unknown, failed and undelivered operations return 202 with their saved state. It does not prepare a child, re-approve, enqueue or dispatch. The existing worker and owner recovery policy remain responsible for incomplete sends. New operation UUIDs still validate current contact and use the original preparation/release path.

Pre-215 receipts retain their original revision. Reading that receipt does not authorize new approval or a replacement payload. The current atomic 215 function, including `parent_quote_id`, pricing version, report document and report style, is applied for every newly generated test intent.

## Executed assertions

The 23 composed cases execute the actual final-payment POST/GET, owner delivery-retry POST, durable dispatch/recovery and receipt helpers over real SQL 198/199/201/202/205/207/211/212/213/215. They verify:

- A retained native first UUID and its case-folded replay select one accepted intent; omitted legacy identity remains a separate initial namespace. A deliberate second UUID creates one additional intent for the same balance.
- Lost release acknowledgement leaves one pending intent. Replayed POST only returns its state; the actual recovery worker accepts the original payload. Lost accepted-response acknowledgement is recovered without another carrier call.
- An accepted carrier result whose database acknowledgement is missing becomes unknown after lease expiry; automatic recovery and owner retry cannot resend it. A matching receipt repairs exactly one publication.
- A definite provider rejection requires the explicit owner recovery action and produces one accepted transcript after recovery.
- Accepted, pending and unknown operations remain bound to the original recipient after current contact changes or becomes unavailable. A changed expectation is refused. A fresh UUID still checks current contact.
- A mismatched saved quote resource, payload operation key, or conversation recipient is refused without dispatch. A stale expected final revision remains refused.
- Reconstructed pre-215 accepted/pending metadata remains readable without rewriting its old payload or revision. Pending recovery still uses the real worker.

Successful acceptance checks compare exact tenant, destination, sender, owned conversation, outbox ID, provider SID and body against one customer transcript per accepted intent. Root/final rows and balance amount/version identity remain unchanged. Read-only replay checks compare all quotes, outbox rows, transcripts, conversations, RPC count and carrier count before and after.

The unavailable-contact fixture first verifies the real contact resolver returns null: removing only `caller.phone` is insufficient because the original intake-linked conversation remains a valid fallback. It therefore removes that current intake lookup association while preserving the historical delivery conversation's ID, tenant and phone pair. This tests receipt recovery without weakening contact precedence.

## Command and scope

Run from `quotemate-automation` with a new artifact directory:

```text
node scripts/test-sms-audit-offline.mjs --artifacts=<fresh directory> --maxWorkers=1 --timeoutMs=240000 -- tests/sms-balance-payment-recovery.test.ts app/api/quote/[id]/request-final-payment/route.test.ts
```

This is source-route integration with inert auth, a PostgREST-shaped adapter and simulated carrier boundaries, not compiled-fleet startup, a native device, live Stripe settlement or Twilio delivery. The paid root/final/intake chain is seeded; `issue-final` and payment settlement are not executed. Pre-215 cases reconstruct only historical revision/snapshot metadata on a real generated intent, rather than execute the old application binary. One PGlite connection does not establish production multi-connection race behaviour. Named source hashes are explicit dependencies, not the full transitive import closure.

Exact POST GitNexus impact resolved the route symbol but returned UNKNOWN with no indexed callers; text inspection confirmed the dashboard ChainActions caller and route test callers, with native use documented in the coordination note. No graph absence was treated as proof of no callers. Only the handed-off replay slice and its new tests were edited; existing money/preparation paths, mobile tests and migrations were preserved.

## Historical attempts

- **Checkpoint 01:** ten setup failures before the route scenarios; the fixture used an arbitrary pricing version missing the actual 207 row. The fixture now captures an owned version through the real helper. This was not a route defect.
- **Checkpoint 02:** nine passes and one actual replay failure on the pre-fix route. Composition hash `f0b6f43015098004d9b54a1b21cd069088cdf5b00720acfc30484f7ced7588c0` and log hash `b373de7b5b1cec1830c6535f50620fe5629ba17a685f8734ef2bc7dd725246f0` preserve the reproduction.
- **Checkpoint 03:** 63 passes and one fixture expectation failure: the claimed missing current phone still resolved through the legitimate conversation fallback. All 43 existing C09 cases passed. Exact source and failed outputs are archived; no production change followed this failure.
- **Checkpoint 04:** original 66/66 passing result above. Historical results do not substitute for the current source-bound run.
