// POST /api/quote/[id]/approve: the owning tradie authorises a held quote.
// Approval and the exact initial SMS intent commit together before transport.
// Replayed approve/send requests share that intent. Carrier acceptance updates
// the sent lifecycle through the outbox trigger, including after worker recovery.

import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { dispatchQuoteWithPdf } from '@/lib/sms/send-quote-pdf'
import { genericQuoteSendKey, persistGenericQuoteRelease, quoteReleaseReviewMatches, quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { publicWebOrigin } from '@/lib/sms/public-origin'
import { ensureQuotePdf, signQuotePdfUrl } from '@/lib/quote/pdf'
import { archiveAndIngestQuote } from '@/lib/filestore/ingest-quote'
import { buildQuoteKbText } from '@/lib/filestore/minimize'
import {
  buildQuoteSms,
  buildQuoteUpdatedSms,
} from '@/lib/sms/templates'
import { advanceQuoteStatus } from '@/lib/quote/lifecycle'
import {
  asQuoteDisplayMode,
  resolveQuoteDisplayMode,
} from '@/lib/quote/display'
import { asQuoteTierMode } from '@/lib/quote/tier-visibility'
import { computePriceHoldUntil } from '@/lib/quote/hold'
import { asQuoteKind, isSiteVisitFirstRow } from '@/lib/quote/mint-tier'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { assertExpectedQuoteRecipient, QuoteDeliveryRecipientError, resolveOwnedQuoteCustomerContact } from '@/lib/quote/delivery-recipient'
import { loadQuoteReportPricing } from '@/lib/quote/report-pricing'
import { QuotePricingVersionError } from '@/lib/quote/pricing-version'
import { storedDepositPercent } from '@/lib/quote/chain-money'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'
import { resolveQuoteOriginConversation } from '@/lib/sms/quote-origin-conversation'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let approval: {expected_revision?:unknown; expected_recipient?:unknown} = {}
  try { approval=await req.json() } catch { /* Missing review revision is rejected below. */ }
  const { id: quoteId } = await params
  if (!quoteId) {
    return Response.json({ error: 'missing_quote_id' }, { status: 400 })
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

  // ─── Load quote + verify ownership + state ──
  const { data: quote, error: qErr } = await supabase
    .from('quotes')
    .select(
      'id, tenant_id, intake_id, status, share_token, good, better, best, selected_tier, total_inc_gst, scope_of_works, assumptions, estimated_timeframe, needs_inspection, inspection_reason, stripe_links, deposit_pct, display_mode, price_hold_until, applied_discount_pct, quote_kind, parent_quote_id, customer_released_at, sent_at, paid_at, pricing_book_version_id, report_doc, report_style',
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

  if (quote.status === 'awaiting_tradie_approval' && !quoteReleaseReviewMatches(quote,approval?.expected_revision)) return Response.json({ok:false,error:'quote_review_required',message:'Open and review the current quote before approving.',review_url:`/dashboard/quote/${quote.share_token}`},{status:409})

  // Idempotency: if the quote isn't awaiting approval, return success
  // with a status code in the body so the page can render "already
  // sent" instead of an error.
  if (quote.status !== 'awaiting_tradie_approval') {
    return Response.json({
      ok: true,
      already_actioned: true,
      status: quote.status,
      message:
        quote.status === 'sent' || quote.status === 'accepted' || quote.status === 'paid'
          ? 'Quote already sent to the customer.'
          : `Quote is in state '${quote.status}' — nothing to approve.`,
    })
  }

  // ─── Load intake (caller name + suburb + job_type) + pricing book
  //      (display mode for the SMS template) ──
  const { data: intake, error: intakeError } = await supabase
    .from('intakes')
    .select('id, tenant_id, caller, suburb, job_type, scope, call_id, customer_id, trade')
    .eq('id', quote.intake_id as string)
    .eq('tenant_id', tenant.id)
    .maybeSingle()
  if (intakeError || !intake || intake.id !== quote.intake_id || intake.tenant_id !== tenant.id)
    return Response.json({ ok: false, error: 'quote_contact_unavailable' }, { status: 503 })
  const approveIntakeTrade = typeof intake.trade === 'string' ? intake.trade.trim() : ''
  if (!approveIntakeTrade) return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  // Today's book supplies presentation only. Priced messages use saved tax
  // evidence, even after this mutable book changes or disappears.
  const { data: currentBook } = await supabase
    .from('pricing_book')
    .select('quote_display, quote_tier_mode')
    .eq('tenant_id', quote.tenant_id)
    .eq('trade', approveIntakeTrade).maybeSingle()

  // Caller phone number — shared 4-source chain (intake.caller.phone →
  // sms_conversations → calls → customers), the same lookup the edit route
  // proved necessary in prod; the old 2-source version here missed numbers
  // that sat on the intake or customer row.
  let callerNumber: string | null
  try {
    callerNumber = (await resolveOwnedQuoteCustomerContact(supabase, tenant.id, intake)).phone
    assertExpectedQuoteRecipient('sms', approval?.expected_recipient, callerNumber)
  } catch (error) {
    if (error instanceof QuoteDeliveryRecipientError)
      return Response.json({ ok: false, error: error.code, message: error.message }, { status: error.status })
    return Response.json({ ok: false, error: 'quote_contact_unavailable' }, { status: 503 })
  }

  if (!callerNumber) {
    return Response.json(
      { error: 'no_caller_number', message: 'No phone number on file for this customer.' },
      { status: 400 },
    )
  }

  const approveQuoteKind = asQuoteKind(quote.quote_kind as string | null)
  let pricing: Awaited<ReturnType<typeof loadQuoteReportPricing>> | null = null
  try {
    if (!(quote.needs_inspection === true && approveQuoteKind === 'initial'))
      pricing = await loadQuoteReportPricing(supabase, quote, intake)
    if (pricing && !isSiteVisitFirstRow({ trade: approveIntakeTrade, quoteKind: approveQuoteKind }) &&
        storedDepositPercent(quote.deposit_pct) === null) throw new QuotePricingVersionError('quote_pricing_review_required')
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof QuotePricingVersionError ? error.code : 'pricing_unavailable' },
      { status: error instanceof QuotePricingVersionError ? error.status : 503 })
  }
  const pricingBook = pricing?.pricingVersion?.snapshot ?? currentBook

  let conversationId: string | null
  try {
    conversationId = await resolveQuoteOriginConversation(supabase, { tenantId: tenant.id, family: 'generic',
      resourceId: quote.id as string, intakeId: quote.intake_id, customerPhone: callerNumber, fromNumber: tenant.twilio_sms_number })
  } catch { return Response.json({ ok: false, error: 'quote_origin_unavailable', message: 'Saved quote conversation unavailable; retry approval shortly.' }, { status: 503 }) }

  // ─── Build + dispatch the customer SMS ──
  const appUrl = publicWebOrigin()
  const displayMode = resolveQuoteDisplayMode({
    perQuoteOverride: quote.display_mode as string | null,
    tenantPreference:
      (pricingBook as { quote_display?: string | null } | null)?.quote_display ?? null,
  })

  // Reconstruct the Quote shape the SMS template expects. The actual
  // tier jsonb already lives on the quote row; we just need to attach
  // the share-link + deposit pct + pay links so the body renders the
  // pay-now CTAs.
  //
  // Pay links are the GATED /r short-links, never the raw stored Stripe
  // URLs (mirrors the draft route). Raw Session URLs die after Stripe's
  // 24h expiry — usually before a review-held quote is even approved —
  // and bypass /r's book-first funnel + price-hold gate + fresh-Session
  // mint entirely.
  const storedLinks =
    quote.stripe_links && typeof quote.stripe_links === 'object'
      ? (quote.stripe_links as Record<string, string>)
      : {}
  const payLinks: Record<string, string> = {}
  for (const k of Object.keys(storedLinks)) {
    payLinks[k] = `${appUrl}/r/${quote.share_token as string}/${k}`
  }
  // Spec elec-plumb-site-visit-first R5 — electrical/plumbing sell only the
  // $99 site visit, so the approved-send message needs that link even on a
  // quote drafted before the model changed (stripe_links hold G/B/B only).
  // /r/<token>/inspection mints a fresh Session per click, so it is always live.
  if (isSiteVisitFirstRow({ trade: approveIntakeTrade, quoteKind: approveQuoteKind })) {
    payLinks.inspection = `${appUrl}/r/${quote.share_token as string}/inspection`
  }
  // Only inspection-only messages can reach here without a proven deposit.
  const depositPct = typeof quote.deposit_pct === 'number' ? quote.deposit_pct : 0

  // Migration 105 — Gotenberg quote PDF. Held quotes skipped PDF
  // generation at draft time (the customer SMS was held), so this is
  // usually the first render. Best-effort: a failure never blocks the
  // approve-and-send.
  // Mig 146 — force a fresh render on the human send action so the PDF always
  // reflects the tenant's current Pricing-settings tier mode at send time.
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

  // The seven-day hold begins at the explicit release. A replay reuses the
  // saved hold and message, so retry timing cannot change the approved offer.
  const refreshedHoldUntil = computePriceHoldUntil(new Date().toISOString())

  const quoteForSms = {
    ...quote,
    price_hold_until: refreshedHoldUntil,
    pay_links: payLinks,
    deposit_pct: depositPct,
    needs_inspection: !!quote.needs_inspection,
    inspection_reason: quote.inspection_reason as string | null,
    quote_view_url: `${appUrl}/q/${quote.share_token as string}`,
    pdf_url: quotePdfPath ? `${appUrl}/api/q/${quote.share_token as string}/pdf` : null,
    // P6 — the SMS prices must match what /r's freshly-minted Session
    // charges: discounted when the customer already booked in time, and
    // GST-conditional like every other surface (lib/quote/money.ts).
    applied_discount_pct: (quote.applied_discount_pct as number | null) ?? 0,
    ...(pricing ? { gst_registered: pricing.gstRegistered } : {}),
  }
  const intakeForSms = {
    job_type: (intake?.job_type as string) ?? 'other',
    caller: (intake?.caller as { name?: string } | null) ?? null,
    scope: (intake?.scope as { item_count?: number; description?: string } | null) ?? null,
  }

  // Mig 142 — per-feature tier mode (single-price tradies get one option).
  const tierMode = asQuoteTierMode(
    (pricingBook as { quote_tier_mode?: string | null } | null)?.quote_tier_mode ?? null,
  )
  const body = buildQuoteSms(intakeForSms, quoteForSms, {
    displayMode: asQuoteDisplayMode(displayMode),
    tierMode,
    trade: approveIntakeTrade,
    quoteKind: approveQuoteKind,
    businessName: (tenant as { business_name?: string | null }).business_name ?? null,
  })
  const fromNumber = tenant.twilio_sms_number ?? undefined
  if (!fromNumber) return Response.json({ok:false,error:'tenant_messaging_unavailable'},{status:503})
  // Best-effort MMS attach of the PDF — the shared helper signs the media
  // URL (best-effort) and dispatch auto-falls back to a plain SMS when the
  // carrier rejects media; the body always carries the download link.
  let release
  try {
    release = await persistGenericQuoteRelease(supabase, {
      quote, tenantId: tenant.id, ownerId: resolved.identity.userId, holdUntil: refreshedHoldUntil, signMediaUrl:signQuotePdfUrl,
      outbound: { to: callerNumber, from: fromNumber, text: body, tenantId: tenant.id,
        ...(conversationId ? { conversationId } : {}),
        deliveryKey: genericQuoteSendKey(quote.id as string),
        ...(quotePdfPath ? { mediaKey: quotePdfPath } : {}),
      },
    })
  } catch (error) {
    return Response.json({ok:false,error:'approval_unavailable',message:String(error)},{status:409})
  }
  const dispatch = await dispatchQuoteWithPdf({
    ...release.outbound!, pdfPath: typeof release.outbound?.mediaKey === 'string' ? release.outbound.mediaKey : null, signMediaUrl: signQuotePdfUrl,
  })
  if (!dispatch.ok) {
    return Response.json({ok:true,approved:true,accepted:false,outboxId:release.outboxId,
      status:'approved_delivery_pending',message:'Approved. Customer SMS delivery needs recovery; check SMS delivery.'},{status:202})
  }

  // Mark as sent (uses the same monotonic lifecycle advancer the
  // estimator uses) so the follow-up queue + dashboard pick it up.
  await advanceQuoteStatus(supabase, quote.id as string, 'sent')

  // Per-tenant file-store ingest — best-effort, post-send (after the
  // customer SMS has gone out and the quote is 'sent'). Archives the
  // rendered quote PDF + a minimized KB text doc for retrieval. STUBs
  // when TENANT_FILESTORE_ENABLED !== 'true' and no-ops on missing
  // inputs, so it never blocks or alters the approve-and-send response.
  const ingestTrade = (intake?.trade as string | null | undefined) ?? 'electrical'
  after(async () => {
    try {
      const fullDocPath = await ensureQuotePdf(quote.id as string)
      if (!fullDocPath) return
      const { markdown, contentHash } = buildQuoteKbText({
        quote: quote as Record<string, unknown>,
        trade: ingestTrade,
      })
      await archiveAndIngestQuote({
        tenantId: (quote.tenant_id as string | null) ?? null,
        sourceKind: 'quote',
        sourceId: quote.id as string,
        trade: ingestTrade,
        fullDocPath,
        kbText: markdown,
        contentHash,
      })
    } catch {
      /* best-effort */
    }
  })

  // Drop a row into quote_followup_events so the touch-log on the
  // dashboard shows "Tradie approved + sent" alongside the other
  // post-send actions. Best-effort; never blocks success.
  // Columns per migration 039: tenant_id + kind are NOT NULL and outcome is
  // CHECK-constrained — the previous {quote_id, outcome:'approved_and_sent'}
  // shape violated all three, so this insert had silently never written a row.
  {
    const { error: touchErr } = await supabase.from('quote_followup_events').insert({
      tenant_id: quote.tenant_id,
      quote_id: quote.id,
      kind: 'sms',
      outcome: 'text_sent',
      note: 'Tradie approved the quote; customer SMS dispatched.',
    })
    if (touchErr) {
      console.warn('[quote/approve] touch-log insert failed (send unaffected)', touchErr.message)
    }
  }
  // Reference buildQuoteUpdatedSms so the import isn't tree-shaken in
  // tests that load the route module to read its export.
  void buildQuoteUpdatedSms

  return Response.json({
    ok: true,
    quote_id: quote.id,
    approved: true,
    accepted: true,
    outboxId: release.outboxId,
    channel: dispatch.channel,
    sid: dispatch.sid,
    status: 'sent',
  })
}
