import { createOwnerReleaseFixture } from './sms-owner-release-fixture.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addCommercialPricingSql } from './sms-commercial-pricing-fixture.mjs'

// Extend the unchanged owner adapter with physical rate columns and actual
// commercial pricing/proof/save SQL. The deterministic pricer stays real.
export async function createToolReleaseFixture(app, state, tenantId) {
  const fixture = await createOwnerReleaseFixture(app, state)
  await fixture.pg.exec(readFileSync(join(app,'sql/migrations/211_commercial_quote_release_guard.sql'),'utf8'))
  // The production quotes relation has these nullable review fields even
  // when the tool's insert omits them. SQL JSON containment distinguishes an
  // absent column from an existing NULL column; model that actual distinction.
  await fixture.pg.exec(`alter table quotes
    add column if not exists estimated_timeframe text,
    add column if not exists needs_inspection boolean,
    add column if not exists inspection_reason text,
    add column if not exists deposit_pct numeric default 30,
    add column if not exists display_mode text,
    add column if not exists applied_discount_pct numeric,
    add column if not exists quote_kind text;`)
  // Match sql/02_stages_06_10_partial.sql's actual quote-column default even
  // when the shared minimal schema already declared this column. Omitted tool
  // fields take the database default; never patch a created quote afterward.
  await fixture.pg.exec('alter table quotes alter column deposit_pct set default 30')
  try { return await addCommercialPricingSql(app, fixture, state, tenantId) }
  catch (error) { await fixture.close(); throw error }
}
