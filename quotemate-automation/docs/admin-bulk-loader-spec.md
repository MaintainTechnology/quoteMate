# Admin Bulk Service & Catalogue Loader — Build Spec (v4)

> Companion to `docs/strategy.md` **v9** (2026-05-21, "trades-as-data").
> Strategy holds the *decision*; this holds the *build detail*.
> **v4 (2026-05-21)** — Phase 0 build started. Foundation migrations 046-051
> written and applied to prod. v4 corrects the §3/§5 table list: an
> authoritative `pg_constraint` query found the trade CHECK on SEVEN tables,
> not the four v3 named — `tenant_assembly_overrides` (which has no `trade`
> column) was a spec typo, and `tenant_custom_assemblies`, `tenant_licences`
> and `tenants` were missed. See migration 051's header for the corrected seven.
> **v3 (2026-05-21)** — scopes the loader to install/job-based trades, and
> closes 8 design findings from the v2 review: the smoke-test moves OUT of the
> DB transaction (staging model), Phase 0 now states the prompt-router refactor
> it implies, the exit gates are made testable, plus idempotency, rollback
> guards, and conditional-aware prompt templates.
> **Read §2.1 and §3 before any code. Phase 0 before Phase 1.**
> Status: **Phase 0 COMPLETE (2026-05-21)** — migrations 046-051 applied to
> prod; the prompt-router is data-driven (estimator / voice / SMS) with
> byte-identical parity tests; `trade_prompts` backfilled. §13 gate green
> (`tsc` 0, vitest 518, sms-parity 70). Phase 1 is next. See §12.1 for the
> honest as-built notes.

---

## 1. Goal

Let an internal admin expand QuoteMate into new trades and bulk-add services
from an admin-only dashboard — with **no per-trade code change**, and **no path
that can touch a live quote until an atomic, validated, smoke-tested commit.**

"No code" is true for *data* (services, prices, categories, supplier SKUs). It
is **not** true for a new trade's **prompt pack** (§6): a trade still needs
trade-tuned LLM prompt text authored by a human — the loader makes that text
*data the system loads*, not something hand-wired into TypeScript per trade.

---

## 2. The one rule that prevents disaster

Two capabilities, very different risk. Never build them as one:

- **Capability 1 — bulk-add services to an existing trade** (electrical /
  plumbing). Safe; services are pure data the agents already read. Ship first.
- **Capability 2 — add a brand-new trade.** Hits hardcoded `electrical |
  plumbing` assumptions; needs the §5 foundation **and** a §6 prompt pack first.

## 2.1 Scope — install/job-based trades ONLY

This loader serves trades that fit QuoteMate's existing engine: a trade that
**quotes a discrete job** built from assemblies (service fee + labour hours) +
materials, presented as **Good / Better / Best**. Electrical, plumbing,
carpentry, handyman, tiling, and similar install trades fit.

**Out of scope: recurring-service / subscription trades** (pool cleaning, lawn
& garden maintenance, regular cleaning). Their pricing is per-visit or
subscription, often has no "materials," and does not map to Good/Better/Best.
They need a different pricing model and are a **separate future project** —
not this loader.

**Hard gate:** at trade-creation the admin must confirm the trade is
install/job-based. The §8 smoke-test is the backstop — a recurring-service
trade forced through this model produces sample quotes that do not make sense,
and the trade is held back.

---

## 3. Codebase reality — what blocks a new trade (verified 2026-05-21)

| Blocker | Location | Effect if ignored |
|---|---|---|
| `check (trade in (…))` — **CHECK→FK swap done, migration 051** | was on 7 tables (`pg_constraint`, 2026-05-21): `shared_assembly_bom`, `supplier_catalogue`, `tenant_assembly_bom`, `tenant_custom_assemblies`, `tenant_licences`, `tenant_material_catalogue`, `tenants` | (resolved) DB rejected a new-trade row at INSERT |
| Estimator prompt router is binary | `lib/estimate/prompt.ts` | new trade silently gets the electrical prompt |
| `electrical-prompt.ts` / `plumbing-prompt.ts` hand-written | `lib/estimate/` | no prompt exists for a new trade |
| SMS dialog `SYSTEM_PROMPT` trade-scope hardcoded | `lib/sms/dialog.ts` | "We do electrical (…) and plumbing (…)", easy-5 lists, Rule 4/6/6a — new trade invisible to SMS |
| `deriveTradeFromJobType()` returns only `electrical\|plumbing` | `lib/intake/schema.ts` | new job types default to electrical |
| SMS `job_type` Zod enum (×2) | `lib/sms/extract-slots.ts`, `dialog.ts` | new services classify `out_of_scope` — **acceptable, see §6.4** |
| Grounding validator `Category` set | `lib/estimate/validate.ts`, `categories.ts` | unknown category → quote silently drops to inspection |
| Voice assistant prompt baked at provision | `lib/vapi/provision.ts` | new trade not spoken by existing assistants |
| `defaultsForTrade()`, `LICENCE_BODIES` | `lib/onboard/schema.ts` | new trade has no pricing seed / licence mapping |

