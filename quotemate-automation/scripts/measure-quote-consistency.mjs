// READ-ONLY, AGGREGATE-ONLY Phase 0 baseline for the quote-integrity backstops.
// Sizes the three problems the reconcile backstops (lib/estimate/reconcile.ts)
// fix. No PII, no writes. Run before AND after deploying the backstops.
// Run: node --env-file=.env.local scripts/measure-quote-consistency.mjs

import pg from 'pg'
const { Client } = pg

const c = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
})
await c.connect()

async function q(label, sql) {
  try {
    const r = await c.query(sql)
    console.log(`\n=== ${label} ===`)
    console.table(r.rows)
  } catch (e) {
    console.log(`\n=== ${label} ===\n  (query failed: ${e.message})`)
  }
}

// ── 1. Line-level math errors: total_ex_gst != round(qty × unit_price, 2) ──
await q('LINE MATH ERRORS — total_ex_gst != qty × unit_price', `
  with lines as (
    select li
    from quotes q
    cross join lateral (values ('good', q.good), ('better', q.better), ('best', q.best)) as t(k, tier)
    cross join lateral jsonb_array_elements(coalesce(t.tier->'line_items', '[]'::jsonb)) as li
    where t.tier is not null and not q.needs_inspection
  )
  select
    count(*) as total_lines,
    count(*) filter (
      where (li->>'quantity')         ~ '^-?[0-9.]+$'
        and (li->>'unit_price_ex_gst') ~ '^-?[0-9.]+$'
        and (li->>'total_ex_gst')      ~ '^-?[0-9.]+$'
        and abs( (li->>'total_ex_gst')::numeric
                 - round( (li->>'quantity')::numeric * (li->>'unit_price_ex_gst')::numeric, 2) ) > 0.01
    ) as math_error_lines
  from lines
`)

// ── 2. Subtotal drift: tier subtotal != sum(line totals) ──
await q('SUBTOTAL DRIFT — tier subtotal != sum of line totals', `
  with tiers as (
    select
      (t.tier->>'subtotal_ex_gst')::numeric as subtotal,
      (select coalesce(sum((li->>'total_ex_gst')::numeric), 0)
         from jsonb_array_elements(coalesce(t.tier->'line_items', '[]'::jsonb)) li
        where (li->>'total_ex_gst') ~ '^-?[0-9.]+$') as line_sum
    from quotes q
    cross join lateral (values ('good', q.good), ('better', q.better), ('best', q.best)) as t(k, tier)
    where t.tier is not null and not q.needs_inspection
  )
  select
    count(*) as total_priced_tiers,
    count(*) filter (where subtotal is not null and abs(subtotal - line_sum) > 0.01) as drifted_tiers
  from tiers
`)

// ── 3. Fake tiers: all three present tier subtotals identical ──
await q('FAKE TIERS — all 3 present tier subtotals identical', `
  select
    count(*) as auto_quotes_with_3_tiers,
    count(*) filter (
      where (good->>'subtotal_ex_gst') = (better->>'subtotal_ex_gst')
        and (better->>'subtotal_ex_gst') = (best->>'subtotal_ex_gst')
    ) as all_three_identical
  from quotes
  where not needs_inspection and good is not null and better is not null and best is not null
`)

await c.end()
console.log('\n[done] read-only measurement complete — no rows modified.')
