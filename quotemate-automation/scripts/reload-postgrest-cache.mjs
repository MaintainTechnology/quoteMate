// One-shot: tell PostgREST to reload its schema cache.
// PostgREST caches column metadata for performance — after a DDL change,
// it doesn't see the new columns until the cache is refreshed. Supabase
// auto-detects most DDL via triggers, but a manual NOTIFY is the safe
// belt-and-braces for "I just added a column and the API is still 404ing".
//
// Run from repo root after a migration:
//   node --env-file=.env.local scripts/reload-postgrest-cache.mjs

import pg from "pg";
const { Client } = pg;

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

const client = new Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log("→ Sending NOTIFY pgrst, 'reload schema'...");
  await client.query("NOTIFY pgrst, 'reload schema'");
  console.log("✓ schema cache reload requested. Effect is near-instant.");
} catch (e) {
  console.error("✗ failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await client.end();
}
