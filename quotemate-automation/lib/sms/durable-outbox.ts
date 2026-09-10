import { createHash, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { DispatchResult } from './dispatch'
import { publicWebUrl } from './public-origin'
import { smsDeliveryContext } from './delivery-context'
import { readTwilioMessage } from './twilio'

export type OutboundOptions = {
  to: string; text: string; from?: string; mediaUrl?: string | string[]
  audience?: 'customer' | 'tradie'; tenantId?: string | null
  deliveryKey?: string; turnId?: string; conversationId?: string | null
  workId?: string; workOwner?: string
  /** Persistent storage identity; signed media credentials are transport details. */
  mediaKey?: string | string[]
}
export type OutboxRow = {
  id: string; delivery_key: string; turn_id: string | null; conversation_id: string | null
  status: string; attempts: number; provider_sid: string | null; attempt_token: string | null
  payload: OutboundOptions; result: DispatchResult | null
}
export function outboxDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SMS outbox database configuration missing')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const deadline = AbortSignal.timeout(4000)
      const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
      try { return await fetch(input, { ...init, signal }) }
      catch (error) {
        // PostgREST retries GET network errors, including TimeoutError. Report
        // cancellation as AbortError so a stalled recovery poll ends at 4s.
        if (signal.aborted) throw new DOMException('SMS outbox database request aborted', 'AbortError')
        throw error
      }
    } },
  })
}
function failure(code: string, reason: string, outboxId?: string): DispatchResult {
  return { ok: false, smsAttempt: { code, reason }, smsAttempts: 0, outboxId }
}
export function deliveryStatus(result: DispatchResult): 'accepted' | 'delivered' | 'retry' | 'failed' | 'unknown' {
  if (result.ok) return result.status === 'delivered' || result.status === 'read' ? 'delivered' : 'accepted'
  const code = result.waAttempt?.code ?? result.smsAttempt.code
  if (['AMBIGUOUS', 'NETWORK', 'AbortError', 'TimeoutError'].includes(code)) return 'unknown'
  return ['429', '14107', '14101'].includes(code) ? 'retry' : 'failed'
}
/** Persist before network I/O. An unknown provider outcome is never automatically re-sent. */
export async function enqueueOutbound(opts: OutboundOptions, db = outboxDb()): Promise<OutboxRow> {
  const context = smsDeliveryContext()
  await context?.assertOwnership?.()
  const turnId = opts.turnId ?? context?.turnId
  const payload = { ...opts, turnId, tenantId: opts.tenantId ?? context?.tenantId,
    conversationId: opts.conversationId ?? context?.conversationId,
    workId: opts.workId ?? context?.workId, workOwner: opts.workOwner ?? context?.workOwner }
  const digest = createHash('sha256').update(JSON.stringify([
    payload.tenantId ?? null, opts.to, opts.from ?? null, opts.text, logicalMediaIdentity(opts), opts.audience ?? 'customer',
  ])).digest('hex')
  const jobId = payload.workId ?? turnId
  // A turn spans inbound, intake and estimate jobs. Use the job, never a resettable
  // call ordinal: retry wrappers and process restarts must select the same intent.
  const key = opts.deliveryKey ?? (jobId ? `${jobId}:payload:${digest}` : randomUUID())
  const { data, error } = await db.rpc('sms_outbox_enqueue', {
    p_key: key, p_payload: payload, p_hash: digest,
  })
  if (error || !data) throw new Error(`SMS outbox enqueue failed: ${error?.code ?? 'missing row'}`)
  return data as OutboxRow
}

