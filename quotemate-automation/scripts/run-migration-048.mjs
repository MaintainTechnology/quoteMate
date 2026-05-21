// QuoteMate · run migration 048 (trade_prompts + trade_pricing_defaults)
// Usage: node --env-file=.env.local scripts/run-migration-048.mjs
// Additive. trade_prompts is created EMPTY (populated later by
// scripts/backfill-trade-prompts.mjs). trade_pricing_defaults is
// backfilled for electrical + plumbing. Depends on migration 046.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "048_trade_prompts_and_pricing_defaults.sql");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}
const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();

  const { rows: tradeCheck } = await c.query("select count(*)::int n from trades");
  if (tradeCheck[0].n === 0) {
    console.error("PRE-FLIGHT FAIL: trades table empty — run migration 046 first");
    process.exit(1);
  }

  console.log(`→ Running 048_trade_prompts_and_pricing_defaults.sql (${sql.length.toLocaleString()} chars)...`);
  await c.query(sql);

  const { rows: defaults } = await c.query(`
    select t.name as trade, d.hourly_rate, d.call_out_minimum, d.default_markup_pct,
           d.min_labour_hours, d.licence_label
      from trade_pricing_defaults d join trades t on t.id = d.trade_id
     order by t.name`);
  console.log(`OK — trade_pricing_defaults (${defaults.length} rows):`);
  for (const r of defaults)
    console.log(`  ${r.trade}: $${r.hourly_rate}/hr callout=$${r.call_out_minimum} markup=${r.default_markup_pct}% minhrs=${r.min_labour_hours} licence="${r.licence_label}"`);
  if (defaults.length < 2) {
    console.error("FAIL — electrical + plumbing pricing defaults must both be backfilled");
    process.exit(1);
  }

  const { rows: promptCols } = await c.query(`
    select count(*)::int n from information_schema.tables
     where table_schema='public' and table_name='trade_prompts'`);
  if (promptCols[0].n !== 1) {
    console.error("FAIL — trade_prompts table not created");
    process.exit(1);
  }
  console.log("OK — trade_prompts table created (empty; backfilled by the Phase 0 code refactor).");
  console.log("\nOK — migration 048 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}
