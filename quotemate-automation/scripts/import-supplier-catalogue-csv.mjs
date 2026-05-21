// QuoteMate · operator CSV import for the SHARED supplier_catalogue.
//
// Bulk-loads / refreshes the master "Browse supplier catalogue" library
// from a CSV — the operator-side counterpart to the tradie self-serve
// upload at POST /api/supplier-catalogue/import. Both share the parser
// + validation rules in lib/catalogue/csv-import.ts so the CSV format
// is identical.
//
// Usage (dry-run — validates + shows the new/update/error split):
//   node --env-file=.env.local --import tsx \
//     scripts/import-supplier-catalogue-csv.mjs path/to/products.csv
//
// Apply (writes to prod supplier_catalogue):
//   node --env-file=.env.local --import tsx \
//     scripts/import-supplier-catalogue-csv.mjs path/to/products.csv --apply
//
// Print a blank template to stdout:
//   node --import tsx scripts/import-supplier-catalogue-csv.mjs --template
//
// The `--import tsx` flag is required because this .mjs imports the
// TypeScript parser module (lib/catalogue/csv-import.ts) — tsx is already
// a devDependency. Operator imports land with source='admin' and
// created_by_tenant_id=NULL (the column defaults from migration 045).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { parseSupplierCsv, supplierCsvTemplate } from '../lib/catalogue/csv-import.ts'

const { Client } = pg

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const wantsTemplate = args.includes('--template')
const csvArg = args.find((a) => !a.startsWith('--'))

if (wantsTemplate) {
  process.stdout.write(supplierCsvTemplate())
  process.exit(0)
}

if (!csvArg) {
  console.error('Usage: import-supplier-catalogue-csv.mjs <file.csv> [--apply]')
  console.error('       import-supplier-catalogue-csv.mjs --template')
  process.exit(1)
}

const csvPath = resolve(process.cwd(), csvArg)
let csvText
try {
  csvText = readFileSync(csvPath, 'utf8')
} catch (e) {
  console.error(`Cannot read CSV: ${csvPath}\n  ${e.message ?? e}`)
  process.exit(1)
}

// ── Parse + validate ─────────────────────────────────────────────────
// allowedTrades omitted — operators may load any trade.
const { rows, errors, totalDataRows } = parseSupplierCsv(csvText)

console.log(`\nQuoteMate · supplier_catalogue CSV import`)
console.log(`  file        : ${csvPath}`)
console.log(`  data rows   : ${totalDataRows}`)
console.log(`  valid rows  : ${rows.length}`)
console.log(`  row errors  : ${errors.length}`)

if (errors.length > 0) {
  console.log('\nValidation errors:')
  for (const e of errors.slice(0, 50)) {
    console.log(`  line ${e.line}${e.column ? ` · ${e.column}` : ''} — ${e.message}`)
  }
  if (errors.length > 50) console.log(`  …and ${errors.length - 50} more`)
}

if (rows.length === 0) {
  console.error('\nNothing to import — fix the errors above and re-run.')
  process.exit(1)
}

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('\nMissing SUPABASE_DB_URL in .env.local')
  process.exit(1)
}

const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

try {
  await client.connect()

  // Fetch active library rows for the trades in this batch so we can
  // tell new inserts from updates. The seed library is small; a per-trade
  // scan is cheap. Key matches the supplier_catalogue unique index.
  const batchTrades = [...new Set(rows.map((r) => r.trade))]
  const { rows: existing } = await client.query(
    `select id, trade, brand, name, supplier_revision
       from supplier_catalogue
      where retired_at is null and trade = any($1::text[])`,
    [batchTrades],
  )
  const existingByKey = new Map()
  for (const e of existing) {
    existingByKey.set(`${e.trade.toLowerCase()}|${e.brand.toLowerCase()}|${e.name.trim().toLowerCase()}`, e)
  }

  const inserts = rows.filter((r) => !existingByKey.has(r.dedupeKey))
  const updates = rows.filter((r) => existingByKey.has(r.dedupeKey))

  console.log(`\nPlan:`)
  console.log(`  ${inserts.length} new product(s) to insert`)
  console.log(`  ${updates.length} existing product(s) to update (price/details refresh)`)

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.')
    process.exit(0)
  }

  await client.query('begin')
  let inserted = 0
  let updated = 0

  for (const r of inserts) {
    await client.query(
      `insert into supplier_catalogue
         (trade, category, brand, range_series, name, supplier_label,
          default_unit, default_unit_price_ex_gst, tier_hint, image_url,
          description, source, created_by_tenant_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'admin',null)`,
      [
        r.trade, r.category, r.brand, r.range_series, r.name, r.supplier_label,
        r.default_unit, r.default_unit_price_ex_gst, r.tier_hint, r.image_url,
        r.description,
      ],
    )
    inserted++
  }

  for (const r of updates) {
    const e = existingByKey.get(r.dedupeKey)
    await client.query(
      `update supplier_catalogue set
         category = $2, range_series = $3, supplier_label = $4,
         default_unit = $5, default_unit_price_ex_gst = $6, tier_hint = $7,
         image_url = $8, description = $9, supplier_revision = $10
       where id = $1`,
      [
        e.id, r.category, r.range_series, r.supplier_label, r.default_unit,
        r.default_unit_price_ex_gst, r.tier_hint, r.image_url, r.description,
        Number(e.supplier_revision) + 1,
      ],
    )
    updated++
  }

  await client.query('commit')
  console.log(`\nOK — imported. ${inserted} inserted, ${updated} updated.`)
} catch (err) {
  try {
    await client.query('rollback')
  } catch {
    // ignore rollback failure — the original error is what matters
  }
  console.error('\nImport failed (rolled back):', err.message ?? err)
  process.exit(1)
} finally {
  await client.end()
}
