// QuoteMate · run migration 044 (v8 Phase A — early-booking discount).
// Usage:  node --env-file=.env.local scripts/run-migration-044.mjs
//
// Money-path-adjacent: the early-booking discount is applied at the
// booking choke-point (POST /api/q/[token]/book) and re-issues a
// discounted Stripe Session. This migration only adds the four `quotes`
// columns that carry the offer + realised discount; the OFFER config
// lives in pricing_book.overlays.early_bird (no schema change). Empty /
// unconfigured = no change to existing behaviour.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const { Client } = pg
const here = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(here, '..', 'sql', 'migrations', '044_early_bird_discount.sql')

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL in .env.local')
  process.exit(1)
}

const EXPECTED_COLS = [
  ['early_bird_discount_pct', 'numeric'],
  ['early_bird_expires_at', 'timestamp with time zone'],
  ['applied_discount_pct', 'numeric'],
  ['applied_discount_at', 'timestamp with time zone'],
]

const sql = readFileSync(sqlPath, 'utf8')
const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

try {
  await client.connect()
  console.log(`→ Running 044_early_bird_discount.sql (${sql.length.toLocaleString()} chars)...`)
  await client.query(sql)
  console.log('OK migration applied')

  let bad = 0
  for (const [col, type] of EXPECTED_COLS) {
    const { rows } = await client.query(
      `select data_type from information_schema.columns
         where table_name = 'quotes' and column_name = $1`,
      [col],
    )
    if (rows.length === 0) {
      console.error(`  ✗ MISSING COLUMN: ${col}`)
      bad++
    } else if (!String(rows[0].data_type).startsWith(type.split(' ')[0])) {
      console.error(`  ✗ ${col} type=${rows[0].data_type} expected ${type}`)
      bad++
    } else {
      console.log(`  ✓ ${col} (${rows[0].data_type})`)
    }
  }

  // applied_discount_pct must default to 0 and be NOT NULL — the display
  // + Stripe layers read it unconditionally and must never get null.
  const { rows: adp } = await client.query(
    `select is_nullable, column_default from information_schema.columns
       where table_name = 'quotes' and column_name = 'applied_discount_pct'`,
  )
  if (adp.length === 0 || adp[0].is_nullable !== 'NO') {
    console.error('  ✗ applied_discount_pct must be NOT NULL')
    bad++
  } else if (!/0/.test(String(adp[0].column_default ?? ''))) {
    console.error(`  ✗ applied_discount_pct default should be 0, got ${adp[0].column_default}`)
    bad++
  } else {
    console.log('  ✓ applied_discount_pct NOT NULL default 0')
  }

  // Both range CHECK constraints (0..15 — the margin cap) must exist.
  for (const conname of [
    'quotes_early_bird_discount_pct_range',
    'quotes_applied_discount_pct_range',
  ]) {
    const { rows } = await client.query(
      `select 1 from pg_constraint where conname = $1`,
      [conname],
    )
    if (rows.length === 0) {
      console.error(`  ✗ MISSING constraint: ${conname}`)
      bad++
    } else {
      console.log(`  ✓ constraint ${conname}`)
    }
  }

  if (bad > 0) {
    console.error(`\nFAIL — ${bad} problem(s).`)
    process.exit(1)
  }
  console.log('\nOK — migration 044 verified.')
} catch (err) {
  console.error('Migration failed:', err.message ?? err)
  process.exit(1)
} finally {
  await client.end()
}
