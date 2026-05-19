// QuoteMate · run migration 031 (tenant-owned bills of materials)
//
// SAFE BY DEFAULT. Without --apply this only prints the SQL and exits
// (dry run, no DB connection). A human opts in explicitly.
//
// Dry run:   node --env-file=.env.local scripts/run-migration-031.mjs
// Apply:     node --env-file=.env.local scripts/run-migration-031.mjs --apply

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "031_tenant_assembly_bom.sql");
const sql = readFileSync(sqlPath, "utf8");
const apply = process.argv.includes("--apply");

if (!apply) {
  console.log(
    "\nDRY RUN — migration 031 NOT applied (no --apply flag).\n" +
      "Creates tenant_assembly_bom (the editable per-tradie recipe book).\n" +
      "Re-run with --apply after human approval:\n" +
      "  node --env-file=.env.local scripts/run-migration-031.mjs --apply\n\n" +
      `--- SQL (${sql.length.toLocaleString()} chars) ---\n${sql}`,
  );
  process.exit(0);
}

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}
const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  console.log(`\n→ Applying 031_tenant_assembly_bom.sql (${sql.length.toLocaleString()} chars)...`);
  await client.query(sql);
  const { rows } = await client.query(
    `select table_name from information_schema.tables
      where table_schema='public' and table_name='tenant_assembly_bom'`,
  );
  if (rows.length !== 1) {
    console.error("FAIL — tenant_assembly_bom not present post-migration");
    process.exit(1);
  }
  console.log("OK — tenant_assembly_bom created.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
