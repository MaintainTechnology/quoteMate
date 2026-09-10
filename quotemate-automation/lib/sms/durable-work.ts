import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type SmsWorkKind = 'inbound' | 'intake' | 'estimate' | 'plan'
export type SmsWorkPayload = { url: string; headers: Record<string, string>; body: string }
export type SmsWorkJob = {
  id: string; sequence: number; work_key: string; kind: SmsWorkKind; serial_key: string
  turn_id: string; tenant_id: string | null; payload: SmsWorkPayload
  owner_token: string; status: string; attempts: number; checkpoint: Record<string, unknown>; result: StoredResponse | null
}
type StoredResponse = { status: number; body: string; contentType: string }
type WorkContext = {
  jobId: string; ownerToken: string; turnId: string; sequence: number; signal: AbortSignal
  job: SmsWorkJob; db: SupabaseClient; callbacks: Array<() => unknown>; writeErrors: string[]
}
const workStorage = new AsyncLocalStorage<WorkContext>()
export const currentSmsWork = () => workStorage.getStore()
export function smsWorkFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signals = [currentSmsWork()?.signal, init?.signal, AbortSignal.timeout(30_000)].filter((signal): signal is AbortSignal => !!signal)
  return fetch(input, { ...init, signal: AbortSignal.any(signals) })
}
const dbClient = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000) }) } })
function checked<T>(response: { data: T; error: unknown }, operation: string): T {
  if (response.error) throw new Error(`SMS work ${operation} failed: ${JSON.stringify(response.error)}`)
  return response.data
}
export async function enqueueSmsWork(input: {
  key: string; kind: SmsWorkKind; serialKey: string; payload: SmsWorkPayload; turnId?: string; tenantId?: string | null; serviceKey?: string
}, db = dbClient()): Promise<SmsWorkJob> {
  const turnId = input.turnId && /^[0-9a-f-]{36}$/i.test(input.turnId) ? input.turnId : currentSmsWork()?.turnId ?? randomUUID()
  const result = checked(await db.rpc('enqueue_sms_work', {
    p_key: input.key, p_kind: input.kind, p_serial_key: input.serialKey,
    p_service: input.serviceKey ?? process.env.SMS_WORKER_SERVICE ?? 'platform', p_turn_id: turnId, p_payload: input.payload, p_tenant_id: input.tenantId ?? null,
  }), 'enqueue') as SmsWorkJob | SmsWorkJob[] | null
  const job = Array.isArray(result) ? result[0] : result
  if (!job?.id) throw new Error('SMS work receipt was not persisted')
  return job
}
/** Attribute delayed intake/estimate failures to the owning tradie's recovery queue. */
export async function attributeSmsWorkTenant(tenantId: string | null | undefined) {
  const ctx = currentSmsWork()
  if (!ctx || !tenantId || ctx.job.tenant_id === tenantId) return
  await assertSmsWorkOwnership()
  const result = await ctx.db.from('sms_work_jobs').update({ tenant_id: tenantId })
    .eq('id', ctx.jobId).eq('owner_token', ctx.ownerToken).eq('status', 'running').select('id').single()
  checked(result, 'tenant attribution')
  if (!result.data?.id) throw new Error('SMS work tenant attribution lost ownership')
  ctx.job.tenant_id = tenantId
}
export async function assertSmsWorkOwnership(): Promise<void> {
  const ctx = currentSmsWork()
  if (!ctx) return
  ctx.signal.throwIfAborted()
  checked(await ctx.db.rpc('assert_sms_work_owner', { p_id: ctx.jobId, p_owner: ctx.ownerToken }), 'ownership')
}
/** Captured callbacks are drained BEFORE a durable job is marked completed. */
export function durableAfter(callback: () => unknown): void {
  const ctx = currentSmsWork()
  if (!ctx) throw new Error('Durable work context required before scheduling SMS pipeline work')
  ctx.callbacks.push(callback)
}
export async function smsWorkCheckpoint<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const ctx = currentSmsWork()
  if (!ctx) return operation()
  await assertSmsWorkOwnership()
  if (Object.hasOwn(ctx.job.checkpoint, name)) return ctx.job.checkpoint[name] as T
  const value = await operation()
  checked(await ctx.db.rpc('checkpoint_sms_work', { p_id: ctx.jobId, p_owner: ctx.ownerToken, p_name: name, p_value: value ?? null }), 'checkpoint')
  ctx.job.checkpoint[name] = value
  return value
}
const FENCED_TABLES = new Set(['sms_conversations', 'sms_messages', 'intakes', 'quotes', 'roofing_measurements', 'painting_measurements', 'solar_estimates', 'plan_upload_requests', 'plan_extractions', 'sms_human_tasks'])
/** The DB trigger checks the attempt inside the mutation transaction, not a racy preflight. */
export function withFencedSmsClient<T extends SupabaseClient>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'from') {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (table: string) => {
        const builder = target.from(table)
        if (!FENCED_TABLES.has(table)) return builder
        return new Proxy(builder, {
          get(query, method) {
            const fn = Reflect.get(query, method)
            if (!['insert', 'upsert', 'update'].includes(String(method))) return typeof fn === 'function' ? fn.bind(query) : fn
            return (values: Record<string, unknown> | Record<string, unknown>[], ...args: unknown[]) => {
              const ctx = currentSmsWork()
              if (!ctx) return fn.call(query, values, ...args)
              ctx.signal.throwIfAborted()
              const stamp = (row: Record<string, unknown>) => ({ ...row, sms_work_id: ctx.jobId, sms_work_owner: ctx.ownerToken })
              const result = fn.call(query, Array.isArray(values) ? values.map(stamp) : stamp(values), ...args)
              const originalThen = result.then.bind(result)
              result.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => originalThen((value: { error?: unknown }) => {
                if (value.error && (value.error as { code?: string }).code !== '23505') ctx.writeErrors.push(`${table}: ${JSON.stringify(value.error)}`)
                return resolve(value)
              }, reject)
              return result
            }
          },
        })
      }
    },
  })
}
export type SmsWorkHandler = (request: Request) => Promise<Response>
export type SmsWorkHandlers = Partial<Record<SmsWorkKind, SmsWorkHandler>>
export type SmsWorkScope = <T>(job: SmsWorkJob, operation: () => Promise<T>) => Promise<T>

