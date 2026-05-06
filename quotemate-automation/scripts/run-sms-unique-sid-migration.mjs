// ═══════════════════════════════════════════════════════════════════
// QuoteMate · run migration 004 (unique inbound MessageSid index)
//
// Usage:  node --env-file=.env.local scripts/run-sms-unique-sid-migration.mjs
//
// Idempotent — uses `create unique index if not exists`.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "004_sms_messages_unique_sid.sql");

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
  console.log(`\n-> Running 004_sms_messages_unique_sid.sql (${sql.length.toLocaleString()} chars)...`);
  await client.query(sql);
  console.log("OK migration applied");

  // Verify the unique index exists
  const r = await client.query(`
    select indexname, indexdef
    from pg_indexes
    where tablename = 'sms_messages'
      and indexname = 'sms_messages_unique_inbound_sid_idx'
  `);
  if (r.rows.length === 1) {
    console.log(`OK unique index present: ${r.rows[0].indexdef}`);
  } else {
    console.error("Unique index NOT found post-migration");
    process.exit(1);
  }
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
