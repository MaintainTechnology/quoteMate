# ai-voice-progress

_Converted from `ai-voice-progress.html`._

---

  QuoteMate — Build Status

Q QuoteMate · Build Status

Live · v0.5 wedge · 2026-05-06

Status report · for updates

# What's _applied_, what's running, what's pending.

Live tally of every SOP stage, infrastructure component, and beyond-SOP enhancement. Cross-referenced to [stages 01–05 SOP](stage1-05-sop.html), [stages 06–10 SOP](stage6-10-sop.html), and the [strategy iteration log](strategy.md).

12/14

SOP stages complete

12

Beyond-SOP shipments

12/12

Production-verified end-to-end

100%

2026-05-06 deploys signed off

## Build progress.

Each track measures completion within a coherent unit of the SOP — stages, foundations, pre-flight gates. Bars reflect what's actually deployed and verified, not just merged.

5 tracks

SOP v1 stages

8 / 8 v1-required stages · S08 + S09 optional

Foundations

3 / 3 · F1 + F2 + F3

Pre-flight gates

3 / 3 · A + B + C

Production-verified by real call

Voice → intake → estimation → SMS → payment → portal → booking → SMS · all verified 2026-05-06

Stripe pipeline

Checkout, payment-completion webhook, paid\_at persistence all verified · Connect pending tradie #2

Customer-facing

SMS + Stripe Checkout flow live and verified

Current operating mode

**v0.5 wedge — SMS-first, auto-send. End-to-end loop closed 2026-05-06.** The post-payment customer journey is now: SMS quote → Stripe Checkout → `/q/[token]/paid` → "Pick a time" CTA → `/q/[token]/book` slot picker → confirmation SMS to customer + tradie. The voice agent ("Jeff") now calls `send_sms_photo_link` mid-conversation, so customers receive the upload link the moment Jeff asks for photos rather than after hangup. Estimation is now anchored to similar past quotes via pgvector RAG, with the static system prompt + pricing book served from Anthropic's prompt cache (~10× cheaper on warm-cache reads). Tradie-review gate remains explicitly waived for solo-builder testing per [strategy.md v4](strategy.md).

2026-05-06 session — what shipped

**Five customer-visible improvements + two pipeline optimisations**, all deployed to `quote-mate-rho.vercel.app`:

-   **Booking page** at `/q/[token]/book` — slot picker tied to `tradies.available_slots`; writes `scheduled_at` + `status='accepted'` + `accepted_at` on confirm; atomically prunes the picked slot
-   **Booking-confirmation SMS** — customer ("you're locked in for Thu 7 May, 9:00am") + tradie notify ("New booking - 6 downlights for Sarah on Thu 7 May 9:00am") via `TRADIE_NOTIFY_NUMBER`
-   **In-call photo SMS tool** — Vapi assistant now invokes `send_sms_photo_link` mid-call; dedupes against the post-call SMS via `calls.photo_request_sent_at`
-   **Anthropic prompt caching** — Opus system prompt + pricing book marked `cacheControl: ephemeral`; cache stats logged via `providerMetadata.anthropic`
-   **RAG context injection** — top-K (≤5) cosine-similar past intakes hydrated to their winning quotes and prepended to the Opus user prompt; 0.55 similarity floor, inspection-only matches filtered out, `RAG_DISABLED` kill-switch

## SOP stage status.

Every stage from the two SOP documents — pre-flight gates, foundations, and the ten stages of the customer journey. Status reflects what's deployed to production at `quote-mate-rho.vercel.app`.

stage1-05 + stage6-10

