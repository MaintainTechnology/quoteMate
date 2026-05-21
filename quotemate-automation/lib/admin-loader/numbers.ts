// Numeric-cell parsing for the admin bulk loader CSVs (spec §7).
//
// "Number parsing strips currency symbols + thousand separators
// ($1,050.00 -> 1050.00), '.' decimal only, anything else is a
// row-validation error."
//
// A blank cell parses to null — the per-CSV row validator decides whether a
// null is allowed for that column (service_fee is required, etc.).

export type CsvNumberResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string }

export function parseCsvNumber(raw: string | null | undefined): CsvNumberResult {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return { ok: true, value: null }

  // Strip the AU currency symbol and thousand-separator commas. After this
  // the cell must be a plain decimal — '.' is the only decimal point.
  const stripped = trimmed.replace(/\$/g, '').replace(/,/g, '').trim()

  if (stripped === '' || !/^-?\d+(\.\d+)?$/.test(stripped)) {
    return { ok: false, error: `"${trimmed}" is not a valid number` }
  }

  const value = Number(stripped)
  if (!Number.isFinite(value)) {
    return { ok: false, error: `"${trimmed}" is not a finite number` }
  }
  return { ok: true, value }
}

// Boolean-cell parsing for the admin loader CSVs. Lenient on the common
// spellings; a blank cell is false. An unrecognised value is an error so a
// typo can't silently disable/enable a service.
export type CsvBooleanResult =
  | { ok: true; value: boolean }
  | { ok: false; error: string }

const TRUE_TOKENS = new Set(['true', 'yes', 'y', '1'])
const FALSE_TOKENS = new Set(['false', 'no', 'n', '0', ''])

export function parseCsvBoolean(raw: string | null | undefined): CsvBooleanResult {
  const token = (raw ?? '').trim().toLowerCase()
  if (TRUE_TOKENS.has(token)) return { ok: true, value: true }
  if (FALSE_TOKENS.has(token)) return { ok: true, value: false }
  return {
    ok: false,
    error: `"${raw}" is not a valid yes/no value (use true/false)`,
  }
}
