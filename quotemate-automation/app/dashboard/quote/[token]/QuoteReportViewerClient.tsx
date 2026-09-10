'use client'

// QuoteReportViewerClient — the trade-agnostic viewer shell for the dashboard
// "View PDF" flow. Renders the report body (inline PDF for electrical/plumbing;
// a download card for trades whose adapter isn't built yet) plus a toolbar:
// Edit · Download PDF · Edit with AI. Edit and Edit-with-AI drive the existing
// TradieEditor (mounted hidden) via its imperative onReady handle; the editor
// owns auth, grounding, Stripe re-issue, PDF regeneration, and notify. After a
// save we bump the iframe key so the regenerated PDF reloads.
//
// Per-trade behaviour comes entirely from the props the server resolved off the
// adapter (bodyMode / capabilities / pdfUrl) — this component knows nothing
// trade-specific, which is what lets new trades light up without touching it.

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import TradieEditor, { type EditorApi } from '@/app/q/[token]/TradieEditor'
import { getAuthToken } from '@/lib/auth/client-token'
import SendQuotePanel from './SendQuotePanel'
import TierSelect from './TierSelect'
import ChainActions from './ChainActions'
import type { ReportDoc } from '@/lib/quote/report-doc/types'
import type { ReportStyle } from '@/lib/quote/report-doc/style'
import type { EditorKind } from '@/lib/quote/report-adapters/types'
import type { DocEditorTiers } from './QuoteDocumentEditor'

// Lazy-load the TipTap workspace so its bundle only loads when FULL_QUOTE_DOC is
// on and the owner is editing — the default (flag-off) viewer never ships TipTap.
const QuoteDocumentWorkspace = dynamic(() => import('./QuoteDocumentWorkspace'), { ssr: false })

type Tier = {
  label?: string
  timeframe?: string
  subtotal_ex_gst?: number
  line_items?: Array<{
    description: string
    quantity: number
    unit?: string
    unit_price_ex_gst: number
    total_ex_gst?: number
    source?: string
  }>
} | null

