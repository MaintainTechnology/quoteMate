// Dump the JSONB tier blobs (good/better/best) for the downgraded vs
// successful plumbing quotes so we can see EXACTLY which line items
// Opus emitted and which ones the validator rejected.

import pg from "pg";

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const hr = () => console.log('─'.repeat(80));

const TARGETS = [
  { id: '9277dff7-4f4d-426c-b4d0-867a6b0c7f5c', label: '✓ AUTO-QUOTE — toilet_replace ($1075.80)' },
  { id: '66136de2-4976-4537-9cd4-aab614d89760', label: '✗ INSPECTION (grounding fail) — toilet_replace' },
  { id: '398d4519-0874-428e-afaa-ff55b1f062e2', label: '✗ INSPECTION (Opus chose) — hot_water' },
  { id: '251733be-c3ef-4e52-a73b-79aca829f647', label: '✓ AUTO-QUOTE — blocked_drain ($424.60)' },
];

function dumpTier(tierKey, tier) {
  if (!tier) { console.log(`    ${tierKey}: null`); return; }
  console.log(`    [${tierKey.toUpperCase()}] label="${tier.label ?? '?'}" subtotal=$${tier.subtotal_ex_gst ?? '?'} timeframe="${tier.timeframe ?? '?'}"`);
  if (Array.isArray(tier.line_items)) {
    for (const li of tier.line_items) {
      const q = String(li.quantity ?? '?').padStart(5);
      const u = String(li.unit ?? '?').padEnd(4);
      const up = String(li.unit_price_ex_gst ?? '?').padStart(8);
      const tot = String(li.total_ex_gst ?? '?').padStart(9);
      console.log(`      ${q} ${u} unit_price=$${up}  total=$${tot}  src=${li.source ?? '?'}`);
      console.log(`           "${li.description}"`);
    }
  }
}

for (const t of TARGETS) {
  hr();
  console.log(t.label);
  console.log(`quote_id = ${t.id}`);
  hr();

  const q = await c.query(`
    select q.id, q.good, q.better, q.best,
           q.needs_inspection, q.inspection_reason,
           q.scope_of_works,
           i.job_type, i.scope as intake_scope, i.trade
      from quotes q
      left join intakes i on i.id = q.intake_id
     where q.id = $1
  `, [t.id]);
  if (q.rows.length === 0) { console.log('  (not found)\n'); continue; }
  const r = q.rows[0];

  console.log(`  intake_trade=${r.trade}  job_type=${r.job_type}`);
  console.log(`  intake_scope: ${JSON.stringify(r.intake_scope)}`);
  console.log(`  needs_inspection=${r.needs_inspection}`);
  if (r.inspection_reason) console.log(`  inspection_reason: "${r.inspection_reason}"`);
  console.log(`\n  Tiers (raw JSONB from quotes row):`);
  dumpTier('good',   r.good);
  dumpTier('better', r.better);
  dumpTier('best',   r.best);
  console.log('');
}

// ─── For the GROUNDING-FAILED quote: replay validator against catalogue ───
hr();
console.log('VALIDATOR REPLAY for grounding-failed quote 66136de2');
hr();
const failed = await c.query(`
  select q.good, q.better, q.best
    from quotes q where q.id = '66136de2-4976-4537-9cd4-aab614d89760'
`);
const mat = await c.query(`
  select name, default_unit_price_ex_gst as price from shared_materials where trade = 'plumbing' order by price
`);
const asm = await c.query(`
  select name, default_unit_price_ex_gst as price from shared_assemblies where trade = 'plumbing' order by price
`);

console.log('\nPlumbing material prices (raw + 20% markup):');
for (const m of mat.rows) {
  const raw = Number(m.price);
  const marked = +(raw * 1.20).toFixed(2);
  console.log(`  $${String(raw).padStart(8)} (raw)  $${String(marked).padStart(8)} (20%)   ${m.name}`);
}
console.log('\nPlumbing assembly prices (raw + 20% markup):');
for (const a of asm.rows) {
  const raw = Number(a.price);
  const marked = +(raw * 1.20).toFixed(2);
  console.log(`  $${String(raw).padStart(8)} (raw)  $${String(marked).padStart(8)} (20%)   ${a.name}`);
}

console.log('\nFAILED QUOTE 66136de2 tier blobs (they exist even on inspection-route, just nulled by route handler):');
// Note: when route handler downgrades, it nulls the tiers on the row.
// So we won't actually see what Opus emitted. Need to find from pipeline logs
// (Vercel logs) or re-run. Document this for the user.
const f = failed.rows[0];
console.log(`  good: ${f.good === null ? 'NULL (route nulled it)' : 'has data'}`);
console.log(`  better: ${f.better === null ? 'NULL (route nulled it)' : 'has data'}`);
console.log(`  best: ${f.best === null ? 'NULL (route nulled it)' : 'has data'}`);
console.log('\nThe route handler nulls tiers when downgrading to inspection,');
console.log('so the original Opus emission is in Vercel logs (search for');
console.log('"grounding check failed — downgrading quote to inspection-required")');
console.log('or look at the pipeline_log table if it exists.');

await c.end();
