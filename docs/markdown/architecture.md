# architecture

_Converted from `architecture.html`._

---

  QuoteMate · Architecture · Stages 01 → 05

# QuoteMate _Automation Pipeline_ · Stages 01 → 05

From dialed number to drafted quote. The system, the wiring, and why no glue layer is needed.

Twilio AU Vapi Deepgram nova-2 ElevenLabs Claude Haiku 4.5 · Sonnet 4.6 · Opus 4.7 Voyage voyage-3 Vercel · Next.js Supabase + pgvector Vercel AI SDK

v3+ scope

**Heads-up on alignment.** This diagram describes the **voice-first** pipeline from `docs/build-guide.html`. Per `docs/strategy.md`, v1 is **portal-first** (typed intake) — the AI receptionist is a v3+ premium tier. The good news: **Stages 04 and 05 are stack-identical** for portal and voice. Only Stage 03 changes (typed form replaces Vapi). Build the engines first; plug Vapi in front later.

**01** · The whole pipeline at a glance

## End-to-end data flow.

Top to bottom: a homeowner dials in, the AI has a conversation, the transcript gets structured, and an LLM with deterministic tools writes a draft quote. Every box is a single piece of infrastructure or one Vercel AI SDK call. Every arrow is one HTTP request.

SIP / voice text reply ~10 Hz audio loop POST /api/vapi/webhook end-of-call-report insert fetch /api/intake/structure insert (with embedding) fetch /api/estimate/draft insert 01 Customer / Homeowner mobile · landline "G'day, I need 6 downlights..." Stage 01 — call origination Tradie's QuoteMate-provisioned number Same number 24/7 — no off-hours fallback needed 02 Twilio · AU long code +61 2 XXXX XXXX Local number · voice capability ~$1.50/mo · regulatory bundle Stage 02 — Twilio routes voice → Vapi Twilio's voice webhook is delegated to Vapi at import time. Vapi terminates the call. Identity verification required before purchase 03 Vapi · realtime voice orchestrator streaming audio · sub-second turn-taking · your provider keys (Deepgram, ElevenLabs, Anthropic) plug in here Deepgram nova-2 · en-AU speech → text live transcription ~$0.02 / call Claude Haiku in-call decisions "what to ask next?" job-flow routing · 9 trees ~$0.01 / call ElevenLabs Australian voice text → speech streamed TTS to caller ~$0.10–0.30 / call Vercel · Next.js App Router (serverless functions) app/api/vapi/webhook · app/api/intake/structure · app/api/estimate/draft Each route is ~30 lines. Routes fire-and-forget the next route via fetch — non-blocking handoff. Supabase · calls vapi\_call\_id · transcript · recording\_url · photo\_urls · ended\_at One row per inbound call · the raw record before any AI processing 04 Stage 04 · Intake Engine — Claude Sonnet 4.6 free-form transcript → strict structured JSON · vision-capable for caller photos generateObject + Zod IntakeSchema · 11 job types scope · risks · access · confidence ~$0.02 / call Photo vision input image content blocks photo\_urls from SMS switchboard, ceiling, GPO Voyage embed voyage-3 · 1536 dims summary string → vector for similar-job retrieval Supabase · intakes (pgvector) job\_type · scope · risks · embedding(1536) · inspection\_required · confidence match\_intakes(query\_embedding) returns the 5 most similar past intakes 05 Stage 05 · Estimation Engine — Claude Opus 4.7 · generateText + tools · stopWhen: stepCountIs(10) LLM reasoning + deterministic tool execution. Opus never invents prices — every line item comes from a tool result. Claude Opus 4.7 tool-use loop decides which tool to call next writes G/B/B JSON ~$0.05–0.10 / call lookup\_assembly() → 5 matching assemblies lookup\_material() → 5 matching materials apply\_markup() basePrice × (1 + pct/100) flag\_inspection\_needed() switchboard · EV · faults · reno shared\_assemblies "easy 5" + 4 inspection types shared\_materials downlights · GPOs · fans · RCBOs pricing\_book hourly\_rate · markup · licence\_\* no DB lookup — pure flag Supabase · quotes Good / Better / Best JSONB tiered output scope\_of\_works assumptions\[\] risk\_flags\[\] total\_inc\_gst status: 'draft' LEGEND AI service cloud / infra Supabase table external stage cluster read insert

