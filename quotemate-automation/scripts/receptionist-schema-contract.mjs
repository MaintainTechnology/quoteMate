import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

export const REQUIRED_RECEPTIONIST_MIGRATIONS = [198,199,200,201,202,204,205,207,210,211,212,213,214,215,217,218,219,220,221]
export const RECEPTIONIST_SCHEMA_FILES = [
  'sql/migrations/198_sms_durable_work.sql',
  'sql/migrations/199_sms_delivery_outbox.sql',
  'sql/migrations/200_frontdesk_durable_inbox.sql',
  'sql/migrations/201_sms_trade_quote_contract.sql',
  'sql/migrations/202_job_quote_operations.sql',
  'sql/migrations/204_sms_owned_quote_revisions.sql',
  'sql/migrations/205_generic_quote_customer_release.sql',
  'sql/migrations/207_quote_pricing_versions.sql',
  'sql/migrations/210_sms_plan_work.sql',
  'sql/migrations/211_commercial_quote_release_guard.sql',
  'sql/migrations/212_plan_quote_release_guard.sql',
  'sql/migrations/213_prepare_balance_quote.sql',
  'sql/migrations/214_prepare_final_quote.sql',
  'sql/migrations/215_generic_release_snapshot.sql',
  'sql/migrations/217_final_quote_credit_settlement.sql',
  'sql/migrations/218_sms_quote_chain_readiness.sql',
  'sql/migrations/219_commercial_paint_pricing_proof.sql',
  'sql/migrations/220_followup_operations.sql',
  'sql/migrations/221_commercial_paint_correction_operations.sql',
]

export function receptionistSchemaHashes(platform) {
  return Object.fromEntries(RECEPTIONIST_SCHEMA_FILES.map(file => [file,
    createHash('sha256').update(readFileSync(join(platform,file))).digest('hex')]))
}

export function verifyReceptionistSchemaHashes(hashes,platform) {
  assert.ok(hashes,'No required schema hashes')
  for (const [file,expected] of Object.entries(receptionistSchemaHashes(platform))) {
    assert.equal(hashes[file],expected,`Required schema changed or omitted: ${file}; rebuild the candidate`)
  }
}
