# Admin Bulk Service & Catalogue Loader — Build Spec

> Companion to `docs/strategy.md` **v9** (2026-05-21, "trades-as-data").
> The strategy entry holds the *decision*; this file holds the *build detail*.
> **Read §3 before writing any code.** Phase 0 must complete before Phase 1.
> Status: spec only, nothing built. Created 2026-05-21.

---

## 1. Goal

Let an internal admin expand QuoteMate into new trades (carpentry, garden
cleaning, pool cleaning, …) and bulk-add services by uploading CSVs from an
admin-only dashboard — with **no code change to wire new work in**, and **no
path that can silently corrupt a live quote**.

---

## 2. The one rule that prevents disaster

This is **two capabilities with very different risk**. Never build them as one:

- **Capability 1 — bulk-add services to a trade that already exists**
  (electrical / plumbing). Safe. Services are pure data; the SMS and Voice
  agents already read them from the row. Ship this first.
- **Capability 2 — add a brand-new trade/industry.** Hits hardcoded
  `electrical | plumbing` assumptions. Requires the §4 foundation work
  *first*. A CSV alone cannot do it.

Treating "add carpentry" as the same as "add another electrical service"
is how the system breaks. The split is non-negotiable.

---

## 3. Codebase reality — what currently blocks a new trade

Verified 2026-05-21. A new-trade row does **not** just flow in:

| Blocker | Location | Effect if ignored |
|---|---|---|
| `check (trade in ('electrical','plumbing'))` | migrations 028, 031, 041 | DB **rejects** a `carpentry` row at INSERT |
| Estimator prompt router is binary | `lib/estimate/prompt.ts` | new trade silently gets the **electrical** prompt |
| `deriveTradeFromJobType()` returns only `electrical\|plumbing` | `lib/intake/schema.ts` | new job types default to electrical |
| SMS `job_type` Zod enum hardcoded | `lib/sms/extract-slots.ts`, `dialog.ts` | new services classify `out_of_scope` |
| Grounding validator `Category` set | `lib/estimate/validate.ts` + `lib/estimate/categories.ts` | unknown category → quote silently drops to inspection |
| Voice assistant prompt baked at provision | `lib/vapi/provision.ts` (`buildSystemPrompt`) | new trade not spoken by existing assistants |
| `defaultsForTrade()` hardcoded | `lib/onboard/schema.ts` | new trade has no pricing_book seed values |
| `LICENCE_BODIES` electrical/plumbing only | `lib/onboard/schema.ts` | new trade has no licence-body mapping |

`shared_assemblies` itself has **no** trade CHECK — so *services for an
existing trade insert fine*. It is the `tenant_*` / `supplier_catalogue`
tables, the prompts, and the enums that block a *new trade*.

`lib/estimate/categories.ts` is already the single-source-of-truth controlled
vocabulary (drift-guarded by `categories.test.ts`, per strategy v7). Phase 0
moves it to a `categories` table; the upload validates against that table.

---

## 4. Data model changes (Phase 0)

**New tables** (foundation migrations — next free number is **046+**;
041-045 are already taken):

- `trades` — `id, name, display_name, active, created_at`. Single source of
  truth for what a trade is. Backfill `electrical` + `plumbing` on creation.
- `categories` — `id, name, trade_id (FK trades), grounding_tag`. Replaces the
  hardcoded `Category` set; the grounding validator and the upload both read it.
  Backfill every existing category value before any constraint is dropped.
- `trade_pricing_defaults` — `trade_id (FK), hourly_rate, call_out_minimum,
  apprentice_rate, senior_rate, default_markup_pct, risk_buffer_pct,
  min_labour_hours, gst_registered`. Replaces hardcoded `defaultsForTrade()`.
- `import_batches` — `id, admin_user_id, created_at, source, status, changes
  jsonb`. The `changes` payload stores the **before-values of every updated
  row** — without this, rollback of an UPDATE is impossible.

**Constraint migration:** drop the `trade in ('electrical','plumbing')` CHECKs
on `tenant_material_catalogue`, `shared_assembly_bom`, `tenant_assembly_overrides`,
`supplier_catalogue`; replace with FK to `trades`. `shared_assemblies.category`
→ FK to `categories`. Backfill `trades` + `categories` **before** dropping
constraints so existing data never violates the new FKs.

