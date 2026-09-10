# F18: unbacked link fallback on a gathering turn

Status: **PASS for the bounded correction**, after an actual POST regression reproduced the defect. Before the fix, one test failed and 43 passed; the accepted outbox contained `Thanks - I'll get your quote sorted and come back to you shortly.` After the fix, all 122 focused tests passed, with zero failures or skips, observed exit 0 and confirmed child exit. Both runs had empty network-attempt logs. Scoped ESLint passed for the three changed files. Independent source review passed.

The concrete route is an open electrical gathering conversation with a known first name/suburb, no saved intake or quote, and an ordinary customer answer such as `The power points are for the bedroom.` The model's structured response is `action: ask`, `ready_for_intake: false`, no photo/product-choice request, and `Sending the link now.` Existing quote actions do not classify that customer answer as a resend; the name/suburb overrides stand down. Grounding permits the response because it contains no invented amount, count, address or actual URL. The real photo gate returns `no_trigger`, so `stripLinkPromise` removes its only meaningful clause.

Previously the helper supplied the unsupported quote/follow-up promise. The actual inbound handler dispatched that text while retaining `status: open`, no intake/quote, no owner task and no intake enqueue. There is a durable inbound job and accepted reply intent, but neither schedules the promised quote work. Genuine quote-link requests use an earlier server action and do not prove this particular failure.

The only runtime change is `NO_LINK_FALLBACK` and its explanatory comment in `quotemate-automation/lib/sms/dialog-grounding.ts`:

> I have not sent a link in this reply. What would you like help with next?

The wording describes this reply, without denying a link from an earlier turn or promising unscheduled work. No routing field, prompt, pricing logic, transport behavior or inbound runtime code changed. A remaining meaningful question still survives stripping; genuine resend requests still use the owned saved-reference action.

| Focused file | Passed | Added coverage |
|---|---:|---|
| `app/api/sms/inbound/route.customer-links.test.ts` | 44 | Three actual POST cases: accepted honest gathering reply with no downstream quote/task work; retained question; genuine no-saved-quote resend before dialog. |
| `lib/sms/dialog-grounding.test.ts` | 25 | One exact fallback/no-imminent-promise case; prior assertions retained. |
| `lib/sms/quote-actions.test.ts` | 10 | Existing saved-reference controls. |
| `lib/sms/photo-request-trigger.test.ts` | 43 | Existing photo-trigger controls. |

The actual POST cases delegate to the real quote-action handler, generated-link guard, grounding and photo-trigger helper. They use real `dispatchDurably` with fixture database RPCs and a fake carrier, then check the accepted intent/transcript. Model output, database queries, durable lease/checkpoint context and carrier acceptance are fixtures. This is not a compiled-service or deployed reproduction, a real SQL lease/claim test, general model-quality evaluation, or evidence that all possible free-form promises are detected. Its scope is the exhausted-strip fallback and the two adjacent controls.

The shared offline runner executed from `quotemate-automation/`:

```text
node scripts/test-sms-audit-offline.mjs --artifacts=<validation>/f18-link-fallback-before --maxWorkers=1 --timeoutMs=120000 -- app/api/sms/inbound/route.customer-links.test.ts
node scripts/test-sms-audit-offline.mjs --artifacts=<validation>/f18-link-fallback-final --maxWorkers=1 --timeoutMs=120000 -- app/api/sms/inbound/route.customer-links.test.ts lib/sms/dialog-grounding.test.ts lib/sms/quote-actions.test.ts lib/sms/photo-request-trigger.test.ts
pnpm exec eslint lib/sms/dialog-grounding.ts lib/sms/dialog-grounding.test.ts app/api/sms/inbound/route.customer-links.test.ts --max-warnings=0
```

`<validation>` is `C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09`. The before run finished at `2026-09-09T02:06:02.008Z`; the final run finished at `2026-09-09T02:08:23.892Z`. Each directory contains raw stdout, Vitest JSON, offline-runner JSON and the empty network log. The old helper bytes are preserved under the before directory; the final directory includes `lint.log` with explicit exit 0. The runner supplies inert credentials and a recorded Node network backstop; this is not an operating-system sandbox.

| Evidence | SHA256 |
|---|---|
| Before runner JSON | `5bf95cf7f7b3356f16558dc83c66c7d37406100fc682a1d70b31bcf455d24b63` |
| Before Vitest JSON | `6dd80140c75be1f34fe55d11ba29762c01e7d992ad280f7676f0c4feabc90922` |
| Before raw log | `00cae2ad45c5426bf777d03772f5617c7b721635c2fe630142715901792fcb05` |
| Before helper bytes | `f05846379db3e87015b2800369a3b88e374f3761c7358edc1f5e288fa159b32f` |
| Final runner JSON | `fa573ca2a0485ab7d964d00c84bce96a6c78dbd4c92045ab7bc9fa2e1b51ca87` |
| Final Vitest JSON | `dc031f3663e8395fda296e8219b14f0064f047553b0c18899597c4185ecf6928` |
| Final raw log | `5b8d5c623da7c79fc329ba8a7f6a03176b8781be3c174db87ad50aac1f5c3455` |
| Final lint log | `5c14c246be3262ab8efc39374ecd0805c34fcac42d398713723f5dde0087c6f7` |
| Current runtime helper | `0762502f1bdecc15964a9a309a190c786205c3852a5f961eba7eb542f7b4f983` |
| Current pure test file | `47f831be624f1dd69de6cced0c69923e0cc1d242e2a3ab9ae73543a897db7689` |
| Current actual POST test file | `a1b9c65d8fd708ba135261f5ed7a6ae7b98912c5c62a5c0eb080cbd72fa3cb7b` |

GitNexus impact was run before editing against the bound QuoteMax checkout. Its unresolved result was treated as UNKNOWN; text/context checks confirmed the canonical inbound call at line 4036 and test consumers. The helper is part of the exported trade dependency closure, so earlier fleet results remain historical until rebuilt against these bytes. Final integrated platform and fleet validation is recorded separately by the parent audit.
