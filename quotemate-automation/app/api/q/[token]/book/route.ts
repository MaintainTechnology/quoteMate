// Booking endpoint — called by the SlotPicker on the booking page.
// Persists `quotes.scheduled_at`, sets status='accepted' + accepted_at,
// and removes the picked slot from `tradies.available_slots`.
//
// Hardening rules (any failure → 4xx, no partial writes):
//   - share_token must resolve to a quote
//   - quote.paid_at must be set (no booking before deposit)
//   - quote.scheduled_at must be null (no double-booking same quote)
//   - slot must currently be in the tradie's available_slots
//   - slot must be a parseable ISO timestamp in the future
//
// Uses two sequential updates rather than a transaction. Race window
// (two customers picking the same slot at once) is tolerated for v0.5
// single-tradie. When tradie #2 onboards, wrap in a stored procedure.

import { createClient } from '@supabase/supabase-js'
import { pipelineLog } from '@/lib/log/pipeline'

export const maxDuration = 30

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const log = pipelineLog('dispatch')
  const { token } = await ctx.params
  log.step('booking attempt', { token: token.slice(0, 8) + '…' })

  let body: { slot?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const slot = typeof body.slot === 'string' ? body.slot : null
  if (!slot) {
    return Response.json({ ok: false, error: 'slot is required' }, { status: 400 })
  }

  const slotMs = Date.parse(slot)
  if (!Number.isFinite(slotMs)) {
    return Response.json({ ok: false, error: 'slot is not a valid ISO timestamp' }, { status: 400 })
  }
  if (slotMs <= Date.now()) {
    return Response.json({ ok: false, error: 'slot must be in the future' }, { status: 400 })
  }

  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .select('id, paid_at, scheduled_at, share_token')
    .eq('share_token', token)
    .maybeSingle()

  if (quoteErr) {
    log.err('quote lookup failed', quoteErr.message)
    return Response.json({ ok: false, error: 'Lookup failed' }, { status: 500 })
  }
  if (!quote) {
    return Response.json({ ok: false, error: 'Quote not found' }, { status: 404 })
  }
  if (!quote.paid_at) {
    return Response.json({ ok: false, error: 'Pay your deposit first' }, { status: 409 })
  }
  if (quote.scheduled_at) {
    return Response.json({ ok: false, error: 'This quote is already scheduled' }, { status: 409 })
  }

  const { data: tradie, error: tradieErr } = await supabase
    .from('tradies')
    .select('id, available_slots')
    .limit(1)
    .maybeSingle()

  if (tradieErr) {
    log.err('tradie lookup failed', tradieErr.message)
    return Response.json({ ok: false, error: 'Lookup failed' }, { status: 500 })
  }
  if (!tradie) {
    return Response.json({ ok: false, error: 'No tradie configured' }, { status: 409 })
  }

  const currentSlots: string[] = Array.isArray(tradie.available_slots)
    ? (tradie.available_slots as string[])
    : []

  if (!currentSlots.includes(slot)) {
    log.err('slot not available', null, {
      slot,
      currentSlots: currentSlots.slice(0, 10),
    })
    return Response.json({ ok: false, error: 'That slot is no longer available' }, { status: 409 })
  }

  const remainingSlots = currentSlots.filter((s) => s !== slot)
  const nowIso = new Date().toISOString()

  const { error: quoteUpdateErr } = await supabase
    .from('quotes')
    .update({
      scheduled_at: slot,
      status: 'accepted',
      accepted_at: nowIso,
    })
    .eq('id', quote.id)

  if (quoteUpdateErr) {
    log.err('quote update failed', quoteUpdateErr.message, { quote_id: quote.id })
    return Response.json({ ok: false, error: 'Failed to lock in slot' }, { status: 500 })
  }

  const { error: tradieUpdateErr } = await supabase
    .from('tradies')
    .update({ available_slots: remainingSlots })
    .eq('id', tradie.id)

  if (tradieUpdateErr) {
    // Quote is already marked scheduled. Log loudly so the operator can
    // manually reconcile the tradie's slot list, but don't fail the request.
    log.err('tradie slot list update failed (quote IS booked, slot list NOT pruned)', tradieUpdateErr.message, {
      quote_id: quote.id,
      tradie_id: tradie.id,
      slot,
    })
  }

  log.done('quote booked', { quote_id: quote.id, slot })
  return Response.json({ ok: true, scheduled_at: slot })
}
