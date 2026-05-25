// QuoteMate · run migration 057 (vector-store upgrade — voyage-3-large @ 1024 dims)
//
// Apply to staging first, then production with explicit approval:
//   node --env-file=.env.staging.local scripts/run-migration-057.mjs
//   node --env-file=.env.local         scripts/run-migration-057.mjs
//
// IMPORTANT — after applying, run the backfill so RAG works again:
//   node --env-file=.env.staging.local scripts/reembed-intakes-voyage3-large.mjs
//   node --env-file=.env.local         scripts/reembed-intakes-voyage3-large.mjs
//
// Between the migration and the backfill, RAG returns no matches (the
// estimator falls back gracefully — no past-quote anchoring, but quotes
// still draft via Opus + the grounding validator).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "057_voyage3_large_1024.sql");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL (use --env-file=.env.local or .env.staging.local)");
  process.exit(1);
}
const target = dbUrl.includes("bobvihqwhtcbxneelfns") ? "PRODUCTION" : "staging";
const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();

  // Pre-check: count intakes + how many will be NULLed.
  const pre = await c.query(
    `select
       count(*)::int as total,
       count(embedding)::int as with_embedding
     from intakes`,
  );
  const { total, with_embedding } = pre.rows[0];
  console.log(`Pre-migration state on ${target}:`);
  console.log(`  intakes total:           ${total}`);
  console.log(`  intakes with embedding:  ${with_embedding}  ← these will be NULLed and need re-embedding`);

  console.log(`\n→ Running 057_voyage3_large_1024.sql against ${target} (${sql.length.toLocaleString()} chars)...`);
  await c.query(sql);
  console.log("OK migration applied");

  // Post-checks: column type + function signature + comment.
  const { rows: colRows } = await c.query(
    `select udt_name, character_maximum_length, atttypmod
       from information_schema.columns c
       join pg_attribute a on a.attrelid = (c.table_schema||'.'||c.table_name)::regclass
                          and a.attname = c.column_name
      where c.table_name = 'intakes' and c.column_name = 'embedding'`,
  );
  if (colRows.length === 1) {
    console.log(`  ✓ intakes.embedding column type: ${colRows[0].udt_name} (atttypmod=${colRows[0].atttypmod})`);
  } else {
    console.error("  ✗ intakes.embedding column not found");
    process.exit(1);
  }

  const { rows: fnRows } = await c.query(
    `select pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'match_intakes'`,
  );
  if (fnRows.length === 1 && fnRows[0].args.includes("vector(1024)")) {
    console.log(`  ✓ match_intakes signature now: (${fnRows[0].args})`);
  } else {
    console.error(`  ✗ match_intakes signature unexpected: ${fnRows.map(r => r.args).join(" | ")}`);
    process.exit(1);
  }

  const { rows: postCount } = await c.query(
    `select count(*)::int as total, count(embedding)::int as with_embedding from intakes`,
  );
  console.log(`\nPost-migration state on ${target}:`);
  console.log(`  intakes total:           ${postCount[0].total}`);
  console.log(`  intakes with embedding:  ${postCount[0].with_embedding}  ← should be 0`);

  if (postCount[0].with_embedding > 0) {
    console.error("  ✗ expected 0 embeddings after NULL pass — something's off");
    process.exit(1);
  }

  console.log(`\nOK — migration 057 verified on ${target}.`);
  console.log(`Next step: run scripts/reembed-intakes-voyage3-large.mjs against the same env to repopulate.`);
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}
