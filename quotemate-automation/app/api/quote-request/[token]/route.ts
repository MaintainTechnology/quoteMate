// Public self-serve quote-request form — POST handler, every trade.
//
// spec: specs/generic-quote-request-form.md §3.
//
// Token = trade_lead_requests.token. No auth: the unguessable token IS the
// capability, exactly like the public quote pages and /api/paint-request.
// One-shot — a submitted link cannot be re-run.
//
// Order of operations, and why:
//   1. load the lead (error CHECKED — a PostgREST outage is a 503, not
//      "your link is invalid")
//   2. validate the body against the schema for THAT lead's trade
//   3. CLAIM the token with a conditional update (status pending → submitted).
//      This is the one-shot gate AND the double-submit guard: a second tab
//      matches zero rows and gets a 409 instead of a second quote.
//   4. write the submission onto the SMS thread (the electrical/plumbing
//      hand-off structures the transcript, so an unwritten brief means a
//      quote drafted off nothing)
//   5. run that trade's estimate path — the SAME one the SMS gather uses,
//      by calling that trade's own dispatcher module rather than re-doing
//      its steps here (see runHandoff)
//   6. on any failure, RELEASE the claim (status back to pending) and
//      return non-2xx. Never 200 on a failed write or hand-off.
//
// Differences from the painting reference are deliberate, not drift: it
// returns 200 on a failed estimate, bare-awaits its mark-submitted write,
// and reads a lead-lookup error as an invalid link. All three are fixed here.
//
// The response's `texted` is a delivery FACT (true / false / null-for-not-mine),
// never a hopeful literal — the thank-you page branches on it, so claiming a
// send Twilio refused puts "your quote is on its way" in front of a customer
// who is getting nothing.

import { createClient } from '@supabase/supabase-js'
import { isQuoteRequestTrade, type QuoteRequestTrade } from '@/lib/quote-request/fields'
import {
  intakeJobTypeHint,
  parseQuoteRequest,
  summariseSubmission,
  type QuoteRequestData,
} from '@/lib/quote-request/schema'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { estimateAndDispatchPainting } from '@/lib/sms/painting-estimate-dispatch'
import { measureAndDispatchRoofing } from '@/lib/sms/roofing-measure-dispatch'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MultiRoofQuote } from '@/lib/roofing/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// The estimate is awaited inline (a provider measure, or the whole Opus
// intake→draft chain) so a failure can be reported honestly instead of
// disappearing into after().
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// APEX, never www: the www host 307-redirects cross-origin and strips
// Authorization, which 401s the internal intake hand-off below.
//
// APP_URL FIRST, and that order is load-bearing — every other internal
// self-caller reads APP_URL (app/api/q/choose/[token], app/api/sms/inbound,
// app/api/vapi/webhook), while NEXT_PUBLIC_APP_URL is the repo's *www*
// variable (lib/sms/roofing-measure-dispatch.ts defaults it to
// https://www.quotemax.com.au). Preferring NEXT_PUBLIC_APP_URL here would
// make this one route POST the hand-off to www, take the 307, lose the
// Authorization header and 502 every electrical/plumbing submission while
// its siblings kept working.
const APP_BASE_URL = (
  process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://quotemax.com.au'
).replace(/\/$/, '')

type Lead = {
  token: string
  trade: string
  tenant_id: string | null
  conversation_id: string | null
  customer_phone: string | null
  status: string
}

type Conversation = { to_number: string | null; conversation_state: Record<string, unknown> | null }

/** What a trade's estimate path reports back. `ok:false` releases the claim.
 *
 *  `texted` is a THREE-state delivery fact, never a wish:
 *    true  — a carrier accepted the customer's message on this request
 *    false — a send was attempted and refused (or nothing could be sent);
 *            the thank-you page must NOT say the quote is on its way
 *    null  — nobody sent anything here: the async intake pipeline owns the
 *            customer's SMS (electrical / plumbing), so this request cannot
 *            report on it either way.
 *  Hardcoding `true` is the silent-failure class this field exists to close. */
