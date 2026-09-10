// POST /api/quote/[id]/send: authenticated owner approval and manual delivery.
// SMS approval and its durable intent commit atomically. An omitted requestId
// reuses the initial intent shared with /approve; a deliberate resend supplies
// one new client UUID and keeps it across network retries. Paid/accepted quotes
// remain protected. Email preserves the existing provider response contract.

import { createClient } from '@supabase/supabase-js'
import { dispatchQuoteWithPdf } from '@/lib/sms/send-quote-pdf'
import { genericQuoteSendKey, persistGenericQuoteRelease, quoteReleaseReviewMatches, quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { publicWebOrigin } from '@/lib/sms/public-origin'
import {
  downloadQuotePdf,
  ensureQuotePdf,
  signQuotePdfUrl,
} from '@/lib/quote/pdf'
import { buildQuoteSms } from '@/lib/sms/templates'
import { advanceQuoteStatus } from '@/lib/quote/lifecycle'
import {
  asQuoteDisplayMode,
  resolveQuoteDisplayMode,
} from '@/lib/quote/display'
import { asQuoteTierMode } from '@/lib/quote/tier-visibility'
import { computePriceHoldUntil } from '@/lib/quote/hold'
import { asQuoteKind, isSiteVisitFirstRow } from '@/lib/quote/mint-tier'
import {
  MIN_STRIPE_CHARGE_CENTS,
  asMoneyNumber,
} from '@/lib/quote/money'
import { settleFinalQuoteCredit } from '@/lib/quote/credit-settlement'
import { normaliseAuMobile } from '@/lib/phone/au'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'
import { resolveQuoteOriginConversation } from '@/lib/sms/quote-origin-conversation'
import { assertExpectedQuoteRecipient, QuoteDeliveryRecipientError, resolveOwnedQuoteCustomerContact } from '@/lib/quote/delivery-recipient'
import { loadQuoteReportPricing } from '@/lib/quote/report-pricing'
import { QuotePricingVersionError } from '@/lib/quote/pricing-version'
import { storedDepositPercent } from '@/lib/quote/chain-money'
import { sendEmail } from '@/lib/email/resend'
import {
  buildQuoteEmail,
  canSendQuote,
} from '@/lib/quote/send-customer'

export const dynamic = 'force-dynamic'
// Gotenberg PDF render + Twilio/Resend dispatch inside the request — needs
// more than Vercel's 10s default (same knob as the other heavy routes).
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: quoteId } = await params
  if (!quoteId) {
    return Response.json({ error: 'missing_quote_id' }, { status: 400 })
  }

  let body: { channel?: string; to?: string; requestId?: string; expected_revision?:unknown; expected_recipient?:unknown } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    /* empty/malformed body → validated below */
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({error:'invalid_request'},{status:400})
  let deliveryKey: string
  try { deliveryKey = genericQuoteSendKey(quoteId, body.requestId) }
  catch { return Response.json({ok:false,error:'invalid_request_id'},{status:400}) }
  const channel = body?.channel
  if (channel !== 'sms' && channel !== 'email') {
    return Response.json(
      { error: 'invalid_channel', message: "channel must be 'sms' or 'email'." },
      { status: 400 },
    )
  }
  let toOverride =
    typeof body?.to === 'string' ? body.to.trim() || null : null
  if (channel === 'email' && toOverride && !/.+@.+\..+/.test(toOverride)) {
    return Response.json(
      { error: 'invalid_recipient', message: 'That email address does not look valid.' },
      { status: 400 },
    )
  }
  if (channel === 'sms' && toOverride) {
    // A typed number must be a real AU mobile — reject up front rather than
    // burning a Twilio 21211 and returning a generic dispatch failure.
    const normalised = normaliseAuMobile(toOverride)
    if (!normalised) {
      return Response.json(
        {
          error: 'invalid_recipient',
          message: 'Enter a valid Australian mobile, e.g. 04xx xxx xxx.',
        },
        { status: 400 },
      )
    }
    toOverride = normalised
  }

  // ─── Auth (dual-auth: Clerk OR legacy Supabase token) ──
  const resolved = await resolveTenantRequest(
    supabase,
    req,
    'id, twilio_sms_number, business_name',
  )
  if (!resolved) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const tenant = resolved.tenant as {
    id: string
    twilio_sms_number: string | null
    business_name: string | null
  } | null

  // ─── Load quote + verify ownership + sendability ──
  const { data: quote, error: qErr } = await supabase
    .from('quotes')
    .select(
      'id, tenant_id, intake_id, status, share_token, good, better, best, selected_tier, total_inc_gst, scope_of_works, assumptions, estimated_timeframe, needs_inspection, inspection_reason, stripe_links, deposit_pct, display_mode, price_hold_until, applied_discount_pct, quote_kind, parent_quote_id, paid_at, customer_released_at, sent_at, pricing_book_version_id, report_doc, report_style',
    )
    .eq('id', quoteId)
    .maybeSingle()
  if (qErr) return Response.json({ error: qErr.message }, { status: 500 })
  if (!quote) return Response.json({ error: 'not_found' }, { status: 404 })
  if (!quote.tenant_id) {
    return Response.json({ error: 'unscoped_quote' }, { status: 403 })
  }
  if (!tenant || quote.tenant_id !== tenant.id) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const readiness = await readQuoteDraftReadiness(supabase, quote)
  if (!readiness.ready) return Response.json({ ok: false, error: readiness.code }, { status: 409 })

  if (!quoteReleaseReviewMatches(quote,body.expected_revision)) return Response.json({ok:false,error:'quote_review_required',message:'Open and review the current quote before sending.',review_url:`/dashboard/quote/${quote.share_token}`},{status:409})

  const gate = canSendQuote(quote.status as string | null)
  if (!gate.ok) {
    return Response.json(
      { error: 'not_sendable', reason: gate.reason, message: gate.reason },
      { status: 409 },
    )
  }

  // ─── Load intake + pricing book + customer contact ──
  const { data: intake, error: intakeError } = await supabase
    .from('intakes')
    .select('id, tenant_id, caller, suburb, job_type, scope, call_id, customer_id, trade')
    .eq('id', quote.intake_id as string)
    .eq('tenant_id', tenant.id)
    .maybeSingle()
  if (intakeError || !intake || intake.id !== quote.intake_id || intake.tenant_id !== tenant.id)
    return Response.json({ ok: false, error: 'quote_contact_unavailable' }, { status: 503 })
  const rawTrade = typeof intake.trade === 'string' ? intake.trade.trim() : ''
  if (!rawTrade) return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  const { data: currentBook } = await supabase
    .from('pricing_book')
    .select('quote_display, quote_tier_mode')
    .eq('tenant_id', quote.tenant_id)
    .eq('trade', rawTrade)
    .maybeSingle()

  const caller =
    (intake?.caller as { name?: string; phone?: string; email?: string } | null) ?? null
  let contact: Awaited<ReturnType<typeof resolveOwnedQuoteCustomerContact>>
  let recipient: string | null
  try {
    contact = await resolveOwnedQuoteCustomerContact(supabase, tenant.id, intake)
    recipient = toOverride ?? (channel === 'sms' ? contact.phone : contact.email)
    assertExpectedQuoteRecipient(channel, body.expected_recipient, recipient)
  } catch (error) {
    if (error instanceof QuoteDeliveryRecipientError)
      return Response.json({ ok: false, error: error.code, message: error.message }, { status: error.status })
    return Response.json({ ok: false, error: 'quote_contact_unavailable' }, { status: 503 })
  }
  if (!recipient) {
    return Response.json(
      channel === 'sms'
        ? {
            error: 'no_customer_phone',
            message: 'No phone number on file for this customer — enter one to send the SMS.',
          }
        : {
            error: 'no_customer_email',
            message: 'No email address on file for this customer — enter one to send the quote.',
          },
      { status: 400 },
    )
  }

  let conversationId: string | null = null
  if (channel === 'sms') {
    // An owner may deliberately send to a different recipient. That message
    // must not be inserted into the original customer's SMS conversation.
    const recipientChanged = !!toOverride && !!contact.phone &&
      toOverride !== (normaliseAuMobile(contact.phone) ?? contact.phone)
    if (!recipientChanged) {
      try {
        conversationId = await resolveQuoteOriginConversation(supabase, { tenantId: tenant.id, family: 'generic',
          resourceId: quote.id as string, intakeId: quote.intake_id, customerPhone: recipient, fromNumber: tenant.twilio_sms_number })
      } catch { return Response.json({ ok: false, error: 'quote_origin_unavailable', message: 'Saved quote conversation unavailable; retry sending shortly.' }, { status: 503 }) }
    }
  }

  const appUrl = publicWebOrigin()
  const shareToken = quote.share_token as string
  const quoteViewUrl = `${appUrl}/q/${shareToken}`

  // Release owns the initial quote hold. Replaying the same delivery intent
  // reuses its saved message and hold; a deliberate resend creates a new intent.
  const quoteKind = asQuoteKind(quote.quote_kind as string | null)

  if (quoteKind !== 'initial') {
    // R9 — the email channel is for initial quotes only. buildQuoteEmail's
    // copy is generic: it carries no deposit link, no $99 credit and no fee
    // line, so an emailed final quote tells the customer nothing about what
    // they owe or how to pay it. This is the server-side half of hiding the
    // email row in the dashboard — the API must not be the weaker gate.
    if (channel === 'email') {
      return Response.json(
        {
          error: 'email_not_supported_for_child',
          message: 'Final quotes and balance requests are sent by SMS.',
        },
        { status: 409 },
      )
    }
    // A balance row is an invoice minted by "Request final payment", which
    // texts its own link. Pushing it through the quote sender would compose a
    // degenerate tier message ("YOUR OPTION (inc 10% GST)") for a row that
    // has no tiers at all.
    if (quoteKind === 'balance') {
      return Response.json(
        {
          error: 'balance_not_sendable',
          message: 'Use Request final payment to re-send the balance link.',
        },
        { status: 409 },
      )
    }
    // Never text a customer an unpriced quote. The child is seeded with a $0
    // whole-of-job line for the tradie to fill in on site; sending before
    // that is always a mis-tap, and it used to stamp the row paid-by-credit
    // and freeze it permanently.
    const totalCents = Math.round(
      asMoneyNumber(quote.total_inc_gst as number | string | null) * 100,
    )
    if (totalCents < MIN_STRIPE_CHARGE_CENTS) {
      return Response.json(
        {
          error: 'not_priced',
          message: 'Add the confirmed price before sending this final quote.',
        },
        { status: 409 },
      )
    }
  }

  let pricing: Awaited<ReturnType<typeof loadQuoteReportPricing>> | null = null
  try {
    if (!(quote.needs_inspection === true && quoteKind === 'initial'))
      pricing = await loadQuoteReportPricing(supabase, quote, intake)
    if (pricing && !isSiteVisitFirstRow({ trade: rawTrade, quoteKind }) &&
        storedDepositPercent(quote.deposit_pct) === null) throw new QuotePricingVersionError('quote_pricing_review_required')
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof QuotePricingVersionError ? error.code : 'pricing_unavailable' },
      { status: error instanceof QuotePricingVersionError ? error.status : 503 })
  }
  const pricingBook = pricing?.pricingVersion?.snapshot ?? currentBook

  // Mig 146 — fresh render on a human send so the PDF reflects the tenant's
  // current tier mode / template at send time. Inspection-routed quotes carry
  // no committable prices, so no PDF. Best-effort: null never blocks the send.
  //
  // Deliberately AFTER the child guards above: rendering first meant a send
  // refused as `not_priced` still cached a $0 PDF on the row, which the
  // customer's /q page would then offer for download.
  let quotePdfPath: string | null = null
  try {
    if (!quote.needs_inspection) quotePdfPath = await ensureQuotePdf(quote.id as string, {
      regenerate: true, strictPricing: true, expectedReleaseRevision: quoteCustomerReleaseRevision(quote),
    })
  } catch (error) {
    if (error instanceof QuotePricingVersionError)
      return Response.json({ ok: false, error: error.code }, { status: error.status })
    return Response.json({ ok: false, error: 'pricing_unavailable' }, { status: 503 })
  }

  // A final/balance row carries no price hold (spec R9): the hold is a
  // freshness window on an unaccepted estimate, and the mint skips its gate
  // for children. Re-arming it here would write a `price_hold_until` that
  // makes the quote page render a countdown the customer can't act on.
  const refreshedHoldUntil =
    quoteKind === 'initial' ? computePriceHoldUntil(new Date().toISOString()) : null

  if (channel === 'sms') {
    const displayMode = resolveQuoteDisplayMode({
      perQuoteOverride: quote.display_mode as string | null,
      tenantPreference:
        (pricingBook as { quote_display?: string | null } | null)?.quote_display ?? null,
    })

    // Pay links are the GATED /r short-links, never raw stored Stripe URLs
    // (they expire after 24h and bypass the book-first funnel) — see /approve.
    const storedLinks =
      quote.stripe_links && typeof quote.stripe_links === 'object'
        ? (quote.stripe_links as Record<string, string>)
        : {}
    const payLinks: Record<string, string> = {}
    for (const k of Object.keys(storedLinks)) {
      payLinks[k] = `${appUrl}/r/${shareToken}/${k}`
    }
    // Spec elec-plumb-site-visit-first R5 — electrical/plumbing sell only the
    // $99 site visit, so the message needs that link even on a quote drafted
    // before the model changed (whose stripe_links hold G/B/B only).
    // /r/<token>/inspection mints a fresh Session per click, so it is always live.
    if (isSiteVisitFirstRow({ trade: rawTrade, quoteKind })) {
      payLinks.inspection = `${appUrl}/r/${shareToken}/inspection`
    }
    // A FINAL quote sells its deposit and nothing else (spec R9). The link is
    // set unconditionally because the loop above only mirrors keys already in
    // stripe_links, and a freshly-issued child has none — /r mints per click,
    // so the short-link is live regardless. Any `inspection` key inherited
    // from the parent is dropped: offering it here would sell a second site
    // visit and, once paid, claim the row's only paid_at slot.
    if (quoteKind === 'final') {
      delete payLinks.inspection
      payLinks.deposit = `${appUrl}/r/${shareToken}/deposit`
    }
    const depositPct = typeof quote.deposit_pct === 'number' ? quote.deposit_pct : 0

    const quoteForSms = {
      ...quote,
      price_hold_until: refreshedHoldUntil,
      pay_links: payLinks,
      deposit_pct: depositPct,
      needs_inspection: !!quote.needs_inspection,
      inspection_reason: quote.inspection_reason as string | null,
      quote_view_url: quoteViewUrl,
      pdf_url: quotePdfPath ? `${appUrl}/api/q/${shareToken}/pdf` : null,
      // P6 — SMS prices match the /r-minted Session: discounted when the
      // customer booked in time, GST-conditional (lib/quote/money.ts).
      applied_discount_pct: (quote.applied_discount_pct as number | null) ?? 0,
      ...(pricing ? { gst_registered: pricing.gstRegistered } : {}),
    }
    const intakeForSms = {
      job_type: (intake?.job_type as string) ?? 'other',
      caller: (caller as { name?: string } | null) ?? null,
      scope: (intake?.scope as { item_count?: number; description?: string } | null) ?? null,
    }
    const tierMode = asQuoteTierMode(
      (pricingBook as { quote_tier_mode?: string | null } | null)?.quote_tier_mode ?? null,
    )
    const smsBody = buildQuoteSms(intakeForSms, quoteForSms, {
      displayMode: asQuoteDisplayMode(displayMode),
      tierMode,
      trade: rawTrade,
      quoteKind,
      businessName: (tenant as { business_name?: string | null }).business_name ?? null,
    })
    const fromNumber = tenant.twilio_sms_number ?? undefined
    if (!fromNumber) return Response.json({ok:false,error:'tenant_messaging_unavailable'},{status:503})

    let release
    try {
      release = await persistGenericQuoteRelease(supabase, {
        quote,tenantId:tenant.id,ownerId:resolved.identity.userId,holdUntil:refreshedHoldUntil,signMediaUrl:signQuotePdfUrl,
        outbound:{ to:normaliseAuMobile(recipient) ?? recipient,text:smsBody,from:fromNumber,
          ...(conversationId ? { conversationId } : {}),
          tenantId:tenant.id,deliveryKey,...(quotePdfPath ? {mediaKey:quotePdfPath} : {}) },
      })
    } catch (error) {
      return Response.json({ok:false,error:'approval_unavailable',message:String(error)},{status:409})
    }
    const dispatch = await dispatchQuoteWithPdf({
      ...release.outbound!, pdfPath:typeof release.outbound?.mediaKey === 'string' ? release.outbound.mediaKey : null,signMediaUrl:signQuotePdfUrl,
    })
    if (!dispatch.ok) {
      return Response.json({ok:true,approved:true,accepted:false,outboxId:release.outboxId,
        status:'approved_delivery_pending',message:'Approved. Customer SMS delivery needs recovery; check SMS delivery.'},{status:202})
    }

    // The outbox acceptance trigger also advances this lifecycle after worker recovery.
    await markSent(quote.id as string, quote.tenant_id as string, null, 'sms')

    // ── R8: the $99 already covers the deposit ──────────────────────
    // A job small enough that pct% of it is under the site-visit fee has
    // nothing left to charge as a deposit. Stamping the row paid with a
    // 'credit' tier is what lets the chain continue: "Request final payment"
    // accepts it, the row leaves the follow-up queues, and it freezes like
    // any other paid row. paid_amount_cents 0 with a NULL Connect destination
    // keeps it out of Payouts — there is no money to release.
    //
    // Reconcile the actual accepted outbox snapshot. Migration217 also runs
    // this proof when a queued delivery is accepted after this request ends.
    const creditSettlement = quoteKind === 'final' ? await settleFinalQuoteCredit(supabase, {
      quoteId: quote.id as string, tenantId: tenant.id, outboxId: release.outboxId,
    }) : null

    return Response.json({
      ok: true,
      quote_id: quote.id,
      approved:true, accepted:true, outboxId:release.outboxId,
      channel: dispatch.channel,
      sid: dispatch.sid,
      status: 'sent',
      ...(creditSettlement ? { credit_settlement: creditSettlement } : {}),
      ...(creditSettlement?.status === 'settled' ? { deposit_covered_by_credit: true } : {}),
    })
  }

  // ─── Email channel ──
  let attachments: Array<{ filename: string; content: string }> | undefined
  if (quotePdfPath) {
    try {
      const pdf = await downloadQuotePdf(quotePdfPath)
      attachments = [
        { filename: `quote-${shareToken.slice(0, 8)}.pdf`, content: pdf.toString('base64') },
      ]
    } catch (e) {
      console.warn(
        '[quote/send] PDF download failed — sending link-only email',
        e instanceof Error ? e.message : e,
      )
    }
  }

  const email = buildQuoteEmail({
    businessName: tenant.business_name,
    customerName: caller?.name ?? null,
    jobType: (intake?.job_type as string | null) ?? null,
    quoteUrl: quoteViewUrl,
    pdfAttached: !!attachments,
  })

  try {
    await persistGenericQuoteRelease(supabase,{quote,tenantId:tenant.id,ownerId:resolved.identity.userId,holdUntil:refreshedHoldUntil})
  } catch (error) {
    return Response.json({ok:false,error:'approval_unavailable',message:String(error)},{status:409})
  }
  const result = await sendEmail({
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: resolved.identity.email ?? undefined,
    attachments,
  })

  if (!result.ok) {
    return Response.json(
      {
        error: 'email_failed',
        code: result.code,
        message: `Could not send the email (${result.reason}). Try again or use SMS.`,
      },
      { status: 502 },
    )
  }

  await markSent(quote.id as string, quote.tenant_id as string, refreshedHoldUntil, 'email')

  return Response.json({
    ok: true,
    quote_id: quote.id,
    channel: 'email',
    messageId: result.messageId,
    status: 'sent',
  })
}

