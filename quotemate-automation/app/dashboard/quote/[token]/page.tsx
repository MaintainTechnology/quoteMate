// Dashboard PDF quote viewer — /dashboard/quote/[token].
//
// Reached from the "View PDF" action on each dashboard quote card. Loads the
// quote by share_token (service-role; same token trust model as /q/[token]),
// resolves the per-trade report adapter, and hands plain data to the
// trade-agnostic viewer shell. Owner-gating of the edit/AI actions happens
// client-side inside TradieEditor (via /api/quote/[id]/check-owner), exactly
// like the customer page — viewing is by unguessable token, editing is
// owner-only.

import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import { getReportAdapter, tradeRendersOwnQuotePdf } from '@/lib/quote/report-adapters/registry'
import { confirmSendCta, resolveCustomerContact } from '@/lib/quote/send-customer'
import { buildDefaultReportDoc } from '@/lib/quote/report-doc/seed'
import type { ReportDoc } from '@/lib/quote/report-doc/types'
import type { ReportStyle } from '@/lib/quote/report-doc/style'
import QuoteReportViewerClient from './QuoteReportViewerClient'
import { asQuoteKind, isSiteVisitFirstTrade } from '@/lib/quote/mint-tier'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export default async function DashboardQuoteViewerPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const { data: quote } = await supabase
    .from('quotes')
    .select(
      // paid_tier + the mig-194 chain columns (spec post-visit-money-sequence
      // R12): the toolbar's "Issue final quote" is shown only on a row whose
      // payment was the $99 site visit (paid_tier='inspection') and which is
      // itself the chain root (quote_kind='initial').
      // NOTE: `deposit_paid` is NOT a column — it is derived from paid_at (see
      // app/api/tenant/me/route.ts, which computes it for the dashboard list).
      // Selecting it made PostgREST fail the whole read, so `quote` came back
      // null and this page 404'd EVERY quote, not just unpaid ones.
      'id, intake_id, tenant_id, good, better, best, needs_inspection, paid_at, paid_tier, quote_kind, parent_quote_id, status, selected_tier, scope_of_works, assumptions, risk_flags, report_doc, report_style',
    )
    .eq('share_token', token)
    .maybeSingle()
  if (!quote) notFound()

  // Trade lives on the intake (legacy rows without it default to electrical,
  // matching /q/[token]).
  const { data: intake } = quote.intake_id
    ? await supabase
        .from('intakes')
        .select('trade, job_type, caller, call_id, customer_id, scope')
        .eq('id', quote.intake_id)
        .maybeSingle()
    : { data: null }
  const trade = ((intake?.trade as string | null | undefined) ?? 'electrical').trim() || 'electrical'
  // Same derivation the dashboard list uses (app/api/tenant/me/route.ts): a
  // quote counts as paid once Stripe stamped paid_at. Suppresses the
  // "Send to Customer" CTA on an already-paid quote.
  const depositPaid = !!quote.paid_at
  const sendCta = confirmSendCta(
    (quote.status as string | null | undefined) ?? null,
    depositPaid,
  )

  // Customer contact on file for the "Send to Customer" panel.
  const contact = await resolveCustomerContact(supabase, {
    caller: (intake?.caller as { phone?: string; email?: string } | null) ?? null,
    intakeId: (quote.intake_id as string | null) ?? null,
    callId: (intake?.call_id as string | null) ?? null,
    customerId: (intake?.customer_id as string | null) ?? null,
  })

  // GST flag for the line-item editor's inc-GST display.
  let gstRegistered = true
  if (quote.tenant_id) {
    const { data: pb } = await supabase
      .from('pricing_book')
      .select('gst_registered')
      .eq('tenant_id', quote.tenant_id)
      .eq('trade', trade)
      .limit(1)
      .maybeSingle()
    gstRegistered = !!(pb?.gst_registered ?? true)
  }

  // ─── The post-site-visit chain (spec R3/R10) ─────────────────────
  // Which forward action this row offers, decided here so the client
  // component stays presentational:
  //   • the paid $99 site-visit row on a site-visit-first trade → issue the
  //     final quote (the step that unblocks a job stuck at "site visit paid");
  //   • the final row, once its deposit has landed (or the $99 covered it,
  //     paid_tier='credit') → request the balance.
  // Everything else — an unpaid quote, a solar/roofing deposit, a balance row
  // — offers neither.
  const quoteKind = asQuoteKind(quote.quote_kind as string | null)
  const paidTier = (quote.paid_tier as string | null) ?? null
  const chainAction: 'issue-final' | 'request-balance' | null =
    quoteKind === 'initial' &&
    !!quote.paid_at &&
    paidTier === 'inspection' &&
    isSiteVisitFirstTrade(intake?.trade as string | null | undefined)
      ? 'issue-final'
      : quoteKind === 'final' &&
          !!quote.paid_at &&
          (paidTier === 'deposit' || paidTier === 'credit')
        ? 'request-balance'
        : null

  const adapter = getReportAdapter(trade)
  type ViewerTier = Parameters<typeof QuoteReportViewerClient>[0]['tiers']['good']

  // Phase 1 living-document editor, flag-gated (default off ⇒ prod unchanged).
  // Seed a default document from the quote's fields when none is stored yet, so
  // the editor opens with today's title/scope/pricing/assumptions.
  const docEditorEnabled = process.env.FULL_QUOTE_DOC === 'true'
  const reportDoc =
    (quote.report_doc as ReportDoc | null) ??
    buildDefaultReportDoc({
      title: ((intake?.job_type as string | null | undefined) ?? '').replace(/_/g, ' ').trim(),
      scopeOfWorks: quote.scope_of_works as string | null,
      assumptions: quote.assumptions as string[] | null,
    })

  return (
    <QuoteReportViewerClient
      quoteId={quote.id as string}
      shareToken={token}
      trade={trade}
      gstRegistered={gstRegistered}
      needsInspection={!!quote.needs_inspection}
      paid={!!quote.paid_at}
      customerPhone={contact.phone}
      customerEmail={contact.email}
      sendLabel={sendCta.label || undefined}
      // Tradie-only. Strings only — legacy rows stored objects here before the
      // shape settled, and rendering one would print "[object Object]".
      rememberedAddress={
        ((intake?.scope as { remembered_address?: string } | null)?.remembered_address ?? null)
      }
      riskFlags={
        Array.isArray(quote.risk_flags)
          ? (quote.risk_flags as unknown[]).filter((f): f is string => typeof f === 'string' && f.trim() !== '')
          : null
      }
      docEditorEnabled={docEditorEnabled}
      reportDoc={reportDoc}
      reportStyle={(quote.report_style as ReportStyle | null) ?? {}}
      selectedTier={(quote.selected_tier as 'good' | 'better' | 'best' | null) ?? null}
      chainAction={chainAction}
      quoteKind={quoteKind}
      bodyMode={adapter.bodyMode}
      editorKind={adapter.editorKind}
      pdfUrl={adapter.pdfPath(token)}
      // Live, edit-reactive HTML render of the same report the PDF is built
      // from — the viewer prefers this over the frozen PDF iframe. Electrical /
      // plumbing store good/better/best, which /api/q/[token]/html renders via
      // buildQuoteReportHtml. RC-1: commercial painting authors its own tender
      // PDF with no generic HTML equivalent, so we withhold htmlUrl and let the
      // viewer embed the tender PDF inline — the preview then matches the
      // downloaded/MMS'd document instead of a generic Good/Better/Best render.
      htmlUrl={tradeRendersOwnQuotePdf(trade) ? undefined : `/api/q/${token}/html`}
      capabilities={adapter.capabilities}
      tiers={{
        good: (quote.good as ViewerTier) ?? null,
        better: (quote.better as ViewerTier) ?? null,
        best: (quote.best as ViewerTier) ?? null,
      }}
    />
  )
}
