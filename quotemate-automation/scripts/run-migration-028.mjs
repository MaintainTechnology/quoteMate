// QuoteMate · run migration 028 (WP2 catalogue + WP3 structured BOM + overrides)
//
// SAFE BY DEFAULT. Without --apply this only prints the SQL and exits
// (dry run, no DB connection). This is keystone money-path schema, so a
// human must explicitly opt in — never applied autonomously.
//
// Dry run (default, safe):
//   node --env-file=.env.local scripts/run-migration-028.mjs
// Apply for real (human-approved only):
//   node --env-file=.env.local scripts/run-migration-028.mjs --apply

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "028_tenant_catalogue_and_bom.sql");
const sql = readFileSync(sqlPath, "utf8");

const apply = process.argv.includes("--apply");

if (!apply) {
  console.log(
    "\nDRY RUN — migration 028 NOT applied (no --apply flag).\n" +
      "Creates tenant_material_catalogue, shared_assembly_bom, tenant_assembly_overrides.\n" +
      "Re-run with --apply ONLY after human approval (keystone money-path schema):\n" +
      "  node --env-file=.env.local scripts/run-migration-028.mjs --apply\n\n" +
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
  console.log(`\n→ Applying 028_tenant_catalogue_and_bom.sql (${sql.length.toLocaleString()} chars)...`);
  await client.query(sql);
  console.log("OK migration applied");

  const { rows } = await client.query(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_name in ('tenant_material_catalogue', 'shared_assembly_bom', 'tenant_assembly_overrides')
      order by table_name`,
  );
  if (rows.length !== 3) {
    console.error("FAIL — expected 3 new tables, got:", rows.map((r) => r.table_name));
    process.exit(1);
  }
  console.log("  OK — tables present:", rows.map((r) => r.table_name).join(", "));
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