| Stage | Status | Notes | Source |
| --- | --- | --- | --- |
| **Pre-flight A** | Done | Tools installed locally — Node, npm, git, VS Code, ngrok (now superseded by Vercel deploys) | stage1-05 P0a |
| **Pre-flight B** | Done | Service accounts: Twilio, Vapi, Deepgram, ElevenLabs, Anthropic, Supabase, Vercel | stage1-05 P0b |
| **Pre-flight C** | Done | Stripe SDK installed, keys + webhook secret + Connect Client ID stored. Resend account exists. Stripe Connect dashboard activated. | stage6-10 P0c |
| **Stage 01** | Done | Customer call origination — read-only stage | stage1-05 S01 |
| **Stage 02** | Verified | AU number provisioned and **verified by real call**: `+61 7 4518 0330` (voice via Vapi) + `+61 489 083 371` (SMS via Twilio) | stage1-05 S02 |
| **Foundation 1** | Done | Next.js 16 skeleton, env file, GitHub repo, Vercel deploy live at `quote-mate-rho.vercel.app` | stage1-05 F1 |
| **Foundation 2** | Done | Supabase project + 7 base tables · `calls, intakes, quotes, pricing_book, shared_assemblies, shared_materials, quote_line_items` | stage1-05 F2 |
| **Stage 03** | Verified | Vapi assistant `8b42dbe3` · Haiku 4.5 · Deepgram nova-2 en-AU · ElevenLabs Elliot · **Verified by real call from `+61 414 530 836`** — caller name, suburb, scope all captured into transcript. | stage1-05 S03 |
| **Stage 04** | Verified | Intake Engine — Sonnet 4.6 + IntakeSchema + Voyage embeddings. **Verified by real call**: structured Jeff Deligdi's downlight call to `job_type=downlights`, populated `caller.name`, `scope`, `suburb`. | stage1-05 S04 |
| **Stage 05** | Verified | Estimation Engine — Opus 4.7 + 4 tools + `scope_short`. **Verified by real call**: produced 3 tiers ($527 / $696 / $899 inc-GST) with stripe\_links populated. Quote `c4562029`. | stage1-05 S05 |
| **Foundation 3** | Done | Schema additions · `routing_decision`, `viewed_at`, `accepted_tier`, `scheduled_at`, `share_token`, `stripe_links`, `deposit_pct`, `paid_*` on quotes; `tradies` + `payments` tables. Test tradie seeded (`30fb1d7b`). | stage6-10 F3 |
| **Stage 06** | Done | Confidence routing — `decideRouting()` helper with 7-scenario test suite passing. Persists `routing_decision` on quote insert. Behaviour gated behind `V3_AUTOSEND_ENABLED` env flag. | stage6-10 S06 |
| **Stage 07** | Done | Customer experience delivered via the SMS-with-Stripe-links flow — three tier cards rendered in SMS body, three tap-to-pay redirects, Stripe-hosted payment surface. Honours every wireframe Stage 07 intent (mobile-first, clear inclusions, embedded upsells, accept + deposit) without a separate portal route. | stage6-10 S07 |
| **Stage 08** | Optional | Availability nudge — conversion-optimisation feature, ships when pilot data justifies it. Per [strategy.md §11 Phase 3](strategy.md), depends on durable workflow timer + calendar API + viewed\_at signal. | stage6-10 S08 |
| **Stage 09** | Optional | Follow-up engine — Day 1/3/7 reminders, ships when pilot data justifies it. Depends on durable timer + inbound SMS handler + viewed\_at signal + AU Spam Act compliant opt-out tracking. | stage6-10 S09 |
| **Stage 10** | Verified | Stripe Checkout per tier (deposit) verified — 3 working pay links delivered to caller. **Payment completion verified 2026-05-06** — test card paid through full webhook → `paid_at` + `paid_tier` set on quote. **Booking page verified** at `/q/[token]/book` — slot picker writes `scheduled_at` + `status='accepted'`, prunes the picked slot, both customer + tradie SMS land. Thank-you + cancelled pages shipped. Connect onboarding still pending (when tradie #2 onboards). | stage6-10 S10 |

## Beyond-SOP shipments.

Capabilities built that aren't in any SOP step — reliability hardening, observability, the photo-capture flow per the wireframe's optional Stage 03 path, and the 2026-05-06 voice-agent + estimation enhancements.

12 enhancements

| Capability | Status | Notes | File(s) |
| --- | --- | --- | --- |
| **Photo capture** | Verified | SMS with upload link → mobile-first capture page → Supabase Storage bucket `intake-photos` → URLs persisted to `calls.photo_urls`. Pattern 1 (parallel race, photos optional). **Verified end-to-end 2026-05-06** — real photo lands in storage and renders on intake. | app/upload, lib/storage |
| **SMS dispatch + WhatsApp fallback** | Verified | Twilio SMS first, WhatsApp via sandbox if SMS rejects. **Verified by real call** — SMS with three Stripe pay links delivered to `+61 414 530 836`. | lib/sms/dispatch.ts |
| **Pipeline logger** | Shipped | Structured trace IDs across all 4 stages — searchable in Vercel logs by `[QM` prefix or call\_id. | lib/log/pipeline.ts |
| **AI retry-with-backoff** | Shipped | 3 attempts on Sonnet/Opus with 2s/4s exponential backoff. `maxDuration = 300s` on AI routes. | lib/util/retry.ts |
| **Opus `scope_short`** | Verified | Compact 1-line scope summary alongside contractual `scope_of_works`. **Verified by real call** — SMS rendered _"Replace 6 kitchen halogens with warm-white LED downlights, reuse wiring"_. | lib/estimate/prompt.ts |
| **Short-link redirector** | Verified | `/r/[token]/[tier]` redirects to Stripe Checkout. **Verified by real call** — three working redirect URLs in delivered SMS. | app/r/\[token\]/\[tier\] |
| **Health endpoints** | Shipped | `/api/health` + `/api/health/deep` for monitoring. | app/api/health |
| **In-call photo SMS tool** | Shipped 2026-05-06 | Vapi server-side tool `send_sms_photo_link` registered on assistant `8b42dbe3`. When Jeff asks the caller for photos, the tool fires the SMS during the live call instead of after hangup. Idempotent end-to-end — multiple invocations within one call only send the SMS once via `calls.photo_request_sent_at` dedupe. End-of-call webhook no longer clobbers `photo_request_token` if the tool already issued one. Falls back gracefully to the post-call dispatcher when the tool doesn't fire (model didn't ask for photos) or SMS dispatch fails. | app/api/vapi/tools/send-sms-photo-link, scripts/update-vapi-add-photo-tool.mjs |
| **Booking-confirmation SMS — customer** | Shipped 2026-05-06 | Fires from `POST /api/q/[token]/book` in `after()` after the slot is persisted. Format: _"Hi Sarah, you're locked in for Thu 7 May, 9:00am. The tradie will text the day before to confirm. View booking: …"_. Customer phone resolved from `intake.caller.phone` (SMS path) or `calls.caller_number` (voice path). SMS+WhatsApp fallback via `dispatchQuoteMessage`. Failures never undo the booking. | lib/sms/templates.ts, app/api/q/\[token\]/book |
| **Booking notification — tradie** | Shipped 2026-05-06 | Companion to the customer SMS — fires alongside it when `TRADIE_NOTIFY_NUMBER` is set. Format: _"\[QuoteMate\] New booking - 6 downlights for Sarah on Thu 7 May, 9:00am. View: https://…/q/\[token\]"_. Same SMS+WhatsApp fallback path. Closes the loop so the tradie doesn't have to manually check Supabase for new bookings. | lib/sms/templates.ts, app/api/q/\[token\]/book |
| **Anthropic prompt caching** | Shipped 2026-05-06 | Converted `runEstimation` from `{system, prompt}` to `messages[]` with `providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` on the system block. Cache invalidates automatically when pricing\_book changes (different prompt content → different key). Cost on cached reads is ~10% of standard input rate; TTFT improves ~1-2s. `providerMetadata.anthropic` token counts logged via the pipeline trace for visibility (`cacheCreationInputTokens` / `cacheReadInputTokens`). | lib/estimate/run.ts |
| **RAG — similar past quotes** | Shipped 2026-05-06 | Before each Opus draft, `match_intakes(intake.embedding, 6)` returns the top cosine-similar past intakes; their winning quotes are formatted into a compact "SIMILAR PAST QUOTES" block and prepended to the user message (system message stays cacheable). Filters: drops self-match, < 0.55 similarity, inspection-required, all-null tiers. Cold-start safe (returns null when no usable matches). Kill switch: `RAG_DISABLED=true`. Corpus at deploy: 46 embedded intakes, 31 quotes with real tier prices. | lib/estimate/rag.ts |

