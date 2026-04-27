# Project-level skills (vendored from plugins)

This directory contains plugin skills that have been **vendored** into the repo. They are now version-controlled with the project and accessible to any Claude session here, even on machines where the source plugin isn't installed.

## Sync metadata

| Field | Value |
|---|---|
| Synced on | 2026-04-27 |
| Source | `~/.claude/plugins/cache/claude-plugins-official/` |
| Vercel plugin version | `0.40.0` |
| Supabase plugin version | `0.1.5` |
| Stripe plugin version | `0.1.0` |

## What was vendored

### Skills (27 total, ~2 MB)

| Skill (project-level invocation) | Source (`/<plugin>:<skill>`) | Phase |
|---|---|---|
| `/vercel-bootstrap` | `/vercel:bootstrap` | Setup |
| `/vercel-nextjs` | `/vercel:nextjs` | Phase 1 — framework |
| `/vercel-ai-sdk` | `/vercel:ai-sdk` | Phase 1 — LLM layer |
| `/vercel-ai-gateway` | `/vercel:ai-gateway` | Phase 1 — LLM layer |
| `/vercel-vercel-functions` | `/vercel:vercel-functions` | Phase 1 — backend |
| `/vercel-vercel-cli` | `/vercel:vercel-cli` | Phase 1 — ops |
| `/vercel-deployments-cicd` | `/vercel:deployments-cicd` | Phase 1 — deploy |
| `/vercel-env-vars` | `/vercel:env-vars` | Phase 1 — config |
| `/vercel-auth` | `/vercel:auth` | Reference (using Supabase Auth) |
| `/vercel-react-best-practices` | `/vercel:react-best-practices` | Phase 1 — UI quality |
| `/vercel-shadcn` | `/vercel:shadcn` | Phase 1 — UI |
| `/vercel-turbopack` | `/vercel:turbopack` | Phase 1 — bundler |
| `/vercel-knowledge-update` | `/vercel:knowledge-update` | Background — auto-injected |
| `/vercel-workflow` | `/vercel:workflow` | Phase 2 — durable workflows |
| `/vercel-runtime-cache` | `/vercel:runtime-cache` | Phase 2 — caching |
| `/vercel-next-cache-components` | `/vercel:next-cache-components` | Phase 2 — caching |
| `/vercel-vercel-storage` | `/vercel:vercel-storage` | Phase 2 — photo storage |
| `/vercel-routing-middleware` | `/vercel:routing-middleware` | Phase 3 — middleware |
| `/vercel-vercel-agent` | `/vercel:vercel-agent` | Phase 3 — AI code review |
| `/vercel-chat-sdk` | `/vercel:chat-sdk` | Phase 5+ — voice/chat |
| `/vercel-vercel-sandbox` | `/vercel:vercel-sandbox` | Phase 5+ — sandboxed code |
| `/vercel-marketplace` | `/vercel:marketplace` | As needed |
| `/vercel-next-upgrade` | `/vercel:next-upgrade` | When upgrading Next |
| `/vercel-verification` | `/vercel:verification` | Debugging "why isn't this working" |
| `/supabase-supabase` | `/supabase:supabase` | Phase 1 — DB / Auth / Storage / RLS |
| `/supabase-supabase-postgres-best-practices` | `/supabase:supabase-postgres-best-practices` | Phase 1 — schema design |
| `/stripe-best-practices` | `/stripe:stripe-best-practices` | Phase 1 — payments |

### Commands (7 total)

Located in `.claude/commands/` (sibling directory).

| Command | Source | Used for |
|---|---|---|
| `/vercel-bootstrap` | `/vercel:bootstrap` | Initial Vercel + Supabase + Stripe linking |
| `/vercel-deploy` | `/vercel:deploy` | Deploy to preview / production |
| `/vercel-env` | `/vercel:env` | Manage env vars |
| `/vercel-status` | `/vercel:status` | Project state check |
| `/vercel-marketplace` | `/vercel:marketplace` | Discover Marketplace integrations |
| `/stripe-explain-error` | `/stripe:explain-error` | Debug Stripe errors |
| `/stripe-test-cards` | `/stripe:test-cards` | Get test card numbers |

## What was NOT vendored (and why)

- **Built-in skills** (`claude-api`, `simplify`, `fewer-permission-prompts`, `review`, `security-review`, `update-config`, `loop`, `schedule`) — these ship with Claude Code itself. Always available, can't be vendored.
- **Anthropic skills** (`anthropic-skills:pdf`, `anthropic-skills:xlsx`, etc.) — not present as a copyable plugin in the local cache. Available via the host environment when needed.
- **Plugin-dev, agent-sdk-dev, gitnexus-*, next-forge, slack:*, figma:*, pinecone:*, anthropic-skills:*, frontend-design:*, firecrawl:*, ralph-loop:*, skill-creator:*, canvas-medical/cpa, coderabbit:*** — not relevant to QuoteMate's planned stack. See [`docs/skills-toolkit.md`](../../docs/skills-toolkit.md) for the explicit "not relevant" rationale.

## Important caveats

### 1. Drift risk
These skills are **frozen at the version listed above**. When the source plugins update (new `vercel` releases, new `supabase` skills), this directory will NOT auto-update.

**To re-sync:**
- Check source plugin versions: `ls ~/.claude/plugins/cache/claude-plugins-official/vercel/`
- If newer versions exist, re-run the sync (delete `.claude/skills/vercel-*` and re-copy)
- Update the "Synced on" date in this README

### 2. Naming convention
Plugin namespaces (`vercel:nextjs`) don't survive at the project level. They were renamed to `vercel-nextjs` (hyphen, not colon) and the `name:` frontmatter was updated to match. Invocations use the new name: `/vercel-nextjs`, not `/vercel:nextjs`.

### 3. MCP-server-dependent skills
Some skills (especially `supabase-supabase`) reference an MCP server provided by the source plugin. The skill content vendored here describes how to use the MCP, but if the MCP server isn't installed locally, those tool calls will fail. Skills work best when both the skill content AND the underlying plugin/MCP are available.

### 4. License
Vendored skills retain the licenses of their source plugins. The Vercel, Supabase, and Stripe plugins are MIT-licensed. See each source plugin's repository for the canonical license terms.

## Related docs

- [`CLAUDE.md`](../../CLAUDE.md) — engineering context for Claude in this repo
- [`docs/skills-toolkit.md`](../../docs/skills-toolkit.md) — curated index mapping skills to build phases (now points to local copies)
- [`docs/strategy.md`](../../docs/strategy.md) — strategy + iteration history
