// QuoteMate · run migration 045 (supplier_catalogue provenance).
// Usage:  node --env-file=.env.local scripts/run-migration-045.mjs
//
// Adds created_by_tenant_id + source to supplier_catalogue so CSV
// bulk-uploads (operator + tradie self-serve) are auditable. Not a
// money-path table — see 045_supplier_catalogue_provenance.sql header.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const { Client } = pg
const here = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(here, '..', 'sql', 'migrations', '045_supplier_catalogue_provenance.sql')

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL in .env.local')
  process.exit(1)
}

const EXPECTED_COLS = [
  ['created_by_tenant_id', 'uuid'],
  ['source', 'text'],
]

const sql = readFileSync(sqlPath, 'utf8')
const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

try {
  await client.connect()
  console.log(`→ Running 045_supplier_catalogue_provenance.sql (${sql.length.toLocaleString()} chars)...`)
  await client.query(sql)
  console.log('OK migration applied')

  let bad = 0
  for (const [col, type] of EXPECTED_COLS) {
    const { rows } = await client.query(
      `select data_type from information_schema.columns
         where table_name = 'supplier_catalogue' and column_name = $1`,
      [col],
    )
    if (rows.length === 0) {
      console.error(`  ✗ MISSING COLUMN: ${col}`)
      bad++
    } else if (!String(rows[0].data_type).startsWith(type)) {
      console.error(`  ✗ ${col} type=${rows[0].data_type} expected ${type}`)
      bad++
    } else {
      console.log(`  ✓ ${col} (${rows[0].data_type})`)
    }
  }

  // `source` must be NOT NULL default 'admin' — the import paths rely on
  // the default for operator rows that don't set it explicitly.
  const { rows: src } = await client.query(
    `select is_nullable, column_default from information_schema.columns
       where table_name = 'supplier_catalogue' and column_name = 'source'`,
  )
  if (src.length === 0 || src[0].is_nullable !== 'NO') {
    console.error('  ✗ source must be NOT NULL')
    bad++
  } else if (!/admin/.test(String(src[0].column_default ?? ''))) {
    console.error(`  ✗ source default should be 'admin', got ${src[0].column_default}`)
    bad++
  } else {
    console.log("  ✓ source NOT NULL default 'admin'")
  }

  const { rows: chk } = await client.query(
    `select 1 from pg_constraint where conname = 'supplier_catalogue_source_check'`,
  )
  if (chk.length === 0) {
    console.error('  ✗ MISSING constraint: supplier_catalogue_source_check')
    bad++
  } else {
    console.log('  ✓ constraint supplier_catalogue_source_check')
  }

  if (bad > 0) {
    console.error(`\nFAIL — ${bad} problem(s).`)
    process.exit(1)
  }
  console.log('\nOK — migration 045 verified.')
} catch (err) {
  console.error('Migration failed:', err.message ?? err)
  process.exit(1)
} finally {
  await client.end()
}