async function runClaimedJob(job: SmsWorkJob, handler: SmsWorkHandler, db: SupabaseClient, scope?: SmsWorkScope, attemptTimeoutMs = 240_000): Promise<StoredResponse> {
  const controller = new AbortController()
  const ctx: WorkContext = { jobId: job.id, ownerToken: job.owner_token, turnId: job.turn_id, sequence: job.sequence,
    signal: controller.signal, job, db, callbacks: [], writeErrors: [] }
  const deadline = setTimeout(() => controller.abort(new Error('SMS work attempt deadline exceeded')), Math.max(10, Math.min(attemptTimeoutMs, 240_000)))
  deadline.unref?.()
  const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
  let renewing = false
  const heartbeat = setInterval(async () => {
    if (renewing) return
    renewing = true
    try {
      if (!checked(await db.rpc('renew_sms_work', { p_id: job.id, p_owner: job.owner_token }), 'renew')) controller.abort(new Error('SMS work lease lost'))
    } catch (error) { controller.abort(error) } finally { renewing = false }
  }, 20_000)
  heartbeat.unref?.()
  try {
    const execution = workStorage.run(ctx, async () => {
      const operation = async () => {
        await assertSmsWorkOwnership()
        const response = await handler(new Request(job.payload.url, { method: 'POST', headers: { ...job.payload.headers, ...(job.kind !== 'inbound' ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}) }, body: job.payload.body, signal: controller.signal }))
        const stored: StoredResponse = { status: response.status, body: await response.text(), contentType: response.headers.get('content-type') ?? 'application/json' }
        if (stored.status >= 400) throw new Error(`Pipeline HTTP ${stored.status}: ${stored.body.slice(0, 200)}`)
        // Nested deferrals append here and are included in this durable attempt.
        for (let i = 0; i < ctx.callbacks.length; i++) { await assertSmsWorkOwnership(); await ctx.callbacks[i]() }
        if (ctx.writeErrors.length) throw new Error(ctx.writeErrors.join('; ').slice(0, 1000))
        await assertSmsWorkOwnership()
        checked(await db.rpc('finish_sms_work', { p_id: job.id, p_owner: job.owner_token, p_result: stored }), 'complete')
        return stored
      }
      return scope ? scope(job, operation) : operation()
    })
    return await Promise.race([execution, aborted])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A stale owner cannot change successor state, including its error/retry state.
    const result = await db.rpc('finish_sms_work', { p_id: job.id, p_owner: job.owner_token, p_error: message })
    if (result.error) console.error('[sms/work] ownership lost; successor retains work', { jobId: job.id })
    throw error
  } finally { clearInterval(heartbeat); clearTimeout(deadline) }
}
export async function runSmsWorkBatch(handlers: SmsWorkHandlers, options: { db?: SupabaseClient; limit?: number; scope?: SmsWorkScope; attemptTimeoutMs?: number } = {}) {
  const db = options.db ?? dbClient()
  const results: Array<{ id: string; ok: boolean }> = []
  for (let i = 0; i < (options.limit ?? 10); i++) {
    const rows = checked(await db.rpc('claim_sms_work', { p_kinds: Object.keys(handlers), p_service: process.env.SMS_WORKER_SERVICE ?? 'platform' }), 'claim') as SmsWorkJob[]
    const job = rows?.[0]
    if (!job) break
    try { await runClaimedJob(job, handlers[job.kind]!, db, options.scope, options.attemptTimeoutMs); results.push({ id: job.id, ok: true }) }
    catch (error) { console.error('[sms/work] retry scheduled', { jobId: job.id, error: String(error).slice(0, 500) }); results.push({ id: job.id, ok: false }) }
  }
  return results
}
/** Synchronous portal callers retain their response contract; the work also survives caller loss. */
export async function runSmsWorkNow(job: SmsWorkJob, handler: SmsWorkHandler, options: { db?: SupabaseClient; scope?: SmsWorkScope } = {}): Promise<Response> {
  if (job.status === 'completed' && job.result) return storedResponse(job.result)
  const db = options.db ?? dbClient()
  const rows = checked(await db.rpc('claim_sms_work', { p_kinds: [job.kind], p_id: job.id, p_service: process.env.SMS_WORKER_SERVICE ?? 'platform' }), 'claim') as SmsWorkJob[]
  if (!rows?.[0]) return Response.json({ ok: true, jobId: job.id, stage: job.status }, { status: 202 })
  return storedResponse(await runClaimedJob(rows[0], handler, db, options.scope))
}
function storedResponse(value: StoredResponse) { return new Response(value.body, { status: value.status, headers: { 'content-type': value.contentType } }) }

export function internalWorkPayload(path: string, body: unknown): SmsWorkPayload {
  const origin = process.env.ENGINE_BASE_URL ?? process.env.APP_URL ?? 'http://localhost:3000'
  return { url: new URL(path, origin).toString(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
export async function enqueueEstimateWork(intakeId: string, tenantId?: string | null) {
  return enqueueSmsWork({ key: `estimate:initial:${intakeId}`, kind: 'estimate', serialKey: `estimate:${intakeId}`, tenantId,
    payload: internalWorkPayload('/api/estimate/draft', { intakeId, tradieDrafted: true }) })
}
