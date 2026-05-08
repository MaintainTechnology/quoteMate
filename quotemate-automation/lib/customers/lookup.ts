// ════════════════════════════════════════════════════════════════════
// Customer memory — keyed by phone number across voice + SMS.
//
// Two functions:
//   findOrCreateCustomer(phone, channel)
//     Looked up at every inbound. Creates a stub if no row exists yet.
//     Returns the full customer profile.
//
//   updateCustomerFromIntake(customerId, intake, channel)
//     Called after Opus structures the intake. Writes-back name, suburb,
//     address, email if present. Bumps last_contacted_at + total_quotes.
//     If a field is already set on the customer row, it's only overwritten
//     when the new value is materially different (so a tradie's edit isn't
//     wiped by a stale Opus extraction).
//
// Both are idempotent. Both fail-soft — log + return null/no-op rather
// than throw, so a customer-memory write hiccup never breaks the quote
// pipeline.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export type CustomerProfile = {
  id: string
  phone_number: string
  first_name: string | null
  full_name: string | null
  email: string | null
  address: string | null
  suburb: string | null
  notes: string | null
  preferred_channel: 'voice' | 'sms' | null
  total_quotes: number
  total_bookings: number
  first_contacted_at: string
  last_contacted_at: string
}

/**
 * Look up the customer for this phone number. Create a stub if missing.
 * Returns null only on database error (rare; fail-soft so callers keep working).
 */
