// ═══════════════════════════════════════════════════════════════════
// QuoteMate · run migration 008 (customers table + FK columns)
//
// Usage:  node --env-file=.env.local scripts/run-customers-migration.mjs
//
// Adds a `customers` table keyed by phone number plus customer_id FKs on
// sms_conversations, calls, intakes. Idempotent — uses
// `create table if not exists` and `add column if not exists`.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "008_customers.sql");

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

try {
  await client.connect();
  console.log(`\n→ Running 008_customers.sql (${sql.length.toLocaleString()} chars)...`);
  await client.query(sql);
  console.log("OK migration applied");

  // Verify the customers table + key FKs exist.
  const r = await client.query(`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and (
        (table_name = 'customers' and column_name in ('id','phone_number','first_name','suburb'))
        or column_name = 'customer_id'
      )
    order by table_name, column_name
  `);
  console.log("\n  Verification:");
  for (const row of r.rows) console.log(`    · ${row.table_name}.${row.column_name}`);
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
