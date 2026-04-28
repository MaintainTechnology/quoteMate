# Engineering context for Claude

> See [README.md](README.md) for the public project overview, and [docs/strategy.md](docs/strategy.md) for the living strategy + re-evaluation history.

## Project state

Greenfield. The repository contains planning artifacts and design assets — no application code has been written yet. The first code will land in [Phase 1 of the build plan](docs/strategy.md).

## The decisions that shape the work

These were settled after substantive re-evaluation (see iteration history at the end of `docs/strategy.md`). Don't drift from them silently — if work demands a change, **add a new iteration entry to `docs/strategy.md` explaining the why** before changing this table.

| Decision | What it means in practice |
|---|---|
| **Portal-first v1, not voice-first** | The AI receptionist (voice agent) is a v3+ premium tier. v1 is tradie-typed-intake on a portal. Voice has bad unit economics at SaaS price points (~$1,500/mo COGS per tradie at moderate call volume). |
| **Electrical (NSW) first, not painting** | Pilot access dominates regulatory simplicity. v3 pivoted away from painting after operational electrical content (9 job-flow question trees, real AU electrician rates, considered "easy 5 vs hard 5" pilot strategy) signalled an actual electrician pilot relationship. License-display schema (per-state — NSW NECA, VIC ESV, QLD QBCC) is shipped Phase 1. See `docs/strategy.md` v3 entry for full rationale. |
| **Four agents, not ten** | Quote Drafter, Quote Reviewer, Inspection Coordinator, Conversion Engine. Reception agent is reserved for v3. |
| **Build the pricing book WITH the tradie** | Most owner-operators don't have a structured price list. Ship a base assembly library per trade (built by paid domain experts) and capture the tradie's overlay through guided onboarding. |
| **Eval framework before prompt iteration** | 100 hold-out (intake → quote) pairs, scored by 5-dimension rubric. No prompt change ships without delta measurement. |
| **Stripe Connect Express** for marketplace flow | Each tradie owns their funds; QuoteMate takes a platform fee. Required for Australian payment compliance. |
| **No auto-send in v1** | Tradie human-in-loop is the liability shield. Australian Consumer Law treats accepted quotes as binding contracts. |

## Repository layout

```
.
├── CLAUDE.md                          # this file — engineering context
├── README.md                          # public project overview
├── LICENSE                            # MIT
├── .gitignore
├── .claude/
│   └── agents/
│       └── strategy-reviewer.md       # consistency check across docs/assets
├── assets/
│   ├── quotemate_flow_with_inspection.svg
│   └── quotemate_experience_map.jpeg
├── docs/
│   └── strategy.md                    # living strategy + re-evaluation history
└── (app/, lib/, components/, supabase/ will appear when Phase 1 begins)
```

## Tech stack (planned, not yet implemented)

| Layer | Choice |
|---|---|
| Frontend + API | Next.js (App Router) on Vercel |
| Auth, DB, storage, RLS | Supabase (Postgres + pgvector) |
| Background workflows | Vercel Workflow (WDK) or Inngest |
| LLM | Claude (Opus for the heavy reasoning step, Haiku for routing) via Vercel AI Gateway |
| Voice agent (v3 only) | Vapi + Deepgram + ElevenLabs |
| SMS | Twilio (AU long codes) |
| Payments | Stripe AU + Stripe Connect Express |
| Email | Resend |
| Analytics | PostHog |
| PDF | react-pdf server-side |

Don't add infrastructure speculatively — wait until the relevant phase begins.

## Conventions (apply once code starts)

- **Currency stored ex-GST; displayed inc-GST** in customer-facing UI
- **Pricing books are versioned**; quotes reference `pricing_book_version_id` so historical quotes stay accurate when prices change
- **AU/NZ-first**: formatting, language, dates, address parsing all default to AU/NZ patterns
- **Multi-tenant via Supabase RLS from day 1** — never bolt it on later
- **Money-touching LLM steps must use tool-calling**, never emit prices from free-form text
- **Quotes never auto-send in v1** — tradie human-in-loop on every send

## How to work in this repo

