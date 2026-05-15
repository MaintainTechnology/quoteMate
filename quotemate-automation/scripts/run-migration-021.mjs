// QuoteMate · run migration 021 (services catalogue extras)
// Usage:  node --env-file=.env.local scripts/run-migration-021.mjs

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
  "021_services_catalogue_extras.sql",
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
    `\n→ Running 021_services_catalogue_extras.sql (${sql.length.toLocaleString()} chars)...`,
  );
  await client.query(sql);
  console.log("OK migration applied");

  // Verify the new column + new rows.
  const { rows: colCheck } = await client.query(
    `select column_name, data_type, column_default
       from information_schema.columns
       where table_name = 'shared_assemblies' and column_name = 'default_enabled'`,
  );
  console.log(
    `\n  Column check — shared_assemblies.default_enabled:`,
    colCheck[0] ?? "MISSING",
  );

  const { rows: counts } = await client.query(
    `select trade, default_enabled, count(*)::int as n
       from shared_assemblies
       group by trade, default_enabled
       order by trade, default_enabled`,
  );
  console.log(`\n  Assembly counts by (trade, default_enabled):`);
  for (const r of counts) {
    console.log(
      `    ${r.trade.padEnd(11)} default_enabled=${String(r.default_enabled).padEnd(5)} ${r.n} row(s)`,
    );
  }

  const { rows: extras } = await client.query(
    `select trade, name
       from shared_assemblies
       where default_enabled = false
       order by trade, name`,
  );
  console.log(
    `\n  Extras (default_enabled=false) — these appear OFF until tradies tick them:`,
  );
  for (const r of extras) {
    console.log(`    ${r.trade.padEnd(11)} ${r.name}`);
  }
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
