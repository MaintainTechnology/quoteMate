// QuoteMate · run migration 030 (sms_conversations.followup_quote)
// Usage:  node --env-file=.env.local scripts/run-migration-030.mjs
//
// Additive, idempotent: adds a nullable jsonb column. Safe to re-run.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(
  here,
  "..",
  "sql",
  "migrations",
  "030_sms_conversations_followup_quote.sql",
);

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
  console.log(
    `\n→ Running 030_sms_conversations_followup_quote.sql (${sql.length.toLocaleString()} chars)...`,
  );
  await client.query(sql);
  console.log("OK migration applied");

  const { rows } = await client.query(
    `select data_type, is_nullable
       from information_schema.columns
       where table_name = 'sms_conversations'
         and column_name = 'followup_quote'`,
  );
  if (rows.length === 0) {
    console.error("FAIL — sms_conversations.followup_quote not found post-migration");
    process.exit(1);
  }
  console.log(
    `  OK — sms_conversations.followup_quote present (${rows[0].data_type}, nullable=${rows[0].is_nullable})`,
  );
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
