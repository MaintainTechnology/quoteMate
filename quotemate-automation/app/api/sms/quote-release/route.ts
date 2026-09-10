import { createClient } from '@supabase/supabase-js'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { canonicalQuoteUrl, type QuoteFamily, type QuoteReference } from '@/lib/sms/quote-actions'
import { loadSavedQuoteReview, REVIEW_TABLES, type ReviewFamily } from '@/lib/sms/quote-review'
import { createHash } from 'node:crypto'
import { resolveQuoteOriginConversation } from '@/lib/sms/quote-origin-conversation'

export const dynamic = 'force-dynamic'
const RELEASE_FAMILIES = new Set(['roof', 'paint', 'solar', 'plan', 'aircon', 'commercial-paint'])

export async function GET(request: Request) {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const owner = await resolveTenantRequest(db, request, 'id')
  if (!owner?.tenant?.id) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  const url = new URL(request.url); const family = url.searchParams.get('family'); const id = url.searchParams.get('id')
  if (!family || !Object.hasOwn(REVIEW_TABLES,family) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ ok: false, error: 'invalid_resource' }, { status: 400 })
  try {
    const review = await loadSavedQuoteReview(db, owner.tenant.id as string, family as ReviewFamily, id)
    if (!review) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
    const { sourceSnapshot: _snapshot, ...visible } = review
    void _snapshot
    return Response.json({ ok: true, review: visible })
  } catch { return Response.json({ ok: false, error: 'Review temporarily unavailable' }, { status: 503 }) }
}

/** Explicit authenticated owner approval. No inbound/model tool may call this
 * with service-role/cron authentication in lieu of the tenant owner session.
 */
export async function POST(request: Request) {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const owner = await resolveTenantRequest(supabase, request, 'id,twilio_sms_number')
  if (!owner?.tenant?.id) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  let body: { family?: unknown; id?: unknown; customerPhone?: unknown; approve?: unknown; reviewVersion?: unknown }
  try { body = await request.json() } catch { return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 }) }
  if (body.approve !== true || typeof body.family !== 'string' || !RELEASE_FAMILIES.has(body.family) ||
    typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id) ||
    (body.customerPhone != null && (typeof body.customerPhone !== 'string' || !/^\+?[\d ()-]{8,24}$/.test(body.customerPhone)))) {
    return Response.json({ ok: false, error: 'explicit_approval_and_valid_resource_required' }, { status: 400 })
  }
  const tenantId = owner.tenant.id as string
  let review
  try { review = await loadSavedQuoteReview(supabase, tenantId, body.family as ReviewFamily, body.id) }
  catch { return Response.json({ ok: false, error: 'Review temporarily unavailable' }, { status: 503 }) }
  if (!review) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  if (!review.canApprove) return Response.json({ ok: false, error: 'Complete the saved result and resolve its review checks before sharing.' }, { status: 409 })
  if (!owner.tenant.twilio_sms_number) return Response.json({ ok: false, error: 'Tenant messaging setup unavailable' }, { status: 503 })
  if (typeof body.reviewVersion !== 'string' || body.reviewVersion !== review.version) {
    return Response.json({ ok: false, error: 'The saved result changed. Refresh and review it before approving.' }, { status: 409 })
  }
  const phone = review.customerPhone || (typeof body.customerPhone === 'string' ? body.customerPhone : '')
  if (!phone) return Response.json({ ok: false, error: 'Customer mobile required' }, { status: 409 })
  const reference: QuoteReference = { family: body.family as QuoteFamily, id: body.id, token: review.token,
    label: review.address, stage: 'ready', createdAt: review.createdAt }
  let url: string
  try { url = canonicalQuoteUrl(reference) }
  catch { return Response.json({ ok: false, error: 'Saved quote link unavailable' }, { status: 409 }) }
  let conversationId: string | null
  try {
    conversationId = await resolveQuoteOriginConversation(supabase, { tenantId, family: reference.family,
      resourceId: body.id, customerPhone: phone, fromNumber: owner.tenant.twilio_sms_number as string })
  } catch { return Response.json({ ok: false, error: 'Saved quote conversation unavailable; retry approval shortly.' }, { status: 503 }) }
  const outbound = { tenantId, audience: 'customer' as const, to: phone,
    ...(conversationId ? { conversationId } : {}),
    from: owner.tenant.twilio_sms_number as string | undefined,
    deliveryKey: `quote-release:${body.family}:${body.id}`,
    text: `Your tradie has reviewed and approved the ${reference.label} result. View it here: ${url}`,
    resourceToken: review.token,
  }
  const digest = createHash('sha256').update(JSON.stringify([tenantId,outbound.to,outbound.from ?? null,outbound.text,null,'customer'])).digest('hex')
  const { data: saved, error } = await supabase.rpc('sms_release_quote_resource', {
    p_tenant_id: tenantId, p_family: body.family, p_resource_id: body.id, p_customer_phone: body.customerPhone ?? null,
    p_outbound: outbound, p_outbound_hash: digest,
    p_expected_snapshot: review.sourceSnapshot,
  })
  if (error || !saved?.token || !saved.customer_phone) {
    return Response.json({ ok: false, error: 'quote_not_ready_or_owned', detail: error?.message ?? 'Customer contact missing' }, { status: 409 })
  }
  const send = await dispatchQuoteMessage(outbound)
  // Approval and delivery are distinct facts. A failed send remains recoverable
  // in the outbox; repeated approval reuses exactly the same outbound intent.
  return Response.json({ ok: true, approved: true, accepted: send.ok, url, outboxId: 'outboxId' in send ? send.outboxId : null }, { status: send.ok ? 200 : 202 })
}
