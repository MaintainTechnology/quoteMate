// GET /api/tenant/followups/messages?quoteId=...
//
// The two-way SMS thread with the customer behind a follow-up, so the VA
// can read replies right on the Follow-ups page (and inside the compose
// modal) instead of digging through the Chats tab.
//
// Replies are already captured: when the customer texts the tenant's
// number back, /api/sms/inbound stores their message as an inbound
// sms_messages row on a conversation keyed by from_number. This endpoint
// just gathers every message (in + out) for THIS customer + tenant and
// returns it oldest-first with timestamps.
//
// Destination is resolved server-side from quoteId (ownership-guarded);
// the phone is never trusted from the request.

import { createClient } from '@supabase/supabase-js'
import { resolveFollowupTarget } from '@/lib/quote/followup-contact'
import { normaliseAuMobile } from '@/lib/phone/au'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const MSG_CAP = 50

async function tenantFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('owner_user_id', data.user.id)
    .maybeSingle()
  return (tenant as { id: string } | null) ?? null
}

export async function GET(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const quoteId = new URL(req.url).searchParams.get('quoteId')
  if (!quoteId) {
    return Response.json({ ok: false, error: 'quoteId is required' }, { status: 400 })
  }

  const target = await resolveFollowupTarget(supabase, quoteId, tenant.id)
  if (!target.ok) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const rawPhone = target.phone?.trim() ?? ''
  const e164 = normaliseAuMobile(rawPhone)
  // Match on both the canonical E.164 and whatever raw form might have
  // been stored on older rows, scoped to this tenant.
  const fromCandidates = Array.from(
    new Set([e164, rawPhone].filter((v): v is string => !!v)),
  )

  if (fromCandidates.length === 0) {
    return Response.json({
      ok: true,
      customer: { name: target.name, phone: rawPhone || null },
      messages: [],
      last_inbound_at: null,
      last_outbound_at: null,
    })
  }

  const { data: convos } = await supabase
    .from('sms_conversations')
    .select('id')
    .eq('tenant_id', tenant.id)
    .in('from_number', fromCandidates)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(10)

  const convoIds = (convos ?? []).map((c) => c.id as string)
  if (convoIds.length === 0) {
    return Response.json({
      ok: true,
      customer: { name: target.name, phone: (e164 ?? rawPhone) || null },
      messages: [],
      last_inbound_at: null,
      last_outbound_at: null,
    })
  }

  const { data: msgs } = await supabase
    .from('sms_messages')
    .select('direction, body, created_at')
    .in('conversation_id', convoIds)
    .order('created_at', { ascending: true })
    .limit(500)

  type Msg = { direction: 'inbound' | 'outbound'; body: string; created_at: string }
  const all: Msg[] = (msgs ?? []).map((m) => ({
    direction: m.direction as 'inbound' | 'outbound',
    body: (m.body as string) ?? '',
    created_at: m.created_at as string,
  }))
  // Keep the most recent MSG_CAP, but return them oldest-first for display.
  const recent = all.slice(-MSG_CAP)

  let lastInbound: string | null = null
  let lastOutbound: string | null = null
  for (const m of all) {
    if (m.direction === 'inbound') lastInbound = m.created_at
    else lastOutbound = m.created_at
  }

  return Response.json({
    ok: true,
    customer: { name: target.name, phone: (e164 ?? rawPhone) || null },
    messages: recent,
    last_inbound_at: lastInbound,
    last_outbound_at: lastOutbound,
  })
}
