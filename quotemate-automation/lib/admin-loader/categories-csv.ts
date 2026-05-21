// Categories CSV — structural + row validation for the admin bulk loader
// (spec §7.1). New-trade-only: defines a trade's category vocabulary in the
// `categories` table (migration 047), which the grounding validator and the
// Services CSV's category check both read.
//
// Same two-stage shape as services-csv / materials-csv. Pure row stage —
// the live trade + category sets are passed in, so it is unit-testable
// without a DB.
//
// NOT yet wired into batch.ts / the commit transaction: commit_import_batch
// (migration 052) only handles shared_assemblies + shared_materials. Adding
// a `categories` branch there is the next Phase 2 increment; this module is
// the validated foundation it will build on.

import { parseLoaderCsv, tradeNameKey, type LoaderCsvResult } from './csv'

// Exact template headers (spec §7.1). Maps to categories columns:
//   trade -> trades.name (resolved to trade_id at commit), name, grounding_tag
export const CATEGORIES_CSV_COLUMNS = [
  'trade',
  'name',
  'grounding_tag',
] as const

export const CATEGORIES_CSV_MAX_ROWS = 1000

// ── Structural stage (delegates to the shared parser) ─────────────────

export function parseCategoriesCsv(csvText: string): LoaderCsvResult {
  return parseLoaderCsv(
    csvText,
    CATEGORIES_CSV_COLUMNS,
    CATEGORIES_CSV_MAX_ROWS,
  )
}

// ── Row stage ─────────────────────────────────────────────────────────

export type CategoriesRowContext = {
  /** Trade names that exist in the `trades` registry. */
  knownTrades: ReadonlySet<string>
  /** tradeNameKey() of every existing categories row — drives NEW vs UPDATE. */
  existingCategoryKeys: ReadonlySet<string>
}

export type ParsedCategoryRow = {
  trade: string
  name: string
  grounding_tag: string
}

export type CategoriesRowResult =
  | { rowClass: 'REJECT'; errors: string[] }
  | { rowClass: 'NEW' | 'UPDATE'; parsed: ParsedCategoryRow }

/**
 * Validate one Categories-CSV record. `seenKeys` is the running intra-batch
 * (trade,name) set — mutated so a later identical row is rejected.
 */
export function validateCategoriesRow(
  rec: Record<string, string>,
  ctx: CategoriesRowContext,
  seenKeys: Set<string>,
): CategoriesRowResult {
  const errors: string[] = []

  const trade = (rec.trade ?? '').trim()
  const name = (rec.name ?? '').trim()
  const grounding_tag = (rec.grounding_tag ?? '').trim()

  if (trade === '') errors.push('trade is required.')
  else if (!ctx.knownTrades.has(trade)) {
    errors.push(`trade "${trade}" is not a registered trade.`)
  }
  if (name === '') errors.push('name is required.')

  let key: string | null = null
  if (trade !== '' && name !== '') {
    key = tradeNameKey(trade, name)
    if (seenKeys.has(key)) {
      errors.push(`duplicate (trade, name) within this upload: "${name}".`)
    } else {
      seenKeys.add(key)
    }
  }

  // grounding_tag is NOT NULL in the categories table. §14 — reconciling
  // the granular-vs-grounding vocabulary with lib/estimate/categories.ts is
  // a deliberately-deferred open item, so v1 only requires it non-empty.
  if (grounding_tag === '') errors.push('grounding_tag is required.')

  if (errors.length > 0) return { rowClass: 'REJECT', errors }

  const parsed: ParsedCategoryRow = { trade, name, grounding_tag }
  const rowClass =
    key !== null && ctx.existingCategoryKeys.has(key) ? 'UPDATE' : 'NEW'
  return { rowClass, parsed }
}
