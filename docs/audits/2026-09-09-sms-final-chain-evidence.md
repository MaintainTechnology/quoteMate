# SMS final quote chain and signed delivery evidence

**Local composition gate: all 75 selected assertions PASS on their unchanged current inputs.** Full-platform-06 passed nine joined chain/delivery cases, 23 SMS balance-recovery cases and 43 existing balance-handler cases, with no subset skips or blocked external calls. They are a subset of the full suite; no separate 75-case rerun or additional total is implied. The enclosing runner and parent exited **1**, with confirmed child shutdown: one separate commercial-painting browser assertion failed, leaving 10,273 passed and 24 skipped. Typecheck passed; full06 did not run a production build. The failed overall result and its runner errors are retained rather than relabelled as a clean full gate. After the browser-only fixture repair, the separate typecheck07 and production build08 passed; the 42 named inputs for these 75 assertions remained unchanged.

This closes the local evidence gap in the audit's “Tradie review, send, final quote and balance” row and adds joined F12 receipt/recovery coverage. It does not certify production deployment, schema/RLS, a real carrier delivery, or a successful charge.

## What executes

Each electrical/plumbing chain starts with only a synthetic owned, paid initial inspection and its saved historical priced tier. The fixture obtains the original version using the actual migration207 capture function. It then executes:

1. Actual authenticated `issue-final` POST and migration214 create one final draft. An exact replay after the mutable price book changes retains the child, token, historical source version and cents. No customer outbox exists before owner approval, and the public page conceals the held price.
2. Actual owner `send` POST validates the reviewed revision and recipient. Unauthenticated/stale approvals fail before any outbox. Migration215 persists the reviewed snapshot and delivery intent. Actual dispatcher and `sendSms` form encoding reach a fixture HTTP endpoint; only `fetch` is replaced.
3. Actual migration217 accepted-delivery trigger and settlement helper apply the inspection credit. No final payment state is seeded or patched. These small jobs have no deposit left to charge, so the SMS truthfully says that the site visit covers it and omits a deposit-payment link.
4. Actual `request-final-payment` POST and migration213 create one owned balance child, retaining the final's source version. Replaying the same operation and opening its GET readback produce no new send or repricing.
5. Actual public final server component renders the customer amount and balance-payment link. Both the released initial token and balance token redirect to that same final page. The saved-reference tool resolves the requested balance; a duplicated resend turn reuses one outbox and one transcript.
6. The callback URL captured from each real outbound HTTP form is signed using the inert fixture secret and sent to the actual `/api/sms/status` POST. Real signature validation, migration199 receipt persistence and customer transcript updates execute. The authenticated delivery GET reports the resulting state.

| Lane | Historical tax | Final principal | Stored balance principal | Public payable balance, including existing 2% fee |
|---|---|---:|---:|---:|
| Electrical | Not GST registered | A$300.01 | A$201.01 | A$205.03 |
| Plumbing | GST registered | A$275.01 | A$176.01 | A$179.53 |

Both lanes retain one final, one balance, three intended outboxes and three customer transcripts: final release, balance request and explicit saved-link resend. The original inspection row remains unchanged. The two lane totals are fixture inputs, not recommended customer prices or a full catalogue evaluation.

## Joined delivery controls

The remaining seven cases execute actual outbound HTTP parsing, signed receipt handling and durable SQL:

| Scenario | Observed result |
|---|---|
| Queued → delivered, duplicate delivered, older sent/undelivered callbacks, legacy `SmsStatus` field | One delivered transcript; older callbacks cannot downgrade it |
| Signed undelivered, owner recovery, stale former-attempt callback | Visible non-delivery/error; explicit retry retains intent/body, changes attempt; stale callback rejects; matching callback updates the same transcript |
| Invalid signature, wrong account, wrong SID, wrong attempt | Rejected without changing the saved delivery |
| Stale accepted SID, injected timeout | Attention remains visible; no additional send; later successful read reconciles delivery |
| Stale accepted SID, HTTP503 read | Same no-resend and reconciliation behavior |
| HTTP201 with unreadable body | Accepted response is retained without a SID; credit remains pending, owner/automatic resend is refused; signed receipt supplies SID and settles credit |
| HTTP201 JSON without SID | Same behavior as the unreadable-body case |

