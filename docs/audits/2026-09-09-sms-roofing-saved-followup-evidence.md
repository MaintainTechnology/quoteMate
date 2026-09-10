# Saved roofing follow-up repair — 9 September 2026

The focused repair passes **275 tests** with no skips, failed assertions, unmocked external calls or unfinished test child. The subsequent [55-case compiled journey matrix](C:/Users/dalig/Downloads/QuoteMate/quoteMate/docs/audits/2026-09-09-sms-compiled-route-journeys.md) also passes on freshly built candidates with the unchanged harness, including all ten roofing recovery cases and the original failing burst assertion. All six matrix parents exited 0 and passed independent review. This closes the reproduced local F15/F18 saved-follow-up defect; provider, deployment and full production concurrency evidence remain separate.

## Reproduced problem and cause

The fresh compiled matrix stopped during roofing's first burst case, `before-history`, at `scripts/test-sms-route-journeys.mjs:282`. A customer's first-name correction sent a second accepted intake-form opener and replaced `roofing_state` with empty slots, `offer_form` and a null pending quote token. The preceding state contained the consumed address/material inputs, saved token and `workflow_stage: awaiting_review`. The saved measurement and generic quote reference survived; that did not make the reset or extra message correct.

The roofing-only engagement arm accepted this closed conversation, and the deterministic cold-start path reset it before offering another form. The same path also restarted for “Thanks”, “What happens next?” and “What happens next with my roof?”. Painting already has a distinct closed-flow guard and retains its saved specialist state during ordinary name extraction.

The failed compiled parent exited 1; all 105 recorded child PIDs from its six completed kill cases and unfinished burst were closed. The earlier normal five, electrical ten and plumbing ten remain **25 completed historical results**. Six partial roofing PASS lines are not a completed roofing result. Painting and solar recovery parents were not started. The old readiness receipt was invalidated and preserved by the fleet owner.

## Narrow correction

`quotemate-automation/app/api/sms/inbound/route.ts` now intercepts saved roofing-only conversations after authoritative quote actions and saved-job corrections, and before specialist gathering. The gate requires a closed roofing state, its saved token and the local review workflow marker. Ordinary replies use stage-neutral wording because owner approval may have changed the real quote's release status since that conversation snapshot.

Explicit name updates use the existing extractor in a durable checkpoint, project only `first_name`, and perform a checked conversation-and-tenant update before acknowledgement. The write completes the follow-up as `done`, undoing POST's earlier reopening without replacing specialist slots, token, quote reference, selection or pending correction. Retrying after a returned error, missing row, lost write response, lost checkpoint acknowledgement or failed unlock reuses one chosen name and one accepted reply. An unrecognized name prompts an explicit full name statement; a separate work item and MessageSid exercise that clarification response.

Explicit new jobs remain on the existing intake path. Actual-handler controls include a mixed name/new-property request, “quote another re-roof”, a new street-address quote, “Ok can you price 652 London Rd Chandler QLD 4155”, and “I need another roofing estimate”. A shared roofing-and-painting tenant can still start a painting enquiry. Solar's existing checkpoint/reply and both specialist machines are unchanged.

## Build and review evidence

Artifacts are under `fleet-candidate-02/final-validation-2026-09-09/saved-specialist-profile-repair-01` in this task's visualization evidence directory.

| Checkpoint | Actual result | Meaning |
|---|---:|---|
| Initial test preparation | 48 pass / 18 fail | Includes overbroad proposed painting expectations and a quote-action fixture switch omission; retained without calling every failure a runtime defect. |
| Corrected untouched-runtime baseline | 54 pass / 11 fail | All 44 existing cases and three painting controls pass; remaining failures exercise the roofing reset and required recovery behavior. |
| First repair | 59 pass / 6 fail | Exposed the preceding POST reopening; the saved follow-up needed a checked completion write. |
| Corrected repair | 65 / 65 pass | Focused first checkpoint. |
| Independent cross-trade regression | 65 pass / 1 fail | Shared-tenant painting request was intercepted; narrowing to `tenantIsRoofingOnly` fixed it. |
| First six-file checkpoint | 274 / 274 pass | Preserved in `final-tests` and the first source archive. |
| Independent new-estimate regression | 66 pass / 1 fail | The new-job predicate omitted `estimate`; the explicit new-job noun list was corrected. |
| Final six-file checkpoint | **275 / 275 pass** | `final-tests-02`: parent/child exit 0, confirmed child close, zero skips, errors and blocked calls. |

Final counts are **67 actual-handler controls** (44 unchanged original cases, 19 roofing cases, four painting/cross-trade controls), 69 roofing-machine cases, 56 solar cases, 44 painting-machine cases, 10 quote-action cases and 29 saved-job-correction cases. These are overlapping regression groups, not 275 independent end-to-end customer journeys.

Full platform run 05 subsequently stopped before tests/build because the shared-tenant fixture's roofing/painting array did not fit the older `Trade` type. One erased assertion at that mocked tenant boundary fixes the fixture type without changing its values or assertions. Independent transpilation verified identical JavaScript (`caae966f545984090224bbb56595f5d9965690cf652f60e6cf32612592652102`); the route remains `c1361df9a9a90c6054247ea97e6c8fa77d54a609cba9aa2d92100bfca48bcbc3`. The current test hash is `6270a2626d16f2946492787c5b1410cc5f069197a28269a7d63020ba1b2d1811`. The archived 275 execution remains bounded by `type-annotation-independent-review.json`, which verifies the other 213 archived/current inputs are unchanged. Full06 passed typecheck and these focused assertions within the full suite, but its overall parent failed on one separate browser fixture race (10,273 passed, one failed, 24 skipped; no build). The repaired browser controls, separate typecheck07 and production build08 passed afterward; all five trade candidates were freshly built for readiness `f95126d0af7467d03dbc9fae433f7bf81ab6b2c31f89a601567a0c3dfde1da0c`. Neither the erased type bridge nor the later gates convert full06 into an overall pass.

The original 44-test describe body is byte-identical to its archived pre-change source. New fixture instrumentation records the actual profile-save query filters and asserts both conversation ID and tenant ID, including refused writes. The compiled journey harness and its assertion at line 282 remain unchanged.

File-disambiguated GitNexus impact for `POST` returned **UNKNOWN**, not low risk. Current text/caller verification confirmed the Next HTTP route, actual handler tests, compiled child loader and all five receptionist exports consume this canonical route. This required the five fresh trade builds now recorded in the completed matrix's readiness receipt. The test-fixture callback was absent from the graph; its local mock/query call sites were confirmed directly. No commit, provider call, deployment or migration was performed.

## Evidence limits

The handler tests execute the canonical POST and deterministic specialist code with fixture authentication, database query responses, model output and carrier transport. The durable outbox implementation is real, while its SQL RPCs are fixture responses. The separate-work clarification is an actual two-POST composition, not a real Twilio conversation. The current-source archive records resolved static local imports plus explicit test configuration, lockfile and runner inputs; it does not certify every package implementation or production environment.

No language evaluation is claimed from scripted extractor responses. The new ordinary reply does not generate prices or assert a live release stage. The compiled roofing failure, every intermediate failure and previous passing checkpoint remain available for independent review. The completed 55-case matrix supplies the stated compiled-route evidence, and the [separate typecheck07/build08 source bridge](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/final-chain-full-platform-06/subsequent-tsc07-build08/verified-bridge.json) records the later passing typecheck and production build. Live provider behavior, deployed tenant isolation and production concurrency remain outside these local checks.
