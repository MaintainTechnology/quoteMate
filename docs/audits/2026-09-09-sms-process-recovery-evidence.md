# SMS compiled process recovery acceptance

Status: **45 historical cases carry forward by verified final artifact equivalence; they were not rerun.** The [final equivalence receipt](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/primitive-equivalence-review-01/final-equivalence.json), SHA256 `3b5194f565efff1ce233df30fa7dc7a82b95b22bf9ccabe2996139f5cec7448f`, binds the completed 8 September result to new readiness `f95126d0af7467d03dbc9fae433f7bf81ab6b2c31f89a601567a0c3dfde1da0c`. All 25 local compiled dependency files, both harnesses, migrations 198/199, six dependency locks and Node version match. The three direct libraries also import `public-origin` and `twilio`; all five files per trade are included. The exact five old manifests/attestations and new build attestations agree on these executed bytes. This is locked-dependency equivalence, not an archived full installed-package inventory. Old execution timestamps and hashes remain unchanged.

The changed roofing inbound handler is outside this primitive fixture's executed code. The actual 55 route scenarios must run again, and parity 2 will run fresh because its complete historical source/configuration inventory is not proven. These tests do not certify deployed behaviour.

## Test plan and acceptance conditions

Run each candidate's compiled `durable-work.js`, `durable-outbox.js`, and `delivery-context.js` unchanged in child Node processes. Keep the database and fake carrier ledger in a separate parent process. Load the actual migrations 198 and 199 into parent-owned PGlite and expose a loopback HTTP adapter. Block child fetch requests outside that adapter and provide no live credentials.

Acceptance requires all of the following:

1. Persist a receipt, intake, quote, or outbox intent, then terminate the exact spawned worker PID with `SIGKILL`. Restart a fresh worker against the same parent database.
2. Kill a sender after the fake carrier records acceptance, before the worker stores its result. Recovery must retain `unknown` status and attention rather than automatically sending again.
3. Keep one initial intake, one initial quote with the same fixture price, one initial outbox intent, and one carrier attempt. Persisted model checkpoints must prevent repeated fixture model calls.
4. Claim a successor after local lease expiry. The expired owner's quote mutation and completion must fail while the successor retains ownership.
5. Enqueue eight duplicate correction receipts, eight duplicate price-question receipts, and eight duplicate resend receipts. Each group must resolve to one work identity, and each intended reply must appear once.
6. Repeat the burst while the predecessor is paused before history loading, after the saved history checkpoint, during draft persistence, and inside a deferred callback immediately before completion. A competing compiled worker must claim no same-serial follower. All three followers must remain pending until the predecessor resumes, then run once in order.

## Preserved 8 September completed matrix

| Candidate | Process-kill boundaries | Paused burst timings | Result |
|---|---:|---:|---|
| Electrical | 5 | 4 | PASS |
| Plumbing | 5 | 4 | PASS |
| Roofing | 5 | 4 | PASS |
| Painting | 5 | 4 | PASS |
| Solar | 5 | 4 | PASS |

The five kill boundaries are receipt persistence, intake insertion before its checkpoint, quote insertion before its checkpoint, outbox creation before transport, and fake-carrier acceptance before result persistence. This produced **25 actual killed-worker recoveries and 20 live paused burst checks**. An additional duplicate burst ran after each kill/recovery scenario. Across the 45 scenarios, **1,080 duplicate follow-up submissions resolved into 135 intended follow-up jobs and outbox intents**. Each paused burst tested correction, price-question and resend inputs while the predecessor was still running; a competing worker claimed none until that predecessor resumed.

The database remained in the parent process through every child termination. The harness captures killed PIDs, ownership rejection results, saved checkpoints, job attempts, FIFO order, and SHA-256 hashes of the compiled libraries in [the machine-readable results](2026-09-09-sms-process-recovery-results.json). All initial quotes remained `awaiting_tradie_approval`; the harness sends only a fixture review-status message for that draft. The resend fixture uses a separate fixed message and does not implement approval or quote-link selection.

The scripts also passed ESLint and Node syntax checks. No production files, remote database rows, carrier messages, or deployed services were changed by this harness.

