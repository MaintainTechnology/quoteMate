// ═══════════════════════════════════════════════════════════════════
// QuoteMate · photo_paths migration runner (006)
//
// Usage:  node --env-file=.env.local scripts/run-photo-paths-migration.mjs
//
// Adds permanent storage-path columns so the public quote page can
// re-sign photo URLs on every render. Idempotent (uses
// `add column if not exists`).
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "006_intakes_photo_paths.sql");

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

const sql = readFileSync(sqlPath, "utf8");

const client = new Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

console.log("\n→ Connecting to Supabase Postgres...");
try {
  await client.connect();
  console.log("  connected.");

  console.log(`\n→ Running 006_intakes_photo_paths.sql (${sql.length.toLocaleString()} chars)...`);
  await client.query(sql);
  console.log("  ✓ migration applied.");

  // Quick sanity probe: list the columns we just added.
  const { rows } = await client.query(`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and column_name = 'photo_paths'
    order by table_name
  `);
  console.log("\n  photo_paths columns now present on:");
  for (const r of rows) console.log(`    · ${r.table_name}.${r.column_name}`);
} catch (err) {
  console.error("\n✗ migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
  console.log("\n→ Done.");
}
