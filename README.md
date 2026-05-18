# QuoteMate

> AI-powered quoting for trade businesses. Turn a phone call or a photo into a professional quote in minutes — not on Sunday night.

QuoteMate is a mobile-first quoting tool built for residential trade owner-operators (plumbers, electricians, carpenters, painters, landscapers) in the AU/NZ market. It combines an AI receptionist that captures jobs over the phone, an AI engine that drafts professional quotes from the intake, and a customer-facing portal that takes deposits the moment the quote is accepted.

The goal is simple: **reclaim the evenings tradies currently lose to admin, and stop wasting trips on jobs that were never going to convert.**

---

## The problem

Tradies don't lose money on jobs — they lose it *between* jobs:

- Phone tag and notepad chaos while on the tools
- Sunday-night quote writing in Word or Excel
- Re-quoting jobs that ghost (industry average: 30–50% of quotes never become work)
- Driving to free site visits for jobs that were never a real fit
- Customers shopping the quote against two others and never replying

Existing job-management tools (ServiceM8, Tradify, AroFlo) handle scheduling and invoicing well, but the **intake → quote** moment is still mostly manual. QuoteMate is built around that moment.

---

## What QuoteMate does

1. **Captures the job for you** — a dedicated AI receptionist answers the call and asks the right job-specific questions. The moment the call ends, the customer gets an SMS with a one-tap link to add photos — optional, races the quote draft, lifts confidence when it arrives.
2. **Drafts the quote** — an AI engine generates a structured quote (scope, line items, labour, materials, exclusions, risks) using the tradie's own pricing book and prior quote history.
3. **Routes by confidence** — high-confidence jobs go straight to the customer; medium ones wait for a quick tradie review; complex ones trigger a paid site inspection.
4. **Sends a polished customer experience** — mobile-first, branded quote with Good / Better / Best options and a one-tap deposit button.
5. **Closes the loop** — availability nudges, SMS follow-ups, calendar booking on accept.

---

## How it works

### Two flows, one engine

QuoteMate routes every job into one of two paths based on whether the tradie can quote it remotely.

**Standard flow** — the tradie reviews the AI-drafted quote, edits if needed, sends it to the customer, and the customer accepts and pays a deposit through the portal. The flow ends with the job confirmed and on the calendar.

**Inspection flow** — when remote scoping isn't enough, the tradie creates a paid site-visit request. The customer pays a $199 inspection fee (refundable on accepted quote), the tradie attends in person, then completes the full quote in QuoteMate before rejoining the standard send/accept/deposit path.

The full flow is mapped here:

![QuoteMate flow with inspection branch](assets/quotemate_flow_with_inspection.svg)

### The "wow moment" experience

The customer-facing experience is designed around one outcome — the call ends with the customer feeling they're already in good hands, and the tradie wakes up the next morning to a draft they only need to tweak.

![QuoteMate experience map](assets/quotemate_experience_map.jpeg)

### High-level architecture

```
Customer call
   ↓
AI Receptionist (voice agent)
   ↓
Intake Engine        → scope, photos, address, urgency, confidence score
   ↓
Estimation Engine    → scope of works + labour + materials + risks
   ↓
Confidence-based routing
   ├─ HIGH:    auto-quote sent to customer
   ├─ MEDIUM:  tradie validates, then sends
   └─ LOW:     paid site-visit triggered
   ↓
Mobile customer portal (Good / Better / Best + deposit)
   ↓
Availability nudge → Follow-up engine → Job won → Calendar + CRM
```

---

## Key features

| Area | What it does |
|---|---|
| **AI receptionist** | Always-answered phone line per tradie; structured job-specific Q&A; SMS photo capture mid-call |
| **AI quote engine** | Drafts scope, line items, labour, materials, risks from the intake; uses the tradie's own pricing book |
| **Confidence routing** | Automatically decides whether to auto-quote, ask for tradie review, or trigger a paid inspection |
| **Paid site-inspection** | $199 refundable fee filters tire-kickers and pays for trips that don't convert |
| **Mobile customer portal** | Branded, mobile-first quote view with Good / Better / Best and one-tap deposit |
| **Availability nudge** | "We've had a spot open up this week" — creates urgency on high-intent quotes |
| **Follow-up engine** | SMS sequence with objection handling on quotes that haven't converted |
| **Pricing book** | Per-tradie material catalogues, labour rates, and assemblies — versioned so old quotes stay accurate |

---

## Tech stack

What's actually wired today:

