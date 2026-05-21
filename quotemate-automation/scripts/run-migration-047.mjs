// QuoteMate · run migration 047 (categories table — Phase 0)
// Usage: node --env-file=.env.local scripts/run-migration-047.mjs
// Additive: creates `categories` + backfills every distinct
// (trade, category) on shared_assemblies. Depends on migration 046.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "047_categories.sql");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}
const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();

  // Pre-flight: migration 046 must have run.
  const { rows: tradeCheck } = await c.query("select count(*)::int n from trades");
  if (tradeCheck[0].n === 0) {
    console.error("PRE-FLIGHT FAIL: trades table empty — run migration 046 first");
    process.exit(1);
  }

  console.log(`→ Running 047_categories.sql (${sql.length.toLocaleString()} chars)...`);
  await c.query(sql);

  // Verify every distinct shared_assemblies category got a row.
  const { rows: gap } = await c.query(`
    select sa.trade, sa.category
      from (select distinct trade, category from shared_assemblies
             where category is not null and trade is not null) sa
      left join trades t on t.name = sa.trade
      left join categories cat on cat.trade_id = t.id and cat.name = sa.category
     where cat.id is null`);
  if (gap.length > 0) {
    console.error(`FAIL — ${gap.length} shared_assemblies categories not backfilled:`);
    for (const g of gap) console.error(`  [${g.trade}] ${g.category}`);
    process.exit(1);
  }

  const { rows: tally } = await c.query(`
    select t.name as trade, count(cat.id)::int n
      from trades t left join categories cat on cat.trade_id = t.id
     group by t.name order by t.name`);
  console.log("OK — categories backfilled:");
  for (const r of tally) console.log(`  ${r.trade}: ${r.n}`);
  console.log("\nOK — migration 047 verified (every shared_assemblies category has a row).");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}