The nine cases made **14 fixture carrier POSTs and four fixture carrier GETs**. These are deterministic local calls, not messages sent to customers. HTTP201 with no readable SID is stored as accepted without SID, rather than claimed delivered; the test verifies the absence of automatic retransmission. The accepted/delivered states are reported separately.

## Evidence and review

- [Current chain composition JSON](C:/Users/dalig/Downloads/QuoteMate/quoteMate/docs/audits/2026-09-09-sms-final-chain-release.json): nine completed cases and 39 named source hashes.
- [Current full-platform-06 subset archive](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full-platform-06): complete runner/log/Vitest JSON, its failed overall result, the exact 75 passing selected assertion objects, fresh composition reports and 42 archived named inputs. All 2,795 before/typecheck/after-test snapshot entries match within full06. All 42 named inputs still match current source; the sole subsequent whole-tree change is the separate browser test fixture. This remains a named-boundary archive, not a complete import closure.
- [Independent selected75 review](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full-platform-06/independent-review.json), SHA256 `45f014ae43f9a89402276f6e5fcd41881e5da85327f8990a20b94bb385448477`, verifies the exact selected assertion objects, 13 artifacts and 42 current/archive source files while preserving the enclosing failure.
- [Subsequent typecheck07/build08 source bridge](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full-platform-06/subsequent-tsc07-build08/verified-bridge.json), SHA256 `1c181cb2b82471148037ad92af6f84bbd52f219a82c9304f0023f8ced545b93b`, binds eight copied receipts/logs/source maps. All 2,795 inputs match across the later typecheck and successful build, with the same 1,473 runtime inputs as full06. Build08 completed at `2026-09-09T11:08:19.4289717Z`; typecheck07 passed separately, but its build wrapper did not complete. This bridge does not claim a full-suite rerun.
- Its [independent bridge review](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full-platform-06/subsequent-tsc07-build08/independent-review.json), SHA256 `b48533ecb694dce4d2b1e4d1a413ed9653b64fb74fea63e7227e9a92efebf44e`, verifies all eight source/archive artifacts, the later source maps and unchanged named/runtime inputs while preserving both earlier incomplete gates.
- [New tests](C:/Users/dalig/Downloads/QuoteMate/quoteMate/quotemate-automation/tests/sms-final-chain-release.test.ts) and [chain fixture](C:/Users/dalig/Downloads/QuoteMate/quoteMate/quotemate-automation/tests/fixtures/sms-final-chain-fixture.ts).
- The four SMS-owned test/fixture files passed scoped ESLint. An independent source reviewer and the root reviewer verified the final fixture, runtime boundary selection, assertions and recorded evidence. No runtime fix was required by these nine new cases.
- The [preserved full04 independent review](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full04-independent-review.json) and [completed-checkpoint companion](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full04-completed-independent-review.json) retain that earlier clean full build and its source identities. They are historical, not a full06 parent PASS.

Full06's test runner ran from **10:35:07.720Z to 10:47:10.627Z**. The chain report was written at **10:38:30.253Z** and balance report at **10:37:47.172Z**, both within that run. The balance JSON is deterministic and retains its prior hash because all 26 named inputs are unchanged. All 42 distinct named inputs remain the same as full04; the PDF helper remains `fa77170fefbf2d9353bcad2d5590da155ac9a9dc676b4d68ce1a85a02690cf8d`. This link-only composition does not substitute for the [115 specialized PDF regressions](2026-09-09-sms-specialized-pdf-immutability-evidence.md).

