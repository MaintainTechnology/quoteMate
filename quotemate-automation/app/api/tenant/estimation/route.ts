// /api/tenant/estimation — WP3 read-only "how each job is estimated".
//
// For every shared assembly that has a structured bill of materials
// (shared_assembly_bom, migration 028), returns the BOM lines plus the
// EFFECTIVE labour-hours + markup, resolved global-vs-local via the
// tested effectiveAssembly() helper. Pure read — no writes. Bearer-auth
// + tenant-scoped exactly like /api/tenant/catalogue.

import { createClient } from '@supabase/supabase-js'
import { effectiveAssembly } from '@/lib/estimate/catalogue'

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

export async function GET(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const trades =
    Array.isArray(tenant.trades) && tenant.trades.length > 0
      ? tenant.trades
      : tenant.trade
        ? [tenant.trade]
        : []

  // Per-trade global markup from this tenant's own pricing book (WP1:
  // strictly tenant-scoped — never another tradie's book).
  const { data: books } = await supabase
    .from('pricing_book')
    .select('trade, default_markup_pct, hourly_rate')
    .eq('tenant_id', tenant.id)
  const markupByTrade = new Map<string, number>()
  const hourlyByTrade = new Map<string, number>()
  for (const b of books ?? []) {
    markupByTrade.set(b.trade as string, Number(b.default_markup_pct))
    hourlyByTrade.set(b.trade as string, Number(b.hourly_rate))
  }

  // Structured BOM joined to its shared assembly (name + global labour).
  let bomQ = supabase
    .from('shared_assembly_bom')
    .select(
      'material_category, quantity, required, description, sort, ' +
        'shared_assemblies!inner ( id, name, trade, default_labour_hours, default_unit_price_ex_gst )',
    )
    .order('sort', { ascending: true })
  if (trades.length > 0) bomQ = bomQ.in('trade', trades)
  const { data: bomRows, error: bomErr } = await bomQ
  if (bomErr) return Response.json({ error: bomErr.message }, { status: 500 })

  // Per-tenant overrides (global-vs-local).
  const { data: overrides } = await supabase
    .from('tenant_assembly_overrides')
    .select('assembly_id, enabled, labour_hours_override, markup_pct_override')
    .eq('tenant_id', tenant.id)
  const overrideByAssembly = new Map<string, any>()
  for (const o of overrides ?? []) overrideByAssembly.set(o.assembly_id as string, o)

  // Group BOM rows by assembly.
  type AsmAgg = {
    id: string
    name: string
    trade: string
    default_labour_hours: number | string
    default_unit_price_ex_gst: number | string | null
    bom: Array<{ material_category: string; quantity: number; required: boolean; description: string | null }>
  }
  const byAssembly = new Map<string, AsmAgg>()
  for (const r of (bomRows ?? []) as any[]) {
    const a = Array.isArray(r.shared_assemblies) ? r.shared_assemblies[0] : r.shared_assemblies
    if (!a) continue
    let agg = byAssembly.get(a.id)
    if (!agg) {
      agg = {
        id: a.id,
        name: a.name,
        trade: a.trade,
        default_labour_hours: a.default_labour_hours,
        default_unit_price_ex_gst: a.default_unit_price_ex_gst,
        bom: [],
      }
      byAssembly.set(a.id, agg)
    }
    agg.bom.push({
      material_category: r.material_category,
      quantity: Number(r.quantity),
      required: !!r.required,
      description: r.description ?? null,
    })
  }

  const jobs = [...byAssembly.values()].map((a) => {
    const globalMarkup = markupByTrade.get(a.trade) ?? 28
    const eff = effectiveAssembly(a.default_labour_hours, globalMarkup, overrideByAssembly.get(a.id) ?? null)
    return {
      assembly_id: a.id,
      name: a.name,
      trade: a.trade,
      hourly_rate: hourlyByTrade.get(a.trade) ?? null,
      bom: a.bom,
      effective: {
        enabled: eff.enabled,
        labour_hours: eff.labourHours, // { value, source: 'local'|'global' }
        markup_pct: eff.markupPct,
        global_labour_hours: Number(a.default_labour_hours),
        global_markup_pct: globalMarkup,
      },
    }
  })

  return Response.json({ ok: true, jobs })
}
