// Explicit balance request: prepare213 serializes the paid chain; release205
// atomically approves/enqueues. Only outbox acceptance stamps sent_at.
import { createClient } from '@supabase/supabase-js'
import { generateShareToken } from '@/lib/stripe/checkout'
import { connectDestinationForTenant, type TenantConnectState } from '@/lib/stripe/connect'
import { MIN_STRIPE_CHARGE_CENTS, chargedCents } from '@/lib/quote/money'
import { quoteChainMoney } from '@/lib/quote/chain-money'
import { assertExpectedQuoteRecipient, resolveOwnedQuoteCustomerContact, QuoteDeliveryRecipientError } from '@/lib/quote/delivery-recipient'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'
import { genericQuoteReleased, genericQuoteSendKey, persistGenericQuoteRelease, quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { buildBalanceRequestSms } from '@/lib/sms/templates'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { publicWebUrl } from '@/lib/sms/public-origin'
import { resolveQuoteOriginConversation } from '@/lib/sms/quote-origin-conversation'
import { resolveTenantRequest } from '@/lib/tenant/from-request'

export const dynamic = 'force-dynamic'
export const maxDuration = 30
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
type Row = Record<string, unknown>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OUTBOX_FIELDS = 'id,status,provider_sid,provider_status,provider_error,requires_attention,attempts,created_at,updated_at'
class RequestError extends Error { constructor(public status: number, message: string) { super(message) } }
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
function phoneIdentity(value: unknown) {
  const phone = text(value)
  if (!phone || !/^[+\d\s().-]+$/.test(phone)) return null
  const digits = phone.replace(/\D/g, '')
  return /^0\d{9}$/.test(digits) ? '61' + digits.slice(1) : /^[1-9]\d{7,14}$/.test(digits) ? digits : null
}
function failure(error: unknown) {
  if (error instanceof QuoteDeliveryRecipientError) return Response.json({ ok: false, error: error.code, message: error.message }, { status: error.status })
  return Response.json({ ok: false, error: error instanceof RequestError ? error.message : 'balance_request_unavailable' },
    { status: error instanceof RequestError ? error.status : 503, headers: { 'Cache-Control': 'private, no-store' } })
}
async function read<T>(query: PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  const { data, error } = await query
  if (error) throw new RequestError(503, 'quote_chain_unavailable')
  return data
}
async function owned(req: Request, id: string) {
  if (!UUID.test(id)) throw new RequestError(400, 'invalid_quote_id')
  const auth = await resolveTenantRequest(supabase, req,
    'id,twilio_sms_number,business_name,stripe_connect_account_id,stripe_connect_charges_enabled,stripe_connect_payouts_enabled')
  if (!auth?.tenant) throw new RequestError(401, 'unauthorized')
  const tenant = auth.tenant as Row & TenantConnectState & { id: string }
  const final = await read<Row>(supabase.from('quotes').select('*').eq('id', id.toLowerCase()).eq('tenant_id', tenant.id).maybeSingle())
  if (!final || final.tenant_id !== tenant.id || final.id !== id.toLowerCase()) throw new RequestError(404, 'no_quote')
  if (final.quote_kind !== 'final') throw new RequestError(409, 'not_final_quote')
  return { final, tenant, ownerId: auth.identity.userId }
}
async function children(final: Row, tenantId: string) {
  const rows = await read<Row[]>(supabase.from('quotes').select('*').eq('parent_quote_id', final.id)
    .eq('quote_kind', 'balance').limit(2)) ?? []
  if (rows.length > 1 || rows.some(row => row.tenant_id !== tenantId || row.intake_id !== final.intake_id)) {
    throw new RequestError(409, 'balance_history_review_required')
  }
  return rows[0] ?? null
}
async function deliveryReadback(balance: Row, tenantId: string, requestId?: string) {
  const message = await read<Row>(supabase.from('sms_outbox').select(OUTBOX_FIELDS).eq('tenant_id', tenantId)
    .eq('delivery_key', genericQuoteSendKey(String(balance.id), requestId)).maybeSingle())
  return { ok: true, quoteId: balance.id, requestId: requestId ?? null,
    status: message?.status ?? 'not_found', outboxId: message?.id ?? null,
    approved: genericQuoteReleased(balance), quoteReleasedAt: balance.customer_released_at ?? null,
    quoteStatus: balance.status, message }
}
function validBalance(balance: Row, final: Row, root: Row, intake: Row) {
  return balance.pricing_book_version_id === final.pricing_book_version_id &&
    quoteChainMoney(balance, 'balance', final, root, text(intake.trade)).available
}
/** A retained operation recovers its saved recipient, never today's contact.
 * This is readback only: pending and uncertain sends remain outbox-owned. */
async function retainedBalanceDelivery(balance: Row, tenantId: string, requestId: string | undefined, expectedRecipient: unknown) {
  const key = genericQuoteSendKey(String(balance.id), requestId)
  const saved = await read<Row>(supabase.from('sms_outbox').select('*').eq('tenant_id', tenantId)
    .eq('delivery_key', key).maybeSingle())
  if (!saved) return null
  const payload = saved.payload && typeof saved.payload === 'object' && !Array.isArray(saved.payload) ? saved.payload as Row : null
  const states = ['pending', 'retry', 'sending', 'accepted', 'delivered', 'failed', 'undelivered', 'unknown']
  if (!UUID.test(String(saved.id)) || saved.tenant_id !== tenantId || saved.delivery_key !== key ||
    !genericQuoteReleased(balance) || !payload || payload.tenantId !== tenantId || payload.quoteReleaseId !== balance.id ||
    payload.deliveryKey !== key || saved.audience !== 'customer' || payload.audience !== 'customer' ||
    !phoneIdentity(payload.to) || !phoneIdentity(payload.from) || saved.to_number !== payload.to ||
    !text(payload.text) || saved.body !== payload.text || !/^[a-f0-9]{64}$/.test(String(payload.quoteReleaseRevision)) ||
    (saved.conversation_id ?? null) !== (payload.conversationId ?? null) || !states.includes(String(saved.status))) {
    throw new RequestError(409, 'balance_delivery_review_required')
  }
  assertExpectedQuoteRecipient('sms', expectedRecipient, String(payload.to))
  if (saved.conversation_id) {
    const conversation = await read<Row>(supabase.from('sms_conversations').select('id,tenant_id,from_number,to_number')
      .eq('id', saved.conversation_id).eq('tenant_id', tenantId).maybeSingle())
    if (!conversation || conversation.id !== saved.conversation_id || conversation.tenant_id !== tenantId ||
      phoneIdentity(conversation.from_number) !== phoneIdentity(payload.to) ||
      phoneIdentity(conversation.to_number) !== phoneIdentity(payload.from)) {
      throw new RequestError(409, 'balance_delivery_review_required')
    }
  }
  const accepted = saved.status === 'accepted' || saved.status === 'delivered'
  if (accepted && !text(saved.provider_sid)) throw new RequestError(409, 'balance_delivery_review_required')
  // Older approved payloads predate the expanded 215 snapshot. Do not recompose
  // or re-approve them with a new hash; the original receipt remains authoritative.
  return { accepted, saved }
}
/** Lost POST recovery uses the final ID already known to the device. Missing
 * child/outbox remains unconfirmed: this read never authorizes a retry. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { final, tenant } = await owned(req, (await ctx.params).id)
    const requestId = new URL(req.url).searchParams.get('requestId') ?? undefined
    try { genericQuoteSendKey(String(final.id), requestId) } catch { throw new RequestError(400, 'invalid_request_id') }
    const balance = await children(final, tenant.id)
    if (balance) {
      const [root, intake] = await Promise.all([
        read<Row>(supabase.from('quotes').select('*').eq('id', final.parent_quote_id).eq('tenant_id', tenant.id).maybeSingle()),
        read<Row>(supabase.from('intakes').select('*').eq('id', final.intake_id).eq('tenant_id', tenant.id).maybeSingle()),
      ])
      if (!root || !intake || intake.tenant_id !== tenant.id || intake.id !== final.intake_id ||
        root.id !== final.parent_quote_id || !validBalance(balance, final, root, intake)) {
        throw new RequestError(409, 'balance_history_review_required')
      }
    }
    return Response.json(balance ? { finalQuoteId: final.id, balancePaid: !!balance.paid_at,
      ...await deliveryReadback(balance, tenant.id, requestId) }
      : { ok: true, finalQuoteId: final.id, quoteId: null, requestId: requestId ?? null, status: 'not_created', message: null },
    { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return failure(error) }
}
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { final, tenant, ownerId } = await owned(req, (await ctx.params).id)
    let input: Row
    try {
      const raw = await req.text()
      input = raw ? JSON.parse(raw) : {}
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error()
    } catch { throw new RequestError(400, 'invalid_request') }
    const requestId = input.requestId as string | undefined
    try { genericQuoteSendKey(String(final.id), requestId) } catch { throw new RequestError(400, 'invalid_request_id') }
    if (input.expected_revision !== undefined && input.expected_revision !== quoteCustomerReleaseRevision(final)) {
      throw new RequestError(409, 'quote_review_required')
    }
    if (!final.sent_at) throw new RequestError(409, 'final_not_sent')
    if (!final.paid_at || !['deposit', 'credit'].includes(String(final.paid_tier))) throw new RequestError(409, 'deposit_not_paid')
    if (!connectDestinationForTenant(tenant)) throw new RequestError(409, 'connect_required')
    if (!text(tenant.twilio_sms_number)) throw new RequestError(503, 'tenant_messaging_unavailable')
    const readiness = await readQuoteDraftReadiness(supabase, {
      id: String(final.id), tenant_id: tenant.id, intake_id: text(final.intake_id), quote_kind: 'final',
    })
    if (!readiness.ready) throw new RequestError(409, readiness.code)
    if (!text(final.intake_id) || !text(final.parent_quote_id)) throw new RequestError(409, 'quote_chain_not_payable')
    const [intake, root] = await Promise.all([
      read<Row>(supabase.from('intakes').select('*').eq('id', final.intake_id).eq('tenant_id', tenant.id).maybeSingle()),
      read<Row>(supabase.from('quotes').select('*').eq('id', final.parent_quote_id).eq('tenant_id', tenant.id).maybeSingle()),
    ])
    if (!intake || intake.tenant_id !== tenant.id || intake.id !== final.intake_id ||
      !root || root.tenant_id !== tenant.id || root.id !== final.parent_quote_id) throw new RequestError(409, 'quote_chain_not_payable')
    const proof = quoteChainMoney(final, 'final', root, root, text(intake.trade))
    if (!proof.available || proof.balanceBase === null || proof.depositPercent === null) throw new RequestError(409, 'quote_pricing_review_required')
    if (proof.balanceBase < MIN_STRIPE_CHARGE_CENTS) throw new RequestError(409, 'nothing_to_charge')
    const existing = await children(final, tenant.id)
    if (existing && !validBalance(existing, final, root, intake)) throw new RequestError(409, 'balance_history_review_required')
    if (existing?.paid_at) return Response.json({ ok: true, sent: false, already_actioned: true,
      status: 'balance_already_paid', finalQuoteId: final.id, channel: 'sms', quote_id: existing.id, share_token: existing.share_token })

    if (existing) {
      const retained = await retainedBalanceDelivery(existing, tenant.id, requestId, input.expected_recipient)
      if (retained) return Response.json({ ok: true, approved: true, accepted: retained.accepted, sent: retained.accepted,
        finalQuoteId: final.id, channel: 'sms', requestId: requestId?.toLowerCase() ?? null,
        status: retained.accepted ? 'provider_accepted' : 'approved_delivery_pending', deliveryStatus: retained.saved.status,
        outboxId: retained.saved.id, already: true, quote_id: existing.id, share_token: existing.share_token,
        balance_cents: proof.balanceBase, charged_cents: chargedCents(proof.balanceBase),
        ...(retained.accepted ? { sid: retained.saved.provider_sid } : {}),
      }, { status: retained.accepted ? 200 : 202, headers: { 'Cache-Control': 'private, no-store' } })
    }

    // Contact precedence matches owned GET, with tenant-scoped fallback reads.
    const caller = intake.caller && typeof intake.caller === 'object' ? intake.caller as Row : null
    const { phone } = await resolveOwnedQuoteCustomerContact(supabase, tenant.id, intake)
    if (!phone || !phoneIdentity(phone)) throw new RequestError(409, 'no_customer_number')
    assertExpectedQuoteRecipient('sms', input.expected_recipient, phone)
    let payOrigin: string
    try { payOrigin = publicWebUrl('/') } catch { throw new RequestError(503, 'public_origin_unavailable') }
    let conversationId: string | null
    try { conversationId = await resolveQuoteOriginConversation(supabase, { tenantId: tenant.id, family: 'generic',
      resourceId: String(final.id), intakeId: final.intake_id, customerPhone: phone, fromNumber: text(tenant.twilio_sms_number) }) }
    catch { throw new RequestError(503, 'quote_origin_unavailable') }
    const prepared = await supabase.rpc('prepare_balance_quote', { p_final_id: final.id, p_tenant_id: tenant.id,
      p_final_snapshot: final, p_root_snapshot: root, p_intake_snapshot: intake,
      p_balance_cents: proof.balanceBase, p_share_token: generateShareToken() })
    if (prepared.error || !prepared.data?.quote) throw new RequestError(409, 'balance_prepare_unconfirmed')
    const balance = prepared.data.quote as Row
    const check = quoteChainMoney(balance, 'balance', final, root, text(intake.trade))
    if (balance.tenant_id !== tenant.id || !UUID.test(String(balance.id)) || !text(balance.share_token) || !check.available) {
      throw new RequestError(409, 'balance_prepare_unconfirmed')
    }
    if (balance.paid_at) return Response.json({ ok: true, sent: false, already_actioned: true,
      status: 'balance_already_paid', finalQuoteId: final.id, channel: 'sms', quote_id: balance.id, share_token: balance.share_token })
    // Historical sent rows without an initial outbox need explicit resend intent.
    if (!requestId && genericQuoteReleased(balance)) {
      const saved = await deliveryReadback(balance, tenant.id)
      if (!saved.outboxId) return Response.json({ ok: true, sent: false, already_actioned: true,
        status: 'legacy_delivery_review_required', finalQuoteId: final.id, channel: 'sms', quote_id: balance.id, share_token: balance.share_token })
    }
    const release = await persistGenericQuoteRelease(supabase, { quote: balance, tenantId: tenant.id, ownerId, holdUntil: null,
      outbound: { to: phone, from: text(tenant.twilio_sms_number)!, text: buildBalanceRequestSms({
        firstName: text(caller?.name), businessName: text(tenant.business_name), jobType: text(intake.job_type) ?? 'job',
        balanceAud: proof.balanceBase / 100, chargedAud: chargedCents(proof.balanceBase) / 100,
        payUrl: new URL('/r/' + balance.share_token + '/balance', payOrigin).href,
      }), tenantId: tenant.id, audience: 'customer', deliveryKey: genericQuoteSendKey(String(balance.id), requestId),
      ...(conversationId ? { conversationId } : {}),
    } })
    if (!release.outbound || !release.outboxId) throw new RequestError(409, 'balance_release_unconfirmed')
    const dispatch = await dispatchQuoteMessage(release.outbound)
    return Response.json({ ok: true, approved: true, accepted: dispatch.ok, sent: dispatch.ok,
      finalQuoteId: final.id, channel: 'sms',
      status: dispatch.ok ? 'provider_accepted' : 'approved_delivery_pending', outboxId: release.outboxId,
      already: prepared.data.already === true, quote_id: balance.id, share_token: balance.share_token,
      balance_cents: proof.balanceBase, charged_cents: chargedCents(proof.balanceBase),
      ...(dispatch.ok ? { sid: dispatch.sid } : {}),
    }, { status: dispatch.ok ? 200 : 202 })
  } catch (error) { return failure(error) }
}
