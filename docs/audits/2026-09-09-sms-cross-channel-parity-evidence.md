# F16/F17 cross-channel pricing and saved-stage parity

Status: **Fresh two-case execution awaits the final rebuilt candidates and the execution slot after actual 55/HTTP5.** The preserved 8 September checkpoint passed two tests with runner exit 0 against its 21:24Z readiness identity. Its ten named canonical hashes and test bytes remain unchanged, but the complete historical transitive source/configuration inventory is not proven, so this result is not carried forward. The prior whole-candidate identity is superseded. This is bounded offline evidence and does not certify deployed SMS delivery.

## Preserved 8 September acceptance and results

| Finding | Executed boundaries | Assertions that passed |
|---|---|---|
| F16 | Actual platform roofing authority loader/pricer and the corresponding compiled roofing service exports | The same owned, complete approved card and fixed roof measurements produce exactly equal complete pricing output and tenant/book/revision identity. A different tenant's decoy card is excluded. Better price is $38,535.20 ex GST, including the explicit 16% complexity loading. |
| F17 | Actual painting form POST and actual canonical SMS painting dispatcher, delegating to the real estimator, area calculation, pricer, saved-row builder and review-task helper | The same brief and owned complete card produce identical inputs and saved estimates. Each lane prices once, saves one held row, records the review task and customer status, and finishes at `awaiting_review` with `released_at: null`. Both save a Better price of $18,648 ex GST and the same honest review message without a priced link or imminent-delivery promise. |

The painting brief uses an explicitly supplied 180 m² floor area and walls priced at the saved tenant rate of $37/m². The existing deterministic property-provider fixture is retained. These inputs are fixtures, not inferred customer facts or default rate cards.

## Build identity and evidence integrity

- Final readiness SHA-256: `3f70e3787b5834845294b9153988139d73f86c869f2982a669623cb3208f8303`.
- Roofing service source hash: `941ecf544de308732e653386653a172c08ec3c3ec562d8ff522da01ab55e80c3`.
- Roofing manifest SHA-256: `9f5a2076c4e2fe5cc7bf645f4ace3b232909eaf12650f256450d1e1449c0e314`.
- Roofing build attestation SHA-256: `95e2b8803a3e20be1d5bb9fc8c2575173010d4632a61d0e220f427975f5d3111`.
- Test source SHA-256: `ff0357ca64d89f2b8f5def53cf5493328309a15a0524e6857457feeccf1d0b7a`.
- Final result generated at `2026-09-08T21:27:18.228Z`.

The test requires the ready fleet's exact candidate, manifest and attestation paths. It checks the attestation source hash, enumerates the entire compiled inventory, rejects special files/symlinks, and compares every compiled byte hash. It repeats the inventory and hash checks afterward. The recorded canonical hashes include the extracted `completePaintingRateCard` helper. Unexpected database tables and external fetch attempts fail the fixture even when application code catches the original exception.

Machine-readable results, complete estimates and candidate fingerprints: [parity results](2026-09-09-sms-cross-channel-parity-results.json). Implementation: [test](../../quotemate-automation/tests/sms-cross-channel-parity.test.mjs) and [isolated Vitest config](../../quotemate-automation/scripts/vitest-sms-cross-channel.config.mjs). The final log is `fleet-candidate-02/final-validation-2026-09-09/cross-channel-parity-final.log` in the local audit evidence directory.

## Reproduction

From `quotemate-automation/`, set `QM_PARITY_FLEET` to the attested fleet directory and `QM_PARITY_REPORT` to the output JSON path, then run:

```powershell
pnpm exec vitest run --config scripts/vitest-sms-cross-channel.config.mjs --maxWorkers=1 --testTimeout=20000 --reporter=verbose
```

Acceptance requires the command's actual exit code to be zero and a newly written JSON result with both cases present, `completed: true`, and no failed tests. The final validation wrapper additionally recorded the exit code and verified that the file's UTC modification time was after the runner started.

## Build/review iterations

1. Added an isolated `.mjs` test configuration because the repository's normal test include pattern excludes `.mjs` files.
2. The first composed run passed painting. Roofing's complete platform/service output already matched, but an additional hand-calculated expected total omitted the configured complexity loading. Corrected the expected total and asserted the loading explicitly; no pricing code changed.
3. An intermediate run timed out at Vitest's default five seconds during full-inventory hashing. The failed artifact was marked incomplete and retained. Final runs use the repository-standard twenty-second test timeout.
4. Independent review added exact final compiled-inventory comparison and captured unexpected database accesses. Failure tracking prevents a timed-out asynchronous test from publishing a passing result.
5. Both final cases passed, but an outer PowerShell timestamp conversion rejected freshness by reparsing a UTC `DateTime` display as local time. That rejected artifact and log were archived. The corrected UTC filesystem-time gate and unchanged tests then passed together with exit zero.

## Limits

- F16 executes actual authority/pricing exports with fixed measurement facts. It does not invoke rooftop providers or HTTP ingress.
- F17 executes actual form POST and SMS dispatcher business code. It does not execute SMS inbound or the compiled painting service; the separate five-trade compiled-route journey evidence covers those paths.
- Query fixtures and an accepted-dispatch recorder replace database transport and the carrier. This does not prove SQL/RLS, lease contention, outbox delivery, owner approval, PDF/payment behavior, model quality or handset receipt.
- Prices remain held for authenticated tradie review. No live database, external model, carrier, deployed service or customer was contacted.
