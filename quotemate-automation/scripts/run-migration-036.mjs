// QuoteMate · run migration 036 (explicit category on easy-5 CORE assemblies)
// Usage:  node --env-file=.env.local scripts/run-migration-036.mjs
//
// Data-only (column shipped in mig 029). Additive in validate.ts, so
// safe before OR after the code deploy; idempotent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "036_core_assembly_categories.sql");

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

// [trade, name, expected category] — the core rows backfilled by 036.
const EXPECTED = [
  ["electrical", "Hardwire 240V smoke alarm", "smoke_alarm"],
  ["electrical", "Install cooktop (existing wiring)", "oven_cooktop"],
  ["electrical", "Install customer-supplied ceiling fan", "fan"],
  ["electrical", "Install LED downlight", "downlight"],
  ["electrical", "Install outdoor IP-rated LED light", "outdoor_light"],
  ["electrical", "Install oven (existing wiring)", "oven_cooktop"],
  ["electrical", "Install premium DC fan with wall control", "fan"],
  ["electrical", "Replace double GPO", "gpo"],
  ["electrical", "Supply + install AC ceiling fan", "fan"],
  ["plumbing", "CCTV drain inspection", "cctv"],
  ["plumbing", "Disposal and site cleanup", "sundry"],
  ["plumbing", "Gas appliance connection", "gas"],
  ["plumbing", "Hand rod blocked drain", "drain"],
  ["plumbing", "Install electric HWS", "hot_water"],
  ["plumbing", "Install gas HWS", "hot_water"],
  ["plumbing", "Install heat pump HWS", "hot_water"],
  ["plumbing", "Jet blast blocked drain", "drain"],
  ["plumbing", "Pressure reduction valve install", "prv"],
  ["plumbing", "Tap replacement", "tap"],
  ["plumbing", "Tap washer replacement", "tap"],
  ["plumbing", "Toilet cistern repair", "toilet"],
  ["plumbing", "Toilet suite install", "toilet"],
];

const sql = readFileSync(sqlPath, "utf8");
const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  console.log(`→ Running 036_core_assembly_categories.sql (${sql.length.toLocaleString()} chars)...`);
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
    `\nshared_assemblies: ${tally[0].tagged}/${tally[0].n} now carry an explicit category` +
      ` (${tally[0].still_null} still NULL — should be 0 after 029+036).`,
  );
  if (tally[0].still_null > 0) {
    const { rows: nulls } = await client.query(
      `select trade, name from shared_assemblies where category is null order by trade, name`,
    );
    console.log("  rows still NULL (these still fall back to name regex):");
    for (const r of nulls) console.log(`    - [${r.trade}] "${r.name}"`);
  }

  if (bad > 0) {
    console.error(`\nFAIL — ${bad} backfill mismatch(es).`);
    process.exit(1);
  }
  console.log("\nOK — migration 036 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