- **For strategy or product questions** — read `docs/strategy.md` first. It has the current thinking. The earlier chat-only analysis (recorded as v1 in the iteration history) is superseded.
- **For visual context** — the assets in `assets/` are ground truth for the user-facing flow; both README and strategy doc reference them.
- **When changing a "decisions that shape the work" entry** — append a new iteration entry to `docs/strategy.md` rather than editing the prior one in place. The history is the audit log.
- **When in doubt about scope** — the v1 wedge is portal-first electrical in NSW, scoped to the "easy 5" job types (downlights, GPOs, ceiling fans, smoke alarms, outdoor/deck lighting). If a proposed feature isn't needed for those, it likely belongs in v2 or v3, not v1. Switchboards, fault finding, EV chargers, underground cabling, and complex renovations are inspection-only routes — never auto-quoted in v1.
- **After editing `docs/strategy.md`** — invoke the `strategy-reviewer` agent to catch any drift across README, CLAUDE.md, and the assets.

## Skills, agents, and commands toolkit

**Vendored into `.claude/`** — version-controlled with the project, accessible without source plugins on the machine:

- **27 skills** in `.claude/skills/` — see [`.claude/skills/README.md`](.claude/skills/README.md)
- **3 plugin-defined subagents + 1 project agent** in `.claude/agents/`
- **7 commands** in `.claude/commands/`
- **Plugin landscape doc** at [`.claude/PLUGINS.md`](.claude/PLUGINS.md) — what was vendored, what still needs source plugins (MCPs), how to install

The curated mapping of skills/agents/commands to build phases lives at [`docs/skills-toolkit.md`](docs/skills-toolkit.md).

### Invocation conventions

- **Vendored** items use hyphenated names: `/vercel-nextjs`, `/supabase-supabase`, `/stripe-best-practices` (the plugin colon was flattened to a hyphen during vendor).
- **Built-in** Claude Code skills keep bare names: `/review`, `/simplify`, `/security-review`, `/fewer-permission-prompts`, `/update-config`.
- **Subagents** are launched via the Agent tool (`subagent_type` parameter) or auto-selected by Claude based on task description.

### Always-relevant skills (built-in, ship with Claude Code)

`claude-api`, `simplify`, `fewer-permission-prompts`, `review`, `security-review`, `update-config`.

### Phase 1 core stack (vendored)

Skills: `/vercel-bootstrap`, `/vercel-nextjs`, `/vercel-ai-sdk`, `/vercel-ai-gateway`, `/supabase-supabase`, `/supabase-supabase-postgres-best-practices`, `/stripe-best-practices`, `/vercel-shadcn`.

Subagents: `vercel-ai-architect` (designing the Quote Drafter / Reviewer), `vercel-deployment-expert` (Phase 1 deploy), `vercel-performance-optimizer` (mobile-first portal), `strategy-reviewer` (consistency check after `docs/strategy.md` edits).

Commands: `/vercel-bootstrap`, `/vercel-deploy`, `/vercel-env`, `/vercel-status`, `/stripe-explain-error`, `/stripe-test-cards`.

### Plugins still needed at user level (for MCP servers + hooks)

Vendoring covers documentation; some functionality requires the source plugin to be installed:

- **Supabase MCP** — required to actually run SQL, manage migrations, list projects from Claude. Install: `claude plugin install supabase@claude-plugins-official`
- **Vercel hooks** — auto-skill-injection, telemetry. Install: `claude plugin install vercel@claude-plugins-official`

See [`.claude/PLUGINS.md`](.claude/PLUGINS.md) for the full list and rationale.

## What's deliberately not yet set up

- `.claude/settings.json` — add permissions when you discover repeated prompts (the `fewer-permission-prompts` skill is the right tool for this)
- Custom **project-specific** skills (workflows unique to QuoteMate, e.g. `/add-trade`, `/eval-quote`) — premature for a greenfield repo; add when a workflow repeats
- CI/CD pipelines — add when there's code to test
- Database migrations — Phase 1

## How Claude should approach changes here

- **Don't propose voice-agent or multi-trade work for v1.** Both are deferred by deliberate decision; surface that the request is out-of-scope and ask whether to add it as a v2/v3 entry in the strategy doc.
- **Don't recommend ServiceM8/Tradify-style features that already exist in incumbents.** The wedge is the AI quote draft + the paid inspection flow. Calendar, CRM, and invoicing are deferred until those are working.
- **Treat the iteration log in `docs/strategy.md` as load-bearing.** When decisions evolve, the log is how everyone (including future Claude sessions) understands why.