---

## 4. What a new trade actually requires (the "trade bundle")

A complete trade bundle is 8 parts: (1) `trades` row, (2) categories
(Categories CSV), (3) prompt pack (§6 — authored, not CSV), (4) pricing
defaults (trade-defaults block), (5) services (Services CSV), (6) materials
(Materials CSV → `shared_materials`, money-path), (7) supplier catalogue
(Supplier Catalogue CSV — browse-only), (8) licence mapping (in the
trade-defaults block; may be "none").

Capability 1 uses only items 5–7. Capability 2 needs all 8.

---

## 5. Data model changes (Phase 0)

**New tables** (foundation migrations — next free number is **046+**;
041-045 are taken):

- `trades` — `id, name, display_name, active, is_job_based (bool), created_at`.
  Backfill `electrical` + `plumbing`. `is_job_based` enforces §2.1.
- `categories` — `id, name, trade_id (FK), grounding_tag, created_at`. Replaces
  the hardcoded `Category` set. Backfill existing categories **before**
  dropping any constraint.
- `trade_prompts` — `trade_id (FK), estimator_system_prompt text,
  sms_scope_blurb text, sms_trade_rules text, voice_greeting text,
  voice_system_prompt text, updated_at`. The §6 prompt pack.
- `trade_pricing_defaults` — `trade_id (FK), hourly_rate, call_out_minimum,
  apprentice_rate, senior_rate, default_markup_pct, risk_buffer_pct,
  min_labour_hours, gst_registered, licence_label (nullable)`.
- `import_batches` — `id, idempotency_key (unique), admin_user_id, created_at,
  source, status, changes jsonb`. `idempotency_key` makes Approve safe against
  double-click / retry (Finding 6). `changes` stores **before-values of every
  updated row** — rollback needs it.
- `import_staged_rows` — `id, batch_id (FK), target_table, row_class
  (NEW/UPDATE), payload jsonb, validation_status, smoke_status`. **The staging
  area (Finding 1).** Uploaded rows land here first; the live tables are not
  touched until the §8 commit.

**Schema alterations (migration 051 — APPLIED 2026-05-21):**
- Dropped the `trade in ('electrical','plumbing')` CHECK on the **7 tables that
  actually carried it** (`pg_constraint` query, 2026-05-21) and replaced each
  with an FK to `trades(name)`: `shared_assembly_bom`, `supplier_catalogue`,
  `tenant_assembly_bom`, `tenant_custom_assemblies`, `tenant_licences`,
  `tenant_material_catalogue`, `tenants`. The v3 4-table list was wrong — it
  named `tenant_assembly_overrides` (no `trade` column) and missed
  `tenant_custom_assemblies`, `tenant_licences`, and `tenants` (without
  `tenants` a new trade could not have a tenant).
- `shared_assemblies` ADD `retired_at timestamptz` (soft-delete; §11) — done.
- **DEFERRED:** `shared_assemblies.category` → FK to `categories`. `categories`
  has a composite unique key `(trade_id, name)`, so a hard FK from the bare
  `category` text column needs a `category_id` column + backfill first. §9
  Rule 1 (category validated against `categories`) is met by loader-layer
  validation; a hard DB FK can follow later. Documented, not silent.
- Backfill `trades` + `categories` ran in migrations 046 / 047 before 051.

**Code refactor in Phase 0 (Finding 2 — this is NOT just schema):**
- `lib/estimate/prompt.ts` — from `if plumbing … else electrical` to: load the
  trade's `trade_prompts.estimator_system_prompt`, interpolate, return.
