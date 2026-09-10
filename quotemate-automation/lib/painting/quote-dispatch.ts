// ════════════════════════════════════════════════════════════════════
// Painting — run the estimate + persist a saved job, for the non-dashboard
// callers (the SMS receptionist and the public self-serve form). Both need
// the SAME thing the dashboard does: resolve the tenant's rate-card overlay,
// run estimatePainting, and insert a painting_measurements row with a public
// token — but WITHOUT an authenticated user (created_by is null for a lead).
//
// Factored here so the SMS route branch and the /paint-request form POST
// share one code path instead of drifting. I/O glue over already-tested pure
// units (estimatePainting, buildSavedPaintingRow, the rate-card overlay).
// ════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { estimatePainting } from './measure'
import { buildSavedPaintingRow } from './save-row'
import { completePaintingRateCard } from './complete-rate-card'
import type { EstimateRequest } from './request-schema'
import type { PaintingEstimate, PaintingRateCard } from './types'
import { ensurePaintingPdf, signQuotePdfUrl } from '@/lib/quote/pdf'
import { buildPaintingInspectionSms, buildPaintingQuoteSms } from '@/lib/sms/painting-compose'
import { asQuoteTierMode, type QuoteTierMode } from '@/lib/quote/tier-visibility'

export type PaintingQuoteDispatch =
  | {
      ok: true
      /** painting_measurements.public_token — the customer quote page. */
      token: string
      /** painting_measurements.estimate_token — the tradie review page (/p). */
      estimateToken: string
      estimate: PaintingEstimate
      inspection: boolean
    }
  | { ok: false; reason: string }

/** Best-effort — the per-tenant painting rate-card overlay, resolved exactly
 *  like app/api/painting/estimate (prefer the painting pricing_book row's
 *  card, then the primary-trade row's, then any row that carries one). */
export async function loadPaintingRateCard(
  supabase: SupabaseClient,
  tenantId: string,
  primaryTrade: string | null,
): Promise<PaintingRateCard | undefined> {
  try {
    const { data, error } = await supabase
      .from('pricing_book')
      .select('trade, overlays')
      .eq('tenant_id', tenantId)
    if (error || !Array.isArray(data) || data.length === 0) return undefined
    const cardOf = (row: { overlays?: unknown } | undefined): unknown => {
      const overlays = (row?.overlays as Record<string, unknown> | null | undefined) ?? null
      return overlays?.painting_rate_card ?? null
    }
    const byTrade = (t: string) => data.find((r) => (r as { trade?: string }).trade === t)
    const overlayJson =
      cardOf(byTrade('painting')) ??
      (primaryTrade ? cardOf(byTrade(primaryTrade)) : null) ??
      cardOf(data.find((r) => cardOf(r) != null)) ??
      null
    return completePaintingRateCard(overlayJson)
  } catch {
    return undefined
  }
}

/**
 * Run the painting estimate for a gathered request and persist it as a
 * painting_measurements row, returning the public token + estimate. Never
 * throws on operational failure — a provider miss or save error surfaces as
 * { ok: false, reason } so the caller can fall back to an inspection / retry
 * message. `inspection` is true when the estimate routed to an on-site measure.
 */
