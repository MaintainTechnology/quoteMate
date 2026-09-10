# Residential form/SMS same-brief parity evidence

**Current result: all three residential comparisons pass in exact five-group CI checkpoint05**, from `2026-09-09T07:31:52.944Z` to `2026-09-09T07:32:17.307Z`. Electrical, plumbing and roofing each use one actual form lane and one canonical SMS business lane: three comparisons over six independently persisted local journeys. The runner and confirmed child exit 0 with no failures, skips, unexpected errors or blocked calls; the network log is empty. These three cases are included in the full 121-case [standalone CI result](2026-09-09-sms-standalone-ci-evidence.md), not additional passes.

The [current archived composition](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/standalone-ci-five-group-final-05/website-composed-tests/residential-form-parity/composition/2026-09-09-sms-residential-form-parity-results.json), SHA256 `5a2d5f2012a074e31bee4ecd132bc12d21ddc605bfb3041b01862d0a8421538c`, binds **236 named source/import, migration and lock inputs**. The [runner result](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/standalone-ci-five-group-final-05/website-composed-tests/residential-form-parity/offline-result.json) has SHA256 `763068abdf011363cce4628c19ff06601730fb41e646bb7ee27bf2dadefc8bf1`. The CI verifier matches all 334 archived inputs before/after/current, including this composition's dependencies. The earlier 02:19Z result and its 230-input inventory below remain preserved history. No production code changed to obtain either comparison result.

The original audit requires one same-job cross-channel scenario per trade. The residential registry in `lib/quote-request/fields.ts` exposes electrical, plumbing, roofing and painting. Painting already has the separate F17 form/dispatcher parity case. Solar is not an exposed trade in this form registry; its specialist intake has separate journey evidence. This check does not invent a solar form endpoint.

| Trade and common brief | Actual boundaries in both lanes | Saved customer total including GST | Final state |
| --- | --- | ---: | --- |
| Electrical: replace two existing indoor double power points in the garage, flat ceiling, one storey, existing switch within 5 m | Form POST writes its real summary and job hint, authenticates the internal intake POST; SMS lane starts at the canonical intake POST used on dialog finish. Both execute actual structuring, durable estimate work, pricing tools, version capture and quote persistence. | A$264.00, Better tier | One owned draft, `awaiting_tradie_approval`; conversation `awaiting_review` |
| Plumbing: repair one dripping laundry tap by replacing its washer, easy access and no stated hazard | Same form/intake/estimator boundaries, with the actual `tap` → `tap_repair` form hint and plumbing prompt | A$264.00, Better tier | One owned draft, `awaiting_tradie_approval`; conversation `awaiting_review` |
| Roofing: complete corrugated Colorbond re-roof, 2010 building, standard pitch | Actual form POST and canonical `measureAndDispatchRoofing`, both using real tenant rate resolution, measurement orchestration, `priceMultiRoof`, save and review handoff | A$49,055.11, combined Better result | One owned roof measurement; `released_at` remains null and workflow is `awaiting_review` |

Every lane creates exactly one owned review task and accepts exactly two fixture carrier calls: one owner review notice and one customer saved-draft status. The tests bind accepted outbox rows to carrier SIDs, exact text, sender, recipient, audience and tenant. The sole customer transcript points to that outbox row and carries its accepted SID/status. No customer message contains a quote URL, checkout URL, amount or claim that a quote is being sent. The owner task is `notified`, with a null notification error. No intake, quote, measurement or review task is seeded.

The model fixture requires the **actual** complete common brief in the real structurer transcript and estimator input, plus the correct trade hint. For the form lane it also requires the real form summary's identity, address and structured answers. It then supplies a scripted model response through the AI SDK boundary and invokes the real money tool. It does not replace structuring, estimation, pricing or persistence. Electrical/plumbing use the same owned A$120 hourly rate and compare complete saved tier values and the immutable pricing snapshot/hash. The concrete fixture uses the supported labour-based model path with no matching assembly catalogue; it does not prove every product/recipe combination. Roofing uses the existing deterministic mock measurement provider and the complete owned roofing card; the test compares all saved structures, quote/pricing authority and amounts. It does not establish live property measurements.

The actual first form results remain in the report: electrical/plumbing return `{ok:true, inspection:false, texted:null}` and roofing returns `{ok:true, inspection:false, texted:false}`. Each lead is genuinely submitted with a saved submission timestamp. Replaying each form returns `409 already_submitted`. Replaying each SMS business operation recovers its existing work/result. Full saved rows, tasks, conversation state, messages, outbox, work identities and pricing versions remain unchanged after replay, with no new pricing calls, token or carrier call.