- `lib/sms/dialog.ts` — the hardcoded trade-scope text becomes composed from
  active `trades` + each trade's `sms_scope_blurb` / `sms_trade_rules`.
- `lib/vapi/provision.ts` — `buildSystemPrompt()` reads `trade_prompts`.
- electrical + plumbing prompt text is migrated into `trade_prompts` rows
  **string-identical** to today's output.

**Auth:** add `is_admin` boolean to the user identity; server-checked on every
admin route + API.

---

## 6. Prompt pack per trade (the part a CSV cannot do)

`electrical-prompt.ts` / `plumbing-prompt.ts` are large hand-crafted prompts. A
new trade needs the same — authored once, stored as data in `trade_prompts`,
loaded at runtime.

**6.1 Estimator prompt.** `trade_prompts.estimator_system_prompt` is a
template. **It must support conditional blocks, not just value substitution
(Finding 5)** — the current prompts branch on GST-registered, licence display,
etc. The template syntax (chosen in §14) supports `{{value}}` placeholders AND
`{{#if gst_registered}}…{{/if}}` conditionals, so electrical/plumbing migrate
string-identical.

**6.2 SMS dialog scope.** `sms_scope_blurb` + optional `sms_trade_rules`
(electrical's Rule 6a wet-area GPO guard is the model). The hardcoded
"We do electrical (…)" line becomes composed from data.

**6.3 Voice pack.** `voice_greeting` + `voice_system_prompt`, read by
`buildSystemPrompt()`.

**6.4 The `job_type` enum is deliberately NOT changed.** New-trade services
classify as `out_of_scope`/`unknown` in the SMS extractor — that is fine: the
dialog handles them via the `customAssemblies` path (proven in the 2026-05-21
sweep). The enum stays a fixed Zod schema; new trades never touch it.

**6.5 Authoring + safety.** The pack is authored by someone who understands
grounding (AI-assisted is fine), reviewed, stored via the admin dashboard. The
§8 smoke-test is the backstop: a bad prompt produces sample quotes that fail to
ground, and the trade is held back.

---

## 7. CSV formats

Every CSV has a downloadable **template** with exact headers — admins never
guess column names. Number parsing strips currency symbols + thousand
separators (`$1,050.00` → `1050.00`), `.` decimal only, anything else is a
row-validation error.

**7.1 Categories CSV → `categories`** (new-trade only): `trade, name,
grounding_tag`. Unique per `(trade, name)`.

**7.2 Services CSV → `shared_assemblies`:**

| CSV column | DB column | Validation |
|---|---|---|
| `trade` | `trade` | must exist in `trades` |
| `name` | `name` | non-empty; unique per `(trade, name)`, **incl. intra-batch** |
| `description` | `description` | text |
| `unit` | `default_unit` | `each` or `metre` |
| `service_fee_ex_gst` | `default_unit_price_ex_gst` | numeric > 0. **Sundries/consumables portion only, ex-GST — NOT product, NOT labour.** Labour = `labour_hours × hourly_rate` |
| `labour_hours` | `default_labour_hours` | numeric ≥ 0 |
| `exclusions` | `default_exclusions` | text |
| `category` | `category` | must exist in `categories` **OR appear in the same batch's Categories CSV** (Finding 9) |
| `clarifying_question_1..5` | `clarifying_questions` (jsonb) | 5 plain-text columns; assembled server-side; blanks dropped; zero is valid |
| `default_enabled` | `default_enabled` | **Existing trade: forced `false`.** New trade (no live tenants): admin-settable. See Safety Rule 3 |

**7.3 Materials CSV → `shared_materials`:** `trade, name, brand, unit,
price_ex_gst`. The estimator's generic fallback library — money-path.

**7.4 Supplier Catalogue CSV → `supplier_catalogue`** (migration 041): `trade,
category, brand, range_series, name, supplier_label, unit, rrp_ex_gst,
tier_hint, image_url, description`. Browse-only; not money-path.

**7.5 Trade-defaults block** (new-trade only) → `trade_pricing_defaults`:
the 8 rate fields + `licence_label` (nullable).

---

## 8. The upload → approve flow

**Core principle (the non-destruction guarantee): between upload and the final
commit, ZERO writes touch any live table.** Everything stages in
`import_staged_rows`. The commit is INSERT/UPDATE only — no LLM calls — in one
short transaction.

1. **Auth gate** — admin only, server-checked.
2. Admin uploads the bundle CSVs. New trade: also authors the prompt pack and
   confirms the §2.1 install/job-based gate.
3. **Structural validation** — headers match the template, column count, UTF-8,
   row cap (≤1000), no blank rows. A bad file is rejected whole, before any row
   content is read.
4. **Row validation** — per §7. Rows land in `import_staged_rows` with a
   `validation_status`. Includes intra-batch duplicate + in-batch category
   checks.
5. **Preview diff** — every staged row **NEW / UPDATE / REJECT**, each rejection
   with a reason. UPDATE rows changing a price/labour column listed separately
   as **"WILL BE RE-PRICED"**. Each row shows a **computed sample quote** so a
   wrong-but-groundable price is caught by a human.
6. **Manual add (CTA buttons)** — "Add service" / "Add material" / "Add
   supplier product" — manual rows join `import_staged_rows`, same validation.
7. **Smoke-test (outside any transaction — Finding 1).** For each NEW service
   the smoke-test harness drafts a sample quote through the estimator, with the
   staged rows supplied as candidates (the live tables are untouched). It
   confirms the quote **grounds** (does not fall to inspection) and the dialog
   renders the mandated questions. Each staged row gets a `smoke_status`. This
   step is N sequential LLM calls and may take minutes — it must NOT hold a DB
   transaction.
8. **Approve = commit.** A single button, carrying the batch `idempotency_key`.
   It runs **one short all-or-nothing transaction** that copies staged rows
   whose `validation_status` AND `smoke_status` both passed into the live
   tables; writes the `import_batches` record with before-values; registers the
   trade / stores the prompt pack. Rows that failed smoke-test are **left in
   staging, not committed** — the admin gets a report, fixes them, re-uploads.
   Re-pricing live services requires a second explicit confirmation.
9. **Wire-in** — on commit, estimator / SMS / Voice pick the trade up via data.
10. The new trade becomes available on **Account tab → Trades**; tradie
    activation is §10.

---

## 9. Safety rules (non-negotiable)

1. **Category guard** — `category` validated against `categories` (or the
   in-batch Categories CSV); dropdown entry, never free text.
2. **Pricing-semantics guard** — `service_fee_ex_gst` labelled "sundries only,
   ex-GST"; preview shows a computed sample quote per row.
3. **Opt-in by default for existing trades** — adding services to a trade with
   live tenants forces `default_enabled = false`; Approve can never silently
   change a live agent. A brand-new trade (no live tenants) may set it.
4. **Admin auth** — real server-side `is_admin` check on every admin route/API.
5. **Clarifying-questions encoding** — 5 numbered plain-text columns, assembled
   server-side. No JSON-in-a-cell. Zero questions is valid.
6. **Re-pricing confirmation** — money-column UPDATEs separated, second
   confirmation required.
7. **Smoke-test before commit, outside the transaction** — draft + ground +
   mandated-question check per new service against staged rows. Failures stay
   in staging, never committed.
8. **Trade-defaults from data** — new-trade pricing seeds from
   `trade_pricing_defaults`, not hardcoded `defaultsForTrade()`.
9. **Audit + rollback** — every commit writes an `import_batches` record with
   before-values; one-click rollback reverts the batch from it.
10. **Structural-then-row validation** — a structurally-bad CSV rejected whole
    before any row content is read.
11. **Commit is one short transaction** — INSERT/UPDATE only, no LLM calls
    inside it. All-or-nothing. The live tables are untouched until it runs.
12. **Idempotent Approve** — every batch carries a unique `idempotency_key`; a
    double-click or retry cannot apply a batch twice.
13. **Bulk updates never clobber tenant overrides** — a re-price updates only
    the `shared_assemblies` row; `tenant_assembly_overrides` is untouched and
    still wins per-tenant.
14. **Vapi re-provision is tenant-triggered** — never done by Approve.
15. **`import_batches` / `import_staged_rows` are not anon-readable** — admin
    audit data; RLS or service-role-only.
16. **Grounding validator stays the backstop** — `validate.ts` is refactored
    only to read categories from the `categories` table; the strict-grounding
    rule and money-path are otherwise untouched.
17. **Rollback guard (Finding 7)** — a batch can be rolled back freely until any
    of its rows has downstream usage (a `tenant_service_offerings` row, or a
    quote drafted off it). After that, rollback is **blocked**; the admin must
    retire the service instead (§11). The rollback UI shows the reason.

---

## 10. Trade activation by a tradie (Account tab → Trades)

When an existing tenant activates a new trade, the system MUST, atomically:

1. Append the trade to `tenants.trades[]` (keep the legacy scalar `trade`
   consistent).
2. **Create a `pricing_book` row for `(tenant, new_trade)`**, seeded from
   `trade_pricing_defaults`. **Without this row every quote for that trade
   fails** — the known WP1 failure class. Non-negotiable.
3. Seed `tenant_service_offerings`: services with `default_enabled = true` land
   enabled; opt-in extras disabled. Services page shows a "turn on what you do"
   banner.
4. Trigger the per-tenant **Vapi assistant re-provision** (existing
   `retry-provision` path) so the Voice agent speaks the new trade.

If any step fails the activation rolls back — a tenant is never left with a
trade in `trades[]` but no `pricing_book` row.

---

## 11. Service lifecycle after approval

- **Update** — re-uploading an existing `(trade, name)` is an UPDATE; money-
  column updates follow Safety Rule 6.
- **Retire** — set `shared_assemblies.retired_at` (soft-delete, mirroring
  `supplier_catalogue`). Retired services stop being offered; existing quotes
  that referenced them keep working (quotes embed their numbers in
  `good/better/best` jsonb — no FK to the assembly). A whole trade is retired
  via `trades.active = false`.
- **Never hard-delete** a service that quotes/offerings reference.
- **Rollback** reverts inserts + restores update before-values from
  `import_batches` — subject to the Safety Rule 17 guard.

---

## 12. Build phases

| # | Phase | Scope | Money-path | Exit gate |
|---|---|---|---|---|
| 0 | **[DONE 2026-05-21 — see §12.1]** Foundation: 6 new tables + `retired_at`; swap CHECKs for FKs; backfill; admin role; **AND the prompt-router refactor** of `lib/estimate/prompt.ts`, `lib/sms/dialog.ts`, `lib/vapi/provision.ts` to read `trade_prompts`; migrate electrical/plumbing prompt text into rows | schema + 3-path code refactor (migrations 046+) | no | the estimator / SMS / Voice **system-prompt strings are byte-identical** before vs after (string-equality test); §13 suites green |
| 1 | Capability 1 — admin loader for existing trades: upload, staging, validation, preview, manual-add, smoke-test, commit transaction, audit/rollback | none | indirect | bulk-add 5 test services, verify, roll the batch back cleanly |
| 2 | Capability 2 — new trades: prompt-pack authoring UI, Categories + Materials CSVs, trade-defaults, §10 activation flow, §2.1 gate | none | yes | a real install-type new trade quotes correctly end-to-end and the Voice agent speaks it |
| 3 | Supplier Catalogue CSV loader + trade-specific catalogue UI | none (041/042 shipped) | no | parallel to Phase 1 OK |

Each phase is independently shippable. **Never start Phase 1 before Phase 0's
exit gate is green.** Phase 0 is the only phase that touches shared live code;
its byte-identical-prompt gate is what guarantees it does not change behaviour.
The loader itself (Phases 1-3) never touches a live table until §8 step 8.

### 12.1 Phase 0 — as built (2026-05-21)

Honest record of what shipped vs. what §5 envisioned. Gate green: `tsc` 0,
vitest 518, `test-sms-parity` 70.

- **Schema** — migrations 046-051 applied to prod: `trades`, `categories`,
  `trade_prompts`, `trade_pricing_defaults`, `import_batches`,
  `import_staged_rows`, `admin_users`; `shared_assemblies.retired_at`; the
  trade CHECK→FK swap on the **7** tables (§3/§5, corrected from 4).
- **Prompt-template engine** — `lib/prompt-template/render.ts`: `{{value}}`,
  `{{#if}}/{{else}}/{{/if}}`, and one `{{markup N}}` helper (plumbing's
  21-row price table needs the arithmetic). Fails loud on a missing
  placeholder. 18 unit tests.
- **Estimator** — *as spec'd.* `lib/estimate/prompt.ts` loads
  `trade_prompts.estimator_system_prompt`, renders it, and falls back
  bundled-template → oracle module so electrical/plumbing can never break.
  Templates in `lib/estimate/prompt-templates/`; context in
  `prompt-context.ts`. 16 parity tests prove byte-identical vs the oracle on
  both paths × 4 pricing books. `trade_prompts` rows backfilled
  (`scripts/backfill-trade-prompts.mts`).
- **Voice** — `provision.ts` + `update-assistant.ts` now share
  `lib/vapi/voice-prompt.ts` (was duplicated verbatim); trade types widened
  `'electrical'|'plumbing'` → `string` (the real §3 voice blocker). A
  `VoicePromptOverride` param is the `trade_prompts.voice_*` hook. The voice
  prompt is pure composition from trade names — there is no per-trade prose
  to migrate — so electrical/plumbing have **no** `voice_*` rows and the
  voice DB-read is deferred to Phase 2 (when a new trade needs bespoke voice
  text). 9 pinned tests.
- **SMS** — *lighter than §5 envisioned, deliberately.* `tradeScopeDirective`
  feeds the dialog's **user message**, not the system prompt (the SMS system
  prompt is the untouched `SYSTEM_PROMPT` const — trivially byte-identical).
  Its trade type was widened to `string` and a **new-trade branch** added:
  a non-pilot trade now gets a real directive that defers the in-scope job
  list to the TENANT CUSTOM SERVICES block (§6.4) instead of the old
  degenerate "assume both pilots" fallback. The electrical/plumbing/both
  branches are **unchanged code** (byte-identical, pinned by 7 tests). The §5
  idea of composing pilot scope text from `sms_scope_blurb`/`sms_trade_rules`
  was **not** done — a byte-identical general-composer rewrite on the live
  SMS agent was higher risk than value, and the pilot text is not the system
  prompt. Those columns stay empty until a Phase 2 reader needs them.

