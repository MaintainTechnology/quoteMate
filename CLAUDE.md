# Engineering context for Claude

> See [README.md](README.md) for the public overview and [docs/strategy.md](docs/strategy.md) for the living strategy + re-evaluation history.
> **This file describes what is actually built and running as of 2026-05-18.** Where the running system has drifted from a documented strategy decision, that drift is called out explicitly (⚠) rather than hidden.

## Project state — NOT greenfield anymore

The app is built and the two pilot channels (voice + SMS) are live end-to-end against a real Supabase instance. Earlier copies of this file (and `README.md`, and parts of `docs/strategy.md`) still say "greenfield, no code" — that is **stale**; treat this section as ground truth.

- **Application lives in [`quotemate-automation/`](quotemate-automation/)** — a Next.js 16 App Router app. The repo root holds planning docs/assets; the product is the subdirectory.
- **Voice channel is shipped** (Vapi → `/api/vapi/webhook` → intake → estimate → quote SMS). ⚠ The strategy doc still files voice under "v3+ premium tier, deferred". Reality: it shipped in v1. Not yet reconciled in `docs/strategy.md`.
- **SMS channel is shipped end-to-end** (Twilio → `/api/sms/inbound` → AI dialog → same intake/estimate pipeline → quote SMS + HTML quote page). All 5 SMS phases done; see [`docs/markdown/sms-progress.md`](docs/markdown/sms-progress.md).
- **v5 multi-trade is live**: electrical (NSW/NECA) + plumbing (QLD/QBCC) share one DB, routed by `intake.trade`. **4 tenants currently active** (2 electrical-only, 1 plumbing-only, 1 cross-trade — incl. "Pilot Sparky"/"Pilot Plumber" seed tenants). A stub Sparky tenant (no Vapi, zero traffic) was hard-deleted 2026-05-20 via migration 038.
- **v6 self-serve tradie onboarding is the current work**: `/signup`, `/onboard/*`, `/api/onboard/*`, Twilio/Vapi auto-provisioning (`lib/twilio/provision.ts`, `lib/vapi/provision.ts`), tenant-owned custom assemblies (migration 023). Provisioning flags (`TWILIO_PROVISIONING_ENABLED`, `VAPI_PROVISIONING_ENABLED`) are currently `false` in dev.
- **Production**: `https://quote-mate-rho.vercel.app` (Vercel, with the SMS-cleanup cron). Repo is also Railway-deployable (`Dockerfile` + `railway.json`, `output: 'standalone'`). Vapi dev webhook runs via ngrok.
- **Money path is test-mode only**: Stripe test keys; per-tier deposit Checkout + $199 inspection link work, but **Stripe Connect Express is not wired** (`tenants.stripe_connect_account_id` is null for every tenant; `payments` table has 0 rows). Funds-split is still TODO.

## The decisions that shape the work

Settled after substantive re-evaluation (see iteration history at the end of `docs/strategy.md`). Don't drift silently — if work demands a change, **add a new iteration entry to `docs/strategy.md`** before changing this table.