export default function QuoteReportViewerClient(props: {
  quoteId: string
  reviewVersion?: string
  sentBefore?: boolean
  shareToken: string
  trade: string
  gstRegistered: boolean | null
  needsInspection: boolean
  paid: boolean
  /** Phase 1 living-document editor — flag-gated (default off ⇒ current viewer). */
  docEditorEnabled?: boolean
  reportDoc?: ReportDoc
  reportStyle?: ReportStyle
  selectedTier?: 'good' | 'better' | 'best' | null
  /** Which post-site-visit action this row offers, resolved server-side from
   *  quote_kind + paid_tier + trade (spec post-visit-money-sequence R3/R10).
   *  Null on every ordinary quote. */
  chainAction?: 'issue-final' | 'request-balance' | null
  /** quotes.quote_kind. A post-site-visit child hides the AI editor (chat-edit
   *  can propose better/best on a single-slot row, which then 400s on save)
   *  and the email channel (buildQuoteEmail's copy carries no deposit link,
   *  no $99 credit and no fee line). Spec R4/R9. */
  quoteKind?: 'initial' | 'final' | 'balance' | null
  bodyMode: 'pdf-inline' | 'download-only'
  /** Which in-shell editor this trade's adapter mounts. Only 'block-doc' trades
   *  get the TipTap living-document workspace; everything else stays on the
   *  styled full-quote HTML iframe below. */
  editorKind?: EditorKind
  pdfUrl: string
  /** Live HTML render of the report (same document the PDF is built from).
   *  When present the viewer embeds this instead of the frozen PDF, so manual
   *  and AI edits (which flow through the structured editor + save) show up on
   *  reload. Download PDF still uses pdfUrl. */
  htmlUrl?: string
  capabilities: { manualEdit: boolean; aiEdit: boolean }
  tiers: { good: Tier; better: Tier; best: Tier }
  /** Customer contact on file (resolved server-side) for the send panel. */
  customerPhone?: string | null
  customerEmail?: string | null
  /** Held portal drafts use the same explicit confirmation copy as the
   * dashboard Quotes tab. */
  sendLabel?: string
  /** quotes.risk_flags — the assumptions the pricing engine made on its own
   *  (cable-run length, switchboard spare way, pricing-book fallbacks). Written
   *  on every quote since migration 074 and, until now, rendered nowhere: the
   *  tradie could not see what had been assumed on their behalf. TRADIE-ONLY —
   *  deliberately not merged into quotes.assumptions, which is customer-facing
   *  (lib/quote/report-html.ts). */
  riskFlags?: string[] | null
  /** R5(c) — an address we know only from an EARLIER job with this customer,
   *  when the current conversation never produced one. Shown labelled and
   *  tradie-only: it is a lead to confirm, never this job's site. */
  rememberedAddress?: string | null
}) {
  const {
    quoteId,
    trade,
    gstRegistered,
    needsInspection,
    paid,
    customerPhone,
    customerEmail,
    sendLabel,
    docEditorEnabled,
    reportDoc,
    reportStyle,
    selectedTier,
    chainAction,
    quoteKind,
    bodyMode,
    editorKind,
    pdfUrl,
    htmlUrl,
    capabilities,
    tiers,
    riskFlags,
    rememberedAddress,
  } = props

  const [api, setApi] = useState<EditorApi | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [token, setToken] = useState<string | null>(null)

  // Owner-gated document save needs the tradie's Supabase access token
  // client-side (same source TradieEditor uses). Only fetched when the flag is on.
  useEffect(() => {
    if (!docEditorEnabled) return
    let alive = true
    getAuthToken().then((t) => {
      if (alive) setToken(t)
    })
    return () => {
      alive = false
    }
  }, [docEditorEnabled])

  const owner = !!api?.canEdit // owner of an unpaid quote (resolved by TradieEditor)
  const canEdit = capabilities.manualEdit && owner && !needsInspection && !paid
  const isChildRow = quoteKind === 'final' || quoteKind === 'balance'
  // R4 — the AI editor is hidden on a child: chat-edit can propose better/best
  // on a single-slot final quote and the save then 400s cannot_edit_missing_tier.
  const canAi = capabilities.aiEdit && owner && !needsInspection && !paid && !isChildRow

  const toDocTier = (t: Tier): DocEditorTiers['good'] =>
    t ? { label: t.label ?? '', subtotal_ex_gst: t.subtotal_ex_gst ?? 0 } : null
  const docTiers: DocEditorTiers = {
    good: toDocTier(tiers.good),
    better: toDocTier(tiers.better),
    best: toDocTier(tiers.best),
    selectedTier: selectedTier ?? null,
  }
  // The TipTap living-document workspace replaces the styled iframe ONLY for a
  // trade whose adapter opts in with editorKind 'block-doc' (flag on + owner +
  // token). No live adapter does yet — the block-doc render lacks report_doc
  // serializer parity + workspace styling and is hollow for dedicated-builder
  // trades (roofing/solar/painting render from their own tables, not report_doc)
  // per the full-quote-editing v2 spec §10.4/§13.4 — so every trade stays on the
  // full-quote HTML iframe below, which is the editable Word-like surface.
  const showWorkspace = !!docEditorEnabled && canEdit && editorKind === 'block-doc'

  const disabledReason = useMemo(() => {
    if (!capabilities.manualEdit) return `Editing isn’t available for ${trade} quotes yet — view & download only.`
    if (paid) return 'This quote is paid and can’t be edited.'
    if (needsInspection) return 'Inspection quotes are a flat $99 — there are no tiers to edit.'
    if (!owner) return 'Sign in as the quote owner to edit.'
    return null
  }, [capabilities.manualEdit, paid, needsInspection, owner, trade])

  const inlineSrc = `${pdfUrl}${pdfUrl.includes('?') ? '&' : '?'}disposition=inline&v=${reloadKey}`
  // Prefer the live HTML render. `?v=reloadKey` busts the iframe after a save so
  // the preview reflects the just-edited tiers (the HTML route reads the live
  // quotes row, so no PDF regeneration is needed for the preview to update).
  const htmlSrc = htmlUrl ? `${htmlUrl}${htmlUrl.includes('?') ? '&' : '?'}v=${reloadKey}` : null

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      {/* ─── Toolbar (modelled on the report-viewer reference) ─── */}
      {/* top-11: sticks below the layout's h-11 dashboard bar. */}
      <div className="sticky top-11 z-30 border-b border-ink-line bg-ink-deep/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className=" text-[0.7rem] uppercase tracking-[0.08em] text-text-dim">
            Quote report · <span className="text-text-sec">{trade}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => api?.openEditor()}
              disabled={!canEdit}
              title={!canEdit ? disabledReason ?? undefined : undefined}
              className="rounded-ctl inline-flex min-h-[40px] items-center gap-2 border border-ink-line px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-ink-line disabled:hover:text-text-pri"
            >
              ✎ Edit Report
            </button>
            {/* Inspection quotes have no priced PDF — /api/q/[token]/pdf 404s
                for them (route.ts:37-42), so the button is omitted rather than
                dead-ending the tradie on raw JSON. The body iframe still shows
                the graceful "site visit required" placeholder. */}
            {needsInspection ? null : (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-ctl inline-flex min-h-[40px] items-center gap-2 border border-ink-line px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-pri transition-colors hover:border-accent hover:text-accent"
              >
                ↓ Download PDF
              </a>
            )}
            <button
              type="button"
              onClick={() => api?.openEditor({ chat: true })}
              disabled={!canAi}
              title={!canAi ? disabledReason ?? undefined : undefined}
              className="rounded-ctl inline-flex min-h-[40px] items-center gap-2 bg-accent px-4 py-2 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent"
            >
              ⚡ Edit with AI
              <span className="rounded-sm bg-white/20 px-1.5 py-0.5 font-mono text-[0.55rem] leading-none">
                Beta
              </span>
            </button>
            {/* Pick which single tier the quote sends as (roofing defaults to
                'better'/Re-roof, but the tiers are different jobs). Hidden for
                inspection quotes (no committable tiers) and single-option quotes
                (TierSelect self-hides). Sets selected_tier, then refreshes the
                live preview — Send/Download then use the chosen tier. */}
            {!needsInspection && (
              <TierSelect
                quoteId={quoteId}
                tiers={tiers}
                initialSelected={selectedTier ?? null}
                disabled={paid}
                onChanged={() => setReloadKey((k) => k + 1)}
              />
            )}
            <SendQuotePanel
              reviewVersion={props.reviewVersion}
              sentBefore={props.sentBefore}
              quoteId={quoteId}
              customerPhone={customerPhone ?? null}
              customerEmail={customerEmail ?? null}
              paid={paid}
              label={sendLabel}
              smsOnly={isChildRow}
            />
            {/* The post-site-visit chain (spec post-visit-money-sequence
                R3/R10). The server decides which — if either — of these is
                available; the client just renders it. */}
            {chainAction && <ChainActions quoteId={quoteId} action={chainAction} />}
          </div>
        </div>
        {disabledReason && (
          <div className="mx-auto max-w-5xl px-4 pb-2 sm:px-6">
            <p className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
              {disabledReason}
            </p>
          </div>
        )}
      </div>

      {/* ─── Address on file, unconfirmed for THIS job (tradie-only) ─── */}
      {rememberedAddress?.trim() ? (
        <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6">
          <section
            aria-labelledby="remembered-address-heading"
            className="border border-ink-line bg-ink-card px-5 py-4"
          >
            <h2
              id="remembered-address-heading"
              className=" text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-dim"
            >
              Address from customer records &middot; confirm on site
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-text-sec">
              {rememberedAddress.trim()}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-text-dim">
              This customer did not give an address in this conversation. The
              address above is from an earlier job and may be the wrong site.
            </p>
          </section>
        </div>
      ) : null}

      {/* ─── What the engine assumed (tradie-only) ─── */}
      {(riskFlags?.length ?? 0) > 0 && (
        <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6">
          <section
            aria-labelledby="risk-flags-heading"
            className="border border-ink-line bg-ink-card px-5 py-4"
          >
            <h2
              id="risk-flags-heading"
              className=" text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-dim"
            >
              Assumed while pricing · only you see this
            </h2>
            <ul className="mt-3 space-y-2">
              {riskFlags!.map((flag, i) => (
                <li key={i} className="text-sm leading-relaxed text-text-sec">
                  {flag}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {/* ─── Report body ─── */}
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {showWorkspace && reportDoc && token ? (
          <QuoteDocumentWorkspace
            quoteId={quoteId}
            authToken={token}
            initialDoc={reportDoc}
            initialStyle={reportStyle ?? {}}
            tiers={docTiers}
            onEditPrices={() => api?.openEditor()}
          />
        ) : htmlSrc ? (
          <>
            <div className="mb-2 flex items-center gap-2 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              Live preview · edits appear here after you save · Download PDF exports it
            </div>
            <iframe
              key={`html-${reloadKey}`}
              src={htmlSrc}
              title="Quote report"
              className="h-[80vh] w-full rounded border border-ink-line bg-white"
            />
          </>
        ) : bodyMode === 'pdf-inline' ? (
          <iframe
            key={reloadKey}
            src={inlineSrc}
            title="Quote PDF"
            className="h-[80vh] w-full rounded border border-ink-line bg-white"
          />
        ) : (
          <div className="flex flex-col items-center gap-4 rounded border border-ink-line bg-ink-card px-6 py-16 text-center">
            <div className=" text-[0.65rem] uppercase tracking-[0.08em] text-text-dim">
              Inline preview not available yet for {trade}
            </div>
            <p className="max-w-md text-sm text-text-sec">
              Download the PDF to view this quote. An in-page preview and editing for{' '}
              {trade} are coming as each trade is wired up.
            </p>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-ctl inline-flex min-h-[44px] items-center gap-2 bg-accent px-5 py-3 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-accent-press"
            >
              ↓ Download PDF
            </a>
          </div>
        )}
      </div>

      {/* ─── Hidden editor: owns auth + grounding + save; toolbar drives it ─── */}
      {capabilities.manualEdit && gstRegistered !== null && (
        <TradieEditor
          quoteId={quoteId}
          gstRegistered={gstRegistered}
          initialTiers={tiers}
          hideBanner
          onReady={setApi}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      )}
    </main>
  )
}
