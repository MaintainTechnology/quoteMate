import { createHash } from 'node:crypto'

/** Scope snapshot shown by the measurement editor; approval is checked in SQL. */
export function roofMeasurementVersion(row: { quote: unknown; included_indices: unknown }): string {
  return createHash('sha256').update(JSON.stringify([row.quote, row.included_indices])).digest('hex')
}
