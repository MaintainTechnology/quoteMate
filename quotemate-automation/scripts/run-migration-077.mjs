// QuoteMate · run migration 077
// (quality-agent findings tables: eval_runs, eval_run_items,
//  catalogue_findings, tradie_edit_patterns)
// Usage: node --env-file=.env.local scripts/run-migration-077.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const { Client } = pg
const here = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(here, '..', 'sql', 'migrations', '077_agent_findings_tables.sql')

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL')
  process.exit(1)
}

const sql = readFileSync(sqlPath, 'utf8')
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

async function tableExists(client, name) {
  const { rows } = await client.query(
    `select 1 from information_schema.tables
       where table_schema='public' and table_name=$1`,
    [name],
  )
  return rows.length > 0
}

async function rlsEnabled(client, name) {
  const { rows } = await client.query(
    `select relrowsecurity from pg_class
       where oid = ('public.' || $1)::regclass`,
    [name],
  )
  return rows[0]?.relrowsecurity === true
}

const expectedTables = [
  'eval_runs',
  'eval_run_items',
  'catalogue_findings',
  'tradie_edit_patterns',
]

try {
  await c.connect()

  console.log('─── pre-flight ──')
  for (const t of expectedTables) {
    const exists = await tableExists(c, t)
    console.log(`  before · ${t.padEnd(24)} ${exists ? 'present' : 'absent'}`)
  }

  console.log('\n─── executing migration 077 ──')
  await c.query(sql)
  console.log('  migration committed.')

  console.log('\n─── post-verify ──')
  let allOk = true
  for (const t of expectedTables) {
    const exists = await tableExists(c, t)
    const rls = exists ? await rlsEnabled(c, t) : false
    console.log(
      `  after  · ${t.padEnd(24)} ${exists ? '✓ present' : '✗ MISSING'}  ${rls ? '· RLS on' : '· RLS OFF (must be on)'}`,
    )
    if (!exists || !rls) allOk = false
  }
  if (!allOk) {
    console.error('\nABORTING: expected tables missing or RLS off.')
    process.exit(2)
  }

  console.log('\nMigration 077 complete.')
} catch (e) {
  console.error('MIGRATION FAILED:', e.message)
  process.exitCode = 1
} finally {
  await c.end()
}
