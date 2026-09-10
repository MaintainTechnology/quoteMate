import type { SupabaseClient } from '@supabase/supabase-js'
import { normaliseAuMobile } from '@/lib/phone/au'
import type { CustomerContact } from './send-customer'

type Row = Record<string, unknown>
export class QuoteDeliveryRecipientError extends Error {
  constructor(
    readonly code: 'invalid_expected_recipient' | 'quote_recipient_changed' | 'quote_contact_unavailable',
    readonly status: 400 | 409 | 503,
  ) {
    super(code === 'quote_recipient_changed'
      ? 'The customer recipient changed. Open the current quote and confirm the recipient again.'
      : code === 'invalid_expected_recipient'
        ? 'Review a customer recipient before sending.'
        : 'The owned customer contact could not be confirmed. Refresh the quote before sending.')
    this.name = 'QuoteDeliveryRecipientError'
  }
}

function canonicalRecipient(channel: 'sms' | 'email', input: unknown): string | null {
  if (typeof input !== 'string' || /[\u0000-\u001f\u007f]/.test(input)) return null
  const value = input.trim()
  if (!value) return null
  // Preserve existing foreign-number policy: only known AU formats are
  // normalized; all other stored recipients require an exact reviewed value.
  if (channel === 'sms') return normaliseAuMobile(value) ?? value
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return null
  // Domain names are case-insensitive; do not assume that of an email local part.
  return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`
}

/** Additive for legacy web callers. Native always supplies a nonempty reviewed
 * recipient. Never use this field as a destination override: compare it to the
 * already resolved destination before any release/outbox/provider action. */
export function assertExpectedQuoteRecipient(
  channel: 'sms' | 'email', expected: unknown, resolvedRecipient: string | null,
): void {
  if (expected === undefined) return
  const reviewed = canonicalRecipient(channel, expected)
  if (!reviewed) throw new QuoteDeliveryRecipientError('invalid_expected_recipient', 400)
  if (reviewed !== canonicalRecipient(channel, resolvedRecipient))
    throw new QuoteDeliveryRecipientError('quote_recipient_changed', 409)
}

function text(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new QuoteDeliveryRecipientError('quote_contact_unavailable', 503)
  return value.trim() || null
}
async function ownedRead(
  query: PromiseLike<{ data: Row | null; error: unknown }>, tenantId: string,
): Promise<Row | null> {
  try {
    const { data, error } = await query
    if (error || (data && data.tenant_id !== tenantId)) throw new Error('Unconfirmed contact')
    return data
  } catch {
    throw new QuoteDeliveryRecipientError('quote_contact_unavailable', 503)
  }
}

/** Same existing contact precedence, with explicit ownership and read proof.
 * A failed higher-priority read is unknown, never permission to select a lower
 * priority customer. Pass only an intake read successfully for this tenant. */
export async function resolveOwnedQuoteCustomerContact(
  db: SupabaseClient, tenantId: string, intake: Row | null,
): Promise<CustomerContact> {
  if (!tenantId || !intake || intake.tenant_id !== tenantId || typeof intake.id !== 'string')
    throw new QuoteDeliveryRecipientError('quote_contact_unavailable', 503)
  const caller = intake.caller
  if (caller != null && (typeof caller !== 'object' || Array.isArray(caller)))
    throw new QuoteDeliveryRecipientError('quote_contact_unavailable', 503)
  let phone = text((caller as Row | null)?.phone)
  let email = text((caller as Row | null)?.email)
  const callId = text(intake.call_id)
  const customerId = text(intake.customer_id)
  if (!phone) {
    const row = await ownedRead(db.from('sms_conversations')
      .select('id,tenant_id,from_number').eq('tenant_id', tenantId).eq('intake_id', intake.id)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle(), tenantId)
    phone = text(row?.from_number)
  }
  if (!phone && callId) {
    const row = await ownedRead(db.from('calls').select('id,tenant_id,caller_number')
      .eq('tenant_id', tenantId).eq('id', callId).maybeSingle(), tenantId)
    phone = text(row?.caller_number)
  }
  if ((!phone || !email) && customerId) {
    const row = await ownedRead(db.from('customers').select('id,tenant_id,phone_number,email')
      .eq('tenant_id', tenantId).eq('id', customerId).maybeSingle(), tenantId)
    phone = phone ?? text(row?.phone_number)
    email = email ?? text(row?.email)
  }
  return { phone, email }
}
