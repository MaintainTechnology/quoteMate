# stage6-10-sop

_Converted from `stage6-10-sop.html`._

---

  QuoteMate · Beginner Walkthrough · Stages 06 → 10

[QQuoteMate](#)

Beginner Walkthrough · **Stages 06 → 10**

Click-by-click walkthrough · No prior experience required

# Turn drafted quotes into _signed jobs_.

Stages 01–05 ended with a draft quote sitting in your database. This SOP picks up there: route it to the right reviewer, show it to the customer on a phone-friendly page, get them to accept a tier, take a deposit through Stripe Connect, and book the job into a calendar slot. The same baby-step format as the [Stages 01–05 SOP](stage1-05-sop.html).

AudienceFirst-time builder, finished Stages 01–05

Total time~2 working days for v1 scope

New cost surfaceStripe (1.75% + 30¢/AU charge) · Resend free tier

v1 vs v3 split · Read first

Of the five stages in this SOP, **three are genuinely v1 work** (06, 07, 10) and **two are deliberately deferred to v3** (08, 09). Per [strategy.md](strategy.md) and [CLAUDE.md](../CLAUDE.md), v1 ships **tradie-review only** — Stage 06's HIGH-confidence auto-send branch and Stage 09's autonomous follow-up engine are v3 features that compound real liability risk under Australian Consumer Law if you turn them on too early.

For each stage, this SOP marks **v1: build now** vs **v3: design preview only**. If you're shipping the v1 wedge, build 06 + 07 + 10 fully; read 08 + 09 to know what the architecture leaves room for, but don't write that code yet.

## Before you start, read this once.

You already have the pipeline that drafts quotes ([Stages 01–05](stage1-05-sop.html)). What you don't have yet: a way to _show_ a quote to a customer, take their money, and put the job in the diary. This SOP fills that gap.

**What you'll have at the end:** a customer can open a tradie's QuoteMate-provisioned quote URL on their phone, see Good / Better / Best tiers with line items, pick one, pay a deposit through Stripe (which routes to the tradie's bank via Stripe Connect Express), and pick a slot from the tradie's available times. The booked slot is recorded on the quote and removed from the tradie's `available_slots` JSONB (real Google/iCloud calendar API integration is v2 — see [Stage 10's deferred-items callout](#s10) and the wireframe's Layer-5 Calendar entry).

**Three reference docs pair with this one:** [architecture.html](architecture.html) (system shape), [build-guide.html](build-guide.html) (full code blocks), [wireframe.html](wireframe.html) (10-stage product flow + 4-agent decomposition). Open them in adjacent tabs and switch as needed.

**Important rules of thumb:**

-   Same conventions as the Stages 01–05 SOP: Click this = a real button label · Settings → API = menu navigation · value\_here = a field you fill in.
-   Each stage has a **v1 / v3 marker** at the top of its header. Don't accidentally implement a v3 stage in v1.
-   Stripe touches money. Test in **test mode** first; live mode flips later. Never paste your live keys into chat or screenshots.
-   If a step fails, re-read the step. Most beginner failures are skipped sub-steps. Stripe especially has 5–6 things you have to enable in the dashboard before code works.

## The full path.

1.  P0c[Pre-flight C — Three new accounts (Stripe + Resend)](#p0c)~30 min
2.  F3[Foundation 3 — Schema additions for stages 06–10](#f3)~30 min
3.  S06[Stage 06 — Confidence routing](#s06)v1 · ~1 hr
4.  S07[Stage 07 — Customer Good/Better/Best portal](#s07)v1 · ~4 hr
5.  S08[Stage 08 — Availability nudge (v3 design preview)](#s08)v3 · read only
6.  S09[Stage 09 — Follow-up engine (v3 design preview)](#s09)v3 · read only
7.  S10[Stage 10 — Job-won, Stripe Connect deposit + booking](#s10)v1 · ~4 hr
8.  V[Verify — End-to-end test (Stages 01–10)](#verify)~30 min
9.  T[Troubleshooting — common failures](#trouble)reference

Pre-flight C · **New service accounts**

## Sign up for two more services.

Stripe handles money (Connect Express routes deposits to each tradie's own bank account, with QuoteMate taking a platform fee). Resend handles transactional emails (the share-link the customer clicks). Both have free tiers that easily cover testing.

### C.1 — Stripe (payments + Stripe Connect Express)

1.  Sign upGo to [https://dashboard.stripe.com/register](https://dashboard.stripe.com/register). Email + password + business name. You can pick "individual" if you don't have an ABN yet — switch to "company" later.
2.  Stay in test modeTop right of the dashboard, you'll see a Test mode toggle. Make sure it's **ON**. Test keys start with `sk_test_…` and `pk_test_…`; never paste live keys (`sk_live_…`) until you've actually tested.
3.  Get your test API keysLeft sidebar → Developers → API keys. Copy:
    -   **Publishable key** (`pk_test_…`) → STRIPE\_PUBLISHABLE\_KEY
    -   **Secret key** (`sk_test_…`) — click Reveal first → STRIPE\_SECRET\_KEY
4.  Enable ConnectLeft sidebar → Connect → click Get started. Pick Platform or marketplace. Stripe will ask you a few questions about your business model — answer "I'm building a marketplace where service providers earn money".
5.  Configure Connect platform settingsConnect → Settings. Under **Account types**, enable Express. Under **Branding**, upload your QuoteMate logo + brand colour — this is what tradies see when they onboard.
6.  Note your Connect Client IDSame settings page → **Integration** → copy the **Client ID** (starts with `ca_…`) → STRIPE\_CONNECT\_CLIENT\_ID.

AU GST is included by Stripe Tax

Stripe Tax can collect and remit GST automatically on AU charges. Enable it later via Settings → Tax when you go live. For now, the deposit charge in this SOP is GST-inclusive (the price the customer sees) and we tell Stripe Tax to compute the GST component for reporting. Don't double-charge.

### C.2 — Resend (transactional email)

1.  Sign upGo to [https://resend.com/signup](https://resend.com/signup). Use Google login — fastest. Free tier covers 3,000 emails/mo and 100/day, plenty for v1 pilot.
2.  Get your API keyLeft sidebar → API Keys → Create API Key. Name it quotemate-dev. Permission: Full access. Copy and paste as RESEND\_API\_KEY.
3.  Add a verified sending address (optional for now)Until you verify a domain, Resend will only let you send **from `onboarding@resend.dev` to your own signup email**. That's fine for testing. Production: Domains → Add Domain, follow DNS instructions.

### C.3 — Stripe CLI (so webhooks can reach localhost)

Stripe sends webhooks to your server when payments succeed/fail. While you're developing on localhost, the Stripe CLI provides a forwarding tunnel similar to ngrok.

1.  InstallWindows (Scoop): `scoop install stripe`. Mac: `brew install stripe/stripe-cli/stripe`. Or download from [github.com/stripe/stripe-cli/releases](https://github.com/stripe/stripe-cli/releases).
2.  Log in

    ```
    stripe login
    ```

    A browser opens; click Allow access. The CLI stores credentials locally.
3.  Don't forward webhooks yetYou'll start the forwarder in Stage 10.4 once the webhook handler exists.

Done check — Pre-flight C

You have new entries in `.env.local`: `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_CLIENT_ID`, `RESEND_API_KEY`. Stripe dashboard is in test mode and shows Connect → Settings with Express enabled. Stripe CLI installed and logged in.

Foundation 3 · **Schema additions**

## Add 3 columns + 2 tables to Supabase.

Stages 06–10 don't change the existing 7 tables — they layer on. We add a routing decision to `quotes`, a share token + viewed\_at + accepted\_tier + scheduled\_at, and two new tables: `tradies` (for Stripe Connect account IDs) and `payments` (for deposit transactions).

### F3.1 — Run the migration SQL

1.  Create the migration fileIn your Next.js project, create sql/02\_stages\_06\_10.sql. Paste:

    ```
    -- ──────────────────────────────────────────────
    -- F3 · Schema additions for Stages 06–10
    -- Safe to re-run: every alter uses if not exists; tables use if not exists.
    -- ──────────────────────────────────────────────

    -- 1. New columns on quotes for routing + share + booking
    alter table quotes add column if not exists routing_decision text;
      -- 'auto_send' (v3 only) | 'tradie_review' (v1 default) | 'inspection_required'

    alter table quotes add column if not exists share_token text unique;
      -- random URL-safe token; null until the tradie clicks "Send"

    alter table quotes add column if not exists viewed_at timestamptz;
      -- first time the customer opened the quote URL

    alter table quotes add column if not exists accepted_tier text;
      -- 'good' | 'better' | 'best' — set when customer picks a tier

    alter table quotes add column if not exists scheduled_at timestamptz;
      -- chosen booking slot (set after deposit success)

    -- 2. Tradies — one row per electrical contractor onboarded
    create table if not exists tradies (
      id uuid primary key default gen_random_uuid(),
      business_name text not null,
      email text not null unique,
      phone text,
      licence_type text,                                 -- 'NECA', 'ESV', 'QBCC' etc.
      licence_state text,
      licence_number text,
      stripe_account_id text unique,                     -- 'acct_…' from Stripe Connect
      stripe_onboarded_at timestamptz,                  -- set when Connect onboarding completes
      default_deposit_pct numeric(5,2) default 30,    -- % of total taken upfront
      available_slots jsonb default '[]'::jsonb,         -- ['2026-05-02T09:00:00+10:00', ...]
      created_at timestamptz default now()
    );

    -- 3. Payments — one row per Stripe charge attempt (success or fail)
    create table if not exists payments (
      id uuid primary key default gen_random_uuid(),
      quote_id uuid references quotes(id) on delete cascade,
      tradie_id uuid references tradies(id),
      stripe_payment_intent_id text unique,             -- 'pi_…'
      stripe_charge_id text,                            -- 'ch_…' once captured
      amount_inc_gst numeric(12,2),                       -- in dollars (Stripe stores cents; we store dollars for display)
      platform_fee_inc_gst numeric(12,2),                  -- QuoteMate's cut
      status text,                                       -- 'pending' | 'succeeded' | 'failed' | 'refunded'
      created_at timestamptz default now(),
      succeeded_at timestamptz,
      refunded_at timestamptz
    );

    -- 4. Index — share_token is hit on every customer page-load
    create index if not exists idx_quotes_share_token on quotes(share_token) where share_token is not null;

    -- 5. RLS for the new tables (deny-by-default, service_role bypasses)
    alter table tradies enable row level security;
    alter table payments enable row level security;
    ```

2.  Run it via the existing setup pipelineEither paste into Supabase SQL Editor and click Run, or use the script approach from Stage 1–5 SOP:

    ```
    node --env-file=.env.local scripts/run-sql.mjs sql/02_stages_06_10.sql
    ```

    (If you don't have a generic `run-sql.mjs`, copy the structure from `scripts/setup-database.mjs` and parameterise the SQL file path.)
3.  Verify in SupabaseTable Editor → `quotes` should now show 5 new columns at the right edge. Two new tables `tradies` and `payments` should appear in the table list (both with 0 rows).

### F3.2 — Add new env vars to `.env.local`

1.  Append these to `.env.local`

    ```
    # Stripe
    STRIPE_PUBLISHABLE_KEY=pk_test_...
    STRIPE_SECRET_KEY=sk_test_...
    STRIPE_CONNECT_CLIENT_ID=ca_...
    STRIPE_WEBHOOK_SECRET=                 # filled in S10.4 after `stripe listen` runs

    # Resend
    RESEND_API_KEY=re_...
    RESEND_FROM=onboarding@resend.dev      # swap for your verified domain when ready

    # Quote share base URL — what gets emailed/SMSed to customers.
    # Should match the existing APP_URL set in Stages 01–05; you can
    # merge them later or just keep both pointed at the same value.
    QUOTE_SHARE_BASE_URL=http://localhost:3000   # swap for your Vercel URL in production
    ```

2.  Mirror to VercelVercel project → Settings → Environment Variables. Add the same 7 variables for Production / Preview / Development. Use your live Vercel URL for `QUOTE_SHARE_BASE_URL` there.

### F3.3 — Install the new libraries

1.  In your terminal

    ```
    cd quotemate-automation
    pnpm add stripe resend
    ```

    -   `stripe` — the server-side Stripe SDK; this SOP uses Stripe Checkout (hosted page), so the browser-side `@stripe/stripe-js` loader isn't needed in v1. Add it later if you migrate to in-page Stripe Elements per the wireframe's stage-07 spec.
    -   `resend` — the server-side email client
2.  Seed a test tradie rowStage 10 needs a tradie record with a Stripe account before you can test deposits. For now, insert a placeholder via SQL Editor:

    ```
    insert into tradies (business_name, email, licence_type, licence_state, licence_number)
    values ('Anant Electrical', 'anant@example.com', 'NECA', 'NSW', 'EC-123456')
    returning id;
    ```

    Save the returned UUID — you'll reference it in Stage 10.

Done check — Foundation 3

Quotes table has the 5 new columns. `tradies` table has 1 row. `payments` table exists with 0 rows. `.env.local` has 7 new variables (with the webhook secret blank for now). `pnpm` dependencies install cleanly.

Stage 06 · **v1 — build now** · _Quote Reviewer's confidence gate_

## Confidence routing.

Take the freshly-drafted quote and decide which path it goes down: tradie review (v1 default), paid site inspection (always for inspection-required jobs), or auto-send (v3 only — **do not enable in v1**). The Estimation Engine already produces the inputs (`intake.confidence`, `quote.needs_inspection`); this stage just records the decision in the new `routing_decision` column. _Note:_ the wireframe's Stage 06 description mentions a "Haiku sanity check" alongside the rule-based logic — that LLM second-look is v3 polish; v1 ships pure rule-based routing because the rule set is simple enough that an LLM check adds latency without catching anything the rules miss.

### S6.1 — Create the routing helper

1.  Create the folderInside `lib`, create folder routing.
2.  Create decide.tsInside `lib/routing`, create decide.ts and paste:

    ```
    // Three-branch confidence router (wireframe stage 06).
    // v1 only emits 'tradie_review' or 'inspection_required' — auto_send is
    // v3+ once the eval framework hits 80%+ on the 100-pair hold-out set.

    export type RoutingDecision = 'auto_send' | 'tradie_review' | 'inspection_required'

    export type RoutingInput = {
      intake: { confidence: 'LOW' | 'MEDIUM' | 'HIGH'; inspection_required: boolean }
      quote: { needs_inspection: boolean }
      v3AutoSendEnabled?: boolean   // flip to true ONLY after eval framework passes
    }

    export function decideRouting(input: RoutingInput): RoutingDecision {
      const { intake, quote, v3AutoSendEnabled = false } = input

      // Strongest signal wins: anything Stage 04 or 05 marks as inspection-required
      // goes through the paid-site-visit path no matter what the LLM said about confidence.
      if (intake.inspection_required || quote.needs_inspection) return 'inspection_required'

      // HIGH confidence + clean scope: candidate for auto-send IF the v3 flag is on.
      // In v1 (v3AutoSendEnabled=false) intake.confidence is read but doesn't change
      // behavior — every non-inspection quote falls through to tradie_review. The
      // confidence field is wired here forward-compatibly so flipping the flag in v3
      // is a one-line change rather than a re-architecture.
      if (intake.confidence === 'HIGH' && v3AutoSendEnabled) return 'auto_send'

      // v1 default: tradie reviews every quote before it goes to the customer.
      return 'tradie_review'
    }
    ```

### S6.2 — Wire it into `/api/estimate/draft`

1.  Open `app/api/estimate/draft/route.ts`You're going to add one import and one extra field on the insert.
2.  Add the importNear the top:

    ```
    import { decideRouting } from '@/lib/routing/decide'
    ```

3.  Compute the decision before the insertRight before the `supabase.from('quotes').insert(...)` call, add:

    ```
    const routing_decision = decideRouting({
      intake: {
        confidence: intake.confidence,
        inspection_required: intake.inspection_required,
      },
      quote: { needs_inspection: draft.needs_inspection ?? false },
      v3AutoSendEnabled: false,   // v1 hardcode — flip to env-flag in v3
    })
    ```

4.  Add it to the insert payloadInside the `{...}` argument to `.insert()`, add a new line:

    ```
    routing_decision,
    ```

### S6.3 — Test it

1.  Re-run the V.2 simulator(the clean downlights call from the Stages 01–05 SOP)

    ```
    node --env-file=.env.local scripts/test-stage-05.mjs
    ```

2.  Inspect the latest quote rowIn Supabase Table Editor → `quotes` → newest row → check the `routing_decision` column. For a clean downlights quote with HIGH/MEDIUM confidence and no inspection flag, you should see tradie\_review.
3.  Re-run the V.3 simulator(the burning-smell + EV charger inspection scenario)

    ```
    node --env-file=.env.local scripts/test-v3-inspection.mjs
    ```

    The new quote row should have `routing_decision = 'inspection_required'`.

Don't flip `v3AutoSendEnabled` to true in v1

The whole liability shield in v1 is "tradie reviewed every quote before it went to the customer." Australian Consumer Law treats accepted quotes as binding contracts — an auto-sent wrong quote becomes a refund or a lawsuit. Read the decision log in [wireframe.html](wireframe.html) if you're tempted.

Done check — Stage 06

Every new row in `quotes` has a non-null `routing_decision` field. Clean auto-quote-5 jobs route to `tradie_review`; switchboard / EV / fault-finding / renovation jobs route to `inspection_required`; nothing routes to `auto_send` in v1.

Stage 07 · **v1 — build now** · _Customer-facing surface produced by the Reviewer_

## Customer Good / Better / Best portal.

A token-protected URL like `https://yourapp.vercel.app/quote/abc123def456` that the customer opens on their phone. Three pricing cards, line items per tier, one-tap accept. No customer login — security is the random share token. Email/SMS the link when the tradie clicks "Send".

Two wireframe-listed bits deferred to v2

The wireframe lists **react-pdf** (server-side PDF generation per quote) and **shadcn/ui** (component primitives) as part of Stage 07's stack. This SOP ships **HTML-only** rendering with raw Tailwind classes — that's enough for tier selection on a phone, and matches what your existing `app/page.tsx` already uses. Add `react-pdf` when you need an emailable PDF attachment (for archival or when the customer wants a print-friendly copy), and retrofit `shadcn/ui` when you do a v2 polish pass on the customer-facing UI. Neither blocks v1 conversion.

### S7.1 — Create the share-token helper

1.  Create the folderInside `lib`, create folder quotes.
2.  Create share-link.tsInside `lib/quotes`, create share-link.ts:

    ```
    import { randomBytes } from 'node:crypto'

    // 16 bytes = 128 bits, hex-encoded → 32 chars URL-safe.
    // Probability of a random guess hitting any active quote is ≈ 0 even at scale.
    export function generateShareToken(): string {
      return randomBytes(16).toString('hex')
    }

    export function shareUrlFor(token: string): string {
      const base = process.env.QUOTE_SHARE_BASE_URL ?? 'http://localhost:3000'
      return `${base}/quote/${token}`
    }
    ```

### S7.2 — Create the email sender (Resend)

1.  Create lib/email/send-quote.tsInside `lib`, create folder email, then send-quote.ts:

    ```
    import { Resend } from 'resend'

    const resend = new Resend(process.env.RESEND_API_KEY!)

    export async function sendQuoteEmail(opts: {
      to: string
      customerName: string
      tradieBusinessName: string
      shareUrl: string
      totalIncGst: number
    }) {
      const { data, error } = await resend.emails.send({
        from: process.env.RESEND_FROM ?? 'onboarding@resend.dev',
        to: opts.to,
        subject: `Your quote from ${opts.tradieBusinessName}`,
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
            <h1 style="font-size: 22px; color: #1a1a1a;">G'day ${opts.customerName},</h1>
            <p style="color: #4a4a4a; line-height: 1.55;">
              Your quote from ${opts.tradieBusinessName} is ready. We've put together three options
              so you can pick what suits — total starts from $${opts.totalIncGst.toFixed(2)} inc-GST.
            </p>
            <a href="${opts.shareUrl}" style="display: inline-block; background: #0066cc; color: white; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 20px 0;">
              Open your quote
            </a>
            <p style="color: #6b6b6b; font-size: 13px; line-height: 1.5;">
              This quote is valid for 14 days. If you have questions, reply to this email
              and ${opts.tradieBusinessName} will get back to you directly.
            </p>
          </div>
        `,
      })
      if (error) throw new Error(`Resend failed: ${error.message}`)
      return data
    }
    ```

### S7.3 — Create the "send quote" API route

This is what the tradie's review dashboard will call when they approve a quote. For now we'll trigger it manually with curl. The route generates the token, persists it, and sends the email.

1.  Create folder + file`app/api/quote/send/route.ts`:

    ```
    import { createClient } from '@supabase/supabase-js'
    import { generateShareToken, shareUrlFor } from '@/lib/quotes/share-link'
    import { sendQuoteEmail } from '@/lib/email/send-quote'

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export async function POST(req: Request) {
      try {
        const { quoteId } = await req.json()

        // 1. Load quote + intake (for customer email + name)
        const { data: quote } = await supabase
          .from('quotes')
          .select('*, intakes(caller, address, suburb)')
          .eq('id', quoteId)
          .single()
        if (!quote) return Response.json({ error: 'quote not found' }, { status: 404 })

        // 2. Load tradie (for business name) — for v1 there's just one row
        const { data: tradie } = await supabase.from('tradies').select('*').single()

        // 3. Generate token if quote doesn't have one yet
        const token = quote.share_token ?? generateShareToken()
        if (!quote.share_token) {
          await supabase
            .from('quotes')
            .update({ share_token: token, status: 'sent', sent_at: new Date().toISOString() })
            .eq('id', quoteId)
        }

        // 4. Send the email — Resend free tier only allows your own email
        // in test mode. Use your signup email here while developing.
        const caller = (quote.intakes as any)?.caller ?? {}
        await sendQuoteEmail({
          to: caller.email ?? process.env.RESEND_TEST_RECIPIENT ?? 'you@example.com',
          customerName: caller.name ?? 'there',
          tradieBusinessName: tradie?.business_name ?? 'your sparky',
          shareUrl: shareUrlFor(token),
          totalIncGst: Number(quote.total_inc_gst ?? 0),
        })

        return Response.json({ ok: true, shareUrl: shareUrlFor(token) })
      } catch (err: any) {
        console.error('[/api/quote/send] error:', err)
        return Response.json({ ok: false, error: err?.message }, { status: 500 })
      }
    }
    ```

### S7.4 — Build the customer portal page

1.  Create the folderInside `app`, create folder quote, then a dynamic-route folder \[token\], then a page.tsx file inside it.
2.  Paste the page`app/quote/[token]/page.tsx`:

    ```
    import { createClient } from '@supabase/supabase-js'
    import { notFound } from 'next/navigation'
    import { AcceptForm } from './AcceptForm'

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export default async function QuotePage({ params }: { params: Promise<{ token: string }> }) {
      const { token } = await params

      const { data: quote } = await supabase
        .from('quotes')
        .select('*, intakes(caller, suburb, job_type)')
        .eq('share_token', token)
        .single()

      if (!quote) notFound()

      // Mark first-view timestamp (fire-and-forget)
      if (!quote.viewed_at) {
        supabase.from('quotes').update({ viewed_at: new Date().toISOString() }).eq('id', quote.id)
      }

      const { data: tradie } = await supabase.from('tradies').select('business_name, licence_type, licence_state, licence_number').single()
      const caller = (quote.intakes as any)?.caller ?? {}

      return (
        <main className="max-w-2xl mx-auto px-5 py-8 font-sans">
          <header className="mb-8">
            <p className="text-sm text-zinc-500 uppercase tracking-widest mb-1">Your quote</p>
            <h1 className="text-3xl font-extrabold text-zinc-900 leading-tight">
              {tradie?.business_name ?? 'Your electrician'}
            </h1>
            <p className="text-zinc-600 mt-2">
              {caller.name ? `G'day ${caller.name}, ` : ''}here are three options for your{' '}
              <strong>{(quote.intakes as any)?.job_type?.replace('_', ' ')}</strong> job in{' '}
              {(quote.intakes as any)?.suburb}.
            </p>
          </header>

          <section className="mb-8 p-5 rounded-lg border border-zinc-200 bg-zinc-50">
            <h2 className="font-semibold text-zinc-900 mb-2">Scope of works</h2>
            <p className="text-sm text-zinc-700 leading-relaxed">{quote.scope_of_works}</p>
          </section>

          <div className="grid gap-4 mb-8">
            {(['good', 'better', 'best'] as const).map((tier) => {
              const t = (quote as any)[tier]
              if (!t) return null
              const selected = quote.selected_tier === tier
              return (
                <div key={tier} className={`rounded-xl border-2 p-5 ${selected ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 bg-white'}`}>
                  <div className="flex items-baseline justify-between mb-2">
                    <p className="text-xs uppercase tracking-widest text-zinc-500">{tier}</p>
                    <p className="text-2xl font-bold text-zinc-900">${Number(t.subtotal_ex_gst).toFixed(2)}</p>
                  </div>
                  <h3 className="font-semibold text-zinc-900 mb-3">{t.label}</h3>
                  <ul className="text-sm text-zinc-700 space-y-1 mb-3">
                    {(t.line_items ?? []).map((li: any, i: number) => (
                      <li key={i}>· {li.description} {li.quantity > 1 && `× ${li.quantity}`}</li>
                    ))}
                  </ul>
                  <p className="text-xs text-zinc-500">Timeframe: {t.timeframe}</p>
                </div>
              )
            })}
          </div>

          {quote.needs_inspection && (
            <div className="mb-8 p-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">
              <strong>These prices are indicative.</strong> A $199 site inspection is required to confirm scope and lock in a fixed price. The site fee is fully refunded automatically when you accept the resulting quote.
            </div>
          )}

          <AcceptForm quoteId={quote.id} token={token} />

          <footer className="mt-12 pt-6 border-t border-zinc-200 text-xs text-zinc-500">
            Licensed: {tradie?.licence_type} {tradie?.licence_state} · {tradie?.licence_number}
            <br />
            Quote ID: {quote.id} · {quote.gst_note}
          </footer>
        </main>
      )
    }
    ```

3.  Create the AcceptForm component`app/quote/[token]/AcceptForm.tsx` — this needs `'use client'` because it has interactive state:

    ```
    'use client'

    import { useState } from 'react'
    import { useRouter } from 'next/navigation'

    export function AcceptForm({ quoteId, token }: { quoteId: string; token: string }) {
      const [tier, setTier] = useState<'good' | 'better' | 'best'>('better')
      const [submitting, setSubmitting] = useState(false)
      const router = useRouter()

      async function accept() {
        setSubmitting(true)
        const res = await fetch(`/api/quote/${token}/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier }),
        })
        if (!res.ok) {
          setSubmitting(false)
          alert('Something went wrong — please try again.')
          return
        }
        const { redirectTo } = await res.json()
        router.push(redirectTo)
      }

      return (
        <div className="p-5 rounded-xl border-2 border-zinc-900 bg-white">
          <h3 className="font-semibold text-zinc-900 mb-3">Pick your option</h3>
          <div className="flex gap-2 mb-4">
            {(['good', 'better', 'best'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTier(t)}
                className={`flex-1 py-2 rounded-lg font-semibold capitalize ${tier === t ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-700'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <button
            onClick={accept}
            disabled={submitting}
            className="w-full py-3 rounded-lg bg-blue-600 text-white font-semibold disabled:opacity-50"
          >
            {submitting ? 'Loading…' : 'Accept and pay deposit'}
          </button>
          <p className="text-xs text-zinc-500 mt-3 leading-relaxed">
            By accepting, you agree to a 30% deposit charged via Stripe. The remainder is invoiced on completion.
          </p>
        </div>
      )
    }
    ```

### S7.5 — Create the accept route (records tier, redirects to Stripe)

1.  Create folder + file`app/api/quote/[token]/accept/route.ts`. Stage 10 will fill in the actual Stripe Checkout creation here — for now we just record the chosen tier.

    ```
    import { createClient } from '@supabase/supabase-js'

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export async function POST(
      req: Request,
      { params }: { params: Promise<{ token: string }> }
    ) {
      const { token } = await params
      const { tier } = await req.json()

      if (!['good', 'better', 'best'].includes(tier)) {
        return Response.json({ error: 'invalid tier' }, { status: 400 })
      }

      const { data: quote } = await supabase
        .from('quotes')
        .update({ accepted_tier: tier, selected_tier: tier })
        .eq('share_token', token)
        .select()
        .single()

      if (!quote) return Response.json({ error: 'quote not found' }, { status: 404 })

      // In Stage 10 this will redirect to Stripe Checkout. For now it just
      // confirms the tier and sends them to a placeholder /quote/[token]/pay page.
      return Response.json({ ok: true, redirectTo: `/quote/${token}/pay` })
    }
    ```

2.  Create a placeholder pay page`app/quote/[token]/pay/page.tsx` — Stage 10 replaces this with the real Stripe deposit flow:

    ```
    export default function PayPlaceholder() {
      return (
        <main className="max-w-2xl mx-auto px-5 py-12 text-center">
          <h1 className="text-2xl font-bold mb-3">Tier accepted ✓</h1>
          <p className="text-zinc-600">Stage 10 wires the Stripe deposit form into this page.</p>
        </main>
      )
    }
    ```

### S7.6 — Test the customer flow

1.  Trigger the send routePick a recent quote ID from your `quotes` table. In a terminal:

    ```
    curl -X POST http://localhost:3000/api/quote/send \
      -H "Content-Type: application/json" \
      -d '{"quoteId":"PASTE_QUOTE_UUID"}'
    ```

    You should get back `{"ok":true,"shareUrl":"http://localhost:3000/quote/abc123…"}`.
2.  Open the shareUrl in your browserYou should see the Good / Better / Best portal — three tier cards, scope of works, accept form. Click between tiers; the highlight moves.
3.  Click AcceptBrowser redirects to `/quote/[token]/pay` placeholder. Back in Supabase, the quote row's `accepted_tier` should be set, and `viewed_at` should be populated.
4.  Check ResendIf you used your own email as the recipient, you should have received the quote email within ~10 seconds. Click the link inside it — it should land on the same portal.

**Troubleshooting:** If the page is blank with a 404, check the URL — the token must match the database value exactly (32 hex chars). If accepting fails with a 404 from the API, your dynamic route folder name needs square brackets: `app/api/quote/[token]/accept/route.ts`. If the email doesn't arrive, Resend rejected the recipient — free tier only sends to your own signup email until you verify a domain.

Done check — Stage 07

One curl POST to `/api/quote/send` creates a share token and emails it. The customer can open the share URL, see three pricing tiers, pick one, and land on the placeholder pay page. `quotes.accepted_tier`, `quotes.share_token`, and `quotes.viewed_at` all populate correctly.

Stage 08 · **v3 — design preview only, do not build in v1**

## Availability nudge.

When a high-confidence quote sits unaccepted for >24 hours and the tradie has a slot opening up this week, send the customer a gentle "we've got a window — want to lock this in?" SMS. Genuine, not spammy: the slot is real, and the tradie chose to surface it. **This stage is v3** — wait until you have signal that v1 conversion needs a bump before turning it on.

### Why this is deferred to v3

-   **Real spots required.** Sending "we have a spot Wednesday" without a real Wednesday spot is fraud-shaped. Stage 08 only works once the tradie's calendar is live (which itself is half of Stage 10) AND the calendar has stable read access.
-   **Conversion data first.** Until you've seen 50–100 real quotes go through the customer portal, you don't know whether nudges actually move acceptance rate. Build the measurement (Stage 09's reply tracking) before the intervention.
-   **Twilio outbound SMS** requires opt-in disclosure under Australian Spam Act 2003. The tradie's quote-page footer must say "we may contact you about this quote by SMS for the next 14 days" before you can send anything.

### Architectural sketch (when v3 ships)

1.  **Vercel Cron** runs `/api/cron/nudge-eligible` every hour. The route queries quotes where: `status = 'sent'` AND `accepted_tier IS NULL` AND `viewed_at > 24h ago` AND `routing_decision != 'inspection_required'`.
2.  For each eligible quote, check the tradie's `available_slots` JSONB — if there's a slot in the next 7 days that wasn't there at quote-send time, this is a "newly opened" slot worth surfacing.
3.  Generate the SMS body via Claude Haiku 4.5 with a fixed prompt: _"Write a 1-sentence SMS in friendly Australian tradie tone offering this newly-opened slot. Mention the suburb. No emoji."_
4.  Send via Twilio Messaging API; record send in a new `nudges` table to enforce a max of 1 nudge per quote.
5.  If the customer replies (Twilio inbound webhook), pause the nudge engine and route the message to the tradie's review dashboard.

v1 builders: skip this section

Don't build Stage 08 in v1. It compounds liability (auto-SMSing customers without strong opt-in evidence) and burns Twilio credit before you have product-market signal. The wireframe leaves room for it; the SOP leaves it out.

Stage 09 · **v3 — design preview only, do not build in v1**

## Follow-up engine.

Day 1 / Day 3 / Day 7 SMS to quotes that were viewed but not accepted. Pauses on customer reply. Hands off to the tradie's review dashboard when the customer asks a question. Same SMS-compliance constraint as Stage 08; same "wait for v1 conversion data" reasoning.

### Architectural sketch (when v3 ships)

1.  **Vercel Workflow (Durable Tasks)** rather than Vercel Cron — you need pause/resume for "if the customer replies, stop the sequence". Cron-based polling fights against this; durable workflows are designed for it.
2.  On `quotes.sent_at` set, kick off a workflow with three timed steps: `+24h`, `+72h`, `+7d`. Each step calls `/api/follow-up/send` if the quote is still `accepted_tier IS NULL`.
3.  Body templates per step:
    -   Day 1: _"G'day {name}, just checking the quote arrived alright. Any questions?"_
    -   Day 3: _"Hi {name}, the quote's still active for 11 more days. Happy to walk through any options if helpful."_
    -   Day 7: _"Last touch — quote expires {date}. Reply STOP to opt out."_
4.  Twilio inbound webhook at `/api/twilio/sms` watches for replies. Any non-STOP reply pauses the workflow and creates a row in a `customer_messages` table the tradie reviews.
5.  Track open rate / reply rate / accept-after-followup rate for each step. Cut steps that don't move the metric.

v1 builders: skip this section

Manual follow-up (the tradie SMSes from their own phone) is cheaper, more compliant, and produces better data in v1. Build the automation only when you have enough volume that manual follow-up doesn't scale.

Stage 10 · **v1 — build now (deposit + booking)** · _Conversion Engine — v1 deposit slice_

## Job won — Stripe Connect deposit + slot booking.

Customer accepts a tier → Stripe Checkout collects a 30% deposit → Stripe webhook fires → quote status flips to `'accepted'` → customer picks a booking slot from the tradie's available times → tradie gets push-notified. **v1 scope is deposit + slot.** CRM / Xero / push notifications are v3+ — we'll surface them in the doc but skip the build.

### S10.1 — Onboard the test tradie to Stripe Connect

Before any customer can pay, the tradie needs a Stripe Connect Express account so the deposit gets routed to them (minus QuoteMate's platform fee). For v1 you onboard one test tradie manually.

1.  Create the onboarding API route`app/api/stripe/connect/onboard/route.ts`:

    ```
    import Stripe from 'stripe'
    import { createClient } from '@supabase/supabase-js'

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export async function POST(req: Request) {
      const { tradieId } = await req.json()
      const { data: tradie } = await supabase.from('tradies').select('*').eq('id', tradieId).single()
      if (!tradie) return Response.json({ error: 'tradie not found' }, { status: 404 })

      // Reuse existing account if we already onboarded them
      let accountId = tradie.stripe_account_id
      if (!accountId) {
        const account = await stripe.accounts.create({
          type: 'express',
          country: 'AU',
          email: tradie.email,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_profile: { name: tradie.business_name, mcc: '1731' }, // 1731 = Electrical Contractors
        })
        accountId = account.id
        await supabase.from('tradies').update({ stripe_account_id: accountId }).eq('id', tradieId)
      }

      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${process.env.QUOTE_SHARE_BASE_URL}/onboard/refresh`,
        return_url: `${process.env.QUOTE_SHARE_BASE_URL}/onboard/done`,
        type: 'account_onboarding',
      })

      return Response.json({ url: link.url, accountId })
    }
    ```

2.  Trigger onboarding for your test tradie

    ```
    curl -X POST http://localhost:3000/api/stripe/connect/onboard \
      -H "Content-Type: application/json" \
      -d '{"tradieId":"PASTE_TRADIE_UUID"}'
    ```

    Response includes a `url` — open it in a browser. Stripe will walk you through their onboarding (business details, bank account). **In test mode, you can fill anything — use the test bank routing number `110000000` and account `000123456789`.**
3.  Confirm onboardingAfter completing the Stripe flow, your `tradies` row should have `stripe_account_id` populated. The webhook in S10.4 will mark `stripe_onboarded_at` when Stripe confirms.

### S10.2 — Build the deposit Checkout route

Replace the placeholder accept-route's redirect with a real Stripe Checkout Session that takes 30% of the accepted tier's total.

1.  Update `app/api/quote/[token]/accept/route.ts`Replace the body of the function with:

    ```
    import { createClient } from '@supabase/supabase-js'
    import Stripe from 'stripe'

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export async function POST(
      req: Request,
      { params }: { params: Promise<{ token: string }> }
    ) {
      const { token } = await params
      const { tier } = await req.json()
      if (!['good', 'better', 'best'].includes(tier)) {
        return Response.json({ error: 'invalid tier' }, { status: 400 })
      }

      const { data: quote } = await supabase
        .from('quotes')
        .select('*')
        .eq('share_token', token)
        .single()
      if (!quote) return Response.json({ error: 'quote not found' }, { status: 404 })

      // One tradie in v1; in v2 you'd resolve via the quote's owner
      const { data: tradie } = await supabase.from('tradies').select('*').single()
      if (!tradie?.stripe_account_id) {
        return Response.json({ error: 'tradie has not finished Stripe onboarding' }, { status: 400 })
      }

      // 30% of the tier's inc-GST total — convert dollars to cents
      const tierData = (quote as any)[tier]
      const subtotalExGst = Number(tierData?.subtotal_ex_gst ?? 0)
      const totalIncGst = subtotalExGst * 1.10
      const depositAmount = Math.round(totalIncGst * (tradie.default_deposit_pct ?? 30) / 100 * 100) // in cents
      const platformFee = Math.round(depositAmount * 0.05) // QuoteMate keeps 5% of the deposit

      // Mark accepted tier before creating session — if Stripe fails we still know what they picked
      await supabase.from('quotes').update({ accepted_tier: tier, selected_tier: tier }).eq('id', quote.id)

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        automatic_payment_methods: { enabled: true },     // supports card, Apple Pay, Google Pay automatically
        automatic_tax: { enabled: false },               // our deposit is GST-inclusive; flip to true + tax_behavior:'inclusive' when Stripe Tax goes live to avoid double-GST
        currency: 'aud',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'aud',
            unit_amount: depositAmount,
            product_data: { name: `Deposit · ${tradie.business_name} · ${tier}` },
          },
        }],
        payment_intent_data: {
          application_fee_amount: platformFee,
          transfer_data: { destination: tradie.stripe_account_id },
          metadata: { quoteId: quote.id, tier, tradieId: tradie.id },
        },
        success_url: `${process.env.QUOTE_SHARE_BASE_URL}/quote/${token}/book?session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.QUOTE_SHARE_BASE_URL}/quote/${token}`,
      })

      // Record the pending payment so we can correlate the webhook later
      await supabase.from('payments').insert({
        quote_id: quote.id,
        tradie_id: tradie.id,
        stripe_payment_intent_id: session.payment_intent as string,
        amount_inc_gst: depositAmount / 100,
        platform_fee_inc_gst: platformFee / 100,
        status: 'pending',
      })

      return Response.json({ ok: true, redirectTo: session.url })
    }
    ```

### S10.3 — Build the booking page

1.  Create `app/quote/[token]/book/page.tsx`Customer lands here after Stripe success\_url. Show the tradie's available slots, let them pick one.

    ```
    import { createClient } from '@supabase/supabase-js'
    import { notFound } from 'next/navigation'
    import { SlotPicker } from './SlotPicker'

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export default async function BookPage({ params }: { params: Promise<{ token: string }> }) {
      const { token } = await params
      const { data: quote } = await supabase.from('quotes').select('*').eq('share_token', token).single()
      if (!quote) notFound()

      const { data: tradie } = await supabase.from('tradies').select('available_slots, business_name').single()
      const slots = (tradie?.available_slots as string[]) ?? []

      return (
        <main className="max-w-2xl mx-auto px-5 py-8">
          <header className="mb-6">
            <p className="text-sm text-emerald-600 font-semibold mb-1">✓ Deposit received</p>
            <h1 className="text-3xl font-extrabold text-zinc-900">Pick a time slot.</h1>
            <p className="text-zinc-600 mt-2">
              {tradie?.business_name} has these slots available. Pick what suits — they'll confirm via SMS.
            </p>
          </header>
          <SlotPicker token={token} slots={slots} />
        </main>
      )
    }
    ```

2.  Create `app/quote/[token]/book/SlotPicker.tsx`

    ```
    'use client'
    import { useState } from 'react'

    export function SlotPicker({ token, slots }: { token: string; slots: string[] }) {
      const [picked, setPicked] = useState<string | null>(null)
      const [done, setDone] = useState(false)

      async function book() {
        if (!picked) return
        const res = await fetch(`/api/quote/${token}/book`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot: picked }),
        })
        if (res.ok) setDone(true)
      }

      if (done) return <p className="text-emerald-700 font-semibold text-lg">You're booked. The tradie will SMS to confirm.</p>

      return (
        <div>
          <div className="grid gap-2 mb-4">
            {slots.map((s) => (
              <button
                key={s}
                onClick={() => setPicked(s)}
                className={`p-4 rounded-lg border text-left ${picked === s ? 'border-blue-500 bg-blue-50' : 'border-zinc-200'}`}
              >
                {new Date(s).toLocaleString('en-AU', { dateStyle: 'full', timeStyle: 'short' })}
              </button>
            ))}
          </div>
          <button
            onClick={book}
            disabled={!picked}
            className="w-full py-3 rounded-lg bg-blue-600 text-white font-semibold disabled:opacity-50"
          >
            Lock this slot in
          </button>
        </div>
      )
    }
    ```

3.  Create `app/api/quote/[token]/book/route.ts`

    ```
    import { createClient } from '@supabase/supabase-js'

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    export async function POST(
      req: Request,
      { params }: { params: Promise<{ token: string }> }
    ) {
      const { token } = await params
      const { slot } = await req.json()

      // Set scheduled_at on the quote and remove the slot from the tradie's available list.
      const { data: quote } = await supabase
        .from('quotes')
        .update({ scheduled_at: slot, status: 'accepted', accepted_at: new Date().toISOString() })
        .eq('share_token', token)
        .select()
        .single()
      if (!quote) return Response.json({ error: 'quote not found' }, { status: 404 })

      const { data: tradie } = await supabase.from('tradies').select('*').single()
      const remaining = ((tradie?.available_slots as string[]) ?? []).filter((s) => s !== slot)
      await supabase.from('tradies').update({ available_slots: remaining }).eq('id', tradie!.id)

      return Response.json({ ok: true })
    }
    ```

4.  Seed some test slotsIn Supabase SQL Editor:

    ```
    update tradies
    set available_slots = '["2026-05-05T09:00:00+10:00","2026-05-06T13:00:00+10:00","2026-05-07T15:00:00+10:00"]'::jsonb
    where id = 'PASTE_TRADIE_UUID';
    ```

### S10.4 — Build the Stripe webhook

Stripe POSTs to a webhook when payments succeed/fail. The handler updates the `payments` row and flips the quote's status.

1.  Create `app/api/stripe/webhook/route.ts`

    ```
    import Stripe from 'stripe'
    import { createClient } from '@supabase/supabase-js'

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!

    export async function POST(req: Request) {
      const sig = req.headers.get('stripe-signature')!
      const body = await req.text()

      let event: Stripe.Event
      try {
        event = stripe.webhooks.constructEvent(body, sig, WEBHOOK_SECRET)
      } catch (err: any) {
        console.error('[stripe/webhook] signature failed:', err.message)
        return Response.json({ error: 'invalid signature' }, { status: 400 })
      }

      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object as Stripe.PaymentIntent
        const quoteId = pi.metadata?.quoteId

        await supabase
          .from('payments')
          .update({
            stripe_charge_id: String(pi.latest_charge ?? ''),
            status: 'succeeded',
            succeeded_at: new Date().toISOString(),
          })
          .eq('stripe_payment_intent_id', pi.id)

        // Don't flip quote.status to 'accepted' here — that happens at booking time.
        // 'sent' → 'deposit_paid' is a useful intermediate state if you want it.
        if (quoteId) {
          await supabase.from('quotes').update({ status: 'deposit_paid' }).eq('id', quoteId)
        }
      }

      if (event.type === 'account.updated') {
        const acct = event.data.object as Stripe.Account
        if (acct.charges_enabled && acct.payouts_enabled) {
          await supabase
            .from('tradies')
            .update({ stripe_onboarded_at: new Date().toISOString() })
            .eq('stripe_account_id', acct.id)
        }
      }

      return Response.json({ received: true })
    }
    ```

2.  Start the Stripe CLI forwarderIn a third terminal (you should already have `pnpm dev` in one and `ngrok http 3000` in another):

    ```
    stripe listen --forward-to http://localhost:3000/api/stripe/webhook
    ```

    The CLI prints a webhook signing secret like `whsec_…`. Copy it into `.env.local` as STRIPE\_WEBHOOK\_SECRET. Restart `pnpm dev` so the new env var loads.

### S10.5 — Test the full Stage 10 flow

1.  From your customer portal, click AcceptYou should be redirected to Stripe Checkout (real Stripe-hosted page).
2.  Use a test cardNumber `4242 4242 4242 4242`, any future expiry (`12/34`), any CVC (`123`), any postcode. [More test cards here](https://stripe.com/docs/testing) — including ones that fail authentication, are declined, etc.
3.  Complete the paymentStripe redirects to `/quote/[token]/book?session=cs_…` — your booking page.
4.  Pick a slotClick one of the seeded slots → "Lock this slot in" → success message.
5.  Check Supabase
    -   `quotes` row → `status` = `'accepted'`, `accepted_tier` set, `scheduled_at` set
    -   `payments` row → `status` = `'succeeded'`, `stripe_charge_id` populated
    -   `tradies` row → `available_slots` has the picked slot removed
6.  Check Stripe dashboardPayments → All payments shows the charge. Connect → Connected accounts shows the platform fee separated from the tradie's net.

v3+ items deliberately skipped

**Push notifications to the tradie** — the wireframe describes "Tradie push-notified · customer confirmed". Build this with Resend (transactional email to tradie) or via a tradie-side mobile app in v3.

**CRM / Xero integration** — the wireframe lists this as v3+ ("CRM / Xero integration", layer-2 of the architecture). Once the tradie pilot validates the v1 flow, sync accepted jobs to Xero invoicing via their API.

**Real calendar API** — the wireframe specifies _"Calendar integration · Google + iCloud — auto-block on accept"_ in the architecture's Layer 5. This SOP uses a JSONB array of slots on the `tradies` row instead — defensible v1 simplification because real calendar OAuth (Google + Apple) is a 2–3 day implementation that doesn't unblock customer testing. Swap to Google Calendar API (read availability + write booked block) or Cal.com when v2 ships.

Done check — Stage 10

One real test card transaction completes the loop: portal → tier accepted → Stripe Checkout → deposit captured → booking page → slot picked → quote.status = 'accepted'. The Stripe dashboard shows the charge with platform fee separated, your `payments` table has a 'succeeded' row, and the slot is removed from the tradie's `available_slots`.

Verify · **End-to-end test (Stages 01–10)**

## Run the full pipeline once.

By the end of this test, a single test phone call (or simulator run) should produce: a `calls` row, an `intakes` row, a `quotes` row with three tiers + routing decision, an emailed share link, a customer-accepted tier, a Stripe deposit charge, and a booked slot.

### V.1 — Pre-flight checklist

-   ☐ Terminal 1: `pnpm dev`
-   ☐ Terminal 2: `ngrok http 3000`
-   ☐ Terminal 3: `stripe listen --forward-to http://localhost:3000/api/stripe/webhook`
-   ☐ Vapi assistant Server URL is current ngrok URL
-   ☐ Tradie row has `stripe_account_id` populated
-   ☐ Tradie row has 3+ `available_slots`
-   ☐ All env vars in `.env.local` populated (Stripe + Resend + Supabase)

### V.2 — Run the full chain

1.  **Trigger Stage 03**: dial your Twilio number from your mobile and describe a clean job, OR run `node --env-file=.env.local scripts/test-stage-05.mjs` for a simulated call.
2.  **Wait ~45s**: rows land in `calls` → `intakes` → `quotes`. The new `quotes.routing_decision` column should be `tradie_review`.
3.  **Send the quote**: `curl -X POST http://localhost:3000/api/quote/send -H "Content-Type: application/json" -d '{"quoteId":"PASTE_QUOTE_UUID"}'`
4.  **Open the share URL** (printed in the response). Three tiers visible.
5.  **Click Accept** → land on Stripe Checkout.
6.  **Pay with `4242 4242 4242 4242`** → land on booking page.
7.  **Pick a slot** → success message.
8.  **Verify in Supabase**: quote status is `accepted`, scheduled\_at is set, payments.status is `succeeded`.

### V.3 — Inspection-path test

Re-run the V.3 simulator from Stages 01–05 SOP (burning smell + EV charger). The resulting quote should:

-   Have `routing_decision = 'inspection_required'`
-   Have `needs_inspection = true`
-   Show indicative ranges (no fixed line items) on the customer portal
-   Display the amber "$199 inspection fee" callout above the accept form

Done check — Pipeline complete

One run produces a row in every table: `calls` (1) → `intakes` (1) → `quotes` (1) → `payments` (1). The whole journey from "phone rings" to "deposit paid + slot booked" works without manual intervention.

Troubleshoot · **Common failures**

## When something breaks.

Stages 06–10 add three new failure surfaces (Stripe, Resend, webhook signing). These are the ones you'll hit first.

### Stripe webhook signature fails

If you see `[stripe/webhook] signature failed` in the dev console, your `STRIPE_WEBHOOK_SECRET` env var is wrong. The secret rotates each time you start `stripe listen`; copy the latest `whsec_…` from the CLI output and restart `pnpm dev`.

### Stripe Checkout returns "tradie has not finished Stripe onboarding"

The tradie row's `stripe_account_id` exists but `charges_enabled` is false. Re-run the onboarding link and complete every step in Stripe's modal — Stripe rejects accounts where business address, ID verification, or bank details are skipped, even in test mode.

### Resend email never arrives

Free Resend without a verified domain only delivers to your own signup email. Either add the recipient as a "test recipient" in Resend, verify a domain via DNS, or check the Resend logs at Logs → Emails — you'll see exactly why each delivery was rejected.

### Customer portal returns 404

Three usual causes: (1) the share token in the URL doesn't match the database value (32 hex chars exactly), (2) the dynamic-route folder isn't `app/quote/[token]` with literal square brackets, (3) the quote has no `share_token` yet — call `/api/quote/send` first to generate one.

### Booking page shows no slots

The `tradies.available_slots` JSONB column is empty or null. Seed it via SQL: `update tradies set available_slots = '["2026-05-05T09:00:00+10:00", ...]'::jsonb where id = '...'`.

### Stripe Checkout charge succeeds but quote.status doesn't flip to 'accepted'

Two-stage state in v1: the webhook flips status to `deposit_paid` when the charge succeeds, then the booking route flips it to `accepted` when the customer picks a slot. If the slot pick is skipped (customer abandons after payment), status stays at `deposit_paid`. Add a tradie-side dashboard view in v2 that surfaces these stuck quotes for manual booking.

### "Connect onboarding loop" — Stripe keeps redirecting back to onboarding

You set `refresh_url` and `return_url` to the same path, or the test tradie's account requires more verification than test mode allows. Use distinct URLs (`/onboard/refresh` vs `/onboard/done`) and check Stripe's Connected accounts → \[your test account\] → Account requirements for what's missing.

### Customer email mentions wrong tier total

The send route uses `quote.total_inc_gst` which is computed from the _default_ selected\_tier (better) at draft time. If the customer accepts a different tier, that doesn't propagate back to the email — it doesn't need to, since the email's purpose is to get them to the portal where they pick the tier.

QuoteMate · stages 06–10 SOP · pairs with [stage1-05-sop.html](stage1-05-sop.html), [architecture.html](architecture.html), [build-guide.html](build-guide.html), [wireframe.html](wireframe.html)