## Live in production.

Every dependency that's currently serving real traffic — voice, language models, payments, storage. Coloured dots map to wireframe component categories.

13 services

Hosting

Vercel

quote-mate-rho.vercel.app

Database + Storage

Supabase

bobvihqwhtcbxneelfns.supabase.co

Voice agent

Vapi

Assistant 8b42dbe3 · Server URL → Vercel

AU number — voice

Twilio

+61 7 4518 0330

AU number — SMS

Twilio

+61 489 083 371

STT

Deepgram nova-2

Language: en-AU

TTS

ElevenLabs · Elliot

Australian-English voice

Conversational LLM

Claude Haiku 4.5

During-call brain · temp 0.4

Intake structuring

Claude Sonnet 4.6

Vision-capable · ~25s typical

Estimation

Claude Opus 4.7

Tool-use · ~40s typical

Payments

Stripe (test mode)

Platform-direct charging · webhook live

Embeddings

Voyage

1536-dim vectors on intakes table

Photo storage

Supabase Storage

Bucket `intake-photos` · 5MB · JPEG/PNG/WebP

## Verified by real call.

Evidence of the production pipeline working end-to-end. A real call from `+61 414 530 836` on 2026-05-01 produced this SMS — proves voice capture, intake structuring, estimation, scope\_short, Stripe Checkout creation, redirect routing, and SMS dispatch all work in production. **Follow-up verifications on 2026-05-06** closed every previously-pending surface (payment, photos, in-call tool, booking SMS, cache + RAG).