**Auth:** add `is_admin` boolean to the user identity; checked server-side on
every admin route + API. Not an unlisted URL.

---

## 5. CSV formats

### 5.1 Services CSV → `shared_assemblies`

| CSV column | DB column | Validation |
|---|---|---|
| `trade` | `trade` | must exist in `trades` |
| `name` | `name` | non-empty; unique per `(trade, name)` |
| `description` | `description` | text |
| `unit` | `default_unit` | `each` or `metre` |
| `service_fee_ex_gst` | `default_unit_price_ex_gst` | numeric > 0. **Sundries/consumables portion only, ex-GST — NOT product cost, NOT labour.** Labour = `labour_hours × pricing_book.hourly_rate` |
| `labour_hours` | `default_labour_hours` | numeric ≥ 0 |
| `exclusions` | `default_exclusions` | text |
| `category` | `category` | must exist in `categories` for that trade |
| `clarifying_question_1`…`_5` | `clarifying_questions` (jsonb) | 5 fixed plain-text columns; assembled server-side into the array, blanks dropped, ≤5 enforced (matches the dialog's `MAX_MUSTASK_PER_SERVICE`) |

`default_enabled` is **not** a CSV column — always forced `false` (Safety Rule 3).

### 5.2 Supplier Catalogue CSV → `supplier_catalogue` (migration 041)

| CSV column | DB column | Validation |
|---|---|---|
| `trade` | `trade` | must exist in `trades` |
| `category` | `category` | must exist in `categories` for that trade |
| `brand` | `brand` | non-empty |
| `range_series` | `range_series` | optional (e.g. "Iconic", "2000") |
| `name` | `name` | non-empty; unique per `(trade, brand, lower(name))` for active rows |
| `supplier_label` | `supplier_label` | optional free text (Reece, Bunnings, …) |
| `unit` | `default_unit` | defaults `each` |
| `rrp_ex_gst` | `default_unit_price_ex_gst` | numeric > 0. **Vendor RRP — never a sell price**; the estimator never reads `supplier_catalogue` |
| `tier_hint` | `tier_hint` | optional; `good` / `better` / `best` |
| `image_url` | `image_url` | optional URL |
| `description` | `description` | optional text |

`supplier_revision`, `retired_at`, timestamps are system-managed — not in the CSV.
Lower risk than the Services CSV: `supplier_catalogue` is a browse-only library;
the grounding validator never reads it.

### 5.3 Trade-defaults block (new-trade only) → `trade_pricing_defaults`

A small form or third CSV: `hourly_rate, call_out_minimum, apprentice_rate,
senior_rate, default_markup_pct, risk_buffer_pct, min_labour_hours,
gst_registered`. Seeds a new tenant's `pricing_book` row when they activate
the trade.

---

## 6. The upload → approve flow

1. **Auth gate** — admin only, server-checked (Safety Rule 4).
2. Admin uploads the Services CSV + Supplier Catalogue CSV (+ trade-defaults
   block for a new trade).
3. **Structural validation** — header names match the schema exactly, column
   count, UTF-8, row cap (≤1000), no blank rows. A structurally-bad file is
   rejected whole, before any row content is read (Safety Rule 10).
4. **Row validation** — per §5 + Safety Rules 1, 2, 5.
5. **Preview diff** — every row classified **NEW / UPDATE / REJECT**, each
   rejection with a reason. UPDATE rows that change a price or labour column
   are listed separately as **"WILL BE RE-PRICED"** (Safety Rule 6). Each row
   shows a **computed sample quote** so a wrong-but-groundable price is caught
   by a human (Safety Rule 2).
6. **Manual add (CTA buttons)** — "Add service" / "Add supplier product" let
   the admin type in anything missed. Manual rows join the same pending batch
   and go through the same validation.
7. **Approve** — single button. Re-pricing live services requires a second
   explicit confirmation distinct from Approve (Safety Rule 6).
8. **Smoke-test gate** — before going live, each NEW service is drafted into a
   sample quote through the real estimator; the system confirms it **grounds**
   (does not fall to the inspection fallback) and the dialog renders its
   mandated questions. Services that fail are held back and listed; the batch
   ships "approved with N held back" (Safety Rule 7).
9. **Wire-in** — trade registered, services in the catalogue, supplier
   catalogue loaded; estimator / SMS / Voice pick it up via data. The
   `import_batches` row is written (Safety Rule 9).
10. The new trade becomes available on the **Account tab → Trades**. When a
    tradie activates it, its services appear on their **Services page** to
    toggle on/off, and *that activation* triggers the per-tenant Voice (Vapi)
    re-provision (Safety Rule 11). Approve itself never touches a Vapi assistant.
11. The trade's supplier catalogue appears as a new trade-specific catalogue
    under the **Supplier Catalogue**.

---

## 7. Safety rules (non-negotiable)

1. **Category guard** — every row's `category` validated against the
   `categories` table; entered via dropdown, never free text. A genuinely new
   category for a new trade must be registered first.
2. **Pricing-semantics guard** — `service_fee_ex_gst` labelled "sundries only,
   ex-GST, not product/labour"; preview shows a computed sample quote per row.
3. **Opt-in by default** — every bulk-uploaded service forced
   `default_enabled = false`. Approve can never silently change a live tradie's
   agent. Default-on is a separate, deliberate per-service admin action.
4. **Admin auth** — real server-side `is_admin` check on the dashboard route
   and every upload/approve API. Not an unlisted URL, not a client-only check.
5. **Clarifying-questions encoding** — 5 fixed numbered plain-text columns,
   assembled server-side into the jsonb array. No JSON-in-a-cell.
6. **Re-pricing confirmation** — UPDATE rows touching a price/labour column are
   separated and require a second explicit confirmation.
7. **Smoke-test before live** — draft + ground + mandated-question check per
   new service; failures held back, not shipped.
8. **Trade-defaults from data** — a new trade's `pricing_book` seed values come
   from the uploaded trade-defaults block, not hardcoded `defaultsForTrade()`.
9. **Audit + rollback** — every Approve writes an `import_batches` record with
   before-values; one-click rollback reverts the batch from that record.
10. **Structural-then-row validation** — a structurally-bad CSV is rejected
    whole before any row content is examined.
11. **Vapi re-provision is tenant-triggered** — Approve makes the trade
    available; the Voice assistant is re-provisioned per-tenant only when that
    tenant activates the trade.

---

## 8. Build phases (the order that avoids destroying the system)

| # | Phase | New schema | Money-path | Exit gate |
|---|---|---|---|---|
| 0 | Foundation: `trades`, `categories`, `trade_pricing_defaults`, `import_batches`; swap `trade` CHECKs for FKs; backfill electrical/plumbing + existing categories; add admin role | yes (migrations 046+) | no | every existing electrical/plumbing quote byte-identical; SMS parity sweep green |
| 1 | Capability 1 — admin loader scoped to existing trades: upload, structural+row validation, preview diff, manual-add CTAs, Approve, smoke-test, audit/rollback | none | indirect | bulk-add 5 test electrical services, verify via SMS sweep, roll the batch back cleanly |
| 2 | Capability 2 — new trades: data-composable estimator prompt, trade-defaults wiring, new-trade activation + tenant-triggered Vapi re-provision | none | yes | a real new trade quotes correctly end-to-end and the Voice agent speaks it |
| 3 | Supplier Catalogue CSV loader + the trade-specific catalogue UI | none (041/042 shipped) | no (browse-only) | can run parallel to Phase 1 |

Each phase is independently shippable; abandoning mid-delivery never leaves the
system worse than strategy v8. **Never start Phase 1 before Phase 0's exit gate
is green.**

---

## 9. Open items

- Phase 2 design decision: is the data-composable estimator prompt a single
  template + per-trade data rows, or one prompt row per trade? Decide before
  Phase 2 starts.
- `categories` table must reconcile with `lib/estimate/categories.ts` and the
  granular-vs-grounding vocabulary mismatch noted in strategy v7 Phase 6.
- Licence-body mapping for new trades (`LICENCE_BODIES`) — some trades need no
  licence; the data model must allow "no licence required".
- RLS: `trades` / `categories` are global tables — add to the RLS apply list
  (currently RLS-off + service-role read is acceptable, matching `supplier_catalogue`).

---

## 10. Definition of done

Adding a service to an existing trade, or a whole new trade, is: upload →
preview → approve. No code change, no re-wire. The Approve button never ships
unvalidated data, never re-prices a live service without explicit confirmation,
never flips a service on without a tradie opting in, runs a grounding
smoke-test first, and is always reversible via the `import_batches` record.
