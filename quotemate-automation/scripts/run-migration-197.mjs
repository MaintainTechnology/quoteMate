// Safe-by-default runner for migration 197. No DB connection without --apply.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const rollback = process.argv.includes('--rollback')
const apply = process.argv.includes('--apply')
const file = rollback ? '197_down.sql' : '197_tenant_dev_sms_number.sql'
const sql = readFileSync(join(here, '..', 'sql', 'migrations', file), 'utf8')

if (!apply) {
  console.log(`DRY RUN — ${file} NOT applied. Re-run with --apply after review.\n`)
  console.log(sql)
  process.exit(0)
}

const url = process.env.SUPABASE_DB_URL
if (!url) throw new Error('SUPABASE_DB_URL missing')

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
})
await client.connect()
try {
  await client.query('begin')
  await client.query(sql)
  if (rollback) {
    const gone = await client.query(`
      select count(*)::int as col
      from information_schema.columns
      where table_schema = 'public' and table_name = 'tenants'
        and column_name = 'twilio_sms_number_dev'
    `)
    if (gone.rows[0]?.col !== 0) {
      throw new Error('Migration 197 rollback verification failed: column still present')
    }
    console.log('Verified tenants.twilio_sms_number_dev is gone')
  } else {
    const verified = await client.query(`
      select
        (select data_type from information_schema.columns
          where table_schema = 'public' and table_name = 'tenants'
            and column_name = 'twilio_sms_number_dev') as data_type,
        (select is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'tenants'
            and column_name = 'twilio_sms_number_dev') as is_nullable,
        (select count(*)::int from pg_indexes
          where schemaname = 'public'
            and indexname = 'tenants_twilio_sms_number_dev_idx') as idx
    `)
    const row = verified.rows[0]
    if (row?.data_type !== 'text' || row?.is_nullable !== 'YES' || row?.idx !== 1) {
      throw new Error(
        `Migration 197 verification failed: expected a nullable text column plus its index (got ${JSON.stringify(row)})`,
      )
    }
    console.log('Verified tenants.twilio_sms_number_dev', row)
  }
  await client.query('commit')
  console.log(`Applied and verified ${file}`)
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  await client.end()
}
