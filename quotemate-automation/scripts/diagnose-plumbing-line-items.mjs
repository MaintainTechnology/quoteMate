// Look at the actual line items Opus emitted for the downgraded plumbing
// quotes, plus the equivalent successful one for comparison. Reveals
// exactly which assembly / material rows Opus tried to price against
// and why the validator rejected the bad ones.

import pg from "pg";

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const hr = () => console.log('─'.repeat(80));

// Quotes to dissect (from previous run):
const TARGETS = [
  // SUCCESSFUL plumbing toilet_replace — what Opus emitted that the validator accepted
  { id: '9277dff7-4f4d-426c-b4d0-867a6b0c7f5c', label: '✓ AUTO-QUOTE — toilet_replace ($1075.80)' },
  // FAILED plumbing toilet_replace — validator rejected
  { id: '66136de2-4976-4537-9cd4-aab614d89760', label: '✗ INSPECTION (grounding fail) — toilet_replace' },
  // FAILED plumbing hot_water — Opus self-escalated
  { id: '398d4519-0874-428e-afaa-ff55b1f062e2', label: '✗ INSPECTION (Opus chose) — hot_water (250L electric)' },
  { id: '0b3a04b2-8b29-42f2-9bd3-4c042171dc58', label: '✗ INSPECTION (Opus chose) — hot_water (250L electric)' },
  // SUCCESSFUL hot_water for comparison? Let's also check the auto-quoted plumbing successes
  { id: '251733be-c3ef-4e52-a73b-79aca829f647', label: '✓ AUTO-QUOTE — blocked_drain ($424.60)' },
  { id: '98b4383a-930e-47c8-adb1-87c6ba5efcf3', label: '✓ AUTO-QUOTE — tap_repair ($609.40)' },
];

for (const t of TARGETS) {
  hr();
  console.log(t.label);
  console.log(`quote_id = ${t.id}`);
  hr();

  // Quote header
  const q = await c.query(`
    select q.*, i.trade, i.job_type, i.confidence, i.inspection_required,
           coalesce(i.scope->>'description','') as desc,
           i.scope as scope_full,
           i.risks
      from quotes q
      left join intakes i on i.id = q.intake_id
     where q.id = $1
  `, [t.id]);
  if (q.rows.length === 0) { console.log('  (not found)\n'); continue; }
  const r = q.rows[0];

  console.log(`  intake_trade=${r.trade}  job_type=${r.job_type}  confidence=${r.confidence}  inspection_flag=${r.inspection_required}`);
  console.log(`  intake_desc: "${r.desc}"`);
  console.log(`  intake_risks: ${JSON.stringify(r.risks)}`);
  console.log(`  intake_scope: ${JSON.stringify(r.scope_full).slice(0, 200)}`);
  console.log(`  quote.needs_inspection=${r.needs_inspection}`);
  console.log(`  quote.inspection_reason: "${(r.inspection_reason ?? '').slice(0, 160)}"`);
  console.log(`  quote.scope_of_works: "${(r.scope_of_works ?? '').slice(0, 160)}"`);
  console.log(`  quote.scope_short: "${r.scope_short ?? ''}"`);

  // Line items
  const li = await c.query(`
    select tier, description, quantity, unit, unit_price_ex_gst, total_ex_gst, source
      from quote_line_items
     where quote_id = $1
     order by tier, id
  `, [t.id]);

  console.log(`\n  Line items (${li.rows.length}):`);
  let lastTier = '';
  for (const l of li.rows) {
    if (l.tier !== lastTier) {
      console.log(`    [${l.tier.toUpperCase()}]`);
      lastTier = l.tier;
    }
    console.log(`      ${String(l.quantity).padStart(5)} ${l.unit.padEnd(4)} $${String(l.unit_price_ex_gst).padStart(8)}  =$${String(l.total_ex_gst).padStart(8)}  source=${l.source ?? '?'}`);
    console.log(`         "${l.description}"`);
  }

  // Tier subtotals
  if (r.good) console.log(`  good_subtotal_ex_gst: ${r.good.subtotal_ex_gst ?? 'null'}`);
  if (r.better) console.log(`  better_subtotal_ex_gst: ${r.better.subtotal_ex_gst ?? 'null'}`);
  if (r.best) console.log(`  best_subtotal_ex_gst: ${r.best.subtotal_ex_gst ?? 'null'}`);
  console.log('');
}

await c.end();
