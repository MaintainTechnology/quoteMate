// POST /api/supplier-catalogue/import — tradie self-serve CSV bulk-upload
// into the SHARED supplier_catalogue library (the "Browse supplier
// catalogue" UI in CatalogueTab).
//
// The product decision (2026-05-21): a tradie's upload populates the
// shared library, so the new SKUs become browsable by every tenant. To
// keep that safe:
//   • Rows are validated against the tenant's OWN trades — an electrician
//     can't seed plumbing SKUs.
//   • INSERT-ONLY. A row that collides with an existing library SKU
//     (same trade+brand+name) is SKIPPED, never updated — one tradie's
//     upload must not silently rewrite an operator-curated row or another
//     tenant's row. (The operator CLI keeps refresh/update behaviour.)
//   • Inserted rows are tagged source='tenant_csv' + created_by_tenant_id
//     (migration 045) so the upload is auditable / reversible.
//
// Two-phase: pass dryRun=true first to get the new/skipped/error split,
// then dryRun=false to commit. Optional alsoStockMine copies every
// uploaded SKU (new + already-in-library) into the tradie's own
// tenant_material_catalogue — same logic as /api/tenant/catalogue/bulk-add.
//
// Bearer-authed + tenant-scoped. Service-role write; the RLS layer from
// migration 040 is bypassed by service role exactly like the sibling
// /api/supplier-catalogue and /api/tenant/catalogue routes.

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { parseSupplierCsv, dedupeKeyFor, MAX_CSV_ROWS } from '@/lib/catalogue/csv-import'
import { granularToGroundingCategory } from '@/lib/catalogue/category-mapping'

export const dynamic = 'force-dynamic'
// CSV parse + per-row inserts can exceed Vercel Hobby's 10s; mirrors the
// raised limit on the heavier routes (see CLAUDE.md conventions).
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const ImportSchema = z.object({
  // ~2000 rows of CSV — generous ceiling, the parser caps rows itself.
  csvText: z.string().min(1).max(2_000_000),
  dryRun: z.boolean().default(true),
  alsoStockMine: z.boolean().default(false),
})

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

/** Copy a set of supplier_catalogue rows into the tenant's own
 *  tenant_material_catalogue — the same operation as the "Add to my
 *  catalogue" bulk-add, run inline so an upload can stock in one step.
 *  Idempotent: skips SKUs the tenant already linked or already named. */