**02** · Stage-by-stage breakdown

## What runs at each step.

Each card is one stage from the wireframe. Read the diagram above for the wiring; read these cards for what each stage actually does and which tool does the work.

Stage · 01

### Customer call origination

no infrastructure

A homeowner reaches for their phone and dials the tradie's QuoteMate-provisioned number. Same number every day, no after-hours fallback, no IVR menu.

tools

-   customer's mobile / landline

Stage · 02

### Twilio AU number receives

~$1.50/mo + per-minute · ~$0.08/call

Twilio owns the AU local long code. On purchase, its voice webhook is delegated to Vapi via the Vapi dashboard's "Import from Twilio" action — Twilio terminates SIP, hands the audio stream to Vapi.

tools

-   Twilio Console (regulatory bundle)
-   Twilio AU local number (voice cap.)

why local, not 1300

-   homeowners answer local calls; 1300s feel like marketing

Stage · 03

### Vapi runs the conversation

~10Hz loop · ~$0.30–0.55/call

Vapi orchestrates the realtime audio loop: **Deepgram** transcribes incoming audio, **Claude Haiku** reads the transcript and the system prompt to decide what to say next, **ElevenLabs** synthesizes the reply. ~10 cycles per second keeps conversation natural.

On hangup, Vapi POSTs an `end-of-call-report` with the full transcript + recording URL to `/api/vapi/webhook`.

tools

-   Vapi (orchestrator)
-   Deepgram nova-2 (en-AU)
-   Claude Haiku (in-call)
-   ElevenLabs (Australian voice)
-   Vercel API route (webhook receiver)

Stage · 04

### Intake Engine structures

Claude Sonnet 4.6 · ~$0.02/call

Free-form transcript → structured JSON. The Vercel AI SDK's `generateObject` enforces a Zod `IntakeSchema` — Sonnet must produce JSON matching it or the SDK retries. Photos sent via SMS pass through as image content blocks for vision input.

A summary string ("downlights count=6 indoor existing-wiring...") is embedded with Voyage `voyage-3` into a 1536-dim vector and stored in pgvector for similar-job retrieval.

tools

-   Vercel AI SDK `generateObject`
-   Zod schema validation
-   Anthropic (Sonnet 4.6 + vision)
-   Voyage AI (voyage-3 embeddings)
-   Supabase pgvector extension

Stage · 05

### Estimation Engine drafts

Claude Opus 4.7 · ~$0.05–0.10/call

`generateText({ tools, maxSteps: 10 })`. Opus reads the structured intake, then _chooses_ which of four tools to call: `lookup_assembly`, `lookup_material`, `apply_markup`, `flag_inspection_needed`. Tools hit Supabase deterministically; Opus only handles reasoning.

Output is three pricing tiers (Good / Better / Best) as JSONB columns plus indicative ranges for inspection-only routes. Status starts as `'draft'` — never auto-sent.

tools

-   Vercel AI SDK `generateText + tools`
-   4 Zod-typed tool definitions
-   Anthropic Opus 4.7
-   Supabase lookup tables (read)
-   Supabase quotes (write JSONB)

**03** · Database schema

## How the tables relate.

