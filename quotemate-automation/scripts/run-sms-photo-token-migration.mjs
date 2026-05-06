// ═══════════════════════════════════════════════════════════════════
// QuoteMate · run migration 005 (sms_conversations photo columns)
//
// Usage:  node --env-file=.env.local scripts/run-sms-photo-token-migration.mjs
//
// Idempotent — uses `add column if not exists`.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "005_sms_conversations_photos.sql");

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
  console.log(`\n-> Running 005_sms_conversations_photos.sql (${sql.length.toLocaleString()} chars)...`);
  await client.query(sql);
  console.log("OK migration applied");

  const r = await client.query(`
    select column_name, data_type
    from information_schema.columns
    where table_name = 'sms_conversations'
      and column_name in ('photo_request_token','photo_request_sent_at','photos_completed_at','photo_urls')
    order by column_name
  `);
  if (r.rows.length === 4) {
    console.log("OK all four columns present:");
    for (const row of r.rows) console.log(`   ${row.column_name}: ${row.data_type}`);
  } else {
    console.error(`Expected 4 columns, found ${r.rows.length}`);
    process.exit(1);
  }
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
