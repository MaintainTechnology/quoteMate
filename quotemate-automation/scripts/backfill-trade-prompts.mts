// QuoteMate · backfill trade_prompts (Phase 0 — admin bulk loader)
//
// Migration 048 created trade_prompts EMPTY because the prompt text lived in
// TypeScript and had to migrate string-identical (a SQL seed cannot
// reproduce ~16 KB of prompt with embedded markup arithmetic). This script
// copies the bundled prompt-pack templates into the electrical + plumbing
// rows. Idempotent upsert; verifies every stored column round-trips
// byte-identical to its source constant.
//
// Run: npx tsx scripts/backfill-trade-prompts.mts
// (.mts so tsx loads it as ESM — the script uses top-level await.)
//
// SAFE: the estimator/SMS/Voice routers fall back to the bundled templates
// when a trade_prompts row is absent, so running — or not running — this
// script never changes behaviour for electrical/plumbing. It only activates
// the DB-driven path and makes the rows visible to the future admin UI.

import process from 'node:process'
import pg from 'pg'
import { ELECTRICAL_ESTIMATOR_TEMPLATE } from '../lib/estimate/prompt-templates/electrical-estimator'
import { PLUMBING_ESTIMATOR_TEMPLATE } from '../lib/estimate/prompt-templates/plumbing-estimator'

if (!process.env.SUPABASE_DB_URL) {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    /* fall through to the explicit check below */
  }
}

const { Client } = pg

// Per-trade prompt pack. Only the columns present here are written; missing
// columns are left untouched (the SMS/Voice columns are filled as those
// refactors land). Keys MUST be real trade_prompts columns.
const PROMPT_PACKS: Record<string, Record<string, string>> = {
  electrical: { estimator_system_prompt: ELECTRICAL_ESTIMATOR_TEMPLATE },
  plumbing: { estimator_system_prompt: PLUMBING_ESTIMATOR_TEMPLATE },
}

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL (set it in .env.local)')
  process.exit(1)
}

const client = new Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
})

try {
  await client.connect()

  let failures = 0
  for (const [trade, pack] of Object.entries(PROMPT_PACKS)) {
    const { rows: tradeRows } = await client.query(
      'select id from trades where name = $1',
      [trade],
    )
    if (tradeRows.length === 0) {
      console.error(`  ✗ ${trade}: no trades row — run migration 046 first`)
      failures++
      continue
    }
    const tradeId = tradeRows[0].id as string

    const cols = Object.keys(pack)
    const values = cols.map((c) => pack[c])
    // Upsert: cols on INSERT, cols on UPDATE. $1 = trade_id, $2.. = values.
    const insertCols = ['trade_id', ...cols].join(', ')
    const insertParams = ['$1', ...cols.map((_, i) => `$${i + 2}`)].join(', ')
    const updateSet = [
      ...cols.map((c, i) => `${c} = $${i + 2}`),
      'updated_at = now()',
    ].join(', ')
    await client.query(
      `insert into trade_prompts (${insertCols}) values (${insertParams})
       on conflict (trade_id) do update set ${updateSet}`,
      [tradeId, ...values],
    )

    // Verify the stored text round-trips byte-identical.
    const { rows: stored } = await client.query(
      `select ${cols.join(', ')} from trade_prompts where trade_id = $1`,
      [tradeId],
    )
    let ok = true
    for (const c of cols) {
      if (stored[0][c] !== pack[c]) {
        console.error(`  ✗ ${trade}.${c}: stored text does NOT match source`)
        ok = false
        failures++
      }
    }
    if (ok) {
      console.log(
        `  ✓ ${trade}: ${cols.length} column(s) written + verified (${cols.join(', ')})`,
      )
    }
  }

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} backfill check(s) failed.`)
    process.exit(1)
  }
  console.log('\nOK — trade_prompts backfill verified.')
} catch (err) {
  console.error('Backfill failed:', err instanceof Error ? err.message : err)
  process.exit(1)
} finally {
  await client.end()
}
