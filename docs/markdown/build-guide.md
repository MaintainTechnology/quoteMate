# build-guide

_Converted from `build-guide.html`._

---

  QuoteMate — Automation Build Guide (Stages 01 → 05)

[Q QuoteMate](#)

Automation Build Guide · **Stages 01 → 05**

Beginner Guide · Voice Automation Pipeline

# From the moment a customer dials, to a fully _drafted quote_.

A step-by-step walkthrough for building the **QuoteMate automation pipeline** — the part that picks up an inbound phone call, has an AI conversation with the caller, structures what was said, and produces a real quote. Stages **01 through 05** of the wireframe, in plain English.

Audience Beginner / first-time builder

End state Phone rings → AI drafts a quote

Stack Twilio · Vapi · Claude · Supabase

v3+ scope · Read before building

**This guide describes the voice-first pipeline.** Per [docs/strategy.md](strategy.md) and [CLAUDE.md](../CLAUDE.md), the QuoteMate **v1 wedge is portal-first** (typed intake on a webpage) — voice is deferred to the v3+ premium tier on COGS grounds (~$0.50–0.75 per call vs ~$0.07 for typed). The good news: **Stages 04 (Intake Engine) and 05 (Estimation Engine) are stack-identical for portal and voice** — the only thing that changes is Stage 03. Build the engines first; plug Vapi in front later when voice unit economics make sense.

**If you're building v1 right now,** follow Foundation 1 + 2 + Stages 04 and 05 in this guide, but skip Stage 02 (Twilio) and Stage 03 (Vapi). Replace them with a typed-intake form that POSTs to `/api/intake/structure` directly. See the [architecture diagram](architecture.html) for the portal-vs-voice path comparison.

## What we're building, in one paragraph.

A homeowner picks up the phone and calls a tradie's QuoteMate-provisioned number. **An AI receptionist answers.** It has a natural conversation: "What kind of job?" → "Where?" → "When?" → asks for photos via SMS if helpful. The conversation ends. A second AI **structures everything that was said** into clean fields — measurements, scope, risks, confidence score. A third AI **looks up assemblies and prices** and writes a draft quote with line items and exclusions.

That's the pipeline. The tradie doesn't even need to be near their phone for any of this to happen.

01 Customer / Homeowner A homeowner has a job and reaches for their phone.

02 Calls dedicated AI number Twilio AU number routes the call to your AI.

03 AI Receptionist Vapi + Deepgram + ElevenLabs + Claude have a natural conversation.

04 Intake Engine Claude Sonnet structures the transcript into clean fields.

05 Estimation Engine Claude Opus writes a draft quote using tools + a pricing book.

In scope · This guide

### The five stages from the wireframe.

-   Provisioning the Australian phone number (Stage 02)
-   Building the voice agent that answers it (Stage 03)
-   Building the engine that structures what the caller said (Stage 04)
-   Building the engine that drafts the quote (Stage 05)

Out of scope · Not in this guide

The **tradie portal, customer-facing quote view, payment flow, Stripe Connect, follow-up SMS, and calendar booking** are stages 06 → 10 of the wireframe. Once you have a quote being drafted at the end of stage 05, you'll know what data the rest needs — those become a separate guide.

Honest cost warning

This pipeline is **voice-first**. Voice AI is significantly more expensive than typed-input AI. A 4-minute call costs roughly **$0.50–$1.00** in third-party fees (Twilio + Vapi + Deepgram + ElevenLabs + Claude). At 30 calls/day, that's $450–$900 per month per tradie just in API costs. See the cost table in Step 2 before you commit.

Strategy · **What to scope first**

## Pilot scope — auto-quote vs inspection-only.

The pilot ships against **5 bounded electrical job types** where photos + structured intake are sufficient to draft a quote (the "easy 5"). The other 5 always trigger a paid site inspection — they're safety-critical or load-dependent and cannot be auto-quoted (the "hard 5"). This split applies to both v1 (portal-typed intake) and v3+ (voice receptionist) — only the front-end channel changes; the routing rules are identical.

Auto-quote candidates · easy 5

1.  Downlights / lighting
2.  Power points (GPOs)
3.  Ceiling fans
4.  Smoke alarms
5.  Outdoor / deck lighting

Bounded scope · predictable materials · customer photos sufficient. Still go through tradie review in v1 — auto-send is off until the eval framework proves accuracy.

Inspection-only routes · hard 5

1.  Switchboard work
2.  Fault finding
3.  EV chargers
4.  Underground cabling _(classified as `renovation` in the schema)_
5.  Complex renovations (multi-trade / mains)

Hidden state can't be photographed. Surface as indicative range only and trigger the $199 paid site visit. Note: the `job_type` Zod enum has 11 values; underground cabling is folded into `renovation` at classification time, then surfaces with its own risk flag at intake.

Why split this way

-   **Photos plus structured Q&A are sufficient** for the easy 5 — the customer can show "the area" and the AI can ask the 6–8 questions that bound the job
-   **Hidden state can't be photographed** for the hard 5 — switchboard internals, cable runs in walls, fault root cause, EV load on existing supply
-   **Australian Consumer Law** treats accepted quotes as binding contracts. Auto-quoting safety-critical work that turns out wrong creates personal liability for the licensed electrician
-   **The $199 inspection fee** filters tire-kickers AND pays for the trip when the job doesn't convert — turns a cost into a revenue line

The 9 detailed job-flow question trees and Good / Better / Best logic are at the bottom of this page — see [Job Flow Library](#job-flow-library). They feed directly into the Vapi system prompt's question routing (Step 6) and the Estimator's lookup logic (Step 8).

## The 9 steps.

1.  01[Set up your laptop](#step-1)Foundation
2.  02[Create the accounts you need](#step-2)Foundation
3.  03[Provision your AU phone number](#step-3)Stage 02
4.  04[Set up the backend skeleton](#step-4)Foundation
5.  05[Set up the database](#step-5)Foundation
6.  06[Build the AI Receptionist (Vapi)](#step-6)Stage 03
7.  07[Build the Intake Engine](#step-7)Stage 04
8.  08[Build the Estimation Engine](#step-8)Stage 05
9.  09[Test the full pipeline end to end](#step-9)Verify

Step 01 · **Foundation**

## Set up your laptop.

Install the small handful of programs you need before you can write a single line of code or call any API. One-time setup.

### What we're building & why

You'll need a code editor, a way to run JavaScript on your computer, a way to track changes, and a way to install third-party libraries. The pipeline lives in code — without these basics, none of it can be built or deployed.

Tools to install

-   Node.js (LTS)Runs JavaScript on your computer. [nodejs.org](https://nodejs.org/)
-   pnpmA faster, tidier alternative to npm. [pnpm.io](https://pnpm.io/installation)
-   GitTracks every change you make to your code. [git-scm.com](https://git-scm.com/)
-   VS CodeThe most common code editor for web devs. [code.visualstudio.com](https://code.visualstudio.com/)
-   ngrokLets external services (Twilio, Vapi) call back to your laptop while developing. [ngrok.com](https://ngrok.com/)

### Step-by-step

1.  Install Node.js Download the LTS installer from [nodejs.org](https://nodejs.org/). Run it. Then verify in a terminal:

    ```
    node --version
    # should print v20.x.x or v22.x.x
    ```

2.  Install pnpm

    ```
    npm install -g pnpm
    pnpm --version
    ```

3.  Install Git and configure your identity

    ```
    git config --global user.name "Your Name"
    git config --global user.email "you@example.com"
    ```

4.  Install VS Code From [code.visualstudio.com](https://code.visualstudio.com/). Open it once after install.
5.  Install ngrok Sign up at [ngrok.com](https://ngrok.com/), download the binary, and run `ngrok config add-authtoken YOUR_TOKEN`. You'll need this in Step 6 — Twilio and Vapi need a public URL to send webhooks to, and your laptop doesn't have one. ngrok creates a temporary public URL that tunnels to your local machine.

Tip

If a command "isn't recognised" after installing — close your terminal completely and open a fresh one. New programs only appear in terminals opened _after_ the install finishes.

Step 02 · **Foundation**

## Create the accounts you need.

Six service accounts. The voice pipeline depends on more vendors than a typed-input app does — that's the cost of voice. All have free tiers or pay-as-you-go.

### Why so many?

Each service does exactly one thing well, and they connect together. **Twilio** owns the phone number. **Vapi** orchestrates the live conversation. **Deepgram** turns speech into text. **ElevenLabs** turns text into a natural-sounding voice. **Anthropic** provides the Claude AI brain. **Supabase** stores everything. Vapi can wrap Deepgram and ElevenLabs for you, but you still create accounts so you control the keys and the bills.

Accounts to create

-   TwilioPhone numbers + SMS in Australia. [twilio.com/try-twilio](https://www.twilio.com/try-twilio)
-   VapiVoice AI orchestration — the platform that runs the live call. [vapi.ai](https://vapi.ai/)
-   DeepgramSpeech-to-text (STT). [deepgram.com](https://console.deepgram.com/signup)
-   ElevenLabsText-to-speech (TTS) — the voice the caller hears. [elevenlabs.io](https://elevenlabs.io/)
-   AnthropicClaude AI — used for routing decisions, intake structuring, and quote drafting. [console.anthropic.com](https://console.anthropic.com/)
-   SupabasePostgres database (with pgvector) for assemblies, prices, intakes, quotes. [supabase.com](https://supabase.com/dashboard/sign-up)
-   VercelHosts the backend webhooks that receive call data. [vercel.com](https://vercel.com/signup)

### Realistic running costs (per call)

Estimates for a 4-minute call to the AI receptionist that produces one drafted quote:

| Service | What you pay for | Cost / call |
| --- | --- | --- |
| Twilio AU number | Inbound minutes (~$0.02 / min) | ~$0.08 |
| Vapi | Orchestration (~$0.05 / min) | ~$0.20 |
| Deepgram (STT) | Live transcription | ~$0.02 |
| ElevenLabs (TTS) | Synthesised voice output | ~$0.10–0.30 |
| Claude Haiku (routing) | In-call decisions | ~$0.01 |
| Claude Sonnet (intake) | Structuring the transcript | ~$0.02 |
| Claude Opus (estimation) | Drafting the quote | ~$0.05–0.10 |
| Total | Per completed call → quote | ~$0.50–0.75 |

### Step-by-step

1.  Sign up for Twilio At [twilio.com/try-twilio](https://www.twilio.com/try-twilio). Add a credit card — you'll need it to buy an Australian phone number in Step 3 (around $1/month).
2.  Sign up for Vapi At [vapi.ai](https://vapi.ai/). Vapi gives you ~$10 of free credit to start — enough for ~50 test calls.
3.  Sign up for Deepgram At [deepgram.com](https://console.deepgram.com/signup). Generous free tier ($200 of credit).
4.  Sign up for ElevenLabs At [elevenlabs.io](https://elevenlabs.io/). Free tier covers ~10K characters/month — plenty for testing.
5.  Sign up for Anthropic and add a payment method At [console.anthropic.com](https://console.anthropic.com/). Add a card. Set a monthly spend limit of $20 while learning.
6.  Generate API keys for each service For each of Vapi, Deepgram, ElevenLabs, Anthropic — go to their dashboard, find "API Keys", create one, and save it somewhere safe (a password manager is ideal). Twilio uses an "Account SID" + "Auth Token" instead of an API key — find those in the Twilio Console home page. We'll plug all of these into env vars in Step 4.
7.  Sign up for Supabase + Vercel using GitHub At [supabase.com](https://supabase.com/) and [vercel.com/signup](https://vercel.com/signup). Use "Continue with GitHub" for both.

Never commit API keys

You'll soon have ~7 different API keys floating around. Store them all in a single `.env.local` file at your project root — Git ignores it by default. If you ever publish a key by accident, immediately revoke it in the relevant dashboard and create a new one.

Step 03 · **Stage 02 — Calls dedicated AI number**

## Provision your Australian phone number.

Buy a real AU phone number through Twilio. This is the number a homeowner will dial. Later, we'll point it at the AI receptionist.

### What we're building & why

This is **Stage 02 of the wireframe**: "Calls dedicated AI phone number". Without a real phone number, there's no call to receive. Twilio is the project's chosen provider because it has good Australian local-number coverage, sensible pricing, and works with every voice AI orchestrator including Vapi.

Tools used

-   Twilio ConsoleWeb dashboard at [console.twilio.com](https://console.twilio.com/)
-   Twilio AU local number~$1/month + per-minute charges

### Step-by-step

1.  Verify your identity in Twilio To buy an Australian number, Twilio requires identity verification (it's a regulator requirement, not Twilio's choice). In the Console, go to **Phone Numbers → Regulatory Compliance → Bundles**, pick "Australia", and submit ID + a local address. Approval takes 1–3 business days.
2.  Buy an AU local number Once approved, go to **Phone Numbers → Buy a number**. Filter by Country = Australia. Pick a number from a city (Sydney, Melbourne, etc.) — local numbers feel more trustworthy to homeowners than 1300 numbers. Tick "Voice" capability. Click **Buy** (~AU$1.50/month).
3.  Note your credentials From the Twilio Console homepage, copy:

    -   **Account SID** — starts with `AC...`
    -   **Auth Token** — click "show" to reveal
    -   **Phone number** — the one you just bought, in `+61...` format

    Save these somewhere safe. They go into `.env.local` in Step 4.
4.  Test that it rings From your mobile, dial the new number. It should ring and Twilio's default voice will say "Hello, this is your Twilio number." That's all we need for now — in Step 6 we'll point it at Vapi instead.

Why a local number, not 1300?

Homeowners are more likely to answer calls from local mobile or landline numbers. 1300 numbers feel like marketing or call-centre traffic. The wireframe specifies "AU long code" — that's industry shorthand for "regular Australian local phone number" (as opposed to short codes used for high-volume SMS).

Step 04 · **Foundation**

## Set up the backend skeleton.

Create a minimal Next.js project. It exists only to host the API endpoints that Vapi and Twilio call into. No UI yet — pure backend.

### What we're building & why

The voice agent (Vapi) needs somewhere to send the call transcript when the conversation ends. The Intake Engine and Estimation Engine need to live somewhere too. We use Next.js because it gives us API routes + automatic deployment to Vercel out of the box — the cheapest, fastest way to host webhook endpoints.

Tools used

-   Next.js (App Router)Just for its API routes. [nextjs.org](https://nextjs.org/)
-   TypeScriptCatches bugs before they ship.
-   VercelFree hosting for the API endpoints.
-   Vercel AI SDKUnified interface for calling Claude. [sdk.vercel.ai](https://sdk.vercel.ai/)

### Step-by-step

1.  Generate the project In your terminal:

    ```
    pnpm create next-app@latest quotemate-automation
    ```

    Answer: TypeScript yes, ESLint yes, Tailwind no (we don't need a UI), src/ no, App Router yes, Turbopack yes.
2.  Open it and run it

    ```
    cd quotemate-automation
    code .
    pnpm dev
    ```

    Visit [localhost:3000](http://localhost:3000). Default page loads. Backend is alive.
3.  Install the libraries you'll need

    ```
    pnpm add ai @ai-sdk/anthropic zod twilio @supabase/supabase-js
    ```

4.  Create your env file In the project root, create `.env.local` and paste in every key from Step 2 + Step 3:

    ```
    # Twilio
    TWILIO_ACCOUNT_SID=AC...
    TWILIO_AUTH_TOKEN=...
    TWILIO_PHONE_NUMBER=+61...

    # Vapi
    VAPI_API_KEY=...
    VAPI_WEBHOOK_SECRET=...

    # Voice services
    DEEPGRAM_API_KEY=...
    ELEVENLABS_API_KEY=...

    # Claude
    ANTHROPIC_API_KEY=sk-ant-...

    # Supabase (filled in Step 5)
    NEXT_PUBLIC_SUPABASE_URL=
    NEXT_PUBLIC_SUPABASE_ANON_KEY=
    SUPABASE_SERVICE_ROLE_KEY=
    ```

5.  Push to GitHub and connect to Vercel

    ```
    git init
    git add .
    git commit -m "Initial automation backend skeleton"
    ```

    Create a GitHub repo called `quotemate-automation`, push to it, then go to [vercel.com/new](https://vercel.com/new) and import the repo. After deploy, copy **every env var from `.env.local`** into Vercel → Settings → Environment Variables. Without this, the deployed version can't talk to anything.
6.  Start ngrok in a second terminal For local development, Twilio and Vapi need a public URL pointing to your laptop. Open a new terminal:

    ```
    ngrok http 3000
    ```

    Copy the `https://abc123.ngrok.app` URL ngrok prints. We'll use it as the webhook target in Step 6.

Step 05 · **Foundation**

## Set up the database.

Create a Supabase project, turn on the pgvector extension (needed for similar-job lookup in Stage 04), and create the small handful of tables the pipeline writes into.

### What we're building & why

The Intake Engine needs to **find similar past jobs** using vector similarity (the wireframe Stage 04 spec). The Estimation Engine needs to **read assemblies and prices** (Stage 05). Both write their results to the database. Postgres + pgvector via Supabase is the project's chosen combination.

Tools used

-   Supabase projectManaged Postgres + storage. [supabase.com](https://supabase.com/)
-   pgvector extensionLets Postgres store and search vector embeddings. Built into Supabase — just toggle it on.
-   Supabase SQL EditorRun SQL right in your browser.

### The tables, in plain English

-   **shared\_assemblies** — the electrical assembly library (e.g. "install LED downlight", "replace double GPO", "hardwire smoke alarm"). Read by Estimation Engine.
-   **shared\_materials** — downlights, GPOs, smoke alarms, fans, RCBOs, cabling, sundries with default prices. Read by Estimation Engine.
-   **pricing\_book** — the tradie's hourly rate, markup %, custom prices. Read by Estimation Engine.
-   **calls** — one row per inbound call. Stores the Vapi call ID, transcript, audio URL.
-   **intakes** — the structured output of Stage 04. JSON fields + an embedding for similarity search.
-   **quotes** — the draft quote produced by Stage 05.
-   **quote\_line\_items** — the line items inside a quote.

### Step-by-step

1.  Create a Supabase project In the Supabase dashboard, click "New project". Name it `quotemate-automation-dev`, set a strong DB password (save it), pick the closest region. Wait ~2 minutes for provisioning.
2.  Copy your URL and keys into `.env.local` Project Settings → API. Paste `Project URL`, `anon public`, and `service_role` into the empty Supabase slots in your `.env.local` from Step 4. Add the same three to Vercel.
3.  Enable the pgvector extension Database → Extensions → search "vector" → toggle on. This is what lets Stage 04 find similar past jobs.
4.  Create the library tables SQL Editor → New query → paste and run:

    ```
    create table shared_assemblies (
      id uuid primary key default gen_random_uuid(),
      trade text not null default 'electrical',
      name text not null,
      description text,
      default_unit text,
      default_unit_price_ex_gst numeric(10,2),
      default_labour_hours numeric(6,2),
      default_exclusions text
    );

    create table shared_materials (
      id uuid primary key default gen_random_uuid(),
      trade text not null default 'electrical',
      name text not null,
      brand text,
      unit text,
      default_unit_price_ex_gst numeric(10,2)
    );

    create table pricing_book (
      id uuid primary key default gen_random_uuid(),
      hourly_rate numeric(8,2) default 110,                 -- AU sparky band $90–$130/hr
      call_out_minimum numeric(8,2) default 150,           -- $120–$180 typical
      apprentice_rate numeric(8,2) default 60,             -- $45–$75/hr if needed
      default_markup_pct numeric(5,2) default 28,           -- 20–35% on materials
      risk_buffer_pct numeric(5,2) default 15,              -- 10–20% for unknown access
      gst_registered boolean default true,
      licence_type text,                                  -- e.g. 'NECA', 'ESV', 'QBCC'
      licence_number text,
      licence_state text,                                 -- 'NSW', 'VIC', 'QLD' etc.
      licence_expiry date,
      overlays jsonb default '{}'::jsonb
    );
    ```

5.  Create the pipeline tables

    ```
    create table calls (
      id uuid primary key default gen_random_uuid(),
      vapi_call_id text unique,
      caller_number text,
      duration_seconds int,
      transcript text,
      recording_url text,
      photo_urls jsonb default '[]'::jsonb,
      ended_at timestamptz,
      created_at timestamptz default now()
    );

    create table intakes (
      id uuid primary key default gen_random_uuid(),
      call_id uuid references calls(id) on delete cascade,
      job_type text,                                          -- enum: downlights, power_points, ceiling_fans, smoke_alarms, outdoor_lighting, switchboard, oven_cooktop, ev_charger, fault_finding, renovation, other
      address text,
      suburb text,
      scope jsonb,                                            -- { item_count, is_new_install, existing_wiring, indoor_outdoor, description }
      access jsonb,                                           -- { roof_access, ceiling_type, wall_type, notes }
      property jsonb,                                         -- { bedrooms, levels, pre_1970, has_solar, phase }
      risks jsonb,                                            -- e.g. ['burning smell', 'ceramic-fuse switchboard', 'water damage near fixture']
      inspection_required boolean default false,                -- true for switchboard / fault_finding / ev_charger / renovation / mains
      caller jsonb,                                           -- { name, phone, email }
      timing jsonb,                                           -- { urgency, preferred_date }
      confidence text,                                        -- LOW / MEDIUM / HIGH
      confidence_reason text,
      embedding vector(1536),
      created_at timestamptz default now()
    );

    create table quotes (
      id uuid primary key default gen_random_uuid(),
      intake_id uuid references intakes(id) on delete cascade,
      status text default 'draft',                       -- draft | sent | accepted | declined | expired

      -- Top-level explanatory fields (from Estimator output)
      scope_of_works text,                                  -- plain-English summary
      assumptions jsonb default '[]'::jsonb,
      risk_flags jsonb default '[]'::jsonb,

      -- Three pricing tiers, each storing { label, line_items[], subtotal_ex_gst, timeframe }
      good jsonb,
      better jsonb,
      best jsonb,

      optional_upsells jsonb default '[]'::jsonb,
      estimated_timeframe text,
      needs_inspection boolean default false,
      inspection_reason text,
      gst_note text,

      -- The tier the customer ultimately picks (default 'better' for portal display)
      selected_tier text default 'better',                 -- good | better | best
      subtotal_ex_gst numeric(12,2),                          -- of the selected tier
      gst numeric(12,2),
      total_inc_gst numeric(12,2),

      created_at timestamptz default now(),
      sent_at timestamptz,
      accepted_at timestamptz
    );

    -- Line items live inside the good/better/best JSONB on quotes.
    -- This table is optional — only used to materialise the selected tier's items
    -- for invoicing / job-card generation after the customer accepts.
    create table quote_line_items (
      id uuid primary key default gen_random_uuid(),
      quote_id uuid references quotes(id) on delete cascade,
      tier text not null,                                    -- which tier this came from
      description text not null,
      quantity numeric(10,2),
      unit text,                                              -- 'each' | 'hr' | 'lm'
      unit_price_ex_gst numeric(10,2),
      total_ex_gst numeric(12,2),
      source text                                              -- 'assembly:UUID' | 'material:UUID' | 'labour' | 'callout'
    );
    ```

6.  Create the similarity-search function This is what Stage 04 will use to find the 5 most similar past intakes:

    ```
    create or replace function match_intakes(
      query_embedding vector(1536),
      match_count int default 5
    )
    returns table (id uuid, scope jsonb, similarity float)
    language sql stable as $$
      select id, scope, 1 - (embedding <=> query_embedding) as similarity
      from intakes
      where embedding is not null
      order by embedding <=> query_embedding
      limit match_count;
    $$;
    ```

7.  Seed the "easy 5" electrical assemblies + a default pricing book row

    ```
    -- One assembly per "easy 5" job type — covers v1 auto-quote scope
    insert into shared_assemblies (trade, name, description, default_unit, default_unit_price_ex_gst, default_labour_hours, default_exclusions)
    values
      ('electrical', 'Install LED downlight',                  'Cut hole, terminate, fit fixture, test',                  'each', 28.00, 0.40, 'Excludes new wiring runs and ceiling repair'),
      ('electrical', 'Replace double GPO',                    'Disconnect, remove old, fit new, test',                   'each', 22.00, 0.30, 'Excludes new circuit work'),
      ('electrical', 'Install customer-supplied ceiling fan',  'Mount, terminate to existing wiring, test',               'each', 35.00, 1.00, 'Excludes ceiling reinforcement and supply of fan'),
      ('electrical', 'Hardwire 240V smoke alarm',             'Mount, terminate, test interconnect',                     'each', 30.00, 0.50, 'Excludes ceiling penetrations beyond standard'),
      ('electrical', 'Install outdoor IP-rated LED light',    'Mount weatherproof fitting on existing circuit',           'each', 32.00, 0.60, 'Excludes new circuit and underground cabling');

    -- A handful of materials so lookup_material has something to find
    insert into shared_materials (trade, name, brand, unit, default_unit_price_ex_gst)
    values
      ('electrical', 'Basic LED downlight',             null,         'each', 28.00),
      ('electrical', 'Tri-colour LED downlight',        null,         'each', 48.00),
      ('electrical', 'Dimmable IP-rated downlight',     null,         'each', 72.00),
      ('electrical', 'Standard double GPO',             'Clipsal',    'each', 25.00),
      ('electrical', 'USB double GPO',                  'Clipsal',    'each', 70.00),
      ('electrical', 'Hardwired smoke alarm',           'Clipsal',    'each', 95.00),
      ('electrical', 'RCBO safety switch',              'Clipsal',    'each', 85.00),
      ('electrical', 'Sundries (terminals, wire, clips)', null,        'each', 50.00);

    -- Pricing book row with AU sparky defaults; update licence_* before sending real quotes
    insert into pricing_book (hourly_rate, default_markup_pct, licence_type, licence_state)
    values (110, 28, 'NECA', 'NSW');
    ```

Why no auth or RLS in this guide?

This is a **pure automation pipeline**, not a multi-tenant SaaS. There's no logged-in user — Twilio and Vapi call the endpoints directly using webhook secrets. We're using the service-role Supabase key from server code only. When you eventually add a tradie portal on top, you'll add auth and Row-Level Security at that point.

Step 06 · **Stage 03 — AI Receptionist**

## Build the AI Receptionist.

Create a Vapi assistant that answers the phone, has a structured conversation with the caller, and sends you the transcript when the call ends. This is _the_ headline component.

### What we're building & why

Vapi is the conductor. When a call comes in, Vapi picks it up, streams the audio to Deepgram for transcription, sends the transcript to Claude Haiku to decide what to say next, and uses ElevenLabs to speak the response back. This whole loop runs ~10 times a second so the conversation feels natural. When the call ends, Vapi POSTs the full transcript and recording URL to a webhook on your backend.

Tools used

-   Vapi dashboardWhere you create the assistant and configure the conversation. [dashboard.vapi.ai](https://dashboard.vapi.ai/)
-   Claude HaikuFast, cheap LLM for in-call decisions.
-   Deepgram (via Vapi)Speech-to-text.
-   ElevenLabs (via Vapi)Text-to-speech — pick a friendly Australian voice.
-   Twilio number (from Step 3)The phone number callers dial.

### Step-by-step

1.  Connect Twilio to Vapi In the Vapi dashboard → **Phone Numbers → Import from Twilio**. Paste your Twilio Account SID, Auth Token, and the AU number from Step 3. Vapi takes over the number's voice webhook automatically.
2.  Plug in your own Deepgram + ElevenLabs + Anthropic keys Vapi → **Settings → Provider Keys**. Pasting your own keys means you're billed at retail rates by each provider, not a Vapi markup. Recommended.
3.  Create the assistant Vapi → **Assistants → New Assistant**. Configure:
    -   **Transcriber:** Deepgram (model `nova-2`, language `en-AU`)
    -   **Voice:** ElevenLabs — pick an Australian or neutral English voice. Test it.
    -   **Model:** Anthropic Claude Haiku 4.5 (the live-conversation model — fast and cheap; in Vapi's dashboard pick the option whose full ID is `claude-haiku-4-5-20251001`)
    -   **First message:** "G'day, you've reached \[electrician/business name\]'s quoting line. I'm an AI assistant — I can take down all the details for your electrical job and have a quote sent through. This call may be recorded for quality and quote-drafting purposes. Sound good?"
4.  Write the system prompt The system prompt teaches the AI what to ask. A starting point:

    ```
    // In the Vapi assistant config, paste this as the System Prompt.
    // Every field below maps 1:1 to the IntakeSchema in Step 7 — the Intake
    // Engine uses Claude Sonnet to extract these from your transcript.

    ROLE
    You are an AI receptionist for an Australian licensed electrical business.
    You answer the phone and capture exactly the information the Estimation
    Engine needs to draft a quote. You never give electrical advice, never
    confirm safety, and never commit to a price.

    TONE
    Friendly, conversational, brief. ONE question at a time. Always confirm
    what you heard. Use plain language unless the customer uses trade terms first.

    WHAT YOU'RE CAPTURING (maps to IntakeSchema in Step 7)
      caller.name           caller.phone         caller.email
      suburb                address              job_type
      scope.description     scope.item_count     scope.is_new_install
      scope.existing_wiring scope.indoor_outdoor access.*
      property.*            risks[]              inspection_required
      timing.urgency        timing.preferred_date  photo URLs (sent via SMS)
      confidence            confidence_reason

    JOB-TYPE CLASSIFICATION — set first, drives everything that follows
    Pick exactly one:
      downlights | power_points | ceiling_fans | smoke_alarms | outdoor_lighting
      switchboard | oven_cooktop | ev_charger | fault_finding | renovation | other

    OPENING (after Vapi's first message has played)
    "No worries, I'll grab a few quick details so we can get you an accurate
    quote. It should only take a minute. First — what's your name?"

    Then: name → confirm mobile (Vapi has caller ID) → suburb → "What do you
    need done?" → from that, classify job_type.

    ═══ AUTO-QUOTE 5 (job_type ∈ {downlights, power_points, ceiling_fans,
                      smoke_alarms, outdoor_lighting}) ════════════════════

    DOWNLIGHTS
    1. How many downlights?                         → scope.item_count
    2. Replacing existing or new install?           → scope.is_new_install
    3. Is the wiring already run?                   → scope.existing_wiring
    4. Indoor or outdoor / under a deck?            → scope.indoor_outdoor
    5. Is the ceiling flat, raked, or high?         → access.ceiling_type
    6. Roof / ceiling access available?             → access.roof_access
    7. Warm white, cool white, tri-colour, dimmable, or smart?
                                                    → scope.description
    8. Send photos of the ceiling and the existing switch
                                                    → call send_sms_photo_link

    POWER_POINTS
    1. How many power points?                       → scope.item_count
    2. New or replacing existing?                   → scope.is_new_install
    3. Indoor or outdoor?                           → scope.indoor_outdoor
    4. Wall type — plaster, brick, concrete, tile?  → access.wall_type
    5. Is there power nearby?                       → scope.existing_wiring
    6. Single, double, USB, weatherproof, smart?    → scope.description
    7. Send a photo of the location                 → call send_sms_photo_link
    NOTE: if customer mentions "new circuit" or "extra circuit" →
      add to risks: "new circuit needed — confirm switchboard capacity"
      set inspection_required = true

    CEILING_FANS
    1. How many fans?                               → scope.item_count
    2. Existing light or fan there now?             → scope.existing_wiring
    3. Customer-supplied fan or do we supply?       → scope.description
    4. Remote or wall control?                      → scope.description
    5. Ceiling — flat, raked, or high?              → access.ceiling_type
    6. Roof access available?                       → access.roof_access

    SMOKE_ALARMS
    1. How many bedrooms?                           → property.bedrooms
    2. How many levels?                             → property.levels
    3. Owner-occupied, rental, or being sold?       → scope.description
    4. Need compliance certification?               → scope.description
    5. Existing smoke alarms there?                 → scope.is_new_install
                                                      (false if replacing)
    6. Battery, hardwired, or interconnected?       → scope.description

    OUTDOOR_LIGHTING
    1. Covered or weather-exposed?                  → scope.indoor_outdoor='outdoor'
    2. How many lights?                             → scope.item_count
    3. Cabling already run?                         → scope.existing_wiring
    4. Distance from existing power?                → scope.description
    5. Switching, sensor, dimmer, or smart control? → scope.description
    6. Functional or feature lighting?              → scope.description
    7. Send photos of the deck/area, the switchboard, and any existing power
                                                    → call send_sms_photo_link

    ═══ INSPECTION-ONLY (always inspection_required=true) ════════════════

    SWITCHBOARD
    1. Send a photo of the switchboard right now (close-up if safe)
                                                    → call send_sms_photo_link FIRST
    2. Old ceramic fuses or modern circuit breakers?→ scope.description, risks
    3. Adding a circuit, or full board upgrade?     → scope.is_new_install
    4. Any tripping, buzzing, burning smell, overheating?
                                                    → risks (if any: SEE EMERGENCY OVERRIDE)
    5. Solar, EV charger, pool, large appliances?   → property.has_solar
    6. Single phase or three phase if known?        → property.phase

    EV_CHARGER
    1. What vehicle make/model?                     → scope.description
    2. Charger model — do you have one in mind?     → scope.description
    3. Single phase or three phase property?        → property.phase
    4. Distance from your switchboard to install location?
                                                    → access.notes
    5. Wall-mounted, garage, driveway, or outdoor?  → access.notes, scope.indoor_outdoor
    6. Solar on the property?                       → property.has_solar
    7. Send photos of the switchboard and install location
                                                    → call send_sms_photo_link

    FAULT_FINDING — diagnostic only, NEVER fixed-priced
    1. What's happening?                            → scope.description, risks
    2. When did it start?                           → scope.description
    3. Whole house or one area?                     → scope.description
    4. Are breakers tripping?                       → risks
    5. Burning smell, buzzing, sparks, water damage?→ risks; if YES: EMERGENCY
    6. Recent storms, renovations, new appliances?  → scope.description
    At end: "Faults need testing onsite. We'll attend, diagnose, then quote
    the repair separately. Diagnostic call-out is around $120–$180 plus the
    hourly rate while we're there."

    RENOVATION — multi-trade and complex
    1. What's the broader project?                  → scope.description
    2. Single trade or multi-trade?                 → scope.description
    3. Plans available?                             → trigger SMS for plans + switchboard photo
    4. Existing circuits being extended?            → risks

    ═══ CASE-BY-CASE ═════════════════════════════════════════════════════

    OVEN_COOKTOP
    1. Oven, cooktop, or both?                      → scope.description
    2. Gas, electric, or induction?                 → scope.description
    3. Replacing existing or new install?           → scope.is_new_install
    4. Model number?                                → scope.description
    5. Wiring already in place?                     → scope.existing_wiring
    6. Does the new appliance need a dedicated circuit?
       IF YES: risks: ["new dedicated circuit needed"], inspection_required = true
    7. Send photos of old appliance, new specs, switchboard
                                                    → call send_sms_photo_link

    ═══ EMERGENCY OVERRIDE (overrides any flow) ══════════════════════════
    If the customer mentions ANY of:
      burning smell · smoke · fire · sparks · electric shock · "got shocked"
      no power + whole house · water + electrical/switchboard/powerpoint

    IMMEDIATELY:
    1. Stay calm. Say: "That sounds urgent — please switch off the main switch
       at your switchboard if it's safe, and don't use anything electrical
       until we get there."
    2. Set timing.urgency = 'emergency'
    3. Set inspection_required = true
    4. Skip detailed Q&A. Confirm: name, suburb, best contact number.
    5. End the call: "I've alerted [tradie name]. They'll call you back within
       15 minutes to dispatch."

    ═══ PHOTO CAPTURE PROTOCOL ═══════════════════════════════════════════
    When you ask for photos, call function send_sms_photo_link. Be specific
    about what you need:

      downlights        → ceiling area, existing fitting, wall switch
      power_points      → wall location, nearest existing GPO
      ceiling_fans      → ceiling, current light/fan
      smoke_alarms      → existing alarm if any, ceiling
      outdoor_lighting  → deck/area, switchboard, existing power
      switchboard       → CLOSE-UP of board (cover off if safe), full view, labels
      oven_cooktop      → old appliance, new appliance specs sticker, switchboard
      ev_charger        → switchboard, install location with distance reference
      fault_finding     → switchboard, affected area, anything visible
      renovation        → switchboard, plans, key areas

    ═══ CONFIDENCE SCORING (set at end of call) ═════════════════════════
    HIGH:    job_type ∈ AUTO-QUOTE 5 AND inspection_required=false AND
             photos received AND all key questions answered AND no risks.

    MEDIUM:  AUTO-QUOTE 5 job but photos missing OR a key question unanswered
             (e.g. ceiling type unknown), OR oven_cooktop with confirmed wiring.

    LOW:     job_type ∈ {switchboard, ev_charger, fault_finding, renovation},
             OR any risks flagged, OR scope is vague,
             OR oven_cooktop needing a new circuit.

    confidence_reason: one short sentence explaining why.

    ═══ CLOSING ═════════════════════════════════════════════════════════
    Summarise back: "Just to confirm — [N] [job type] in [suburb], [is/is not]
    a new install, [photos received / sending now]. [Tradie name] will [send a
    quote / call you to book a site visit] within [SLA — an hour for auto-quote,
    end of day for inspection]. Anything else I should note?"

    Then close: "Great, we'll prepare a quote with a few options. If anything
    looks unclear from the photos, we may recommend a quick site visit before
    final pricing."

    ═══ THINGS YOU NEVER DO ═════════════════════════════════════════════
    - Quote a price (even a range — that's the Estimation Engine's job)
    - Confirm work is safe / unsafe
    - Diagnose a fault
    - Recommend a brand
    - Promise an arrival time
    - Promise warranty
    - Tell the customer to do anything electrical themselves
    - Skip photo asks for switchboard / EV / outdoor / oven jobs
    ```

5.  Set the end-of-call webhook In the assistant config → **Server URL** → paste your ngrok URL from Step 4 plus the path: `https://abc123.ngrok.app/api/vapi/webhook`. Vapi will POST the call transcript to this URL when the conversation ends.
6.  Build the webhook receiver in your Next.js project Create `app/api/vapi/webhook/route.ts`:

    ```
    import { createClient } from '@supabase/supabase-js'

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export async function POST(req: Request) {
      const payload = await req.json()

      // Vapi sends many event types — status-update, transcript, function-call,
      // hang, end-of-call-report. We only act on end-of-call-report.
      if (payload.message?.type !== 'end-of-call-report') {
        return Response.json({ ok: true, ignored: payload.message?.type })
      }

      const call = payload.message.call
      if (!call?.id) {
        console.error('[vapi/webhook] end-of-call-report had no call.id', payload.message)
        return Response.json({ ok: false, error: 'missing call.id' }, { status: 400 })
      }

      // Vapi sends durationSeconds as a float (e.g. 32.053). Our `duration_seconds`
      // column is `int`, so round before inserting.
      const durationSeconds =
        typeof payload.message.durationSeconds === 'number'
          ? Math.round(payload.message.durationSeconds)
          : null

      // Upsert (not insert) so Vapi retrying the same end-of-call event is idempotent.
      // The unique constraint on vapi_call_id otherwise fires on retry → null callRow.
      const { data: callRow, error } = await supabase
        .from('calls')
        .upsert(
          {
            vapi_call_id: call.id,
            caller_number: call.customer?.number ?? null,
            duration_seconds: durationSeconds,
            transcript: payload.message.transcript ?? null,
            recording_url: payload.message.recordingUrl ?? null,
            ended_at: new Date().toISOString(),
          },
          { onConflict: 'vapi_call_id' }
        )
        .select()
        .single()

      if (error || !callRow) {
        console.error('[vapi/webhook] failed to upsert call row:', {
          message: error?.message,
          code: error?.code,
          details: error?.details,
          hint: error?.hint,
          vapi_call_id: call.id,
        })
        return Response.json(
          { ok: false, error: error?.message ?? 'upsert returned no row' },
          { status: 500 }
        )
      }

      // Fire-and-forget hand-off to the Intake Engine. Don't await — Vapi expects
      // a fast response from the webhook, and a slow downstream call shouldn't
      // make Vapi mark the webhook as failed.
      fetch(`${process.env.APP_URL}/api/intake/structure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: callRow.id }),
      }).catch((e) => {
        console.error('[vapi/webhook] failed to dispatch intake/structure:', e)
      })

      return Response.json({ ok: true, callId: callRow.id })
    }
    ```

7.  Test the call With `pnpm dev` running and `ngrok http 3000` running in another terminal, dial your Twilio number from your mobile. The AI should answer, ask the structured questions, then say goodbye. After it ends, check your Supabase `calls` table — a new row should appear with the full transcript.

Recording consent — Australian law

Australian states have varying rules on call recording. NSW and Victoria require **at least one party** to consent (you do). To be safe, your assistant's first message should announce: "this call may be recorded for quality and quote-drafting purposes." Add that line to the "First message" field in Vapi.

Step 07 · **Stage 04 — Intake Engine**

## Build the Intake Engine.

A second AI takes the transcript from Stage 03 and turns it into clean, structured data — fields the Estimation Engine can actually work with.

### What we're building & why

A free-text transcript ("yeah, six downlights in the kitchen, and a couple of power points in the bedroom — the wiring's already there I think, but the switchboard's pretty old, looks like ceramic fuses…") is useless to the Estimation Engine. The Intake Engine reads that transcript and produces structured JSON: `job_type: "downlights"`, `scope: { item_count: 6, is_new_install: false, existing_wiring: true, indoor_outdoor: "indoor" }`, `risks: ["old ceramic-fuse switchboard — recommend inspection before any new circuit"]`, `inspection_required: false`, `confidence: "MEDIUM"`. We use Claude Sonnet because it's strong at extraction and supports vision (for analysing any photos the customer sent).

Tools used

-   Claude Sonnet 4.6Strong extraction + vision. Cheaper than Opus.
-   Vercel AI SDK`generateObject` with a Zod schema enforces structured output.
-   Anthropic embeddingsFor the similar-job vector search via pgvector.

### Step-by-step

1.  Define the intake schema Create `lib/intake/schema.ts`:

    ```
    import { z } from 'zod'

    export const IntakeSchema = z.object({
      job_type: z.enum([
        'downlights',
        'power_points',
        'ceiling_fans',
        'smoke_alarms',
        'outdoor_lighting',
        'switchboard',
        'oven_cooktop',
        'ev_charger',
        'fault_finding',
        'renovation',
        'other',
      ]),
      address: z.string(),
      suburb: z.string(),
      scope: z.object({
        item_count: z.number().optional(),                                       // e.g., # of downlights, # of GPOs
        is_new_install: z.boolean().optional(),                                  // vs replacing existing
        existing_wiring: z.boolean().optional(),                                 // is wiring already there?
        indoor_outdoor: z.enum(['indoor', 'outdoor', 'both', 'unknown']).optional(),
        description: z.string(),
      }),
      access: z.object({
        roof_access: z.boolean().optional(),
        ceiling_type: z.enum(['flat', 'raked', 'high', 'unknown']).optional(),
        wall_type: z.enum(['plaster', 'brick', 'concrete', 'tile', 'unknown']).optional(),
        notes: z.string().optional(),
      }).optional(),
      property: z.object({
        bedrooms: z.number().optional(),                                         // for smoke-alarm jobs
        levels: z.number().optional(),
        pre_1970: z.boolean().optional(),                                        // asbestos / lead risk
        has_solar: z.boolean().optional(),                                       // affects switchboard / EV-charger work
        phase: z.enum(['single', 'three', 'unknown']).optional(),
      }).optional(),
      risks: z.array(z.string()),                                                // burning smell, tripping breakers, water damage, asbestos, old switchboard
      inspection_required: z.boolean(),                                          // true for switchboard, fault_finding, ev_charger, renovation, anything with mains/underground
      caller: z.object({
        name: z.string(),
        phone: z.string(),
        email: z.string().optional(),
      }),
      timing: z.object({
        urgency: z.enum(['emergency', 'this_week', 'this_month', 'flexible']).optional(),
        preferred_date: z.string().optional(),
      }).optional(),
      confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      confidence_reason: z.string(),
    })

    export type Intake = z.infer<typeof IntakeSchema>
    ```

2.  Build the structuring function Create `lib/intake/structure.ts`:

    ```
    import { anthropic } from '@ai-sdk/anthropic'
    import { generateObject } from 'ai'
    import { IntakeSchema } from './schema'

    export async function structureIntake(transcript: string, photoUrls: string[] = []) {
      const { object } = await generateObject({
        model: anthropic('claude-sonnet-4-6'),
        schema: IntakeSchema,
        system: `You extract structured intake data from electrical quoting calls.
    Be conservative — if unsure, leave fields blank and lower confidence.

    Surface real risks:
    - burning smell, buzzing, sparks → mark inspection_required=true, urgency=emergency
    - tripping breakers, recurring faults → mark inspection_required=true
    - water damage near electrical fixtures → add to risks + inspection_required=true
    - pre-1970 properties → flag asbestos / lead-paint risk on cabling work
    - unknown switchboard age or ceramic fuses → recommend inspection
    - difficult access (high ceilings, raked ceilings, no roof access, brick/concrete walls)
    - mains, underground cabling, three-phase work → always inspection_required=true

    Auto-quote candidates (inspection_required=false) when scope is clear and photos look clean:
    downlights, power_points, ceiling_fans, smoke_alarms, outdoor_lighting.

    Always inspection_required=true: switchboard, ev_charger, fault_finding, renovation, and
    any oven_cooktop / power_points / outdoor_lighting job that mentions new circuits, mains,
    or switchboard work.`,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `Transcript:\n${transcript}` },
            ...photoUrls.map(url => ({ type: 'image' as const, image: url })),
          ],
        }],
      })
      return object
    }
    ```

3.  Build the embedding helper for pgvector Create `lib/intake/embed.ts`:

    ```
    // Embeds the structured intake into a 1536-dim vector for pgvector.
    // Note: the @ai-sdk/anthropic provider has no .embedding() method —
    // Voyage AI is a separate vendor Anthropic recommends. Voyage's voyage-3
    // outputs 1024 dims, so we pad/truncate to fit our vector(1536) column.
    import type { Intake } from './schema'

    const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY
    const TARGET_DIM = 1536

    export async function embedIntake(intake: Intake) {
      const summary = `${intake.job_type} count=${intake.scope.item_count ?? '?'} new=${intake.scope.is_new_install ?? '?'} ${intake.scope.indoor_outdoor ?? ''} ${intake.risks.join(' ')}`

      if (!VOYAGE_API_KEY) return stubEmbedding(summary)

      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: [summary], model: 'voyage-3' }),
      })
      if (!res.ok) return stubEmbedding(summary)
      const data = await res.json()
      return resizeToTargetDim(data.data?.[0]?.embedding ?? [])
    }

    function resizeToTargetDim(v: number[]): number[] {
      if (v.length === TARGET_DIM) return v
      if (v.length > TARGET_DIM) return v.slice(0, TARGET_DIM)
      return [...v, ...new Array(TARGET_DIM - v.length).fill(0)]
    }

    // Deterministic per-summary 1536-dim vector — not semantic, but stable.
    // Replace with real embeddings when you set VOYAGE_API_KEY or wire OpenAI.
    function stubEmbedding(text: string): number[] {
      let h = 2166136261 >>> 0
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i)
        h = Math.imul(h, 16777619) >>> 0
      }
      const out = new Array(TARGET_DIM)
      for (let i = 0; i < TARGET_DIM; i++) {
        h ^= h << 13; h >>>= 0
        h ^= h >> 17; h >>>= 0
        h ^= h << 5;  h >>>= 0
        out[i] = (h / 0xffffffff) * 2 - 1
      }
      return out
    }
    ```

    Embedding vendor: **Voyage AI** (Anthropic's recommended embeddings provider — they're a separate vendor; `@ai-sdk/anthropic` has no `.embedding()` method despite what older docs may say). The stub fallback runs when `VOYAGE_API_KEY` isn't set so the pipeline still completes end-to-end during local testing — just don't expect `match_intakes()` similarity search to return useful results until you sign up for a real key. **OpenAI alternative:** `pnpm add @ai-sdk/openai`, then swap the fetch block for `openai.embedding('text-embedding-3-small')` via the AI SDK's `embed()` helper — that model natively outputs 1536 dims so no resize needed.

4.  Build the API route that ties it together Create `app/api/intake/structure/route.ts`:

    ```
    import { createClient } from '@supabase/supabase-js'
    import { structureIntake } from '@/lib/intake/structure'
    import { embedIntake } from '@/lib/intake/embed'

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export async function POST(req: Request) {
      const { callId } = await req.json()

      // 1. Load the call transcript
      const { data: call } = await supabase.from('calls').select('*').eq('id', callId).single()
      if (!call) return Response.json({ error: 'call not found' }, { status: 404 })

      // 2. Structure it
      const intake = await structureIntake(call.transcript, call.photo_urls)

      // 3. Embed it for similarity search
      const embedding = await embedIntake(intake)

      // 4. Save it
      const { data: intakeRow } = await supabase.from('intakes').insert({
        call_id: callId,
        job_type: intake.job_type,
        address: intake.address,
        suburb: intake.suburb,
        scope: intake.scope,
        access: intake.access,
        property: intake.property,
        risks: intake.risks,
        inspection_required: intake.inspection_required,
        caller: intake.caller,
        timing: intake.timing,
        confidence: intake.confidence,
        confidence_reason: intake.confidence_reason,
        embedding,
      }).select().single()

      // 5. Hand off to Stage 05 — the Estimation Engine
      fetch(`${process.env.APP_URL}/api/estimate/draft`, {
        method: 'POST',
        body: JSON.stringify({ intakeId: intakeRow!.id }),
      })

      return Response.json({ ok: true, intakeId: intakeRow!.id })
    }
    ```

5.  Test it manually Make a call to your Twilio number, hang up, then check the `intakes` table. A new row should appear with structured fields. Inspect them — are the surfaces correct? Did the AI flag the right risks? If not, refine the system prompt.

Why `generateObject`?

Free-text LLM output is hard to parse reliably. `generateObject` from the Vercel AI SDK enforces a Zod schema — Claude is required to produce JSON that matches it. If it can't, the SDK retries automatically. This eliminates a whole category of "the AI returned weird text" bugs.

Step 08 · **Stage 05 — Estimation Engine**

## Build the Estimation Engine.

The third AI agent. Takes the structured intake from Stage 04, looks up assemblies and prices using _tools_, applies the tradie's markup, and writes the final draft quote.

### What we're building & why

The Estimation Engine is a Claude Opus prompt with **tool use**. Instead of letting Claude invent prices (which it would, badly), we hand it a small set of tools it can call: `lookup_assembly`, `lookup_material`, `apply_markup`, `flag_inspection_needed`. The AI decides which tools to call and in what order; the tools do the actual database lookups. This pattern — **LLM reasoning + deterministic tools** — is what keeps prices honest.

Tools used

-   Claude Opus 4.7Strongest reasoning. The wireframe specifies it for this stage.
-   Vercel AI SDK `generateText`With the `tools` parameter for tool-use loops.
-   ZodDefines each tool's input schema.
-   Prompt cachingCaches the system prompt + library between calls. Big cost saver.

### Step-by-step

1.  Define the four tools Create `lib/estimate/tools.ts`. Each tool is a Zod schema + a function that runs against Supabase:

    ```
    import { tool } from 'ai'
    import { z } from 'zod'
    import { createClient } from '@supabase/supabase-js'

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export const lookupAssembly = tool({
      description: 'Search the electrical assembly library (e.g. "install LED downlight", "replace double GPO", "hardwire smoke alarm")',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const { data } = await supabase
          .from('shared_assemblies')
          .select('*')
          .ilike('name', `%${query}%`)
          .limit(5)
        return data ?? []
      },
    })

    export const lookupMaterial = tool({
      description: 'Search electrical materials (downlights, GPOs, smoke alarms, ceiling fans, RCBOs, cabling, sundries) by name or brand',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const { data } = await supabase
          .from('shared_materials')
          .select('*')
          .or(`name.ilike.%${query}%,brand.ilike.%${query}%`)
          .limit(5)
        return data ?? []
      },
    })

    export const applyMarkup = tool({
      description: 'Apply the tradie\'s markup percentage to a base material price. Always pass markupPct explicitly using pricingBook.default_markup_pct (default falls back to 28% — the AU electrical median — only as a safety net).',
      inputSchema: z.object({ basePrice: z.number(), markupPct: z.number().optional() }),
      execute: async ({ basePrice, markupPct }) => {
        const pct = markupPct ?? 28                                // matches pricing_book default
        return { final: +(basePrice * (1 + pct / 100)).toFixed(2), markupPct: pct }
      },
    })

    export const flagInspectionNeeded = tool({
      description: 'Flag that this job is too complex to quote without a site visit',
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => ({ flagged: true, reason }),
    })
    ```

2.  Write the system prompt Create `lib/estimate/prompt.ts`:

    ```
    // systemPrompt receives the pricingBook from the database. Every field below
    // comes from the pricing_book row created in Step 5.
    export function systemPrompt(pricingBook: {
      hourly_rate: number;
      call_out_minimum: number;
      apprentice_rate: number;
      default_markup_pct: number;
      risk_buffer_pct: number;
      gst_registered: boolean;
      licence_type: string | null;
      licence_state: string | null;
    }) {
      return `ROLE
    You are an expert Australian electrical estimator working for a licensed
    electrical contractor. You receive a structured intake (the IntakeSchema
    from Step 7) and produce a customer-ready draft quote with Good / Better /
    Best options. Your output is parsed by the API route and inserted directly
    into the quotes table — the JSON must match the shape below exactly.

    NON-NEGOTIABLE RULES
    1. NEVER invent prices. Every line-item price comes from a tool result.
    2. ALWAYS call lookup_assembly first for each work item. If no match, call
       flag_inspection_needed — do not estimate from thin air.
    3. Use lookup_material to find specific products (downlights, GPOs, RCBOs)
       when the assembly's default material isn't specific enough.
    4. Apply markup ONLY via apply_markup — never multiply yourself.
    5. If intake.inspection_required === true → call flag_inspection_needed and
       use the INSPECTION FALLBACK shape below (no fixed line items).
    6. For job_type === 'fault_finding' → use the FAULT-FINDING shape (call-out
       + hourly), never a fixed-price quote.
    7. All prices in your output are EX-GST. The API layer applies GST.

    YOUR INPUT (intake — see lib/intake/schema.ts)
      job_type, address, suburb, scope, access, property,
      risks[], inspection_required, caller, timing, confidence, confidence_reason

    PRICING BOOK (passed in)
      hourly_rate         = \${pricingBook.hourly_rate}        // typical AU sparky $90–$130
      call_out_minimum    = \${pricingBook.call_out_minimum}   // $120–$180
      apprentice_rate     = \${pricingBook.apprentice_rate}    // $45–$75 if needed
      default_markup_pct  = \${pricingBook.default_markup_pct} // 20–35% on materials
      risk_buffer_pct     = \${pricingBook.risk_buffer_pct}    // 10–20% for unknown access
      gst_registered      = \${pricingBook.gst_registered}
      licence_type        = \${pricingBook.licence_type ?? '(unset)'}
      licence_state       = \${pricingBook.licence_state ?? '(unset)'}

    YOUR TOOLS — exact signatures
      lookup_assembly({ query: string })
        → returns up to 5 rows from shared_assemblies:
          { id, trade, name, description, default_unit, default_unit_price_ex_gst,
            default_labour_hours, default_exclusions }
        Use queries like: "install LED downlight", "replace double GPO",
        "hardwire smoke alarm", "install ceiling fan", "outdoor IP-rated light".

      lookup_material({ query: string })
        → returns up to 5 rows from shared_materials:
          { id, trade, name, brand, unit, default_unit_price_ex_gst }
        Use for products: "tri-colour downlight", "USB GPO", "RCBO safety switch",
        "Clipsal Iconic".

      apply_markup({ basePrice: number, markupPct?: number })
        → returns { final, markupPct }
        If markupPct omitted, uses default_markup_pct.

      flag_inspection_needed({ reason: string })
        → returns { flagged: true, reason }
        Call when intake.inspection_required, OR no assembly match for a critical
        item, OR risks demand on-site verification.

    OUTPUT FORMAT — strict JSON, parsed by the API route
    {
      "scope_of_works":      "string — plain-English summary",
      "assumptions":         ["..."],
      "risk_flags":          ["..."],
      "good":   { "label": "...", "line_items": [...], "subtotal_ex_gst": N, "timeframe": "..." },
      "better": { "label": "...", "line_items": [...], "subtotal_ex_gst": N, "timeframe": "..." },
      "best":   { "label": "...", "line_items": [...], "subtotal_ex_gst": N, "timeframe": "..." },
      "optional_upsells":    [{ "name": "...", "price_ex_gst": N }],
      "estimated_timeframe": "string",
      "needs_inspection":    boolean,
      "inspection_reason":   "string | null",
      "gst_note":            "string"
    }

    LINE_ITEM SHAPE (each entry inside good/better/best.line_items)
    {
      "description":       "string — what the customer reads",
      "quantity":          N,
      "unit":              "each" | "hr" | "lm",
      "unit_price_ex_gst": N,
      "total_ex_gst":      N,
      "source":            "assembly:UUID" | "material:UUID" | "labour" | "callout"
    }

    GOOD / BETTER / BEST FRAMING (per job_type)
      downlights         → G: standard LED · B: tri-colour · X: dimmable IP-rated/smart
      power_points       → G: standard double GPO · B: USB GPO · X: weatherproof/smart + circuit
      ceiling_fans       → G: install customer-supplied · B: supply quality + remote ·
                           X: premium DC + light + wall control
      smoke_alarms       → G: like-for-like · B: compliant interconnected (10-yr lithium) ·
                           X: full property compliance package (AS3786:2014)
      outdoor_lighting   → G: basic outdoor-rated · B: IP65+ quality · X: dimmable/smart
      oven_cooktop       → G: like-for-like (existing wiring confirmed) ·
                           B: install + circuit verification + new isolation switch ·
                           X: dedicated circuit / switchboard upgrade

    INSPECTION FALLBACK (when intake.inspection_required, OR you call
    flag_inspection_needed — for switchboard, ev_charger, renovation)
    Don't produce real line items. Instead emit indicative ranges:
      good   = { label: "Indicative · minor scope",   line_items: [],
                 subtotal_ex_gst: <range_low>,  timeframe: "Subject to inspection" }
      better = { label: "Indicative · partial scope", line_items: [],
                 subtotal_ex_gst: <range_mid>,  timeframe: "Subject to inspection" }
      best   = { label: "Indicative · full scope",    line_items: [],
                 subtotal_ex_gst: <range_high>, timeframe: "Subject to inspection" }
      needs_inspection: true
      inspection_reason: customer-friendly explanation referencing the $199 site fee
      assumptions: list what we'd verify on-site
      scope_of_works: high-level description; mark as INDICATIVE

    FAULT-FINDING SPECIAL CASE (job_type === 'fault_finding')
    Override G/B/B framing entirely:
      good = {
        label: "Diagnostic call-out (1 hour onsite)",
        line_items: [
          { description: "Diagnostic call-out", quantity: 1, unit: "each",
            unit_price_ex_gst: \${pricingBook.call_out_minimum},
            total_ex_gst:      \${pricingBook.call_out_minimum},
            source: "callout" },
          { description: "Diagnostic time", quantity: 1, unit: "hr",
            unit_price_ex_gst: \${pricingBook.hourly_rate},
            total_ex_gst:      \${pricingBook.hourly_rate},
            source: "labour" }
        ],
        subtotal_ex_gst: \${pricingBook.call_out_minimum + pricingBook.hourly_rate},
        timeframe: "Same week"
      }
      better = same shape, 2 hours of diagnostic time
      best   = null
      scope_of_works: "Faults are diagnosed first. Repairs are quoted separately
                       once the cause is confirmed."
      assumptions: [
        "Diagnostic time only — repair work excluded.",
        "Straightforward repairs may be done in the same visit at additional time + materials."
      ]
      needs_inspection: true
      inspection_reason: "Faults must be diagnosed onsite — cannot be quoted blind."

    CALCULATION ORDER (per option — Good, Better, Best)
    1. For each work item:
       a. lookup_assembly({ query }) → pick best match
       b. quantity = intake.scope.item_count (or 1 if not applicable)
       c. labour_hours = quantity × assembly.default_labour_hours
       d. labour_total = labour_hours × hourly_rate
       e. material_total = quantity × assembly.default_unit_price_ex_gst
       f. (Optional) lookup_material → override material price for the chosen tier
       g. material_marked_up = apply_markup({ basePrice: material_total }).final
       h. line_total = labour_total + material_marked_up
    2. Apply risk buffer if conditions are met (see below)
    3. Sum to subtotal_ex_gst for that option

    RISK-BUFFER TRIGGERS (multiply subtotal by 1 + risk_buffer_pct/100 if ANY)
      intake.access.ceiling_type ∈ {'raked', 'high'}
      intake.access.roof_access === false
      intake.access.wall_type ∈ {'brick', 'concrete'}
      intake.scope.existing_wiring === false
      intake.property.pre_1970 === true

    INTAKE-DRIVEN RISK FLAGS (add to risk_flags[] when conditions match)
      intake.scope.existing_wiring === false →
        "Wiring not confirmed — new circuit may be required pending inspection."
      intake.property.pre_1970 === true →
        "Pre-1970 property — possible asbestos in existing cabling. Requires
         confirmation before any work that disturbs walls/ceilings."
      intake.property.has_solar === true AND job_type ∈ {'ev_charger','switchboard'} →
        "Existing solar requires load assessment before new high-load work."
      intake.timing.urgency === 'emergency' →
        "Customer reported emergency — same-day attendance required."

    OPTIONAL UPSELLS (add to optional_upsells[] when relevant)
      Any new wiring work:
        { name: "Add RCBO safety switch", price_ex_gst: 95 }
      Switchboard-adjacent jobs (oven_cooktop / ev_charger / partial board upgrade):
        { name: "Switchboard health check", price_ex_gst: 150 }
      Smoke-alarm work in older homes:
        { name: "Per-property compliance certificate", price_ex_gst: 80 }

    SCOPE_OF_WORKS WRITING STYLE
    - Plain English; customer-readable in 10 seconds
    - 2–4 sentences max
    - Mention key assumptions inline (e.g. "subject to existing wiring being in
      good condition")
    - Minimal jargon

    GST_NOTE
    - if gst_registered:  "All prices are ex-GST. Customer total includes 10% GST."
    - else:               "GST not applicable — this business is not GST-registered."

    ESTIMATED_TIMEFRAME
    - 1–2 hr jobs                 → "Same day"
    - 2–4 hr jobs                 → "1–2 business days"
    - Half-day to full day        → "Within the week"
    - 1+ day                      → "1–2 weeks subject to scheduling"
    - inspection_required = true  → "After site visit (within 5 business days)"

    LICENCE COMPLIANCE
    The PDF generator (Stage 06) reads pricingBook.licence_* and prints it on the
    quote PDF. Do NOT add licence text inline in your output.

    CONSISTENCY CHECK BEFORE EMITTING
    - Did every line_item price come from a tool result? (or call_out / labour rate)
    - Does intake.scope.item_count match the quantities in line_items?
    - If inspection_required, did you use INSPECTION FALLBACK shape?
    - If job_type === 'fault_finding', did you use the FAULT-FINDING shape?
    - Is the JSON valid and matches the OUTPUT FORMAT exactly?
    `
    }
    ```

3.  Build the agent runner Create `lib/estimate/run.ts`:

    ```
    import { anthropic } from '@ai-sdk/anthropic'
    import { generateText, stepCountIs } from 'ai'
    import { systemPrompt } from './prompt'
    import * as tools from './tools'

    export async function runEstimation(intake: any, pricingBook: any) {
      const result = await generateText({
        model: anthropic('claude-opus-4-7'),
        system: systemPrompt(pricingBook),
        prompt: `Draft a quote for this intake:\n\n${JSON.stringify(intake, null, 2)}`,
        tools,
        stopWhen: stepCountIs(10),
      })
      return parseJsonFromText(result.text)
    }

    // Opus often prefixes its JSON with reasoning text or wraps it in
    // ```json fences. Find and parse the first balanced { ... } block.
    function parseJsonFromText(text: string): any {
      const direct = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
      try { return JSON.parse(direct) } catch {}

      const start = text.indexOf('{')
      if (start < 0) throw new Error(`No JSON in Opus output: ${text.slice(0, 300)}`)

      let depth = 0, inStr = false, esc = false
      for (let i = start; i < text.length; i++) {
        const c = text[i]
        if (esc) { esc = false; continue }
        if (c === '\\') { esc = true; continue }
        if (c === '"') { inStr = !inStr; continue }
        if (inStr) continue
        if (c === '{') depth++
        else if (c === '}') {
          depth--
          if (depth === 0) return JSON.parse(text.slice(start, i + 1))
        }
      }
      throw new Error(`Unbalanced braces in Opus output: ${text.slice(0, 300)}`)
    }
    ```

    The `stopWhen: stepCountIs(10)` lets Claude call multiple tools in sequence — look up an assembly, then a material, then apply markup — before writing the final answer. The default is `stepCountIs(1)`, so without this Opus would never enter the tool-use loop. The `parseJsonFromText` helper survives Opus prefixing its response with reasoning prose like _"Calculation: …"_ before the JSON block — a common failure mode the build-guide originally swallowed.

    AI SDK API note

    This block was updated in 2026-04 for AI SDK v5+/v6. If you're on an older AI SDK, the older API used `parameters:` on tools and `maxSteps: 10` here — both renamed in the v5 release.

4.  Build the API route Create `app/api/estimate/draft/route.ts`:

    ```
    import { createClient } from '@supabase/supabase-js'
    import { runEstimation } from '@/lib/estimate/run'

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export async function POST(req: Request) {
      const { intakeId } = await req.json()

      const { data: intake } = await supabase.from('intakes').select('*').eq('id', intakeId).single()
      const { data: pricingBook } = await supabase.from('pricing_book').select('*').single()

      const draft = await runEstimation(intake, pricingBook)

      // Default selected tier for the customer portal is "better".
      // Falls through to "good" if better is missing (e.g. fault_finding has no best).
      const defaultTier = draft.better ?? draft.good
      const selectedSubtotal = defaultTier?.subtotal_ex_gst ?? 0
      const gst = pricingBook.gst_registered ? +(selectedSubtotal * 0.10).toFixed(2) : 0
      const total = +(selectedSubtotal + gst).toFixed(2)

      const { data: quote } = await supabase.from('quotes').insert({
        intake_id: intakeId,
        status: 'draft',
        scope_of_works:      draft.scope_of_works,
        assumptions:         draft.assumptions      ?? [],
        risk_flags:          draft.risk_flags       ?? [],
        good:                draft.good             ?? null,
        better:              draft.better           ?? null,
        best:                draft.best             ?? null,
        optional_upsells:    draft.optional_upsells ?? [],
        estimated_timeframe: draft.estimated_timeframe,
        needs_inspection:    draft.needs_inspection,
        inspection_reason:   draft.inspection_reason,
        gst_note:            draft.gst_note,
        selected_tier:       'better',
        subtotal_ex_gst:     selectedSubtotal,
        gst,
        total_inc_gst:       total,
      }).select().single()

      // Line items live inside the good/better/best JSONB columns —
      // no separate quote_line_items insert is needed at draft time.
      // (We materialise quote_line_items only after the customer accepts a tier.)

      return Response.json({ ok: true, quoteId: quote!.id })
    }
    ```

5.  Verify a draft quote was written After your test call from Step 6 → 7 finishes, check the `quotes` and `quote_line_items` tables. You should see a draft quote with real line items, prices that come from your seeded assemblies, and a sensible total inc-GST.

Don't auto-send to the customer (yet)

Australian Consumer Law treats accepted quotes as binding contracts. The wireframe is firm: in v1, no quote auto-sends without tradie review. This guide stops at "draft saved" — actually delivering it to the customer is part of stages 06 and 07, which need a human-in-the-loop step in between.

Step 09 · **Verify**

## Test the full pipeline end to end.

Make one real phone call. Watch the data flow through every stage. Check the quote at the end. This is the moment of truth.

### Pre-flight checklist

-   `pnpm dev` running in one terminal
-   `ngrok http 3000` running in another, with the public URL pasted into the Vapi assistant's Server URL
-   Vapi assistant connected to your Twilio number
-   Supabase has seeded assemblies + a pricing\_book row
-   All env vars set in `.env.local`

### The full-flow test

1.  Dial your Twilio AU number from your mobile phone
2.  Answer the AI's questions naturally — describe a real-feeling job ("I need six LED downlights in the kitchen, replacing the old halogens. The wiring's already there. Single-storey house, plaster ceiling, roof access is fine.")
3.  End the call
4.  **Within ~10 seconds:** a row appears in `calls` with the transcript
5.  **Within ~20 seconds:** a row appears in `intakes` with structured fields, an embedding, and a confidence score
6.  **Within ~45 seconds:** a row appears in `quotes` with the rich Estimator output — `scope_of_works`, `assumptions`, `risk_flags`, three `good` / `better` / `best` JSONB columns each holding label + line\_items + subtotal + timeframe, plus `optional_upsells` and the selected-tier totals (`subtotal_ex_gst`, `gst`, `total_inc_gst`). The `quote_line_items` table stays empty at draft time — it's only populated when the customer accepts a tier.
7.  Read each tier in the JSONB. Sanity-check that prices match your seeded assemblies. Check the GST math against the selected tier (`better.subtotal_ex_gst × 1.10 = total_inc_gst`).
8.  Verify the route was applied correctly — auto-quote-5 jobs (downlights, GPOs, fans, alarms, outdoor lighting) should produce three real tiers; switchboards / EV / fault finding should set `needs_inspection: true` and use indicative ranges.

### Run a deliberately complex call

Call again with a vague or risky job: "I'm getting a burning smell from the switchboard, and breakers keep tripping, also I want to add an EV charger — it's an old place, the switchboard's still got ceramic fuses." The pipeline should:

-   Capture the risks in the `intakes.risks` array (burning smell, tripping breakers, ceramic-fuse switchboard, EV charger on old board)
-   Mark `confidence: "LOW"` and `inspection_required: true`
-   Set `timing.urgency: "emergency"` based on the burning smell
-   The Estimation Engine should call `flag_inspection_needed` and set `quotes.needs_inspection = true`
-   Produce only an indicative range (not fixed pricing) with a strong "subject to inspection" exclusion

### Common things that break

-   **Vapi webhook never fires** — your ngrok tunnel restarted (URL changed) or your assistant's Server URL is wrong. Check the Vapi call logs.
-   **Intake structuring returns garbage** — the system prompt isn't strict enough. Add example transcripts + expected outputs.
-   **Estimation returns text, not JSON** — Opus fell out of structured mode. Use `generateObject` instead of `generateText` for stricter JSON output.
-   **Tool calls return empty** — your seeded library only has 5 assemblies. Real coverage needs the electrical domain expert input from [strategy.md §3](strategy.md) (a 25-year sparky for ~$5k consulting builds the base library across the 9 job types).
-   **GST math is off** — line items are stored ex-GST, totals displayed inc-GST. If everything looks 10% wrong, this is it.

Capture this as your eval baseline

Save 10–20 of these test calls as your hold-out set. Each one: the call audio, the intake the AI structured, the quote it produced, and a 0–5 score on whether the quote is right. Every future change to the prompts or tools must be measured against this set. Without it, you're iterating blind. (See [strategy.md §6](strategy.md) for the full eval rubric.)

Reference · **Job Flow Library**

## The 9 electrical job flows.

For each job type, this is what the AI Receptionist asks at intake and how the Estimator structures the Good / Better / Best options. These feed directly into the Vapi system prompt (Step 6) and the Estimator's lookup logic (Step 8). Colour bars indicate v1 routing: green = auto-quote candidate, amber = case-by-case, red = inspection-only.

A

### Downlights / Lighting

auto-quote candidate

Ask at intake

-   How many downlights?
-   New install or replacement?
-   Is cabling already run?
-   What type of ceiling — flat, raked, high?
-   Indoor, outdoor, under deck, or weather-exposed?
-   Warm white, cool white, tri-colour, dimmable, or smart?
-   Roof / ceiling access available?
-   Photos of ceiling and switch location?

Quote logic — Good / Better / Best

**Good**
Standard LED downlights

**Better**
Tri-colour LED downlights

**Best**
Dimmable / IP-rated / smart

B

### Power Points (GPOs)

auto-quote candidate

Ask at intake

-   How many power points?
-   New points or replacing existing?
-   Indoor or outdoor?
-   Wall type — plaster, brick, concrete, tile?
-   Is power nearby?
-   Single, double, USB, weatherproof, or smart GPO?
-   Photos of location?

Quote logic — Good / Better / Best

**Good**
Standard double GPO

**Better**
Premium / USB GPO

**Best**
Weatherproof / smart / extra circuit

Note: any "extra circuit" upgrade triggers `inspection_required=true` — check the existing switchboard before quoting.

C

### Ceiling Fans

auto-quote candidate

Ask at intake

-   How many fans?
-   Existing light or fan there?
-   Customer-supplied fan, or do we supply?
-   Remote control or wall control?
-   Ceiling — flat, raked, or high?
-   Roof access available?

Quote logic — Good / Better / Best

**Good**
Install customer-supplied fan to existing wiring

**Better**
Supply & install quality fan with remote

**Best**
Premium DC fan + light + wall control

D

### Smoke Alarms

auto-quote candidate

Ask at intake

-   How many bedrooms?
-   How many levels?
-   Owner-occupied, rental, or being sold?
-   Need compliance certification?
-   Existing smoke alarms?
-   Battery, hardwired, or interconnected?

Quote logic — Good / Better / Best

**Good**
Replace like-for-like alarms

**Better**
Compliant interconnected alarms

**Best**
Full property compliance package

E

### Outdoor / Deck Lighting

auto-quote candidate

Ask at intake

-   Covered or weather-exposed?
-   How many lights?
-   Cabling already run?
-   Distance from existing power?
-   Switching, sensor, dimmer, or smart control?
-   Functional lighting or feature lighting?
-   Photos of deck / ceiling / switchboard?

Quote logic — Good / Better / Best

**Good**
Basic outdoor-rated lights

**Better**
IP-rated quality fittings

**Best**
Premium dimmable / smart / weatherproof

Note: if cabling is NOT already run and a new circuit is needed → triggers `inspection_required=true`.

F

### Switchboard Work

inspection-only

Ask at intake

-   Photo of the switchboard?
-   Old ceramic fuses or modern breakers?
-   Adding a circuit or upgrading the board?
-   Tripping, buzzing, burning smell, or overheating?
-   Solar, EV charger, pool, or large appliances on the property?
-   Single phase or three phase (if known)?

Quote logic — indicative only

**Good**
Minor breaker / RCBO addition

**Better**
Partial safety upgrade

**Best**
Full switchboard upgrade

Always recommend inspection before fixed price. Burning smell / buzzing → mark `urgency=emergency`.

G

### Oven / Cooktop Install

case-by-case

Ask at intake

-   Oven, cooktop, or both?
-   Gas, electric, or induction?
-   Replacing existing or new install?
-   Model number?
-   Wiring already in place?
-   Does the new appliance need a dedicated circuit?
-   Photos of old appliance, new specs, and switchboard?

Quote logic — Good / Better / Best

**Good**
Like-for-like replacement

**Better**
Install + circuit check

**Best**
Dedicated circuit / switchboard upgrade

Like-for-like with confirmed wiring → auto-quotable. Anything requiring a new circuit or switchboard work → triggers `inspection_required=true`.

H

### EV Charger

inspection-only

Ask at intake

-   Vehicle make / model?
-   Charger model?
-   Single-phase or three-phase property?
-   Distance from switchboard to install location?
-   Wall-mounted, garage, driveway, or outdoor?
-   Solar on the property?
-   Photos of switchboard and install location?

Quote logic — indicative only

**Good**
Basic charger install near switchboard

**Better**
Quality install + load assessment

**Best**
Smart charger with solar / load management

Always recommend inspection. Load assessment is non-negotiable for safety + grid compliance.

I

### Fault Finding

no fixed quote

Ask at intake

-   What's happening?
-   When did it start?
-   Affecting whole house or one area?
-   Any tripping breakers?
-   Burning smell, buzzing, sparks, or water damage?
-   Recent storms, renovations, or new appliances?

Quote logic — diagnostic only

**Do not produce a fixed quote.** Use call-out + hourly diagnostic rate ($120–$180 minimum + $90–$130/hr).

**Customer wording:** _"Faults need testing onsite. We can attend, diagnose the issue, and provide repair options before proceeding with larger work."_

How this maps to the system

The 9 **Ask at intake** blocks become the job-type-specific question routing in the Vapi system prompt (Step 6). The **Quote logic** blocks become the Estimator's tool-use targets (Step 8) — each Good/Better/Best option pulls assemblies and materials from `shared_assemblies` and `shared_materials` via `lookup_assembly` and `lookup_material`. The **case-by-case / inspection-only** tags become the `inspection_required` boolean in the intake schema (Step 7).

## What comes after Stage 05.

You now have the full automation backbone — phone rings, AI converses, intake gets structured, quote gets drafted. The remaining wireframe stages turn this into a complete product:

-   Stage 06

    Workflow Decision · Confidence-Based Routing A rule layer that decides what happens to the draft: auto-send to customer (HIGH confidence), tradie review then send (MEDIUM), or trigger a paid $199 site inspection (LOW).

-   Stage 07

    Customer-facing quote view (Good / Better / Best) A mobile-first portal page where the homeowner opens the quote, sees three tiers, and clicks "accept + deposit" — Stripe Connect Express handles the money.

-   Stage 08

    Availability Nudge Automated SMS that reads the tradie's calendar and creates urgency: "We've had a spot open up this week."

-   Stage 09

    Follow-Up Engine SMS reminders on Day 1 / Day 3 / Day 7 for quotes that haven't accepted yet, with objection handling.

-   Stage 10

    Job Won The accept event triggers calendar booking, deposit capture, CRM update, and notifications to both sides.

Refer to [docs/wireframe.html](wireframe.html) for the full system diagram. Refer to [docs/strategy.md](strategy.md) for the strategic context — particularly the cost analysis around voice infrastructure.

QuoteMate · Automation Build Guide · Wireframe stages 01 → 05
