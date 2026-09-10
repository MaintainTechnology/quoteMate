'use client'

import { z } from 'zod'
import { followupTarget, followupUuid, followupOperationResponse, type FollowupAction, type FollowupOperation } from './followup-operation-contract'

type Payload = { quoteId?: string; conversationId?: string; text?: string; expectedRecipient?: string; kind?: 'note'; outcome?: string; note?: string; preserveChase?: boolean }
const receiptSchema = z.object({ version: z.literal(1), requestId: followupUuid, bodyHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
type Dependencies = {
  getToken: () => Promise<string | null>; fetch?: typeof fetch; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  signal?: AbortSignal; confirm?: (message: string) => boolean; lock?: <T>(key: string, task: () => Promise<T>) => Promise<T>
}
const terminal = (op: FollowupOperation) => op.status === 'complete' ||
  (op.status === 'failed' && !op.accepted) ||
  (op.status === 'accepted' && op.accepted && op.history === 'complete')
async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function actor(token: string | null): string {
  if (!token) throw new Error('Sign in again before continuing.')
  try {
    // Local partition only. Server verification of this bearer remains authority.
    const raw = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const value = JSON.parse(atob(raw)) as { sub?: unknown; iss?: unknown }
    if (typeof value.sub !== 'string' || typeof value.iss !== 'string') throw new Error()
    return JSON.stringify([value.iss, value.sub])
  } catch { throw new Error('The current account identity could not be confirmed.') }
}
export function createBrowserFollowupOperations(deps: Dependencies) {
  const transport = deps.fetch ?? fetch
  const storage = deps.storage ?? localStorage
  const confirm = deps.confirm ?? (message => window.confirm(message))
  const lock = deps.lock ?? (<T>(key: string, task: () => Promise<T>) => {
    if (!navigator.locks) throw new Error('This browser cannot safely coordinate follow-up requests.')
    return navigator.locks.request(key, task)
  })
  const assertActive = () => deps.signal?.throwIfAborted()
  async function json(path: string, token: string, body?: unknown): Promise<unknown> {
    assertActive()
    const timeout = AbortSignal.timeout(20_000)
    const response = await transport(path, { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      signal: deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout,
      ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json()
    assertActive()
    if (!response.ok) {
      const error = value && typeof value === 'object' && 'error' in value ? String(value.error) : `HTTP ${response.status}`
      throw new Error(`Follow-up could not be confirmed: ${error}. Keep the saved request and check status.`)
    }
    return value
  }
  async function context(action: FollowupAction, payload: Payload) {
    const token = await deps.getToken(); const owner = actor(token)
    const me = await json('/api/tenant/me', token!)
    const parsed = z.object({ tenant: z.object({ id: followupUuid }) }).safeParse(me)
    if (!parsed.success) throw new Error('The current business could not be confirmed.')
    const tenantId = parsed.data.tenant.id
    const target = followupTarget(payload)
    const scope = await digest(JSON.stringify([owner, tenantId, action, target]))
    const key = `quotemax.followup.operation.v1.${scope}`
    async function fresh() {
      assertActive(); const current = await deps.getToken()
      if (actor(current) !== owner) throw new Error('The account changed. Reopen this follow-up in the current account.')
      const currentMe = z.object({ tenant: z.object({ id: followupUuid }) }).safeParse(await json('/api/tenant/me', current!))
      if (!currentMe.success || currentMe.data.tenant.id !== tenantId)
        throw new Error('The business changed. Reopen this follow-up in the current business.')
      return current!
    }
    const endpoint = `/api/tenant/followups/${action === 'note' ? 'events' : action}`
    function read() {
      const raw = storage.getItem(key)
      if (raw == null) return null
      const parsed = receiptSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) throw new Error('The saved follow-up request could not be read. Do not send another request.')
      return parsed.data
    }
    async function status(requestId: string) {
      const params = new URLSearchParams({ requestId, [target.kind === 'quote' ? 'quoteId' : 'conversationId']: target.id })
      return validate(await json(`${endpoint}?${params}`, await fresh()), requestId)
    }
    async function validate(value: unknown, requestId: string) {
      await fresh()
      const parsed = followupOperationResponse.safeParse(value)
      if (!parsed.success || parsed.data.requestId !== requestId || parsed.data.action !== action ||
        parsed.data.target.kind !== target.kind || parsed.data.target.id !== target.id)
        throw new Error('The follow-up response could not be verified. Keep this request and check status.')
      return parsed.data
    }
    return { key, endpoint, read, status, validate, fresh }
  }
  return {
    async recover(action: FollowupAction, payload: Payload): Promise<FollowupOperation | null> {
      const ctx = await context(action, payload)
      return lock(ctx.key, async () => { const receipt = ctx.read(); return receipt ? ctx.status(receipt.requestId) : null })
    },
    async submit(action: FollowupAction, payload: Payload): Promise<FollowupOperation> {
      const ctx = await context(action, payload)
      return lock(ctx.key, async () => {
        assertActive()
        let receipt = ctx.read()
        const bodyHash = await digest(JSON.stringify([action, followupTarget(payload), payload.text ?? null,
          payload.expectedRecipient ?? null, payload.outcome ?? null, payload.note || null, payload.preserveChase ?? false]))
        if (receipt) {
          const prior = await ctx.status(receipt.requestId)
          if (terminal(prior)) {
            if (!confirm(`${prior.message} Start a separate new ${action === 'note' ? 'touch log' : action === 'call' ? 'call' : 'message'}?`))
              throw new Error('New action cancelled. Your draft is unchanged.')
            // Only a verified terminal result and an explicit new-action decision
            // can replace the old identity. Unknown receipts have no expiry.
            receipt = null
          } else {
            if (receipt.bodyHash !== bodyHash) throw new Error(`${prior.message} This draft differs from the saved request. Check status before starting another action.`)
            if (!confirm(`${prior.message} Retry this same saved request?`)) return prior
          }
        }
        if (!receipt) {
          receipt = { version: 1, requestId: crypto.randomUUID(), bodyHash }
          storage.setItem(ctx.key, JSON.stringify(receipt))
          if (ctx.read()?.requestId !== receipt.requestId) throw new Error('The request identity could not be saved. Nothing was sent.')
        }
        const token = await ctx.fresh()
        return ctx.validate(await json(ctx.endpoint, token, { ...payload, requestId: receipt.requestId }), receipt.requestId)
      })
    },
  }
}