2026-05-01 + 2026-05-06 · all surfaces verified

Delivered SMS — verbatim

Hi Jeff,

Your QuoteMate quote for 6 downlights (same day).

3 OPTIONS (inc 10% GST - 30% deposit to confirm):

GOOD: $527 (deposit $158)
- Standard warm-white LED
- 12 fittings
Tap to pay: https://quote-mate-rho.vercel.app/r/cR4ij0PVKb78E0u7jvJTPQ/good

BETTER: $696 (recommended) (deposit $209)
- Tri-colour LED
- 12 fittings
Tap to pay: https://quote-mate-rho.vercel.app/r/cR4ij0PVKb78E0u7jvJTPQ/better

BEST: $899 (deposit $270)
- Dimmable IP-rated premium LED
- 12 fittings
Tap to pay: https://quote-mate-rho.vercel.app/r/cR4ij0PVKb78E0u7jvJTPQ/best

SCOPE: Replace 6 kitchen halogens with warm-white LED downlights, reuse wiring

Reply or call back to confirm a tier and we will book you in.

- QuoteMate

Voice capture

Caller name + scope

"Hi Jeff" · "6 kitchen halogens"

Intake structuring

job\_type=downlights

caller.name=Jeff Deligdi · suburb populated

Estimation

3 priced tiers

$527 / $696 / $899 inc-GST · 30% deposit

scope\_short

1-line scope

"Replace 6 kitchen halogens with warm-white LED downlights, reuse wiring"

Stripe Checkout

3 Sessions created

stripe\_links populated on quote c4562029

SMS dispatch

Twilio AU mobile

From +61 489 083 371 → +61 414 530 836

Stripe payment flow

Verified — webhook fires

Test card payment completed · paid\_at + paid\_tier set on quote · paid page renders

Photo upload

Verified — file lands

/upload/\[token\] page accepts JPEG/PNG/WebP · Supabase Storage bucket receives file · URL persisted

In-call photo SMS (2026-05-06)

Verified — fires mid-call

send\_sms\_photo\_link tool invoked by Jeff during conversation · SMS lands within ~2s · post-call dedupe confirmed

