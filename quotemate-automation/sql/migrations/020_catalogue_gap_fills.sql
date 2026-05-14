-- ════════════════════════════════════════════════════════════════════
-- Migration 020 — catalogue gap fills for common AU residential variants
--
-- Background: stress test on 2026-05-14 exposed BUG H — a customer asked
-- for "250L gas storage hot water replacement" and the system downgraded
-- to a $199 inspection. Investigation showed the catalogue had Gas storage
-- HWS 170L and Gas continuous-flow but no Gas storage 250L. Opus generated
-- a price the validator couldn't ground, so the route auto-downgraded.
-- The customer's request was a STANDARD AU residential job that SHOULD
-- have auto-quoted. The gap was in the catalogue data, not the code.
--
-- This migration adds 8 missing variants that audit-catalogue-gaps.mjs
-- flagged as common-enough-to-cause-customer-impact:
--
--   Hot water (5):
--     - Gas storage HWS 250L (the priority fix — most common gas size)
--     - Gas storage HWS 315L (larger family premium)
--     - Electric HWS 125L (units / single-bath properties)
--     - Electric HWS 400L (large family / 2-bath premium)
--     - Heat pump HWS 315L (matches Electric 315L premium for HP customers)
--
--   Tapware (2):
--     - Laundry tap (basic, very common service call)
--     - Outdoor garden tap (common backyard / hose-tap replacement)
--
--   Toilet (1):
--     - Smart toilet suite (growing premium tier — Caroma Smart, etc.)
--
-- Prices are wholesale ex-GST. The 20% plumber markup applies at quote
-- time via lib/estimate/tools.ts applyMarkup(). Retail equivalents
-- shown in inline comments for sanity check.
--
-- Idempotent: uses `where not exists` so re-running is a no-op.
-- ════════════════════════════════════════════════════════════════════

insert into shared_materials (
  trade, name, brand, unit, default_unit_price_ex_gst
)
select * from (values
  -- ── Hot water gap fills ─────────────────────────────────────────
  -- Gas storage 250L: most common AU residential gas HWS size.
  -- Retail $1200-1400, wholesale ~$1050. Marked up at 20% = $1260.
  ('plumbing', 'Gas storage HWS 250L',            'Rheem',           'each', 1050.00),
  -- Gas storage 315L: larger families. Retail $1450-1650 → wholesale ~$1250.
  ('plumbing', 'Gas storage HWS 315L',            'Rheem Stellar',   'each', 1250.00),
  -- Electric 125L: units, granny flats, single-bath properties.
  -- Retail $580-680 → wholesale ~$520.
  ('plumbing', 'Electric HWS 125L',               'Rheem',           'each',  520.00),
  -- Electric 400L: large family / 2-bath premium. Retail $1500-1700 → wholesale ~$1450.
  ('plumbing', 'Electric HWS 400L premium',       'Rheem Stellar',   'each', 1450.00),
  -- Heat pump 315L: pairs with Electric 315L premium for HP-curious customers.
  -- Retail $2700-2950 → wholesale ~$2500.
  ('plumbing', 'Heat pump HWS 315L',              'Reclaim Energy',  'each', 2500.00),
  -- ── Tapware gap fills ───────────────────────────────────────────
  -- Laundry tap: basic chrome laundry mixer. Retail $110 → wholesale ~$95.
  ('plumbing', 'Laundry tap (chrome)',            'Caroma',          'each',   95.00),
  -- Outdoor garden tap: standard hose-bib. Retail $55 → wholesale ~$45.
  ('plumbing', 'Outdoor garden tap',              'Caroma',          'each',   45.00),
  -- ── Toilet premium gap fill ─────────────────────────────────────
  -- Smart toilet suite (Caroma Smart 270 etc): heated seat, bidet, soft-close.
  -- Retail $2200-2500 → wholesale ~$1900. Growing premium tier in AU market.
  ('plumbing', 'Smart toilet suite',              'Caroma Smart',    'each', 1900.00)
) as v(trade, name, brand, unit, default_unit_price_ex_gst)
where not exists (
  select 1 from shared_materials sm
   where sm.name = v.name and sm.trade = v.trade
);
