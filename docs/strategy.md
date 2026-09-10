# QuoteMax — Strategy & Re-evaluation

> **Current iteration: v24 (2026-09-08).** v24 restores an explicit human approval gate for all newly drafted customer quotes as required by the SMS reliability audit implementation contract.  v1 trade pivoted from **painting** to **electrical** in v3; v5 expanded to **multi-trade** (electrical + plumbing); v10 added roofing; v11 added **commercial painting**; v12 extended **solar** to Path B auto-send; v13–v15 refined roofing structure/source gates; v16–v20 converged residential trades on a pay-first flat **$99 refundable site visit**; v17–v18 recorded the LLM receptionist and its route-level trade boundaries; v21 moved residential painting to auto-release; v22 replaced v3's blanket EV-charger inspection rule with a narrow, tenant-enabled, tradie-reviewed single-phase pricing path; **v23 carries the job past the paid $99 site visit — final quote, deposit (less the $99 credit) and balance each on their own linked `quotes` row, with the 2% platform fee charged on top so the tradie nets the quoted price.** The prose in §1–§12 below is the v2 painting analysis, kept as audit-log record. See [Iteration history](#iteration-history) at the bottom for the full v3–v24 rationale.

> Status: living document. Each iteration sharpens the analysis against the project assets and prior reasoning.

This document supersedes the initial chat-based analysis. It is written to be honest about what was shallow or wrong before, and to give the project a more grounded plan.

---

## 1. What the prior analysis got wrong (or shallow)

| # | Prior position | Why it was wrong / thin | Corrected view |
|---|---|---|---|
| 1 | Treated the voice-first AI receptionist as the obvious v1 architecture | Conflated two distinct product visions: the SVG (portal-first, tradie-typed intake from existing-platform enquiries) and the high-level design (voice-first AI receptionist). Different cost structures, different moats, different timelines. | Voice-first is the eventual product. Portal-first is the v1 you should actually build. See §2. |
| 2 | "Ingest the tradie's pricing book via RAG" | Most owner-operator tradies have **no structured pricing book**. They quote from memory + gut markup. There's nothing to ingest. | Ship a base assembly library per trade (built by paid domain experts), and capture the tradie's overlay through a guided 30-minute onboarding. See §3. |
| 3 | No unit economics computed | Without numbers, the architecture choice is fashion-driven. Voice-first economics are brutal (~$1,500/mo COGS per tradie at moderate call volume). Portal-first is ~$10/mo COGS. | Pricing model has to match architecture. Subscription pricing only works for portal-first. Voice-first needs per-call or premium tier. See §4. |
| 4 | 10-agent architecture | YAGNI. Many of the agents are sub-functions, not standalone reasoning units. | 4 agents for v1: Quote Drafter, Quote Reviewer, Inspection Coordinator, Conversion Engine. See §5. |
| 5 | "Use RAG over past quotes" — no eval framework | If you can't measure quote quality, you can't iterate on it. Every prompt change is blind. | Build the eval harness in week 1: 100 hold-out (intake → quote) pairs, scored by rubric. See §6. |
| 6 | "Start with plumbing or electrical" | Wrong on regulatory grounds. Plumbing is licensed per-state with QBCC/PIC/VBA requirements; electrical needs licensed-electrician details on every quote. Both are high-friction wedges. | Start with painting (no licensing in most AU states), then landscaping, then carpentry. See §7. |
| 7 | No GTM plan | "Build it and they will come" is not a strategy. | Founder-led sales for first 20, then trade Facebook groups, then hipages partnership conversation. See §8. |
| 8 | "Pricing knowledge base is the moat" — said but not explained | Doesn't articulate *how* the moat compounds, which means it can't be told to investors. | Per-tradie data lock-in: each correction calibrates the system; switching = losing the calibration. See §9. |
| 9 | Treated the experience-map metrics (91% / 87% / 94% / 83%) as validated | Those are **prototype-cohort numbers** from 5 tradies. Signal, not proof. | Treat as directional. Real validation is paid pilots that don't churn at month 2. |
| 10 | Glossed AU regulatory layer | Mentioned ABN/GST in passing; never reckoned with the per-trade implications. | Trade choice, license display, ACL binding-quote risk, and recording consent all materially shape the product. See §7 and §10. |

---

## 2. The strategic question that was dodged: voice-first vs portal-first

Your two reference assets describe two different products:

- **`quotemate_flow_with_inspection.svg`**: customer enters via existing platform (hipages, Airtasker) → tradie opens QuoteMax → tradie *types* the job details → AI drafts quote. This is **portal-first**.
- **High-level design (in your prompt)**: customer dials the tradie's QuoteMax-provisioned number → AI receptionist captures everything → tradie wakes up to a draft. This is **voice-first**.

These are not the same product. They differ on:

| Dimension | Portal-first | Voice-first |
|---|---|---|
| Time to v1 | 4–6 weeks | 12–16 weeks |
| COGS per tradie/mo | ~$10 | ~$1,500 (at ~30 calls/day × 4 min) |
| Tradie adoption friction | Moderate (open another app) | High (give up phone-number control) |
| Demo "wow" | Lower | Higher |
| Defensibility | Pricing book accuracy | Pricing book + intake quality |
| Pricing model that fits | $99/mo flat | $299/mo or $0.50/min metered |
| Failure mode if it goes wrong | Tradie ignores draft | Customer hangs up on AI |

**The honest call:** voice-first is the impressive demo and the right north star. Portal-first is what you should actually ship to v1. Voice gets added in v3 as a premium tier. If you build voice-first first, you will burn 12 weeks before you have a paying customer and the unit economics won't justify the SaaS price you'd need to charge.

> **Decision:** v1 is portal-first. Voice agent is deferred to v3 (~month 7).

---

## 3. Pricing data — the real strategy

The core architectural assumption in any AI quoting tool is "we have access to the tradie's prices." Reality check:

- ~70% of AU owner-operator tradies do not maintain a structured price list
- The remaining ~30% have it in a spreadsheet, in their head, in old PDF quotes, or in Xero invoice line items
- Even when a price list exists, it's stale — material prices move 5–15% per year on commodity items

**The real strategy is to build the pricing book *with* the tradie, not from them.**

### How

1. **Hire a domain expert per trade.** A 30-year painter, a 25-year landscaper. ~$5k of consulting per trade for a base assembly library: 50–80 most common assemblies (e.g. "interior wall — prep, prime, two coats, low VOC") with default unit prices, default labour, default exclusions.

2. **Onboarding produces a per-tradie overlay.** A 30-minute guided flow:
   - Hourly rate for owner / 2IC / apprentice
   - Default markup % on materials
   - Walk through 20 highest-volume assemblies — "what would *you* charge?"
   - Branding (logo, license number, ABN, GST status)

3. **Active learning from the first 5 quotes.** Every edit the tradie makes to an AI draft is a calibration signal. After 5 quotes, the system has the tradie's actual price language and exclusion phrasing.

4. **Background price refresh.** For commodity items (paint, fence palings), scrape Bunnings public pricing weekly. Surface "3 of your prices haven't been updated in 60+ days — verify?" before each quote send.

### Schema implication

```
pricing_books              (per tradie, versioned)
├── overlay_labour         (their hourly rates)
├── overlay_assemblies     (their custom prices on shared assemblies)
├── overlay_materials      (custom material prices / preferred brands)
└── settings               (markup %, GST, branding)

shared_libraries           (per trade, maintained by us)
├── assemblies             (the 50–80 base assemblies)
├── materials              (commodity catalog with refresh dates)
└── exclusion_templates    (standard exclusion language)
```

The Estimation Agent reads from `shared_libraries` first, then applies the tradie's `overlay_*` deltas. This makes cold-start tractable: a new tradie's day-1 quote is "decent base library + their hourly rate" — not "blank page."

---

## 4. Unit economics

### Portal-first v1

**Per-tradie monthly COGS:**

| Item | Cost |
|---|---|
| Quote drafts (Claude Opus, ~$0.05 × 80 quotes/mo with prompt caching) | $4.00 |
| SMS for photo capture (Twilio AU, ~$0.02 × 80) | $1.60 |
| SMS for quote delivery (~$0.04 × 80) | $3.20 |
| Hosting, storage, misc (Vercel + Supabase amortized) | $1.20 |
| **Total COGS** | **~$10/mo** |

**Per-tradie monthly revenue:**

| Item | Revenue |
|---|---|
| Subscription | $99 |
| Platform fee on deposits (1% of avg $10K/mo deposits collected) | $100 |
| **Total ARPU** | **$199/mo** |

**Gross margin: ~95%.** Healthy.

### Voice-first (for context)

At 30 calls/day × 4 min average × ($0.30–0.50 stack cost) = **$1,100–$1,800 COGS per tradie per month.**

This destroys the SaaS model. Voice has to be either:
- Premium tier at $299–$499/mo with per-minute overage, or
- Per-call billing ($2–$5 per qualified call), or
- Optional add-on, off by default

**Implication:** the moment you turn on voice, your pricing page has to change. Plan for that.

### CAC / LTV

- Founder-led sales for first 20: ~5 hours per tradie × your time = soft CAC
- Paid acquisition (months 4+): estimate $200/tradie via trade Facebook + Google
- LTV: $199/mo × 24 months (assuming 4% monthly churn) = ~$4,800
- **LTV/CAC ~24x** if churn stays under 5%/mo, which is the hard part

**The killer metric to watch:** monthly active quote rate per tradie. If a tradie sends fewer than 4 quotes/month after their first month, they will churn within 90 days.

---

## 5. The four-agent architecture

The 10-agent decomposition was over-engineered. For v1, you need exactly four:

### Agent 1: Quote Drafter

| | |
|---|---|
| Replaces | Old Intake Cleaner (②) + Estimation Agent (③) |
| Trigger | Tradie completes intake form (or hipages enquiry parsed) |
| Reads | Intake fields, photos, tradie's pricing book overlay, shared assembly library |
| Writes | Draft quote with Good/Better/Best, line items, exclusions, confidence score |
| Model | Claude Opus 4.7 with tool use + prompt caching |
| Tools | `lookup_assembly`, `lookup_material`, `apply_markup`, `flag_inspection_needed` |

**Why merged:** the "cleaning" of intake and the "drafting" of the quote share context. Splitting them adds an LLM hop with no quality benefit.

### Agent 2: Quote Reviewer

| | |
|---|---|
| Replaces | Old Routing (④) + Tradie Validator (⑤) + Quote Presentation (⑥) |
| Trigger | Quote draft ready |
| Reads | Draft quote, tradie's review preferences |
| Writes | Final approved quote, customer-facing portal page, PDF |
| Model | Haiku (annotations) + Sonnet (cover note prose) + react-pdf (document) |

**Why merged:** routing in v1 is rule-based (always go to tradie review — no auto-send). Validator and Presentation share the same data and run sequentially.

### Agent 3: Inspection Coordinator

| | |
|---|---|
| Replaces | Old ⑨a + ⑨b + ⑩ post-acceptance |
| Trigger | Tradie marks quote as "needs site visit" OR Quote Drafter flagged inspection |
| Reads | Quote, tradie's calendar, Stripe Connect account |
| Writes | Inspection booking, payment intent, on-site capture session, post-acceptance side-effects |
| Model | Sonnet (on-site capture analysis) + rule-based orchestration |

**Why merged:** the entire inspection branch is one stateful flow. Splitting it adds coordination overhead with no benefit.

### Agent 4: Conversion Engine

| | |
|---|---|
| Replaces | Old Availability Nudge (⑦) + Follow-up (⑧) |
| Trigger | Quote sent + N hours/days, no acceptance |
| Reads | Quote, customer history, tradie's calendar |
| Writes | SMS to customer, in-portal banners, status updates |
| Model | Haiku (message text) + Inngest/Vercel Workflow (durable timing) |

**Why merged:** availability nudges and follow-ups are the same thing — post-send communication driven by time + state. They share infrastructure.

### Reserved for v3+

- **Receptionist Agent** (voice — full Vapi/Retell stack with per-trade prompt sets)
- **On-Site Capture Agent** as a separate mobile-first agent (currently a sub-mode of Inspection Coordinator)

---

## 6. The eval framework — built first

You cannot iterate on quote quality without measuring it. Build this in week 1, before any prompt changes.

### What to collect

- 100 historical (intake → final quote) pairs from your first 3 pilot tradies
- Each pair tagged with trade, job type, complexity (simple/medium/complex)
- Anonymized — no customer PII

### How to score

A 5-dimension rubric, scored 0–5:

1. **Scope completeness** — did the AI capture what the tradie ultimately scoped?
2. **Price accuracy** — % delta between AI total and tradie's final total (≤10% = 5, 10–20% = 3, >30% = 0)
3. **Line-item correctness** — are the line items the right shape (assemblies vs raw parts)?
4. **Exclusions** — did the AI surface the right exclusions (existing damage, hidden work, etc.)?
5. **Confidence calibration** — did HIGH-confidence quotes need fewer edits than LOW-confidence ones?

### How to use it

- Every prompt change → run against the hold-out set → publish delta
- Track per-trade per-job-type scores as a dashboard
- The day a prompt change drops average score >5%, revert immediately

### Why it matters

This is also your **investor pitch deck slide**. "Our AI quote engine scores 4.2/5 against held-out tradie quotes, up from 2.8/5 three months ago" is the slide that wins your seed round. Without it, you have a demo and no proof.

---

## 7. Trade selection — reconsidered

Prior recommendation was plumbing or electrical. That's wrong for v1. Here's the regulatory reality:

| Trade | Licensing burden | Quote frequency | Avg quote size | v1 fit? |
|---|---|---|---|---|
| **Painting** | Low (no national license) | High | $800–$5,000 | **★ Best v1** |
| **Landscaping** | Low | Medium | $1,500–$15,000 | Strong v2 |
| **Carpentry** | Low–Medium (state-varying) | Medium | $500–$10,000 | Strong v2 |
| **Plumbing** | High (per-state license, must display) | Very High | $200–$3,000 | v3 (after voice) |
| **Electrical** | High (licensed electrician on every quote) | Very High | $200–$5,000 | v3 (after voice) |
| **Tiling, fencing, glazing** | Low–Medium | Medium | Varies | v2 candidates |

Painting wins v1 because:

- No licensing complexity (don't have to handle per-state license display in the schema yet)
- Quote structure is simple and bounded (rooms × surfaces × paint × labour)
- Customers expect a written quote (high willingness to use a portal)
- High AU/NZ density of owner-operator painters
- Less emergency work → AI receptionist not strictly needed → defers voice complexity

Plumbing and electrical have the highest *quote frequency* (which is why they're tempting), but their regulatory requirements force the schema and product to handle license display, supervision-by-licensed-trade, and emergency call patterns from day 1. That's three months of work for a v1 you don't need.

> **Decision:** v1 trade is painting (NSW first), v2 adds landscaping + carpentry, v3 unlocks plumbing/electrical alongside voice.

---

## 8. Go-to-market plan

Missing entirely from prior analysis. Here's the realistic path:

### First 20 customers (months 1–3) — founder-led

- You personally onboard each painter
- 30-minute video call + walkthrough
- Stay on the call while they send their first quote
- Free for 60 days, then $99/mo
- Your only target: 3 quotes sent per painter per week by week 4

This is brutal but necessary. Every one of these 20 becomes a referenceable case study and a feedback source.

### Customers 21–80 (months 4–6) — community-led

- AU painter Facebook groups (e.g. "Painters of Australia", "Master Painters AU"): post real demos, not marketing
- Master Painters Australia partnership conversation
- Referral program: $50 credit per referred painter who pays for one month
- Aim for 60% inbound, 40% outbound

### Customers 81–250 (months 7–12) — paid + partnerships

- Google Ads on "quoting software for painters" (low competition keyword)
- hipages partnership conversation: "QuoteMax widget on every painter enquiry"
- Trade supplier partnerships: Inspirations Paint, Bristol Paint
- Paid: aim for $200 CAC, $4,800 LTV → 24x ratio

### Anti-patterns to avoid

- **Don't list on app stores in v1** — tradies won't search for you, distribution is wasted
- **Don't go to trade shows in year 1** — $20k+ for a booth, bad ROI for a 10-customer wedge
- **Don't hire a salesperson before $20k MRR** — founder-led sales is the right CAC at this stage

---

## 9. Defensibility — the per-tradie data lock-in

Prior analysis said "the pricing book is the moat" and stopped. Here's how the moat actually compounds, told as a 12-month painter timeline:

| Time | What's happened | Tradie effort to switch |
|---|---|---|
| Day 1 | Generic painting library + their hourly rate. First quote: 60% of tradie's normal phrasing | Trivial |
| Quote 10 | 30 line-item corrections logged. Quotes use their preferred brands (Dulux not Taubmans, etc.) | A bit of pain |
| Quote 50 | Custom assemblies created, exclusion language matches their style, GST handling is right | Real switching cost |
| Quote 200 | The system *is* their pricing book. Migrating means rebuilding 12 months of calibration | Painful — they'd lose 50+ hours of accumulated tuning |
| Year 2 | Their employees (2IC, apprentices) use the system to quote without owner involvement | Now it's an org-level dependency |

**This is a network effect of one** — between the tradie and their data — but it's real. It's also the thing that *no LLM-only competitor can match by being smarter*. They have to put in the same 200-quote calibration time.

**Investor framing:** "Every quote our customers send makes their next quote better. After 6 months, switching means losing their book. After 12 months, it means losing their team's workflow. This is why our churn drops from 8% in month 1 to under 2% by month 6."

---

## 10. AU regulatory specifics that shape the product

Not all of these matter for v1 (painting). They matter for the schema and roadmap.

| Area | Implication for product |
|---|---|
| **Australian Consumer Law** — accepted quote = binding contract | Never auto-send in v1. Tradie human-in-loop is your liability shield. Add prominent "subject to inspection" language for inspection-flow quotes |
| **GST registration** ($75k threshold) | `organizations.gst_registered` boolean. Quote display logic must omit GST line for non-registered tradies |
| **License display per trade** | `organizations.licenses` table — type, number, state, expiry. Quote PDF generator includes them when present. Painting v1: not required. Plumbing/electrical v3: required |
| **Privacy Act + Notifiable Data Breaches** | Privacy policy, customer data deletion endpoint, encryption at rest (Supabase default), audit log on data access |
| **Recording consent** (voice agent — v3) | Opening line announces recording; per-state dual-consent handled via Vapi config |
| **Stripe Connect KYC** | ABN, bank, ID verification required before tradie can accept payments. Onboarding designed so tradies can *draft* quotes immediately and only need Connect when they want to *send* and accept payment |
| **Spam Act** (SMS marketing) | Conversion Engine SMS must be "transactional" (about a quote the customer requested) — easy to comply by scoping to active quote follow-ups only |

---

## 11. The tightened plan

### Phase 0 — Validate (2 weeks, no code)
- 15 painter interviews, 10 homeowner interviews
- Specific tests: would painters pay $99/mo? Would homeowners pay $199 for a paid inspection on a complex repaint?
- Hire painting domain expert ($5k consulting) — start the base assembly library
- **Exit:** ≥5 paid pilot LOIs from painters

### Phase 1 — Portal MVP (6 weeks)
- Next.js + Supabase + Stripe Connect Express
- 4-agent architecture: Quote Drafter, Reviewer, Inspection Coordinator (no on-site capture yet), Conversion Engine
- Painting only, NSW only
- Manual intake form (no voice, no hipages integration yet)
- Eval harness with 100 hold-out quote pairs from pilot painters
- **Exit:** 3 painters each sending ≥5 real quotes, ≥1 deposit collected

### Phase 2 — Pricing intelligence + inspection flow (6 weeks)
- Active learning from tradie edits → pricing book overlay
- Confidence scoring with calibrated thresholds
- Full inspection flow (paid $199, on-site capture sub-mode in mobile web)
- Bunnings/Inspirations Paint price refresh
- **Exit:** average tradie editing time < 3 min/quote, eval score ≥4.0/5

### Phase 3 — Conversion engine + scale (4 weeks)
- Availability nudges tied to real calendar
- SMS follow-up sequence with objection handling
- hipages enquiry parsing (if partnership conversation goes well)
- Open to 50 painters
- **Exit:** measurable +15% acceptance rate vs Phase 2 baseline

### Phase 4 — Trade expansion (8 weeks)
- Add landscaping (already similar enough — bigger ticket, similar quote structure)
- Add carpentry
- Multi-state expansion
- 150 customers, $15k MRR

### Phase 5 — Voice + premium tier (12 weeks)
- Vapi-based voice agent
- Premium tier at $299/mo OR per-minute metered
- Plumbing + electrical unlock (now justified by voice-driven enquiry capture)
- 300 customers, $40k MRR

### Realistic 12-month milestones

| Month | Customers | MRR |
|---|---|---|
| 3 | 20 painters | $2,000 |
| 6 | 80 (3 trades) | $8,000 |
| 9 | 150 | $15,000 |
| 12 | 250 + voice tier rolling | $30,000 + voice ARPU |

---

## 12. Updated feasibility verdict

**Buildable today: yes — the right version of it.**

- Portal-first painting v1 in AU: 100% buildable in 6 weeks of focused engineering
- Add multi-trade and inspection: another 6 weeks
- Voice agent as premium tier: 12+ weeks once you have data and revenue to justify it

**Where I was overconfident before:**

- Voice agent in 6 weeks (real: 12+)
- "Ingest the pricing book" (real: build it with them)
- Plumbing/electrical as the v1 wedge (real: painting)
- 10-agent architecture (real: 4)
- 6-month launch with all features (real: 6 months gets you portal-first painters at $8k MRR)

**Where I was right:**

- Stripe Connect Express
- Don't auto-send quotes in v1
- Mobile-first customer portal
- Good/Better/Best framing
- Paid inspection fee as differentiator
- Per-tradie pricing data as the moat

**The single biggest risk to manage:**

The voice-first AI receptionist is a fundraise pitch, not a v1 product. **If you build for the pitch, you'll exhaust runway before you have customers.** Build the boring portal-first version, get 80 painters paying, then raise on the data and use the money to build voice.

---

## Iteration history

- **v1** (2026-04-27, chat-only): initial 5-section analysis, 10-agent architecture, plumbing/electrical wedge, voice-first assumed. Many shallow points. Superseded by v2.
- **v2** (2026-04-27): honest critique + tighter plan. Portal-first v1, **painting wedge**, 4 agents, eval-first, GTM included. Trade-selection rationale (§7) anchored on regulatory simplicity. Superseded for trade selection by v3; everything else still stands.
- **v3** (2026-04-28): **pivoted v1 trade from painting to electrical.** Architecture, agent design, build options, and feasibility verdict all unchanged.

  **Why the pivot:**

  v2 chose painting because the regulatory burden is lower (no per-state license display, no supervised-trade rules). That argument was correct in isolation but **anchored on the wrong dominant factor**. Pilot access dominates regulatory complexity. Without a real pilot tradie, no v1 ships.

  The user-supplied operational content for electrical signalled that the pilot relationship is in electrical, not painting:

    - 9 detailed job-flow question trees (downlights, GPOs, ceiling fans, smoke alarms, outdoor lighting, switchboards, oven/cooktop, EV charger, fault finding)
    - Real AU electrician rates ($90–$130/hr, $120–$180 minimum call-out, 20–35% material margin)
    - A considered "easy 5 vs hard 5" pilot recommendation (auto-quote downlights/GPOs/fans/alarms/outdoor; always inspection-route switchboards/fault-finding/EV/underground/renovations)

  Content of that specificity comes from talking to actual electricians — not theorising about a market. **Painting was theoretical; electrical is operational.**

  **What this changes:**

  | Area | v2 (painting) | v3 (electrical) |
  |---|---|---|
  | v1 trade | Painting | **Electrical** |
  | License display | Not required v1 | **Required v1** — per-state (NSW = NECA, VIC = ESV, QLD = QBCC); on every quote PDF |
  | Schema | `organizations.licenses` deferred | `organizations.licenses` shipped Phase 1 (type, number, state, expiry) |
  | Domain expert | "30-year painter" | "25-year electrician" (~$5k consulting) |
  | Base assembly library | Painting assemblies (interior wall, prep+prime+coat, etc.) | Electrical assemblies (replace GPO, install downlight, hardwire smoke alarm, etc.) |
  | Confidence-router defaults | All MED route (tradie validates) in v1 | **Inspection-only** for switchboards, fault finding, EV chargers, underground cabling, complex renovations. **Auto-quote candidates** (still MED in v1, HIGH later): downlights, GPOs, ceiling fans, smoke alarms, outdoor/deck lighting |
  | Pricing structure | Sqm + paint × labour | Hourly rate + materials + sundries + 20–35% margin + risk buffer 10–20% on unknown access |
  | GTM channels | "Painters of Australia" FB groups, Master Painters AU, Inspirations Paint suppliers | NECA member networks, sparky FB groups, Reece Electrical / L&H Group / MM Electrical suppliers |

  **What stays the same (every v2 architectural decision):**

  - Portal-first v1, voice deferred to v3+ premium tier
  - 4 agents (Quote Drafter, Quote Reviewer, Inspection Coordinator, Conversion Engine)
  - Build-with-tradie pricing book (overlay pattern)
  - Eval framework before prompt iteration (100 hold-out pairs, 5-dim rubric)
  - Stripe Connect Express
  - No auto-send in v1 — tradie human-in-loop on every send
  - Multi-tenant via Supabase RLS from day 1
  - Mobile-first customer portal, Good/Better/Best, paid $199 inspection branch

  **Cautions specific to electrical (vs painting):**

  - Australian Consumer Law liability is *higher* for electrical than painting because work is safety-critical. Auto-send stays off in v1; even MED-confidence quotes go through tradie review
  - Fault finding cannot be fixed-quoted — uses call-out + hourly diagnostic rate
  - Switchboard work, EV chargers, anything with mains/underground cabling = always inspection-route
  - Pre-1970 wiring may have asbestos in insulation — surface as a risk flag in Intake Engine
  - Solar/EV interaction with switchboards requires three-phase awareness — ask the question at intake

  **Operational reference:** the 9 job-flow question trees and pilot strategy live in `docs/build-guide.html` — they're operational artefacts, not strategy. This entry records the rationale only.

- **v4** (2026-05-01): **photo-capture flow — Pattern 1 (parallel race) chosen for v1.**

  **What's settled:**

  Photos are captured via SMS link sent immediately on call-end, in parallel with the intake → estimate chain. Quote SMS goes out as soon as Sonnet+Opus complete (~70s typical). Photos that arrive after the quote was sent are **stored for tradie review** but do **not** trigger an auto re-quote in v1.

  **Patterns considered:**

  | # | Pattern | Why not |
  |---|---|---|
  | 1 | Parallel race (chosen) | Fastest to quote (~70s); matches "(optional)" framing in wireframe Stage 03; matches SOP S2 setting Twilio capabilities to "Voice only" |
  | 2 | Photos required (gate quote on upload) | 5+ min wait kills conversion; contradicts wireframe's "optional" framing |
  | 3 | Two-stage quote (initial + revised SMS) | Multiple SMS confuses customers; first SMS's Stripe links go stale on revision; legal liability if customer pays v1 before v2 |
  | 4 | Photos hard-gated (no quote without photos) | ~50% of customers won't upload; explicit contradiction of "optional" framing |

  **Why parallel works for v1:**

  The auto-quote wedge is scoped to the "easy 5" job types (downlights, GPOs, ceiling fans, smoke alarms, outdoor lighting). Those are deliberately **photo-light** — the transcript carries enough info to quote at MEDIUM confidence. Vision adds nice-to-have detail (asbestos risk on pre-1970 ceilings, switchboard age verification) but is not deal-breaking. The inspection route (Stage 06 LOW path) is where vision is genuinely load-bearing — and that path involves the tradie capturing photos on-site, not the customer over SMS.

  **What this means in practice:**

  - `app/api/vapi/webhook/route.ts` generates a `photo_request_token` and dispatches the photo SMS in `after()` alongside the intake handoff
  - Customer taps the SMS link → opens `app/upload/[token]/page.tsx` → snaps photos via native camera input (`<input type="file" capture="environment">`) → photos land in Supabase Storage bucket `intake-photos`
  - Photo URLs are appended to `calls.photo_urls` and `calls.photos_completed_at` is set
  - Quote draft does **not** wait for photos; runs as soon as the transcript is structured
  - Photos remain available for the tradie's Stage 06b review and for any future re-quote logic

  **What changes when the mobile app exists (post-v2):**

  Photo capture moves from after-call SMS to during-call in-app camera. The asynchrony question disappears — by the time the call ends, photos are already on the device. The pattern shifts toward "photos before quote" naturally, with no waiting. The current Pattern 1 is a v1 web-only workaround for SMS asynchrony, not a permanent architectural choice.

  **What stays the same:**

  - Photos remain optional in v1 (per the wireframe)
  - Auto-quote path doesn't gate on photos
  - Inspection route still demands on-site capture by the tradie
  - Sonnet vision continues to accept photo URLs in `structureIntake` when present

  **Trigger for revisiting this decision:**

  - Pilot data shows >40% of customers actually upload photos within 5 minutes — then Pattern 3 (two-stage with revision SMS) becomes worth the complexity
  - Real callers hit asbestos/old-switchboard surprises that photos would have caught — then we either tighten the auto-quote scope or add a confidence-gated "wait briefly for photos" branch in Stage 06 routing
  - Mobile app development begins — Pattern 1 is replaced wholesale by in-app capture

- **v5** (2026-05-11): **multi-trade expansion — plumbing alongside electrical (Brisbane pilot).**

  **What's settled:**

  The system now supports two trades simultaneously via a `trade` column on `pricing_book`, plus the pre-existing `trade` column on `shared_assemblies` and `shared_materials`. Electrical (NSW/NECA) and plumbing (QLD/QBCC) live in the same database; the estimator routes to a trade-specific system prompt based on `intake.trade`. Plumbing follows the same Good/Better/Best architecture and strict-grounding discipline — no ranged quotes, every dollar amount traces to a DB row.

  **Why this crosses v1 scope:**

  v3 locked v1 to "NSW electrical, easy 5 job types." Adding plumbing is a deliberate scope expansion driven by a second pilot opportunity (Brisbane plumber). The architectural cost is low because `trade` was already a column on assemblies/materials — the schema was architected for multi-trade from day 1, just not exercised. The product cost is two prompts to maintain and a per-trade `pricing_book` row.

  **Plumbing "easy 5" (auto-quote tiered):**

  - `blocked_drain` (G: hand rod · B: jet blast · X: jet blast + CCTV)
  - `hot_water` (G: like-for-like electric · B: gas/continuous flow · X: heat pump w/ QLD rebate)
  - `tap_repair` (G: washer · B: full tap replace · X: replace + new isolation valve)
  - `toilet_repair` (G: cistern internals · B: full suite · X: wall-faced/in-wall premium)
  - `tap_replace` (G: basin/laundry · B: kitchen mixer · X: wall-mounted premium)

  **Plumbing inspection-route (cannot auto-quote):**

  Gas fitting (leak detection, appliance connection — requires gas-licence verification), burst pipe repair (access/make-good unknown), bathroom renovation (rough-in + fit-off), CCTV-only inspections, hot-water replacements where electrical/gas line upgrades are needed.

  **What didn't change:**

  - Strict-grounding rule still binding: no fabricated ranges, every line item from DB
  - Good/Better/Best framing reused — plumbing JSON's low/high ranges converted to midpoint assemblies
  - $199 site-visit fee + inspection-fallback shape reused
  - No auto-send — tradie human-in-loop preserved
  - 4-agent architecture, eval framework, Stripe Connect Express — all unchanged

  **What's deferred to future iterations:**

  - Full multi-tenancy (`tenant_id` + RLS): both trades share one DB without per-tenant isolation. Acceptable for a 2-tenant pilot; required before scaling beyond 5 tradies. CLAUDE.md's "multi-tenant via Supabase RLS from day 1" goal becomes the next architectural debt to pay
  - Plumbing-specific intake schema fields: currently reuses electrical access/property fields where applicable; plumbing-specific detail (fixture type, fuel type, indoor/outdoor) lives in `scope.description` and is parsed by the plumbing prompt rather than structured
  - Cross-trade SMS slot extraction: the SMS extractor's per-job slots are electrical-centric (ceiling_type, colour); plumbing SMS leads classify by job_type and rely on portal completion for richer detail
  - QBCC licence-specific PDF rendering for QLD plumbing quotes
  - Plumbing RAG corpus: shares the `intakes` embeddings table; cross-trade matches are filtered by `job_type` at the SQL layer, so plumbing intakes naturally only match plumbing past quotes once corpus exists

  **Trigger for the next iteration:**

  - Plumbing pilot signs up 2+ tradies → invest in true multi-tenancy before the third
  - Plumbing intake quality drops below 4.0/5 on the eval rubric → richer plumbing-specific intake schema
  - QBCC compliance audit fails → harden QLD PDF rendering before any further multi-trade growth
  - Third trade gets pitched → stop bolting trades on per-pilot and refactor to a trade-registry pattern

- **v6** (2026-05-20): **drift reconciliation — what shipped vs what this doc said would ship.**

  **Why this entry exists:**

  CLAUDE.md flagged three documented decisions in this strategy doc as
  contradicted by the running system. Per the project rule ("if work
  demands a change, add a new iteration entry before changing the
  decisions table"), this entry records the drift so future readers can
  see the running system as canon and treat §1–§12 as historical.

  This entry **records reality**; it does not justify it. The strategic
  rationale for shipping voice and auto-send earlier than v3/v5 said
  needs to be added by whoever made those product calls (pilot tradie
  feedback, the John 12-point list referenced in the engineering memory,
  etc.). Future-Claude reading this: when in doubt, treat §1–§12 as
  v2 history; treat CLAUDE.md + this entry as ground truth.

  **What shipped, contradicting prior iterations:**

  | Decision in v2/v3/v4/v5 | Running system as of 2026-05-20 |
  |---|---|
  | "v1 is portal-first. Voice agent is deferred to v3 (~month 7)" (§2) | Voice intake **shipped in v1** via Vapi (`/api/vapi/webhook` → intake → estimate → quote SMS). Persona "jon". Deepgram STT + ElevenLabs TTS. |
  | "Receptionist Agent (voice — full Vapi/Retell stack) — Phase 5 premium tier" (§5) | Same as above — voice is the v1 path, not a Phase 5 tier. |
  | "No auto-send in v1 — tradie human-in-loop on every send" (v3/v5) | `lib/routing/decide.ts` records `tradie_review` as the routing decision but **every drafted quote auto-sends to the customer today (Path B)**. The two investor-pack commits `ad72ab8` and `602915e` explicitly moved to auto-send-to-customer / tradie-reviews-after. |
  | "Eval framework before prompt iteration: 100 hold-out (intake → quote) pairs, 5-dim rubric" (§6, every iteration) | **Not built.** Prompts iterate without delta measurement. The parity harness `scripts/test-sms-parity.mjs` (70 assertions) covers SMS↔voice intake parity, not quote quality. |

  **What also shipped beyond the strategy doc, but doesn't contradict it:**

  - **SMS intake** (full dialog agent, `/api/sms/inbound`, all 5 phases done — `docs/markdown/sms-progress.md`).
  - **Multi-trade** (v5 already recorded — electrical + plumbing).
  - **v6 self-serve onboarding** (`/signup`, `/onboard/*`, Twilio + Vapi auto-provisioning behind `*_PROVISIONING_ENABLED` flags).
  - **Vercel AI SDK direct to Anthropic** (`ANTHROPIC_API_KEY`), not via Vercel AI Gateway as v2/v3 docs implied.
  - **Google Gemini for image generation** (preview + per-tier sample images) — not in the v2 stack table.

  **Asset gap acknowledged (not yet fixed):**

  - `assets/quotemate_flow_with_inspection.svg` (STEP 5 "Tradie reviews quote") still depicts the pre-auto-send model. README.md's "How it works" prose was updated this iteration to match Path B (lines 27, 41, 67-69), but the SVG is a binary asset and needs a designer pass — leaving it annotated as historical until then.

  **Outstanding debt unchanged from v5:**

  - **Stripe Connect Express still not wired.** `tenants.stripe_connect_account_id` is null for every tenant; `payments` has 0 rows. The marketplace funds-split decision (§9, Phase 4 plan) is still owed.
  - **Multi-tenant RLS still policy-less.** RLS-on with no policies for some tables; RLS-off entirely for `tenants/customers/sms_*/tenant_*` — meaning the public anon key currently allows `SELECT *` against those. Phase 1 plan written this iteration: see [`quotemate-automation/docs/rls-design.md`](../quotemate-automation/docs/rls-design.md). Apply before scaling past tenant #5.
  - **Eval framework** still not built (see drift table above).

  **What was confirmed unchanged from v5:**

  - 4-agent architecture (Drafter, Reviewer, Inspection Coordinator, Conversion Engine).
  - Build-with-tradie pricing book (the WP2 operator material catalogue is the keystone here — migrations 028, 034 shipped tenant-owned brand/range/cost rows; see memory `project_wp1_pricing_book_fix`).
  - Strict-grounding rule binding on every line item.
  - Good/Better/Best tier shape, $199 paid-inspection fallback, Stripe test mode + Mobile HTML quote page (no PDF).
  - Electrical + plumbing are the boundary — third trade requires a new entry.

  **Trigger for the next iteration:**

  - Stripe Connect Express ships → record the funds-split design choice (platform fee shape, Connect Express vs Standard, dispute handling).
  - First tenant signs up that brings active-tenant count to 5 → record the RLS Phase 1 apply (and whether the Phase 2 tenant-scoped policies followed).
  - First eval-rubric run → record the framework that finally lands and the baseline scores.
  - John (or whoever drove the voice + auto-send pivots) supplies the strategic rationale → backfill it into this v6 entry rather than starting a v7.

- **v7** (2026-05-20): **catalogue-as-template — pre-populated services, master supplier catalogue, per-tenant G/B/B ladder.**

  **Why this entry exists:**

  Jon toured the live dashboard (Catalogue → Recipes → Estimation → Services tabs) and described how he expected it to work for a brand-new tradie. Three quotes:

  > "I can imagine that we would load the whole clips or catalogue, and then the traders could select the items that they use"
  > "We offer standard services and standard product catalogues and they just toggle on and off these catalogues — everything is pre-populated for them"
  > "They can localise whether they have a preferred Good/Better/Best option"

  This is **not a request for new capability** — the schema for almost all of it is already shipped (migrations 022, 023, 028, 031, 034). It is a request that the **default tradie experience** match a "stocked template they tick" model rather than a "blank tabs they configure" model. This entry records the decision to deliver that and the phased plan.

  **What's already in place (no new schema needed):**

  - `tenant_material_catalogue` (028 + 034) — brand, range_series, supplier, tier_hint, is_preferred, cost_price, image, active toggle, description.
  - `tenant_assembly_bom` (031) — per-tenant editable recipe book; estimator already prefers it over shared baseline.
  - `tenant_assembly_overrides` (028) — per-tenant labour_hours / markup overrides.
  - `tenant_material_preferences` (022) — preferred brand per category.
  - `shared_assembly_bom` (028) — global structured BOMs.
  - `lib/estimate/catalogue.ts` — `chooseMaterial()` scores tenant rows ahead of shared; `catalogueCandidateRows()` feeds tenant catalogue into the grounding validator (the WP2 "trap" is solved); `formatCatalogueHint()` + `formatBomHint()` are live soft prompt hints; `enrichLinesWithCatalogue()` + `applyChosenProduct()` stamp catalogue_id/image post-grounding.
  - Dashboard tabs Catalogue / Recipes / Estimation / Services all exist and write through.

  **The real gaps Jon was reacting to:**

  1. **No master supplier catalogue.** Catalogue tab is empty by default. Tradies hand-type SKUs instead of ticking from a pre-loaded library.
  2. **Services pre-population is implicit.** `/api/tenant/me` defaults a missing row to enabled=true. CRM counts therefore lie about what's "configured" vs "default".
  3. **No G/B/B ladder picker.** Tier is per-product (`tier_hint`); there's no "for downlights → my Good is X, my Better is Y, my Best is Z" data shape, only inference.
  4. **Two competing "is this on?" surfaces.** `tenant_service_offerings.enabled` (Services-tab → estimator) AND `tenant_assembly_overrides.enabled` (Estimation-tab badge only — write-orphaned column). The latter is never written by any UI, so the Estimation tab can show "enabled" while the AI is actually declining the service.
  5. **No bulk-import / "stock the essentials" defaults** to get a new tradie from signup to first quote in <5 min.
  6. **Free-text catalogue categories** — silent join failures between Catalogue and Recipe when the tradie typos a category. Multiplies in severity once the catalogue grows 10x.

  **Phased delivery plan:**

  | # | Phase | New schema | Money-path | Effort |
  |---|---|---|---|---|
  | 0 | Consolidate `enabled` surfaces — Services-tab is single source of truth; Estimation tab reads from `tenant_service_offerings`; drop `enabled` from `AssemblyOverride` type. **Preserves the deliberate decline-on-OFF semantics recorded in memory `project_services_toggle_off_decline`** (Services-tab OFF still routes SMS to polite decline, not the legacy $199 fallback). | none | no | 1 day |
  | 1 | Extract the (already-shipped) explicit seeding from `/api/onboard/activate` into a reusable helper; backfill the 4 activated tenants whose offerings rows are incomplete (94 → ~160 expected); add "Standard services on by default — untick what you don't do" banner. Safety-net fallback in `/api/tenant/me` (uses per-assembly `default_enabled` from migration 021) is sound — kept as belt-and-braces. | none | indirect (CRM truthfulness) | 1–2 days |
  | 2a | `supplier_catalogue` table + `supplier_catalogue_id` link on `tenant_material_catalogue`; seed ~300 SKUs (Clipsal Iconic/2000, HPM, SAL, Versalux; Caroma, Methven, Phoenix, Rheem, Rinnai, Bosch) | mig 041 + 042 *(planned numbers; latest applied is 040 = RLS Phase 1)* | yes (catalogue feeds validator) | 3 days |
  | 6 | Controlled-vocabulary categories. **Already shipped pre-v7** via `lib/estimate/categories.ts` (single source of truth, drift-guarded by `categories.test.ts`) — the CatalogueTab dropdown imports `CATEGORIES` directly. ⚠ Known issue uncovered while validating: supplier_catalogue (mig 041) uses granular material-category vocab (`tapware_basin`, `hws_gas`) while CATEGORIES uses coarse grounding vocab (`tap`, `hot_water`). The bridge is needed in Phase 2b's "Add to my catalogue" action — map granular → grounding on copy, retain link via `supplier_catalogue_id`. | none | no | 0 days (pre-shipped); vocab mismatch becomes a Phase 2b deliverable |
  | 2b | CatalogueTab "Browse supplier catalogue" mode — filters, multi-select, "Add N to my catalogue" | none | no | 3–4 days |
  | 2c | "Already in your catalogue" badging via the link; supplier-refresh foundation (no UI yet) | none | no | 1 day |
  | 2d | **"Stock the essentials for my trade" 1-click button** — auto-adds ~30 SKUs across most-quoted categories. Without this, 2a/b/c is a configuration tax | none | indirect | 2 days |
  | 3 | `tenant_tier_ladder (tenant_id, category, tier, catalogue_id)`; wire `chooseMaterial()` to give ladder hits +10, prepend explicit ladder section in `formatCatalogueHint()`; per-category G/B/B picker UI | mig 043 *(planned number)* | yes (estimator priority) | 1 week |
  | 4 | Per-assembly labour/markup override editor on Estimation tab + PATCH `/api/tenant/estimation/[assemblyId]` | none | yes (math input) | 3–5 days |

  **What's explicitly OUT of scope for v7:**

  - **Phase 5 (bulk CSV import + supplier refresh UI)** — deferred until a pilot tradie asks for it. The "Stock the essentials" button (Phase 2d) covers ~80% of new-tradie onboarding without CSV.
  - **Licensed supplier feeds** (Clipsal/Reece APIs) — hand-curated ~300 SKUs is fine through pilot. Revisit when a tradie asks for a brand we don't carry or the manual quarterly refresh starts decaying.
  - **Stripe Connect Express** — still flagged debt from v6; v7 doesn't touch the money flow.
  - **RLS Phase 2 tenant-scoped policies** — Phase 1 (migration 040) shipped; v7 adds new tables (`supplier_catalogue` is global/read-only; `tenant_tier_ladder` is tenant-scoped) which must be added to the RLS apply list but Phase 2 policies are not bundled into v7.
  - **Eval framework** — still flagged debt; v7 doesn't substitute for it. Each money-path migration in v7 must re-run `scripts/test-sms-parity.mjs` + the catalogue-trap tests, but that's regression coverage, not quality measurement.

  **What's confirmed unchanged from v6:**

  - 4-agent architecture, strict-grounding rule, G/B/B framing, $199 inspection fallback.
  - Electrical + plumbing are still the boundary — no third trade.
  - Auto-send-to-customer remains the Path B reality recorded in v6; v7 does not revisit that.
  - Tenant-owned data physically partitioned in separate tables (`tenant_*`) — `supplier_catalogue` is a NEW table for global supplier SKUs (read-only to tradies), distinct from `shared_materials` (generic fallback library) and `tenant_material_catalogue` (operator-owned).

  **Risk model (carried through every phase):**

  - The "zero-config tradie still gets a quote" guarantee is non-negotiable. Every new tenant-controlled dimension falls back gracefully — partial ladder → keyword inference; no override → global default; no supplier link → existing tenant_material_catalogue flow.
  - Every money-path migration (2a, 3) runs `scripts/test-sms-parity.mjs` + `lib/estimate/catalogue-trap.test.ts` + `lib/estimate/catalogue-hints.test.ts` before the next phase starts.
  - Per-migration prod-apply gate confirmed with operator (Anant) — no batch applies.
  - Each phase is independently shippable; abandoning v7 mid-delivery never leaves the system worse than v6.

  **Trigger for the next iteration:**

  - A pilot tradie asks for a brand outside the seeded ~300 SKUs → log a supplier-catalogue expansion entry; consider whether hand-curation still scales or a feed is warranted.
  - Catalogue-link refresh becomes a real workflow (more than 1 tenant needs it) → record Phase 5 (bulk import + supplier-refresh banner) as a v8 entry rather than smuggling it into v7.
  - Stripe Connect Express finally ships → its own iteration entry (still owed from v5/v6).
  - First eval-rubric run lands → its own entry (still owed from every prior iteration).
  - **Any phase in the v7 table ships → backfill the actual migration number and note any scope deviation in this entry.** The 041/042/043 placeholders are nominal; whichever migration number ends up applied is what should appear here, so future readers see history not aspiration. (This is the lesson v6 learned the hard way about v3/v4/v5 drift.)

  **Note on prior debt status (correction to v6's outstanding-debt list):**

  - RLS Phase 1 has now SHIPPED as migration 040 between v6 and v7 — v6 line 597 says "Phase 1 plan written this iteration" but the apply followed. Phase 2 tenant-scoped policies still outstanding (v7 is out of scope for them).

- **v8** (2026-05-21): **dynamic pricing — per-tenant early-booking discount (Phase A).**

  **Why this entry exists:**

  Jon asked, reviewing the booking flow, for an Uber-style pricing lever:

  > "How do you bring up a prompt a bit earlier to say, hey, if you book it in today, you'll get a discount. Or if you book it in today, I can honor this price."
  > "Some type of concept of dynamic pricing. Like Uber — if I'm free and available on a couple of these prices, these areas, maybe you could apply a 10% discount."

  This introduces a **new pricing concept** not in the §"decisions" table — a promotional discount applied to a drafted quote. Per CLAUDE.md, a money-touching concept change requires an iteration entry before code. This records the decision, the deliberate scope split, and the guardrails.

  **The split — what ships now (Phase A) vs later (Phase B):**

  - **Phase A — early-booking discount (this iteration).** A deterministic, per-tenant % discount with a deadline. The tradie configures `{ enabled, discount_pct, window_hours }`; every drafted quote is stamped with an offer (`quotes.early_bird_discount_pct` + `early_bird_expires_at`). The quote page advertises a countdown ("book by <time> → save X%"); the discount is *realised* server-side at the booking choke-point (`POST /api/q/[token]/book`) when the customer commits a time before expiry, and a fresh discounted Stripe Checkout Session is re-issued for the deposit.
  - **Phase B — availability-derived dynamic pricing (deferred).** The true Uber-surge model ("if I'm free in these areas") needs two things QuoteMax does not have: a real two-way calendar integration (today `tradies.available_slots` is a flat ISO-timestamp array; `GOOGLE_BOOKING_URL` is an off-platform link with no callback) and geographic zones. Deferred until calendar sync exists. A crude per-day proxy (discount days with many open slots) is possible earlier but is explicitly **not** in Phase A.

  **Decisions locked with the operator (Anant), 2026-05-21:**

  | Decision | Choice |
  |---|---|
  | What the discount reduces | **The whole job total** (deposit + balance both drop) — a real incentive, not just a cashflow nudge. Consequence: it eats tradie margin, so it is capped (below). |
  | First-build scope | **Phase A only.** No per-slot/availability pricing. |
  | Who configures it | **Per-tenant.** Config lives in `pricing_book.overlays.early_bird` jsonb (no schema change for config); editable in the dashboard Pricing tab. |

  **Guardrails (non-negotiable):**

  - **Margin cap.** `discount_pct` is clamped to a hard platform maximum of **15%** in the pure module (`MAX_EARLY_BIRD_DISCOUNT_PCT`). Plumbing books run 15–20% markup ([[project_plumbing_routing_rules]]); an uncapped discount could sell below cost. A misconfigured overlay can never exceed the cap.
  - **Grounding validator untouched.** The `good/better/best` jsonb line items stay catalogue-derived. The discount is a **separate quote-level field** (`applied_discount_pct`), applied only at the display + Stripe layer. `lib/estimate/validate.ts` is not modified and never sees a discounted line item — the strict-grounding rule is preserved.
  - **Server-side evaluation.** The discount is decided from the DB-stamped `early_bird_expires_at`, never from a client-passed value. The book route is the single apply point.
  - **Graceful degradation.** New `quotes` columns land via migration 044; until applied, the offer is stamped via a best-effort post-insert update (same pattern as `booking_state`) so quote creation never fails on a missing column. Zero-config tenants (no `early_bird` overlay, or `enabled:false`) behave exactly as v7 — no banner, no discount.

  **Schema:** migration 044 — `quotes.early_bird_discount_pct`, `quotes.early_bird_expires_at`, `quotes.applied_discount_pct` (default 0), `quotes.applied_discount_at`. Config (`pricing_book.overlays.early_bird`) needs no migration — `overlays` jsonb already exists.

  **What's confirmed unchanged from v7:**

  - 4-agent architecture, strict-grounding rule, G/B/B framing, paid-inspection fallback.
  - Electrical + plumbing remain the boundary — no third trade.
  - Book-first / pay-last funnel order (WP6) is unchanged; the discount is applied within it, not by reordering it.

  **Trigger for the next iteration:**

  - Google Calendar two-way sync ships → Phase B (availability-derived pricing + geographic zones) becomes buildable; record it as its own entry.
  - A tradie sets a discount that needs to exceed 15% → revisit the cap with a cost-floor check against assembly cost rather than a flat ceiling.
  - Stripe Connect Express ships → record how the discount interacts with the platform-fee split (the discount reduces the charge and should reduce the fee proportionally).

- **v9** (2026-05-21): **trades-as-data — admin bulk loader, no-code industry expansion.**

  **Why this entry exists:**

  Every iteration v5→v8 repeated the same line: "electrical + plumbing are the boundary — a third trade requires a new entry." v5's own trigger list spelled out the exit condition: *"Third trade gets pitched → stop bolting trades on per-pilot and refactor to a trade-registry pattern."* That trigger has now fired. The operator wants QuoteMax to expand into carpentry, garden cleaning, swimming-pool cleaning and more — **added in bulk, by a non-developer, through an admin dashboard, not hand-wired in code per trade.**

  This entry **is** the authorization to cross the electrical+plumbing boundary. It supersedes that boundary line in v5/v6/v7/v8, and it supersedes v7's deferral of "Phase 5 — bulk CSV import" (v7 "out of scope" list): bulk loading is now the *mechanism* for growth, not a nice-to-have.

  **The decision: trades become data, not code.**

  Today `trade` is a hardcoded `'electrical' | 'plumbing'` string — enforced by ~5 DB CHECK constraints (migrations 028/031/041) and assumed in ~10 code locations: the estimator prompt router (`lib/estimate/prompt.ts`), `deriveTradeFromJobType()`, the SMS `job_type` enum, the grounding validator's `Category` set, the Vapi assistant prompt, `defaultsForTrade()`, `LICENCE_BODIES`. v9 makes `trade` a row in a new `trades` registry table. Adding a trade becomes a data operation; the boundary moves from "2 hardcoded trades" to "N admin-loaded trades."

  **The two-capability split (non-negotiable):**

  - **Capability 1 — bulk-add services to an EXISTING trade.** Low risk. Services are already data (`clarifying_questions`, `category`, pricing columns); the SMS/Voice agents read them straight from the row. Proven safe in the 2026-05-21 n8n adversarial sweep — a service the `job_type` classifier doesn't recognise still works via the `customAssemblies` path.
  - **Capability 2 — add a NEW trade.** High risk. Needs the Phase 0 foundation first; a CSV alone cannot do it (the DB CHECK constraints reject the row). Building these two as one feature is how the system gets destroyed — they ship as separate phases.

  **The feature:** an admin-only dashboard that ingests a Services CSV + a Supplier Catalogue CSV (+ a trade-defaults block for a new trade), runs structural-then-row validation, shows a preview diff, allows manual single-row adds (CTA buttons) for anything missed, then a single **Approve** wires it in behind a grounding smoke-test. A detailed build spec (exact CSV→column maps, validation rules) is to be filed under `docs/` before Phase 0 starts.

  **Decisions locked with the operator, 2026-05-21:**

  | Decision | Choice |
  |---|---|
  | Who adds trades/services | A non-developer admin, via CSV + Approve. No code, no re-wire. |
  | Capability ordering | Existing-trade bulk-add first (safe), new-trade second (after foundation). |
  | Manual add | A single-service "Add" CTA on the review screen, for anything missed in the CSV; joins the same batch + validation. |
  | Access | Admin-only, behind a real server-side admin role. |

  **Guardrails (non-negotiable — this is the "without destroying the system" requirement):**

  - **Opt-in by default.** Every bulk-uploaded service lands `default_enabled = false`. Approve can never silently change a live tradie's SMS/Voice behaviour; default-on is a separate deliberate per-service action.
  - **Grounding-category guard.** Every service's `category` is validated against the controlled vocabulary (v7 already shipped `lib/estimate/categories.ts` as the single source of truth, drift-guarded by `categories.test.ts`). A new trade's new categories must be registered first. An unknown category silently drops quotes to the paid-inspection fallback — so it is rejected at upload, never at quote time.
  - **Pricing-semantics guard.** The service-fee CSV column is the sundries portion ex-GST only (not product, not labour). The preview shows a **computed sample quote** per row so a wrong-but-groundable price is caught by a human, not by a customer.
  - **Smoke-test gate.** Each new service is drafted into a sample quote on Approve; it must ground (not fall to inspection) and render its mandated questions before going live. Failures are held back, not shipped.
  - **Strict-grounding rule untouched.** `lib/estimate/validate.ts` is not modified; money still flows only through catalogue-derived line items.
  - **Audit + one-click rollback** via an `import_batches` record holding the before-values of every updated row.
  - **Vapi re-provision is tenant-triggered** (at trade activation on the Account tab), never by Approve.

  **Phased delivery plan** (foundation migrations nominal 045+; backfill actual numbers on apply, per the v7 lesson):

  | # | Phase | New schema | Money-path | Exit gate |
  |---|---|---|---|---|
  | 0 | Foundation: `trades`, `categories`, `trade_pricing_defaults`, `import_batches` tables; swap the `trade` CHECK constraints for FKs; backfill electrical/plumbing + existing categories; add a server-side admin role | yes (schema) | no | existing electrical/plumbing quotes byte-identical; SMS parity sweep green |
  | 1 | Capability 1 — admin loader scoped to existing trades: upload, structural+row validation, preview diff, manual-add CTA, Approve, smoke-test, audit/rollback | none | indirect | bulk-add 5 test services, verify via SMS sweep, roll the batch back cleanly |
  | 2 | Capability 2 — new trades: data-composable estimator prompt, trade-defaults wiring, new-trade activation + tenant Vapi re-provision | none | yes | a real new trade quotes correctly end-to-end and the Voice agent speaks it |
  | 3 | Supplier Catalogue CSV loader — extends v7 Phase 2a (`supplier_catalogue`, migrations 041/042) | none | no (browse-only) | can run parallel to Phase 1 |

  Each phase is independently shippable; abandoning v9 mid-delivery never leaves the system worse than v8. Never start Phase 1 before Phase 0's exit gate is green.

  **What's confirmed unchanged from v8:**

  - 4-agent architecture, strict-grounding rule, G/B/B framing, paid-inspection fallback.
  - Auto-send Path B (v6), book-first funnel (WP6), early-booking discount (v8) — all unchanged.
  - Tenant-owned data stays physically partitioned in `tenant_*` tables; the `trades` registry and `categories` are new *global* tables.

  **What's OUT of scope for v9:**

  - **Trade-specific structured intake fields.** A new trade reuses the generic intake schema; richer per-trade structured fields (the kind plumbing still lacks per v5) are a later iteration.
  - **Self-serve trade creation by tradies.** v9 is admin-only — tradies *activate* a trade and toggle its services, they do not create trades. Tradie-created trades are a different security model and need their own entry.
  - **Licensed supplier feeds** — supplier catalogue stays hand-curated per v7.
  - **Stripe Connect Express, RLS Phase 2, the eval framework** — still owed from prior iterations; v9 does not touch them.

  **Trigger for the next iteration:**

  - First real new trade ships end-to-end → backfill the actual migration numbers and note any scope deviation in this entry.
  - A new trade needs trade-specific structured intake fields → record an intake-schema-per-trade entry.
  - Tradies ask to self-create trades → that is a different security model; its own entry.
  - Phase 0 changes how `category` is stored → reconcile with v7's `lib/estimate/categories.ts` single-source-of-truth note so the two don't drift.

- **v10** (2026-05-29): **roofing as the third trade — shipped ahead of v9's admin loader.**

  **What's settled:**

  Roofing is QuoteMax's third trade, joining electrical (NSW/NECA) and plumbing (QLD/QBCC). Phase 1 ships with the existing hand-wired pattern (a new migration seeding `shared_assemblies` + `shared_materials` rows scoped to `trade='roofing'`, no admin loader involved). The measurement engine starts on **Geoscape Buildings + customer-declared pitch** (precomputed footprints, ~10–15% accuracy on sloped area) with a clean swap-point for a real LiDAR pipeline (PDAL + Open3D over ELVIS data) once Phase 2 volume justifies the 4–6 week Python-worker investment.

  **Why this departs from v9 (intentionally):**

  v9 said: *first real new trade ships end-to-end → backfill the actual migration numbers and note any scope deviation in this entry.* The honest deviation: **v9 Phase 0 is not yet built**, so roofing cannot route through the admin loader. Hand-wiring through the legacy seed pattern (migration 080) is the pragmatic call — it ships in 2–3 weeks instead of 6+. The row set is shaped to be **adoptable by the v9 loader without change** when Phase 0 lands (same `shared_assemblies` columns, same `category`/`properties` JSON convention, same idempotent insert pattern).

  | Area | v9 plan | v10 reality |
  |---|---|---|
  | Trade onboarding | Admin CSV via `/admin/loader` | Hand-wired SQL migration (080) |
  | Trades registry | Global `trades` table + FK constraints | `trade` text column on existing tables (legacy pattern) |
  | Intake fields | Generic schema reused | **NEW** — roofing runs through its own `lib/roofing/` pipeline, NOT `lib/intake/structure.ts`. IntakeSchema's `['electrical','plumbing']` enum is unchanged (the Anthropic generateObject 24-optional-field cap is preserved). |
  | Estimator | Generic prompt + per-trade defaults | Roofing bypasses the strict-grounding estimator entirely — a deterministic $/m² × area × loading calculation, no Opus call on the price path. |

  **Roofing-specific decisions:**

  | Decision | Choice | Why |
  |---|---|---|
  | Measurement source | Geoscape Buildings + customer pitch declaration (Phase 1) → LiDAR via ELVIS (Phase 2) | Phase 1 ships fast and proves demand; Phase 2 lifts accuracy without changing the customer flow because the `lib/roofing/measure.ts` interface is provider-agnostic. |
  | Auto-send | **NO — every roofing quote requires tradie review** | Roof jobs are A$8–40k. The v6 Path-B auto-send rule does not apply at these dollar values. This re-introduces a Path-A flow specifically for high-value trades; logged as a deliberate exception, not a strategy reversal. |
  | Asbestos | Pre-1990 buildings + cement-sheet declaration → forced inspection route | Legal/safety. Australian Consumer Law + state asbestos regulations make any auto-quoted roof work on suspected asbestos a non-starter. |
  | Coverage fallback | Address outside Geoscape coverage → $99 paid inspection route | Same pattern as low-confidence electrical/plumbing intakes; the Stage 0 IG-engine validator pattern (`lib/ig-engine/validate-inputs.ts`, shipped 2026-05-29) provides the template. |
  | Pricing model | `$/m² × sloped area × multi-storey loading % × asbestos loading %` then tier-framed (patch / re-roof same material / upgrade) | Roofers price this way operationally; no per-line-item granularity needed. Deterministic — no Opus on the money path → no grounding validator needed for roofing. |

  **Phasing within roofing:**

  | # | Phase | Scope | Trigger to advance |
  |---|---|---|---|
  | 1 | Hand-wired seed + Geoscape measurement + dashboard tab + review-required routing | This iteration | First paying roofing tenant + 20 real quotes through the pipeline |
  | 2 | Real LiDAR pipeline (PDAL + Open3D over ELVIS) replaces Geoscape behind the same interface | Defer | Phase 1 volume + accuracy complaints justify the 4–6 week Python-worker build |
  | 3 | Roofing flows through the v9 admin loader once v9 Phase 0 ships | Defer | v9 Phase 0 exit gate green |

  **What stays unchanged from v8/v9:**

  - 4-agent architecture (Drafter / Reviewer / Inspection Coordinator / Conversion Engine) — roofing reuses the Reviewer and Inspection Coordinator unchanged
  - G/B/B tier framing
  - Paid-inspection fallback at $99
  - Mobile-first customer portal at `/q/[token]` — extended with a roof-hero strip, otherwise unchanged
  - Stripe deposit + booking flow
  - The Path-B auto-send default for electrical/plumbing — roofing is an explicit per-trade override

  **What's OUT of scope for v10:**

  - The real LiDAR pipeline (deferred to roofing Phase 2)
  - Asbestos detection from satellite imagery (out — relies on the customer's pre-1990 declaration; not the right tool to ML this)
  - Roofing-specific intake structurer (out — the deterministic flow does not need one)
  - Multi-line-item roofing breakdowns at the customer's quote level (out for v1 — single sloped-area × rate line, with tier-level material variation)
  - Voice channel for roofing intake (out — address-first web form is a much better intake channel than SMS/voice for this trade)

  **Trigger for the next iteration:**

  - 20 roofing quotes processed end-to-end → backfill Phase 2 LiDAR decision with real volume + accuracy delta data
  - Customer complaint pattern emerges (under-quote / over-quote) → record the diagnosis + the patch
  - Second roofing tenant onboards in a different state (VIC/QLD) → record any state-specific licence/regulatory adjustments needed

- **v11** (2026-06-12): **commercial painting — document-driven takeoff as an estimator extension, not a new trade seed.**

  **What's settled:**

  Commercial painting ships as a tradie-facing dashboard tool (its own "Commercial Painting" tab) that turns uploaded construction documents (plan set required; measurement takeoff / services layout / site photo optional) into a confirmed surface-by-surface takeoff and a **single tender-style quote** — labour (hours / crew / days), materials (litres / products / $), equipment — plus a Gemini "after repaint" preview. Pilot job: IGA Swan Street, 480 Swan St, Richmond VIC (Sarris AS73 rev CP1). Full design: `docs/superpowers/specs/2026-06-12-commercial-painting-estimator-design.md`.

  **Why this departs from v9/v10 (intentionally):**

  This is NOT a trades-as-data seed (v9) and NOT a hand-wired customer-intake trade (v10 roofing). It extends the **Estimator Beta** plumbing the way electrical plan estimation did: `plan_uploads`/`plan_extractions` gain a `trade` column (`'commercial_painting'`), a `paint_runs` grouping table owns multi-file runs, and a `paint_rates` reference table (trade-scoped, tenant-overridable, migration-seeded with researched AU commercial defaults flagged `is_default`) carries coverage/spread/modifier rates. The residential painting flow (`lib/painting/`, address-derived $/m² × G/B/B) is untouched and coexists.

  | Area | v9/v10 pattern | v11 reality |
  |---|---|---|
  | Entry point | Customer intake (SMS/voice/web form) | Tradie uploads documents in the dashboard |
  | Quote shape | G/B/B tiers | Single tender price + optional separate-price line items |
  | Pricing | shared_assemblies catalogue / $-per-m² heuristic | Pure-TS pricer over `paint_rates` (coverage m²/hr, spread m²/L, height/prep/sundries modifiers); unmatched lines returned unpriced — no LLM in the money path |
  | Confidence fallback | $99 paid inspection route | No $99 route — commercial quotes always pass the human confirm step; low-confidence takeoffs (>50% area in low-confidence lines) get a "site measure recommended" banner |
  | AI usage | Opus intake structuring | Sonnet 4.6 doc classification + Opus 4.8 page-by-page takeoff extraction, with reconciliation against an uploaded measurement takeoff (deltas >10% flagged, nothing silently preferred) |

  **Decisions:**

  | Decision | Choice | Why |
  |---|---|---|
  | Audience | Tradie-facing dashboard tool first | The confirm-the-takeoff step IS the product trust mechanism; a customer portal can come later without rework |
  | Architecture | Extend Estimator-Beta plumbing; do NOT fork the workspace | One editable-takeoff pattern to maintain; painting-specific columns/panels are new components only |
  | Rates | Migration-seeded AU commercial defaults, `is_default = true`, tenant-overridable | Ship now, tune with a real painter before production quoting; the flag makes unvalidated rates auditable |
  | Auto-send | NO — tender quotes always reviewed in the confirm step | Same dollar-value logic as v10 roofing's review-required rule |
  | Preview | Gemini repaint preview in v1 (site photo → repaint-only edit) | Reuses the shipped ig-engine provider; failure is non-blocking |

  **Phasing:** 0 strategy gate (this entry) → 1 migration + `paint_rates` seed → 2 upload & classification → 3 extraction + reconciliation (pure cores, TDD) → 4 confirmation editor → 5 pricer + quote output → 6 repaint preview → 7 acceptance against the four IGA documents.

  **What stays unchanged:** money-path discipline (tool-calling/pure-TS only, grounding by reference data), migrations + run-script convention, ex-GST stored / inc-GST displayed, Maintain design system on all tradie-facing UI, residential painting flow, the v9 registry ambition (commercial painting's `paint_rates` rows are shaped to be loader-adoptable when v9 Phase 0 lands).

  **Out of scope for v11:** customer-facing upload portal, duct/services painting as a scoped option, multi-colour scheme previews, exterior access engineering (swing stages), tender document generation beyond the established quote PDF pattern.

  **Trigger for the next iteration:**

  - A real painter validates/replaces the seeded `paint_rates` defaults → record the deltas and flip `is_default`.
  - First external commercial quote sent → backfill accuracy vs the painter's manual takeoff (the IGA pilot gives the baseline).
  - Demand for a customer-facing upload portal → that is a different auth/abuse surface; its own entry.

- **v12** (2026-06-16): **solar joins Path B — a clean estimate auto-releases to the customer; the Sun & Shade heatmap race is fixed with page auto-refresh.**

  **What's settled:**

  Solar drops the forced "Confirm & release" gate for the common case. A **clean** estimate (no guardrail flags, priced/non-inspection route) now auto-confirms and texts the customer at creation time — the same Path-B auto-send model electrical/plumbing already use. The change is gated by `SOLAR_AUTO_RELEASE` (default on; set `false`/`0` to revert to forced-confirm without a deploy). Separately, the customer quote page now auto-refreshes until the deferred Sun & Shade heatmap (and the auto-confirm) land, so a viewer who opens the quote mid-generation no longer has to manually reload.

  **Why this departs from the prior solar decision:**

  Solar was previously review-required (forced human-in-loop confirm), unlike electrical/plumbing's Path-B default. The tradie complaint was that nothing — including the heatmap and prices — showed until they clicked "Confirm & release," which read as "the estimate isn't done." Root-cause investigation (workflow `wud6e08dx`, 6 unanimous agents) found the heatmap delay was **not** caused by the confirm gate at all: the flux heatmap is generated in the estimate route's `after()` job (`applySolarSunAssets`) that runs seconds after the response, and the page is a one-shot server read — so the first view races ahead of the job. Confirm only *correlated* with the heatmap appearing because it happened to be the first re-render after the job finished. So two independent fixes: (1) auto-refresh the page so deferred assets reveal themselves, and (2) — on the user's explicit call — extend Path B to solar so a clean quote reaches the customer without a manual click.

  **The safety line that holds:**

  A **flagged** estimate is NOT auto-sent. The publish gate (`canShowPrices`) hides prices on a flagged row regardless of `confirmed_at`, so auto-sending one would text the customer a price-less link. Flagged (and inspection-routed) estimates stay forced human-in-loop — the "Confirm & release" button remains the path for a flagged estimate the tradie re-drafts clean. This keeps the liability backstop exactly where the dollar/credibility risk lives while clearing the gate for the clean majority.

  | Area | Prior solar | v12 solar |
  |---|---|---|
  | Clean estimate | Awaits tradie "Confirm & release" before any customer contact | Auto-confirms + texts the customer at creation (Path B), tradie notified after the fact |
  | Flagged / inspection estimate | Forced confirm | **Unchanged** — forced confirm; not auto-sent |
  | Heatmap on first view | Missing until manual reload / post-confirm re-render | Page polls (`HeatmapAutoRefresh`) and reveals it within seconds, no reload |
  | Kill-switch | — | `SOLAR_AUTO_RELEASE` (default on) |
  | Tradie notification | "review and confirm before it goes live" | "sent to your customer — review it here" for released; old wording retained for flagged |

  **Implementation:** release side-effects extracted to `lib/solar/release.ts` (shared by the manual confirm route and the new `autoReleaseSolarEstimate` after()-job); eligibility decided synchronously off `estimate.guardrail_flags`, re-checked on the freshly-read row inside `after()` so a Pylon-appended flag is still caught. Customer-facing auto-refresh via a small `'use client'` `router.refresh()` poller, capped at ~60s.

  **What stays unchanged:** money-path grounding discipline (the auto-release never re-prices — it stamps `confirmed_at` and fires the already-built customer SMS + CRM leads); the publish gate logic; redraft does NOT auto-resend (it preserves `confirmed_at`, avoiding customer spam); roofing + commercial painting remain review-required overrides; Maintain design system on the quote page.

  **Trigger for the next iteration:**

  - A clean estimate auto-sends with a number a tradie would have corrected → tighten the synchronous guardrails (or reconsider the clean-only line), and record the miss.
  - Pylon-appended flags arrive *after* auto-send often enough to flip prices off post-send for a real tenant → move auto-release behind the awaited enrichment instead of a synchronous decision.
  - The heatmap `after()` job routinely exceeds the auto-refresh cap → make heatmap generation faster or lazily on-demand, rather than widening the poll window.

- **v13** (2026-06-25): **roofing multi-structure selection — the read-time default becomes roof-only (main dwelling), and the Measurement Results page makes the included set unmistakable.**

  **What's settled:**

  A roofing measurement with **no persisted selection** (`included_indices` NULL/empty) now resolves to the **roof-only default — just the main dwelling** — at read time, instead of silently expanding to ALL detected structures. This aligns the reader with the save-time default (`primaryStructureIndices`), which already opted secondaries IN rather than out. The decision lives in one helper, `defaultStructureIndices` in `lib/roofing/selection.ts`, used by every reader (`resolveEffectiveIndices` — now takes the quote, not a bare count — `denormFromSelection`, `partitionRoofQuote`, and the `/m` + customer-page feeders). Explicitly-saved selections, **including migration-140's backfilled all-structures arrays**, are honoured verbatim — only a genuine NULL changes behaviour, so it is a no-op on real backfilled rows and a defensive correction on quote-less/edge rows. No schema or data migration; stored values are untouched.

  Alongside the default fix, the tradie Measurement Results page (`/m/[token]`) gains three display-only clarity affordances so a returning tradie is never surprised by a summed total: (1) an explicit `In job` / `Not in job` text pill on every structure card (state legible from text, not just card opacity); (2) when ≥1 secondary is included, the Combined-total block names the secondary count and their **marginal $ contribution per tier**, derived as `combined(included) − combined(included ∩ primary)` through the canonical `combinedTotalsForIndices` — never a second summation; (3) a non-blocking "showing your saved selection" notice that fires only when the set differs from primary-only. The read-only customer quote page (`/q/roof/[token]`) gains the included-structure count in its Combined-estimate header for parity (count only — no customer-facing $ breakdown).

  **Why this is a clarity + correctness change, not a money-path change:**

  This came out of a tradie (Jon) confusion review: a combined estimate summed multiple structures and read as a bug. Investigation confirmed the summation, persistence, and at-least-one-structure guard are all working-as-designed — the only true defect was the latent "NULL = all" reader default (a never-touched record over-counted) plus the absence of any UI signal of which structures fed the total. So the money path is untouched: `combinedTotalsForIndices` → `narrowQuoteToStructures` remains the single source of truth, dashboard ↔ customer ↔ PDF parity is preserved byte-for-byte, inspection-routed structures stay listed-but-$0, and the PATCH route's denorm recompute + `pdf_path` busting are unchanged.

  | Area | Prior roofing | v13 roofing |
  |---|---|---|
  | NULL/empty `included_indices` at read time | Expands to ALL structures | Roof-only default (main dwelling) via `defaultStructureIndices` |
  | Explicitly-saved selection (incl. backfilled "all") | Honoured | **Unchanged** — honoured verbatim |
  | `/m` per-structure state cue | Card opacity only | Explicit `In job` / `Not in job` pill (+ opacity) |
  | `/m` combined total | Count + area | Count + area + secondary count + per-tier marginal $ |
  | Customer combined header | Area only | Area + included-structure count (still read-only) |
  | Summation source of truth | `combinedTotalsForIndices` | **Unchanged** |

  **What stays unchanged:** money-path grounding discipline (no new reducer; the marginal-$ figure is two calls to the canonical helper); the save-time primary-only default; persistence side-effects; the at-least-one-structure guard (client + server 400 `no_structures`); the customer page staying read-only (narrowable only by `?s=`/SMS, never widenable); Maintain design system on all surfaces.

  **Trigger for the next iteration:**

  - A tradie wants the customer page to also show the secondaries' $ contribution (currently count-only) → flip the customer-facing breakdown on and widen the test matrix.
  - The roof-only read default surprises anyone relying on the old "NULL = all" behaviour on a quote-less row → reconsider, but the fix is to persist an explicit selection, not to restore the silent all-default.

- **v14** (2026-07-15): **roofing semantic-edge candidates — Google Solar and Geoscape provide reviewable topology evidence, not survey-grade measurements.**

  **What's settled:**

  Google Solar's plane, DSM, RGB, and mask layers can be combined with the
  Geoscape building footprint/height context to construct *candidate* ridge,
  hip, valley, and eave runs for the selected main dwelling. Neither provider
  returns these semantic line types directly, so this is a deterministic,
  feature-flagged reconstruction and review workflow rather than a vendor
  measurement API.

  The current form/footprint estimate remains the fallback. Candidate generation
  does not alter quote totals, customer PDFs, or the existing roofing
  review-required release gate. A tradie must explicitly use candidates for an
  indicative draft or approve/edit individual runs before approved totals enter
  the existing deterministic repricing path. Eave candidates remain roof-boundary
  measurements, not automatic gutter claims; box gutters stay manual.

  **Why this is a bounded bridge, not a Phase 2 replacement:**

  v10 deferred a full LiDAR pipeline until roofing volume and accuracy evidence
  justified it. The new feature reuses already-available Google Solar data to
  make the current Measurement Results page more auditable: it shows the
  numbered facet assignment, coloured semantic candidates, confidence, imagery
  dates, and an explicit tradie review surface. It does not claim the precision
  or coverage of a dedicated LiDAR pipeline. Google/Geoscape source-date and
  footprint alignment conflicts are a visible **needs review** condition, not a
  value to silently merge.

  **Phasing:**

  1. Build labelled evaluation fixtures and source-alignment gates.
  2. Ship read-only, server-side candidate analysis for the main dwelling behind
     a tenant feature flag.
  3. Add the topology-evidence review panel and audit actions.
  4. Permit explicit candidate drafts, then approved-only canonical repricing
     after roofer calibration.

  **What stays unchanged:** roofing is review-required; money remains
  deterministic; customer pages stay read-only; multi-structure selection
  remains authoritative; raw provider credentials stay server-side; and the
  Phase 2 LiDAR decision remains a separate volume/accuracy gate.

  **Trigger for the next iteration:**

  - Roofer-labelled results show candidate count/length accuracy is insufficient
    after calibration → keep it evidence-only or advance the LiDAR decision.
  - A provider term, entitlement, or imagery-retention rule prevents the planned
    evidence surface → redesign persistence/visualisation before rollout.
  - Pilot tradies consistently approve the candidates with low correction rates
    → record thresholds and consider widening the tenant feature flag.

- **v15** (2026-07-15): **Google Solar is a prototype-only roofing source until a commercial-use gate is cleared.**

  **Correction to v14:**

  The current Google Maps Platform Service Specific Terms restrict Solar API use
  to energy-system feasibility, design/installation, or downstream energy
  transactions, and restrict Solar Data caching to 30 days except for fixed
  media in an energy-system downstream transaction. A general reroof
  measurement/quote does not clearly fit that permitted use. Therefore the
  v14 Google Solar proof of concept must not be promoted into production roofing
  measurement without written Google permission that covers the intended use,
  retention, derived geometry, evidence image, and attribution model.

  **What's settled:**

  The roofing topology feature remains valid as a source-agnostic,
  review-required product capability, but production has two legal/commercial
  paths: written Google approval, or a separately licensed Australian
  aerial-DSM/3D/LiDAR source that permits rooftop take-offs. Until one path is
  approved, Geoscape/form estimates and manual tradie overrides remain the
  production flow; the Solar prototype is research-only.

  The future implementation also records three non-negotiable money-path
  constraints exposed by the review: generated candidates never mutate a
  customer-visible quote; approved hip/valley **surface lengths** must override
  the current count-to-average-length fallback explicitly; and a topology quote
  revision must pin the original pricing-book/rate-card snapshot rather than
  reloading current tenant rates.

  **What stays unchanged:** no auto-send for roofing; mandatory tradie review;
  Geoscape is context/footprint enrichment rather than a semantic-edge API; and
  Phase 2 LiDAR remains a separate accuracy/volume decision.

  **Trigger for the next iteration:**

  - Written Google permission is obtained → record the precise scope, retention,
    attribution, and display obligations before enabling an adapter.
  - A licensed roof-geometry supplier is selected → record its coverage,
    commercial rights, data-retention policy, cost, and evaluation result.
  - Neither path is commercially viable → keep topology evidence/manual-only and
    revisit the LiDAR investment decision with pilot demand data.

- **v16** (2026-07-22): **the booking funnel is PAY-FIRST on every trade; WP6 "book first, pay last" is superseded for deposit tiers.**

  **What changed:**

  Every customer funnel now runs one order — quote → Stripe → pick a time →
  thank-you — across three distinct pages: the customer-view page, a booking
  page that shows only a calendar, and a thank-you page that carries the
  tradie's video, the amount actually paid, the booked slot, the booking
  reference, and add-to-calendar links.

  **Why the previous decision was reversed:**

  This supersedes the book-first lines in **v8** ("book-first funnel (WP6) is
  unchanged", and discount realisation placed at `POST /api/q/[token]/book`) and
  **v9** ("book-first funnel (WP6) is unchanged"). Both entries stand as
  history; the ordering they assert no longer holds.

  The WP6 reorder made deposit tiers book-first so a customer never paid before
  a time existed. In practice the codebase had already drifted into three
  different orders: the $99 inspection went pay-first in 2026-07-17
  (five-sections R7/D1a), and the roofing and painting surfaces were pay-first
  from the start ("these jobs book AFTER paying"). Only the electrical/plumbing
  deposit path remained book-first. Maintaining two funnel orders meant two sets
  of page states, two pickers that had already diverged in behaviour, and a
  reserve/finalise split in the booking API that existed solely to serve the
  book-first case.

  Consolidating on pay-first also removed a live defect: an unpaid deposit with
  no slot resolved to `kind: 'book'` → `/q/<token>/book`, whose no-slots CTA
  pointed straight back at `/r/<token>/<tier>`. A tenant with no published
  windows could never reach checkout at all.

  **The risk this accepts, and its bound:**

  Customers now commit money before seeing any times, and a deposit is a much
  larger sum than the $99 fee that set this precedent. That is bounded by
  `canTakePayment()`: no Stripe Session is minted for a tenant with zero
  bookable windows on any funnel — the customer is returned to the quote with
  "we'll text you to arrange a time" and is not charged. The residual exposure
  is a customer who dislikes every offered window after paying, which the
  refundable-deposit position and the tradie-arranges-a-time SMS path already
  cover.

  **Money-path consequences that had to move with it:**

  The early-booking discount was realised when a customer committed a time, on a
  branch that only ran for unpaid quotes. Pay-first makes that branch
  unreachable, so realisation moved to the Stripe mint — otherwise the discount
  would have silently stopped applying for every customer. Separately, the trade
  measurement tables recorded `paid_tier` but no amount, so a confirmation page
  could only infer "$99" from a constant; migration 181 adds
  `paid_amount_cents`, stamped from the Stripe Session.

  **What stays unchanged:** the $99 inspection remains pay-first; already-paid
  quotes are never re-charged; a lapsed price hold still blocks booking; slot
  generation, tier pricing and the estimate pipeline are untouched.

  **Trigger for the next iteration:**

  - Pilot data shows deposit conversion dropping against the book-first
    baseline → revisit, with the no-slots guard's block rate as the control.
  - A tradie reports a customer paying and then rejecting every window →
    record how often, and consider a "see times before paying" preview that
    does not hold a slot.

- **v17** (2026-07-26): **the roofing and painting SMS receptionists become LLM-driven conversations (Sonnet 5), with deterministic code retained as the money path.** Supersedes the "zero LLM in the customer-facing flow" property of **v10**.

  **What changed:**

  The roofing and painting receptionists were pure regex state machines. Every
  customer-facing string was a literal template selected by keyword, and the
  machine assumed each inbound message answered the question it had just asked.
  `lib/sms/model.ts` documented this explicitly and forbade an LLM step.

  From this iteration, `claude-sonnet-5` decides every customer-facing turn on
  those two trades — greetings, questions, refusals, trade switches, and asking
  for missing job details in natural language. With electrical and plumbing
  already on the same model (`lib/sms/dialog.ts`), **every SMS receptionist the
  platform runs is now AI driven**, not just some of them.

  `SMS_LLM_RECEPTIONIST_ENABLED` **defaults to ON**. It shipped default-OFF for
  one working session so the behaviour could be proved against the live model
  before customers saw it; that pass found four defects no mocked test could
  (see below) and, once fixed, the flag inverted to opt-out. `0` is the kill
  switch for every tenant, effective on the next inbound with no redeploy; a
  comma-separated tenant-id list narrows back to a pilot.

  The deterministic state machines are deliberately NOT deleted. They are the
  per-turn fallback — the thing that answers when the model times out or writes
  a figure no tool produced. Removing them would mean a provider outage drops
  leads, which is the failure this platform can least afford.

  **Why — four live defects that a keyword machine cannot fix:**

  Reproduced against the deployed code on 2026-07-26 (QM Sparky, `+61468048422`,
  a roofing flow parked at `await_booking`):

  1. `"Hi there"` → `{action:'booking', confirmed:true}`. The booking arm read
     `confirmed: !isNegative(inbound)`, so **a greeting booked an inspection**.
  2. `"No i dont want a roofer"` → `looksLikeRoofingEnquiry` keyword-matched
     "roofer" with no negation model, so **a refusal re-opened roofing**.
  3. `"Not roofer i want electrical work"` → the roof-word veto inside
     `namesOtherTrade` returned false, so **the trade switch was blocked** and
     the address parser answered instead: *"Sorry, I didn't catch a property
     address there."*
  4. `"Hey!"` → the roofing address was asked a third time, because nothing
     recorded that the customer had already refused.

  Each is the same root cause wearing a different hat: the machine has no
  concept of negation, consent, or a question. Every prior round answered one of
  them with another regex, and each new regex created the next defect — the
  roof-word veto in #3 was itself the fix for an earlier bug. Widening the
  vocabulary again is not convergent.

  **What did NOT change — the boundary that makes this safe:**

  The LLM drives the CONVERSATION. Deterministic code still owns the MONEY. The
  model returns a tool choice plus the slots the customer supplied; that choice
  is mapped onto the existing `RoofingTurnDecision` / `PaintingTurnDecision`
  unions, so `measureAndPriceRoofs`, `priceMultiRoof`, `lib/sms/roofing-compose`,
  `verifyAuAddress` and `lib/painting/pricing` are **called, never modified**. No
  price, area, structure count, measured address, quote link or booking
  confirmation may originate in model text — enforced by a grounding validator,
  not by prompt instruction alone. This mirrors the estimation discipline
  already settled in **v5/v6** (tool-calling only plus a validator, with the
  inspection route as the backstop).

  This also supersedes the v10 line "Deterministic — no Opus on the money path →
  no grounding validator needed for roofing". That remains true **of the money
  path**: no model writes a price. But a separate *conversational* grounding
  validator now gates every model-authored reply, and money is grounded only
  against tool output — never against the customer's own text, or a customer
  could authorise a figure by typing it. v10 stands as history.

  **The properties that make regression structurally hard, not merely tested:**

  - One env switch, default ON, revertible in seconds. `=0` puts every tenant
    back on the deterministic machines at the next inbound, with no redeploy
    and no state cleanup (the two fields this adds are additive and the old
    path ignores them).
  - Fail-open. Any throw, timeout, unusable shape or grounding violation
    returns the deterministic decision for that turn. A model outage cannot
    drop a lead or dead-end a customer. The model call carries a hard deadline,
    because a provider that hangs rather than throwing is the failure mode that
    would otherwise send nothing at all.
  - The money modules are untouched, checkable with `git diff --name-only`.
  - Opt-out (STOP) is decided deterministically **before** the model is called.
    Compliance is not a judgement call.
  - A greeting can never book, on either path. Where the deterministic fallback
    would have read one as consent, the LLM path re-asks instead.

  **The risk this accepts, and its bound:**

  A conversational model can say something wrong. The bound is that the only
  thing it can be wrong ABOUT is prose: the grounded fact block carries the
  business name, owner first name, trades and service state and nothing else,
  so licence numbers, ABNs, insurance and contact details cannot be stated at
  all. Anything outside those facts is deflected with an honest "I'll check and
  come back to you" plus a tradie alert, because a fabricated fact about a
  tradie's business is worse than no answer.

  **Trigger for the next iteration:**

  - The grounding validator fires in production more than rarely → the prompt
    is losing, and the tool surface (not the wording) needs to absorb whatever
    the model keeps trying to say itself.
  - A declined trade needs to be re-openable within one conversation → today a
    refusal is final for that thread. That is deliberate (it is the fix for
    defect #2) but it is the first thing to revisit if customers are observed
    changing their minds mid-thread.
  - Turn latency pushes the SMS reply past the webhook budget → move the
    conversational turn behind the existing `after()` boundary rather than
    trimming the model.

- **v18** (2026-07-29): **the SMS route does not choose a receptionist per message, and the intake handoff had no trade guard.** Corrects a load-bearing claim in `CLAUDE.md` and records money already taken wrongly.

  **What was believed, and what is true:**

  `CLAUDE.md` described `/api/sms/inbound` as fanning out to four receptionists
  "depending on the tenant's trades **and the message**". The second half is
  false. `shouldEngageRoofing` (`lib/sms/roofing-receptionist.ts:968`) is
  `canResume = isActiveRoofingFlow(prev) && !followupPinActive; if (canResume)
  return true` — it never inspects the inbound text. `route.ts:2185-2187` then
  returns before `extractSlots` at `:2353`. On a tenant holding roofing, an
  active roofing thread captures **every** subsequent turn, and the
  electrical/plumbing dialog is unreachable for the life of that thread.

  **The money consequence, found by following that thread.** `IntakeSchema.trade`
  is `z.enum(['electrical','plumbing'])` — it cannot represent roofing — and
  `deriveTradeFromJobType` maps anything unrecognised, including `'other'`, to
  `'electrical'`. The handoff at `route.ts:3735` was gated only by
  `sideEffectsAllowed`, which had no trade signal. Roofing enquiries therefore
  minted **electrical** intakes and real $99 electrical inspection quotes:
  `8d02aa98` was **paid**, `d1d3cc6c` **accepted**, `7030df6c` viewed, and
  `530bd60b` sat at **$0.00** in `tradie_review`. One of those customers had a
  $73,522 roofing estimate. Fixed by adding an `otherTradeActive` signal to
  `sideEffectsAllowed`, derived from `roofing_state`/`painting_state.last_step`
  only — deriving it from `slots.job_type` would suppress all SMS quoting,
  because that field is null on every conversation since 2026-07-08.

  **What was NOT a defect.** Every electrical intake from 2026-07-08 to 07-28
  carried `job_type='other'`, which looked like a classifier regression that had
  silently disabled the WP9 catalogue product offer. It is a **traffic
  artefact**: three `power_points` intakes on 07-29 classify correctly, and the
  offer gate reads `decision.job_type_guess` (`route.ts:3388`), an enum that does
  not contain `'other'` at all. Both were downstream symptoms of the roofing
  capture above. Recorded here so it is not "fixed" again.

  **Reading this against v17.** v17 credits the LLM with handling "trade
  switches", and that remains true at the *conversational* layer — the model can
  acknowledge a customer changing trade and reply sensibly. What v18 adds is that
  the *route* cannot act on it: the receptionist that owns the thread is chosen
  before the model is consulted, so an acknowledged switch does not re-route the
  turn. The two statements describe different layers, not a contradiction.

  **R9 sanity bounds modelled labour as proportional when it is affine.**
  `checkSanityBounds` compared `totalLabourHours / quantity` against
  `per_unit_labour_hours × 1.75`, which divides every FIXED cost by the item
  count and makes the cap tightest exactly where fixed costs dominate — at
  quantity 1. Consequence: on the three tenants whose
  `pricing_book.min_labour_hours` is 2.00, **every single-item `power_points` or
  `downlights` quote failed R9 unconditionally** and was routed to the $99
  inspection (intake `5350290e`), and a recipe's one-off cable run was charged
  per unit (intake `0c39d4c2`). Now `cap = max(minCharge, per_unit × n × 1.75) +
  recipeOneOff`, with `max` rather than a sum so the floor and the scaled
  allowance cannot stack. All five `job_type_bounds` rows remain flagged
  `PROVISIONAL — confirm with tradie`; no migration shipped.

  **The two internal quote routes are no longer anonymous.** `POST /api/estimate/draft` and
  `POST /api/intake/structure` mint quotes, Stripe sessions and customer SMS, and
  both accepted unauthenticated calls — `proxy.ts:20` is a bare
  `clerkMiddleware()` that gates nothing. Both now require the shared secret via
  the already-tested `isCronAuthorised`, and all six internal callers send it.
  ⚠ The guard is fail-closed in production, so `CRON_SECRET` must be present in
  Vercel Production **and Preview** or every intake channel stops producing
  quotes on that deployment (`NODE_ENV` is `'production'` on Vercel Preview too,
  so Preview takes the strict branch). ⚠ This does **not** close every door:
  `/api/vapi/webhook` still has no authentication of its own — no Vapi server
  secret exists anywhere in the repo — so the pipeline stays reachable through
  it. Scoped out of this change deliberately; it needs its own fix.

  **Deliberately deferred:** making a live roofing thread yield mid-conversation
  when the customer asks for another trade. That changes which receptionist wins
  a turn on the two tenants holding all eight trades, and the eval harness is
  only partially built — it needs its own regression corpus first.

- **v19** (2026-08-05): **painting adopts roofing's model — the flat $99 refundable site visit is the ONLY customer payment; the 30% tier deposits are retired from every customer surface.** Owner decision.

  **What changed:**

  A residential painting customer is never asked for a tier deposit again. Every
  actionable unpaid quote — prices released by the tradie, or routed to an
  on-site measure — offers one action: accept and pay the flat $99 refundable
  site visit, credited toward the final quote, with the booking happening AFTER
  payment. The Good/Better/Best prices stay visible as pricing information; the
  final price is confirmed on site. Held-for-review quotes still pay nothing
  anywhere.

  **Why the previous decision was reversed:**

  This supersedes the "G/B/B handling byte-for-byte unchanged" clause of the
  painting-funnel-parity spec (2026-08-05), which had extended the funnel with a
  $99 path for inspection-routed rows only while leaving released rows on the
  30% deposit. Two payment models on one trade meant two page states, two mint
  branches and two SMS shapes, and the deposit branch was the one asking a
  customer to commit thousands of dollars against a price nobody had yet
  confirmed on site. Roofing has never done that: it sells a visit, then prices
  the job. Painting now matches, so the funnel copy, the mint gate and the
  receptionist SMS all promise the same thing.

  **How old links keep working:**

  Every previously-texted deposit link (`/r/paint/<token>/good|better|best`)
  302s onto `/r/paint/<token>/inspection` rather than 404ing or minting a
  deposit, and a held row gets a friendly 302 back to the quote page's holding
  message instead of a bare 400. The 30% Session-creation code
  (`createPaintingCheckoutSessionForTier`) stays in the codebase, unreachable
  from the route — retired, not deleted, so a reversal is a routing change
  rather than a rebuild. ⚠ Draft/edit still mints per-tier Sessions into
  `painting_measurements.stripe_links` (`lib/painting/quote-dispatch.ts`) as a
  dormant record; no customer surface links them, and nothing reads them back —
  a cleanup, not a live path.

  **Asset gap:** the flow SVG's "Customer accepts & pays deposit" box and its
  $199 inspection figure (`assets/quotemate_flow_with_inspection.svg`) remain the
  electrical-era funnel — a second unacknowledged deviation on top of the
  auto-send one logged in v6.

  **Money-path consequences:**

  Painting's only customer charge is now the $99 site visit, which mints through
  `createPaintingSiteVisitSession` with Connect routing (`transfer_data` +
  platform `application_fee`) exactly like roofing's. That closes the
  long-standing "painting deposits bypass Stripe Connect" gap by removing the
  path that bypassed it — the tradie's connected account receives the visit fee.
  `canTakePayment()` still gates the mint, the publish gate is untouched, and
  the Stripe webhook is unchanged (it already records `paid_tier` verbatim, so
  `'inspection'` lands correctly).

  **What stays unchanged:** painting remains review-required — a customer sees
  no price until the tradie releases; commercial painting (a separate stack)
  keeps its own delivery rule; no other trade's pages or mints move.

  **Trigger for the next iteration:**

  - Painters report the $99 visit converting worse than the deposit did, or ask
    to take a real deposit at the point of acceptance → revisit, using visit
    bookings per released quote as the control.
  - Painting deposit volume becomes material again → the retired 30% path is
    still in the codebase; re-enabling it is a routing change, and this entry
    is the record of why it was switched off.

- **v20** (2026-08-06): **electrical and plumbing adopt the same model — the flat $99 refundable site inspection is the only customer payment; the 30% tier deposit is retired from both trades.** Owner decision.

  **What changed:**

  An electrical or plumbing customer is no longer asked for a tier deposit. The
  Good/Better/Best prices stay **visible** wherever they already appeared — the
  quote page, the PDF, the SMS (all unchanged in what they *print*) — they are
  information, not something to transact against — and the
  single action is: accept, pay the flat $99 refundable site inspection
  (credited toward the final quote), then pick a time. The tradie confirms the
  final price on site. `/r/<token>/good|better|best` 302s onto
  `/r/<token>/inspection`, so every deposit link already sitting in a customer's
  SMS thread still lands on a payable page.

  **The data that drove it** (queried from the live Supabase instance on
  2026-08-06 and carried in via `specs/elec-plumb-site-visit-first.md` — the
  figures are a point-in-time read, not re-derivable from this repo; re-run the
  query before citing them again):

  The $99 path converts at **14.8%** on electrical (4/27) against **3.2%** for
  the 30% deposit (3/93); plumbing's deposit path has **never** converted
  (0/53). The average deposit ask was **$249 electrical / $425 plumbing**
  against an AI-drafted price nobody had confirmed on site. The deposit was not
  a weaker offer of the same thing — it was a different, much larger ask made at
  the wrong moment.

  **What this completes:** roofing, painting, electrical and plumbing now sell
  the same first step — a paid site visit, then a confirmed price. **Solar and
  commercial painting keep per-tier deposits**, and they share the *same*
  `/q/[token]` page and `/r/[token]/[tier]` mint as electrical/plumbing, as do
  the roofing rows that live on the `quotes` table. The gate is therefore an
  **allowlist of exactly `['electrical','plumbing']`** read off the raw
  `intakes.trade` (`lib/quote/mint-tier.ts`), and it **fails open**: a trade that
  cannot be resolved keeps today's deposit behaviour, because an unknown trade is
  not provably one of the two. A blocklist here would have silently killed
  roofing's deposit path.

  **What was deliberately NOT touched:**

  `needs_inspection` was not repurposed. It force-nulls the G/B/B tiers by design
  (an Opus-drafted inspection quote may not ship fabricated prices), so those
  rows have no prices to show and were already $99-only — their behaviour is
  unchanged. This decision targets the `needs_inspection=false` majority (78% of
  electrical, 82% of plumbing): prices still shown, $99 charged instead of a
  deposit. The grounding validator, `lib/routing/decide.ts`, the Stripe webhook,
  `resolveAcceptView`/`resolvePayRedirect`/`resolveMintDiscount` and the roofing
  and painting funnels are all unchanged; the trade gate lives entirely at the
  call sites.

  **Two knock-on consequences worth naming:**

  - The **early-booking discount is now unreachable** for these two trades. It is
    realised at the G/B/B mint (`resolveMintDiscount` excludes `'inspection'` and
    stays untouched), so the countdown banner is suppressed for them rather than
    advertising a saving they can never earn. An already-realised discount still
    renders.
  - The **7-day price hold no longer gates anything** for them: the $99 has no
    hold. That also fixed a live dead-end — `/q/[token]/book` showed "price
    expired" to an unpaid electrical visitor whose hold had lapsed, instead of
    sending them to the payment that was still open.

  **The retired path:** `createCheckoutSessionsForQuote` (the draft-time 3-tier
  mint) stays in the codebase, unreachable for these trades — the same treatment
  painting gave its tier mint in v19. Re-enabling is a routing change, not a
  rebuild.

  **Asset + doc gaps still open** (v19 logged the first, v20 removes the last
  generic-funnel trades that justified it): `assets/quotemate_flow_with_inspection.svg`
  still draws "Customer accepts & pays deposit" / "Deposit received" and a $199
  inspection figure — now wrong for four of the six trades on that flow, and
  wrong on the fee everywhere. Two economics inputs above this history also now
  rest on solar + commercial painting alone: §4's "platform fee on deposits"
  ARPU line, and §11's "≥1 deposit collected" pilot-exit criterion, which has
  been unreachable for painters since v19. Recorded, not silently corrected —
  the numbers need a fresh pass, not a find-and-replace.

  **Trigger for the next iteration:**

  - The $99 conversion advantage does not hold at higher volume, or sparkies ask
    to take a real deposit at acceptance → revisit, using visit bookings per sent
    quote as the control (the same measure v19 set for painting).
  - Solar or commercial painting want the same model → it is one entry added to
    the `SITE_VISIT_FIRST_TRADES` allowlist, but their funnels have their own
    review gates and should get their own decision, not a quiet widening.

- **v21** (2026-08-07): **residential painting joins auto-send — the tradie review gate is retired; a priced quote is released at draft time and texted to the customer immediately.** Owner decision. Supersedes the "painting remains review-required" clause of **v19** and the review-required half of **v11**.

  **What changed:**

  The two origins that used to draft-and-hold — the SMS/voice receptionist
  (`lib/sms/painting-estimate-dispatch.ts`) and the self-serve form
  (`/api/paint-request/[token]`) — now stamp `released_at` when the estimate is
  saved, exactly as the dashboard path has always done, and send the customer
  the **full quote** instead of a holding message: tier prices, the
  `/q/paint/[token]` page, the PDF, and the one $99 site-visit link. Painting
  now behaves like roofing, electrical and plumbing. Inspection-routed rows are
  untouched — they have no price to show and keep their on-site-measure
  message.

  **Why the gate's rationale is gone:**

  It existed because painting prices are *inferred* (Google Solar footprint +
  street-view area) and the customer was being asked for a **30% deposit** —
  roughly $6,400 on a $21,432 quote — against a number nobody had checked. v19
  removed that: the only customer payment is the flat **$99 refundable site
  visit**, with the final price confirmed on site. A human check between an
  inferred estimate and a $99 refundable booking buys nothing, and it costs the
  customer the wait.

  **And the gate was failing silently.** Verified against production
  2026-08-06: of 8 recent releases **3 sent no SMS at all** — every one of the 8
  had a `customer_phone` on file, so a missing mobile does not explain it. The
  route stamped
  `released_at`, ran the send in `after()`, discarded
  `sendPaintingQuoteToCustomer`'s `{ sent }` and answered `{ ok: true }`
  unconditionally — so `/p` showed "✓ Sent to customer" while the customer got
  nothing. Underneath, the send itself returned `sent: true` off a bare `await
  sendSms(...)`, and `sendSms` *resolves* `{ ok: false }` on a Twilio
  rejection rather than throwing. A manual gate that drops a third of its sends
  is worse than no gate.

  **The invariant that replaces the gate**, stated precisely: *a painting quote
  is reported as sent only when a carrier accepted the message.* Two columns,
  two questions — conflating them was the whole bug. `released_at` (mig 157)
  answers *may the customer see prices*; it is stamped **before** the send
  because the quote page and the $99 mint gate on it, and a dashboard save
  stamps it while texting nobody. `quote_sent_at` (**mig 189**) answers *was it
  delivered*, and is written only after Twilio accepts. So: every send path
  returns `{ sent }`; the release endpoint answers `{ ok, sent }`; the "Send to
  customer" button reads `quote_sent_at` for its initial state and `sent ===
  true` for its result, offering a retry otherwise; a **first** send that fails
  rolls `released_at` back (`revertPaintingRelease`, which checks the write's
  `error` — supabase-js resolves rather than throws — and reports whether the
  rollback landed); and the tradie gets an alert saying in plain words that the
  customer received nothing.

  **What that does and does not guarantee.** No surface reports a delivery
  without carrier acceptance. It does **not** guarantee the customer read it —
  Twilio acceptance is not handset delivery, and no delivery-receipt webhook is
  wired. Two known gaps stay open, recorded rather than papered over: two
  simultaneous first-release POSTs can both stamp and send, and one failing
  reverts a row the other successfully texted; and a row with **no
  `customer_phone`** can now never reach a sent state from `/p`, because there
  is nothing to send to — the tradie must add a mobile first.

  **What was deliberately NOT touched:** the gate functions themselves.
  `canShowPaintingPrices`, `paintingDepositLocked` and `resolvePaintMintTier`
  keep their signatures and semantics — a genuinely unreleased row (a legacy
  held draft, or a rolled-back failed send) is still withheld from prices and
  from the mint. These two origins simply stop producing held rows. The money
  path is unchanged: the $99 mint, checkout and the Stripe webhook are
  identical. **Commercial painting and solar keep their own gates** — commercial
  painting is a separate stack with its own delivery rule, and solar's
  `SOLAR_AUTO_RELEASE` / `lib/solar/publish.ts` behaviour is unmoved. Neither has
  a line of diff.

  **Trigger for the next iteration:**

  - Painters report unwanted quotes going out, or want a hold back for a
    specific job class → the gate modules are intact; re-enabling is a
    `releasedAt` argument in `runAndSavePaintingQuote`, not a rebuild.
  - The auto-send failure alert starts firing regularly → the fault is in the
    send, not the policy; fix delivery rather than reinstating a human
    checkpoint that was itself dropping a third of its sends.

- **v22** (2026-09-01): **EV charger installs gain a narrow priced path for the electrical pilot; the blanket v3 inspection-only rule is retired for grounded single-phase jobs.** Owner-requested demo and receptionist correction.

  **What changed:**

  An electrical tenant may now draft a Good/Better/Best EV charger
  installation quote when the intake identifies the vehicle, charger supplier,
  location, switchboard distance and phase. The existing install assembly
  remains the labour/sundries authority. When the tradie supplies the charger,
  the selected tenant-catalogue unit is additive to that assembly; it never
  replaces the installation line. The dashboard draft remains held for tradie
  review, and the customer's only payment action remains the $99 refundable
  site visit recorded in v20.

  **The safety and pricing boundaries:**

  Explicit `three phase (on-site inspection)` answers are deterministically
  inspection-routed even if the structuring model disagrees. Existing danger,
  switchboard-capacity and explicit three-phase language remains inspection
  evidence. Charger-unit prices must come from the tenant's catalogue and be
  confirmed by the tradie; QuoteMax does not seed or infer Tesla, BYD or generic
  wallbox prices. A customer-supplied charger can therefore receive an
  install-only draft, while a tradie-supplied unit cannot be priced until an
  approved catalogue product is selected.

  **Why the previous rule changed:**

  v3 treated every EV charger enquiry as high-risk before the product had a
  five-question intake, deterministic phase gate, tenant service toggle or EV
  sanity bounds. Those controls now separate the bounded single-phase case from
  work that genuinely needs an inspection. The production symptom was more
  basic: Atomic Electrical's EV offering was disabled, so its SMS receptionist
  told an interested customer that EV installs were not offered. Enabling that
  tenant's offering keeps the demo coherent: SMS asks the existing mandatory
  charger questions instead of rejecting the job by name. The dashboard tool
  still prices independently of service toggles, as it did before; widening
  that gate to every tenant is outside this iteration.

  **What this does not change:**

  EV remains part of the existing electrical trade; this is not a fourth-trade
  expansion. Quotes never bypass the tradie's review, three-phase work never
  becomes priceable through this exception, and no deterministic EV BOM or
  charger market-price feed is introduced.

  **Trigger for the next iteration:**

  - The pilot electrician supplies approved unit prices and distance/cable-run
    rules → replace provisional bounds and prose-driven labour with a reviewed
    EV recipe/BOM.
  - Review edits or site visits show the bounded single-phase path is poorly
    calibrated → return the affected configuration to inspection routing rather
    than widening model discretion.

- **v23** (2026-09-03): **the job no longer ends at "site visit paid" — the tradie can issue a final quote, take a job-type deposit less the $99 already paid, and request the balance on completion, each charge on its own linked `quotes` row, with the 2% platform fee charged on top instead of deducted.** Owner decision, onboarding week. Extends **v20**; spec `quotemate-automation/specs/post-visit-money-sequence.md`.

  **What was blocking it:**

  v20 made the flat $99 site visit the only thing electrical and plumbing
  sell, and the product stopped dead there. The stop was structural, not
  cosmetic: a `quotes` row takes exactly one payment. `finalisePaidQuote`
  claims with `WHERE paid_at IS NULL`, the Stripe webhook skips any session
  for a row that already carries `paid_at`, and every tradie mutation — edit,
  chat-edit, document, tier PATCH, DELETE — 409s once it is set. The only
  post-payment action in the app *released* funds; nothing charged again. So
  "the price is confirmed on site, now what" had no answer in code. The pilot
  electrician put it plainly in onboarding week: stuck at the site visit, no
  way forward to a full quote and deposit acceptance.

  **The decision: chain rows, don't build a ledger.**

  Each customer charge is its own `quotes` row — `quote_kind` one of
  `initial | final | balance`, linked by `parent_quote_id` (mig 194, with a
  partial unique index making "at most one open child of each kind" a database
  guarantee rather than app code). The $99 initial row is untouched; the final
  row carries the price confirmed on site and takes the deposit; the balance
  row takes the rest. One-payment-per-row therefore stays literally true, and
  the webhook claim, the paid-redirect and the Connect payout release all keep
  working with no new branches.

  The alternative was weighed on touch-points, not taste: record the balance as
  a **second payment on the final row** — `balance_paid_at`,
  `balance_amount_cents`, `balance_fee_cents`, `balance_payout_id`, a webhook
  branch on `metadata.purpose` with its own claim, and a second release path.
  That duplicates the entire payment column set *and* the release path, which
  is precisely the money code where this repo has already grown silent-failure
  bugs (v21's three-of-eight releases that texted nobody). The third row costs
  one tier literal and a label. A proper `quote_payments` ledger stays the
  named later upgrade — it is not this build.

  **The 2% changes incidence, not size.**

  The platform fee has always been *deducted*: `application_fee_amount` comes
  off a destination charge, so a tradie quoting $10,000 settled $9,800. On the
  deposit and the balance it is now charged **on top** — `surcharge =
  platformFeeCents(base)`, `charged = base + surcharge`, and
  `application_fee_amount` is that **same variable** — so the tradie nets
  exactly the base they quoted and the customer sees a labelled "QuoteMax
  platform fee (2%)" line. The $99 site visit is unchanged: flat, fee deducted.

  The trap worth naming, because it looks equivalent and is not: charging
  `round(base × 1.02)` and then taking the fee as `platformFeeCents(charged)`
  is two roundings of two different bases, and it leaves the tradie about
  0.04% short on every job. One base, one rounding, one variable.

  **"Credited toward your final quote" becomes arithmetic.**

  Since the $99 shipped, that credit has been a Stripe product-description
  string and nothing more — no code subtracted it from anything, because there
  was nothing later to subtract it from. Now `deposit = max(0, round(T × pct /
  100) − 9900)` and `balance = T − 9900 − deposit`, with `9900 + deposit +
  balance === T` as a tested identity in every case including the edges. A job
  whose deposit would fall below the $99 already paid skips the deposit step
  entirely rather than charging a token amount.

  **Deposit % is per job type, and it is config, not code.**

  The ask that suits a $600 switchboard repair does not suit a $12,000 EV
  charger install; the pilot electrician wants 50% on EV work (v22's trade).
  So `pricing_book.overlays.deposit_pct_by_job_type`, keyed verbatim by
  `intakes.job_type` (`{"ev_charger": 50, "default": 30}`), resolved once and
  stamped onto the child row when the final quote is issued. Overlays because
  that is where per-tenant configuration already lives (mig 044) and it needs
  no schema change; out-of-range values fall back to 30 with the documented
  `clampDepositPct` semantics. No editor UI this iteration — Jon's map is
  seeded by SQL.

  **Two invariants stated unconditionally in CLAUDE.md are now scoped to
  `quote_kind='initial'`** — the drift note future engineers need:

  CLAUDE.md says `canTakePayment()` must gate **every** mint, and that the
  early-booking discount must be realised at the generic mint. Both are now
  true of initial rows only, and the narrowing is deliberate in each case. A
  child row has no site visit to book, so the bookable-slots guard would refuse
  a legitimate deposit on a tenant whose calendar happens to be full. And a
  child must never inherit an early-bird offer: the `early_bird_*` columns are
  deliberately not copied and `resolveMintDiscount` is skipped, because a stale
  parent offer would otherwise silently discount a price the tradie had just
  confirmed on site. The 7-day price hold is skipped on children for the same
  reason — they have no hold, and one derived from `created_at` would expire a
  link that should still be payable. And `/r/<child>/inspection` is refused
  outright: it would mint a second $99 that claims the child's only `paid_at`
  slot and permanently blocks the deposit. Anyone restoring the unconditional
  reading of either invariant breaks the sequence.

  **Entry point: SMS, and GHL stays deferred.**

  Leads arrive from a Meta ad that tells the consumer to text the tradie's
  QuoteMax number — the channel that already exists, handled by the out-of-repo
  Front Desk and per-trade receptionist services on Railway. No GHL webhook or
  status writeback: it is a second integration to keep alive before a single
  job has been through the sequence end to end, and Meta→SMS needs no code in
  this repo. ⚠ The dependency it creates is that the external receptionist must
  mint the initial `quotes` row through this app, or the chain has no root.

  **Two economics inputs v20 parked now move again**, recorded rather than
  quietly corrected: §4's "platform fee on deposits" ARPU line and §11's
  "≥1 deposit collected" pilot-exit criterion have rested on solar and
  commercial painting alone since v19/v20. Electrical and plumbing can take a
  deposit again — after the visit, against a price confirmed on site, with the
  fee on top rather than inside it — so both need a fresh pass, not a
  find-and-replace.

  **What was deliberately NOT touched:** solar, roofing, painting and
  commercial-painting money paths; the $99 initial flow for every existing
  tenant; the fee percentage (2% remains a platform constant — only its
  incidence moved). Roofing rows on `quotes` keep `quote_kind='initial'` and
  pass through `/r` exactly as before, which is why every new gate is a *kind*
  check layered on v20's trade allowlist rather than a blocklist. Refunds are
  still absent: the $99 is advertised as refundable on every surface and no
  refund path exists in code, so a declined final quote is handled by hand in
  the Stripe dashboard. Recorded, not fixed.

  **Trigger for the next iteration:**

  - A third charge appears on a job (variations, staged payments), or per-row
    payouts start confusing tradies → that is the signal to build
    `quote_payments` properly, not to lengthen the chain.
  - Deposits go routinely uncollected while the work proceeds anyway → the
    deposit is theatre for this trade; drop it and charge the balance only,
    exactly as v20 dropped the deposit that never converted.
  - The 2% surcharge draws customer complaints, or its GST treatment gets an
    accounting ruling → revisit the incidence before revisiting the number.
    Stripe's processing fees are platform-borne, so 2% charged on top nets
    QuoteMax roughly 0.3% — the fee is close to cost recovery, not margin.

- *Future iterations:* drill into specific phases (eval rubric details, onboarding flow design, hipages partnership terms, voice tier economics, full multi-tenancy refactor).


- **v24 (2026-09-08): SMS reliability and explicit customer quote approval.** The owner requested execution of `docs/audits/2026-09-08-sms-receptionist-reliability-audit.md`, including F17's instruction to preserve human approval. This supersedes the automatic customer release portions of v6 Path B, v12 and v21 for newly drafted quotes while preserving deterministic estimation, saved drafts and owner notifications. Electrical, plumbing, roofing, painting, solar and enabled quotation tools must record a draft, await an authenticated tradie release, and distinguish review, provider acceptance and delivery. A customer confirming a roof/address or choosing a product is not tradie approval. Existing authorised send operations remain the release boundary. Missing tenant pricing produces tracked setup/review, never default customer prices. This iteration repairs existing tools and does not add a new trade or promote voice to the v1 wedge. Durable receipts, fenced workers, one initial estimate identity and a delivery outbox are required before the repaired fleet can be called stable; deployment and controlled provider evidence remain separate release gates.

  Documentation reconciliation: the engineering trade table now records the existing commercial painting expansion in v11 and solar release-policy evolution in v12. Its earlier three-trade count had fallen behind the iteration log; this changes no supported trade or rollout gate.