---

## 13. Testing & migration discipline

- **Per-phase suites that must stay green:** `npx vitest run` (full unit
  suite), `scripts/test-sms-parity.mjs`, `lib/estimate/catalogue-trap.test.ts`,
  `lib/estimate/catalogue-hints.test.ts`, `lib/estimate/categories.test.ts`,
  `npx tsc --noEmit`.
- Phase 0 adds a **prompt-string-equality test**: assert the assembled
  electrical + plumbing system prompts (estimator, SMS, Voice) are identical
  byte-for-byte to the pre-refactor output.
- The Twilio n8n sweep is an end-of-phase acceptance check, not the per-commit
  gate.
- **Every DB change** = a numbered `sql/migrations/NNN_*.sql` + a matching
  `scripts/run-migration-NNN.mjs`, applied to prod **only with explicit human
  approval, one migration at a time** (per CLAUDE.md). Keep `sql/init.sql`
  representative after Phase 0.

---

## 14. Open items (settle before Phase 0 freezes the schema)

- **Prompt-template engine** — choose the syntax for
  `trade_prompts.estimator_system_prompt`. It MUST support `{{value}}`
  substitution AND `{{#if …}}` conditionals (Finding 5), or the electrical
  prompt cannot migrate string-identical.
- **`categories.grounding_tag`** must reconcile with `lib/estimate/categories.ts`
  and the granular-vs-grounding vocab mismatch noted in strategy v7 Phase 6.
- **Validator category cache (Finding 8)** — the validator reads `categories`
  on the hot path. Categories change rarely, so a per-cold-start in-memory read
  (or a short TTL) is sufficient; pick one and state it.
- **Supplier-catalogue `image_url`** — hot-link vs download into Supabase
  storage (hot-links rot).
- **Concurrency** — lock or queue if two admins upload at once.

## 15. Definition of done

Adding a service to an existing trade, or a whole new install-type trade, is:
upload bundle → preview → smoke-test → approve. No per-trade code change. The
live tables are untouched until one short commit transaction. That commit never
ships unvalidated or un-smoke-tested data, never re-prices a live service
without explicit confirmation, never flips a service on without a tradie opting
in, never clobbers a tradie's override, cannot be applied twice, and is
reversible (subject to the downstream-usage guard). A tradie activating a new
trade always gets a `pricing_book` row, seeded offerings, and a re-provisioned
Voice agent — atomically. Phase 0 is the only code that touches the live
system, and its byte-identical-prompt gate proves it changed nothing.
