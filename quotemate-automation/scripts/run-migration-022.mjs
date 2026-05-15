// QuoteMate · run migration 022 (tenant material preferences)
// Usage:  node --env-file=.env.local scripts/run-migration-022.mjs

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
  "022_tenant_material_preferences.sql",
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
    `\n→ Running 022_tenant_material_preferences.sql (${sql.length.toLocaleString()} chars)...`,
  );
  await client.query(sql);
  console.log("OK migration applied");

  // Verify the column exists and backfills landed.
  const { rows: catRows } = await client.query(
    `select trade, category, count(*)::int as sku_count, count(distinct brand)::int as brand_count
       from shared_materials
       where category is not null
       group by trade, category
       order by trade, category`,
  );

  console.log(
    `\n  Verification — categories populated (${catRows.length} rows):`,
  );
  for (const r of catRows) {
    console.log(
      `    ${r.trade.padEnd(11)} ${r.category.padEnd(20)} ${String(r.sku_count).padStart(2)} SKUs · ${r.brand_count} brand(s)`,
    );
  }

  // Verify the preferences table is present and empty (no prefs yet).
  const { rows: prefCount } = await client.query(
    `select count(*)::int as n from tenant_material_preferences`,
  );
  console.log(
    `\n  tenant_material_preferences table created. Current rows: ${prefCount[0].n}`,
  );

  // Sanity: any rows with category but null brand (won't appear in dropdown).
  const { rows: noBrand } = await client.query(
    `select trade, category, count(*)::int as n
       from shared_materials
       where category is not null and brand is null
       group by trade, category
       order by trade, category`,
  );
  if (noBrand.length > 0) {
    console.log(`\n  Note: ${noBrand.length} category/trade combos have SKUs with null brand —`);
    console.log(`  these won't render in the Preferred Brands dropdown until brands are added:`);
    for (const r of noBrand) {
      console.log(`    ${r.trade.padEnd(11)} ${r.category.padEnd(20)} ${r.n} null-brand SKU(s)`);
    }
  }
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
