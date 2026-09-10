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
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import {
  resolveFollowupTarget,
  resolveLeadTarget,
} from '@/lib/quote/followup-contact'
import { normaliseAuMobile } from '@/lib/phone/au'
import { followupTargetQuery } from '@/lib/quote/followup-operation-contract'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// Full history: a real SMS thread is tens of turns, so return the whole
// conversation (bounded only by a generous safety cap so a pathological
// row can't blow the payload). The compose modal + card both show it all.
const MSG_QUERY_LIMIT = 2000

async function tenantFromBearer(req: Request) {
  // Dual-auth: Clerk session token OR legacy Supabase token → tenant row.
  const resolved = await resolveTenantRequest(supabase, req, 'id')
  return (resolved?.tenant ?? null) as { id: string } | null
}

export async function GET(req: Request) {
  try {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // Accept a quoteId (quote follow-up) OR a conversationId (a no-quote
  // SMS lead). Either resolves the destination phone server-side,
  // ownership-guarded — the phone is never trusted from the request.
  const url = new URL(req.url)
  const query = followupTargetQuery.safeParse(Object.fromEntries(url.searchParams))
  if (!query.success ||
      [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) {
    return Response.json(
      { ok: false, error: 'quoteId or conversationId is required' },
      { status: 400 },
    )
  }
  const quoteId = query.data.quoteId
  const conversationId = query.data.conversationId

  const target = conversationId
    ? await resolveLeadTarget(supabase, conversationId, tenant.id)
    : await resolveFollowupTarget(supabase, quoteId as string, tenant.id)
  if (!target.ok) {
    return Response.json({ ok: false, error: target.code }, { status: target.code === 'unavailable' ? 503 : 404 })
  }

  const rawPhone = target.phone?.trim() ?? ''
  const e164 = normaliseAuMobile(rawPhone)
  // Match on both the canonical E.164 and whatever raw form might have
  // been stored on older rows, scoped to this tenant.
  const fromCandidates = Array.from(
    new Set([e164, rawPhone].filter((v): v is string => !!v)),
  )

  const emptyResponse = () =>
    Response.json({
      ok: true,
      customer: { name: target.name, phone: (e164 ?? rawPhone) || null },
      messages: [],
      last_inbound_at: null,
      last_outbound_at: null,
    })

  // Scope the thread to the SPECIFIC quote when this is a quote follow-up.
  // A customer with several quotes on one phone shares a single active SMS
  // thread, so a naive phone-number merge bleeds an unrelated job's chat
  // into this modal (e.g. a roof conversation showing under a Ceiling Fans
  // follow-up). The follow-up thread is phone-level (intake_id may be NULL)
  // and is scoped by the followup_quote PIN, so match by the pin first, then
  // by the quote's own intake, and only fall back to the phone-level merge
  // for legacy threads / no-quote leads.
  let convoIds: string[] = conversationId ? [conversationId] : []

  if (quoteId) {
    // (a) the thread this quote's follow-up was pinned onto (the ground truth)
    const { data: pinned, error: pinnedError } = await supabase
      .from('sms_conversations')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('followup_quote->>quote_id', quoteId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
    if (pinnedError) return Response.json({ ok: false, error: 'history_unavailable' }, { status: 503 })
    convoIds = (pinned ?? []).map((c) => c.id as string)

    // (b) fall back to conversations tied to this quote's own intake
    if (convoIds.length === 0) {
      const { data: quoteRow, error: quoteError } = await supabase
        .from('quotes')
        .select('intake_id')
        .eq('id', quoteId)
        .eq('tenant_id', tenant.id)
        .maybeSingle()
      if (quoteError || !quoteRow) return Response.json({ ok: false, error: 'history_unavailable' }, { status: 503 })
      const intakeId = (quoteRow?.intake_id as string | null) ?? null
      if (intakeId) {
        const { data: byIntake, error: intakeError } = await supabase
          .from('sms_conversations')
          .select('id')
          .eq('tenant_id', tenant.id)
          .eq('intake_id', intakeId)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .order('id', { ascending: false })
        if (intakeError) return Response.json({ ok: false, error: 'history_unavailable' }, { status: 503 })
        convoIds = (byIntake ?? []).map((c) => c.id as string)
      }
    }
  }

  // (c) Legacy quote fallback after successful empty quote-scoped reads.
  // Leads retain their exact owned conversation; they never merge by phone.
  if (convoIds.length === 0) {
    if (fromCandidates.length === 0) return emptyResponse()
    const { data: convos, error: conversationError } = await supabase
      .from('sms_conversations')
      .select('id')
      .eq('tenant_id', tenant.id)
      .in('from_number', fromCandidates)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(10)
    if (conversationError) return Response.json({ ok: false, error: 'history_unavailable' }, { status: 503 })
    convoIds = (convos ?? []).map((c) => c.id as string)
  }

  if (convoIds.length === 0) return emptyResponse()

  const { data: msgs, error: messagesError } = await supabase
    .from('sms_messages')
    .select('direction, body, created_at')
    .in('conversation_id', convoIds)
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(MSG_QUERY_LIMIT)
  if (messagesError) return Response.json({ ok: false, error: 'history_unavailable' }, { status: 503 })

  type Msg = { direction: 'inbound' | 'outbound'; body: string; created_at: string }
  const all: Msg[] = (msgs ?? []).map((m) => ({
    direction: m.direction as 'inbound' | 'outbound',
    body: (m.body as string) ?? '',
    created_at: m.created_at as string,
  }))
  // Return the FULL thread, oldest-first for display.
  const recent = all

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
  } catch { return Response.json({ ok: false, error: 'history_unavailable' }, { status: 503 }) }
}
