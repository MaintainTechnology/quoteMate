// POST /api/tenant/calibration/accept — A5 apply-a-suggestion endpoint.
//
// Body: { trade: string, accept: boolean }
//
// On accept=true:
//   1. Re-run the calibration to get the current freshly-computed
//      suggestion for the trade. (We don't trust a stale client-side
//      copy — the source of truth is what calibration says NOW.)
//   2. Reject when the suggestion has trust='reject' OR when it's
//      missing (no suggestion to apply).
//   3. Snapshot the prior pricing_book.hourly_rate.
//   4. Update pricing_book.hourly_rate to suggested_value.
//   5. Insert a pricing_suggestions row with status='accepted',
//      prior value, applied_pricing_book_id, accepted_at, accepted_by.
//
// On accept=false:
//   1. Same as above through step 2 (fresh re-run + sanity check).
//   2. Insert pricing_suggestions row with status='rejected'. No
//      pricing_book write.
//
// Side-effect of an accept is reversible: the pricing_suggestions row
// records the prior value and the applied row id. A future "undo"
// endpoint can read that, write it back, and flag status='superseded'.

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  buildCalibrationReport,
  type AssemblyForMatch,
  type InvoiceExtraction,
  type TenantPricingContext,
} from '@/lib/dashboard/invoice-calibration'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BodySchema = z.object({
  trade: z.string().min(1).max(40),
  accept: z.boolean(),
})

async function userAndTenantFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, trade, trades')
    .eq('owner_user_id', data.user.id)
    .maybeSingle()
  if (!tenant) return null
  return {
    userId: data.user.id,
    tenant: tenant as { id: string; trade: string | null; trades: string[] | null },
  }
}

