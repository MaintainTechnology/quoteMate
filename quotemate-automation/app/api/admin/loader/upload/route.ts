// POST /api/admin/loader/upload — admin bulk loader: upload + validate +
// stage a Services and/or Materials CSV (spec §8 steps 1-5).
//
// Admin-only (§9 rule 4). Structural-then-row validation (§9 rule 10): a
// structurally-bad CSV is rejected WHOLE before any batch is created. Valid
// NEW/UPDATE rows are staged in import_staged_rows; nothing touches a live
// table until Approve. The response is the preview diff.
//
// Idempotent: the same idempotencyKey returns the existing batch instead of
// staging a second copy (§9 rule 12).

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { resolveAdminUserId } from '@/lib/admin-loader/route-auth'
import {
  planServicesUpload,
  planMaterialsUpload,
  type UploadPlan,
} from '@/lib/admin-loader/batch'
import {
  serviceKey,
  type ServicesRowContext,
} from '@/lib/admin-loader/services-csv'
import { tradeNameKey } from '@/lib/admin-loader/csv'
import type { MaterialsRowContext } from '@/lib/admin-loader/materials-csv'
import { createBatch, stageRows, loadBatch } from '@/lib/admin-loader/store'

export const dynamic = 'force-dynamic'
// CSV parse + staging inserts can exceed Vercel Hobby's 10s — mirrors the
// raised limit on the other CSV / LLM routes (CLAUDE.md conventions).
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const UploadSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  services: z.string().max(2_000_000).optional(),
  materials: z.string().max(2_000_000).optional(),
})

export async function POST(req: Request) {
  const adminId = await resolveAdminUserId(supabase, req)
  if (!adminId) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = UploadSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const { idempotencyKey, services, materials } = parsed.data
  if (!services && !materials) {
    return Response.json(
      { error: 'no_csv', message: 'Provide a services and/or materials CSV.' },
      { status: 400 },
    )
  }

  // Validation context — every DB-derived input the planners need.
  const [tradesRes, catsRes, asmRes, matRes, tenantsRes] = await Promise.all([
    supabase.from('trades').select('name'),
    supabase.from('categories').select('name'),
    supabase.from('shared_assemblies').select('trade, name'),
    supabase.from('shared_materials').select('trade, name'),
    supabase.from('tenants').select('trade, trades'),
  ])

  const knownTrades = new Set(
    (tradesRes.data ?? []).map((r) => r.name as string),
  )
  const knownCategories = new Set(
    (catsRes.data ?? []).map((r) => r.name as string),
  )
  const existingServiceKeys = new Set(
    (asmRes.data ?? []).map((r) => serviceKey(r.trade as string, r.name as string)),
  )
  const existingMaterialKeys = new Set(
    (matRes.data ?? []).map((r) =>
      tradeNameKey(r.trade as string, r.name as string),
    ),
  )
  // §9 rule 3 — a trade is "live" if any tenant covers it.
  const liveTrades = new Set<string>()
  for (const t of tenantsRes.data ?? []) {
    if (t.trade) liveTrades.add(t.trade as string)
    for (const x of (t.trades as string[] | null) ?? []) liveTrades.add(x)
  }
  const tradeHasLiveTenants = (t: string) => liveTrades.has(t)

  const svcCtx: ServicesRowContext = {
    knownTrades,
    knownCategories,
    existingServiceKeys,
    tradeHasLiveTenants,
  }
  const matCtx: MaterialsRowContext = { knownTrades, existingMaterialKeys }

  const plans: UploadPlan[] = []
  if (services) plans.push(planServicesUpload(services, svcCtx))
  if (materials) plans.push(planMaterialsUpload(materials, matCtx))

  // §9 rule 10 — a structurally-bad CSV is rejected whole, no batch created.
  const structural = plans.filter(
    (p): p is Extract<UploadPlan, { ok: false }> => !p.ok,
  )
  if (structural.length > 0) {
    return Response.json(
      {
        error: 'structural_validation_failed',
        csvs: structural.map((p) => ({ csv: p.csv, errors: p.structuralErrors })),
      },
      { status: 400 },
    )
  }
  const okPlans = plans as Extract<UploadPlan, { ok: true }>[]

  const source =
    [services ? 'services' : null, materials ? 'materials' : null]
      .filter(Boolean)
      .join('+') || 'manual'

  const batch = await createBatch(supabase, {
    idempotencyKey,
    adminUserId: adminId,
    source,
  })
  if (!batch.ok) {
    return Response.json(
      { error: 'batch_create_failed', message: batch.error },
      { status: 500 },
    )
  }

  // Idempotent replay — the rows were already staged on the first call.
  if (batch.alreadyExists) {
    const loaded = await loadBatch(supabase, batch.batchId)
    return Response.json({
      ok: true,
      idempotentReplay: true,
      batchId: batch.batchId,
      batch: loaded.ok ? loaded.batch : null,
    })
  }

  const allStaged = okPlans.flatMap((p) => p.stagedRows)
  const staged = await stageRows(supabase, batch.batchId, allStaged)
  if (!staged.ok) {
    return Response.json(
      { error: 'staging_failed', message: staged.error },
      { status: 500 },
    )
  }

  return Response.json({
    ok: true,
    batchId: batch.batchId,
    preview: okPlans.map((p) => ({
      csv: p.csv,
      target_table: p.target_table,
      summary: p.summary,
      forcedDisabledCount: p.forcedDisabledCount,
      stagedRows: p.stagedRows.map((r) => ({
        row_class: r.row_class,
        payload: r.payload,
      })),
      rejected: p.rejected,
    })),
  })
}
