// QuoteMate · WP2 + WP3 demo seed (Option A)
//
// Loads a realistic operator catalogue (WP2: tenant_material_catalogue —
// Clipsal Iconic vs 2000, etc.) and a sample structured bill of materials
// (WP3: shared_assembly_bom) so you can SEE WP2/WP3 working end-to-end via
// SMS + the /q/<token> quote page — without hand-writing SQL.
//
// SAFE BY DESIGN:
//   • Targets ONLY the "Pilot Sparky" test tenant. If that tenant is not
//     found it ABORTS — it never guesses / writes to a real customer tenant.
//   • Dry-run by default (prints the plan, no writes). --apply to write.
//   • Idempotent: catalogue uses upsert; BOM uses ON CONFLICT DO NOTHING.
//   • Fully reversible: --undo removes exactly what this script added.
//
// Usage:
//   node --env-file=.env.local scripts/seed-wp2-demo.mjs            # dry run
//   node --env-file=.env.local scripts/seed-wp2-demo.mjs --apply    # seed
//   node --env-file=.env.local scripts/seed-wp2-demo.mjs --undo --apply  # remove

import pg from "pg";

const { Client } = pg;
const APPLY = process.argv.includes("--apply");
const UNDO = process.argv.includes("--undo");

// Demo catalogue (WP2). category aligns with the grounding validator's
// tags so these ground exactly like shared rows.
const CATALOGUE = [
  { category: "gpo", name: "Clipsal Iconic GPO", brand: "Clipsal", range_series: "Iconic", unit_price_ex_gst: 42, tier_hint: "better" },
  { category: "gpo", name: "Clipsal 2000 GPO", brand: "Clipsal", range_series: "2000", unit_price_ex_gst: 18, tier_hint: "good" },
  { category: "downlight", name: "Brightgreen D900 downlight", brand: "Brightgreen", range_series: "D900", unit_price_ex_gst: 58, tier_hint: "best" },
  { category: "downlight", name: "HPM DLI tri-colour downlight", brand: "HPM", range_series: "DLI", unit_price_ex_gst: 22, tier_hint: "good" },
];

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}
const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();

  // 1. Resolve the Pilot Sparky test tenant — abort if absent.
  const { rows: tRows } = await client.query(
    `select id, business_name, trade from tenants
       where status = 'active' and business_name ilike '%pilot sparky%'
       order by created_at asc limit 1`,
  );
  if (tRows.length === 0) {
    console.error("ABORT — no active tenant matching 'Pilot Sparky'. Refusing to seed a real customer tenant.");
    process.exit(1);
  }
  const tenant = tRows[0];
  const tenantId = tenant.id;

  // 2. Resolve a shared electrical downlight assembly for the WP3 BOM.
  const { rows: aRows } = await client.query(
    `select id, name from shared_assemblies
       where trade = 'electrical' and name ilike '%downlight%'
       order by name asc limit 1`,
  );
  const assembly = aRows[0] ?? null;

  console.log(`\nTarget tenant : ${tenant.business_name} (${tenant.trade})  ${tenantId}`);
  console.log(`WP3 assembly  : ${assembly ? `${assembly.name} (${assembly.id})` : "(none found — WP3 BOM will be skipped)"}`);
  console.log(`Mode          : ${UNDO ? "UNDO" : "SEED"} · ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);

  if (UNDO) {
    console.log("\nWould remove:");
    console.log(`  • tenant_material_catalogue rows for tenant ${tenantId} with name in [${CATALOGUE.map((c) => c.name).join(", ")}]`);
    if (assembly) console.log(`  • shared_assembly_bom rows for assembly ${assembly.id} (downlight, sundry)`);
    if (APPLY) {
      await client.query(
        `delete from tenant_material_catalogue where tenant_id = $1 and name = any($2)`,
        [tenantId, CATALOGUE.map((c) => c.name)],
      );
      if (assembly) {
        await client.query(
          `delete from shared_assembly_bom where assembly_id = $1 and material_category in ('downlight','sundry')`,
          [assembly.id],
        );
      }
      console.log("\nOK — demo data removed.");
    } else {
      console.log("\nDRY RUN — nothing removed. Add --apply to undo for real.");
    }
    process.exit(0);
  }

  // 3. WP2 catalogue (idempotent upsert on the migration-028 unique index).
  console.log("\nWP2 — tenant_material_catalogue:");
  for (const c of CATALOGUE) {
    console.log(`  • ${c.name}  $${c.unit_price_ex_gst}  [${c.category} · ${c.brand} ${c.range_series} · ${c.tier_hint}]`);
    if (APPLY) {
      await client.query(
        `insert into tenant_material_catalogue
           (tenant_id, trade, category, name, brand, range_series, unit_price_ex_gst, tier_hint, active)
         values ($1,'electrical',$2,$3,$4,$5,$6,$7,true)
         on conflict (tenant_id, trade, lower(name))
         do update set category = excluded.category, brand = excluded.brand,
           range_series = excluded.range_series, unit_price_ex_gst = excluded.unit_price_ex_gst,
           tier_hint = excluded.tier_hint, active = true`,
        [tenantId, c.category, c.name, c.brand, c.range_series, c.unit_price_ex_gst, c.tier_hint],
      );
    }
  }

  // 4. WP3 BOM (non-destructive — ON CONFLICT DO NOTHING).
  if (assembly) {
    console.log(`\nWP3 — shared_assembly_bom for "${assembly.name}":`);
    const bom = [
      { material_category: "downlight", quantity: 6, required: true, sort: 1 },
      { material_category: "sundry", quantity: 1, required: true, sort: 2 },
    ];
    for (const b of bom) {
      console.log(`  • ${b.quantity} x ${b.material_category}${b.required ? "" : " (optional)"}`);
      if (APPLY) {
        await client.query(
          `insert into shared_assembly_bom
             (assembly_id, trade, material_category, quantity, required, sort)
           values ($1,'electrical',$2,$3,$4,$5)
           on conflict (assembly_id, lower(material_category), lower(coalesce(description,'')))
           do nothing`,
          [assembly.id, b.material_category, b.quantity, b.required, b.sort],
        );
      }
    }
  }

  if (APPLY) {
    console.log("\nOK — demo data seeded. To SEE it working:");
    console.log("  1. Text the Pilot Sparky QuoteMate number: \"4 new double power points in the kitchen\"");
    console.log("     → quote should price Clipsal (Good=2000 $18, Better=Iconic $42), NOT a $99 inspection.");
    console.log("  2. Text: \"6 downlights in the lounge\" (wait ~90s between tests)");
    console.log("     → same parts list every time (6 downlight + 1 sundry).");
    console.log("  3. Open the /q/<token> link from each quote SMS to see the line items.");
    console.log("\nUndo any time: node --env-file=.env.local scripts/seed-wp2-demo.mjs --undo --apply");
  } else {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to seed.");
  }
} catch (err) {
  console.error("Seed failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