The pipeline tables on the right are written in order: **calls → intakes → quotes → quote\_line\_items**. The lookup tables on the left are read by the Estimator's tools — they aren't written by the pipeline at all (they're seeded by the tradie + a domain expert). Solid arrows are FK relationships; dashed arrows are reads from Stage 05 tools.

LOOKUP TABLES read-only · seeded · per-tradie overrides PIPELINE TABLES written in order, one row per call MATERIALISED created on tier acceptance FK: call\_id FK: intake\_id FK apply\_markup lookup\_assembly lookup\_material pricing\_book hourly\_rate call\_out\_minimum · apprentice\_rate default\_markup\_pct · risk\_buffer\_pct gst\_registered licence\_type · \_state · \_number overlays JSONB (per-tradie) shared\_assemblies trade ('electrical' default) name · description default\_unit · default\_unit\_price\_ex\_gst default\_labour\_hours default\_exclusions seed: install LED downlight, replace double GPO, hardwire smoke alarm... (the "easy 5") shared\_materials trade · name · brand · unit default\_unit\_price\_ex\_gst seed: tri-colour downlight, USB GPO, RCBO, hardwired smoke alarm, sundries... calls id (PK) vapi\_call\_id (unique) caller\_number duration\_seconds · transcript recording\_url photo\_urls JSONB ended\_at · created\_at intakes id (PK) call\_id → calls.id job\_type (enum: 11 types) address · suburb scope · access · property JSONB risks JSONB · inspection\_required caller · timing JSONB confidence · confidence\_reason embedding vector(1536) ← pgvector quotes id (PK) intake\_id → intakes.id status: draft | sent | accepted scope\_of\_works · assumptions\[\] good · better · best (JSONB) risk\_flags\[\] · optional\_upsells\[\] selected\_tier · subtotal\_ex\_gst gst · total\_inc\_gst quote\_line\_items id (PK) quote\_id → quotes.id tier (which G/B/B was accepted) description · quantity · unit unit\_price\_ex\_gst · total\_ex\_gst source: 'assembly:UUID' | ... empty until customer accepts a tier; flattens the chosen JSONB for invoicing

**04** · Why no n8n (or any workflow tool)

## Three architectural reasons.

n8n is an excellent SaaS-glue tool — it shines for "when row added in Sheet → post to Slack → create Trello card." It's the wrong shape for this pipeline. Here's why each of the three core stages defeats it.

WITH n8n GLUE LAYER extra hop · breaks streaming · can't host LLM tool-loops Vapi realtime audio n8n workflow \+ latency · + vendor code node (anyway) Zod / generateObject code node (anyway) tools + stopWhen Supabase finally writes ✗ slower ✗ extra cost WITHOUT n8n — DIRECT CODE PATH (this build) Vapi handles realtime · Vercel routes are 30 lines each · LLM agency lives in code Vapi realtime audio Vercel route · Sonnet generateObject Zod schema enforced · vision · embed Vercel route · Opus generateText + tools stopWhen: stepCountIs(10) · LLM picks tool order Supabase direct insert ✓ clean ✓ testable

REASON · 01

### Stage 03 is sub-second realtime.

Vapi's audio loop runs ~10 cycles per second: `audio chunk → Deepgram → Haiku → ElevenLabs → audio chunk`. n8n is event-batched HTTP — it can't be in a streaming voice loop. **Vapi already _is_ the orchestrator** for this stage; bolting n8n on just intercepts the post-call webhook for no benefit.

streaming · sub-second turn-taking

REASON · 02

### Stage 04 needs schema-enforced output.

The Intake Engine uses `generateObject({ schema: IntakeSchema })` — Sonnet must produce JSON matching a Zod schema, with automatic retries if it doesn't. n8n's HTTP-call-and-parse can't enforce that. The moment you reach for a "code node" inside n8n to do it, **you're writing the same code** — just inside a slower, vendored, harder-to-test environment.

Zod · generateObject · retry-on-mismatch

REASON · 03

### Stage 05 needs LLM tool agency.

`generateText({ tools, stopWhen: stepCountIs(10) })` lets Opus choose which of four tools to call, in which order, based on what the prior tool returned. n8n can chain HTTP calls in a fixed graph, but it **cannot give the LLM agency to pick the next tool mid-loop**. That agency is the whole architectural point — money-touching steps must be tool-calls, never free text.

tool-use loop · stopWhen · LLM-decided routing

where n8n CAN fit

n8n is a fine choice for the **post-quote glue work** — Stages 06+: notify the tradie on Slack when a quote is ready, sync accepted quotes to Xero/MYOB, send follow-up SMS sequences, calendar bookings. Those are CRUD between SaaS apps and exactly n8n's strength. Stages 02–05 are not.

QuoteMate · automation pipeline architecture · references [build-guide.html](build-guide.html) · [strategy.md](strategy.md)
