// QuoteMate · run migration 020 (catalogue gap fills)
// Usage:  node --env-file=.env.local scripts/run-migration-020.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "020_catalogue_gap_fills.sql");

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
  console.log(`\n→ Running 020_catalogue_gap_fills.sql (${sql.length.toLocaleString()} chars)...`);
  await client.query(sql);
  console.log("OK migration applied");

  // Verify the new rows landed
  const { rows } = await client.query(
    `select trade, name, brand, default_unit_price_ex_gst
       from shared_materials
       where trade = 'plumbing'
         and (name ilike 'Gas storage HWS 250L%'
              or name ilike 'Gas storage HWS 315L%'
              or name ilike 'Electric HWS 125L%'
              or name ilike 'Electric HWS 400L%'
              or name ilike 'Heat pump HWS 315L%'
              or name ilike 'Laundry tap%'
              or name ilike 'Outdoor garden tap%'
              or name ilike 'Smart toilet%')
       order by default_unit_price_ex_gst`,
  );

  console.log(`\n  Verification — new rows present (${rows.length}/8):`);
  for (const r of rows) {
    const brand = r.brand ? ` [${r.brand}]` : "";
    console.log(`    $${String(r.default_unit_price_ex_gst).padStart(7)}  ${r.name}${brand}`);
  }
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
