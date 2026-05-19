// QuoteMate · run migration 037 (backfill the last 11 NULL-category rows)
// Usage:  node --env-file=.env.local scripts/run-migration-037.mjs
//
// Data-only, additive, idempotent. After this, EVERY shared_assemblies
// row should carry an explicit category (0 NULL) — single-source done.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "037_remaining_assembly_categories.sql");

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

const EXPECTED = [
  ["electrical", "Hardwire induction cooktop", "oven_cooktop"],
  ["electrical", "Hardwire oven", "oven_cooktop"],
  ["electrical", "Install aircon power point", "gpo"],
  ["electrical", "Install bathroom exhaust fan", "fan"],
  ["electrical", "Install EV charger", "ev_charger"],
  ["electrical", "Install outdoor IP-rated GPO", "gpo"],
  ["plumbing", "Install external garden tap", "tap"],
  ["plumbing", "Install garbage disposal", "sundry"],
  ["plumbing", "Install washing machine taps", "tap"],
  ["plumbing", "Replace toilet seat", "toilet"],
  ["plumbing", "Stormwater drain unblock", "drain"],
];

const sql = readFileSync(sqlPath, "utf8");
const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`→ Running 037_remaining_assembly_categories.sql (${sql.length.toLocaleString()} chars)...`);
  await client.query(sql);
  console.log("OK migration applied");

  let bad = 0;
  for (const [trade, name, cat] of EXPECTED) {
    const { rows } = await client.query(
      `select category from shared_assemblies where trade=$1 and name=$2`,
      [trade, name],
    );
    if (rows.length === 0) {
      console.error(`  ✗ MISSING ROW: [${trade}] "${name}"`);
      bad++;
    } else if (rows[0].category !== cat) {
      console.error(`  ✗ [${trade}] "${name}" category=${rows[0].category} expected=${cat}`);
      bad++;
    } else {
      console.log(`  ✓ [${trade}] "${name}" → ${cat}`);
    }
  }

  const { rows: tally } = await client.query(
    `select count(*)::int n, count(category)::int tagged,
            count(*) filter (where category is null)::int still_null
       from shared_assemblies`,
  );
  console.log(
    `\nshared_assemblies: ${tally[0].tagged}/${tally[0].n} carry an explicit category; ${tally[0].still_null} still NULL.`,
  );
  if (tally[0].still_null === 0) {
    console.log("  ✓ SINGLE-SOURCE COMPLETE — every assembly has an explicit category.");
  } else {
    const { rows: nulls } = await client.query(
      `select trade, name from shared_assemblies where category is null order by trade, name`,
    );
    for (const r of nulls) console.log(`    - [${r.trade}] "${r.name}" still NULL`);
  }

  if (bad > 0) {
    console.error(`\nFAIL — ${bad} backfill mismatch(es).`);
    process.exit(1);
  }
  console.log("\nOK — migration 037 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
