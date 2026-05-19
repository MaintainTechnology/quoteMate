// QuoteMate · run migration 029 (explicit validator category on assemblies)
// Usage:  node --env-file=.env.local scripts/run-migration-029.mjs
//
// Safe to apply before OR after the code deploy: NULL category = old
// name-regex behaviour, and run.ts selects with `*` so a missing column
// degrades gracefully. Idempotent — re-running just re-asserts the
// deterministic backfill.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "029_assembly_category.sql");

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

const EXPECTED = [
  ["electrical", "Diagnostic call-out (fault finding)", "fault_find"],
  ["electrical", "Install LED strip lighting", "strip_light"],
  ["electrical", "Install motion sensor flood light", "outdoor_light"],
  ["electrical", "Install security camera (single)", "security_camera"],
  ["electrical", "Install wired doorbell or intercom", "doorbell_intercom"],
  ["plumbing", "Install dishwasher", "dishwasher"],
  ["plumbing", "Install rainwater tank", "rainwater_tank"],
  ["plumbing", "Install whole-house water filter", "water_filter"],
  ["plumbing", "Leak detection", "leak_detection"],
  ["plumbing", "Replace shower head", "shower"],
];

const sql = readFileSync(sqlPath, "utf8");
const client = new Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();

  console.log(
    `→ Running 029_assembly_category.sql (${sql.length.toLocaleString()} chars)...`,
  );
  await client.query(sql);
  console.log("OK migration applied");

  // Verify the column exists on both tables.
  for (const tbl of ["shared_assemblies", "tenant_custom_assemblies"]) {
    const { rows } = await client.query(
      `select 1 from information_schema.columns
        where table_name = $1 and column_name = 'category'`,
      [tbl],
    );
    if (rows.length === 0) {
      console.error(`FAIL — ${tbl}.category column not found post-migration`);
      process.exit(1);
    }
    console.log(`  OK — ${tbl}.category present`);
  }

  // Verify every expected backfill landed.
  let bad = 0;
  for (const [trade, name, expected] of EXPECTED) {
    const { rows } = await client.query(
      `select category from shared_assemblies where trade = $1 and name = $2`,
      [trade, name],
    );
    if (rows.length === 0) {
      console.error(`  ✗ MISSING ROW: [${trade}] "${name}" — name drifted from migration 021?`);
      bad++;
    } else if (rows[0].category !== expected) {
      console.error(`  ✗ [${trade}] "${name}" category=${rows[0].category} expected=${expected}`);
      bad++;
    } else {
      console.log(`  ✓ [${trade}] "${name}" → ${expected}`);
    }
  }

  const { rows: tally } = await client.query(
    `select count(*)::int n, count(category)::int tagged from shared_assemblies`,
  );
  console.log(
    `\nshared_assemblies: ${tally[0].tagged}/${tally[0].n} rows now carry an explicit category (rest fall back to name regex — by design).`,
  );

  if (bad > 0) {
    console.error(`\nFAIL — ${bad} backfill mismatch(es). Investigate before relying on grounding.`);
    process.exit(1);
  }
  console.log("\nOK — migration 029 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
