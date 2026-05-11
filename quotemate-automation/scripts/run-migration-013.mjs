// Apply sql/migrations/013_plumbing_expansion.sql to prod Supabase.
// v5 multi-trade — adds `trade` column to pricing_book + intakes,
// seeds 12 plumbing assemblies, 13 plumbing materials, 1 plumbing pricing_book row.
// Idempotent — re-running is a no-op.
//
// Usage:  node --env-file=.env.local scripts/run-migration-013.mjs

import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "sql", "migrations", "013_plumbing_expansion.sql"), "utf8");

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

console.log("→ Applying 013_plumbing_expansion.sql");
await c.query(sql);
console.log("✓ Migration applied\n");

// ─── Verify expected post-state ───────────────────────────────────
const pbBoth = await c.query(
  `select trade, hourly_rate, call_out_minimum, default_markup_pct,
          min_labour_hours, licence_type, licence_state
     from pricing_book
    order by trade`,
);
const asmCount = await c.query(
  `select trade, count(*)::int as n from shared_assemblies group by trade order by trade`,
);
const matCount = await c.query(
  `select trade, count(*)::int as n from shared_materials group by trade order by trade`,
);
const intakeCols = await c.query(
  `select column_name, data_type, column_default
     from information_schema.columns
    where table_name = 'intakes' and column_name = 'trade'`,
);

console.log("── pricing_book rows ──");
for (const r of pbBoth.rows) {
  console.log(
    `  ${r.trade.padEnd(10)}  $${r.hourly_rate}/hr  callout $${r.call_out_minimum}` +
      `  markup ${r.default_markup_pct}%  min ${r.min_labour_hours}hr` +
      `  ${r.licence_type ?? "—"} / ${r.licence_state ?? "—"}`,
  );
}

console.log("\n── shared_assemblies by trade ──");
for (const r of asmCount.rows) console.log(`  ${r.trade.padEnd(10)}  ${r.n} rows`);

console.log("\n── shared_materials by trade ──");
for (const r of matCount.rows) console.log(`  ${r.trade.padEnd(10)}  ${r.n} rows`);

console.log("\n── intakes.trade column ──");
if (intakeCols.rows.length === 0) {
  console.log("  ⚠ MISSING — column was not created");
} else {
  const r = intakeCols.rows[0];
  console.log(`  ${r.column_name}  ${r.data_type}  default=${r.column_default ?? "—"}`);
}

await c.end();

// Sanity: did the row counts land where they should?
const asmByTrade = Object.fromEntries(asmCount.rows.map((r) => [r.trade, r.n]));
const matByTrade = Object.fromEntries(matCount.rows.map((r) => [r.trade, r.n]));
const issues = [];
if ((asmByTrade.plumbing ?? 0) < 12) issues.push(`plumbing assemblies: expected ≥12, got ${asmByTrade.plumbing ?? 0}`);
if ((matByTrade.plumbing ?? 0) < 13) issues.push(`plumbing materials: expected ≥13, got ${matByTrade.plumbing ?? 0}`);
if (pbBoth.rows.length !== 2) issues.push(`pricing_book rows: expected 2, got ${pbBoth.rows.length}`);
if (intakeCols.rows.length === 0) issues.push(`intakes.trade column missing`);

if (issues.length) {
  console.log("\n⚠ Post-migration sanity check found issues:");
  for (const i of issues) console.log(`  • ${i}`);
  process.exit(1);
} else {
  console.log("\n✓ Post-migration sanity check passed — plumbing is live");
}
