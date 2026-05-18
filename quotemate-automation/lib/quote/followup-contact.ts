// Resolve who a follow-up should reach, server-side, from a quoteId.
//
// The destination phone is NEVER taken from the client request — that
// would let a signed-in tradie spray texts/calls at arbitrary numbers on
// our Twilio account. We re-derive it from quote → intake → caller /
// customer, scoped to the caller's tenant (ownership guard built in).

import type { SupabaseClient } from '@supabase/supabase-js'

export type FollowupTarget =
  | { ok: true; phone: string | null; name: string | null; quoteId: string }
  | { ok: false; code: 'not_found' }

export async function resolveFollowupTarget(
  supabase: SupabaseClient,
  quoteId: string,
  tenantId: string,
): Promise<FollowupTarget> {
  const { data: q } = await supabase
    .from('quotes')
    .select('id, intake_id')
    .eq('id', quoteId)
    .eq('tenant_id', tenantId) // ownership guard — foreign quote → not_found
    .maybeSingle()
  if (!q) return { ok: false, code: 'not_found' }

  let phone: string | null = null
  let name: string | null = null

  if (q.intake_id) {
    const { data: i } = await supabase
      .from('intakes')
      .select('caller, customer_id')
      .eq('id', q.intake_id)
      .maybeSingle()
    const caller =
      (i?.caller as { name?: string; phone?: string } | null) ?? null
    phone = caller?.phone?.trim() || null
    name = caller?.name?.trim() || null

    if ((!phone || !name) && i?.customer_id) {
      const { data: c } = await supabase
        .from('customers')
        .select('phone_number, full_name, first_name')
        .eq('id', i.customer_id)
        .maybeSingle()
      phone = phone || ((c?.phone_number as string | null) ?? null)
      name =
        name ||
        ((c?.full_name as string | null) ?? null) ||
        ((c?.first_name as string | null) ?? null)
    }
  }

  return { ok: true, phone, name, quoteId: q.id as string }
}
