# Skills toolkit for QuoteMate

> Curated index of plugin skills available in this repo. **27 skills + 7 commands have been vendored into [`.claude/skills/`](../.claude/skills/) and [`.claude/commands/`](../.claude/commands/)** — they ship with the repo and don't require source plugins to be installed. See [`.claude/skills/README.md`](../.claude/skills/README.md) for the inventory and re-sync notes.

## How to read this doc

- **Vendored skills** are invoked with hyphenated names: `/vercel-nextjs`, `/supabase-supabase`. The plugin namespace colon (`:`) was flattened to a hyphen during vendoring.
- **Built-in skills** (ship with Claude Code) keep their bare names: `/review`, `/simplify`, `/security-review`, etc.
- **Skills can also auto-load** when Claude detects work matching their description — explicit invocation is optional but useful for guided workflows.
- "Phase" columns map to the build plan in [`strategy.md`](strategy.md).
- Use the **always relevant** section throughout; consult the phase sections as you reach each milestone.

---

## Always relevant (apply throughout the build)

| Skill | Used for |
|---|---|
| `claude-api` | Anthropic SDK setup, **prompt caching** (mandatory for keeping Quote Drafter cost under $0.05/quote on Opus), model migration between Claude versions |
| `simplify` | Reviews changed code for reuse, quality, efficiency. Run after non-trivial features land |
| `fewer-permission-prompts` | Scan transcripts → add allowlists to `.claude/settings.json`. Run periodically once repeated dev commands accumulate |
| `review` | Pull-request review (once code begins) |
| `security-review` | Run before any merge that touches Stripe Connect, Supabase RLS, or customer PII |
| `update-config` | Configure `settings.json` — hooks, permissions, env vars |

---

## Phase 1 — Portal MVP (painting NSW, manual intake, no voice)

### Setup & deploy

| Skill | Used for |
|---|---|
| `vercel:bootstrap` | One-shot setup: links Vercel + provisions Marketplace integrations (Supabase, others) + pulls env vars + runs first dev. **The right starting point** for the very first commit |
| `vercel:vercel-cli` | Day-to-day CLI workflows |
| `vercel:env-vars` | Managing secrets across local / preview / production |
| `vercel:deployments-cicd` | Deploying to preview and production |
| `vercel:status` | Checking project state |

### App framework

| Skill | Used for |
|---|---|
| `vercel:nextjs` | App Router decisions, layouts, server components, server actions for the quote draft pipeline |
| `vercel:turbopack` | Bundler decisions / HMR issues |
| `vercel:react-best-practices` | After any `.tsx` edits — runs a component quality checklist |
| `vercel:shadcn` | Customer portal UI (mobile-first, professional). The right component library for tradie + homeowner-facing surfaces |

### Auth, DB, storage

| Skill | Used for |
|---|---|
| `supabase:supabase` | Everything Supabase: DB, Auth (magic-link for tradies), RLS, Storage (job photos), Edge Functions, Realtime |
| `supabase:supabase-postgres-best-practices` | Schema design + query optimization. Apply when designing the `pricing_books` / `quotes` / `line_items` tables |

### LLM layer

| Skill | Used for |
|---|---|
| `vercel:ai-sdk` | Building the Quote Drafter and Quote Reviewer agents — streaming, structured output, tool use |
| `vercel:ai-gateway` | Routing Claude calls through Gateway for failover, cost tracking, observability |
| `vercel:vercel-functions` | Serverless function patterns for the quote-draft endpoint |

### Payments

| Skill | Used for |
|---|---|
| `stripe:stripe-best-practices` | Stripe Connect Express integration, webhook security, deposit + refund flows. **Critical for v1** — both deposits and inspection fees flow through Connect |
| `stripe:explain-error` | When Stripe webhooks fail or test-mode confuses |
| `stripe:test-cards` | Manually testing the deposit + inspection-fee flows |

### PDF + documents

| Skill | Used for |
|---|---|
| `anthropic-skills:pdf` | Generating the PDF version of customer-facing quotes |

---

## Phase 2 — Pricing intelligence + inspection flow

| Skill | Used for |
|---|---|
| `anthropic-skills:xlsx` | Parsing tradies' uploaded pricing CSVs/XLSX (Xero/MYOB exports) for the pricing-book overlay |
| `vercel:workflow` | Durable workflows for inspection coordination — booking, $199 payment, on-site capture, refund-on-accept |
| `vercel:runtime-cache` | Caching assembly library lookups (per-trade base library + per-tradie overlays) |
| `vercel:next-cache-components` | Cache strategy for the customer-facing quote portal (PPR + `use cache`) |
| `vercel:vercel-storage` | Blob storage for intake + inspection photos |

---

## Phase 3 — Conversion engine + scale

| Skill | Used for |
|---|---|
| `vercel:routing-middleware` | Per-tenant request handling, customer-portal token validation, A/B testing the availability nudge |
| `vercel:vercel-agent` | AI code review + anomaly investigation on PRs |
| `schedule` | One-time or recurring follow-up agents (e.g. "in 2 weeks open a cleanup PR for the inspection-fee experiment") |
| `loop` | Polling tasks during ops (e.g. checking deploy status during a release) |

---

## Phase 5+ — Voice agent (deferred until pricing accuracy proven + revenue justifies)

