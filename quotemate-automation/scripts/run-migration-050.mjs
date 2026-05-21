// QuoteMate · run migration 050 (admin_users — the admin-auth gate)
// Usage: node --env-file=.env.local scripts/run-migration-050.mjs
// Additive: creates `admin_users`. Rows are inserted by hand afterwards.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "050_admin_users.sql");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}
const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();
  console.log(`→ Running 050_admin_users.sql (${sql.length.toLocaleString()} chars)...`);
  await c.query(sql);

  const { rows } = await c.query(`
    select count(*)::int n from information_schema.tables
     where table_schema='public' and table_name='admin_users'`);
  if (rows[0].n !== 1) {
    console.error("FAIL — admin_users not created");
    process.exit(1);
  }
  console.log("OK — admin_users table created.");
  console.log("NOTE: insert internal-admin auth user_ids by hand, e.g.");
  console.log("  insert into admin_users (user_id, note) values ('<auth-uuid>', 'Jeph — founder');");
  console.log("\nOK — migration 050 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}