function logicalMediaIdentity(opts: OutboundOptions): string | string[] | null {
  if (opts.mediaKey) return opts.mediaKey
  if (!opts.mediaUrl) return null
  const urls = Array.isArray(opts.mediaUrl) ? opts.mediaUrl : [opts.mediaUrl]
  return urls.map(value => {
    try {
      const url = new URL(value)
      return `${url.origin}${url.pathname}`
    } catch { return value.split(/[?#]/, 1)[0] }
  })
}
export async function processOutbound(
  row: OutboxRow,
  transport: (opts: OutboundOptions & { statusCallback: string }) => Promise<DispatchResult>,
  db = outboxDb(),
): Promise<DispatchResult> {
  if (['accepted', 'delivered'].includes(row.status)) return row.result?.ok
    ? { ...row.result, outboxId: row.id }
    : { ok: true, channel: 'sms', sid: row.provider_sid ?? '', status: row.status, outboxId: row.id }
  // Configuration failure is definite pre-send, so leave the intent pending.
  let callbackBase: string
  try { callbackBase = publicWebUrl('/api/sms/status') }
  catch { return failure('OUTBOX_UNAVAILABLE', 'Message remains queued; callback origin configuration is unavailable', row.id) }
  const attempt = randomUUID()
  const { data, error } = await db.rpc('sms_outbox_claim', { p_id: row.id, p_attempt: attempt })
  if (error) return failure('OUTBOX_UNAVAILABLE', 'Message remains queued; persistence is unavailable', row.id)
  if (!data) return failure('OUTBOX_PENDING', `Message is ${row.status}; recovery will reconcile it`, row.id)
  let result: DispatchResult
  try {
    await smsDeliveryContext()?.assertOwnership?.()
    const callback = `${callbackBase}?outbox=${row.id}&attempt=${attempt}`
    result = await transport({ ...row.payload, statusCallback: callback })
  } catch {
    // Once claimed, an interrupted execution may have reached the carrier. Require reconciliation.
    result = failure('AMBIGUOUS', 'Provider acceptance is unknown; automatic resend stopped', row.id)
  }
  const status = deliveryStatus(result)
  const completed = await db.rpc('sms_outbox_finish', {
    p_id: row.id, p_attempt: attempt, p_status: status, p_result: result,
    p_sid: result.ok ? result.sid || null : null,
  })
  if (completed.error || !completed.data) {
    return failure('AMBIGUOUS', 'Send result could not be saved; callback/reconciliation required', row.id)
  }
  const persisted = completed.data as OutboxRow
  if (['failed','undelivered'].includes(persisted.status) && result.ok) {
    return failure('DELIVERY_FAILED', 'Provider reported non-delivery', row.id)
  }
  return { ...result, outboxId: row.id }
}
export async function dispatchDurably(
  opts: OutboundOptions,
  transport: (opts: OutboundOptions & { statusCallback: string }) => Promise<DispatchResult>,
): Promise<DispatchResult> {
  let row: OutboxRow | undefined
  try {
    const db = outboxDb()
    row = await enqueueOutbound(opts, db)
    return await processOutbound(row, transport, db)
  } catch {
    // A later persistence exception must not erase the already-saved intent.
    // Reconciliation determines whether its claim reached the provider.
    if (row) return failure('AMBIGUOUS', 'Saved message requires reconciliation after persistence failed', row.id)
    // Fail closed: no durable intent means no network call.
    return failure('OUTBOX_UNAVAILABLE', 'Message could not be queued; retry the originating job')
  }
}

export async function recordDeliveryReceipt(input: {
  outboxId: string; attempt: string; sid: string; status: string; errorCode?: string | null
}, db = outboxDb()): Promise<boolean> {
  const { data, error } = await db.rpc('sms_outbox_receipt', {
    p_id: input.outboxId, p_attempt: input.attempt, p_sid: input.sid,
    p_status: input.status, p_error: input.errorCode ?? null,
  })
  if (error) throw new Error(`Delivery receipt persistence failed: ${error.code}`)
  return data === true
}

export async function recoverOutbound(
  transport: (opts: OutboundOptions & { statusCallback: string }) => Promise<DispatchResult>,
  limit = 10, db = outboxDb(),
): Promise<{ attempted: number; reconciled: number }> {
  const bounded = Math.max(1, Math.min(limit, 25))
  const { data: ready, error } = await db.from('sms_outbox').select('*')
    .in('status', ['pending','retry','sending']).lte('next_attempt_at', new Date().toISOString())
    .order('created_at').limit(bounded)
  if (error) throw new Error('Outbox recovery database unavailable')
  for (const row of (ready ?? []) as OutboxRow[]) await processOutbound(row, transport, db)
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString()
  const { data: stale, error: staleError } = await db.from('sms_outbox').select('*')
    .in('status', ['accepted','unknown']).lt('updated_at', cutoff).order('updated_at').limit(bounded)
  if (staleError) throw new Error('Outbox reconciliation database unavailable')
  let reconciled = 0
  for (const row of (stale ?? []) as OutboxRow[]) {
    if (row.provider_sid && row.attempt_token) {
      try {
        const receipt = await readTwilioMessage(row.provider_sid)
        await recordDeliveryReceipt({ outboxId: row.id, attempt: row.attempt_token,
          sid: row.provider_sid, status: receipt.status, errorCode: receipt.errorCode }, db)
        reconciled++
        continue
      } catch { /* Keep visible; a read failure must not trigger a resend. */ }
    }
    const marked = await db.from('sms_outbox').update({ requires_attention: true })
      .eq('id', row.id).in('status', ['accepted','unknown'])
    if (marked.error) throw new Error('Outbox reconciliation escalation failed')
  }
  return { attempted: ready?.length ?? 0, reconciled }
}