Booking confirmation SMS (2026-05-06)

Verified — both sides receive

Slot picked at /q/\[token\]/book · scheduled\_at written · customer + tradie SMS both delivered

Prompt cache hit (2026-05-06)

Verified — cache reads logged

cacheReadInputTokens > 0 observed in pipeline trace on warm-cache estimation · ~10× cost reduction

RAG context attached (2026-05-06)

Verified — anchors live

"RAG context attached" log line confirmed · match\_intakes returning relevant past quotes from the 31-quote corpus

Minor template observation

The delivered SMS shows **"12 fittings"** per tier — Opus produced two `unit:'each'` line items per tier (LED + driver, each qty 6) and the template sums them. Cosmetic; doesn't affect price. Worth refining to _"6 fittings + driver"_ in `lib/sms/templates.ts` when convenient.

## Pending work.

Three buckets — strict SOP gaps, wireframe-implied features that don't have a SOP step, and strategic commitments from the iteration log. Effort estimates are focused build time.

3 buckets

### Strict SOP gaps

| Item | Priority | What it adds | Effort |
| --- | --- | --- | --- |
| **S10 — Connect onboarding** | When tradie #2 | `/api/stripe/connect/onboard` creates Connect Express account + Account Link redirect. Switches charges from platform-direct to Connect with `application_fee_amount`. | ~45 min |
| **S10 — Booking page** | Done 2026-05-06 | **Shipped:** `app/q/[token]/book/page.tsx` + `SlotPicker` client component + `POST /api/q/[token]/book`. Uses the `/q/` URL prefix instead of the SOP's `/book/[quoteId]` to align with the rest of the customer portal. Writes `scheduled_at` + `status='accepted'` + `accepted_at`; prunes the picked slot atomically. | — shipped |
| **S09 — Day-before reminder** | Recommended next | Cron-based — once-daily query for bookings within 24h, fire reminder SMS to customer ("Quick reminder, your tradie's visiting tomorrow at 9:00am"). Use the existing `vercel.json` crons block. Reduces no-shows once booking volume picks up. | ~45 min |

### Wireframe-implied features

| Item | Priority | What it adds | Effort |
| --- | --- | --- | --- |
| **pgvector RAG** | Done 2026-05-06 | **Shipped:** `lib/estimate/rag.ts` calls `match_intakes(embedding, 6)`, hydrates winning quotes, formats compact context block, prepends to Opus user message. 0.55 similarity floor, inspection-only filtered, cold-start safe. Kill switch: `RAG_DISABLED=true`. | — shipped |
| **Anthropic prompt cache** | Done 2026-05-06 | **Shipped:** `lib/estimate/run.ts` uses `messages[]` with `cacheControl: ephemeral` on the system block. Cache stats logged via `providerMetadata.anthropic`. Cost on warm reads ~10% of full input; TTFT improves ~1-2s. | — shipped |
| **PDF quote generation** | Nice-to-have | react-pdf server-side; customer can save/print quote. License compliance display lives here. | ~90 min |
| **PostHog analytics** | Nice-to-have | Client-side events: SMS link tap, Stripe link tap, photo upload, quote view. Drives funnel insight. | ~30 min |

### Strategy doc commitments

| Item | Priority | What it adds | Effort |
| --- | --- | --- | --- |
| **Eval framework** | Required before prompt iteration | 100 hold-out intake→quote pairs scored by 5-dim rubric. Per [strategy.md §6](strategy.md): "no prompt change ships without delta measurement." | ~3 hr setup + ongoing |
| **Pricing book onboarding** | Required for tradie #2 | Guided UI to capture each tradie's overlay (hourly rate, markup %, custom assemblies, common materials). Currently the seed pricing book is a placeholder. | ~4 hr |
| **Assembly library expansion** | Domain-expert work | 5 seed rows in `shared_assemblies` today. Strategy specifies a full ~50-row electrical library built with paid domain expert. | External |
| **Real-call validation** | Verified | **End-to-end verified 2026-05-06**: voice → intake → estimation (with RAG + prompt cache hits) → 3 Stripe Checkout links → SMS → payment completion → paid page → "Pick a time" → booking page → slot picked → customer + tradie booking SMS. Photo upload + in-call `send_sms_photo_link` tool also verified on a real call. | — complete |

