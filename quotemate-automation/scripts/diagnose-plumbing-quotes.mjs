// Diagnostic: trace why plumbing quotes keep returning "needs site visit".
//
// Checks each layer of the pipeline:
//   1. pricing_book — is the plumbing row actually there and correct?
//   2. shared_assemblies / shared_materials — are plumbing rows queryable?
//   3. Recent intakes — what trade/job_type are they being classified as?
//   4. Recent quotes — auto-quote vs inspection, and why?
//   5. For any inspection-downgraded quote, surface the inspection_reason
//
// Usage:  node --env-file=.env.local scripts/diagnose-plumbing-quotes.mjs

import pg from "pg";

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const hr = () => console.log('─'.repeat(80));

// ─── 1. pricing_book sanity ─────────────────────────────────────
hr();
console.log('1. pricing_book rows');
hr();
const pb = await c.query(`
  select trade, hourly_rate, call_out_minimum, default_markup_pct,
         min_labour_hours, licence_type, licence_state
    from pricing_book order by trade
`);
for (const r of pb.rows) {
  console.log(
    `  ${r.trade.padEnd(10)} $${r.hourly_rate}/hr  callout $${r.call_out_minimum}  ` +
    `markup ${r.default_markup_pct}%  min ${r.min_labour_hours}hr  ${r.licence_type}/${r.licence_state}`
  );
}

// ─── 2. Plumbing catalogue ──────────────────────────────────────
hr();
console.log('2. plumbing shared_assemblies (price + labour)');
hr();
const asm = await c.query(`
  select name, default_unit_price_ex_gst as price, default_labour_hours as hrs,
         left(coalesce(description,''), 60) as descr
    from shared_assemblies where trade = 'plumbing' order by name
`);
for (const r of asm.rows) {
  console.log(`  $${String(r.price).padStart(6)}  ${String(r.hrs).padStart(4)}hr  ${r.name.padEnd(40)}  "${r.descr}"`);
}
console.log(`  → ${asm.rows.length} plumbing assemblies\n`);

hr();
console.log('3. plumbing shared_materials');
hr();
const mat = await c.query(`
  select name, brand, default_unit_price_ex_gst as price
    from shared_materials where trade = 'plumbing' order by price
`);
for (const r of mat.rows) {
  console.log(`  $${String(r.price).padStart(6)}  ${(r.brand ?? '').padEnd(18)}  ${r.name}`);
}
console.log(`  → ${mat.rows.length} plumbing materials`);

// ─── 4. Recent intakes (any trade, last 24h) ──────────────────
hr();
console.log('4. Recent intakes (last 24h, any trade)');
hr();
const intakes = await c.query(`
  select id, trade, job_type, confidence, inspection_required,
         coalesce(scope->>'description','') as desc,
         created_at
    from intakes
   where created_at > now() - interval '24 hours'
   order by created_at desc
   limit 20
`);
if (intakes.rows.length === 0) {
  console.log('  (no intakes in the last 24h)');
} else {
  for (const r of intakes.rows) {
    const trade = (r.trade ?? '?').padEnd(10);
    const jt = (r.job_type ?? '?').padEnd(22);
    const conf = (r.confidence ?? '?').padEnd(6);
    const insp = r.inspection_required ? 'INSP=Y' : 'INSP=N';
    const desc = (r.desc ?? '').slice(0, 50);
    console.log(`  ${trade}  ${jt}  ${conf}  ${insp}  "${desc}"`);
    console.log(`    intake_id=${r.id}  at ${r.created_at.toISOString()}`);
  }
}

// ─── 5. Recent quotes — auto-quote vs inspection ────────────
hr();
console.log('5. Recent quotes (last 24h) — were they auto-quoted or downgraded?');
hr();
const quotes = await c.query(`
  select q.id, q.intake_id, q.needs_inspection,
         q.inspection_reason,
         q.subtotal_ex_gst, q.total_inc_gst,
         q.selected_tier,
         i.trade, i.job_type, i.confidence, i.inspection_required,
         coalesce(i.scope->>'description','') as desc,
         q.created_at
    from quotes q
    left join intakes i on i.id = q.intake_id
   where q.created_at > now() - interval '24 hours'
   order by q.created_at desc
   limit 20
`);
if (quotes.rows.length === 0) {
  console.log('  (no quotes in the last 24h)');
} else {
  for (const r of quotes.rows) {
    const trade = (r.trade ?? '?').padEnd(10);
    const jt = (r.job_type ?? '?').padEnd(20);
    const path = r.needs_inspection ? 'INSPECTION→$99' : `AUTO-QUOTE $${r.total_inc_gst}`;
    const tier = r.selected_tier ?? '-';
    console.log(`  ${trade}  ${jt}  ${path.padEnd(20)}  tier=${tier}`);
    if (r.needs_inspection && r.inspection_reason) {
      console.log(`    reason: "${r.inspection_reason.slice(0, 120)}"`);
    }
    console.log(`    intake_inspection_flag=${r.inspection_required}  intake_confidence=${r.confidence}`);
    console.log(`    intake_desc: "${r.desc.slice(0, 80)}"`);
    console.log(`    quote_id=${r.id}`);
    console.log('');
  }
}

// ─── 6. Plumbing-specific summary ──────────────────────────
hr();
console.log('6. Plumbing pipeline summary (last 24h)');
hr();
const plumbingStats = await c.query(`
  select
    count(*) filter (where i.trade = 'plumbing') as plumbing_intakes,
    count(*) filter (where i.trade = 'plumbing' and i.inspection_required) as plumbing_inspection_flagged_by_structurer,
    count(*) filter (where i.trade = 'plumbing' and not i.inspection_required) as plumbing_auto_quote_candidates,
    count(*) filter (where i.trade = 'plumbing' and q.needs_inspection) as plumbing_ended_as_inspection,
    count(*) filter (where i.trade = 'plumbing' and not q.needs_inspection) as plumbing_ended_as_auto_quote
    from intakes i
    left join quotes q on q.intake_id = i.id
   where i.created_at > now() - interval '24 hours'
`);
const s = plumbingStats.rows[0];
console.log(`  Plumbing intakes:                          ${s.plumbing_intakes}`);
console.log(`    flagged inspection by intake structurer: ${s.plumbing_inspection_flagged_by_structurer}`);
console.log(`    auto-quote candidates after structurer:  ${s.plumbing_auto_quote_candidates}`);
console.log(`  Plumbing quote outcomes:`);
console.log(`    ended as inspection:                     ${s.plumbing_ended_as_inspection}`);
console.log(`    ended as auto-quote:                     ${s.plumbing_ended_as_auto_quote}`);

await c.end();