| Decision | What it means in practice | Status in the running system |
|---|---|---|
| **Portal + SMS + voice intake** | Tradie-typed portal was the v1 wedge; voice and SMS intake were added. | Voice **and** SMS both live. The v3-deferral was contradicted in practice; drift logged in `docs/strategy.md` v6 (2026-05-20). |
| **Electrical (NSW) + plumbing (QLD)** | Two parallel single-trade pilots. No third trade without a new iteration entry. | Live. `trade` column on `pricing_book`/`shared_assemblies`/`shared_materials`/`intakes`. |
| **Four agents, not ten** | Quote Drafter, Quote Reviewer, Inspection Coordinator, Conversion Engine. | Drafter (Opus) + grounding validator + confidence router shipped. Reviewer/Conversion partial (tradie-notify, booking); no follow-up sequence yet. |
| **Build the pricing book WITH the tradie** | Ship base assembly library per trade; capture tradie overlay via onboarding. | `shared_assemblies`/`shared_materials` seeded; per-tenant overlay via `pricing_book.overlays`, `tenant_material_preferences`, `tenant_custom_assemblies`, `tenant_service_offerings`. |
| **Eval framework before prompt iteration** | 100 hold-out (intake → quote) pairs, 5-dim rubric. | ⚠ **Not built yet.** Prompts iterate without delta measurement. A parity harness (`scripts/test-sms-parity.mjs`, 70 assertions) exists but is not the eval rubric. |
| **Stripe Connect Express** for marketplace flow | Each tradie owns funds; QuoteMate takes a platform fee. | ⚠ **Not wired.** Test-mode Checkout only; no Connect accounts, no fee split. |
| **No auto-send in v1** | Tradie human-in-loop is the liability shield. | ⚠ **Superseded.** Live behaviour is Path B: every drafted quote auto-sends to the customer; the tradie is notified and reviews after-the-fact. Investor-pack commits `ad72ab8` + `602915e` made the switch. Drift logged in `docs/strategy.md` v6 (2026-05-20). Strategic rationale still owed there. |

When a "decisions" entry diverges from reality, the honest move is to **append a new `docs/strategy.md` iteration entry** documenting the why — not to quietly edit the prior decision.

## Repository layout

```
.
├── CLAUDE.md                          # this file
├── README.md                          # public overview (updated 2026-05-20: 4 active tenants, voice live)
├── docs/
│   ├── strategy.md                    # living strategy (v6; voice/auto-send drift logged 2026-05-20)
│   ├── skills-toolkit.md              # skills/agents/commands → build-phase mapping
│   └── *.html + markdown/*.md         # build guide, SOPs, progress, wireframe, agent architecture
├── assets/                            # flow SVG, experience map, Maintain logo
├── .claude/                           # vendored skills/agents/commands (see .claude/PLUGINS.md)
└── quotemate-automation/              # ◀── THE APPLICATION
    ├── AGENTS.md                      # ⚠ "This is NOT the Next.js you know" — READ FIRST
    ├── CLAUDE.md                      # just `@AGENTS.md`
    ├── app/                           # Next.js App Router: pages + /api routes
    ├── lib/                           # estimate, intake, sms, preview, routing, onboard, twilio, vapi, stripe, supabase, voice
    ├── sql/                           # init.sql + migrations/002…038
    ├── scripts/                       # ~90 ops/diagnostic .mjs (run: node --env-file=.env.local …)
    ├── tests/ + *.test.ts             # vitest unit + playwright e2e
    ├── Dockerfile, railway.json, vercel.json, next.config.ts
    └── .env.local                     # all live secrets — NEVER commit, NEVER paste into docs
```

### The webpage surface (App Router)

Customer-facing: `/` (marketing landing, Maintain design system, "v5 live"), `/q/[token]` (mobile quote page — Good/Better/Best, Gemini preview/sample images, per-tier Stripe deposit, licence footer), `/q/[token]/book` (slot picker), `/q/[token]/paid`, `/q/[token]/cancelled`, `/upload/[token]` (camera/gallery photo upload), `/r/[token]/[tier]` (Stripe redirect).

Tradie-facing: `/signin` `/signup` `/signup/verify` `/auth/callback` (Supabase PKCE auth), `/onboard` `/onboard/check-email` `/onboard/success` (self-serve onboarding), `/dashboard` (CRM: overview/KPIs/pipeline, quotes, chats, services editor).

Docs pages: `/docs/{sms-onboarding-architecture,sms-onboarding-flow,tradie-onboarding-architecture,tradie-onboarding-plan,tradie-onboarding-plan-sms}` + static HTML in `public/docs/` (investor pack, build guide, SOPs).