type Handoff =
  | { ok: true; quoteToken: string | null; inspection: boolean; texted?: boolean | null }
  | { ok: false; reason: string }

const fail = (status: number, error: string, extra?: Record<string, unknown>) =>
  Response.json({ ok: false, error, ...extra }, { status })

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  // 1. Load the lead. supabase-js RESOLVES { data, error } — the error is
  //    checked so an outage never renders as "invalid or expired link".
  const { data: leadRow, error: leadErr } = await supabase
    .from('trade_lead_requests')
    .select('token, trade, tenant_id, conversation_id, customer_phone, status')
    .eq('token', token)
    .maybeSingle()
  if (leadErr) {
    console.error('[quote-request] lead lookup failed', leadErr.message)
    return fail(503, 'lookup_failed')
  }
  if (!leadRow) return fail(404, 'invalid_link')

  const lead = leadRow as Lead
  if (lead.status === 'submitted') return fail(409, 'already_submitted')
  if (lead.status !== 'pending') return fail(410, 'link_expired')
  if (!isQuoteRequestTrade(lead.trade)) {
    console.error('[quote-request] lead carries a trade this form cannot serve', lead.trade)
    return fail(500, 'unsupported_trade')
  }

  // 2. Body + per-trade Zod. Both before any write.
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return fail(400, 'invalid_json')
  }
  const parsed = parseQuoteRequest(lead.trade, body)
  if (!parsed.ok) return fail(400, 'invalid_request', { issues: parsed.issues })
  const data = parsed.data

  // 3. Claim the token. Conditional on status='pending', so two concurrent
  //    submits cannot both proceed — the loser matches zero rows.
  const { data: claimed, error: claimErr } = await supabase
    .from('trade_lead_requests')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() })
    .eq('token', token)
    .eq('status', 'pending')
    .select('token')
  if (claimErr) {
    console.error('[quote-request] claim write failed', claimErr.message)
    return fail(503, 'claim_failed')
  }
  if (!Array.isArray(claimed) || claimed.length === 0) return fail(409, 'already_submitted')

  const release = async () => {
    const { error } = await supabase
      .from('trade_lead_requests')
      .update({ status: 'pending', submitted_at: null })
      .eq('token', token)
    if (error) {
      // The customer sees a non-2xx either way; this only means the link
      // stays spent. Loud, because it needs a human to reopen it.
      console.error('[quote-request] could not release the claimed link', token, error.message)
    }
  }

  try {
    // 4. Put the submission on the thread. Load the conversation once —
    //    the roofing branch needs its from-number, electrical/plumbing need
    //    its state, and both need the message written.
    let conv: Conversation | null = null
    if (lead.conversation_id) {
      const { data: c, error: convErr } = await supabase
        .from('sms_conversations')
        .select('to_number, conversation_state')
        .eq('id', lead.conversation_id)
        .maybeSingle()
      if (convErr) {
        console.error('[quote-request] conversation lookup failed', convErr.message)
        await release()
        return fail(502, 'thread_read_failed')
      }
      conv = (c as Conversation | null) ?? null

      const { error: msgErr } = await supabase.from('sms_messages').insert({
        conversation_id: lead.conversation_id,
        direction: 'inbound',
        body: summariseSubmission(data),
      })
      if (msgErr) {
        // Fatal on purpose: /api/intake/structure structures the TRANSCRIPT,
        // so a dropped message means electrical/plumbing would be quoted off
        // a brief the customer never gave.
        console.error('[quote-request] could not write the submission to the thread', msgErr.message)
        await release()
        return fail(502, 'thread_write_failed')
      }
    }

    // 5. Trade's own estimate path.
    const handoff = await runHandoff({ lead, trade: lead.trade, data, conv })
    if (!handoff.ok) {
      console.error('[quote-request] estimate hand-off failed', lead.trade, handoff.reason)
      await release()
      return fail(502, 'estimate_failed', { reason: handoff.reason })
    }

    if (handoff.quoteToken) {
      const { error: tokErr } = await supabase
        .from('trade_lead_requests')
        .update({ quote_token: handoff.quoteToken })
        .eq('token', token)
      // Best-effort BY DESIGN, and the only write here that is: the quote
      // has already been produced and texted. A non-2xx now would send the
      // customer back to resubmit and quote them twice. Ops-visible instead.
      if (tokErr) console.error('[quote-request] quote_token not recorded', token, tokErr.message)
    }

    return Response.json({
      ok: true,
      inspection: handoff.inspection,
      texted: handoff.texted ?? null,
    })
  } catch (e) {
    console.error('[quote-request] unhandled failure', e)
    await release()
    return fail(500, 'server_error')
  }
}

