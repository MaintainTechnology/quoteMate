// QuoteMate · run migration 049 (import_batches + import_staged_rows)
// Usage: node --env-file=.env.local scripts/run-migration-049.mjs
// Additive: the audit + staging tables for the admin bulk loader.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "049_import_batches.sql");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}
const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();
  console.log(`→ Running 049_import_batches.sql (${sql.length.toLocaleString()} chars)...`);
  await c.query(sql);

  const { rows } = await c.query(`
    select table_name from information_schema.tables
     where table_schema='public'
       and table_name in ('import_batches', 'import_staged_rows')
     order by table_name`);
  const got = new Set(rows.map((r) => r.table_name));
  for (const t of ["import_batches", "import_staged_rows"]) {
    if (!got.has(t)) {
      console.error(`FAIL — ${t} not created`);
      process.exit(1);
    }
    console.log(`  ✓ ${t}`);
  }
  console.log("\nOK — migration 049 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}
