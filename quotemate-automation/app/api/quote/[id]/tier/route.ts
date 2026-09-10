// PATCH /api/quote/[id]/tier
//
// Set which single tier (good/better/best) a quote sends as. The tradie picks
// on the dashboard quote viewer BEFORE sending; roofing defaults to 'better'
// (Re-roof) but the tiers are genuinely different jobs (Patch / Re-roof /
// Upgrade), so the tradie needs to choose.
//
// This is a VIEW choice, not a re-price: the full good/better/best jsonb is
// untouched. In 'single' tier mode (the platform default) resolveVisibleTiers
// renders exactly selected_tier across the SMS, the email PDF, and /q/[token],
// so setting this column is all that's needed. We also recompute the headline
// total_inc_gst (mirrors /api/quote/[id]/edit) and invalidate the cached PDF so
// the next download/send regenerates for the chosen tier; the live HTML preview
// reads the row directly, so it updates immediately.
//
// Auth: bearer token (Clerk or legacy Supabase), owner-only — mirrors /send + /edit.

import { createClient } from '@supabase/supabase-js'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'
import { resolveTierSelection, type PricedTier } from '@/lib/quote/select-tier'
import { type QuoteEditRow, QUOTE_EDIT_FIELDS, quoteEditRevision, validOwnedQuoteBook, validExpectedRevision } from '@/lib/quote/edit-authority'
import { loadQuotePricingVersion, versionedQuoteGst, QuotePricingVersionError, type QuotePricingVersion } from '@/lib/quote/pricing-version'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: quoteId } = await params
  if (!quoteId) {
    return Response.json({ ok: false, error: 'missing_quote_id' }, { status: 400 })
  }

  let body: { tier?: unknown; expected_revision?: unknown } = {}
  try {
    const raw: unknown = await req.json()
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) body = raw
  } catch {
    /* malformed body → resolveTierSelection rejects below */
  }
  if (!validExpectedRevision(body.expected_revision)) return Response.json({ ok: false, error: 'invalid_revision' }, { status: 400 })

  // ─── Auth (dual-auth: Clerk OR legacy Supabase token) ──
  const resolved = await resolveTenantRequest(supabase, req, 'id')
  if (!resolved) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const tenant = resolved.tenant as { id: string } | null

  // ─── Load quote + verify ownership + editability ──
  const { data: quote, error: qErr } = await supabase
    .from('quotes')
    .select(QUOTE_EDIT_FIELDS.join(','))
    .eq('id', quoteId)
    .maybeSingle<QuoteEditRow>()
  if (qErr) return Response.json({ ok: false, error: qErr.message }, { status: 500 })
  if (!quote) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  if (!quote.tenant_id) {
    return Response.json({ ok: false, error: 'unscoped_quote' }, { status: 403 })
  }
  if (!tenant || quote.tenant_id !== tenant.id) {
    return Response.json({ ok: false, error: 'not_owner' }, { status: 403 })
  }
  const readiness = await readQuoteDraftReadiness(supabase, quote)
  if (!readiness.ready) return Response.json({ ok: false, error: readiness.code }, { status: 409 })
  if (quote.paid_at) {
    return Response.json({ ok: false, error: 'quote_already_paid' }, { status: 409 })
  }
  if (body.expected_revision && body.expected_revision !== quoteEditRevision(quote)) {
    return Response.json({ ok: false, error: 'quote_changed' }, { status: 409 })
  }
  if (quote.needs_inspection) {
    return Response.json(
      {
        ok: false,
        error: 'inspection_quote',
        hint: 'Inspection-required quotes have no tier to choose — they route to the flat $99 site visit.',
      },
      { status: 409 },
    )
  }

  const { data: intake, error: intakeError } = await supabase.from('intakes')
    .select('tenant_id, trade').eq('id', quote.intake_id).eq('tenant_id', tenant.id).maybeSingle()
  const trade = intake?.trade
  if (intakeError) return Response.json({ ok: false, error: 'pricing_unavailable' }, { status: 503 })
  if (!intake || intake.tenant_id !== tenant.id || typeof trade !== 'string' || !trade.trim()) {
    return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  }
  let savedVersion: QuotePricingVersion | null
  try { savedVersion = await loadQuotePricingVersion(supabase, quote, trade) }
  catch (error) {
    return Response.json({ ok: false, error: error instanceof QuotePricingVersionError ? error.code : 'pricing_unavailable' },
      { status: error instanceof QuotePricingVersionError ? error.status : 503 })
  }
  const { data: currentBook, error: bookError } = savedVersion ? { data: null, error: null } : await supabase
    .from('pricing_book')
    .select('id, tenant_id, trade, gst_registered')
    .eq('tenant_id', quote.tenant_id)
    .eq('trade', trade)
    .maybeSingle()
  const pb = savedVersion?.snapshot ?? currentBook
  if (bookError) return Response.json({ ok: false, error: 'pricing_unavailable' }, { status: 503 })
  const gstRegistered = versionedQuoteGst(quote, savedVersion)
  if (!validOwnedQuoteBook(pb, tenant.id, trade) || gstRegistered === null) {
    return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  }

  const result = resolveTierSelection({
    tier: body.tier,
    tiers: {
      good: quote.good as PricedTier,
      better: quote.better as PricedTier,
      best: quote.best as PricedTier,
    },
    gstRegistered,
  })
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 })
  }

  let update = supabase
    .from('quotes')
    .update({
      selected_tier: result.selectedTier,
      total_inc_gst: result.totalIncGst,
      // Invalidate the cached customer PDF so the next download/send regenerates
      // for the newly chosen tier (the pdf_signature also captures visible tiers,
      // but nulling here is explicit and matches the edit route's invalidation).
      pdf_path: null,
      pdf_signature: null,
    })
    .eq('id', quoteId)
    .eq('tenant_id', tenant.id)
    .is('paid_at', null)
    .eq('total_inc_gst', quote.total_inc_gst)
  for (const key of QUOTE_EDIT_FIELDS) {
    if (['id', 'tenant_id', 'paid_at', 'total_inc_gst'].includes(key)) continue
    const value = quote[key]
    update = value == null ? update.is(key, null) : update.eq(key,
      typeof value === 'object' ? JSON.stringify(value) : value)
  }
  const { data: saved, error: updErr } = await update.select(QUOTE_EDIT_FIELDS.join(',')).maybeSingle<QuoteEditRow>()
  if (updErr) {
    return Response.json(
      { ok: false, error: 'update_failed', detail: updErr.message },
      { status: 500 },
    )
  }
  if (!saved) return Response.json({ ok: false, error: 'quote_changed', hint: 'Reload the quote before choosing a tier.' }, { status: 409 })

  return Response.json({ ok: true, persisted: true, edit_revision: quoteEditRevision(saved), selected_tier: result.selectedTier, total_inc_gst: result.totalIncGst, gst_registered: gstRegistered })
}
