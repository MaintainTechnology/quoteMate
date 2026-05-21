// Materials CSV — structural + row validation for the admin bulk loader
// (spec §7.3). shared_materials is the estimator's generic fallback library,
// so this is a MONEY-PATH CSV: price_ex_gst must be a real positive number.
//
// Same two-stage shape as services-csv (structural then row). The structural
// stage is the shared parseLoaderCsv; the row stage is pure — the live
// trade/material sets are passed in, so it is unit-testable without a DB.

import { parseLoaderCsv, tradeNameKey, type LoaderCsvResult } from './csv'
import { parseCsvNumber } from './numbers'

// Exact template headers (spec §7.3). Maps to shared_materials columns:
//   trade, name, brand, unit, price_ex_gst -> default_unit_price_ex_gst
export const MATERIALS_CSV_COLUMNS = [
  'trade',
  'name',
  'brand',
  'unit',
  'price_ex_gst',
] as const

export const MATERIALS_CSV_MAX_ROWS = 1000

// ── Structural stage (delegates to the shared parser) ─────────────────

export function parseMaterialsCsv(csvText: string): LoaderCsvResult {
  return parseLoaderCsv(csvText, MATERIALS_CSV_COLUMNS, MATERIALS_CSV_MAX_ROWS)
}

// ── Row stage ─────────────────────────────────────────────────────────

export type MaterialsRowContext = {
  /** Trade names that exist in the `trades` registry. */
  knownTrades: ReadonlySet<string>
  /** tradeNameKey() of every existing shared_materials row — drives the
   *  NEW vs UPDATE classification. */
  existingMaterialKeys: ReadonlySet<string>
}

export type ParsedMaterialRow = {
  trade: string
  name: string
  brand: string | null
  unit: string
  default_unit_price_ex_gst: number
}

export type MaterialsRowResult =
  | { rowClass: 'REJECT'; errors: string[] }
  | { rowClass: 'NEW' | 'UPDATE'; parsed: ParsedMaterialRow }

/**
 * Validate one Materials-CSV record. `seenKeys` is the running intra-batch
 * (trade,name) set — mutated so a later identical row is rejected.
 */
export function validateMaterialsRow(
  rec: Record<string, string>,
  ctx: MaterialsRowContext,
  seenKeys: Set<string>,
): MaterialsRowResult {
  const errors: string[] = []

  const trade = (rec.trade ?? '').trim()
  const name = (rec.name ?? '').trim()

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

  const unit = (rec.unit ?? '').trim()
  if (unit === '') errors.push('unit is required.')

  // price_ex_gst — required, > 0. This is a money-path catalogue price.
  const price = parseCsvNumber(rec.price_ex_gst)
  let priceValue = 0
  if (!price.ok) errors.push(`price_ex_gst: ${price.error}.`)
  else if (price.value === null) errors.push('price_ex_gst is required.')
  else if (price.value <= 0) errors.push('price_ex_gst must be greater than 0.')
  else priceValue = price.value

  const brandRaw = (rec.brand ?? '').trim()

  if (errors.length > 0) return { rowClass: 'REJECT', errors }

  const parsed: ParsedMaterialRow = {
    trade,
    name,
    brand: brandRaw === '' ? null : brandRaw,
    unit,
    default_unit_price_ex_gst: priceValue,
  }
  const rowClass =
    key !== null && ctx.existingMaterialKeys.has(key) ? 'UPDATE' : 'NEW'
  return { rowClass, parsed }
}