export async function findOrCreateCustomer(
  phoneNumber: string,
  channel: 'voice' | 'sms',
): Promise<CustomerProfile | null> {
  if (!phoneNumber) return null

  // Try to find existing.
  const { data: existing, error: lookupErr } = await supabase
    .from('customers')
    .select('*')
    .eq('phone_number', phoneNumber)
    .maybeSingle()

  if (lookupErr) {
    console.error('[customers] lookup failed', { phoneNumber, err: lookupErr.message })
    return null
  }

  if (existing) {
    // Bump last_contacted_at + preferred_channel (latest channel used wins).
    const { error: bumpErr } = await supabase
      .from('customers')
      .update({
        last_contacted_at: new Date().toISOString(),
        preferred_channel: channel,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
    if (bumpErr) {
      console.error('[customers] bump last_contacted_at failed', { id: existing.id, err: bumpErr.message })
    }
    return existing as CustomerProfile
  }

  // Create stub.
  const { data: created, error: createErr } = await supabase
    .from('customers')
    .insert({
      phone_number: phoneNumber,
      preferred_channel: channel,
    })
    .select()
    .single()

  if (createErr || !created) {
    // Race-condition fallback: another inbound may have created the row in
    // parallel (unique constraint on phone_number triggers 23505). Re-fetch.
    if (createErr?.code === '23505') {
      const { data: raced } = await supabase
        .from('customers')
        .select('*')
        .eq('phone_number', phoneNumber)
        .maybeSingle()
      return (raced as CustomerProfile) ?? null
    }
    console.error('[customers] create failed', { phoneNumber, err: createErr?.message })
    return null
  }

  return created as CustomerProfile
}

/**
 * Write extracted intake fields back onto the customer row.
 * Called after /api/intake/structure has Opus-extracted name + suburb + etc.
 * Only fills in fields that are blank on the customer OR materially changed.
 *
 * Preserves tradie-set values: if the customer row has a non-null value for
 * a field, we only overwrite when the new value is non-null AND different.
 * (Empty / placeholder Opus extractions are ignored.)
 */
export async function updateCustomerFromIntake(opts: {
  customerId: string | null
  intake: {
    caller?: { name?: string | null; email?: string | null } | null
    address?: string | null
    suburb?: string | null
  }
}): Promise<void> {
  if (!opts.customerId) return

  const { data: cust, error: fetchErr } = await supabase
    .from('customers')
    .select('*')
    .eq('id', opts.customerId)
    .maybeSingle()

  if (fetchErr || !cust) {
    console.error('[customers] fetch for update failed', { customerId: opts.customerId, err: fetchErr?.message })
    return
  }

  const newFullName = (opts.intake.caller?.name ?? '').trim() || null
  const newFirstName = newFullName ? newFullName.split(/\s+/)[0] : null
  const newEmail = (opts.intake.caller?.email ?? '').trim() || null
  const newAddress = (opts.intake.address ?? '').trim() || null
  const newSuburb = (opts.intake.suburb ?? '').trim() || null

  const update: Record<string, unknown> = {
    last_contacted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    total_quotes: (cust.total_quotes ?? 0) + 1,
  }

  // Only overwrite when a meaningful new value differs from the stored one.
  // Empty / null new values never overwrite a stored value.
  if (newFullName && newFullName !== cust.full_name) update.full_name = newFullName
  if (newFirstName && newFirstName !== cust.first_name) update.first_name = newFirstName
  if (newEmail && newEmail !== cust.email) update.email = newEmail
  if (newAddress && newAddress !== cust.address) update.address = newAddress
  if (newSuburb && newSuburb !== cust.suburb) update.suburb = newSuburb

  const { error: updErr } = await supabase
    .from('customers')
    .update(update)
    .eq('id', opts.customerId)

  if (updErr) {
    console.error('[customers] update from intake failed', { customerId: opts.customerId, err: updErr.message })
  }
}

/**
 * Render a compact "KNOWN CUSTOMER" block for the dialog system prompt.
 * Returns null if there's nothing useful to inject (stub customer with no
 * fields populated).
 *
 * Conservative re-engagement design:
 *   - Greeting stays neutral (no name leak — someone else may have the phone).
 *   - If first_name is known, skip the "what's your first name?" question
 *     silently and use the name in later acknowledgements.
 *   - If suburb is known, REPLACE the standard "what suburb?" question with
 *     an address-confirmation handshake ("still at the Bondi place, right?").
 *   - On correction ("Coogee now"), the new value flows through to the
 *     post-intake updateCustomerFromIntake() and overwrites the row.
 */
export function formatCustomerContext(c: CustomerProfile | null): string | null {
  if (!c) return null
  const known: string[] = []
  if (c.first_name) known.push(`first_name: ${c.first_name}`)
  if (c.full_name && c.full_name !== c.first_name) known.push(`full_name: ${c.full_name}`)
  if (c.suburb) known.push(`suburb: ${c.suburb}`)
  if (c.address) known.push(`address: ${c.address}`)
  if (c.email) known.push(`email: ${c.email}`)
  if (c.total_quotes > 0) known.push(`total_quotes_with_us: ${c.total_quotes}`)
  if (known.length === 0) return null

  const suburbExample = c.suburb ?? 'Bondi'
  const nameExample = c.first_name ?? 'Sam'

  return [
    'KNOWN CUSTOMER MEMORY — apply conservative re-engagement.',
    '',
    'GREETING: stay neutral. Do NOT volunteer the name in the welcome',
    'line. Someone else may be holding the phone. Rule 9 Case B applies',
    'unchanged ("Welcome back — what can I help you with this time?").',
    '',
    'NAME: if first_name is known, skip the "what\'s your first name?"',
    'question silently — treat the name as already captured. Use it in',
    'acknowledgements once the customer has engaged with the new request',
    `(e.g. "Cheers ${nameExample} — ...").`,
    '',
    'SUBURB: if suburb is known, REPLACE the standard "and what suburb',
    'is the job in?" question with an address-confirmation handshake:',
    `  ✓ "Cheers ${nameExample} — still at the ${suburbExample} place, right?"`,
    `  ✓ "Got it — still at the same ${suburbExample} spot?"`,
    'If the customer affirms ("yep", "still there"), use the stored',
    'suburb and move to the next missing field — do NOT ask again.',
    'If they correct ("Coogee now" / "this job\'s at my mum\'s in Penrith"),',
    'use the new suburb for this conversation. The post-intake write-back',
    'will reconcile the customers row.',
    '',
    'KNOWN FIELDS (do NOT re-ask):',
    ...known.map(k => `  - ${k}`),
  ].join('\n')
}
