// QuoteMate · run migration 052 (admin bulk loader — commit + rollback)
// Usage: node --env-file=.env.local scripts/run-migration-052.mjs
//
// Additive: adds UNIQUE (trade,name) indexes on shared_assemblies +
// shared_materials and creates the commit_import_batch / rollback_import_batch
// functions. Pre-flight re-confirms there are no (trade,name) duplicates so
// the unique-index creation cannot fail.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "052_loader_commit.sql");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}
const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();

  // ── PRE-FLIGHT — the unique index cannot be created over duplicates ──
  for (const tbl of ["shared_assemblies", "shared_materials"]) {
    const { rows } = await c.query(
      `select trade, name, count(*)::int n from ${tbl}
        group by trade, name having count(*) > 1`,
    );
    if (rows.length > 0) {
      console.error(
        `PRE-FLIGHT FAIL: ${tbl} has duplicate (trade,name) rows:`,
        rows,
      );
      process.exit(1);
    }
  }
  console.log("  ✓ pre-flight: no (trade,name) duplicates in either table");

  // ── APPLY ─────────────────────────────────────────────────────────
  console.log(`\n→ Running 052_loader_commit.sql (${sql.length.toLocaleString()} chars)...`);
  await c.query(sql);
  console.log("OK migration applied");

  // ── POST-VERIFY ───────────────────────────────────────────────────
  let bad = 0;
  for (const fn of ["commit_import_batch", "rollback_import_batch"]) {
    const { rows } = await c.query(
      `select count(*)::int n from pg_proc where proname = $1`,
      [fn],
    );
    if (rows[0].n >= 1) {
      console.log(`  ✓ function ${fn} present`);
    } else {
      console.error(`  ✗ function ${fn} missing`);
      bad++;
    }
  }
  for (const idx of [
    "shared_assemblies_trade_name_key",
    "shared_materials_trade_name_key",
  ]) {
    const { rows } = await c.query(
      `select count(*)::int n from pg_indexes where indexname = $1`,
      [idx],
    );
    if (rows[0].n === 1) {
      console.log(`  ✓ unique index ${idx} present`);
    } else {
      console.error(`  ✗ unique index ${idx} missing`);
      bad++;
    }
  }

  if (bad > 0) {
    console.error(`\nFAIL — ${bad} post-verify check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOK — migration 052 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}