| Skill | Used for |
|---|---|
| `vercel:chat-sdk` | Multi-channel customer messaging if you build a chat surface |
| `vercel:vercel-sandbox` | Only relevant if you ship customer scripting (unlikely) |

Voice agent infrastructure (Vapi/Deepgram/ElevenLabs) is **not represented in any installed skill** — when you reach Phase 5, integrate against their docs directly.

---

## Optional / situational (use only when the trigger appears)

| Skill | Trigger to use |
|---|---|
| `figma:figma-implement-design` | When designs land in Figma — translates them into shadcn/Tailwind code with high fidelity |
| `figma:figma-use` | Mandatory prerequisite before any Figma write operation |
| `slack:summarize-channel`, `slack:standup`, `slack:channel-digest` | If team adopts Slack for ops; useful for monitoring feedback channels |
| `slack:slack-messaging` | Drafting well-formatted Slack messages |
| `pinecone:cli`, `pinecone:query`, `pinecone:assistant` | **Only if** Supabase pgvector hits scale issues at 10k+ quotes/tradie. v1 default is pgvector. Pinecone is the fallback |
| `anthropic-skills:docx` | If you need to export quote templates or compliance docs as Word files |
| `vercel:auth` | General auth patterns — note v1 uses Supabase Auth, not Clerk/Descope/Auth0 |
| `vercel:knowledge-update` | Auto-injects current Vercel platform knowledge — passive, no action needed |
| `vercel:next-upgrade` | When upgrading Next.js major versions |
| `vercel:marketplace` | Discovering Marketplace integrations beyond the planned stack |
| `vercel:verification` | End-to-end verification when "why isn't this working" hits |

---

## Explicitly NOT relevant for this project

Documenting these so future sessions don't waste time invoking them.

| Skill | Why not |
|---|---|
| `gitnexus-*` | Requires a populated GitNexus knowledge graph; no codebase yet to graph |
| `agent-sdk-dev:new-sdk-app` | For building Claude Agent SDK applications. QuoteMate is a Next.js web app — not the right shape |
| `plugin-dev:*` (all of them) | For building Claude Code plugins. Not what we're shipping |
| `vercel:next-forge` | Turborepo monorepo starter — overkill for a single Next.js app |
| `clonesdkpipeline` | Cloning VectorShift SDK pipelines to Express. Not our stack |
| `anthropic-skills:lecture-builder` | Specific to NGM (Next Generation Medicine) lecture publishing |
| `anthropic-skills:document-studio` | NGM-specific (proposals, flyers, sponsor packets) |
| `anthropic-skills:internal-comms` | NGM-specific internal communications |
| `anthropic-skills:web-artifacts-builder` | For building claude.ai HTML artifacts, not production web apps |
| `anthropic-skills:mcp-builder` | For building MCP servers; not what QuoteMate ships |
| `anthropic-skills:skill-creator`, `skill-creator:skill-creator` | For building new Claude Code skills. Premature; revisit if a repeated workflow emerges |
| `anthropic-skills:setup-cowork` | Cowork setup; unrelated |
| `anthropic-skills:consolidate-memory` | Periodic memory cleanup — invoke ad-hoc, not on the project |
| `anthropic-skills:slack-gif-creator` | For Slack GIFs; not a product need |
| `anthropic-skills:algorithmic-art`, `anthropic-skills:canvas-design`, `anthropic-skills:brand-guidelines`, `anthropic-skills:theme-factory` | Visual art / design tools; QuoteMate's design is built via shadcn + Tailwind |
| `anthropic-skills:doc-coauthoring` | General doc co-authoring; CLAUDE.md and `strategy.md` are already structured |
| `anthropic-skills:email-conversion-judge` | Email copy critique tool — relevant if/when marketing site copy is being optimized |
| `anthropic-skills:pptx` | PowerPoint decks — not a product need |
| `pinecone:join-discord`, `pinecone:help`, `pinecone:docs`, `pinecone:mcp`, `pinecone:quickstart` | Pinecone-specific onboarding; we're not on Pinecone in v1 |
| `vercel:bootstrap` (after first use) | Only useful for the initial setup; redundant after that |
| `stripe:test-cards`, `stripe:explain-error` | Useful ad-hoc but not "Phase 1 toolkit" — they're break-glass references |
| `keybindings-help` | User-level config, not project-level |

---

## Skill-invocation conventions for this repo

- **Use `/skill-name`** explicitly when you want a guided workflow
- **Don't invoke a skill just because it exists** — only when the trigger matches
- **When in doubt, prefer the skill over re-deriving knowledge** — skills encode best practices that beat improvised approaches
- **For multi-skill workflows**, the phase tables above show natural pairings (e.g. `vercel:nextjs` + `supabase:supabase` + `vercel:ai-sdk` for any Quote Drafter feature)

---

## What's deliberately not done

- **No skills are copied into `.claude/skills/`.** They live at the user level and are accessible without duplication.
- **No new project-specific skills written.** Premature for greenfield. Add when a workflow repeats (e.g. "/add-trade", "/eval-quote") — that's when `skill-creator` becomes the right tool.
- **No project plugin manifest** (`plugin.json`, `marketplace.json`). QuoteMate is the product, not a Claude Code plugin. If we ever wanted to package QuoteMate-specific skills for distribution to other repos, that would be a separate decision.
