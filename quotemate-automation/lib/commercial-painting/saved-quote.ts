import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/** A pricing pass has one intake and one quote even when its response is lost.
 * Public capability tokens remain random and are read from the winning row.
 */
export function commercialPaintSaveIdentity(tenantId: string, runId: string, extractionId: string, pricedAt: string) {
  const key = JSON.stringify(['commercial-paint-save-v1', tenantId.toLowerCase(), runId.toLowerCase(), extractionId.toLowerCase(), pricedAt])
  const uuid = (kind: string) => {
    const hex = createHash('sha256').update(`${kind}:${key}`).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  return { intakeId: uuid('intake'), quoteId: uuid('quote') }
}

export type SavedPaintQuote = { id: string; share_token: string; intake_id: string; pdf_path: string | null }
export class UnverifiablePaintQuote extends Error {}
/** PostgreSQL retains microseconds. Do not collapse distinct pricing passes
 * through Date.toISOString()'s millisecond precision. */
export function normalisePaintPricedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/)
  if (!match) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString().slice(0, 19) + '.' + (match[2] ?? '').padEnd(6, '0') + 'Z'
}
export type PaintSaveSource = { runId: string; extractionId: string; pricedAt: string; customerPhone?: string | null;
  customerName?: string | null; pricingProof?: string }

export async function readSavedPaintQuote(db: SupabaseClient, tenantId: string, quoteId: string, source: PaintSaveSource): Promise<SavedPaintQuote | null> {
  const { data, error } = await db.from('quotes').select('id,share_token,intake_id,pdf_path')
    .eq('tenant_id', tenantId).eq('id', quoteId).maybeSingle()
  if (error) throw new Error(`Saved tender lookup failed: ${error.code ?? 'database_error'}`)
  if (!data) return null
  if (!data.id || !data.share_token || !data.intake_id) throw new Error('Saved tender identity is incomplete')
  const { data: intake, error: intakeError } = await db.from('intakes').select('id,trade,scope,caller')
    .eq('tenant_id', tenantId).eq('id', data.intake_id).maybeSingle()
  if (intakeError) throw new Error('Saved tender source could not be read')
  const scope = intake?.scope as Record<string, unknown> | null | undefined
  if (!intake || intake.trade !== 'commercial_painting' ||
      String(scope?.paint_run_id ?? '').toLowerCase() !== source.runId.toLowerCase() ||
      String(scope?.extraction_id ?? '').toLowerCase() !== source.extractionId.toLowerCase() ||
      normalisePaintPricedAt(scope?.priced_at) !== normalisePaintPricedAt(source.pricedAt)) {
    throw new UnverifiablePaintQuote('The saved quote cannot be verified against this pricing pass; review the existing quote before saving again')
  }
  const caller = intake.caller as { phone?: unknown; name?: unknown } | null | undefined
  if (source.customerPhone !== undefined && (caller?.phone ?? '') !== (source.customerPhone ?? ''))
    throw new UnverifiablePaintQuote('This pricing pass is already saved for different customer details')
  if (source.customerName !== undefined && (caller?.name ?? '') !== (source.customerName ?? ''))
    throw new UnverifiablePaintQuote('This pricing pass is already saved for different customer details')
  if (source.pricingProof !== undefined && (scope?.paint_pricing_proof as { digest?: unknown } | null)?.digest !== source.pricingProof)
    throw new UnverifiablePaintQuote('The saved quote belongs to a different reviewed calculation')
  return data as SavedPaintQuote
}

/** Ignore conflicts, then read back ownership; a lost committed response can
 * recover, while a failed or unobservable save cannot produce a quote link.
 */
export async function persistPaintDraftRow(db: SupabaseClient, table: 'intakes' | 'quotes', payload: Record<string, unknown>) {
  let writeError: unknown
  try {
    const result = await db.from(table).upsert(payload, { onConflict: 'id', ignoreDuplicates: true })
    writeError = result.error
  } catch (error) { writeError = error }
  const { data, error } = await db.from(table).select('id').eq('id', payload.id)
    .eq('tenant_id', payload.tenant_id).maybeSingle()
  if (error || !data?.id) throw new Error(`${table} save could not be confirmed${writeError ? ' after a write failure' : ''}`)
}