## Reproduction and preserved iterations

Run from `quotemate-automation` using the exported offline runner, with a new empty artifact path:

```js
import { runOfflineTests } from './scripts/test-sms-audit-offline.mjs'
const result = await runOfflineTests({
  artifacts: '<fresh-absolute-artifact-directory>',
  maxWorkers: 1,
  files: ['--config=scripts/vitest-sms-residential-form-parity.config.mjs'],
})
process.exitCode = result.success ? 0 : 1
```

The public CLI intentionally rejects flags after its `--` separator; the dedicated CI groups use this supported exported function for fixed configuration arguments. An initial rejected CLI invocation executed no tests.

| Attempt | Result and underlying cause |
| --- | --- |
| 01 | Setup failed before all three cases: the new source inventory named `package-lock.json`, but this app uses `pnpm-lock.yaml`. Corrected the test input. |
| 02 | All three failed new fixture expectations after real electrical/plumbing drafts were saved. The SQL outbox publisher records owner notices as well as customer replies; the initial assertion counted every outbound row as a customer reply. The real roofing loader also includes an explicit `unknown:0` material rate that was absent from the fixture's full-object comparison. Assertions now distinguish exact audiences and the synthetic owned card explicitly declares that zero. No runtime defect was inferred. |
| 03 | All three hit the fixture snapshot query's `ORDER BY id` for an empty `trade_lead_requests` table whose actual key is `token`. A form-lane seed had caused its isolated adapter to add an `id` column, hiding the assumption until the SMS lane. Snapshot ordering now uses the complete JSON row, without requiring a nonexistent column. |
| 04 | All three passed. Independent source review then required closing the local database if fixture initialization throws before the caller receives its handle. |
| 05 | **All three passed again** after that cleanup correction and a declaration-only lint correction. The final run is the reported result; 04 remains a separate checkpoint. |

Attempts 01–05 retain their runner/Vitest logs and original composition JSON under [the validation directory](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09). The final [composition snapshot](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/residential-form-parity-attempt05/composition.json) records `completed:true`, the exact three successful trades, empty `failedTests`/`unexpected` arrays and 230 statically resolvable source/import, migration and lock hashes, verified before and after. Computed runtime module names are outside that static inventory claim. Its SHA-256 is `bb89da5b31c0f27890b1943295a3ece81f84e065bfebaf06a6eb9ac7ca59e17b`.

The [offline runner result](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/residential-form-parity-attempt05/offline-result.json) records 3/3, zero failures/skips, successful confirmed child exit, no timeout/cancellation and empty errors/blocked calls. The network log has zero bytes. Owned execution session `13108` exited 0. Its result hash is `7958aecac839f7dd4f38c346bd9dcbaa8d37744b342d4c53fe4f9be6ba0fb65e`; [Vitest JSON](C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09/residential-form-parity-attempt05/vitest-results.json) is `9c3ad3007b9c21dead41fea8984c9a862fa27016286e95ab13d03a192d80d625`. Scoped ESLint over the three authored files exited 0 with no warnings.

Independent review confirmed the final source and execution evidence. It strengthened the initial test with exactly two total sends, owner/customer audience matching, task notification state, exact customer outbox/transcript binding and initialization cleanup. Final authored hashes:

- `tests/sms-residential-form-parity.test.mjs`: `7bad45b5951ff1357bb9bb058ece4794cccfc4827ea65a39056092da18ad0814`
- `scripts/sms-residential-form-parity-fixture.mjs`: `f2f504ad6ff2b8191bc91e4cb53c3cb31135036bfa2940f6bc08f57af6b32922`
- `scripts/vitest-sms-residential-form-parity.config.mjs`: `de6353a8fa9652606a855d2ceb3a4cc727b9f3c25364b74632329d0a049f4357`

GitNexus could not resolve the newly authored functions; `snapshot` matched unrelated existing symbols. Direct caller searches confirmed these helpers belong only to this new configuration/test. No production symbol was edited. These are offline canonical business-boundary comparisons, not full inbound dialog, browser submission, deployed RLS/PostgREST, real Stripe/Geoscape/Twilio or carrier-delivery certification. The full inbound and front-desk compositions, public approval/release and compiled recovery have separate evidence and must use their own current source identities.
