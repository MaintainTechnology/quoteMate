// POST /api/quote/[id]/document — persist the quote DOCUMENT (report_doc) and
// per-quote branding (report_style). Spec 2026-07-06 §6.3.
//
// This is a deliberately SEPARATE, focused write from the money route
// (/api/quote/[id]/edit): it touches NO money field — no good/better/best, no
// Stripe re-issue, no grounding gate, no status bump, no customer notify. A
// document/branding edit therefore CANNOT affect pricing by construction. It
// reuses /edit's owner-gate + paid/inspection guards, and nulls the PDF cache so
// the next render reflects the new content (when FULL_QUOTE_DOC is on).
//
// Owner-gate = Bearer → auth.getUser → load quote → quote.tenant → require
// tenant.owner_user_id === userId. Identity comes from the token, never the body
// or path (no IDOR).

import { createClient } from '@supabase/supabase-js'
import { validateReportDocWrite } from '@/lib/quote/report-doc/validate-write'
import { validateReportStyle } from '@/lib/quote/report-doc/style'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'
import { type QuoteEditRow, QUOTE_EDIT_FIELDS, quoteEditRevision, validExpectedRevision } from '@/lib/quote/edit-authority'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: quoteId } = await params

  // ─── Auth (dual-auth: Clerk OR legacy Supabase token) ───────
  const resolved = await resolveTenantRequest(supabase, req, 'id')
  if (!resolved) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const tenant = resolved.tenant as { id: string } | null

  // ─── Body ───────────────────────────────────────────────────
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 })
  }
  const body = raw as { report_doc?: unknown; report_style?: unknown; expected_revision?: unknown }
  if (!validExpectedRevision(body.expected_revision)) return Response.json({ ok: false, error: 'invalid_revision' }, { status: 400 })
  const hasDoc = body.report_doc !== undefined
  const hasStyle = body.report_style !== undefined
  if (!hasDoc && !hasStyle) {
    return Response.json({ ok: false, error: 'no_changes' }, { status: 400 })
  }

  // ─── Load + authorise (mirrors /edit) ───────────────────────
  const { data: quote, error: readError } = await supabase
    .from('quotes')
    .select(QUOTE_EDIT_FIELDS.join(','))
    .eq('id', quoteId)
    .maybeSingle<QuoteEditRow>()
  if (readError) return Response.json({ ok: false, error: 'quote_unavailable' }, { status: 503 })
  if (!quote) return Response.json({ ok: false, error: 'no_quote' }, { status: 404 })
  if (!quote.tenant_id) {
    return Response.json({ ok: false, error: 'unscoped_quote' }, { status: 403 })
  }
  if (quote.paid_at) {
    return Response.json({ ok: false, error: 'quote_already_paid' }, { status: 409 })
  }
  if (quote.needs_inspection) {
    return Response.json({ ok: false, error: 'cannot_edit_inspection_quote' }, { status: 409 })
  }

  if (!tenant || quote.tenant_id !== tenant.id) {
    return Response.json({ ok: false, error: 'not_owner' }, { status: 403 })
  }
  // The same rollout gate controls owner preview/PDF rendering and writes.
  if (process.env.FULL_QUOTE_DOC !== 'true') {
    return Response.json({ ok: false, error: 'document_editor_disabled' }, { status: 409 })
  }
  const readiness = await readQuoteDraftReadiness(supabase, quote)
  if (!readiness.ready) return Response.json({ ok: false, error: readiness.code }, { status: 409 })
  if (body.expected_revision && body.expected_revision !== quoteEditRevision(quote)) {
    return Response.json({ ok: false, error: 'quote_changed' }, { status: 409 })
  }

  // ─── Validate + persist (quiet, PDF-cache invalidated) ──────
  const update: Record<string, unknown> = { pdf_path: null, pdf_signature: null }
  if (hasDoc) {
    const document = validateReportDocWrite(body.report_doc)
    if (!document) return Response.json({ ok: false, error: 'invalid_document' }, { status: 422 })
    update.report_doc = document
  }
  if (hasStyle) {
    // `null` explicitly clears the override; any other invalid value is rejected.
    const style = validateReportStyle(body.report_style)
    if (body.report_style !== null && style === null) {
      return Response.json({ ok: false, error: 'invalid_style' }, { status: 400 })
    }
    if (style?.logoPath && (!style.logoPath.startsWith(`branding/${tenant.id}/`) ||
        ['.', '..'].includes(style.logoPath.split('/').at(-1)!))) {
      return Response.json({ ok: false, error: 'invalid_style' }, { status: 400 })
    }
    update.report_style = style
  }

  let save = supabase.from('quotes').update(update).eq('id', quoteId)
    .eq('tenant_id', tenant.id).is('paid_at', null)
  for (const key of QUOTE_EDIT_FIELDS) {
    if (['id', 'tenant_id', 'paid_at'].includes(key)) continue
    const value = quote[key]
    save = value == null ? save.is(key, null) : save.eq(key,
      typeof value === 'object' ? JSON.stringify(value) : value)
  }
  const { data: saved, error } = await save.select(QUOTE_EDIT_FIELDS.join(',')).maybeSingle<QuoteEditRow>()
  if (error) {
    return Response.json({ ok: false, error: 'save_failed' }, { status: 500 })
  }
  if (!saved) return Response.json({ ok: false, error: 'quote_changed' }, { status: 409 })
  return Response.json({ ok: true, persisted: true, edit_revision: quoteEditRevision(saved) })
}
