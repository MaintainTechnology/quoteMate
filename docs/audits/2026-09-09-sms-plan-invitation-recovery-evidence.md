# Plan invitation delivery recovery: local F25 evidence

Status: **PASS for four offline invitation cases and the retained plan journey**, refreshed by the exact standalone CI step with observed exit 0. The invitation artifact completed at `2026-09-09T07:32:40.324Z` with four passing results, `completed: true`, empty failure/unexpected arrays, nine fixture-carrier attempts and four accepted messages. The separate upload-to-release case also passed with one model call, two real pricer calls and five accepted fixture messages. No runtime code was changed for this increment.

The earlier03 result remains archived separately, and04 passed this five-case group while six unrelated owner-PDF cache fixtures failed. Checkpoint05 reran all five standalone groups after that test-only repair; it passes121/121 with no declared or whole-app source drift. This plan/invitation test source was unchanged.

The original F25 acceptance concerns losing the upload-link message before the customer can submit a plan. The existing [plan upload through release composition](2026-09-09-sms-plan-created-release-evidence.md) begins with a saved invitation. Its earlier passing attempt 02 remains archived as `plan-created-release-before-invitation.json`, SHA256 `bc4b54823aa9fb8686eea7b44f9d9163a089fd820e62b38a12b5739e63c1e13a`, in the audit log directory.

This increment adds `quotemate-automation/tests/sms-plan-invitation-recovery.test.mjs` and the narrow `scripts/sms-plan-invitation-fixture.mjs` wrapper to the same dedicated Vitest configuration. The earlier upload/worker/owner-release test body is unchanged. The new cases invoke the actual `maybeHandlePlanEstimation`, SQL 199 request creation and outbox, SQL 198 work claim/retry, shared dispatcher/recovery, and authenticated owner delivery GET/POST. Only the owning tenant is seeded; the actual request transaction creates each invitation, token, conversation and inbound message.

| Case | Required observations |
|---|---|
| Accepted invitation | A stored owned request exists before carrier invocation; duplicate receipt/helper execution retains the request, token, intended outbox and accepted transcript. |
| Transient rejection | Four explicit carrier 429 rejections exhaust the existing in-call retry policy. The outbox remains visible as `retry`, without an accepted transcript. Recovery accepts the same intent and token once. |
| Permanent definite rejection | Carrier 21612 rejection remains visible as `failed` with owner attention required. Anonymous retry is refused; authenticated owner retry and recovery accept the same intent once. |
| Failed enqueue | A recorded pre-enqueue database failure prevents carrier invocation and leaves the actual owning work job retryable. Replaying that receipt reuses the persisted request/token and produces one intended message. |

Each case requires exact tenant/sender/recipient/body/SID correspondence between the accepted intent, fixture carrier and customer transcript. Duplicate original SIDs cannot add inbound rows or new intended sends. All generated customer URLs must use the canonical website origin even when the internal app origin differs.

The fixture adapter invokes the real invitation helper under the real durable work and delivery contexts. It does not execute webhook signature validation, general routing or compiled bootstrap. Carrier responses and one enqueue database error are explicit fixtures; network entry points are denied and recorded before application imports. Local SQL advances recovery timestamps, so the cases do not claim real elapsed scheduler time, process-kill recovery, production PostgREST/RLS or carrier delivery. They exercise definite provider rejection, not ambiguous acceptance or exhaustion of the durable retry budget. Invitation recovery and the retained upload-to-release journey are separate cases, not a single combined customer transcript.

Executed from `quotemate-automation/`:

```text
pnpm exec vitest run --config scripts/vitest-sms-plan-created-release.config.mjs --maxWorkers=1
```

Acceptance checked all five cases (the prior upload journey plus four invitation cases), observed Vitest exit 0, and both fresh JSON artifacts with `completed: true` and empty failure/unexpected arrays. The four modes made 1, 5, 2 and 1 carrier attempts respectively, each ending with one accepted intended message. Before recovery, the transient intent was `retry`, the permanent intent was `failed` and visible in the actual owner queue, and the failed-enqueue work row was `retry` with `Plan upload notification could not be queued`; that enqueue attempt made no carrier call. These failures were deliberate injected acceptance cases, not failed tests. No harness repair or production edit was needed after execution.

The invitation [result JSON](2026-09-09-sms-plan-invitation-recovery.json) SHA256 is `46cd7e2e47f5914ca36db3ac0d83f702e39454a9b37ffddddc92579420ddd02b`. The combined passing stdout is `standalone-ci-five-group-final-05/invocation.log`, SHA256 `3effe58faacfdd1834a4fa8ba8edb871b7fbfc82a2ae15d2b4cdb83bbed2631a`, under `C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/`. The original first-run `plan-invitation-created-attempt-01.log` and its two adjacent JSONs remain archived. The [exact CI refresh](2026-09-09-sms-standalone-ci-evidence.md) preserves both prior reports and fresh copies with runner/Vitest results under `standalone-ci-five-group-final-05/website-composed-tests/plan-created-release/`. Named source hashes were checked before and after each suite; they are not a full dependency-closure attestation. Independent source and evidence reviews passed for the first run; Node syntax checks and `plan-invitation-final-lint.log` cover the two new files and config.

GitNexus was bound to `C:/Users/dalig/Downloads/QuoteMate/quoteMate`, index commit `0b652e60dc1070a4d5fa0f54990fcb1a4fbee402`. The existing standalone fixture/config returned `UNKNOWN`/unindexed; text searches confirmed the dedicated plan-test consumer. The existing fixture function is unchanged, a new wrapper supplies only the omitted real SQL RPC adapters, and the config adds the new test file. Production TypeScript, pricing and release policy remain unchanged.
