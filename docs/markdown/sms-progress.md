# sms-progress

_Converted from `sms-progress.html`._

---

  QuoteMate · Weekly Progress · 2026-05-06

[QQuoteMate](#)

Weekly Progress · **2026-05-06**

Build status · Updated 2026-05-06

# SMS Agent — _shipped end-to-end_.

All five phases of the SMS channel are live in production. Real customers can text our number, the AI greets + thanks them, the dialog gathers details (capped at 4 turns with declared assumptions), the SMS Agent dispatches a photo-upload link, the existing intake + estimation pipeline drafts a Good/Better/Best quote, and the customer receives the same polished quote SMS the voice path produces — with photos. The tradie gets pinged via SMS + WhatsApp on every draft. Daily abandoned-conversation cron is armed.

Reporting periodWeek of 2026-05-06

SMS channelPhases 1–5 ALL DONE · production-live

Voice agentHardened — strict grounding live

Quote outputHTML page + tier photos + Stripe deposit + booking

## Priorities — at a glance.

All five priorities Jon set on 2026-05-05 are now resolved.

-   DONE

    #### 1\. SMS trigger and dialog (similar to voice agent, fast + simple, with assumptions)

    Customer texts +61 481 613 464 → Haiku 4.5 dialog agent (capped at 4 turns, off-topic redirect, declared assumptions per job type) → handoff to the same Opus 4.7 intake + estimation pipeline as voice → customer SMS with full G/B/B quote and HTML quote page. End-to-end verified on a real phone. [See SMS section ↓](#sms)

-   DONE

    #### 2\. Ensuring the electrical agent is consistent in its outcomes

    Strict grounding wired into both the intake and estimation prompts. A 4th defence layer (DB-grounding validator) automatically downgrades any ungrounded line item to the $199 inspection route. [See Voice Agent section ↓](#voice)

-   DONE

    #### 3\. Parameters of estimation made clear

    Every quote line item traces back to a row in our pricing book — no free-form pricing from the LLM. Confidence routing decides between auto-quote, tradie review, or inspection-only based on intake quality.

-   DONE

    #### 4\. How we onboard each trade

    Onboarding bundle spec written: each new trade ships as a single bundle of five components (assemblies, intake rules, pricing defaults, G/B/B framing, licence schema). Electrical is the reference; plumbing is sketched as the worked example. [Read the spec →](onboarding-bundle.html)

-   DONE

    #### 5\. Quote output — webform / agentic creation, with mocked photos

    Customer-facing HTML quote page live at `/q/[token]` with per-tier mocked photos (`lib/quote/tier-photos.ts`). Per-tier Stripe Checkout deposit links. Photo upload supports both camera and gallery. Inspection-route jobs show a $199 pay-link variant. [See Output section ↓](#output)

SMS channel — overall Phases 1–5 ALL DONE · 100% shipped

**SMS Agent is fully shipped end-to-end.** All four engineering phases live + verified on a real phone. Phase 5 deploy steps complete: three migrations applied to prod Supabase, `CRON_SECRET` + `TRADIE_NOTIFY_*` set in Vercel Production env. Daily cleanup cron armed. Tradie notify firing on every SMS-sourced draft.

SMS Channel · **Detailed step status**

## SMS quoting agent — every SOP step, where it stands.

Mapped 1-to-1 against the steps in [sms-sop.html](sms-sop.html). Every row is shipped and verified.

### Phase 1 — Plumbing (DONE)

A customer text reaches our backend, gets saved, and gets a reply.

-   SMS01 DONE

    **SMS dev number provisioned + env wired**

    +61 481 613 464 is live on Twilio for SMS. Env vars set on local + Vercel: `TWILIO_SMS_NUMBER`, `TRADIE_NOTIFY_NUMBER`, `TRADIE_NOTIFY_WHATSAPP`, `TWILIO_WHATSAPP_FROM`. WABA registered sender +1 555 941 5397 ("NomanuAI") provisioned for production WhatsApp.

-   SMS02 DONE

    **Database migration ran**

    Two tables in Supabase: `sms_conversations` (status + turn count + assumptions + intake link) and `sms_messages` (one row per inbound/outbound + photo URLs). Indexes added for fast per-customer lookup and photo-bearing message lookup.

-   SMS03 DONE

    **Twilio signature validation helper**

    Every inbound webhook is verified against our auth token. Rejects forged requests with 403. Reconstructs the URL from forwarded-host headers so signatures match even when Vercel internal routing rewrites the URL.

-   SMS06 DONE

    **Inbound webhook — full route with idempotency + fast-ack**

    Validates signature → idempotency check on `MessageSid` → finds/creates conversation → MMS extraction (Phase 4) → persists inbound → returns 200 in <500ms. Heavy work (Haiku call, dispatch, outbound persist, conversation update, intake handoff) runs in `after()`. `maxDuration=60`. Eliminates duplicate-reply bugs from webhook timeout retries.

-   SMS07 DONE

    **Outbound sender (SMS-first / WhatsApp-fallback dispatcher)**

    `lib/sms/twilio.ts` + `lib/sms/dispatch.ts`. Tries SMS first; on failure (carrier reject, 21612, 21408) falls back to WhatsApp via `TWILIO_WHATSAPP_FROM`. Same dispatcher used by the voice agent for customer quote SMS.

-   SMS09 DONE

    **Test harness built**

    `simulate-sms-conversation.mjs` POSTs Twilio-shaped requests with valid signatures, plus state-inspector and Twilio-message-checker scripts. New `test-sms-parity.mjs` runs 70 pure-function assertions against the SMS Agent (customer SMS shape, tradie notify, quality gate, dialog schema, assumption rules).

-   SMS10 DONE

    **Twilio webhook wired + Vercel deployed**

    Twilio's Messaging webhook for +61 481 613 464 points at `https://quote-mate-rho.vercel.app/api/sms/inbound`. Real-phone end-to-end verified — customer receives Haiku reply, then full quote SMS with HTML quote page link + Stripe deposit.

### Phase 2 — The AI brain (DONE)

Static placeholder replaced with intelligent dialog. Hardened against off-topic chat and missing-field finishes.

-   SMS04 DONE

    **Assumption-rules spec per "easy 5" job type**

    `lib/sms/assumptions.ts` — per-job `safeDefaults`, `mustAsk`, `inspectionTriggers` for downlights / GPOs / fans / smoke alarms / outdoor lighting. Plus `UNIVERSAL_INSPECTION_TRIGGERS` (burning smell, sparks, switchboard, etc.) and `UNIVERSAL_MUST_ASK` (name, suburb, job\_type — voice-parity).

-   SMS05 DONE

    **Dialog turn handler (Claude Haiku 4.5) — hardened**

    `lib/sms/dialog.ts`. One Haiku call per inbound. Returns Zod-validated `{action, job_type_guess, reply_to_send, assumptions_made, ready_for_intake}`. 8-step decision guide: inspection trigger → off-topic redirect → no job\_type → out-of-scope job → name → suburb → per-job mustAsk → finish. Capped at 4 turns. Reply hard-limited to 320 chars.

-   SMS06 full DONE

    **Replace static reply with dialog agent**

    Dialog agent wired in. Conversation status routes: `open` (mid-dialog) → `structuring` (finish, intake fires) → `done` (escalate or completed). Assumptions accumulate on the conversation row so the intake agent sees them in the stitched transcript.

### Phase 3 — Quote drafts from SMS (DONE)

SMS conversations now produce the same Good/Better/Best quote the voice path produces.

-   SMS08 DONE

    **Made intake/structure channel-agnostic**

    `app/api/intake/structure/route.ts` accepts a discriminated-union body: `{callId}` (voice) or `{conversationId, sourceChannel: 'sms'}` (SMS). SMS branch loads `sms_conversations` + `sms_messages`, stitches a transcript, prepends accumulated assumptions, and aggregates MMS photo URLs. Everything downstream is unchanged — same Opus 4.7 vision call, same embedding, same quality gate.

-   handoff DONE

    **SMS-to-quote handoff wired**

    When dialog returns `finish`, fire-and-forget POST to `/api/intake/structure` with the conversation ID. Intake structures it → embedding → estimation → quote row → Stripe sessions → customer SMS via `buildQuoteSms` with link to `/q/[token]`. Identical to the voice path from there.

### Phase 4 — Notify / cleanup / photos (DONE)

Tradie notification on draft, daily abandoned-conversation sweep, and inbound MMS photo support.

-   notify DONE

    **Tradie SMS + WhatsApp ping on SMS-sourced draft completion**

    End of `/api/estimate/draft` — gated on `isSmsSource` (so voice path is unchanged). Sends both an SMS (with WhatsApp fallback) to `TRADIE_NOTIFY_NUMBER` AND an explicit WhatsApp message to `TRADIE_NOTIFY_WHATSAPP`. Two flavours: `buildTradieDraftNotification` for auto-quotes, `buildTradieInspectionNotification` for $199 site-visit jobs.

-   cleanup DONE

    **Auto-archive abandoned conversations after 24h**

    Daily Vercel Cron (`vercel.json`, schedule `0 17 * * *` UTC) hits `/api/cron/sms-cleanup`. Sweeps `sms_conversations` where `status=open` AND `last_message_at < now()-24h` → marks `abandoned`. Bearer-secured via `CRON_SECRET` in production.

-   photos DONE

    **Dual-source photo support (MMS + upload-link)**

    Two surfaces: (1) **MMS attachments** via `lib/sms/mms.ts` persist to `sms_messages.photo_urls` (migration 003). (2) **Upload-link photos** via the dialog agent's `buildPhotoRequestSms` dispatch persist to `sms_conversations.photo_urls` (migration 005). Both are aggregated and de-duplicated in the intake/structure SMS branch and fed to the same Opus vision call.

✓ Verified end-to-end

Real phone tested 2026-05-06. Inbound text → dialog asks name → suburb → per-job questions → finish. Customer receives quote SMS with full Good/Better/Best breakdown and clickable HTML quote page. WABA-registered WhatsApp fallback works when SMS rejects.

Beyond the SOP · **Hardening + parity additions**

## Things the SMS Agent does that weren't in the original SOP.

During the build we found and fixed several latent bugs and added parity surfaces beyond what the SOP scoped. All shipped, all tested.

✓

#### Idempotency on inbound MessageSid

Route checks for an existing `sms_messages` row with the same `twilio_message_sid` and acks 200 immediately if found. Plus a partial unique index (migration 004) catches the racy concurrent-retry case. Eliminates duplicate-reply bugs from any external retry source.

✓

#### Fast-ack via after()

Inbound route returns 200 in <500ms regardless of Haiku latency. All heavy work (Haiku, dispatch, outbound persist, conversation update, intake handoff) runs in `next/server` `after()`. Twilio never times out → never retries → never causes duplicates.

✓

#### Universal must-ask (name, suburb, job\_type)

Dialog agent enforces these three fields are captured before `finish`. Mirrors the voice receptionist's opening sequence (name → suburb → classify job). Without these the intake's quality gate would fire and short-circuit the quote.

✓

#### Off-topic / unrelated chat handling

Customer sends "hey" or "do you do plumbing?" — agent acknowledges in one phrase and pivots to the next missing required field. Never engages with weather, jokes, other-trade questions. Greeting alone no longer escalates to a $199 site visit.

✓

#### Single-thread customer UX

Customer-facing quote SMS for SMS-sourced jobs is sent _from_ `TWILIO_SMS_NUMBER` (the same number the customer texted) so it lands in the same conversation thread on their phone — not a second thread on the voice line. Voice-sourced quotes still use the voice number.

✓

#### Empty-intake callback respects channel

When the quality gate fires on an SMS-sourced intake, the callback-request SMS also originates from `TWILIO_SMS_NUMBER` so the customer doesn't see a stray message on a different number.

✓

#### Mocked tier photos on /q/\[token\]

`lib/quote/tier-photos.ts` — per-(job\_type, tier) image + caption. Renders a 16:9 hero on every Good/Better/Best card with an "Indicative · {label}" chip overlay. Drop-in path documented for swapping to real on-site photos.

✓

#### SCOPE line uses contractual wording

Customer SMS SCOPE line preference flipped to use the first sentence of `scope_of_works` (the rich, contractual paraphrase) over `scope_short`. Matches the format Jon expects.

✓

#### Parity self-test harness

`scripts/test-sms-parity.mjs` — 70 pure-function assertions covering customer SMS shape (auto + inspection), tradie notify, callback SMS, quality gate, assumption rules, dialog schema. Runs offline, no network. `npx tsx` compatible.

✓

#### Onboarding bundle spec

`onboarding-bundle.html` — formal spec for adding any new trade as a 5-component bundle. Electrical mapped to its current shipped code. Plumbing sketched as worked example. Six-edit checklist for adding a trade. [Read it →](onboarding-bundle.html)

✓

#### Photo-request SMS — voice-parity

**NEW THIS WEEK.** SMS Agent now mirrors the voice agent's `send_sms_photo_link`: every conversation gets a fresh `photo_request_token` on creation; once dialog identifies an easy-5 job\_type, the route fires `buildPhotoRequestSms` with `${'${APP_URL}'}/upload/${'${token}'}`. `/upload/[token]` resolves both calls and sms\_conversations. Stamps `photo_request_sent_at` so it never re-sends.

✓

#### Dual-source photo aggregation

**NEW THIS WEEK.** SMS-sourced intakes feed Opus vision a deduplicated union of `sms_messages.photo_urls` (MMS attachments) AND `sms_conversations.photo_urls` (uploaded via the photo-request link). Customer can use either path — text the photo, tap the link, or both.

✓

#### First-turn intro + gratitude

**NEW THIS WEEK.** On the customer's very first message Haiku opens with _"G'day, thanks for messaging QuoteMate — I'm the AI quoting assistant…"_ before transitioning to the question. Subsequent turns drop the intro and stay direct. Enforced via Rule 9 in the SYSTEM\_PROMPT plus a turn-marker in the user prompt.

✓

#### Phase 5 migrations live in prod

**SHIPPED 2026-05-06.** Migrations 003 (sms\_messages.photo\_urls), 004 (unique inbound MessageSid index), and 005 (sms\_conversations photo columns) all applied to prod Supabase. Verified at run-time — every required column / index landed. Idempotent re-runs are safe.

Voice Agent · **Quality upgrades (still live)**

## Voice agent is hardened — quotes can't go off-rails.

Multiple defence layers ensure the AI cannot invent prices, hallucinate assemblies, or auto-quote risky scope. Outcomes are tightly bound to what's in the pricing book.

✓

#### Strict grounding on intake + estimation

Every line item must trace back to a row in **shared\_assemblies** or **shared\_materials**. The model literally cannot emit a price out of thin air.

✓

#### DB-grounding validator (4th defence layer)

A runtime validator checks every line item's `source` field against the database. Anything ungrounded is auto-downgraded to the $199 inspection route — no faulty quote reaches the customer.

✓

#### Quality gate on intake

Empty calls or calls with insufficient information no longer trigger downstream photo/quote SMS. Saves Twilio cost and avoids confusing customers with empty drafts. **Now applies to SMS too.**

✓

#### Opus 4.7 on intake structuring

Upgraded from Sonnet to Opus 4.7 for the IntakeSchema extraction step — meaningful quality gain on multi-job calls and ambiguous customer phrasing. Same model used for SMS-sourced intakes.

✓

#### Confidence routing live

Each draft is auto-classified **HIGH / MED / LOW** based on intake completeness. HIGH → tradie sees a clean draft. LOW → automatic inspection upsell.

✓

#### Vapi prompt rebalanced

Receptionist tone improved — more natural, fewer interruptions, faster turn-taking. Same SYSTEM\_PROMPT structure now mirrored on the SMS side (name → suburb → classify → per-job).

Quote Output · **Customer-facing rendering**

## The output side — what the customer actually sees.

Per Jon's priority #5 — the agent produces a real, viewable, mobile-friendly quote that the customer can read and pay a deposit on directly. Same quote whether the source is voice or SMS.

✓

#### Customer-facing quote page

Each draft has its own URL at `/q/[token]` — mobile-friendly HTML page showing scope of works, Good/Better/Best line items, exclusions, assumptions, risk flags, timeframe, GST note, and licence footer. No PDF needed for v1.

✓

#### Stripe Checkout deposit per tier

Each tier has its own "Lock in this option · $X deposit" button → tier-specific Stripe Checkout via `/r/[token]/[tier]` redirect. Webhook confirms payment. Thank-you and cancelled pages handle both flows.

✓

#### Inspection route — $199 pay link

For jobs flagged inspection-only (switchboard, EV charger, fault finding, complex renovations), the page shows a single $199 deposit option to book the inspection. SMS variant suppresses fabricated tier numbers entirely.

✓

#### Mocked tier photos

**NEW THIS WEEK.** Each Good/Better/Best card now renders a 16:9 indicative product image with a captioned chip ("Indicative · Tri-colour dimmable LED"). Tier-coloured backgrounds match the page palette. Drop-in path for real photos documented.

✓

#### Photo upload — camera + gallery

Customer can attach photos via `/upload` route. Supports both phone camera capture and gallery picker. Photos feed into the intake structuring (Opus sees them when extracting scope).

✓

#### Inbound MMS photos (SMS path)

**NEW THIS WEEK.** Customer can MMS a photo as part of their SMS conversation. Twilio media is fetched (Basic auth), stored in `intake-photos` bucket, and the signed URLs flow into `structureIntake` alongside the transcript.

✓

#### WhatsApp fallback for SMS dispatch

When the customer-facing quote SMS fails to deliver (e.g. PH carrier blocks, geo-permission off), the system falls back to WhatsApp via the registered WABA sender. Same dispatcher used for voice and SMS.

✓

#### Single-thread UX on the customer's phone

**NEW THIS WEEK.** SMS-sourced quote SMS originates from `TWILIO_SMS_NUMBER` so the customer sees ONE continuous thread (dialog turns + final quote) rather than two threads on different numbers.

✓

#### Booking flow — customer slot picker

After the customer picks a tier and pays the deposit, the paid page redirects to `/q/[token]/book` where they choose an available time slot. Slots are seeded per-tradie from `scripts/seed-tradie-slots.mjs`; locking a slot fires `/api/q/[token]/book`.

✓

#### Booking confirmations — both sides

On a successful slot lock, the customer receives `buildBookingConfirmationSms` ("you're locked in for Thu 7 May, 9:00am") and the tradie receives `buildTradieBookingNotification` with the customer name, job, and time. Same SMS-first / WhatsApp-fallback dispatcher used elsewhere.

Phase 5 · **Production hardening (deploy steps, no engineering)**

## Deploy prerequisites and post-launch hygiene.

All code is shipped, committed, and would build cleanly today. Phase 5 is the small set of **one-off operational commands** someone needs to run in the production environment (Supabase prod DB + Vercel env vars) so the new features actually function for real customers. No new code, no new features — just "run these commands once".

✓ Phase 5 fully shipped 2026-05-06

All three SQL migrations live in prod Supabase + `CRON_SECRET` set in Vercel Production env + `TRADIE_NOTIFY_NUMBER` + `TRADIE_NOTIFY_WHATSAPP` set in Vercel Production env. Redeployed. SMS Agent is now fully operational for real customers.

-   prod-001 DONE

    **Run migration 003 (sms\_messages.photo\_urls)**

    Applied to prod Supabase 2026-05-06. `photo_urls jsonb default '[]'::jsonb` column verified present. Inbound MMS attachments now persist to `sms_messages.photo_urls` per message.

-   prod-002 DONE

    **Run migration 004 (unique inbound MessageSid index)**

    Applied to prod Supabase 2026-05-06. Partial unique index `sms_messages_unique_inbound_sid_idx` verified present. Concurrent-retry race window now closed at the DB layer.

-   prod-003 DONE

    **Run migration 005 (sms\_conversations photo columns)**

    Applied to prod Supabase 2026-05-06. All four columns verified present: `photo_request_token`, `photo_request_sent_at`, `photos_completed_at`, `photo_urls`. Photo-request SMS feature (voice-parity) is now DB-ready.

-   prod-004 DONE

    **Set CRON\_SECRET in Vercel env**

    Set in Vercel Production env 2026-05-06. Daily Vercel Cron now Bearer-authenticates against `/api/cron/sms-cleanup`. Stale conversations (status=open AND last\_message\_at < now()-24h) get marked `abandoned` automatically every day at 17:00 UTC. Secret never committed to git.

-   prod-005 DONE

    **TRADIE\_NOTIFY\_NUMBER + TRADIE\_NOTIFY\_WHATSAPP set in prod**

    Set in Vercel Production env 2026-05-06 (mirrored from `.env.local` values). Phase 4 tradie notify now fires on every SMS-sourced draft — both an SMS (with WhatsApp fallback) to the tradie's mobile AND an explicit WhatsApp message to the WhatsApp identity. Customer still gets their quote regardless.

-   prod-006 OPTIONAL

    **Promote deposit\_pct to a column on quotes**

    `app/q/[token]/page.tsx:109` has a TODO. Currently hardcoded to 30. Becomes load-bearing only when a tradie wants to ship a different deposit percentage; safe to leave until then.

-   prod-007 OPTIONAL

    **Tenant-scope the pricing\_book lookup**

    `app/q/[token]/page.tsx:86-90` calls `pricing_book.maybeSingle()` with no filter. Fine for the single-tradie pilot, but will pick a random row once a second tradie onboards. Revisit when the second trade goes live.

Timeline · **This week**

## What shipped, in chronological order.

### 2026-05-06 (today) · SMS Agent end-to-end + Phase 5 100% shipped

-   today**Phase 5 fully shipped** — migrations 003 / 004 / 005 applied to prod Supabase + `CRON_SECRET` set in Vercel Production env + `TRADIE_NOTIFY_NUMBER` + `TRADIE_NOTIFY_WHATSAPP` set in Vercel Production env. Redeployed. SMS Agent is fully operational.
-   today**Photo-request SMS parity** — SMS Agent now sends `${'${APP_URL}'}/upload/${'${token}'}` link when easy-5 job\_type is identified, same as voice agent's `send_sms_photo_link`. Migration 005 + token generation + dual-source aggregation in `structureIntake`.
-   today**First-turn intro + gratitude** — Haiku now opens with "G'day, thanks for messaging QuoteMate — I'm the AI quoting assistant…" before the first question. Subsequent turns stay direct.
-   today**Migration 004** — unique partial index on inbound `MessageSid` (defence-in-depth for the duplicate-reply fix)
-   todayInbound route hardened — application-layer idempotency check + fast-ack via `after()` + `maxDuration=60` + race-loser `23505` handling
-   today**Mocked tier photos** — `lib/quote/tier-photos.ts` + `TierCard` hero on `/q/[token]`
-   today**Onboarding bundle spec** — `public/docs/onboarding-bundle.html`
-   todaySCOPE line in customer SMS now uses first sentence of `scope_of_works` (matches Jon's expected format)
-   todayEmpty-intake callback SMS now uses `TWILIO_SMS_NUMBER` for SMS-sourced intakes
-   todayCustomer-facing quote SMS originates from `TWILIO_SMS_NUMBER` for SMS-sourced quotes (single-thread UX)
-   todayDialog SYSTEM\_PROMPT hardened — universal must-ask (name, suburb), 8-step decision guide, off-topic redirect, no-greeting-as-escalate
-   todayParity self-test harness — `scripts/test-sms-parity.mjs` with 70 assertions, all passing
-   todayReal-phone smoke test passed end-to-end

### Earlier this week · Phase 2/3/4 ship-fest

-   earlier**Phase 4 / photos** — `lib/sms/mms.ts` + migration 003 + inbound route MMS extraction
-   earlier**Phase 4 / cleanup** — `/api/cron/sms-cleanup` + `vercel.json` daily schedule
-   earlier**Phase 4 / notify** — tradie SMS+WhatsApp ping gated on `isSmsSource`; `buildTradieDraftNotification` + `buildTradieInspectionNotification`
-   earlier**Phase 3 / SMS08** — `app/api/intake/structure/route.ts` made channel-agnostic via discriminated-union body
-   earlier**Phase 3 / handoff** — inbound route fires `/api/intake/structure` on `finish`
-   earlier**Phase 2 / SMS05** — `lib/sms/dialog.ts` Haiku 4.5 turn handler
-   earlier**Phase 2 / SMS04** — `lib/sms/assumptions.ts` per-job rules + universal triggers
-   earlierWABA sender +1 555 941 5397 ("NomanuAI") registered for production WhatsApp

### Pre-existing · Voice agent + output (still live)

-   earlierDB-grounding validator (4th defence layer) — ungrounded prices auto-downgrade to $199 inspection
-   earlierInspection-route $199 pay link wired through Stripe Checkout
-   earlierStrict grounding on intake + estimation prompts
-   earlierPhoto upload supports camera + gallery picker
-   earlierQuality gate on intake — empty calls no longer trigger downstream SMS
-   earlierPer-tier Stripe Checkout deposit links in quote SMS + webhook + thank-you/cancelled pages
-   earlierWhatsApp fallback when SMS rejects (PH carrier compatibility)
-   earlier`maxDuration` bumped to 300s on Sonnet+Opus routes

Known issues · **Honesty about what's resolved + what isn't**

## Status of every blocker from last week.

✓

#### WhatsApp Sandbox blocker — RESOLVED

The Twilio account now has a registered WABA sender (+1 555 941 5397, "NomanuAI"). Outbound WhatsApp confirmed working. Error `63015` no longer fires.

✓

#### Real phone has now received a message — RESOLVED

2026-05-06 smoke test: customer texted +61 481 613 464 → Haiku replied → quote SMS received with full G/B/B breakdown and clickable HTML quote page. End-to-end working.

✓

#### Phase 2 dialog brain — RESOLVED

Haiku 4.5 dialog agent live and hardened. Off-topic chat, missing-name finishes, inspection-trigger escalation all handled. First-turn intro + gratitude shipped today.

✓

#### Phase 5 SQL migrations — RESOLVED

Migrations 003 / 004 / 005 applied to prod Supabase 2026-05-06. Verified at run-time — all required columns + indexes landed. SMS Agent's photo-request, MMS persistence, and duplicate-reply protection are now DB-ready.

✓

#### SMS Agent doesn't ask for photos — RESOLVED

Was a real gap until today. SMS Agent now mirrors the voice receptionist: when easy-5 job\_type is identified, dialog dispatches a photo-upload SMS with `${'${APP_URL}'}/upload/${'${token}'}`. Customer can use the link OR attach via MMS — both surfaces aggregate into Opus vision.

✓

#### Vercel Production env fully configured — RESOLVED

2026-05-06: `CRON_SECRET`, `TRADIE_NOTIFY_NUMBER`, and `TRADIE_NOTIFY_WHATSAPP` all set in Vercel Production env and redeployed. Daily abandoned-conversation cron is armed; tradie notify fires on every SMS-sourced draft. Phase 5 fully shipped.

○

#### AU→PH SMS not enabled (environmental)

Error `21612` still applies for AU→PH testing. Twilio Console toggle, not a code change. Doesn't block AU customers — they're AU phones. Leave off until international expansion.

## What's next.

SMS Agent is fully shipped — all five phases live in prod, verified end-to-end, no outstanding ops items. Next focus: onboard the second tradie using the bundle spec, then run the eval framework against 100 hold-out intake → quote pairs before the first paying customer.

[SMS Engineering walkthrough →](sms-sop.html) [Onboarding bundle spec →](onboarding-bundle.html) [Full build guide →](build-guide.html) [Architecture →](architecture.html)

QuoteMate · weekly progress · last updated **2026-05-06** · pairs with [sms-sop.html](sms-sop.html), [onboarding-bundle.html](onboarding-bundle.html), [stage1-05-sop.html](stage1-05-sop.html), [stage6-10-sop.html](stage6-10-sop.html)
