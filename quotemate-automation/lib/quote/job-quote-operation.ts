import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

const OperationSchema = z.object({
  tenant_id: z.string().uuid(), operation_id: z.string().uuid(), request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  intake_id: z.string().uuid(), quote_id: z.string().uuid().nullable(),
  status: z.enum(['processing', 'unknown', 'failed_no_commit', 'completed']),
  pinned: z.boolean(), pin_requested: z.boolean(), created_at: z.string(),
})
export type JobQuoteOperation = z.infer<typeof OperationSchema>
type JobInput = {
  job_type: string; address: string; suburb: string; answers: Record<string, string>;
  notes: string; customer_name: string; customer_mobile: string; customer_email: string;
  product_id?: string; product_name?: string; photo_paths?: string[]; photo_urls?: string[];
}

/** The parsed request is the pipeline input. Preserve exact option values; only
 * object key order and absent empty media differ. Signed URL rotation is not input. */
export function jobQuoteRequestHash(body: JobInput): string {
  const canonical = {
    version: 1, job_type: body.job_type, address: body.address, suburb: body.suburb,
    answers: Object.entries(body.answers).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    notes: body.notes, customer_name: body.customer_name, customer_mobile: body.customer_mobile,
    customer_email: body.customer_email, product_id: body.product_id ?? null,
    product_name: body.product_name ?? null, photo_paths: body.photo_paths ?? [],
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Only the authenticated upload route can mint this namespace in the private
 * bucket. Match its ENTIRE random path; never sign an arbitrary submitted path.
 * Client URLs are ignored, so neither vision nor a fetch follows client origins. */
export function validJobQuoteMedia(tenantId: string, body: Pick<JobInput, 'photo_paths' | 'photo_urls'>): boolean {
  if (!z.string().uuid().safeParse(tenantId).success) return false
  const paths = body.photo_paths ?? []
  const urls = body.photo_urls ?? []
  if (paths.length > 3 || new Set(paths).size !== paths.length) return false
  if (urls.length && urls.length !== paths.length) return false
  const pathPattern = new RegExp(`^jobquote-${tenantId}-[a-f0-9]{16}/[0-9]{13}-[0-2]-[a-f0-9]{8}\\.(jpg|png|webp)$`)
  return paths.every(path => pathPattern.test(path))
}

export async function claimJobQuoteOperation(db: SupabaseClient, tenantId: string, operationId: string, hash: string, pinRequested: boolean) {
  const { data, error } = await db.rpc('claim_job_quote_operation', {
    p_tenant_id: tenantId, p_operation_id: operationId, p_request_hash: hash, p_pin_requested: pinRequested,
  })
  if (error) throw new Error('Operation receipt could not be persisted')
  const receipt = z.object({ claimed: z.boolean(), operation: OperationSchema }).parse(data)
  if (receipt.operation.tenant_id !== tenantId || receipt.operation.operation_id !== operationId) {
    throw new Error('Operation receipt identity mismatch')
  }
  return receipt
}

export async function loadJobQuoteOperation(db: SupabaseClient, tenantId: string, operationId: string) {
  const { data, error } = await db.from('job_quote_operations').select('*')
    .eq('tenant_id', tenantId).eq('operation_id', operationId).maybeSingle()
  if (error) throw new Error('Operation receipt could not be read')
  if (!data) return null
  const operation = OperationSchema.parse(data)
  if (operation.tenant_id !== tenantId || operation.operation_id !== operationId) throw new Error('Operation identity mismatch')
  return operation
}

export async function updateJobQuoteOperation(db: SupabaseClient, operation: JobQuoteOperation,
  patch: { status?: JobQuoteOperation['status']; quote_id?: string; pinned?: boolean }) {
  const { data, error } = await db.from('job_quote_operations').update(patch)
    .eq('tenant_id', operation.tenant_id).eq('operation_id', operation.operation_id)
    .eq('request_hash', operation.request_hash).select('*').single()
  if (error || !data) throw new Error('Operation outcome could not be persisted')
  return OperationSchema.parse(data)
}

export type JobQuoteOperationView = {
  ok: true; operationId: string;
  status: 'processing' | 'unknown' | 'failed_no_commit' | 'quote_available' | 'completed';
  quoteId?: string; intakeId?: string; shareToken?: string | null; needsInspection?: boolean;
  pinned: boolean; pinRequested: boolean;
}

/** Readback never runs or re-enqueues work. A saved quote is distinct from a
 * finished pipeline; full completion requires the original response receipt or
 * the existing estimate worker's durable completed response for this intake. */
export async function readJobQuoteOperation(db: SupabaseClient, operation: JobQuoteOperation): Promise<JobQuoteOperationView> {
  const base = { ok: true as const, operationId: operation.operation_id, pinned: operation.pinned, pinRequested: operation.pin_requested }
  if (operation.status === 'failed_no_commit') return { ...base, status: 'failed_no_commit' }
  const { data: quotes, error } = await db.from('quotes')
    .select('id, intake_id, tenant_id, share_token, needs_inspection')
    .eq('tenant_id', operation.tenant_id).eq('intake_id', operation.intake_id)
    .is('parent_quote_id', null).limit(2)
  if (error) throw new Error('Saved quote could not be checked')
  const rows = z.array(z.object({ id: z.string().uuid(), intake_id: z.string().uuid(), tenant_id: z.string().uuid(),
    share_token: z.string().nullable(), needs_inspection: z.boolean().nullable() })).parse(quotes)
  if (rows.length > 1 || rows.some(row => row.tenant_id !== operation.tenant_id || row.intake_id !== operation.intake_id)) {
    return { ...base, status: 'unknown' }
  }
  const quote = rows[0]
  if (operation.status === 'completed') {
    if (!quote || quote.id !== operation.quote_id) return { ...base, status: 'unknown' }
    return { ...base, status: 'completed', quoteId: quote.id, intakeId: operation.intake_id,
      shareToken: quote.share_token, needsInspection: quote.needs_inspection === true }
  }
  // Migration 198's work key is unique and includes the exact preclaimed intake.
  // Some older workers leave tenant_id null; access is authorised above by the
  // operation's tenant and the saved quote's tenant, never by this nullable field.
  const work = await db.from('sms_work_jobs').select('status, result')
    .eq('work_key', `estimate:initial:${operation.intake_id}`).eq('kind', 'estimate').maybeSingle()
  if (quote) {
    let completed = false
    const result = work.data?.result as { status?: unknown; body?: unknown } | null
    if (!work.error && work.data?.status === 'completed' && result?.status === 200 && typeof result.body === 'string') {
      try {
        const body = JSON.parse(result.body) as { ok?: unknown; quoteId?: unknown }
        completed = body.ok === true && body.quoteId === quote.id
      } catch { /* An unreadable result is not proof of completion. */ }
    }
    return { ...base, status: completed ? 'completed' : 'quote_available', quoteId: quote.id,
      intakeId: operation.intake_id, shareToken: quote.share_token, needsInspection: quote.needs_inspection === true }
  }
  const recent = Date.now() - Date.parse(operation.created_at) < 6 * 60_000
  return { ...base, status: operation.status === 'processing' && recent && !work.error ? 'processing' : 'unknown' }
}

export function jobQuoteOperationResponse(view: JobQuoteOperationView): Response {
  return Response.json(view, { status: view.status === 'completed' ? 200 : 202, headers: { 'Cache-Control': 'no-store' } })
}

export type QuoteDraftReadiness = { ready: true } | {
  ready: false; code: 'quote_draft_processing' | 'quote_draft_unconfirmed'
}

/** Shared owner capability/mutation gate. A quote row can exist while its
 * estimate worker is still finishing. No-op-history legacy rows also require
 * a worker lookup: missing 202 history alone is not completion evidence.
 * Reads only, never resumes/claims work. Call after owner authentication. */
export async function readQuoteDraftReadiness(db: SupabaseClient, quote: {
  id: string; tenant_id: string | null; intake_id: string | null; quote_kind?: unknown
}): Promise<QuoteDraftReadiness> {
  const unconfirmed = { ready: false as const, code: 'quote_draft_unconfirmed' as const }
  const processing = { ready: false as const, code: 'quote_draft_processing' as const }
  try {
    if (![quote.id, quote.tenant_id].every(id => z.string().uuid().safeParse(id).success) ||
        (quote.intake_id !== null && !z.string().uuid().safeParse(quote.intake_id).success)) return unconfirmed
    if (quote.quote_kind === 'final' || quote.quote_kind === 'balance') {
      // Children share the initial intake, but the worker result names the
      // INITIAL quote. Verify that owned root instead of rejecting a legitimate
      // child because its own ID differs from the completed worker's receipt.
      if (!quote.intake_id) return unconfirmed
      const initial = await db.from('quotes').select('id, tenant_id, intake_id')
        .eq('tenant_id', quote.tenant_id!).eq('intake_id', quote.intake_id)
        .is('parent_quote_id', null).limit(2)
      if (initial.error || !Array.isArray(initial.data) || initial.data.length !== 1) return unconfirmed
      const root = z.object({ id: z.string().uuid(), tenant_id: z.string().uuid(), intake_id: z.string().uuid() }).parse(initial.data[0])
      if (root.id === quote.id || root.tenant_id !== quote.tenant_id || root.intake_id !== quote.intake_id) return unconfirmed
      return readQuoteDraftReadiness(db, { ...root, quote_kind: 'initial' })
    }
    const conditions = [`quote_id.eq.${quote.id}`]
    if (quote.intake_id) conditions.push(`intake_id.eq.${quote.intake_id}`)
    const operations = await db.from('job_quote_operations').select('*')
      .eq('tenant_id', quote.tenant_id!).or(conditions.join(',')).limit(2)
    if (operations.error) return unconfirmed
    const rows = z.array(OperationSchema).parse(operations.data)
    if (rows.length > 1) return unconfirmed
    const operation = rows[0]
    if (operation && (operation.tenant_id !== quote.tenant_id || operation.intake_id !== quote.intake_id ||
        (operation.quote_id !== null && operation.quote_id !== quote.id) || operation.status === 'failed_no_commit')) return unconfirmed
    const work = quote.intake_id ? await db.from('sms_work_jobs').select('status, result')
      .eq('work_key', `estimate:initial:${quote.intake_id}`).eq('kind', 'estimate').maybeSingle() : { data: null, error: null }
    if (work.error) return unconfirmed
    if (work.data) {
      if (['queued', 'running', 'pending', 'retry'].includes(work.data.status)) return processing
      const result = work.data.result as { status?: unknown; body?: unknown } | null
      if (work.data.status !== 'completed' || result?.status !== 200 || typeof result.body !== 'string') return unconfirmed
      const body = JSON.parse(result.body) as { ok?: unknown; quoteId?: unknown }
      return body.ok === true && body.quoteId === quote.id ? { ready: true } : unconfirmed
    }
    if (!operation) return { ready: true }
    if (operation.status === 'completed' && operation.quote_id === quote.id) return { ready: true }
    return operation.status === 'processing' && Date.now() - Date.parse(operation.created_at) < 6 * 60_000 ? processing : unconfirmed
  } catch { return unconfirmed }
}
