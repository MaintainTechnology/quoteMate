// CSV bulk-import for supplier_catalogue — shared parser + validator.
//
// Used by BOTH entry points so the format + validation rules live in
// exactly one place:
//   • POST /api/supplier-catalogue/import   — tradie self-serve upload.
//   • scripts/import-supplier-catalogue-csv.mjs — operator CLI.
//
// PURE: turns a raw CSV string into validated supplier_catalogue row
// objects + a per-row error list. NO database, NO HTTP — the two callers
// own auth + persistence (the upsert). Unit-tested in csv-import.test.ts.
//
// The column set mirrors the tradie-facing fields of supplier_catalogue
// (migration 041). System columns — id, properties, supplier_revision,
// retired_at, created_at/updated_at, and the migration-045 provenance
// pair — are deliberately NOT importable: the callers set those.

import { parse } from 'csv-parse/sync'
import { granularToGroundingCategory } from './category-mapping'

/** Importable columns, in canonical template order. The first five are
 *  required; the rest are optional. */
export const SUPPLIER_CSV_HEADER = [
  'trade',
  'category',
  'brand',
  'name',
  'default_unit_price_ex_gst',
  'range_series',
  'supplier_label',
  'default_unit',
  'tier_hint',
  'image_url',
  'description',
] as const

export type SupplierCsvColumn = (typeof SUPPLIER_CSV_HEADER)[number]

const REQUIRED_COLUMNS: SupplierCsvColumn[] = [
  'trade',
  'category',
  'brand',
  'name',
  'default_unit_price_ex_gst',
]

const VALID_TRADES = ['electrical', 'plumbing'] as const
const VALID_TIERS = ['good', 'better', 'best'] as const

/** Hard cap on a single upload — keeps the parse + per-row DB diff
 *  bounded. A real supplier price list is well under this. */
export const MAX_CSV_ROWS = 2000

/** A fully-validated row, ready to upsert into supplier_catalogue. */
export type SupplierCsvRow = {
  trade: string
  category: string
  brand: string
  range_series: string | null
  name: string
  supplier_label: string | null
  default_unit: string
  default_unit_price_ex_gst: number
  tier_hint: 'good' | 'better' | 'best' | null
  image_url: string | null
  description: string | null
  /** Stable key for de-duplication: matches the supplier_catalogue
   *  unique index `(trade, brand, lower(name))`. */
  dedupeKey: string
}

export type RowError = {
  /** 1-based CSV line number (header is line 1), or 0 for file-level errors. */
  line: number
  column: string
  message: string
}

export type ParseResult = {
  /** Valid rows only — every row here is safe to upsert. */
  rows: SupplierCsvRow[]
  /** Per-row + file-level validation failures. */
  errors: RowError[]
  /** Count of data rows seen (valid + invalid), excluding the header. */
  totalDataRows: number
}

function clean(v: unknown): string {
  if (v == null) return ''
  return typeof v === 'string' ? v.trim() : String(v).trim()
}

function emptyToNull(v: string): string | null {
  return v === '' ? null : v
}

export function dedupeKeyFor(trade: string, brand: string, name: string): string {
  return `${trade.toLowerCase()}|${brand.toLowerCase()}|${name.trim().toLowerCase()}`
}

/**
 * Parse + validate a raw CSV string into supplier_catalogue rows.
 *
 * @param csvText  Raw CSV (with header row). UTF-8 BOM tolerated.
 * @param opts.allowedTrades  When set, a row whose `trade` isn't in this
 *   list becomes a row error. The API passes the tenant's own trades so
 *   a tradie can't seed the shared library for a trade they don't run.
 *   Omitted by the operator CLI (operators may load any trade).
 */
