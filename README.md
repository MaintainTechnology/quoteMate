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

1. **Captures the job for you** — a dedicated AI receptionist answers the call, asks the right job-specific questions, and pulls photos via SMS while the customer is still on the line.
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

## Planned tech stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js (App Router) on Vercel |
| Auth, DB, storage, RLS | Supabase (Postgres + pgvector) |
| Background workflows | Vercel Workflow (WDK) |
| LLM | Anthropic Claude (Opus for reasoning, Haiku for low-latency routing) via Vercel AI Gateway |
| Vision | Claude vision (job photos) |
| Voice agent | Vapi (Deepgram STT, ElevenLabs TTS) |
| SMS | Twilio (AU long codes) |
| Payments | Stripe AU + Stripe Connect Express |
| Email | Resend |
| Analytics | PostHog |
| Errors | Sentry |
| PDF | react-pdf / Puppeteer |

---

## Project status

**Greenfield.** The repository currently contains the project brief, design assets, and this README. No application code has been written yet.

Planning artifacts in [`assets/`](assets/):
- `quotemate_experience_map.jpeg` — the customer + tradie wow-moment journey
- `quotemate_flow_with_inspection.svg` — the standard and inspection flows side by side

---

## Roadmap

The build is planned in five phases over roughly six months to a paid launch with a small cohort of pilot tradies.

| Phase | Focus | Exit criterion |
|---|---|---|
| **0 — Validate** (2 wks) | Customer interviews, pricing-test on the $199 inspection fee, pre-sell pilots | ≥5 paid pilot commitments |
| **1 — Tradie portal MVP** (4 wks) | Manual intake, AI quote draft, customer portal, Stripe deposit. *No voice agent yet.* | 3 pilot tradies, ≥5 real quotes each, ≥1 paid |
| **2 — Pricing intelligence + inspection** (4 wks) | Pricing-book ingestion, RAG, confidence scoring, paid site-visit flow, Good / Better / Best | Avg tradie editing time < 3 min/quote |
| **3 — Voice intake** (6 wks) | Vapi receptionist, per-trade prompts, mid-call SMS photo capture, post-call quote draft | 80% of calls produce a quote draft sent with < 5 min editing |
| **4 — Conversion engine** (4 wks) | Availability nudge, SMS follow-up, calendar integration, basic CRM | +15% win-rate lift vs Phase 3 baseline |
| **5 — Launch** | 50 tradies in the wedge segment, high-touch onboarding, second trade added | — |

**Initial wedge:** plumbing OR electrical, residential, AU. Single trade keeps the pricing book + assembly library focused before going broad.

---

## Repository structure

```
.
├── README.md                  # this file
├── LICENSE                    # MIT
├── .gitignore
└── assets/
    ├── quotemate_experience_map.jpeg
    └── quotemate_flow_with_inspection.svg
```

Application code will be added under `app/`, `lib/`, `components/`, and `supabase/` as Phase 1 begins.

---

## License

MIT — see [LICENSE](LICENSE).