| Layer | Choice |
|---|---|
| Frontend + API | Next.js 16 (App Router, React 19) — Vercel (prod) / Railway (Docker) |
| Auth, DB, storage | Supabase (Postgres 17 + pgvector), PKCE auth, `intake-photos` storage |
| LLM | Anthropic Claude via the Vercel AI SDK — Opus 4.7 for intake + estimation, Sonnet 4.6 for SMS dialog |
| Vision | Claude vision (job photos) |
| Image gen | Google Gemini (quote preview + per-tier sample images) |
| Voice agent | Vapi (Deepgram STT, ElevenLabs TTS) — **live** |
| SMS / WhatsApp | Twilio (AU long codes), SMS-first with WhatsApp fallback |
| Payments | Stripe (test mode); per-tier deposit + $199 inspection. Connect Express: planned |
| Email | Resend |
| Quote document | Mobile HTML page at `/q/[token]` (no PDF in v1) |

Planned but not yet wired: Stripe Connect Express (marketplace fund-split), PostHog analytics, Sentry error tracking, the eval framework.

---

## Project status

**Built and running** (as of 2026-05-18). The application lives in [`quotemate-automation/`](quotemate-automation/); the repo root holds planning docs and design assets.

- **Voice and SMS intake are both live end-to-end** — a customer calls or texts a tradie's QuoteMate number, the AI captures the job, Opus drafts a Good/Better/Best quote grounded strictly in that trade's pricing book, and the customer gets a mobile quote page with a Stripe deposit (or a $199 inspection for complex jobs).
- **Multi-trade is live**: electrical (NSW) and plumbing (QLD) run on the same platform, with 5 pilot tenants active.
- Current work: self-serve tradie onboarding (auto-provisioned number, pricing book, and AI brand voice per tradie).
- Production: `quote-mate-rho.vercel.app`. Payments run in Stripe test mode.

For the full engineering picture see [`CLAUDE.md`](CLAUDE.md); for the strategy and decision history see [`docs/strategy.md`](docs/strategy.md).

Planning artifacts in [`assets/`](assets/):
- `quotemate_experience_map.jpeg` — the customer + tradie wow-moment journey
- `quotemate_flow_with_inspection.svg` — the standard and inspection flows side by side

---

## Roadmap

Originally planned as five phases to a paid pilot launch. Where the build actually landed:

| Phase | Focus | Status |
|---|---|---|
| **0 — Validate** | Customer interviews, $199 inspection-fee pricing test, pre-sell pilots | Done |
| **1 — Tradie portal MVP** | Intake, AI quote draft, customer portal, Stripe deposit | Done |
| **2 — Pricing intelligence + inspection** | Per-trade pricing book, RAG, confidence routing, paid site-visit, Good/Better/Best | Done |
| **3 — Voice intake** | Vapi receptionist, per-trade prompts, SMS photo capture, post-call draft | Done (shipped earlier than planned) |
| **3b — SMS intake** | Full SMS quoting agent, parity with voice path | Done |
| **5 — Multi-trade + onboarding** | Plumbing alongside electrical; self-serve tradie onboarding | In progress (multi-trade live; onboarding building) |
| **4 — Conversion engine** | Availability nudge, follow-up sequence, calendar, CRM | Partial (tradie notify + booking live; follow-up sequence not yet) |
| Hardening | Stripe Connect Express, eval framework, multi-tenant RLS | Not yet started |

**Initial wedge:** **electrical (NSW, residential)** — joined by **plumbing (Brisbane, residential)** in v5 (2026-05-11). Two parallel single-trade pilots keep each pricing book + assembly library focused before going broad. v1 scope is the "easy 5" auto-quoteable job types per trade:

- **Electrical:** downlights, GPOs, ceiling fans, smoke alarms, outdoor / deck lighting. Switchboards, fault finding, EV chargers, underground cabling, and complex renovations are inspection-route only.
- **Plumbing:** blocked drain, hot water, tap repair, tap replace, toilet repair, toilet replace. Gas fitting, burst pipe, and bathroom renovation are inspection-route only.

Per-state license display (NECA for NSW electrical, QBCC for QLD plumbing; ESV reserved for VIC) is shipped Phase 1. See [`docs/strategy.md`](docs/strategy.md) v3 entry for the painting → electrical pivot and v5 entry for the multi-trade expansion.

---

## Repository structure

```
.
├── README.md                  # this file
├── CLAUDE.md                  # engineering context (the accurate source of truth)
├── LICENSE                    # MIT
├── assets/                    # experience map + flow SVG + logo
├── docs/                      # strategy, build guide, SOPs, progress, wireframe
├── .claude/                   # vendored skills / agents / commands
└── quotemate-automation/      # ◀── the application (Next.js 16)
    ├── app/                   #   App Router pages + /api routes
    ├── lib/                   #   estimate, intake, sms, preview, routing, onboard, …
    ├── sql/                   #   schema + migrations
    ├── scripts/               #   ops / diagnostic tooling
    └── …                      #   Dockerfile, railway.json, vercel.json, tests
```

---

## License

MIT — see [LICENSE](LICENSE).
