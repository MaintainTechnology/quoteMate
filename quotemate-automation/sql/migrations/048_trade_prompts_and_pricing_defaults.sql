-- ════════════════════════════════════════════════════════════════════
-- Migration 048 — trade_prompts + trade_pricing_defaults (Phase 0)
--
-- trade_prompts: the per-trade "prompt pack" (spec §6) — estimator
-- system prompt, SMS dialog scope, Voice greeting/prompt. Created
-- EMPTY here. The electrical/plumbing rows are populated by the Phase 0
-- code refactor via scripts/backfill-trade-prompts.mjs, because that
-- text lives in TypeScript today (electrical-prompt.ts / plumbing-
-- prompt.ts / dialog.ts / vapi/provision.ts) and must migrate
-- STRING-IDENTICAL — a SQL seed cannot reproduce it.
--
-- trade_pricing_defaults: per-trade seed values for a new tenant's
-- pricing_book row when they activate a trade (spec §10), replacing the
-- hardcoded defaultsForTrade(). Backfilled with the documented AU pilot
-- standards (electrical $110/28%, plumbing $120/20% — see memory
-- project_plumbing_routing_rules and the seeded pilot pricing books).
--
-- ADDITIVE ONLY. Depends on migration 046 (trades).
-- Apply with: node --env-file=.env.local scripts/run-migration-048.mjs
-- ════════════════════════════════════════════════════════════════════

create table if not exists trade_prompts (
  trade_id uuid primary key references trades(id) on delete cascade,
  estimator_system_prompt text,
  sms_scope_blurb text,
  sms_trade_rules text,
  voice_greeting text,
  voice_system_prompt text,
  updated_at timestamptz not null default now()
);

create table if not exists trade_pricing_defaults (
  trade_id uuid primary key references trades(id) on delete cascade,
  hourly_rate numeric(8,2) not null,
  call_out_minimum numeric(8,2) not null,
  apprentice_rate numeric(8,2) not null,
  senior_rate numeric(8,2),
  default_markup_pct numeric(5,2) not null,
  risk_buffer_pct numeric(5,2) not null,
  min_labour_hours numeric(4,2) not null,
  gst_registered boolean not null default true,
  licence_label text,                   -- nullable: some trades need none
  updated_at timestamptz not null default now()
);

-- Backfill the two live trades' pricing defaults.
insert into trade_pricing_defaults (
  trade_id, hourly_rate, call_out_minimum, apprentice_rate, senior_rate,
  default_markup_pct, risk_buffer_pct, min_labour_hours, gst_registered, licence_label
)
select t.id, v.hourly, v.callout, v.appr, v.senior, v.markup, v.risk, v.minhrs, true, v.licence
  from (values
    ('electrical', 110, 150, 65, 160, 28, 15, 2.0, 'Electrician licence'),
    ('plumbing',   120, 110, 65, 160, 20, 15, 1.5, 'Plumber licence')
  ) as v(trade, hourly, callout, appr, senior, markup, risk, minhrs, licence)
  join trades t on t.name = v.trade
on conflict (trade_id) do nothing;

notify pgrst, 'reload schema';
