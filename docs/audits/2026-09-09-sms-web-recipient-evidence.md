# Web quote recipient review

Current result: **20 focused tests and 14 browser assertions pass**, with zero failed or skipped focused cases. The offline runner exited 0 with confirmed child shutdown, no blocked network calls and no runner errors. Six-file ESLint passes with zero warnings. The refreshed browser process exited 0 after browser/server cleanup; all owned processes are closed.

The SMS audit owns the three web components and their tests. The coordinated mobile task owns the `/approve` and `/send` API changes and `lib/quote/delivery-recipient.ts`. This document proves web adoption of that contract; it does not certify the pending combined API/fleet release.

Independent source review passes on the final three web hashes, including the A→null retry correction. No web runtime issue remains open in this bounded review.

## Problem and change

| Problem | Cause | Change and regression |
| --- | --- | --- |
| A send could resolve a different contact from the one shown during review. | `SendQuotePanel` omitted a destination when using its displayed on-file contact. Quote revision hashes do not include recipient fields. | The request always includes the displayed string `expected_recipient`. On-file sends still use server fallback; a deliberate typed override includes matching `to` and `expected_recipient`. SMS and email controls cover both cases. |
| The generic approval page did not show the SMS destination. | It read only the intake's summary/name fields. | The owner page reads the owned intake and uses the shared strict owned-contact resolver, displays its phone, and passes exactly that phone to `ApproveAction`. Missing contact disables sending; failed owned reads show an unavailable message without an action. Nonowners cannot read the contact. |
| Retrying a lost response could combine an existing resend UUID with newly displayed contact/revision fields. | Only the UUID was retained locally. | The request snapshot now retains recipient, override and quote revision with that UUID. Approval retains the same initial request snapshot. The UI shows the retained SMS destination while that outcome remains uncertain. |
| A contact disappearing after a lost response disabled recovery of the existing request. | The first draft checked only the current phone prop for button availability, despite retaining the original request. | Independent review found this before freeze. Both phone A→B and A→null cases now allow the same saved request, preserving its original body; a fresh request with no reviewed phone remains blocked. |
| Contact conflict could lead to repeated attempts without a fresh review. | The UI handled the error as a generic send failure. | `quote_recipient_changed` and `quote_contact_unavailable` block that action and offer explicit contact refresh/review. No automatic retry or replacement recipient is submitted. Existing uncertain-email and known-pending-SMS recovery rules remain. |

The agreed optional wire field is a **string**. The API helper normalises recognised AU phones; stored foreign numbers retain exact comparison. Email comparison trims and lowercases its domain while retaining local-part case. The web sends the actual displayed text and delegates those rules to the server. Omitting the field remains legacy API behaviour, so this is not a mandatory recipient-proof rule for every external caller.

## Validation and history

- `web-recipient-focused-03`: 14 client callback tests plus six actual approval-page/strict-resolver tests. The client fixture executes the mount effect and state transitions, including enabled retry after A→null. The page fixture executes the actual page and actual strict resolver over recorded offline queries. Unknown fixture imports/tables fail the checks.
- `web-recipient-browser-02`: all 14 assertions pass on the final web component bytes. This retains the eight original recovery/review checks and adds six generic-client checks across 390 px and 1280 px widths. The added checks cover SMS/email recipient conflicts, original UUID/body retry after response loss and approval conflict review. Phone A→null and strict server-page resolution are focused-test cases, not additional browser claims.
- `web-recipient-focused-01`: 18 test cases passed. Its first lint attempt failed on nine `react-hooks/refs` errors from reading the immutable retry ref during render. A state projection now owns displayed recipient values; the ref is used only in event handlers.
- `web-recipient-focused-02`: the corrected render-state version passed 18 tests and lint. Independent review then found the disappearing-contact retry edge; this checkpoint does not include its two new controls.
- `web-recipient-browser-01`: 14 assertions passed and the outer process exited 0. These retain all eight earlier recovery/review checks and add six checks for the actual generic send/approval clients across 390 px and 1280 px viewports. It predates the disappearing-contact availability correction.

Evidence root: `C:/Users/dalig/.codex/visualizations/2026/09/08/01a07f99-45aa-7301-bf72-b1e946ed3015/fleet-candidate-02/final-validation-2026-09-09`.

Current named source hashes are recorded in `web-recipient-focused-03/source-hashes.json`, including the three web files, two direct test files, browser harness and the shared resolver version used by the tests. The browser report separately fingerprints its five actual client components. These are named-boundary inventories, not a complete transitive dependency attestation.

`web-recipient-final-summary.json` records the observed process exits and these verified artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| Focused offline result | `da5d62b198bc92c5213dfadb947a8d41cedd66a0d8323470c32d6a3872759c30` |
| Focused Vitest result | `dec0c4dcdbd2ed957a8b9153c4ebbb2de624c6be5078c6e653fc802067ff7e39` |
| Final lint log | `d16fdeccb33d9885f19b714c41dbcf74e9932cefa727d121051beaedd5d21d70` |
| Named source inventory | `d03bb8df282bebb1f4ab1e58883c2aa60a93c11da8cc446ff53d6e72b7f377bc` |
| Final browser result | `00928d4d59b572876e337606ebea86a77129012a8b2cacc90051e4a404d08f59` |
| Final browser log | `68452910a6c5b20f4e524d5093859296877017288cc4fc2350d370ac8bbd99bb` |

GitNexus impact ran against the explicit QuoteMax checkout before edits. `ApproveAction` was LOW with its one direct `ApprovePage` caller. `SendQuotePanel` and `ApprovePage` were UNKNOWN; text search confirmed the dashboard JSX callers and Next page entry. New/unindexed test/harness consumers were confirmed as direct Vitest/manual script entries. No HIGH/CRITICAL result was ignored.

## Limits and API handoff

The browser uses actual bundled client components with fixture authentication, HTTP responses and Next Link, in a loopback server. Its generic approval wrapper seeds a reviewed phone; the separate page tests establish the server page's owned-phone projection. It does not execute the real approval/send APIs, production auth, carrier, database, hosted browser page or deployed fleet. An aborted browser response is an injected unknown client outcome, not proof of actual provider acceptance.

The web retains and resubmits its original operation after a lost response. Successful backend replay after a contact changes still requires the mobile API's owned saved-intent readback and immutable-outbound checks. A UI callback test cannot prove that SQL/provider behaviour. Likewise, comparing a captured recipient and carrying it unchanged into delivery binds the reviewed recipient; it does not prove the mutable contact row still matches at commit time. The shared [coordination note](2026-09-09-sms-mobile-coordination.md) records that distinction and the reserved API responsibilities.
