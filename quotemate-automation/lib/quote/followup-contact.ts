// Resolve who a follow-up should reach, server-side, from a quoteId.
//
// The destination phone is NEVER taken from the client request — that
// would let a signed-in tradie spray texts/calls at arbitrary numbers on
// our Twilio account. We re-derive it from quote → intake → caller /
// customer, scoped to the caller's tenant (ownership guard built in).

import type { SupabaseClient } from '@supabase/supabase-js'

export type FollowupTarget =
  | {
      ok: true
      phone: string | null
      name: string | null
      quoteId: string | null
      conversationId?: string | null
    }
  | { ok: false; code: 'not_found' | 'unavailable' }

function contactText(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('Malformed contact')
  return value.trim() || null
}

export async function resolveFollowupTarget(
  supabase: SupabaseClient,
  quoteId: string,
  tenantId: string,
): Promise<FollowupTarget> {
  try {
  const { data: q, error: quoteError } = await supabase
    .from('quotes')
    .select('id, intake_id')
    .eq('id', quoteId)
    .eq('tenant_id', tenantId) // ownership guard — foreign quote → not_found
    .maybeSingle()
  if (quoteError) return { ok: false, code: 'unavailable' }
  if (!q) return { ok: false, code: 'not_found' }

  let phone: string | null = null
  let name: string | null = null

  if (q.intake_id) {
    const { data: i, error: intakeError } = await supabase
      .from('intakes')
      .select('caller, customer_id')
      .eq('id', q.intake_id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (intakeError || !i) return { ok: false, code: 'unavailable' }
    const caller =
      (i?.caller as { name?: string; phone?: string } | null) ?? null
    if (caller != null && (typeof caller !== 'object' || Array.isArray(caller)))
      return { ok: false, code: 'unavailable' }
    phone = contactText(caller?.phone)
    name = contactText(caller?.name)

    if ((!phone || !name) && i?.customer_id) {
      const { data: c, error: customerError } = await supabase
        .from('customers')
        .select('phone_number, full_name, first_name')
        .eq('id', i.customer_id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (customerError || !c) return { ok: false, code: 'unavailable' }
      phone = phone || contactText(c.phone_number)
      name = name || contactText(c.full_name) || contactText(c.first_name)
    }
  }

  return { ok: true, phone, name, quoteId: q.id as string, conversationId: null }
  } catch { return { ok: false, code: 'unavailable' } }
}

// Resolve a no-quote SMS lead's contact from a conversationId. Same
// server-side, ownership-guarded posture as resolveFollowupTarget: the
// phone is taken from the tenant's own sms_conversations row, never from
// the client — so a tradie can't text/ring an arbitrary number by
// passing a foreign conversationId (it resolves to not_found).
export async function resolveLeadTarget(
  supabase: SupabaseClient,
  conversationId: string,
  tenantId: string,
): Promise<FollowupTarget> {
  try {
  const { data: c, error } = await supabase
    .from('sms_conversations')
    .select('id, from_number, conversation_state')
    .eq('id', conversationId)
    .eq('tenant_id', tenantId) // ownership guard — foreign convo → not_found
    .maybeSingle()
  if (error) return { ok: false, code: 'unavailable' }
  if (!c) return { ok: false, code: 'not_found' }

  const slots =
    ((c.conversation_state as { slots?: Record<string, unknown> } | null)
      ?.slots ?? {}) as Record<string, unknown>
  const first =
    typeof slots.first_name === 'string' ? slots.first_name.trim() : ''
  const phone = contactText(c.from_number)

  return {
    ok: true,
    phone,
    name: first || null,
    quoteId: null,
    conversationId: c.id as string,
  }
  } catch { return { ok: false, code: 'unavailable' } }
}
