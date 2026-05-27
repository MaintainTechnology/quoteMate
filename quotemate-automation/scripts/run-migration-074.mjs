// QuoteMate · run migration 074 (Phase 2 price-bands recipes)
// Usage:  node --env-file=.env.local scripts/run-migration-074.mjs
//
// Pre-flight: confirms the "Replace double GPO" row exists (target of
// the price_recipe seed) and snapshots whether the new IDs already exist
// (idempotent re-run support).
// Post-verify: confirms the price_recipe column exists, the two new
// assemblies + one new material are present, the seed JSON is well-
// formed, and a sample slot vector produces sensible line items via the
// pure module. No estimator wiring is exercised yet — Phase 3 work.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "074_price_recipes_phase_2.sql");

const TPS_CABLE_ID = "7c2a4561-8b9d-4e1c-a3f4-b5d6e7f80250";
const GPO_20A_ID = "5b48eed9-3f37-4d1c-a3e2-d4afae0a5e20";
const GPO_3PHASE_ID = "5b48eed9-3f37-4d1c-a3e2-d4afae0a5e32";

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();

  // ── PRE-FLIGHT ─────────────────────────────────────────────────
  console.log("\nPre-flight checks:");
  const { rows: targetRow } = await c.query(
    `select id, name, trade from shared_assemblies
       where name = 'Replace double GPO' and trade = 'electrical'`,
  );
  if (targetRow.length === 0) {
    console.error("PRE-FLIGHT FAIL: 'Replace double GPO' (electrical) not found.");
    process.exit(1);
  }
  console.log(`  OK target row exists: ${targetRow[0].id}`);

  const { rows: colsBefore } = await c.query(
    `select column_name from information_schema.columns
       where table_name = 'shared_assemblies' and column_name = 'price_recipe'`,
  );
  console.log(`  price_recipe column exists pre-apply: ${colsBefore.length > 0}`);

  const { rows: existingNewRows } = await c.query(
    `select id, name from shared_assemblies where id = any($1::uuid[])`,
    [[GPO_20A_ID, GPO_3PHASE_ID]],
  );
  console.log(`  new assembly rows pre-apply: ${existingNewRows.length}/2`);

  const { rows: existingNewMat } = await c.query(
    `select id, name from shared_materials where id = $1::uuid`,
    [TPS_CABLE_ID],
  );
  console.log(`  TPS cable material pre-apply: ${existingNewMat.length}/1`);

  // ── APPLY ──────────────────────────────────────────────────────
  console.log(`\n-> Applying 074_price_recipes_phase_2.sql (${sql.length.toLocaleString()} chars)...`);
  await c.query(sql);
  console.log("OK migration applied");

  // ── POST-VERIFY ────────────────────────────────────────────────
  console.log("\nPost-verify:");

  const { rows: colsAfter } = await c.query(
    `select column_name, data_type from information_schema.columns
       where table_name = 'shared_assemblies' and column_name = 'price_recipe'`,
  );
  if (colsAfter.length === 0 || colsAfter[0].data_type !== "jsonb") {
    console.error("POST-VERIFY FAIL: shared_assemblies.price_recipe (jsonb) missing");
    process.exit(1);
  }
  console.log(`  OK shared_assemblies.price_recipe (jsonb)`);

  const { rows: tenantCols } = await c.query(
    `select column_name from information_schema.columns
       where table_name = 'tenant_custom_assemblies' and column_name = 'price_recipe'`,
  );
  if (tenantCols.length === 0) {
    console.error("POST-VERIFY FAIL: tenant_custom_assemblies.price_recipe missing");
    process.exit(1);
  }
  console.log(`  OK tenant_custom_assemblies.price_recipe`);

  const { rows: newRows } = await c.query(
    `select id, name, default_unit_price_ex_gst, default_labour_hours, category
       from shared_assemblies where id = any($1::uuid[]) order by name`,
    [[GPO_20A_ID, GPO_3PHASE_ID]],
  );
  if (newRows.length !== 2) {
    console.error(`POST-VERIFY FAIL: expected 2 new assembly rows, got ${newRows.length}`);
    process.exit(1);
  }
  for (const r of newRows) {
    console.log(`  OK ${r.name} ($${r.default_unit_price_ex_gst} sundries, ${r.default_labour_hours}hr, cat=${r.category})`);
  }

  const { rows: matRow } = await c.query(
    `select id, name, default_unit_price_ex_gst, unit, category
       from shared_materials where id = $1::uuid`,
    [TPS_CABLE_ID],
  );
  if (matRow.length !== 1) {
    console.error("POST-VERIFY FAIL: TPS cable material missing");
    process.exit(1);
  }
  console.log(
    `  OK material: ${matRow[0].name} @ $${matRow[0].default_unit_price_ex_gst}/${matRow[0].unit} (cat=${matRow[0].category})`,
  );

  const { rows: recipeRow } = await c.query(
    `select id, price_recipe from shared_assemblies
       where name = 'Replace double GPO' and trade = 'electrical'`,
  );
  const recipe = recipeRow[0].price_recipe;
  if (!Array.isArray(recipe) || recipe.length !== 2) {
    console.error("POST-VERIFY FAIL: price_recipe missing or wrong shape on Replace double GPO");
    console.error("  got:", JSON.stringify(recipe));
    process.exit(1);
  }
  console.log(`  OK price_recipe seeded (${recipe.length} questions):`);
  for (const q of recipe) {
    console.log(`    • ${q.id} (${q.variant}, ${q.bands.length} bands)`);
  }

  // ── END-TO-END SMOKE TEST ──────────────────────────────────────
  // Feed the seeded recipe through the pure module to confirm it
  // interprets cleanly for the worked example (8m + 10A → 2 extra lines).
  console.log("\nEnd-to-end smoke test (applyPriceBands on seeded recipe):");
  const { applyPriceBands } = await import("../lib/estimate/price-bands.ts");
  const sample = applyPriceBands(
    recipe,
    { distance_to_existing_power: 8, circuit_required: "10A" },
    { hourly_rate: 118, default_markup_pct: 36 },
  );
  console.log(`  extra_line_items: ${sample.extra_line_items.length}`);
  for (const li of sample.extra_line_items) {
    console.log(`    • ${li.description}`);
    console.log(`      ${li.quantity} × ${li.unit} @ $${li.unit_price_ex_gst} | source=${li.source}`);
  }
  console.log(`  risk_flags: ${JSON.stringify(sample.risk_flags)}`);
  console.log(`  assembly_override_id: ${sample.assembly_override_id ?? "(none)"}`);
  console.log(`  defaults_used: [${sample.defaults_used.join(", ")}]`);

  if (sample.extra_line_items.length !== 2) {
    console.error(
      `POST-VERIFY FAIL: expected 2 extra line items for 8m + 10A, got ${sample.extra_line_items.length}`,
    );
    process.exit(1);
  }
  // Cable raw $5 × 1.36 = $6.80 — verify markup applied correctly.
  const cable = sample.extra_line_items.find((li) => li.unit === "lm");
  if (!cable || cable.unit_price_ex_gst !== 6.8) {
    console.error(
      `POST-VERIFY FAIL: cable price mismatch — expected $6.80 (raw 5 × 1.36), got $${cable?.unit_price_ex_gst}`,
    );
    process.exit(1);
  }
  console.log(`  OK markup correctly applied: TPS cable raw $5 × 1.36 = $6.80`);

  // Second smoke: 20A circuit → assembly override should fire.
  const sample20A = applyPriceBands(
    recipe,
    { distance_to_existing_power: 2, circuit_required: "20A" },
    { hourly_rate: 118, default_markup_pct: 36 },
  );
  if (sample20A.assembly_override_id !== GPO_20A_ID) {
    console.error(
      `POST-VERIFY FAIL: 20A select didn't swap to the 20A assembly. Got: ${sample20A.assembly_override_id}`,
    );
    process.exit(1);
  }
  console.log(`  OK 20A circuit select → assembly_override_id = ${GPO_20A_ID}`);

  console.log("\nOK migration 074 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}
