-- ════════════════════════════════════════════════════════════════════
-- Migration 044 — early-booking discount (v8 Phase A · dynamic pricing)
--
-- Adds the per-quote columns the early-booking discount needs. The
-- OFFER configuration itself lives in pricing_book.overlays.early_bird
-- jsonb (no schema change for config — `overlays` already exists).
--
-- Four columns, all on `quotes`:
--   • early_bird_discount_pct  — the % offered when this quote was
--     drafted (snapshotted from the tenant's pricing_book overlay so a
--     later config change can't retroactively alter a live offer).
--   • early_bird_expires_at    — ISO deadline; the offer is "live" only
--     while now() < this. Derived at draft time from created_at +
--     overlay window_hours.
--   • applied_discount_pct     — the % ACTUALLY locked in. 0 until the
--     customer commits a time before expiry (POST /api/q/[token]/book
--     stamps it). This is the single value the display + Stripe layers
--     read — never the offer columns directly.
--   • applied_discount_at      — when the discount was locked in.
--
-- WHY a separate applied_* pair rather than just flipping the offer:
--   the offer (what was advertised) and the realised discount (what the
--   customer earned by booking in time) are distinct facts. Keeping both
--   lets the dashboard show "offered 10%, customer booked in time → 10%
--   applied" vs "offered 10%, expired → 0 applied" without guessing.
--
-- Grounding note: the discount is a quote-LEVEL field. It never touches
-- good/better/best line items, so lib/estimate/validate.ts is unaffected
-- and the strict-grounding rule still holds (see docs/strategy.md v8).
--
-- Idempotent: add column if not exists. Safe to re-run.
--
-- NOT auto-applied to prod — apply with:
--   node --env-file=.env.local scripts/run-migration-044.mjs
-- ════════════════════════════════════════════════════════════════════

alter table quotes
  add column if not exists early_bird_discount_pct numeric(5,2);

alter table quotes
  add column if not exists early_bird_expires_at timestamptz;

alter table quotes
  add column if not exists applied_discount_pct numeric(5,2) not null default 0;

alter table quotes
  add column if not exists applied_discount_at timestamptz;

-- Defence-in-depth: the discount % can never be negative or above the
-- platform cap (15%) enforced in lib/quote/early-bird.ts. A constraint
-- here means a bad direct UPDATE / bad migration is rejected by Postgres
-- too, not just by the application layer.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'quotes_early_bird_discount_pct_range'
  ) then
    alter table quotes
      add constraint quotes_early_bird_discount_pct_range
      check (early_bird_discount_pct is null
             or (early_bird_discount_pct >= 0 and early_bird_discount_pct <= 15));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'quotes_applied_discount_pct_range'
  ) then
    alter table quotes
      add constraint quotes_applied_discount_pct_range
      check (applied_discount_pct >= 0 and applied_discount_pct <= 15);
  end if;
end $$;

notify pgrst, 'reload schema';