Key API routes: `/api/vapi/webhook`, `/api/vapi/tools/send-sms-photo-link`, `/api/sms/inbound`, `/api/intake/structure` (channel-agnostic), `/api/estimate/draft`, `/api/quote/[id]/edit`, `/api/q/[token]/book`, `/api/stripe/webhook`, `/api/cron/sms-cleanup`, `/api/onboard/{preflight,activate,intent/[token],retry-provision}`, `/api/tenant/{me,chats,services,trades}`, `/api/health` + `/api/health/deep`.

## Tech stack — as actually wired (not the strategy-doc plan)

| Layer | Reality |
|---|---|
| Framework | **Next.js 16.2.4** App Router, React 19.2, Turbopack, `output: 'standalone'`. ⚠ Breaking changes vs older Next — `quotemate-automation/AGENTS.md` mandates reading `node_modules/next/dist/docs/` before writing Next code. |
| LLM | **Vercel AI SDK v6** (`ai`, `@ai-sdk/anthropic`) calling Claude **directly via `ANTHROPIC_API_KEY`** — *not* through Vercel AI Gateway (despite the strategy.md/README plan). Opus 4.7 = intake structuring + estimation; SMS dialog/slot/intent upgraded Haiku 4.5 → Sonnet 4.6 (commit `be6128d`). Anthropic prompt caching on the system prompt. |
| RAG / rerank | Supabase `pgvector` 0.8 (`embedding vector(1536)`, `match_intakes` fn). Voyage embeddings + reranker (`VOYAGE_API_KEY`; `lib/estimate/rag.ts`, `rerank.ts`); stubs if unset. |
| Image gen | **Google Gemini** (`GEMINI_API_KEY`) for quote preview + per-tier sample images (`lib/preview/*`). Not in the original stack plan. |
| DB / auth / storage | **Supabase** (Postgres 17 + pgvector), project ref `bobvihqwhtcbxneelfns`. Auth = Supabase PKCE. Storage bucket `intake-photos`. Server routes use `SUPABASE_SERVICE_ROLE_KEY`. (Neon MCP may be available in-session but is **not** this project's DB.) |
| Voice | Vapi + Deepgram (STT) + ElevenLabs (TTS) — **shipped**, persona "jon". |
| SMS / WhatsApp | Twilio AU long codes; SMS-first with WhatsApp fallback (`lib/sms/dispatch.ts`). Dev SMS number `+61481613464`. |
| Payments | Stripe **test mode** (Checkout + webhook). Connect Express **not** implemented. |
| Email | Resend. |
| PDF | **None** — customer quote is an HTML page at `/q/[token]`, no react-pdf. |
| Analytics / errors | **No PostHog, no Sentry** yet (strategy plan only). Observability = `lib/log/pipeline.ts` + platform logs + `scripts/`. |
| Deploy | Vercel (prod, cron) and/or Railway (Docker). See `quotemate-automation/DEPLOY.md`. |

## The live database (Supabase `bobvihqwhtcbxneelfns`)

18 base tables in `public`. For ad-hoc inspection connect with `pg` via `SUPABASE_DB_URL` (pattern: `scripts/run-migration-*.mjs`). Schema/seed source of truth: `sql/init.sql` + `sql/migrations/002…023`.

**Reference / config (per-trade, per-tenant overlay):**
- `pricing_book` (5 rows) — `trade`, `tenant_id`, `hourly_rate`, `call_out_minimum`, `apprentice_rate`/`senior_rate`, `default_markup_pct`, `risk_buffer_pct`, `min_labour_hours`, GST, licence, `overlays` jsonb. Electrical ≈ $110/hr × 28–36% markup; plumbing = $120/hr × 15–20% (see [[project_plumbing_routing_rules]]).
- `shared_assemblies` (43: 20 electrical / 23 plumbing), `shared_materials` (37, categorised), `tenant_custom_assemblies` (0 — migration 023, tradie-owned), `tenant_service_offerings` (54 — which assemblies a tenant offers), `tenant_material_preferences` (0 — soft brand hints), `tenant_licences` (0).

**Tenancy / onboarding:** `tenants` (5, all `active`; `trade`+`trades[]`, twilio/vapi/stripe ids, branding), `tradie_signup_intents` (2), legacy `tradies` (1).

**Pipeline:** `calls` (49), `intakes` (157 — `scope/access/property/risks/timing/caller` jsonb, `embedding`, `confidence`, `trade`), `quotes` (137 — **G/B/B line items live in `good`/`better`/`best` jsonb**, plus preview/sample image columns, `routing_decision`, stripe links), `quote_line_items` (**0 — unused; do not assume normalized line items**), `payments` (0), `customers` (4).

**SMS:** `sms_conversations` (89; `conversation_type` customer_quote|tradie_registration, `conversation_state` jsonb), `sms_messages` (1038).

**RLS reality (updated 2026-05-20):** RLS is now ON across 22 public tables after migration 040 (Phase 1). The 13 previously-leaking tables (`tenants/customers/sms_*/tradie_signup_intents/tenant_*/shared_assembly_bom`) had RLS off and were exposed to the public `NEXT_PUBLIC_SUPABASE_ANON_KEY` — anon smoke test confirms that's now closed (0 rows visible to anon). One positive policy (`tenants_self_select`) covers the auth-callback's `select id, status, business_name from tenants where owner_user_id = auth.uid()` read. Multi-tenant isolation in API routes + server components is still **app-layer `tenant_id` filtering** because they use the service-role key (RLS bypassed) — Phase 2 will add tenant-scoped policies for defense in depth.

**Quote funnel snapshot (2026-05-18):** 137 quotes, all `draft` except 1 `sent`; 0 sent/accepted/paid. Routing: 80 `tradie_review`, 38 `inspection_required`, 19 null. Intakes: electrical 66 MED / 46 LOW, plumbing 39 MED / 6 LOW. Top job types: downlights (43), hot_water (17), power_points (14), ceiling_fans (12), blocked_drain (10).

## How the quote pipeline works

`intake (voice/SMS)` → `lib/intake/structure.ts` (Opus 4.7 vision + Zod schema) → embedding → `lib/estimate/run.ts`: RAG context + brand-preference hint → Opus 4.7 with **tool-calling only** for prices (`lib/estimate/tools.ts` reads shared + tenant_custom assemblies) → JSON draft → **`lib/estimate/validate.ts` grounding check**: every line-item price must derive from `pricing_book` + `shared_*` + `tenant_custom_assemblies` *scoped to `intake.trade`*; **any failure downgrades the whole quote to the $199 inspection route**. Then `lib/routing/decide.ts` → `quotes` row + Stripe sessions + customer SMS + tradie notify (SMS+WhatsApp). Trade prompt selected in `lib/estimate/prompt.ts` (`electrical-prompt.ts` / `plumbing-prompt.ts`).

## Conventions

- Currency stored ex-GST; displayed inc-GST. Quotes embed their numbers in `good/better/best` jsonb (line items not normalized).
- AU/NZ-first formatting, language, dates, addresses.
- **Money-touching LLM steps use tool-calling only** — never free-form prices. The grounding validator is the hard backstop; inspection-fallback is the safe failure mode.
- Multi-trade scoping is by the `trade` column everywhere (assemblies, materials, pricing_book, intakes, prompts, validator candidates).
- New trade ⇒ 5-component bundle (assemblies, intake rules, pricing defaults, G/B/B framing, licence schema) — see `public/docs/onboarding-bundle.html`. **No third trade without a `docs/strategy.md` iteration entry.**
- Webhook routes fast-ack (<500ms) then run heavy work in `next/server` `after()`; idempotency on Twilio `MessageSid`. `maxDuration` raised on Sonnet/Opus routes (Vercel Hobby's 10s times out — needs Pro or Railway).
- Scripts run with `node --env-file=.env.local scripts/X.mjs`. Don't commit `.env.local` or paste its secrets anywhere (this file included).

## Working in this repo

- **Before writing any Next.js code**, read `quotemate-automation/AGENTS.md` and the relevant `node_modules/next/dist/docs/` guide — Next 16 has breaking changes vs training-data knowledge.
- **Strategy/product questions** — `docs/strategy.md` first, but cross-check against this file; the doc lags reality on voice, auto-send, and the eval framework.
- **Don't propose a THIRD trade** without a fresh `docs/strategy.md` entry. Electrical + plumbing is the boundary.
- **Don't rebuild ServiceM8/Tradify features** (calendar/CRM/invoicing) — the wedge is the AI quote draft + paid inspection flow.
- **After editing `docs/strategy.md`**, invoke the `strategy-reviewer` agent (catches drift across README/CLAUDE/assets). The voice + auto-send + eval-framework drifts above are overdue for a new iteration entry.
- **DB changes** = a new `sql/migrations/NNN_*.sql` + a `scripts/run-migration-NNN.mjs`, applied to prod Supabase; keep `sql/init.sql` representative.
- Skills/agents/commands toolkit is vendored in `.claude/` (hyphenated names, e.g. `/vercel-nextjs`, `/supabase-supabase`, `/stripe-best-practices`); built-ins keep bare names (`/review`, `/simplify`, `/security-review`). Phase→tool mapping: [`docs/skills-toolkit.md`](docs/skills-toolkit.md); plugin landscape: [`.claude/PLUGINS.md`](.claude/PLUGINS.md).

## Known debt / honest gaps

- ⚠ Stripe Connect Express not implemented — no real funds flow.
- ⚠ RLS enabled but policy-less; tenancy is app-layer only.
- ⚠ Eval framework (100 hold-out pairs, 5-dim rubric) not built; prompts iterate without delta measurement.
- ⚠ Voice + auto-send shipped but the original `docs/strategy.md` entries (v3/v4/v5) still document them as deferred/forbidden. The 2026-05-20 v6 iteration entry records the drift but does NOT supply the strategic rationale — that's still owed by whoever made the call.
- **RLS Phase 1 applied 2026-05-20** (migration 040). The 13 leaking tables (`tenants`/`customers`/`sms_*`/`tradie_signup_intents`/`tenant_*`/`shared_assembly_bom`) now have RLS enabled; anon-role smoke test confirms 0 rows visible (was full leak). One positive policy `tenants_self_select` on `tenants` covers the auth-callback's own-tenant lookup. Service role still bypasses RLS so every `/api/*` route + server component works unchanged. Phase 2 (tenant-scoped policies for the per-tenant tables) deferred — see [`quotemate-automation/docs/rls-design.md`](quotemate-automation/docs/rls-design.md). Pending: live browser smoke-test of the post-signup auth-callback flow next time a new user signs up.
- **`customers.tenant_id` code fix 2026-05-20** — `lib/customers/lookup.ts`'s `findOrCreateCustomer()` now accepts a `tenantId` parameter and stamps it on insert, with heal-in-place on existing NULL rows. Callers updated: `app/api/sms/inbound/route.ts:313` (passes `tenant?.id ?? null`) and `app/api/intake/structure/route.ts:312` (passes the resolved `tenantId`). Closes the recurring orphan source.
- **Pre-existing orphan `tenant_id IS NULL` rows** (audit 2026-05-20, 363 rows total): `calls 49/49` (100% — pre vapi_assistant_id stamping on tenants), `customers 4/4` (now self-heal via the code fix on next inbound), `sms_conversations 74/117` (legacy traffic to the dev shared number `+61481613464` + `tradie_registration` rows that are NULL-by-design until activation), `intakes 127/176` + `quotes 108/155` (parent is itself orphan — no FK source to propagate from). FK propagation via `scripts/backfill-orphan-tenant-ids.mjs --apply` resolved 1 intake; the rest are unrecoverable historical test traffic. Accept and document; do not delete (still referenced).
- `quote_line_items` table exists but is unused (0 rows) — line items are denormalized into `quotes.good/better/best`.