The final JSON was generated at `2026-09-08T21:29:35.892Z`. Its `completed: true` and `runnerExitCode: 0` reflect the complete final execution. The run uses the same frozen readiness as the final parity and actual-route checks: SHA-256 `3f70e3787b5834845294b9153988139d73f86c869f2982a669623cb3208f8303`, created at `2026-09-08T21:24:12.0345853Z`.

The runner hashes each of the three executed primitive libraries before and after its candidate's scenarios. A post-run check matched all 15 recorded primitive hashes to the five candidates' build attestations and verified their source/manifest/attestation identities against frozen readiness. Those identities and the harness/migration hashes at verification are in the result JSON. This primitive runner does not claim to attest the whole `dist` inventory; the separate actual-route journey and parity harnesses perform that broader inventory check.

The final command output is `fleet-candidate-02/final-validation-2026-09-09/process-recovery-final.log`; final lint exit 0 is recorded in `process-parity-final-lint.log`. The earlier 40-case artifact is retained as `process-recovery-before-final.json` in that directory and is superseded by this final result.

## Reproduction

From `quotemate-automation/`:

```powershell
node scripts/test-sms-process-recovery.mjs 'C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02' '../docs/audits/2026-09-09-sms-process-recovery-results.json'
pnpm exec eslint scripts/test-sms-process-recovery.mjs scripts/sms-process-worker.cjs
```

The fleet path must contain all five completed candidate builds. An optional final argument selects one trade. The parent uses an automatically assigned loopback port and kills only child handles it created. Lease deadlines are advanced with local SQL; the test does not wait for or modify production lease durations.

Implementation: [parent harness](../../quotemate-automation/scripts/test-sms-process-recovery.mjs), [child fixture runner](../../quotemate-automation/scripts/sms-process-worker.cjs).

## Evidence limits and remaining acceptance

- The compiled durability libraries and migration functions are real. Inbound, intake, and estimate business handlers are explicit fixtures. Existing actual-route regression tests separately cover the conversation-projection repair, inbound classification replay, and empty-intake outbox failure; this harness does not replace complete compiled handler journeys.
- PGlite runs in the surviving parent's memory and serializes SQL requests. This proves recovery from worker-process loss, not parent/database-host loss, storage durability, or production multi-connection Postgres contention.
- Paused draft followers deliberately use the draft job's `serial_key` to exercise the compiled queue guarantee. This does not prove that production inbound/intake/estimate handlers assign the intended serial keys across every customer interaction.
- Fixture corrections, price questions and resend requests prove receipt, scheduling, and delivery-intent counts. Real correction pricing, approved-link selection, trade-specific measurement, model quality, and customer wording need their own handler and controlled journey evidence.
- Fake-carrier acceptance records an attempted delivery boundary; it is not evidence of Twilio acceptance or delivery to a handset. `unknown` deliberately remains unresolved until callback or reconciliation evidence exists.

## Build/review iterations

1. Added the child-process/parent-database harness and five kill boundaries. The first execution exposed JSON scalar serialization in the test HTTP adapter; correcting JSON RPC parameter encoding produced a clean electrical matrix.
2. Added exact draft/intent/checkpoint assertions and duplicate follow-ups. The first all-fleet attempt passed electrical, plumbing, and roofing before encountering a painting build still being refreshed; no worker assertion failed.
3. Independent review confirmed that the process kills and assertions were real, and identified the post-completion-only burst timing limit. Added before-history, during-draft, and pre-unlock pauses plus a competing worker. Electrical passed all eight scenarios, followed by the complete 25-kill/15-pause matrix across all five candidates.
4. The outbox database-timeout fix and subsequent specialist/readiness corrections changed the compiled fleet. Earlier passing runs were retained as intermediate evidence until all six refreshed candidates were ready.
5. A direct comparison with F04's acceptance text identified the missing after-history timing and price-question input. Added a persisted fixture history read, its after-history pause, and the third durable input with eight duplicate deliveries. Independent source review passed the expanded design.
6. After the refreshed five actual-route journeys released the PGlite execution slot, the full 25-kill/20-pause matrix passed unchanged. Final scoped lint, syntax checks and the attested-primitive/readiness identity check also passed.