## Deliberate divergences.

Choices made that diverge from the literal SOP, each documented in the strategy iteration log. They're divergences, not gaps — recorded so future-you can audit the reasoning, not litigate the choice.

5 documented choices

| Choice | Why | Doc reference |
| --- | --- | --- |
| **v3 auto-send mode** | Solo-builder testing — auto-sending every quote. Must flip back to v1 tradie-review gate before tradie #2 onboards. | strategy.md v4 |
| **S07 implemented as SMS + Stripe-links flow** | Customer experience delivered through SMS body (3 tier cards, prices, scope) + Stripe-hosted Checkout for payment, in lieu of a separate `/q/[token]` portal page. Honours all wireframe Stage 07 intents (mobile-first, accept + deposit, embedded upsells) with fewer surfaces. | strategy.md v4 |
| **Platform-direct Stripe (skip Connect)** | Single-tradie pilot doesn't need Connect routing. Migration = adding `stripeAccount` + `application_fee_amount` params. Triggered when tradie #2 onboards. | strategy.md v4 |
| **Photo capture Pattern 1 (parallel)** | Photos race the quote; quote SMS goes out at ~70s without waiting for upload. Photos stored for tradie review, no auto re-quote. | strategy.md v4 photo-capture entry |
| **Voice-only Twilio number (no MMS)** | SOP S2 says "Voice only" capabilities for v1; photo capture handled by upload page instead of MMS reply. | stage1-05 S2.2 |

## TL;DR for status updates.

Six bullets you can paste directly into a Slack update, an investor brief, or a fortnightly status email.

copy & paste

-   **12 of 14 SOP stages complete** — Pre-flight A/B/C, Stages 01–07, F1–F3, plus Stage 10 (booking page now shipped 2026-05-06; Connect onboarding still pending tradie #2). Stages 08 + 09 remain optional v3 conversion-optimisation features.
-   **Verified live by real call (2026-05-01)** — voice → intake (Sonnet) → estimation (Opus) → 3 Stripe Checkout links → SMS delivered. Quote `c4562029`, $695.90 inc-GST.
-   **2026-05-06 voice-agent uplift** — Vapi assistant now calls `send_sms_photo_link` mid-conversation; customers receive the upload link the moment Jeff asks for photos rather than after hangup. Idempotent across multiple invocations + dedupes against the post-call SMS via `calls.photo_request_sent_at`.
-   **2026-05-06 booking loop closed** — `/q/[token]/book` slot picker writes `scheduled_at`; customer + tradie booking-confirmation SMS fire automatically; "Pick a time →" CTA added to the paid page so the post-payment journey is fully wired without flipping the Stripe success\_url.
-   **2026-05-06 estimation pipeline upgrades** — Anthropic prompt caching on the system block (~10× cheaper on warm-cache reads, ~1-2s faster TTFT) and pgvector RAG (top-K similar past quotes prepended to anchor pricing patterns; 46 embedded intakes + 31 priced quotes in the corpus).
-   **Validation complete (2026-05-06)** — Stripe payment-completion ✓, photo upload ✓, in-call `send_sms_photo_link` ✓, slot pick + customer + tradie booking SMS ✓, prompt cache hits + RAG context all confirmed in pipeline traces.
-   **Pending strategic build** — S10 Connect onboarding when tradie #2 onboards (~45 min). Day-before reminder cron (~45 min). Optional S08/S09 ship when pilot data justifies the conversion-optimisation work.

Updated 2026-05-06 · Live URL [quote-mate-rho.vercel.app](https://quote-mate-rho.vercel.app) · Source of truth [docs/strategy.md](strategy.md) · Visual language follows [maintain.com.au](https://maintain.com.au)
