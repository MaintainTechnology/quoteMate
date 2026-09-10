# SMS address and scope correction recovery

Status: **focused implementation, independent source review and current-source SQL compositions PASS**. The correction-focused checks passed, followed by eleven owner-release cases, two additional-tool creation/release cases and one plan upload/release case. No deployed or real-carrier acceptance is claimed here.

## Confirmed failures and fixes

| Failure | Cause | Implemented behavior |
|---|---|---|
| A saved solar draft ignored address or panel corrections | The saved-reference return ran before parsing; the inbound exception handled names only. | The shared inbound correction action records the requested job change against the owned saved resource before the solar handler runs. Solar gathering phase/panel parsing is verified separately. |
| A correction after intake capture never reached the saved job | Intake checkpoint/recovery deliberately reused earlier inputs, while inbound suppressed additional intake once drafting or a saved quote existed. | An owned durable intake job is treated as consumed work even before `intake_id` linkback. A correction creates a task containing the exact request; it does not rewrite the consumed input or saved money. |
| Held painting/roofing corrections fell into a cold opener or general dialog | Current dispatchers persist `last_step: closed`; older warm-quote tests did not cover that state. | The correction task runs before specialist engagement, including painting scope without a painting keyword and cross-trade roofing address changes. |
| “Resend, and change…” ignored the requested change | Read-only resend returned before other intent handling. | The reply records the change for review and also returns the unchanged saved quote's current status or approved link. |
| Requested replacement address could identify the wrong job | Matching the new address to another saved quote's label overrode the current resource. | Exact current ownership wins. A fresh idle conversation can use its sole owned saved result; multiple jobs require a persisted, revalidated selection. An active new gather/consumed intake is not attached to a historical quote merely because it is the only result. |
| An ambiguous correction could lose its later selection | A numeric selection previously reached ordinary resend; task/context/response failures could leave the association incomplete. | Original receipt, exact text and offered IDs persist before the question. Selection updates the same original task, with its own durable association notification. Retry uses its chosen checkpoint even after pending state clears; concurrent owner resolution is preserved. |
| A later-conversation correction blocked owner approval/send | Every resource-linked task was treated as proof of the quote's original conversation. | The origin resolver excludes `sms-correction:` follow-ups before its 25-row limit and retains the original creation relationships. Migration 201 requires non-null request keys. |

No prompt, price calculation, automatic send policy or release SQL was changed. Existing released tokens retain their approved contents, including the immutable plan/commercial guards in migrations 211 and 212.

## Evidence and review loop

Logs are stored under `C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/`.

- `job-corrections-before-fix.log`: **16/16 actual-handler regressions failed** before integration. The failed checks required a correction task, unchanged saved context and a durable honest response.
- `job-corrections-after-fix-01.log`: initial 16 cases passed. Review then required complete ambiguity selection, replay after context clearing, terminal-state preservation, correct current-job precedence and cross-conversation handling.
- `job-corrections-after-fix-02.log`: 61 checks passed at the intermediate checkpoint.
- `job-corrections-final.log`: **45 actual inbound/task/outbox cases and 29 classifier cases passed**.
- `correction-inbound-combined-final.log`: **118/118 passed across four files**, including the existing customer-link and ingress-recovery regressions. This includes the 74 correction checks above; the counts must not be added together.
- `correction-origin-before-fix.log`: **2 failed / 22 passed**. Actual generic and painting approval returned 503 after a later-conversation correction task added a false origin.
- `correction-origin-final.log`: **25/25 passed**, including original-conversation approval/manual send and more than 25 excluded follow-ups.
- `job-corrections-final-lint.log`: seven source/test files, ESLint exit 0. `correction-owner-harness-lint.log`: SQL-composition harness/fixture lint exit 0; Node syntax also passed.

The [owner-release composition](2026-09-09-sms-owner-release-evidence.md) now invokes the actual correction helper against local SQL for generic and painting jobs before owner approval. Both cases preserve one task and the unchanged saved quote on replay, then attach the initial accepted quote transcript to the original creation conversation. Attempt 07 passed the eleven case bodies but failed overall when its final assertion incorrectly required a URL in the two intentionally link-free correction acknowledgements. Attempt 08 requires those exact acknowledgement bodies, retains all other canonical-link checks, and passes with 30 accepted fixture-carrier calls. `correction-owner-ack-lint-final.log` covers that final test-only assertion edit.

The [additional-tool creation/release](2026-09-09-sms-created-tool-release-evidence.md) attempt 08 and [plan upload/release](2026-09-09-sms-plan-created-release-evidence.md) attempt 02 also pass against the current origin resolver and shared 211/212 guard baseline. All three fresh JSON artifacts have `completed: true`, empty failure/unexpected arrays and separately observed Vitest exit 0. These SQL compositions are distinct from the 118 inbound/classifier and 25 origin query-fixture checks above; their exact source hashes and limits are recorded in the linked reports.

The dedicated inbound tests execute the actual POST, new correction helper, existing human handoff and durable outbox. Database queries, authentication context, model/provider boundaries and carrier acceptance are local fixtures. They test failed task save, committed task/association response loss, context write failure, missing customer outbox, unlock loss, replay across owner release, invalid selection, wrong ownership, concurrent task resolution and pending context across status/name turns. They do not prove the database migration, real process-kill recovery or provider delivery; those have separate composition evidence.

Recognition is deliberately bounded. Supported explicit job fields include address/postcode, quantity/scope, phase/panels and trade-specific scope nouns. Direct assertions such as “The address is…”, “The postcode is3000” and “It is three phase” are covered. Ordinary price/status questions, name-only corrections and explicit new-job requests retain their existing flow. The test matrix does not claim recognition of every possible natural-language correction.

## Runtime identity and impact

GitNexus was bound to the QuoteMax checkout. The file-qualified inbound `POST` and the new origin/helper symbols returned `UNKNOWN`/unindexed results; these were not treated as zero risk. Text verification confirmed the Next webhook, the exporter used by all five trade services, and the three owner approval/send callers of the origin resolver. Independent source review passed after the identified defects were corrected.

| Runtime file | SHA256 at focused freeze |
|---|---|
| `quotemate-automation/lib/sms/job-corrections.ts` | `8715216698efb0fa104863948e0b982ecc2c2abd0a6c37c3438d353e10c03045` |
| `quotemate-automation/lib/sms/quote-origin-conversation.ts` | `77e232c23eb34c1515e244391123678c584a886addde436975a41820007b8d83` |
| `quotemate-automation/app/api/sms/inbound/route.ts` | `24776cef63702b01a95db68061a9eecf08e50f321d5e7012338b658336438ce2` |

Fleet candidates, the final compiled correction bursts and integrated platform checks must be refreshed against these source changes before treating older candidate evidence as current.
