import type { SupabaseClient } from '@supabase/supabase-js'

const DELETE_REASONS = new Set([
  'not_found', 'quote_already_paid', 'quote_has_chain', 'quote_has_operation_history',
  'quote_not_private_draft', 'quote_has_public_link', 'quote_has_checkout', 'quote_has_saved_job',
  'quote_has_workflow_history', 'quote_has_payment_history', 'quote_changed',
])

export function knownQuoteDeleteReason(value: unknown): value is string {
  return typeof value === 'string' && DELETE_REASONS.has(value)
}

/** A missing migration/failed read disables deletion while keeping the quote readable. */
export async function quoteDeletionPermission(db: SupabaseClient, tenantId: string, quoteId: string) {
  try {
    const { data, error } = await db.rpc('quote_deletion_permission', { p_tenant_id: tenantId, p_quote_id: quoteId })
    if (!error && data?.allowed === true && data.reason === null) return { allowed: true, reason: null }
    if (!error && data?.allowed === false && knownQuoteDeleteReason(data.reason)) return { allowed: false, reason: data.reason }
  } catch { /* No write is attempted from this read capability. */ }
  return { allowed: false, reason: 'quote_delete_unavailable' }
}
