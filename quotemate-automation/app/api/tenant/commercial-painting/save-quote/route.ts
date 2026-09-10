// POST /api/tenant/commercial-painting/save-quote — tenant-scoped.
//
// Turns a PRICED run into a real quote record: intakes
// (trade='commercial_painting') + quotes (single tender wrapped into the
// established tier shape, share_token) and a tender PDF rendered via the
// existing Gotenberg pattern into the quote-pdfs bucket at
// quotes/<quoteId>.pdf — the path /api/q/[token]/pdf already serves.
// PDF generation is best-effort: the quote stands without it.
//
// Body: { paintRunId: string, extractionId: string }

import { after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { archiveAndIngestQuote } from '@/lib/filestore/ingest-quote'
import { buildQuoteKbText } from '@/lib/filestore/minimize'
import { buildPaintQuotePayloads } from '@/lib/commercial-painting/save-quote-helpers'
import { buildPaintTenderReportHtml } from '@/lib/commercial-painting/report-html'
import { loadTenantBranding } from '@/lib/pdf/branding'
import { normaliseAuMobile } from '@/lib/commercial-painting/notify'
import { gotenbergConfigured, renderPdfFromHtml } from '@/lib/pdf/gotenberg'
import { generateShareToken } from '@/lib/stripe/checkout'
import { pipelineLog } from '@/lib/log/pipeline'
import { provisionSessionStore } from '@/lib/filestore/provision'
import type { PricedPaintBom } from '@/lib/commercial-painting/types'
import { commercialPaintSaveIdentity, normalisePaintPricedAt, readSavedPaintQuote, UnverifiablePaintQuote, type SavedPaintQuote } from '@/lib/commercial-painting/saved-quote'
import { paintPricingRpcError, PaintPricingProofError, readPaintPricingSource, verifyPaintPricing } from '@/lib/commercial-painting/pricing-proof'
import { publicWebUrl } from '@/lib/sms/public-origin'
import { z } from 'zod'

export const dynamic = 'force-dynamic'
export const maxDuration = 90

const storage = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

/** Read-only reconciliation of a retained reviewed pricing pass. Absence is
 * not proof that an in-flight POST can no longer commit. */
export async function GET(req: Request) {
  const query = new URL(req.url).searchParams
  // Scope opaque recovery receipts to the authenticated account and tenant.
  // Caller-provided identity fields never select the returned scope.
  if (query.get('scope') === '1') {
    const resolved = await resolveTenantRequest(estimatorSupabase, req, 'id')
    if (!resolved?.tenant || typeof resolved.tenant.id !== 'string')
      return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
    return Response.json({ ok: true, userId: resolved.identity.userId, tenantId: resolved.tenant.id },
      { headers: { 'Cache-Control': 'private, no-store' } })
  }
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  const parsed = z.object({ paintRunId: z.string().uuid(), extractionId: z.string().uuid(),
    pricingProof: z.string().regex(/^[a-f0-9]{64}$/), pricedAt: z.string() }).safeParse(Object.fromEntries(query))
  if (!parsed.success || !normalisePaintPricedAt(parsed.data.pricedAt)) return Response.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  const runId = parsed.data.paintRunId.toLowerCase(), extractionId = parsed.data.extractionId.toLowerCase()
  const pricedAt = normalisePaintPricedAt(parsed.data.pricedAt)!
  const attempt = { paintRunId: runId, extractionId, pricingProof: parsed.data.pricingProof, pricedAt }
  const ownedRun = await estimatorSupabase.from('paint_runs').select('id').eq('id', runId).eq('tenant_id', tenant.id).maybeSingle()
  if (ownedRun.error) return Response.json({ ok: false, error: 'source_unavailable' }, { status: 503 })
  if (!ownedRun.data) return Response.json({ ok: false, error: 'run_not_found' }, { status: 404 })
  const identity = commercialPaintSaveIdentity(tenant.id, runId, extractionId, pricedAt)
  try {
    const saved = await readSavedPaintQuote(estimatorSupabase, tenant.id, identity.quoteId,
      { runId, extractionId, pricedAt, pricingProof: parsed.data.pricingProof })
    if (!saved) return Response.json({ ok: true, status: 'not_found', ...attempt })
    return Response.json({ ok: true, status: 'saved', ...attempt, quoteId: saved.id, shareToken: saved.share_token,
      quoteViewUrl: `/q/${saved.share_token}`, pdfUrl: saved.pdf_path ? `/api/q/${saved.share_token}/pdf` : null,
      delivery: { attempted: false } })
  } catch (error) {
    if (error instanceof UnverifiablePaintQuote) return Response.json({ ok: false, error: 'saved_quote_unverifiable' }, { status: 409 })
    return Response.json({ ok: false, error: 'saved_quote_lookup_failed' }, { status: 503 })
  }
}

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = z.object({ paintRunId: z.string().uuid(), extractionId: z.string().uuid(),
    customerPhone: z.string().trim().max(30).optional(), customerName: z.string().trim().max(120).optional(),
    pricingProof: z.string().regex(/^[a-f0-9]{64}$/).optional(), pricedAt: z.string().optional() }).safeParse(rawBody)
  if (!parsed.success) return Response.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  const body = parsed.data
  const paintRunId = body.paintRunId.toLowerCase(), extractionId = body.extractionId.toLowerCase()
  if (body.pricedAt !== undefined && !normalisePaintPricedAt(body.pricedAt)) return Response.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  // Customer details may be attached to the draft for the queue/CRM. Saving
  // never delivers the quote; the reviewed send action owns all SMS/MMS.
  const customerMobile = normaliseAuMobile(body.customerPhone)
  if (body.customerPhone && !customerMobile) return Response.json({ ok: false, error: 'invalid_customer_phone' }, { status: 400 })
  const customerName = body.customerName?.trim() || null
  if (!paintRunId || !extractionId) {
    return Response.json({ ok: false, error: 'missing_ids' }, { status: 400 })
  }

  const [runResult, extractionResult] = await Promise.all([
    estimatorSupabase
      .from('paint_runs')
      .select('id, job_name, site_address')
      .eq('id', paintRunId)
      .eq('tenant_id', tenant.id)
      .maybeSingle(),
    estimatorSupabase
      .from('plan_extractions')
      .select('id, items, corrected_items, priced_bom, priced_at, sheets_used, paint_pricing_proof')
      .eq('id', extractionId)
      .eq('paint_run_id', paintRunId)
      .eq('tenant_id', tenant.id)
      .maybeSingle(),
  ])
  if (runResult.error || extractionResult.error) return Response.json({ ok: false, error: 'source_unavailable' }, { status: 503 })
  const run = runResult.data
  const ext = extractionResult.data
  if (!run) return Response.json({ ok: false, error: 'run_not_found' }, { status: 404 })
  if (!ext) return Response.json({ ok: false, error: 'extraction_not_found' }, { status: 404 })
  // Recover the pass the user reviewed, even if another screen has repriced or
  // cleared the current extraction since this request lost its acknowledgement.
  const reviewedPricedAt = normalisePaintPricedAt(body.pricedAt) ?? normalisePaintPricedAt(ext.priced_at)
  if (!reviewedPricedAt) return Response.json({ ok: false, error: 'not_priced' }, { status: 422 })
  const identity = commercialPaintSaveIdentity(tenant.id, run.id, ext.id, reviewedPricedAt)
  const saveSource = { runId: run.id, extractionId: ext.id, pricedAt: reviewedPricedAt, customerPhone: customerMobile,
    customerName, pricingProof: body.pricingProof }
  const sheets = (ext.sheets_used ?? {}) as Record<string, unknown> & {
    saved_quote?: { quote_id: string; share_token: string; priced_at: string; pdf_ready?: boolean }
  }
  const savedResponse = (saved: SavedPaintQuote) => Response.json({
    ok: true, quoteId: saved.id, shareToken: saved.share_token,
    paintRunId, extractionId, pricingProof: body.pricingProof ?? null, pricedAt: reviewedPricedAt,
    quoteViewUrl: `/q/${saved.share_token}`,
    pdfUrl: saved.pdf_path ? `/api/q/${saved.share_token}/pdf` : null,
    alreadySaved: true, delivery: { attempted: false },
  })
  try {
    const previousId = !body.pricedAt && sheets.saved_quote && sheets.saved_quote.priced_at === ext.priced_at ? sheets.saved_quote.quote_id : identity.quoteId
    const previous = await readSavedPaintQuote(estimatorSupabase, tenant.id, previousId, saveSource)
    if (previous) return savedResponse(previous)
  } catch (error) {
    if (error instanceof UnverifiablePaintQuote) return Response.json({ ok: false, error: 'saved_quote_unverifiable', detail: error.message }, { status: 409 })
    return Response.json({ ok: false, error: 'saved_quote_lookup_failed' }, { status: 503 })
  }
  if (!body.pricedAt || normalisePaintPricedAt(ext.priced_at) !== reviewedPricedAt)
    return Response.json({ ok: false, error: 'pricing_review_required' }, { status: 409 })
  const storedBom = (ext.priced_bom ?? null) as PricedPaintBom | null
  if (!storedBom) return Response.json({ ok: false, error: 'not_priced' }, { status: 422 })
  let calculation
  try {
    const source = await readPaintPricingSource(estimatorSupabase, tenant.id, paintRunId, extractionId)
    calculation = verifyPaintPricing(source, ext.paint_pricing_proof, storedBom, body.pricingProof)
  } catch (error) {
    const failure = error instanceof PaintPricingProofError ? error : new PaintPricingProofError('pricing_unavailable', 503)
    return Response.json({ ok: false, error: failure.code,
      detail: 'The confirmed takeoff or tenant pricing needs review. Re-price before saving a new customer quote.' }, { status: failure.status })
  }
  const { bom, proof } = calculation

  const branding = await loadTenantBranding(estimatorSupabase, tenant.id, 'commercial-painting')

  let shareToken = generateShareToken()
  const payloads = buildPaintQuotePayloads({
    bom,
    tenantId: tenant.id,
    shareToken,
    jobName: proof.source.run.job_name,
    siteAddress: proof.source.run.site_address,
  })

  let quoteRow: SavedPaintQuote
  try {
    const committed = await estimatorSupabase.rpc('save_commercial_paint_quote', {
      p_tenant_id: tenant.id, p_run_id: paintRunId, p_extraction_id: extractionId, p_source: proof.source,
      p_proof: proof, p_bom: bom, p_priced_at: reviewedPricedAt,
      p_intake: { ...payloads.intake, id: identity.intakeId,
        scope: { ...payloads.intake.scope, paint_run_id: paintRunId, extraction_id: extractionId,
          priced_at: reviewedPricedAt, paint_pricing_proof: proof },
        caller: { name: customerName ?? '', phone: customerMobile ?? '', email: '' } },
      p_quote: { ...payloads.quote, id: identity.quoteId, intake_id: identity.intakeId },
    }).abortSignal(AbortSignal.timeout(8000))
    if (committed.error || committed.data?.ok !== true) throw paintPricingRpcError(committed.error)
    const saved = await readSavedPaintQuote(estimatorSupabase, tenant.id, identity.quoteId, saveSource)
    if (!saved || saved.intake_id !== identity.intakeId) throw new Error('Saved tender intake does not match')
    if (committed.data.already === true) return savedResponse(saved)
    quoteRow = saved
    shareToken = saved.share_token
  } catch (error) {
    if (error instanceof UnverifiablePaintQuote) return Response.json({ ok: false, error: 'saved_quote_unverifiable', detail: error.message }, { status: 409 })
    if (error instanceof PaintPricingProofError) return Response.json({ ok: false, error: error.code }, { status: error.status })
    return Response.json(
      { ok: false, error: 'quote_insert_failed' }, { status: 503 },
    )
  }

  // Mint the paint_run's public_token (best-effort, non-blocking) so the rich
  // commercial-paint takeoff page /q/commercial-paint/[token] and the dashboard
  // "saved jobs" link-out card work. Only sets it when absent (idempotent), and
  // a failure here never affects the quote save outcome.
  try {
    await estimatorSupabase
      .from('paint_runs')
      .update({ public_token: generateShareToken() })
      .eq('id', paintRunId)
      .is('public_token', null)
  } catch {
    /* best-effort — the quote + /q/[token] view stand without the rich page */
  }

  // Absolute URL only for the PRINTED footer of the tender PDF (a PDF
  // can't use a relative link); the dashboard's clickable links below
  // are relative so they work on any origin, dev included.
  const log = pipelineLog('estimate', paintRunId)

  // ── Tender PDF — best-effort, never blocks the quote. ─────────────
  let pdfReady = false
  if (gotenbergConfigured()) {
    try {
      const html = buildPaintTenderReportHtml({
        businessName: branding.businessName,
        branding,
        jobName: proof.source.run.job_name,
        siteAddress: proof.source.run.site_address,
        bom,
        quoteViewUrl: publicWebUrl(`/q/${shareToken}`),
      })
      const pdf = await renderPdfFromHtml(html)
      const path = `quotes/${quoteRow.id}.pdf`
      const { error: upErr } = await storage.storage
        .from('quote-pdfs')
        .upload(path, pdf, { contentType: 'application/pdf', upsert: true })
      if (!upErr) {
        await estimatorSupabase.from('quotes').update({ pdf_path: path }).eq('id', quoteRow.id)
        pdfReady = true
        // Index the finished tender PDF into the run's persistent store so the
        // estimator chatbot can answer "why this price?" from the result itself.
        provisionSessionStore({
          estimator: 'paint',
          sessionId: paintRunId,
          label: customerName ?? (run.job_name as string | null) ?? null,
          documents: [{ name: 'paint-quote.pdf', bytes: pdf, mime: 'application/pdf' }],
        })
      } else {
        log.err('paint tender pdf upload failed', upErr, { quoteId: quoteRow.id })
      }
    } catch (e) {
      // PDF is a bonus; the quote record is the deliverable — but the
      // failure must be visible in platform logs, not swallowed.
      log.err('paint tender pdf render failed', e, { quoteId: quoteRow.id })
    }
  } else {
    log.err('paint tender pdf skipped — GOTENBERG_URL not configured', undefined, { quoteId: quoteRow.id })
  }

  // Best-effort UI projection. Stable owned row IDs above are the save anchor;
  // response loss here cannot create another draft on a retry.
  try {
    const { error: projectionError } = await estimatorSupabase
    .from('plan_extractions')
    .update({
      sheets_used: {
        ...sheets,
        saved_quote: {
          quote_id: quoteRow.id,
          share_token: shareToken,
          priced_at: ext?.priced_at ?? null,
          pdf_ready: pdfReady,
        },
      },
    })
    .eq('id', extractionId)
    .eq('tenant_id', tenant.id)
    .eq('paint_run_id', paintRunId)
    if (projectionError) log.err('paint saved quote projection failed', projectionError, { quoteId: quoteRow.id })
  } catch (error) {
    log.err('paint saved quote projection failed', error, { quoteId: quoteRow.id })
  }

  log.ok('paint quote saved', {
    quoteId: quoteRow.id,
    totalIncGst: bom.totalIncGst,
    pdfReady,
    delivered: 'not_attempted',
  })

  // ── Per-tenant file-store archive + KB ingest (spec 2026-06-19). The full
  //    tender PDF was already archived at quotes/<quoteId>.pdf above; here we
  //    push ONLY the PII-minimized summary into the tenant's KB. Best-effort,
  //    never throws, STUBs when TENANT_FILESTORE_ENABLED!=='true', and no-ops
  //    when no PDF was produced (no fullDocPath). Tracking source_id for
  //    painting is the painting public_token (== shareToken), not the quoteId.
  if (pdfReady) {
    after(async () => {
      const { markdown, contentHash } = buildQuoteKbText({
        quote: { estimate: bom },
        trade: 'commercial-painting',
      })
      await archiveAndIngestQuote({
        tenantId: tenant.id,
        sourceKind: 'quote',
        trade: 'commercial-painting',
        sourceId: shareToken,
        fullDocPath: `quotes/${quoteRow.id}.pdf`,
        kbText: markdown,
        contentHash,
      })
    })
  }

  return Response.json({
    ok: true,
    paintRunId, extractionId, pricingProof: proof.digest, pricedAt: reviewedPricedAt,
    quoteId: quoteRow.id,
    shareToken,
    quoteViewUrl: `/q/${shareToken}`,
    pdfUrl: pdfReady ? `/api/q/${shareToken}/pdf` : null,
    delivery: { attempted: false },
  })
}