/** Post-success bookkeeping: restart the price hold, advance the lifecycle,
 *  and drop a touch-log row. Only called after a delivered send. */
async function markSent(
  quoteId: string,
  tenantId: string,
  holdUntilIso: string | null,
  channel: 'sms' | 'email',
) {
  if (holdUntilIso) {
    await supabase
      .from('quotes')
      .update({ price_hold_until: holdUntilIso })
      .eq('id', quoteId)
  }
  await advanceQuoteStatus(supabase, quoteId, 'sent')
  // Touch-log entry for the dashboard timeline. Best-effort — never blocks
  // the send response. Columns per migration 039: tenant_id + kind are NOT
  // NULL and outcome is CHECK-constrained ('text_sent' for SMS; email has no
  // dedicated kind, so it logs as a 'note' with outcome 'other').
  const { error } = await supabase.from('quote_followup_events').insert({
    tenant_id: tenantId,
    quote_id: quoteId,
    kind: channel === 'sms' ? 'sms' : 'note',
    outcome: channel === 'sms' ? 'text_sent' : 'other',
    note: `Tradie sent the quote to the customer via ${channel === 'sms' ? 'SMS' : 'email'}.`,
  })
  if (error) {
    console.warn('[quote/send] touch-log insert failed (send unaffected)', error.message)
  }
}