export async function POST(req: Request) {
  const ctx = await userAndTenantFromBearer(req)
  if (!ctx) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const { userId, tenant } = ctx

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'validation_failed', fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }
  const { trade, accept } = parsed.data

  // Sanity-check the trade is one the tenant actually operates in.
  const trades =
    Array.isArray(tenant.trades) && tenant.trades.length > 0
      ? tenant.trades
      : tenant.trade
        ? [tenant.trade]
        : []
  if (!trades.includes(trade)) {
    return Response.json(
      { ok: false, error: 'trade_not_active', message: `Trade '${trade}' is not active for this tenant.` },
      { status: 400 },
    )
  }

  // Re-run calibration to get the current suggestion (the source of truth).
  const { data: pb } = await supabase
    .from('pricing_book')
    .select('id, hourly_rate, default_markup_pct, gst_registered')
    .eq('tenant_id', tenant.id)
    .eq('trade', trade)
    .maybeSingle()
  if (!pb) {
    return Response.json(
      { ok: false, error: 'no_pricing_book', message: `No pricing_book row for tenant+trade.` },
      { status: 404 },
    )
  }

  const { data: extractionsRaw } = await supabase
    .from('invoice_extractions')
    .select(
      'id, scope_description, total_inc_gst, job_type_guess, quantity, customer_name, customer_suburb, invoice_date',
    )
    .eq('tenant_id', tenant.id)

  const extractions: InvoiceExtraction[] = (extractionsRaw ?? []).map((e) => ({
    scope_description: e.scope_description ?? '',
    total_inc_gst: Number(e.total_inc_gst),
    job_type_guess: e.job_type_guess as InvoiceExtraction['job_type_guess'],
    quantity: e.quantity == null ? null : Number(e.quantity),
    customer_name: e.customer_name,
    customer_suburb: e.customer_suburb,
    invoice_date: e.invoice_date,
  }))

  const { data: shared } = await supabase
    .from('shared_assemblies')
    .select('id, name, category, trade, default_labour_hours, default_unit_price_ex_gst')
    .eq('trade', trade)

  const { data: custom } = await supabase
    .from('tenant_custom_assemblies')
    .select('id, name, category, trade, default_labour_hours, default_unit_price_ex_gst')
    .eq('tenant_id', tenant.id)
    .eq('trade', trade)

  const candidates: AssemblyForMatch[] = [...(shared ?? []), ...(custom ?? [])]

  const context: TenantPricingContext = {
    hourly_rate: Number(pb.hourly_rate),
    default_markup_pct: Number(pb.default_markup_pct),
    gst_registered: Boolean(pb.gst_registered),
    trade,
  }
  const report = buildCalibrationReport(extractions, candidates, context)
  const suggestion = report.suggestions[0]
  if (!suggestion) {
    return Response.json(
      { ok: false, error: 'no_suggestion', message: 'No calibration suggestion available.' },
      { status: 400 },
    )
  }
  if (suggestion.trust === 'reject') {
    return Response.json(
      {
        ok: false,
        error: 'suggestion_rejected_by_trust_gate',
        message: suggestion.reject_reason ?? 'Trust gate rejected this suggestion.',
      },
      { status: 400 },
    )
  }

  if (!accept) {
    // Log the explicit decline so the user history shows a "rejected at" entry.
    const { data: row, error: insErr } = await supabase
      .from('pricing_suggestions')
      .insert({
        tenant_id: tenant.id,
        trade,
        field: 'hourly_rate',
        current_value: suggestion.current_value,
        suggested_value: suggestion.suggested_value,
        delta: suggestion.delta,
        delta_pct: suggestion.delta_pct,
        trust: suggestion.trust,
        reject_reason: suggestion.reject_reason ?? null,
        reason: suggestion.reason,
        invoices_used: suggestion.invoices_used,
        diff_pct_min: suggestion.diff_pct_min,
        diff_pct_max: suggestion.diff_pct_max,
        diff_pct_median: suggestion.diff_pct_median,
        status: 'rejected',
        rejected_at: new Date().toISOString(),
        rejected_by_user_id: userId,
      })
      .select('id')
      .single()
    if (insErr) {
      return Response.json(
        { ok: false, error: 'suggestion_insert_failed', message: insErr.message },
        { status: 500 },
      )
    }
    return Response.json({ ok: true, action: 'rejected', suggestion_id: row?.id })
  }

  // accept=true: update pricing_book + insert accepted suggestion row.
  const priorValue = Number(pb.hourly_rate)
  const { error: pbErr } = await supabase
    .from('pricing_book')
    .update({ hourly_rate: suggestion.suggested_value })
    .eq('id', pb.id)
    .eq('tenant_id', tenant.id)
    .eq('trade', trade)
  if (pbErr) {
    return Response.json(
      { ok: false, error: 'pricing_book_update_failed', message: pbErr.message },
      { status: 500 },
    )
  }
  const { data: row, error: insErr } = await supabase
    .from('pricing_suggestions')
    .insert({
      tenant_id: tenant.id,
      trade,
      field: 'hourly_rate',
      current_value: priorValue,
      suggested_value: suggestion.suggested_value,
      delta: suggestion.delta,
      delta_pct: suggestion.delta_pct,
      trust: suggestion.trust,
      reject_reason: null,
      reason: suggestion.reason,
      invoices_used: suggestion.invoices_used,
      diff_pct_min: suggestion.diff_pct_min,
      diff_pct_max: suggestion.diff_pct_max,
      diff_pct_median: suggestion.diff_pct_median,
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      accepted_by_user_id: userId,
      applied_pricing_book_id: pb.id,
      prior_pricing_book_value: priorValue,
    })
    .select('id')
    .single()
  if (insErr) {
    return Response.json(
      { ok: false, error: 'suggestion_insert_failed', message: insErr.message },
      { status: 500 },
    )
  }

  return Response.json({
    ok: true,
    action: 'accepted',
    suggestion_id: row?.id,
    pricing_book_id: pb.id,
    prior_hourly_rate: priorValue,
    new_hourly_rate: suggestion.suggested_value,
  })
}