async function stockForTenant(
  tenantId: string,
  trades: string[],
  supplierIds: string[],
): Promise<{ stocked: number; skipped: number }> {
  if (supplierIds.length === 0) return { stocked: 0, skipped: 0 }

  const { data: supplierRows } = await supabase
    .from('supplier_catalogue')
    .select(
      'id, trade, category, brand, range_series, name, supplier_label, ' +
        'default_unit, default_unit_price_ex_gst, tier_hint, image_url, description',
    )
    .in('id', supplierIds)
    .is('retired_at', null)

  const { data: linked } = await supabase
    .from('tenant_material_catalogue')
    .select('supplier_catalogue_id')
    .eq('tenant_id', tenantId)
    .in('supplier_catalogue_id', supplierIds)
  const alreadyLinked = new Set(
    (linked ?? [])
      .map((r: { supplier_catalogue_id: string | null }) => r.supplier_catalogue_id)
      .filter((id): id is string => !!id),
  )

  let stocked = 0
  let skipped = 0
  for (const s of (supplierRows ?? []) as unknown as Array<Record<string, unknown>>) {
    const sid = s.id as string
    if (alreadyLinked.has(sid) || !trades.includes(s.trade as string)) {
      skipped++
      continue
    }
    const groundingCategory = granularToGroundingCategory(s.category as string)
    if (!groundingCategory) {
      skipped++
      continue
    }
    const { error } = await supabase.from('tenant_material_catalogue').insert({
      tenant_id: tenantId,
      trade: s.trade,
      category: groundingCategory,
      name: s.name,
      brand: s.brand,
      range_series: s.range_series,
      supplier: s.supplier_label,
      unit: (s.default_unit as string) || 'each',
      unit_price_ex_gst: s.default_unit_price_ex_gst,
      tier_hint: s.tier_hint,
      image_path: s.image_url,
      description: s.description,
      active: true,
      is_preferred: false,
      supplier_catalogue_id: sid,
    })
    // 23505 = duplicate name already in the tenant's catalogue — fine, skip.
    if (error) skipped++
    else stocked++
  }
  return { stocked, skipped }
}

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = ImportSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const trades = tradesOf(tenant)
  if (trades.length === 0) {
    return Response.json({ error: 'tenant_has_no_trades' }, { status: 400 })
  }

  const { csvText, dryRun, alsoStockMine } = parsed.data

  // Parse + validate — scoped to the tenant's own trades.
  const { rows, errors, totalDataRows } = parseSupplierCsv(csvText, {
    allowedTrades: trades,
  })

  // Diff against the existing library so the caller sees new vs already-
  // present before committing. Insert-only: collisions are skipped.
  const { data: existing, error: exErr } = await supabase
    .from('supplier_catalogue')
    .select('id, trade, brand, name')
    .in('trade', trades)
    .is('retired_at', null)
  if (exErr) return Response.json({ error: exErr.message }, { status: 500 })

  const existingByKey = new Map<string, string>()
  for (const e of (existing ?? []) as Array<{ id: string; trade: string; brand: string; name: string }>) {
    existingByKey.set(dedupeKeyFor(e.trade, e.brand, e.name), e.id)
  }

  const toInsert = rows.filter((r) => !existingByKey.has(r.dedupeKey))
  const alreadyInLibrary = rows.filter((r) => existingByKey.has(r.dedupeKey))

  const summary = {
    totalDataRows,
    validRows: rows.length,
    errorRows: errors.length,
    toInsert: toInsert.length,
    alreadyInLibrary: alreadyInLibrary.length,
    maxRows: MAX_CSV_ROWS,
  }

  // ── Dry-run — report only, write nothing ──────────────────────────
  if (dryRun) {
    return Response.json({
      ok: true,
      dryRun: true,
      summary,
      errors: errors.slice(0, 100),
      preview: {
        new: toInsert.slice(0, 20).map((r) => ({
          trade: r.trade,
          category: r.category,
          brand: r.brand,
          name: r.name,
          price: r.default_unit_price_ex_gst,
        })),
        alreadyInLibrary: alreadyInLibrary.slice(0, 20).map((r) => ({
          trade: r.trade,
          brand: r.brand,
          name: r.name,
        })),
      },
    })
  }

  // ── Commit — insert the genuinely-new rows ────────────────────────
  let insertedIds: string[] = []
  if (toInsert.length > 0) {
    const insertRows = toInsert.map((r) => ({
      trade: r.trade,
      category: r.category,
      brand: r.brand,
      range_series: r.range_series,
      name: r.name,
      supplier_label: r.supplier_label,
      default_unit: r.default_unit,
      default_unit_price_ex_gst: r.default_unit_price_ex_gst,
      tier_hint: r.tier_hint,
      image_url: r.image_url,
      description: r.description,
      source: 'tenant_csv',
      created_by_tenant_id: tenant.id,
    }))
    const { data: inserted, error: insErr } = await supabase
      .from('supplier_catalogue')
      .insert(insertRows)
      .select('id')
    if (insErr) {
      return Response.json(
        { error: 'insert_failed', message: insErr.message },
        { status: 500 },
      )
    }
    insertedIds = (inserted ?? []).map((r: { id: string }) => r.id)
  }

  // Optionally stock every uploaded SKU (new + already-in-library) into
  // the uploading tradie's own catalogue.
  let stockResult: { stocked: number; skipped: number } | null = null
  if (alsoStockMine) {
    const affectedIds = [
      ...insertedIds,
      ...alreadyInLibrary
        .map((r) => existingByKey.get(r.dedupeKey))
        .filter((id): id is string => !!id),
    ]
    stockResult = await stockForTenant(tenant.id, trades, affectedIds)
  }

  return Response.json({
    ok: true,
    dryRun: false,
    summary,
    inserted: insertedIds.length,
    errors: errors.slice(0, 100),
    stockedToMyCatalogue: stockResult,
  })
}
