// GET /api/tenant/calibration — A5 calibration report endpoint.
//
// Returns:
//   • All invoice_uploads for the tenant (for the "your uploads" list)
//   • All invoice_extractions (the structured data feeding calibration)
//   • A FRESHLY-COMPUTED CalibrationReport per trade — runs the pure
//     buildCalibrationReport() against the current shared_assemblies +
//     tenant_custom_assemblies catalogue every time. So a tradie who
//     adds a new shared row (say "Replace LED downlight" gets re-priced)
//     immediately sees their recipes recalibrate against existing
//     uploads, no re-extraction needed.
//   • All persisted pricing_suggestions rows (pending + history).
//
// The "fresh suggestion" is NOT persisted on every GET — that'd churn
// the table. The /accept route does the persistence + audit log.

import { createClient } from '@supabase/supabase-js'
import {
  buildCalibrationReport,
  type AssemblyForMatch,
  type InvoiceExtraction,
  type TenantPricingContext,
} from '@/lib/dashboard/invoice-calibration'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function tenantFromBearer(req: Request) {
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
  return tenant as { id: string; trade: string | null; trades: string[] | null }
}

function tradesOf(tenant: { trade: string | null; trades: string[] | null }): string[] {
  return Array.isArray(tenant.trades) && tenant.trades.length > 0
    ? tenant.trades
    : tenant.trade
      ? [tenant.trade]
      : []
}

export async function GET(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const trades = tradesOf(tenant)

  // Uploads (most-recent first).
  const { data: uploads } = await supabase
    .from('invoice_uploads')
    .select('id, status, mime_type, error, created_at, updated_at')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false })
    .limit(100)

  // Extractions — full set, the calibration math reads all.
  const { data: extractions } = await supabase
    .from('invoice_extractions')
    .select(
      'id, upload_id, scope_description, total_inc_gst, job_type_guess, quantity, customer_name, customer_suburb, invoice_date, created_at',
    )
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false })

  // Persisted suggestions (any status).
  const { data: suggestions } = await supabase
    .from('pricing_suggestions')
    .select('*')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false })

  // Fresh per-trade report — run calibration each request so the answer
  // tracks catalogue changes without needing a refresh job.
  const reports: Record<string, ReturnType<typeof buildCalibrationReport>> = {}
  for (const trade of trades) {
    const tradeExtractions: InvoiceExtraction[] = (extractions ?? [])
      .filter((e) => true) // all extractions feed all trades; matchRecipe filters by trade
      .map((e) => ({
        scope_description: e.scope_description ?? '',
        total_inc_gst: Number(e.total_inc_gst),
        job_type_guess: e.job_type_guess as InvoiceExtraction['job_type_guess'],
        quantity: e.quantity == null ? null : Number(e.quantity),
        customer_name: e.customer_name,
        customer_suburb: e.customer_suburb,
        invoice_date: e.invoice_date,
      }))

    const { data: pb } = await supabase
      .from('pricing_book')
      .select('hourly_rate, default_markup_pct, gst_registered')
      .eq('tenant_id', tenant.id)
      .eq('trade', trade)
      .maybeSingle()
    if (!pb) {
      reports[trade] = {
        invoices_total: (extractions ?? []).length,
        invoices_matched: 0,
        invoices_skipped: (extractions ?? []).length,
        skip_breakdown: { no_pricing_book: (extractions ?? []).length },
        suggestions: [],
      }
      continue
    }

    const context: TenantPricingContext = {
      hourly_rate: Number(pb.hourly_rate),
      default_markup_pct: Number(pb.default_markup_pct),
      gst_registered: Boolean(pb.gst_registered),
      trade,
    }

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

    reports[trade] = buildCalibrationReport(tradeExtractions, candidates, context)
  }

  return Response.json({
    ok: true,
    trades_active: trades,
    uploads: uploads ?? [],
    extractions: extractions ?? [],
    suggestions: suggestions ?? [],
    reports,
  })
}
