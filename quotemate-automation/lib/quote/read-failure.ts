import { randomUUID } from 'node:crypto'

/** No token, customer details or database message appears in public diagnostics. */
export function quoteReadFailure(family: string, error: unknown): string {
  const correlationId = randomUUID()
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'DEPENDENCY_FAILURE'
  console.error('[public-quote] unavailable', { correlationId, family, code })
  return correlationId
}
