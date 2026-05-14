// ═══════════════════════════════════════════════════════════════════
// QuoteMate · catalogue gap auditor
//
// Lists every shared_materials + shared_assemblies row by trade, then
// flags common AU residential variants that are MISSING but should
// be present so the auto-quote path doesn't false-escalate.
//
// Triggered by the stress test on 2026-05-14: hot water 250L gas
// storage forced an inspection because Opus generated a price the
// validator couldn't ground (catalogue only had 170L gas storage).
//
// Usage:
//   node --env-file=.env.local scripts/audit-catalogue-gaps.mjs
// ═══════════════════════════════════════════════════════════════════

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
await client.connect();

const { rows: materials } = await client.query(
  `select trade, name, brand, unit, default_unit_price_ex_gst
     from shared_materials
     order by trade, name`,
);
const { rows: assemblies } = await client.query(
  `select trade, name, description, default_unit, default_unit_price_ex_gst, default_labour_hours
     from shared_assemblies
     order by trade, name`,
);

// ─── Render current catalogue ────────────────────────────────────────
for (const trade of ["electrical", "plumbing"]) {
  console.log("\n" + "═".repeat(72));
  console.log(`TRADE: ${trade.toUpperCase()}`);
  console.log("═".repeat(72));

  console.log("\nMATERIALS:");
  const mats = materials.filter((m) => m.trade === trade);
  if (mats.length === 0) {
    console.log("  (none)");
  } else {
    for (const m of mats) {
      const brand = m.brand ? ` [${m.brand}]` : "";
      console.log(`  $${String(m.default_unit_price_ex_gst).padStart(7)}  ${m.name}${brand}`);
    }
  }

  console.log("\nASSEMBLIES:");
  const asms = assemblies.filter((a) => a.trade === trade);
  if (asms.length === 0) {
    console.log("  (none)");
  } else {
    for (const a of asms) {
      console.log(`  $${String(a.default_unit_price_ex_gst).padStart(7)}  ${String(a.default_labour_hours ?? "").padStart(4)}hr  ${a.name}`);
    }
  }
}

// ─── Identify gaps against expected AU residential variants ──────────
// This is a curated list of variants common enough in the AU market
// that absence in the catalogue would cause a false escalation when
// a customer asks for them. Add to this list as new patterns surface
// from real customer texts.
const expectedVariants = [
  // ───── Plumbing hot water (the priority gap found 2026-05-14) ─────
  { trade: "plumbing", nameLike: "Gas storage HWS 250L" },
  { trade: "plumbing", nameLike: "Gas storage HWS 315L" },
  { trade: "plumbing", nameLike: "Electric HWS 125L" },
  { trade: "plumbing", nameLike: "Electric HWS 400L" },
  { trade: "plumbing", nameLike: "Heat pump HWS 315L" },
  // ───── Plumbing tapware - additional common variants ─────
  { trade: "plumbing", nameLike: "Laundry tap" },
  { trade: "plumbing", nameLike: "Outdoor garden tap" },
  // ───── Plumbing toilet variants ─────
  { trade: "plumbing", nameLike: "Smart toilet" },
];

console.log("\n" + "═".repeat(72));
console.log("EXPECTED VARIANTS — gap report");
console.log("═".repeat(72));

const found = new Set();
let gapCount = 0;
for (const exp of expectedVariants) {
  const hit = materials.find(
    (m) => m.trade === exp.trade && m.name.toLowerCase().includes(exp.nameLike.toLowerCase()),
  );
  const status = hit ? `✓ HAVE   $${hit.default_unit_price_ex_gst} ${hit.name}` : `✗ GAP`;
  console.log(`  ${exp.trade.padEnd(11)}  ${exp.nameLike.padEnd(30)}  ${status}`);
  if (!hit) gapCount++;
}

console.log("\n" + "─".repeat(72));
console.log(`SUMMARY  ${gapCount} of ${expectedVariants.length} expected variants are MISSING`);
console.log("─".repeat(72));

await client.end();
