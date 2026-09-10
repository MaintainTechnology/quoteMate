import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { normaliseAuMobile } from '@/lib/phone/au'
import { resolveFollowupTarget, resolveLeadTarget } from './followup-contact'
import { assertExpectedQuoteRecipient, QuoteDeliveryRecipientError } from './delivery-recipient'
import { humanizeJobType } from '@/lib/sms/followup-context'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { placeBridgeCall, signBridge } from '@/lib/twilio/voice'
import { followupCallBody, followupTextBody, followupNoteBody, followupOperationQuery,
  followupTarget, followupOutcomeLabel, type FollowupAction, type FollowupInput, type FollowupOperation } from './followup-operation-contract'

type Tenant = { id: string; owner_user_id: string | null; twilio_sms_number: string | null; twilio_voice_number: string | null; owner_mobile: string | null }
type OperationRow = {
  request_id: string; action: FollowupAction; target_kind: 'quote' | 'conversation'; target_id: string
  payload_hash: string; payload: Record<string, unknown>; status: FollowupOperation['status']; history: FollowupOperation['history']
  provider_sid: string | null; outbox_id: string | null; event_id: string | null
}
export class FollowupError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code) }
}
export function followupJson(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Authorization' } })
}
export function followupFailure(error: unknown) {
  if (error instanceof QuoteDeliveryRecipientError || error instanceof FollowupError)
    return followupJson({ ok: false, error: error.code }, error.status)
  return followupJson({ ok: false, error: 'followup_unavailable' }, 503)
}
export async function followupTenant(db: SupabaseClient, req: Request): Promise<Tenant> {
  const resolved = await resolveTenantRequest(db, req, 'id,owner_user_id,twilio_sms_number,twilio_voice_number,owner_mobile')
  if (!resolved?.tenant) throw new FollowupError('unauthorized', 401)
  return resolved.tenant as Tenant
}
export async function readFollowupBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  // Accepted 640-code-unit text, even JSON \uXXXX encoding plus all fields,
  // fits below 8KiB. Bound actual bytes before parsing as well as field lengths.
  const reader = req.body?.getReader()
  if (!reader) throw new FollowupError('invalid_json', 400)
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) { await reader.cancel(); throw new FollowupError('invalid_body', 400) }
      chunks.push(value)
    }
    const parsed = schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
    if (!parsed.success) throw new FollowupError('invalid_body', 400)
    return parsed.data
  } catch (error) {
    if (error instanceof FollowupError) throw error
    throw new FollowupError('invalid_json', 400)
  } finally { reader.releaseLock() }
}
export async function assertFollowupOwned(db: SupabaseClient, tenantId: string, target: FollowupOperation['target']) {
  const { data, error } = await db.from(target.kind === 'quote' ? 'quotes' : 'sms_conversations')
    .select('id').eq('id', target.id).eq('tenant_id', tenantId).maybeSingle()
  if (error) throw new FollowupError('followup_unavailable')
  if (!data) throw new FollowupError('not_found', 404)
}
function fingerprint(action: FollowupAction, input: FollowupInput) {
  return createHash('sha256').update(JSON.stringify([action, followupTarget(input),
    'text' in input ? input.text : null, 'outcome' in input ? input.outcome : null,
    'note' in input ? input.note || null : null, 'preserveChase' in input ? input.preserveChase : null,
    'expectedRecipient' in input ? normaliseAuMobile(input.expectedRecipient) ?? input.expectedRecipient ?? null : null,
  ])).digest('hex')
}
async function operationRow(db: SupabaseClient, tenantId: string, requestId: string): Promise<OperationRow | null> {
  const { data, error } = await db.from('followup_operations').select('*')
    .eq('tenant_id', tenantId).eq('request_id', requestId).maybeSingle()
  if (error) throw new FollowupError('followup_unavailable')
  return data as OperationRow | null
}
export function operationDto(row: OperationRow | null, action: FollowupAction, requestId: string, target: FollowupOperation['target']): FollowupOperation {
  if (row && (row.action !== action || row.target_kind !== target.kind || row.target_id !== target.id))
    throw new FollowupError('operation_conflict', 409)
  // A bridge is fenced from claim onwards, including a crash before its response.
  const status = row?.action === 'call' && row.status === 'pending' ? 'unknown' : row?.status ?? 'not_found'
  const accepted = Boolean(row?.provider_sid)
  const history = row?.history ?? 'not_applicable'
  const message = status === 'not_found' ? 'No saved operation was found. Keep this request identity for any explicit retry.'
    : status === 'complete' ? action === 'note' ? 'Touch logged.' : 'Provider accepted the request and history is saved.'
    : accepted ? 'Provider accepted the request. History still needs reconciliation.'
    : status === 'failed' ? 'The provider rejected this request.'
    : status === 'unknown' ? 'The outcome is unknown. Check status before any further action.'
    : 'The request is pending. Check status before any further action.'
  return { ok: true, requestId, action, target, status, accepted, history,
    eventId: row?.event_id ?? null, outboxId: row?.outbox_id ?? null, providerSid: row?.provider_sid ?? null, message }
}
async function rpc<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args)
  if (error) {
    if (error.code === '23505') throw new FollowupError('operation_conflict', 409)
    if (error.code === 'P0002') throw new FollowupError('not_found', 404)
    throw new FollowupError('followup_unavailable')
  }
  if (!data) throw new FollowupError('followup_unavailable')
  return data as T
}
async function repair(db: SupabaseClient, tenantId: string, requestId: string) {
  // Do not replace accepted evidence with an error if its history repair fails.
  await db.rpc('followup_operation_try_repair', { p_tenant: tenantId, p_request: requestId })
}
export async function getFollowupOperation(db: SupabaseClient, req: Request, action: FollowupAction) {
  try {
    const tenant = await followupTenant(db, req)
    const params = new URL(req.url).searchParams
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new FollowupError('invalid_query', 400)
    const parsed = followupOperationQuery.safeParse(Object.fromEntries(params))
    if (!parsed.success || (action === 'note' && !parsed.data.quoteId)) throw new FollowupError('invalid_query', 400)
    const target = followupTarget(parsed.data)
    await assertFollowupOwned(db, tenant.id, target)
    return followupJson(operationDto(await operationRow(db, tenant.id, parsed.data.requestId), action, parsed.data.requestId, target))
  } catch (error) { return followupFailure(error) }
}
async function recipient(db: SupabaseClient, tenant: Tenant, input: FollowupInput) {
  const target = followupTarget(input)
  const contact = target.kind === 'quote' ? await resolveFollowupTarget(db, target.id, tenant.id)
    : await resolveLeadTarget(db, target.id, tenant.id)
  if (!contact.ok) throw new FollowupError(contact.code, contact.code === 'not_found' ? 404 : 503)
  const to = normaliseAuMobile(contact.phone)
  if (!to) throw new FollowupError('BAD_NUMBER', 422)
  assertExpectedQuoteRecipient('sms', 'expectedRecipient' in input ? input.expectedRecipient : undefined, to)
  return to
}
async function pinForQuote(db: SupabaseClient, tenant: Tenant, quoteId?: string) {
  if (!quoteId) return null
  const { data: quote, error } = await db.from('quotes').select('share_token,selected_tier,total_inc_gst,intake_id')
    .eq('id', quoteId).eq('tenant_id', tenant.id).maybeSingle()
  if (error || !quote) throw new FollowupError('followup_unavailable')
  let jobType: string | null = null
  if (quote.intake_id) {
    const { data, error: intakeError } = await db.from('intakes').select('job_type')
      .eq('id', quote.intake_id).eq('tenant_id', tenant.id).maybeSingle()
    if (intakeError || !data) throw new FollowupError('followup_unavailable')
    jobType = typeof data.job_type === 'string' ? data.job_type : null
  }
  const appUrl = process.env.APP_URL?.replace(/\/$/, '')
  return { quote_id: quoteId, share_token: quote.share_token ?? null, job_label: humanizeJobType(jobType),
    total_inc_gst: quote.total_inc_gst != null && Number.isFinite(Number(quote.total_inc_gst)) ? Number(quote.total_inc_gst) : null,
    tier: quote.selected_tier ?? null, quote_url: appUrl && quote.share_token ? `${appUrl}/q/${quote.share_token}` : null }
}
export async function postFollowupOperation(db: SupabaseClient, req: Request, action: FollowupAction) {
  try {
    const tenant = await followupTenant(db, req)
    const schema = action === 'text' ? followupTextBody : action === 'call' ? followupCallBody : followupNoteBody
    if (process.env.FOLLOWUP_MUTATIONS_DISABLED === 'true') throw new FollowupError('followup_actions_paused')
    const input = await readFollowupBody<FollowupInput>(req, schema)
    const target = followupTarget(input)
    await assertFollowupOwned(db, tenant.id, target)
    const hash = fingerprint(action, input)
    const previous = await operationRow(db, tenant.id, input.requestId)
    if (previous) {
      operationDto(previous, action, input.requestId, target)
      if (previous.payload_hash !== hash) throw new FollowupError('operation_conflict', 409)
      if (previous.provider_sid) {
        await repair(db, tenant.id, input.requestId)
        return followupJson(operationDto(await operationRow(db, tenant.id, input.requestId), action, input.requestId, target))
      }
      if (action === 'call' || previous.status === 'failed' || previous.status === 'complete')
        return followupJson(operationDto(previous, action, input.requestId, target))
    }
    if (action === 'note' && 'outcome' in input) {
      const row = await rpc<OperationRow>(db, 'followup_note_commit', { p_tenant: tenant.id, p_request: input.requestId,
        p_quote: target.id, p_hash: hash, p_payload: { outcome: input.outcome, note: input.note || null,
          preserveChase: input.preserveChase, summary: followupOutcomeLabel(input.outcome), actor: tenant.owner_user_id } })
      return followupJson(operationDto(row, action, input.requestId, target))
    }
    const to = await recipient(db, tenant, input)
    if (previous && previous.payload.to !== to) throw new FollowupError('quote_recipient_changed', 409)
    const from = action === 'text' ? tenant.twilio_sms_number : tenant.twilio_voice_number
    if (!from || !/^\+\d{8,15}$/.test(from)) throw new FollowupError(action === 'text' ? 'NO_FROM' : 'NO_VOICE_NUMBER', 409)
    if (previous && previous.payload.from !== from) throw new FollowupError('followup_sender_changed', 409)
    const tradie = action === 'call' ? normaliseAuMobile(tenant.owner_mobile) : null
    if (action === 'call' && !tradie) throw new FollowupError('NO_TRADIE_NUMBER', 409)
    if (action === 'call' && (!process.env.TWILIO_AUTH_TOKEN || !process.env.APP_URL)) throw new FollowupError('NO_CREDS')
    const payload = previous?.payload ?? { to, from, text: 'text' in input ? input.text : null,
      tradie, pin: action === 'text' ? await pinForQuote(db, tenant, input.quoteId) : null }
    const claim = await rpc<{ claimed: boolean; operation: OperationRow }>(db, 'followup_operation_claim', {
      p_tenant: tenant.id, p_request: input.requestId, p_action: action, p_target_kind: target.kind,
      p_target: target.id, p_hash: hash, p_payload: payload,
    })
    if (action === 'text') {
      // Same immutable payload/key on explicit replay; the existing outbox owns
      // send claims and unknown fences. History creates the thread only on acceptance.
      const saved = claim.operation.payload
      if (saved.to !== to || saved.from !== from) throw new FollowupError('followup_contact_changed', 409)
      await dispatchQuoteMessage({ tenantId: tenant.id, deliveryKey: `followup:${tenant.id}:${input.requestId}`,
        to: saved.to as string, from: saved.from as string, text: saved.text as string, audience: 'customer', conversationId: null })
    } else if (claim.claimed) {
      const secret = process.env.TWILIO_AUTH_TOKEN!
      const twimlUrl = `${process.env.APP_URL!.replace(/\/$/, '')}/api/twilio/voice/followup-bridge?to=${encodeURIComponent(to)}&cid=${encodeURIComponent(from)}&sig=${signBridge(to, from, secret)}`
      let status: 'accepted' | 'failed' | 'unknown' = 'unknown'; let sid: string | null = null
      try {
        const result = await placeBridgeCall({ toTradieE164: tradie!, fromTenantNumberE164: from, twimlUrl })
        if (result.ok && /^CA[0-9a-fA-F]{32}$/.test(result.sid)) { status = 'accepted'; sid = result.sid }
        else if (!result.ok && (/^4\d\d$/.test(result.code) || /^2\d{4}$/.test(result.code) || result.code === 'NO_CREDS')) status = 'failed'
      } catch { /* Durable claim remains unknown; never place another bridge. */ }
      await rpc(db, 'followup_call_finish', { p_tenant: tenant.id, p_request: input.requestId, p_status: status, p_sid: sid })
    }
    const row = await operationRow(db, tenant.id, input.requestId)
    if (!row) throw new FollowupError('followup_unavailable')
    if (row.provider_sid && row.history !== 'complete') await repair(db, tenant.id, input.requestId)
    return followupJson(operationDto(await operationRow(db, tenant.id, input.requestId), action, input.requestId, target))
  } catch (error) { return followupFailure(error) }
}
