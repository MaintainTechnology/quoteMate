# wireframe

_Converted from `wireframe.html`._

---

  QuoteMate — Architecture Wireframe

Q

QuoteMate / Architecture

v2 — synced 2026-04-27

High-Level Design · Architecture · Build Options

# From a homeowner's call to a _booked job._

This page lays out QuoteMate's full High-Level Design — every stage from the customer's first call to the calendar booking, and the technology that powers each. It also surfaces three build paths so you can decide which slice ships first.

10stages

End-to-end journey

4agents

AI orchestration

3options

Build paths

~6weeks

Lean v1 timeline

[→ problem & value](#problem) [→ high-level design](#hld) [→ component list](#layers) [→ system diagram](#diagram) [→ build options](#options) [→ hard parts](#hard-parts) [→ reference flows](#detail) [→ risks & verdict](#risks)

## Why this exists.

Tradies don't lose money on jobs — they lose it between jobs. This page is built around relieving exactly that pain, for the customer who actually pays for it.

The Pain

Quoting eats the evening.

Every owner-operator tradie loses 5–10 hours a week to admin: missed calls during jobs, scribbled notes on coffee cups, Sunday-night quote writing in Word, ghosted email threads, and free site visits to jobs that never close. The work is done in their unpaid hours.

~30–50% of quotes never become work · industry average

The Fix

AI between the call and the contract.

QuoteMate answers the phone, asks the right job-specific questions, captures photos via SMS, drafts a structured quote, routes it for review, and presents it to the customer with one-tap accept and deposit. Confidence routing decides whether to auto-send, ask the tradie to validate, or trigger a paid site visit.

10 stages · 4 agents · end-to-end automation

The Win

More jobs, fewer unpaid hours.

Tradies reclaim evenings, win more quotes (faster + more professional), stop driving to free site visits (the $199 fee filters tire-kickers), and look like a premium business — which lets them charge accordingly. For most, one extra job a month covers the subscription.

$99/mo + 1% on deposits · ~$199 ARPU · 95% gross margin

Who buys this.

Three ICP segments,
one wedge.

Solo operator

1 person · $80k–$250k/yr
5–15 quotes / week
Low software comfort
→ price-sensitive · churn risk

Small crew · TARGET

2–5 people · $300k–$1.5M/yr
10–30 quotes / week
Owner still on tools
→ pain + budget · best fit

Established small business

5+ people · $1.5M+/yr
20–50 quotes / week
Already on ServiceM8 / AroFlo
→ high switching cost

## The journey, end to end.

Ten stages, drawn the way the customer experiences them. The right column shows the technology you'd use at each stage and the phase tag indicates when it's recommended to ship.

01

Origin

Customer / Homeowner

A homeowner has a real-world job — leaking tap, repaint, fence repair — and reaches for their phone.

Channel External user all phases

02

Inbound

Calls dedicated AI phone number

Dials the tradie's QuoteMate-provisioned number — answered immediately, no voicemail, no hold music.

Alternative entry path (v1): existing-platform enquiry from hipages or Airtasker lands in the Tradie Portal — the rest of the flow continues identically from step 04.

Stack Twilio AU long code · per tradie v3 — voice tier

03

Voice intake

AI Receptionist (Voice Agent)

Captures everything needed for a quote, in a natural conversation:

-   Job type (electrical, plumbing, carpentry, landscaping, fencing, etc.)
-   Structured Q&A — job-specific prompts
-   Photos / video via SMS link (optional)
-   Address + access constraints
-   Urgency + budget signals

Stack Vapi orchestration · Deepgram STT · ElevenLabs TTS · Claude Haiku (routing) · Twilio MMS for photo links v3 — premium tier v1 fallback: typed intake form

04

Structuring

Intake Engine

Turns the call (or form) into clean, structured data the Estimation Engine can act on:

-   Scope assumptions
-   Measurements
-   Risk flags
-   Confidence score: LOW / MEDIUM / HIGH

Stack Claude Sonnet + vision (photo analysis) · pgvector for similar-job lookup · address geocoding v1

05

Pricing

Estimation Engine

Produces a real, sendable quote:

-   Scope of works
-   Visuals (where applicable)
-   Labour + materials line items
-   Risks / exclusions

Stack Claude Opus 4.7 · tool-use (lookup\_assembly, lookup\_material, apply\_markup, flag\_inspection) · per-tradie pricing book + 5 similar past quotes (RAG) · prompt cache > 90% hit rate v1 — the heart

06

Routing

Workflow Decision · Confidence-Based Routing

Routes the quote based on the confidence score from the Intake Engine. Three paths — and which paths are enabled depends on which build option you pick.

Logic Rule-based + Haiku sanity check v1

High Confidence

Auto Quote

-   Sent DIRECT to customer
-   Good / Better / Best options
-   No tradie review
-   caution: AU Consumer Law — auto-sent quotes are binding

Medium-High

Tradie Validation

-   Quick tradie review
-   Then sent to customer
-   Target: < 3 min editing
-   v1 default · liability shield

Lower / Complex

Paid Site Inspection

-   Indicative estimate first
-   $199 inspection fee
-   Refundable on quote accepted
-   Tradie attends + completes quote

Routing modes 3 paths — phase-tagged v1: MED + LOW v3: HIGH (auto)

07

Customer view

Good / Better / Best Quote Experience

What the customer actually opens on their phone:

-   Visual, clean, mobile-first
-   Clear inclusions / exclusions
-   Upsells embedded (Better → Best ladder)
-   Accept + deposit button

Stack Next.js mobile portal · react-pdf · shadcn/ui · Stripe Element · token-protected URL v1

08

Conversion · NEW STEP

⚡ Availability Nudge

Especially for high-confidence jobs — surfaces a real, calendar-backed opportunity to lock in:

-   "We've had a spot open up this week"
-   "We can fit this in sooner than expected"
-   "If you lock this in today, we can prioritise your job"

→ Creates real urgency · positions tradie as in-demand but available · encourages fast acceptance.

Stack Vercel Workflow timer · Calendar API read · Haiku for tone · in-portal banner + SMS v3

09

Recovery

Follow-Up Engine

Catches the quotes that don't accept on day 1:

-   SMS reminders (Day 1 / Day 3 / Day 7)
-   Objection handling
-   Reinforces availability ("last spot this week")
-   Pauses on customer reply → handoff to tradie

Stack Twilio SMS · Vercel Workflow (durable timing) · Haiku for personalisation v3

10

Outcome

Job Won

-   Booked into tradie's calendar (auto-block)
-   Deposit captured (Stripe Connect)
-   CRM updated
-   Tradie push-notified · customer confirmed

Stack Calendar API write · Stripe webhook · CRM / Xero integration v1: calendar + deposit v3+: CRM / Xero

## Components, by layer.

Read top-to-bottom: customers and tradies enter the system, traverse the application + agent layer, and resolve into data, payments, and communications. The deferred layer (v3) shows what's planned but not yet building.

01 Customer entry v1 / external

Existing-platform enquiry

hipages • Airtasker • Word-of-mouth

Direct quote-link click

Tokenised public URL — no auth

Phone call (deferred · v3)

Vapi-routed AU number per tradie

02 Client surfaces v1

Tradie portal

Next.js App Router • mobile-first PWA

Customer quote view

Public, token-protected • Good/Better/Best

On-site capture (mobile)

Voice memo + photo prompts during inspections

Quote PDF

react-pdf server-side • branded per tradie

03 AI agent layer (the four) v1

① Quote Drafter

Opus 4.7 • tool-use • RAG over pricing book

② Quote Reviewer

Haiku (annotations) + Sonnet (cover note)

③ Inspection Coordinator

State machine + Sonnet vision (on-site capture)

④ Conversion Engine

Haiku + Vercel Workflow (durable timing)

04 LLM infrastructure v1

Vercel AI Gateway

Failover • cost tracking • observability

Claude Opus 4.7

Heavy reasoning (Quote Drafter, on-site capture)

Claude Haiku 4.5

Routing, annotations, follow-up SMS personalisation

Prompt cache

System + per-tradie pricing book = ~$0.05/quote

05 Data plane v1

Supabase Postgres

Multi-tenant via RLS from day 1

Pricing books (versioned)

Per-tradie overlay + shared assembly library

pgvector

RAG over similar past quotes

Supabase Storage

Job photos, inspection photos, branding assets

Supabase Auth

Magic-link for tradies • no auth for customers

06 Payments Stripe AU

Stripe Connect Express

Per-tradie account • platform fee on each charge

Deposit on accept

PaymentIntent → tradie account → calendar block

$199 inspection fee

Refunded automatically on job-won

Stripe Tax / GST

10% AU GST handling • per-tradie ABN

07 Communications v1

Twilio (AU long codes)

Photo capture links • follow-up SMS sequence

Resend

Quote delivery email • receipts • notifications

Calendar integration

Google + iCloud — auto-block on accept

08 Observability & ops v1

PostHog

Product analytics • session replay • funnel

Sentry

Error tracking • Stripe webhook failures

Eval harness

100 hold-out (intake → quote) pairs • 5-dim rubric

Vercel Workflow / Inngest

Durable retries for follow-ups, refunds, webhooks

09 Deferred — v3+ not yet building

Voice receptionist (Vapi)

Per-tradie phone number • dual-consent recording

Deepgram STT

Nova-3 conversational • AU English locale

ElevenLabs TTS

AU-accent voice clone

hipages partnership

Direct enquiry-to-QuoteMate handoff

Xero / MYOB sync

Pricing-book ingestion + invoice writeback

Bunnings / Inspirations price refresh

Weekly commodity price sync

## The system, drawn.

Same nine layers, rendered as a connected diagram. Solid arrows are runtime calls; dashed arrows are async/event flows. The amber-bordered box is the application boundary running on Vercel. The dashed grey region at the bottom is deferred.

quotemate / v1 / portal-first / electrical-nsw 1280 × 1080

01 / ENTRY CUSTOMER Existing-platform enquiry hipages · Airtasker · referral Direct quote-link click tokenised public URL · no auth TRADIE Mobile portal (PWA) drafts · review · approve · send On-site capture voice memo + photo prompts 02 / APPLICATION · NEXT.JS ON VERCEL VERCEL BOUNDARY · App Router · Server Actions · Edge Customer quote view /q/\[token\] · public · mobile-first Good · Better · Best accept + deposit (Stripe Element) Tradie portal /app · auth · mobile-first intake · review · send · calendar operates all 4 agents below 03 / AI AGENT LAYER (THE FOUR) · sequential left → right ① QUOTE DRAFTER Drafts scope, line items, three options, exclusions Model · Claude Opus 4.7 Tools · lookup\_assembly, lookup\_material, markup, flag\_inspection Reads · pricing book + 5 similar past quotes (RAG) ~$0.05 / quote (cached) ② QUOTE REVIEWER Surfaces draft to tradie with "check this" annotations Model · Haiku (annotations) Sonnet (cover note) Output · approved quote + customer portal page + react-pdf document v1: human-in-loop · no auto-send ③ INSPECTION COORD. Paid site visit + on-site capture + post-acceptance State · pending · paid · scheduled on-site · completed · refunded Captures · voice memo, photos, measurements + risks Conditional · only when complex $199 fee · refundable on win ④ CONVERSION ENGINE Availability nudges + SMS follow-up sequence Cadence · Day 1 · Day 3 · Day 7 Triggers · time + state + calendar Pause · on customer reply Backed by · Vercel Workflow Output · SMS via Twilio durable · survives restarts BACKEND SERVICE BUS · routed via App Router server actions 04 / LLM 05 / DATA 06 / PAYMENTS 07 / COMMS LLM INFRASTRUCTURE Vercel AI Gateway failover · cost tracking Claude Opus 4.7 heavy reasoning · vision Claude Haiku 4.5 routing · annotations · SMS prompt cache · > 90% hit rate DATA PLANE · SUPABASE Postgres + RLS organizations · pricing\_books quotes · line\_items · inspections pgvector RAG over similar past quotes Storage photos · branding · PDFs Auth · magic link tradies only PAYMENTS · STRIPE AU Stripe Connect Express per-tradie account · platform fee Deposit on accept ~20% · webhook → calendar $199 inspection fee refunded automatically on win Stripe Tax (GST) 10% · per-tradie ABN COMMUNICATIONS Twilio (AU long codes) photo links · follow-ups · status Resend quote delivery · receipts Calendar integration Google + iCloud · auto-block Stripe webhooks durable retries · Vercel Workflow 08 / OBSERVABILITY & OPS PostHog · Sentry · Eval harness · Vercel Workflow PostHog — funnel + session replay (tradie drop-off) Sentry — error spikes · Stripe webhook failures Eval — 100 hold-out (intake → quote) pairs · 5-dim rubric 09 / DEFERRED · v3+ Vapi voice agent · Deepgram · ElevenLabs · hipages · Xero/MYOB · Bunnings Voice — premium tier @ $299/mo (per-call cost destroys $99/mo SaaS pricing) hipages — direct enquiry-to-quote handoff (v3 partnership) Trade expansion — landscaping + carpentry (Phase 4) · plumb/elec (v3) view + accept login · review intake submit · server action publish quote ↓ tool-use ↓ RAG · CRUD ↓ charge · refund ↓ SMS · email LEGEND runtime call conditional / async service bus AI agent LLM data payments comms customer tradie deferred (v3) Vercel Each agent column (1–4) stacks above its primary backend service. The grey bus represents server-action routing — every agent can call every backend service.

## Key flows, called out.

Four scenarios that span the whole stack. Each is what a single user action triggers, end to end.

01 / STANDARD QUOTE

Tradie → AI draft → customer accept

-   Tradie types intake on mobile portal
-   Quote Drafter (Opus) reads pricing book + RAG
-   Tradie reviews, adjusts one price, hits send
-   Customer opens token URL, picks Better, taps accept
-   Stripe Connect deposit → tradie account, calendar blocked

02 / INSPECTION BRANCH

Complex job → paid site visit → re-draft

-   Drafter calls flag\_inspection → routes to Coordinator
-   Customer pays $199 (Stripe Connect) → slot booked
-   On-site: tradie speaks notes, snaps prompted photos
-   Sonnet vision structures the capture → re-runs Drafter
-   On accept: $199 auto-refunded, deposit replaces it

03 / FOLLOW-UP SEQUENCE

No accept → SMS cadence

-   Vercel Workflow holds the durable timer
-   Day 1 — gentle nudge with viewing link
-   Day 3 — availability nudge if calendar has slots
-   Day 7 — final "still interested?" message
-   Customer replies → pause + handoff to tradie

04 / EVAL HARNESS

Continuous quality measurement

-   100 hold-out (intake → quote) pairs from pilots
-   5-dim rubric: scope, price ±%, line-items, exclusions, calibration
-   Every prompt change → run hold-out → publish delta
-   Per-trade × per-job-type dashboard
-   Drop >5% → revert immediately

## Build options — what to ship first.

The full High-Level Design above is a 12–18 month build. These are three slices that get to revenue, with the tradeoffs of each. Pick the one that matches your runway, risk appetite, and quality bar — then jump to the recommended-path detail below.

Option A

Full vision — voice-first

timeline12–18 months to v1

cogs / tradie~$1,500 / mo

pricing$299 / mo + per-call

riskHIGH

#### Pros

-   Maximum demo wow-factor
-   Voice intake is genuinely differentiating
-   White-glove customer experience from day 1
-   Strongest fundraise pitch story

#### Cons

-   12+ months before first paying customer
-   Voice quality on AU accents is hard
-   Auto-quote = AU Consumer Law liability
-   SaaS economics broken at $99 / mo

Best if you have $2M+ runway and need a defensible fundraise demo before revenue.

Option B

Hybrid — typed v1, voice as v3

timeline6 months to mature v1

cogs / tradie$10 / mo (typed tier)

pricing$99 + $299 voice tier

riskMEDIUM

#### Pros

-   Revenue starts in month 6
-   All HLD branches active (incl. inspection + nudge)
-   Eval data informs voice tier engineering
-   Multi-trade supported (paint, landscape, carpentry)

#### Cons

-   Less impressive at first demo
-   Multi-trade complexity earlier than necessary
-   Voice tier still demands separate engineering

Best if you want a polished v1 with every HLD branch active before you scale.

Option C · recommended

Lean wedge — electrical, NSW

timeline6 weeks to v1

cogs / tradie~$10 / mo

pricing$99 / mo + 1% deposits

riskLOW

#### Pros

-   Fastest path to paying customers
-   Bounded "easy 5" scope (downlights, GPOs, fans, alarms, outdoor) avoids switchboard / fault complexity in v1
-   Eval framework before scaling — measured quality
-   Pricing-book moat compounds from day 1
-   Real customer data informs every later decision

#### Cons

-   Smallest demo wow at first
-   Tradie does manual intake (no voice yet)
-   Availability nudge + follow-up come in v3

Best if you want paying customers first, then expand from validated learning.

## Hard parts — solved.

Five problems where most "AI quoting" tools fall apart. Each card states the problem, the chosen solution, and the specific tools. These are the wiring decisions that determine whether the system works.

01 / AI Quoting Engine

Drafting a quote a tradie would actually send.

The Problem

A generic LLM call hallucinates $180 for a $40 mixer tap. Tradies stop trusting the system after one wrong line item — and the demo never recovers.

The Solution

Force the model to use tools — never let it emit a price from free-form text. RAG over the tradie's own pricing book + the 5 most similar past quotes. Cache the system prompt and pricing book per tradie. Calibrate confidence against a held-out evaluation set so HIGH actually means HIGH.

Tools

Claude Opus 4.7 tool-use API prompt cache > 90% pgvector (RAG) Vercel AI Gateway

02 / Pricing Logic

Where the numbers come from.

The Problem

~70% of owner-operator tradies have no structured price list. Material prices change weekly. Per-trade × per-region × per-tradie variance is huge. There's nothing to "ingest."

The Solution

Build it WITH the tradie, not from. Ship a base assembly library per trade (built by paid 25-year domain experts). Capture the tradie's overlay during 30-min onboarding. Active learning from the first 10 quote edits. Background commodity-price refresh.

Tools

Postgres versioned tables overlay pattern ~$5k / trade consulting guided onboarding flow

03 / User Accounts

Multi-tenant isolation, zero-friction customer auth.

The Problem

Tradies hate passwords. Customers don't want accounts. Every quote must be isolated per tradie organisation without bleeding across tenants. Adding security later is harder than building it in.

The Solution

Magic-link auth for tradies — no passwords. No customer auth at all — quotes go via tokenised public URLs. Postgres RLS from day 1, never bolted on later. Organisations as the tenant primitive; users belong to orgs with roles (owner / staff).

Tools

Supabase Auth Postgres RLS tokenised quote URLs org → users → roles

04 / Payments

Marketplace flow with AU compliance.

The Problem

Tradies own the funds, not QuoteMate. AU GST handling. Two charge types (deposit + inspection fee). Refund automation on job-won. Per-tradie ABN + bank verification at onboarding adds friction.

The Solution

Stripe Connect Express — each tradie owns their account, QuoteMate takes a platform fee. Two charge shapes share the same plumbing. Stripe Tax handles GST. Defer Connect onboarding so tradies can draft quotes immediately and only need it when sending and accepting payment.

Tools

Stripe Connect Express Stripe Tax (GST) Vercel Workflow (webhook retries) deferred Connect onboarding

05 / Site-Inspection Flow

The differentiator that turns a cost into revenue.

The Problem

Tradies waste hours driving to free site visits. Customers haven't paid for a quote before. Once on-site, the tradie has one hand free and needs to capture everything fast. Refund flow on job-won must be automatic and clear.

The Solution

$199 fee filters tire-kickers; refundable on win positions it as low-risk. State machine handles booking → payment → on-site → re-quote → refund. On-site mobile UX is voice-memo + prompted photos (one tap each). Re-runs the Estimation Agent with on-site data.

Tools

state machine (db-backed) Stripe Connect refund Sonnet vision (on-site) Whisper / Deepgram

## If you take Option C — the recommended path in detail.

These are the resulting decisions baked into the lean v1 wedge. If you choose Option A or B instead, several of these flip — especially auto-send, the voice tier, and the wedge trade. Document any switch in docs/strategy.md with a written rationale before changing the locked entries below.

v1 architecture

Portal-first, not voice-first

Voice agent COGS at moderate volume is ~$1,500/mo per tradie — destroys margin at $99/mo SaaS price. Voice ships in v3 as a $299/mo premium tier.

v1 trade

Electrical (NSW first)

Pilot access dominates regulatory simplicity. Pivoted from painting in v3 after operational electrical content (9 job-flow trees, real AU rates) signalled an actual electrician pilot. Per-state licence display (NSW NECA / VIC ESV / QLD QBCC) ships v1. v1 scope is the "easy 5" job types only — switchboards, fault finding, EV chargers are inspection-only routes.

v1 agents

Four — not ten

Quote Drafter, Quote Reviewer, Inspection Coordinator, Conversion Engine. Receptionist agent reserved for v3.

Pricing data

Build with the tradie, not from

~70% of owner-operators have no structured price list. Ship a base assembly library per trade; capture per-tradie overlay in 30-min onboarding.

Auto-send

Off in v1

Australian Consumer Law treats accepted quotes as binding contracts. Tradie human-in-loop is the liability shield.

Quality

Eval harness before prompt iteration

100 hold-out pairs, 5-dim rubric. No prompt change ships without measured delta.

## Risks & feasibility.

Ranked by what'll actually kill the project — not by what sounds scary. Each risk has a mitigation. The verdict at the bottom is the honest read on whether to build it.

01

Price accuracy

severity · existential

If quotes are ±30% off, tradies stop trusting them and churn fast. **Mitigation:** domain-expert-built base library per trade, pricing-book overlay built with each tradie at onboarding, active learning from the first 10 quote edits, and a 5-dimension eval rubric on 100 hold-out quotes before any prompt change ships.

02

AU regulatory + Consumer Law liability

severity · high

Accepted quotes are binding contracts under Australian Consumer Law. An auto-sent wrong quote is a refund/lawsuit risk. **Mitigation:** human-in-loop in v1 (no auto-send), tradie review on every quote, "subject to inspection" language for inspection-flow quotes, solicitor review before launch.

03

Voice quality on AU accents + noisy backgrounds

severity · medium

Customer in a kitchen with screaming kids; tradie answering in a ute on a freeway — STT accuracy collapses. **Mitigation:** defer voice to v3+ premium tier, use Deepgram Nova-3 with custom vocabulary per trade, AU-cloned ElevenLabs voice, SMS handoff for photos to reduce voice complexity.

04

Tradie adoption inertia

severity · medium

Tradies trust word-of-mouth, hate signing up, and abandon SaaS within 30 days if it doesn't fit existing habits. **Mitigation:** founder-led sales for first 20 customers, free 60-day trial, hand-onboard each one, integrate with channels they already use (SMS, phone), referral program after pilot success.

05

Cold-start data problem

severity · low (tractable)

On day 1, the system has no quotes to learn from. **Mitigation:** ship with a base assembly library per trade (built by paid 25-year domain expert) so the first quote is "generic library + tradie's hourly rate" — not a blank page. By quote 50, the per-tradie overlay has compounded enough to be sticky.

Feasibility verdict

Buildable today — the right version of it.

**Yes — Option C (lean wedge) is shippable in 6 weeks of focused engineering.** Every block exists at production grade in 2026: Claude for reasoning, Supabase for tenancy, Stripe Connect for marketplace flow, Vapi for voice (when you're ready). A solo founder + 1 contractor can ship v1.

**No — Option A (full voice-first vision) is a 12–18 month build with destroyed unit economics.** Voice agent COGS at moderate volume is ~$1,500/mo per tradie. That's not a SaaS at $99/mo; it's a fundraise pitch. Build the boring portal version, get 80 electricians paying, then raise on the data and use the money to build voice.

**The single biggest risk to manage:** if you build for the pitch instead of the customer, you'll exhaust runway before you have revenue. The HLD above is the destination; Option C is the path that gets you there with your runway intact.

**QuoteMate** · Architecture wireframe v2 · 2026-04-27
Sources of truth: docs/strategy.md · CLAUDE.md · assets/quotemate\_flow\_with\_inspection.svg · assets/quotemate\_experience\_map.jpeg
Generated via .claude/skills/architecture-diagram · structural conventions adapted; visual language follows maintain.com.au.

portal-first · electrical-nsw · v1
