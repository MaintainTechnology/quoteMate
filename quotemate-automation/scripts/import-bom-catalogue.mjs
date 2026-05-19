// QuoteMate · WP3 structured bill-of-materials importer + validator
//
// The brief is explicit: "Sourcing the job list and building the
// software are different jobs — bad source data only makes wrong
// quotes happen more consistently. The engineering is the import plus
// a price sanity-check before the data goes live."
//
// THIS is that engineering. It does NOT invent a job catalogue — the
// validated standard-job/BOM list is a human input (John's researched
// + validated source). This tool makes loading that source SAFE:
//   • validates every row before anything is written
//   • resolves assembly names against shared_assemblies (trade-matched)
//   • dry-run by default — prints a full report, writes nothing
//   • --apply writes idempotently (ON CONFLICT DO NOTHING — never
//     destroys or overwrites existing BOM rows)
//
// Input JSON: an array of:
//   { "trade": "electrical", "assembly_name": "Install LED downlight",
//     "material_category": "downlight", "quantity": 6,
//     "required": true, "description": "", "sort": 1 }
//
// Usage:
//   node scripts/import-bom-catalogue.mjs --example          # write a template
//   node --env-file=.env.local scripts/import-bom-catalogue.mjs --file=<path>           # dry run
//   node --env-file=.env.local scripts/import-bom-catalogue.mjs --file=<path> --apply   # load it

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const EXAMPLE = args.includes("--example");
const fileArg = args.find((a) => a.startsWith("--file="));

const TRADES = new Set(["electrical", "plumbing"]);

if (EXAMPLE) {
  const examplePath = join(here, "example-bom-catalogue.json");
  const example = [
    { trade: "electrical", assembly_name: "Install LED downlight", material_category: "downlight", quantity: 6, required: true, sort: 1 },
    { trade: "electrical", assembly_name: "Install LED downlight", material_category: "sundry", quantity: 1, required: true, sort: 2 },
    { trade: "plumbing", assembly_name: "Replace kitchen mixer tap", material_category: "tap", quantity: 1, required: true, sort: 1 },
  ];
  writeFileSync(examplePath, JSON.stringify(example, null, 2));
  console.log(
    `Wrote TEMPLATE (not a validated catalogue): ${examplePath}\n` +
      "Replace its contents with John's validated job/BOM list, then run:\n" +
      "  node --env-file=.env.local scripts/import-bom-catalogue.mjs --file=scripts/example-bom-catalogue.json",
  );
  process.exit(0);
}

if (!fileArg) {
  console.error("Missing --file=<path> (or use --example to get a template).");
  process.exit(1);
}
const filePath = fileArg.slice("--file=".length);

let raw;
try {
  raw = JSON.parse(readFileSync(filePath, "utf8"));
} catch (e) {
  console.error(`Could not read/parse ${filePath}: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(raw)) {
  console.error("Input must be a JSON array of BOM rows.");
  process.exit(1);
}

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local (needed to resolve assembly names).");
  process.exit(1);
}
const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();

  const errors = [];
  const valid = [];
  const seen = new Set();

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] ?? {};
    const where = `row ${i + 1}`;
    if (!TRADES.has(r.trade)) {
      errors.push(`${where}: bad trade "${r.trade}" (must be electrical|plumbing)`);
      continue;
    }
    if (!r.assembly_name || typeof r.assembly_name !== "string") {
      errors.push(`${where}: missing assembly_name`);
      continue;
    }
    if (!r.material_category || typeof r.material_category !== "string") {
      errors.push(`${where}: missing material_category`);
      continue;
    }
    const qty = Number(r.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`${where}: quantity must be a positive number (got "${r.quantity}")`);
      continue;
    }
    // Resolve the assembly (trade-matched, exact name first, else single ilike).
    const exact = await client.query(
      `select id from shared_assemblies where trade=$1 and lower(name)=lower($2) limit 2`,
      [r.trade, r.assembly_name],
    );
    let assemblyId = null;
    if (exact.rows.length === 1) assemblyId = exact.rows[0].id;
    else if (exact.rows.length === 0) {
      const like = await client.query(
        `select id, name from shared_assemblies where trade=$1 and name ilike $2 limit 3`,
        [r.trade, `%${r.assembly_name}%`],
      );
      if (like.rows.length === 1) assemblyId = like.rows[0].id;
      else if (like.rows.length === 0) {
        errors.push(`${where}: no shared_assemblies match for "${r.assembly_name}" (${r.trade})`);
        continue;
      } else {
        errors.push(`${where}: "${r.assembly_name}" is ambiguous — matches ${like.rows.length} assemblies. Use the exact name.`);
        continue;
      }
    } else {
      errors.push(`${where}: "${r.assembly_name}" matched 2+ exact rows — data integrity issue.`);
      continue;
    }

    const dedupeKey = `${assemblyId}|${r.material_category.toLowerCase()}|${(r.description ?? "").toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      errors.push(`${where}: duplicate of an earlier row (same assembly + category + description)`);
      continue;
    }
    seen.add(dedupeKey);
    valid.push({
      assemblyId,
      trade: r.trade,
      material_category: r.material_category,
      quantity: qty,
      required: r.required !== false,
      description: r.description ?? null,
      sort: Number.isFinite(Number(r.sort)) ? Number(r.sort) : 0,
    });
  }

  console.log(`\n── BOM import validation ──`);
  console.log(`  input rows : ${raw.length}`);
  console.log(`  valid      : ${valid.length}`);
  console.log(`  errors     : ${errors.length}`);
  for (const e of errors.slice(0, 50)) console.log(`   ✗ ${e}`);
  if (errors.length > 50) console.log(`   …(${errors.length - 50} more)`);

  if (errors.length > 0) {
    console.error(`\nABORT — fix the ${errors.length} error(s) above. Nothing written (validation is all-or-nothing on purpose: a partial BOM produces wrong quotes).`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — ${valid.length} rows validated OK, nothing written. Re-run with --apply to load.`);
    process.exit(0);
  }

  let inserted = 0;
  for (const v of valid) {
    const res = await client.query(
      `insert into shared_assembly_bom (assembly_id, trade, material_category, quantity, required, description, sort)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (assembly_id, lower(material_category), lower(coalesce(description,''))) do nothing`,
      [v.assemblyId, v.trade, v.material_category, v.quantity, v.required, v.description, v.sort],
    );
    inserted += res.rowCount ?? 0;
  }
  console.log(`\nOK — ${inserted} new BOM row(s) inserted (${valid.length - inserted} already existed, left untouched).`);
} catch (err) {
  console.error("Import failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}