async function runHandoff(args: {
  lead: Lead
  trade: QuoteRequestTrade
  data: QuoteRequestData
  conv: Conversation | null
}): Promise<Handoff> {
  const { lead, data, conv } = args
  const client = supabase as unknown as SupabaseClient

  // ── Roofing and painting: hand the brief to that trade's SHARED SMS
  //    dispatcher — the very module the receptionist's Q&A gather calls on
  //    its last answer (lib/sms/roofing-measure-dispatch.ts,
  //    lib/sms/painting-estimate-dispatch.ts). Spec §3: "the same estimate
  //    path the SMS gather uses for that trade". Calling the halves by hand
  //    is what dropped the tradie notification, the holding SMS and the
  //    conversation state on this origin; there is only one path now, so
  //    they cannot drift apart again.
  //
  //    Each dispatcher owns the customer message, the tradie notification
  //    (painting: notifyPaintingTradie inside it; roofing: fired below,
  //    because roofing's dispatcher has never carried one) and returns the
  //    conversation state. This route owns the transport and persisting it.
  if (data.trade === 'painting' || data.trade === 'roofing') {
    // Both dispatchers text the customer from the tenant's number and record
    // the turn on the thread, so both need the thread they were offered from.
    if (!lead.conversation_id || !lead.customer_phone) {
      return { ok: false, reason: `${data.trade} needs the SMS thread it was offered from` }
    }
    const conversationId = lead.conversation_id
    const customerPhone = lead.customer_phone

    const { data: t } = lead.tenant_id
      ? await supabase
          .from('tenants')
          .select('trade, twilio_sms_number, owner_mobile, owner_first_name')
          .eq('id', lead.tenant_id)
          .maybeSingle()
      : { data: null }
    const tenant =
      (t as {
        trade?: string | null
        twilio_sms_number?: string | null
        owner_mobile?: string | null
        owner_first_name?: string | null
      } | null) ?? null
    const fromNumber = conv?.to_number ?? tenant?.twilio_sms_number ?? null

    // The shared dispatcher sends saved-draft status only; approval sends the quote.
    const sendReply = async (text: string, mediaUrl?: string): Promise<{ ok: boolean }> => {
      const res = await dispatchQuoteMessage({ to: customerPhone, from: fromNumber ?? undefined, text, mediaUrl, audience: 'customer', tenantId: lead.tenant_id, conversationId, deliveryKey: `quote-form:${lead.token}:status` })
      if (!res.ok) {
        console.error('[quote-request] Twilio rejected the customer reply', data.trade, res.smsAttempt)
        return { ok: false }
      }
      return { ok: true }
    }

    /** Persist the state the dispatcher handed back. Not fatal — the quote
     *  exists and the customer has it — but a thread that forgot it re-asks
     *  a job it already quoted (painting sat pinned at 'offer_form' and
     *  restarted the whole Q&A on the customer's next message). */
    const persistThreadState = async (
      column: 'painting_state' | 'roofing_state',
      state: unknown,
    ) => {
      const { error } = await supabase
        .from('sms_conversations')
        .update({ [column]: state, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
      if (error) console.error(`[quote-request] ${column} not persisted`, error.message)
    }

    if (data.trade === 'painting') {
      const i = data.inputs
      // estimateAndDispatchPainting owns: estimate + save + auto-send (or
      // the inspection message), the holding SMS when the send is refused,
      // the release revert, and notifyPaintingTradie with customerTexted.
      const dispatched = await estimateAndDispatchPainting({
        supabase: client,
        tenantId: lead.tenant_id,
        requestKey: `quote-form:${lead.token}`,
        conversationId,
        customerPhone,
        firstName: data.first_name ?? null,
        baseUrl: APP_BASE_URL,
        slots: {
          address: data.address.address,
          postcode: data.address.postcode,
          state: data.address.state,
          // Typed and confirmed on the form; there is no read-back turn.
          address_confirmed: true,
          addr_verified: data.address.address,
          scopes: i.scopes,
          coats: i.coats,
          condition: i.condition,
          ceiling_height: i.ceiling_height,
          storeys: i.storeys ?? 1,
          colour_change: i.colour_change,
          manual_floor_area_m2: i.manual_floor_area_m2 ?? null,
        },
        sendReply,
      })
      if (!dispatched.ok) return { ok: false, reason: dispatched.reason }
      await persistThreadState('painting_state', dispatched.state)
      return {
        ok: true,
        quoteToken: dispatched.token,
        inspection: dispatched.inspection,
        texted: false,
      }
    }

    const dispatched = await measureAndDispatchRoofing({
      supabase: client,
      tenantId: lead.tenant_id,
      tenantTrade: tenant?.trade ?? null,
      conversationId,
      requestKey: `quote-form:${lead.token}`,
      customerPhone,
      replyFrom: fromNumber ?? undefined,
      firstName: data.first_name ?? null,
      baseUrl: APP_BASE_URL,
      slots: {
        address: data.address.address,
        postcode: data.address.postcode,
        state: data.address.state,
        // The customer typed and confirmed it on the form; there is no
        // read-back turn to re-verify against.
        address_confirmed: true,
        addr_verified: data.address.address,
        material: data.inputs.material,
        pitch: data.inputs.pitch,
        intent: data.inputs.intent,
        year_built: data.inputs.building_year_built ?? null,
      },
      // The deterministic pricer owns the inspection decision (cement
      // sheet, unknown pitch, 3+ storeys, no footprint …). The form must
      // not pre-empt it — that would be a second, drifting copy of the
      // routing rules.
      isInspection: false,
      sendReply,
    })
    if (!dispatched.ok) return { ok: false, reason: dispatched.reason }
    await persistThreadState('roofing_state', dispatched.state)

    const quote = dispatched.quote as MultiRoofQuote | null
    const inspection = quote?.routing?.decision === 'inspection_required'

    // The shared dispatcher persisted the owner's review task before this status.
    return { ok: true, quoteToken: dispatched.token, inspection, texted: false }
  }

  // electrical / plumbing — the transcript-driven pipeline. The form answers
  // were written onto the thread above; this fires the identical hand-off the
  // SMS gather fires on `finish`.
  if (!lead.conversation_id) {
    return { ok: false, reason: `${data.trade} needs the SMS thread it was offered from` }
  }

  const jobType = intakeJobTypeHint(data)
  if (jobType) {
    // Grounds the structurer in the right trade's vocabulary
    // (deriveTradeFromJobType). Merged, never clobbering the slots the
    // dialog already filled.
    const state = (conv?.conversation_state ?? {}) as { slots?: Record<string, unknown> }
    const { error } = await supabase
      .from('sms_conversations')
      .update({
        conversation_state: { ...state, slots: { ...(state.slots ?? {}), job_type: jobType } },
        updated_at: new Date().toISOString(),
      })
      .eq('id', lead.conversation_id)
    if (error) return { ok: false, reason: `job_type hint not stored: ${error.message}` }
  }

  const res = await fetch(`${APP_BASE_URL}/api/intake/structure`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Internal self-call — isCronAuthorised is the only gate on this route.
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({ conversationId: lead.conversation_id, sourceChannel: 'sms' }),
  })
  if (!res.ok) {
    return { ok: false, reason: `intake/structure HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
  }
  // The pipeline owns the customer's quote SMS from here, so this request
  // sent nothing and must not claim it did either way — `texted: null`, not
  // false (which the thank-you page reads as a refused send).
  return { ok: true, quoteToken: null, inspection: false, texted: null }
}
