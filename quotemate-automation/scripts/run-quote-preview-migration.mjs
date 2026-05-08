// ═══════════════════════════════════════════════════════════════════
// QuoteMate · Quote-preview migration runner (009)
//
// Usage:  node --env-file=.env.local scripts/run-quote-preview-migration.mjs
//
// Adds preview_* columns to quotes for the Gemini-generated AI preview
// image. Idempotent (`add column if not exists`, `create index if not
// exists`).
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "009_quote_preview.sql");

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

  console.log(`\n→ Running 009_quote_preview.sql (${sql.length.toLocaleString()} chars)...`);
  await client.query(sql);
  console.log("  ✓ migration applied.");

  // Verify the columns landed.
  const cols = await client.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'quotes'
      and column_name in ('preview_image_path','preview_status','preview_generated_at','preview_prompt','preview_error')
    order by column_name
  `);

  console.log("\n  Verification — preview columns on quotes:");
  for (const r of cols.rows) console.log(`    ✓ ${r.column_name}`);
  if (cols.rowCount !== 5) console.log(`    ⚠ expected 5 columns, found ${cols.rowCount}`);

  const idxCheck = await client.query(`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'quotes' and indexname = 'quotes_preview_status_idx'
  `);
  console.log(`    ${idxCheck.rowCount > 0 ? "✓" : "✗"} quotes_preview_status_idx`);

  // Existing quotes default to status='idle' — they'll trigger generation
  // on first quote-page load (Trigger 2 fires on idle+photos).
  const stat = await client.query(`
    select preview_status, count(*)::int as n
    from quotes group by 1 order by 1
  `);
  console.log("\n  Existing quotes by preview_status:");
  for (const r of stat.rows) console.log(`    ${r.preview_status.padEnd(12)} ${r.n}`);
} catch (err) {
  console.error("\n✗ migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
  console.log("\n→ Done.");
}