| Current artifact | SHA256 |
|---|---|
| Full runner result (overall exit 1) | `3c8071ca08566e673a6fc346483529b794ea08b1d95b283154f3bbe0268fbcbf` |
| Full Vitest JSON | `a75a58aaca15348fcae41d758de1ca59535c7b452443d7ab7fb1b82afe26d49b` |
| Selected 75 passing assertion objects | `791e3a4c5e294803643f688ffff1e9f7f583dfd8bdeb49fec98e1e41e003a2c9` |
| Chain composition | `083fa59ca9470a06748567d76bf040b9e9ab47a62156bc56874a45892859944c` |
| Balance composition | `e63947fd000a8cb6cc08cc26ca4dfa5b33f8e476029bd9e9fd784cdb6b8b28eb` |
| Archived source inventory | `967045a4b050346f00ee21d24fad5302cc94f817717562c34fcac08016977a59` |
| Failed full06 platform result, build not run | `7a584dd87e05d0322ac3ecb26a24adbc87944d79629017b1575280f82e5eda62` |

The [preserved full04 archive](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full-platform-04) completed typecheck, tests and production build with exit 0 at `2026-09-09T08:01:42.4445276Z`, retaining all 2,795 source hashes through that build. Its completed platform receipt remains `ba931d03485a617b66b0f98a723f28c98e6e46d4cdfa9768a54098715541e3e3`; later rooftop and browser work requires the newer gates stated above.

## Preserved checkpoint06

[Checkpoint06](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-checkpoint-06) ran from **04:13:51.766Z to 04:14:23.087Z**, passed 75/75 with confirmed child exit and no timeout/cancellation, and retains its original source archive. These identities describe that earlier checkpoint:

| Artifact | SHA256 |
|---|---|
| Runner result | `2032e95ba083f9bfcf026eeea6c2bb0097cbdace23fc705e32be4792032e3d33` |
| Vitest JSON | `f02a292cc3b8a4064c2515773903d18a6f3f9345e5377a4e1659f1e34bdf4bb1` |
| Chain composition | `fc70ae2b901bef0671350663e2edc439f9774ed8fa373ad5b7c468ec2d8a7407` |
| Balance composition | `e63947fd000a8cb6cc08cc26ca4dfa5b33f8e476029bd9e9fd784cdb6b8b28eb` |
| Archived source inventory | `872fd81b326119449fde0cd0d485b9fe9ca65698ef32c69146dc6667d6902afc` |

Earlier checkpoints remain alongside the final evidence. Checkpoint01 passed the existing 66 cases but failed new-fixture setup because a text Stripe account ID was inferred as UUID. Checkpoint02 exposed missing test transport support for the sender timeline insert and a missing physical `last_status_at` column. Checkpoint03 passed seven cases; the other two incorrectly expected a deposit link for an entirely credit-covered deposit. Checkpoint04 passed seven; the other two incorrectly expected the principal amount in a fee-inclusive payable CTA. Those fixture/schema/assertion errors were corrected without changing runtime, money, quote state or approval logic. Checkpoint05 passed nine; checkpoint06 repeated all 75 after using a real errored `ReadableStream` for the unreadable HTTP201 response. Failed results were not counted as passes.

## Practical limits

The database is one PGlite connection with explicit minimal physical columns and actual migration functions, not the full production schema or a multiple-connection concurrency test. Auth, PostgREST-shaped transport and carrier HTTP responses are fixtures. Stale timestamps and timeout events are injected; the test does not wait five real minutes or ten seconds. The PDF renderer is explicitly unavailable and the actual sender uses supported link-only behavior; PDF rendering and visual fidelity remain separate gates. Public pages use actual server rendering with browser-only owner chrome and post-response work omitted. No checkout, Stripe charge, live model, real carrier, native UI, deployed front desk or compiled service bootstrap executes here. The source hashes cover named boundaries, not the complete import closure.

The complete audit acceptance gate therefore remains broader than this passing local composition.
