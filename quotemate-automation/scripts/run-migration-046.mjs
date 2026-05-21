// QuoteMate · run migration 046 (trades registry — Phase 0)
// Usage: node --env-file=.env.local scripts/run-migration-046.mjs
// Additive: creates `trades` + backfills electrical/plumbing. Idempotent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "046_trades.sql");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}
const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();
  console.log(`→ Running 046_trades.sql (${sql.length.toLocaleString()} chars)...`);
  await c.query(sql);

  const { rows } = await c.query("select name, display_name, is_job_based, active from trades order by name");
  console.log(`OK — trades (${rows.length}):`);
  for (const r of rows) console.log(`  ${r.name} · ${r.display_name} · job_based=${r.is_job_based} active=${r.active}`);

  const names = new Set(rows.map((r) => r.name));
  if (!names.has("electrical") || !names.has("plumbing")) {
    console.error("FAIL — electrical + plumbing must both be backfilled");
    process.exit(1);
  }
  console.log("\nOK — migration 046 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}
