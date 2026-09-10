import { createHash } from 'node:crypto'
/** Stable across JSONB key ordering; the browser reviews this exact saved estimate. */
export function paintingEditVersion(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical)
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : entry
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