export function parseSupplierCsv(
  csvText: string,
  opts: { allowedTrades?: readonly string[] } = {},
): ParseResult {
  const errors: RowError[] = []

  let header: string[] = []
  let records: Record<string, string>[]
  try {
    records = parse(csvText, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      columns: (h: string[]) => {
        header = h.map((c) => clean(c).toLowerCase())
        return header
      },
    }) as Record<string, string>[]
  } catch (e) {
    return {
      rows: [],
      errors: [
        {
          line: 0,
          column: '',
          message: `CSV could not be parsed: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
      totalDataRows: 0,
    }
  }

  // Header check — every required column must be present.
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c))
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          column: missing.join(', '),
          message: `Missing required column(s): ${missing.join(', ')}. Expected header: ${SUPPLIER_CSV_HEADER.join(',')}`,
        },
      ],
      totalDataRows: 0,
    }
  }

  if (records.length > MAX_CSV_ROWS) {
    return {
      rows: [],
      errors: [
        {
          line: 0,
          column: '',
          message: `Too many rows (${records.length}). The maximum per upload is ${MAX_CSV_ROWS}.`,
        },
      ],
      totalDataRows: records.length,
    }
  }

  const allowed = opts.allowedTrades?.map((t) => t.toLowerCase())
  const rows: SupplierCsvRow[] = []
  const seen = new Map<string, number>() // dedupeKey -> first line it appeared on

  records.forEach((rec, idx) => {
    const line = idx + 2 // +1 for 0-based index, +1 for the header row
    const rowErrors: RowError[] = []
    const add = (column: string, message: string) =>
      rowErrors.push({ line, column, message })

    const trade = clean(rec.trade).toLowerCase()
    if (!trade) {
      add('trade', 'trade is required')
    } else if (!(VALID_TRADES as readonly string[]).includes(trade)) {
      add('trade', `trade must be one of: ${VALID_TRADES.join(', ')}`)
    } else if (allowed && !allowed.includes(trade)) {
      add('trade', `you can only upload rows for your own trade(s): ${allowed.join(', ')}`)
    }

    const category = clean(rec.category).toLowerCase()
    if (!category) {
      add('category', 'category is required')
    } else if (granularToGroundingCategory(category) == null) {
      add(
        'category',
        `unknown category "${category}" — use a catalogue category such as ` +
          'gpo, downlight, tapware_basin, hws_gas, ceiling_fan, toilet',
      )
    }

    const brand = clean(rec.brand)
    if (!brand) add('brand', 'brand is required')
    else if (brand.length > 120) add('brand', 'brand is too long (max 120 chars)')

    const name = clean(rec.name)
    if (!name) add('name', 'name is required')
    else if (name.length > 200) add('name', 'name is too long (max 200 chars)')

    const priceRaw = clean(rec.default_unit_price_ex_gst).replace(/^\$/, '').replace(/,/g, '')
    const price = Number(priceRaw)
    if (!priceRaw) {
      add('default_unit_price_ex_gst', 'default_unit_price_ex_gst is required')
    } else if (!Number.isFinite(price)) {
      add('default_unit_price_ex_gst', `"${rec.default_unit_price_ex_gst}" is not a number`)
    } else if (price <= 0) {
      add('default_unit_price_ex_gst', 'price must be greater than 0')
    } else if (price > 1_000_000) {
      add('default_unit_price_ex_gst', 'price looks too large (max 1,000,000)')
    }

    const rangeSeries = clean(rec.range_series)
    if (rangeSeries.length > 120) add('range_series', 'range_series is too long (max 120 chars)')

    const supplierLabel = clean(rec.supplier_label)
    if (supplierLabel.length > 120) add('supplier_label', 'supplier_label is too long (max 120 chars)')

    const unit = clean(rec.default_unit) || 'each'
    if (unit.length > 40) add('default_unit', 'default_unit is too long (max 40 chars)')

    const tierRaw = clean(rec.tier_hint).toLowerCase()
    if (tierRaw && !(VALID_TIERS as readonly string[]).includes(tierRaw)) {
      add('tier_hint', `tier_hint must be blank or one of: ${VALID_TIERS.join(', ')}`)
    }

    const imageUrl = clean(rec.image_url)
    if (imageUrl) {
      if (imageUrl.length > 500) add('image_url', 'image_url is too long (max 500 chars)')
      else if (!/^https?:\/\//i.test(imageUrl))
        add('image_url', 'image_url must start with http:// or https://')
    }

    const description = clean(rec.description)
    if (description.length > 1000) add('description', 'description is too long (max 1000 chars)')

    // Duplicate-within-file guard — the same (trade, brand, name) twice in
    // one CSV would otherwise race the unique index on commit.
    let dupeReported = false
    if (trade && brand && name) {
      const key = dedupeKeyFor(trade, brand, name)
      const firstLine = seen.get(key)
      if (firstLine != null) {
        add('name', `duplicate of the row on line ${firstLine} (same trade + brand + name)`)
        dupeReported = true
      } else {
        seen.set(key, line)
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors)
      return
    }
    if (dupeReported) return

    rows.push({
      trade,
      category,
      brand,
      range_series: emptyToNull(rangeSeries),
      name,
      supplier_label: emptyToNull(supplierLabel),
      default_unit: unit,
      default_unit_price_ex_gst: Math.round(price * 100) / 100,
      tier_hint: (emptyToNull(tierRaw) as SupplierCsvRow['tier_hint']) ?? null,
      image_url: emptyToNull(imageUrl),
      description: emptyToNull(description),
      dedupeKey: dedupeKeyFor(trade, brand, name),
    })
  })

  return { rows, errors, totalDataRows: records.length }
}

/** The canonical template CSV body (header + two worked examples). Kept
 *  here so the operator CLI's `--template` flag and the static file in
 *  public/docs/ are generated from the same source of truth. */
export function supplierCsvTemplate(): string {
  const lines = [
    SUPPLIER_CSV_HEADER.join(','),
    'electrical,gpo,Clipsal,Clipsal Iconic double GPO 10A,25.00,Iconic,MM Electrical,each,better,https://example.com/clipsal-iconic-gpo.jpg,Modern flush-profile double power point',
    'plumbing,toilet,Caroma,Caroma Luna Cleanflush back-to-wall suite,389.00,Luna,Reece,each,good,https://example.com/caroma-luna.jpg,Back-to-wall suite with easy-clean rim',
  ]
  return lines.join('\r\n') + '\r\n'
}