export async function runAndSavePaintingQuote(args: {
  supabase: SupabaseClient
  tenantId: string | null
  primaryTrade?: string | null
  customerPhone?: string | null
  customerName?: string | null
  request: EstimateRequest
  requestKey?: string
}): Promise<PaintingQuoteDispatch> {
  if (!args.tenantId) return { ok: false, reason: 'tenant painting pricing setup required' }
  const requestKey = args.requestKey ?? createHash('sha256').update(JSON.stringify([args.customerPhone, args.request])).digest('hex')
  const { data: existing, error: lookupError } = await args.supabase.from('painting_measurements')
    .select('public_token,estimate_token,estimate,routing').eq('tenant_id', args.tenantId)
    .eq('source_request_key', requestKey).maybeSingle()
  if (lookupError) return { ok: false, reason: 'painting saved-work lookup unavailable' }
  if (existing?.public_token && existing.estimate_token && existing.estimate) {
    return { ok: true, token: existing.public_token, estimateToken: existing.estimate_token,
      estimate: existing.estimate as PaintingEstimate, inspection: existing.routing === 'inspection_required' }
  }
  const rateCard = args.tenantId
    ? await loadPaintingRateCard(args.supabase, args.tenantId, args.primaryTrade ?? null)
    : undefined
  if (!rateCard) return { ok: false, reason: 'tenant painting pricing setup required' }

  const est = await estimatePainting(args.request.address, args.request.inputs, {
    rateCard,
  })
  if (!est.ok) return { ok: false, reason: est.detail }

  const estimate = est.estimate
  const inspection = estimate.price.routing.decision === 'inspection_required'
  // Spec painting-auto-send R1 — a PRICED lead is released the moment it is
  // saved, exactly as the dashboard path already does
  // (app/api/painting/save/route.ts). The tradie review gate is retired: both
  // callers text the customer their full quote on this same turn, and the
  // quote page, the PDF route and the $99 site-visit mint all gate on
  // released_at — so the stamp has to land BEFORE the send, not after it.
  // An inspection-routed row has no price to show and keeps its null.
  const row = buildSavedPaintingRow({
    tenantId: args.tenantId,
    userId: null,
    releasedAt: null,
    data: {
      address: args.request.address,
      source: estimate.provider,
      inputs: args.request.inputs,
      estimate,
      customer_name: args.customerName ?? null,
      customer_phone: args.customerPhone ?? null,
    },
  })

  const { data, error } = await args.supabase
    .from('painting_measurements')
    .insert({ ...row, source_request_key: requestKey })
    .select('public_token, estimate_token')
    .single()
  if (error || !data) {
    if (error?.code === '23505') {
      // Another attempt committed first. Read its exact persisted token.
      const winner = await args.supabase.from('painting_measurements')
        .select('public_token,estimate_token,estimate,routing').eq('tenant_id', args.tenantId)
        .eq('source_request_key', requestKey).maybeSingle()
      if (!winner.error && winner.data?.public_token && winner.data.estimate_token && winner.data.estimate) {
        return { ok: true, token: winner.data.public_token, estimateToken: winner.data.estimate_token,
          estimate: winner.data.estimate as PaintingEstimate, inspection: winner.data.routing === 'inspection_required' }
      }
    }
    return { ok: false, reason: error?.message ?? 'painting save failed' }
  }

  const saved = data as { public_token: string; estimate_token: string }
  const token = saved.public_token
  const estimateToken = saved.estimate_token

  // No Stripe session is minted here. Draft time used to create up to three
  // per-tier 30% deposit Sessions, but since spec painting-site-visit-first
  // nothing can link them (/r/paint 302s G/B/B onto the $99 site visit), and
  // this function is awaited BEFORE the customer's holding SMS — so those were
  // three sequential Stripe round-trips of pure latency producing dead links.
  // The one payable Session, the flat $99 site visit, is minted on demand by
  // /r/paint/<token>/inspection and stored under stripe_links.inspection.
  return { ok: true, token, estimateToken, estimate, inspection }
}

/**
 * Best-effort — ensure the painting quote PDF exists and return a short-lived
 * signed URL suitable for an MMS attachment. Returns undefined on any miss
 * (no PDF, signing failed) so the caller just sends the plain SMS, whose body
 * already carries the PDF download link. Never throws.
 */
export async function resolvePaintingPdfMms(token: string): Promise<string | undefined> {
  try {
    const path = await ensurePaintingPdf(token)
    if (!path) return undefined
    return await signQuotePdfUrl(path, 60 * 60)
  } catch (e) {
    console.warn('[painting] PDF MMS sign failed (non-fatal)', e instanceof Error ? e.message : e)
    return undefined
  }
}

/**
 * Build the customer-facing painting quote delivery — the SMS body plus the
 * best-effort PDF MMS URL — for a successful dispatch. ONE place both the SMS
 * Q&A path (handlePaintingTurn) and the self-serve form POST call, so the two
 * never drift:
 *   • priced     → G/B/B prices + quote-page link + PDF link + the $99
 *                  site-visit short-link (painting's ONE customer payment,
 *                  spec painting-site-visit-first), PDF attached as an MMS.
 *   • inspection → the on-site-measure message (no price / Stripe / PDF).
 * The caller decides where to send (the tenant's number) and how to persist.
 */
export async function composePaintingQuoteDelivery(args: {
  supabase: SupabaseClient
  disp: Extract<PaintingQuoteDispatch, { ok: true }>
  address: string
  appUrl: string
  tenantId: string | null
  firstName?: string | null
}): Promise<{ text: string; mmsUrl?: string }> {
  const { supabase, disp, address, appUrl, tenantId, firstName } = args
  const quoteUrl = `${appUrl}/q/paint/${disp.token}`

  if (disp.inspection) {
    return {
      text: buildPaintingInspectionSms({
        firstName,
        address,
        reason: disp.estimate.price.routing.reason,
        quoteUrl,
      }),
    }
  }

  // Mig 142/146 — per-tenant painting tier presentation mode (which tiers,
  // and therefore which Stripe links, appear).
  let tierMode: QuoteTierMode = 'single'
  if (tenantId) {
    const { data: rb } = await supabase
      .from('pricing_book')
      .select('quote_tier_mode')
      .eq('tenant_id', tenantId)
      .eq('trade', 'painting')
      .maybeSingle()
    tierMode = asQuoteTierMode((rb as { quote_tier_mode?: string | null } | null)?.quote_tier_mode ?? null)
  }

  const pdfUrl = `${appUrl}/api/q/paint/${disp.token}/pdf`
  const mmsUrl = await resolvePaintingPdfMms(disp.token)
  const text = buildPaintingQuoteSms({
    estimate: disp.estimate,
    address,
    quoteUrl,
    pdfUrl,
    firstName,
    tierMode,
    token: disp.token,
    appUrl,
  })
  return { text, mmsUrl }
}
