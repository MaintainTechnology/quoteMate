# Plugin landscape for QuoteMate

This document records which Claude Code plugins inform this repo, what has been **vendored** locally, and what remains in the source plugins (MCP servers, hooks, runtime infrastructure).

> Synced 2026-04-27 from `~/.claude/plugins/cache/claude-plugins-official/`.

---

## What "vendoring a plugin" actually means here

A Claude Code plugin is a bundle of:

| Component | What it does | Vendor-able? |
|---|---|---|
| **`skills/`** | Knowledge content Claude reads to do work | ✓ Yes (`.claude/skills/`) |
| **`commands/`** | Slash commands users can invoke | ✓ Yes (`.claude/commands/`) |
| **`agents/`** | Subagent definitions Claude can launch | ✓ Yes (`.claude/agents/`) |
| **`hooks/`** | Event-driven JS/Node scripts that run inside Claude Code's runtime | ✗ No — depends on plugin runtime infrastructure |
| **MCP servers** | External processes Claude calls as tools | ✗ No — requires the source plugin installed for the MCP to start |
| **`assets/`, `src/`, `tests/`** | Plugin internals | ✗ No — not user-facing |
| **`plugin.json`** | Plugin manifest | ✗ No — only meaningful at plugin-publishing time |

So when we "vendor a plugin," we copy the parts Claude reads (skills, commands, agents). The runtime parts (hooks, MCPs) stay with the source plugin and require it to be installed at the user level.

---

## Source plugins that inform this project

| Source plugin | Version vendored | Vendored to repo | Still requires source plugin for |
|---|---|---|---|
| `vercel@claude-plugins-official` | `0.40.0` | 24 skills, 3 agents, 5 commands | Vercel hooks (auto-skill-injection, profilers), session telemetry |
| `supabase@claude-plugins-official` | `0.1.5` | 2 skills | **Supabase MCP server** (run SQL, manage migrations, list projects) |
| `stripe@claude-plugins-official` | `0.1.0` | 1 skill, 2 commands | (no MCP — pure documentation) |

### Why the Supabase MCP matters

The vendored `supabase-supabase` skill teaches Claude *how* to use Supabase — but the actual `mcp__plugin_supabase_supabase__*` tools (run SQL, create branches, list projects, describe schemas) only exist when the source Supabase plugin is installed. Without it, the skill content tells Claude what to do, but Claude can't directly execute against a Supabase instance.

**For Phase 1 work that touches the database**, the Supabase plugin should be installed at the user level so the MCP is live.

---

## How to install source plugins at user level (for full functionality)

If you're working on this repo from a fresh machine, install the source plugins so MCPs, hooks, and runtime features come along:

```bash
# Install plugins (assumes claude-plugins-official marketplace is registered)
claude plugin install vercel@claude-plugins-official
claude plugin install supabase@claude-plugins-official
claude plugin install stripe@claude-plugins-official
```

Or, if you only need specific plugins for specific phases:

| Phase | Install at minimum |
|---|---|
| Phase 1 — Portal MVP | `vercel`, `supabase`, `stripe` |
| Phase 2 — Pricing intelligence | (same as Phase 1) |
| Phase 3 — Conversion engine | (same as Phase 1) |
| Phase 5 — Voice agent | + Vapi/Retell directly (no Claude plugin yet) |

---

## What the vendored agents add

Three Vercel-defined subagents now live in `.claude/agents/` alongside the project's own `strategy-reviewer`:

| Agent | When to invoke | Use case for QuoteMate |
|---|---|---|
| `vercel-ai-architect` | Designing AI features, picking SDK patterns, building agents, setting up workflows, integrating MCP servers | **Direct fit for Quote Drafter, Quote Reviewer, On-Site Capture agents** — has decision trees for AI SDK patterns |
| `vercel-deployment-expert` | Deploy issues, CI/CD, preview URLs, env vars, rollbacks | Phase 1 deployment friction, preview-vs-prod env management |
| `vercel-performance-optimizer` | Core Web Vitals, rendering strategies, caching, image/font optimization, bundle size | Customer-facing quote portal (mobile-first, must be fast) |

These are first-class subagents — they appear in the Agent tool's `subagent_type` options and Claude can auto-select them based on task description.

---

## What was NOT vendored (and why)

### Plugin internals (not user-facing)

- Vercel `hooks/` — ~30 `.mjs` files including session profilers, telemetry, skill auto-injection, lexical indexers. These run inside Claude Code's runtime and depend on the Vercel plugin's TypeScript source. Vendoring would require copying the entire plugin source tree.
- Vercel `src/`, `scripts/`, `tests/`, `assets/`, `generated/` — plugin development files; irrelevant to consumers
- Plugin `package.json`, `bun.lock` — Node deps for the plugin itself
- `.tmpl` files — pre-render templates; the `.md` files are the rendered output

### Plugins not relevant to QuoteMate

| Plugin | Why excluded |
|---|---|
| `claude-md-management` | CLAUDE.md authoring helper; we already have a CLAUDE.md |
| `superpowers` | General-purpose tool augmentation; install at user level if you want it, not project-specific |
| `firecrawl` | Web scraping; not in our flow |
| `coderabbit` | Code review automation; out-of-scope for greenfield |
| `figma`, `pinecone`, `slack` | Different problem domains (covered in [`docs/skills-toolkit.md`](../docs/skills-toolkit.md)) |
| `agent-sdk-dev`, `plugin-dev`, `skill-creator` | For building Claude SDK apps / Code plugins; not what QuoteMate is |
| `ralph-loop` | Iteration loop tool; runtime-only, can be invoked when needed (not vendored) |
| `frontend-design`, `github` | Not in our planned stack |
| `canvas-medical/cpa`, `canvas-medical/pytest-forge` | Medical-domain tooling; unrelated to QuoteMate |

---

## Re-syncing when source plugins update

The vendored content is **frozen** at the versions in the table above. When source plugins update with new skills, agents, or commands, the local copies don't auto-refresh.

### To re-sync

1. Check current source versions:
   ```bash
   ls ~/.claude/plugins/cache/claude-plugins-official/vercel/
   ls ~/.claude/plugins/cache/claude-plugins-official/supabase/
   ls ~/.claude/plugins/cache/claude-plugins-official/stripe/
   ```

2. If newer versions exist, decide whether to upgrade (check the source plugin's CHANGELOG).

3. Re-run the vendoring (delete `.claude/skills/vercel-*`, `.claude/agents/vercel-*`, `.claude/commands/vercel-*` and re-copy from the new version's directories).

4. Update the version cells in this document and in `.claude/skills/README.md`.

### Or — just don't vendor at all

The simpler model: install the plugins at user level (`claude plugin install ...`) and skip vendoring. Vendoring exists in this repo so the project is self-contained on fresh machines, not as the "right" way for everyone.

---

## Should QuoteMate become its own plugin?

**No** — QuoteMate is a SaaS product, not a Claude Code plugin. There's no `plugin.json` or `marketplace.json` here, and there shouldn't be unless you want to package QuoteMate-specific skills (`/add-trade`, `/eval-quote`, etc.) for distribution to other repos in the future. That's a separate exercise; flag it as an explicit decision before adding plugin manifests.

---

## Related docs

- [`README.md`](../.claude/skills/README.md) — vendored skills inventory + sync metadata
- [`../docs/skills-toolkit.md`](../docs/skills-toolkit.md) — phase-by-phase skill mapping
- [`../CLAUDE.md`](../CLAUDE.md) — engineering context for Claude
