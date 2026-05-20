# QuoteMate — Strategy & Re-evaluation

> **Current iteration: v5 (2026-05-11).** v1 trade pivoted from **painting** to **electrical** in v3; v5 expands to **multi-trade** (electrical + plumbing) for a Brisbane plumber pilot. The prose in §1–§12 below is the v2 painting analysis, kept as audit-log record. See [Iteration history](#iteration-history) at the bottom for v3 (electrical pivot), v4 (photo-capture pattern), and v5 (multi-trade expansion) rationale.

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

- **`quotemate_flow_with_inspection.svg`**: customer enters via existing platform (hipages, Airtasker) → tradie opens QuoteMate → tradie *types* the job details → AI drafts quote. This is **portal-first**.
- **High-level design (in your prompt)**: customer dials the tradie's QuoteMate-provisioned number → AI receptionist captures everything → tradie wakes up to a draft. This is **voice-first**.

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
- hipages partnership conversation: "QuoteMate widget on every painter enquiry"
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

- *Future iterations:* drill into specific phases (eval rubric details, onboarding flow design, hipages partnership terms, voice tier economics, full multi-tenancy refactor).
