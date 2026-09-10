// PATCH /api/roofing/measurement/[token] — update the persisted structure
// selection (included_indices) for a roofing measurement, keyed by its
// unguessable measure_token (migration 140).
//
// Writes require the authenticated owning tenant and the displayed revision.
// Released rows create a new held successor; old customer links keep their prices. Updating the
// owner-approved selection recomputes the denormalised summary AND invalidates any cached
// quote PDF (pdf_path → null) so the customer page + PDF re-render the new
// selection on next view/download. At least one structure must stay included.

import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { roofMeasurementVersion } from '@/lib/roofing/measurement-version'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { MultiRoofQuote, RoofJobIntent } from '@/lib/roofing/types'
import type { SolarQuoteAddon } from '@/lib/roofing/solar'
import { denormFromSelection, sanitizeIndices, structureCount } from '@/lib/roofing/selection'
import { detectSolarForJob } from '@/lib/roofing/solar-detect'
import { repriceWithEdgeOverrides } from '@/lib/roofing/reprice'
import { loadTenantRoofingPricingContext, roofMeasurementTokensForRun } from '@/lib/roofing/pricing-authority'

export const dynamic = 'force-dynamic'
// The POST re-scan runs Gemini (per structure) + an Anthropic photo pass
// inline before persisting, so raise the function ceiling like the save route.
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const EdgeOverrideSchema = z.object({
  index: z.number().int().min(1).max(64),
  hips: z.number().int().min(0).max(50).nullable().optional(),
  valleys: z.number().int().min(0).max(50).nullable().optional(),
  box_gutter_lm: z.number().min(0).max(500).nullable().optional(),
  // Accessory quantities (tradie-confirmed; null removes the line).
  gutter_lm: z.number().min(0).max(1000).nullable().optional(),
  downpipe_count: z.number().int().min(0).max(60).nullable().optional(),
  fascia_lm: z.number().min(0).max(1000).nullable().optional(),
  soffit_lm: z.number().min(0).max(1000).nullable().optional(),
  // Measurement corrections (post-inspection). Positive values only —
  // clearing a measurement is not supported (see lib/roofing/reprice.ts).
  pitch_degrees: z.number().min(1).max(75).nullable().optional(),
  sloped_area_m2: z.number().min(1).max(10000).nullable().optional(),
  form: z
    .enum(['gable', 'hip', 'skillion', 'gable_hip', 'complex', 'unknown'])
    .nullable()
    .optional(),
  storeys: z.number().int().min(1).max(10).nullable().optional(),
})
const BodySchema = z
  .object({
    expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
    included_indices: z.array(z.number().int()).min(1).max(64).optional(),
    edges: z.array(EdgeOverrideSchema).min(1).max(64).optional(),
  })
  .refine((b) => b.included_indices != null || b.edges != null, {
    message: 'included_indices or edges required',
  })

type Row = Record<string, unknown> & {
  id: string
  quote: MultiRoofQuote | null
  tenant_id: string | null
  included_indices: number[] | null
}

/** Private native reopen. A measure/public token is never authentication.
 * `lookup=id` lets an owned saved-list row reopen without publishing its token. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const headers = { 'Cache-Control': 'no-store' }
  const { token } = await ctx.params
  const lookup = new URL(req.url).searchParams.get('lookup') ?? 'token'
  if (!['id', 'token', 'run'].includes(lookup) ||
      (lookup === 'id' ? !z.string().uuid().safeParse(token).success : lookup === 'run' ? !/^[a-f0-9]{32}$/.test(token) : !token || token.length < 8 || token.length > 160)) {
    return Response.json({ ok:false, error:'invalid_lookup' }, { status:400, headers })
  }
  try {
    const auth = await resolveTenantRequest(supabase,req,'id')
    const tenantId = auth?.tenant?.id
    if (typeof tenantId !== 'string') return Response.json({ ok:false,error:'unauthorized' }, { status:401,headers })
    // Recovery is read-only even after the measurement run expires. The same
    // deterministic capability was used by Save; the owning tenant is still
    // required and a run ID never grants public or cross-tenant access.
    let lookupToken = token
    if (lookup === 'run') {
      const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!secret) return Response.json({ ok:false,error:'measurement_unavailable' }, { status:503,headers })
      lookupToken = roofMeasurementTokensForRun({ runId: token, secret }).measure_token
    }
    const { data:row,error } = await supabase.from('roofing_measurements').select('*')
      .eq('tenant_id',tenantId).eq(lookup === 'id' ? 'id':'measure_token',lookupToken).maybeSingle<Row>()
    if (error) return Response.json({ ok:false,error:'measurement_unavailable' }, { status:503,headers })
    if (!row || row.tenant_id !== tenantId) return Response.json({ ok:false,error:'not_found' }, { status:404,headers })
    const pricing = await loadTenantRoofingPricingContext(supabase,tenantId,null)
    let promotedQuoteId: string | null = null
    if (typeof row.quote_share_token === 'string' && row.quote_share_token) {
      const promoted = await supabase.from('quotes').select('id,tenant_id,share_token')
        .eq('tenant_id',tenantId).eq('share_token',row.quote_share_token).maybeSingle()
      if (promoted.error) return Response.json({ok:false,error:'promotion_lookup_unavailable'},{status:503,headers})
      if (promoted.data?.tenant_id === tenantId && promoted.data.share_token === row.quote_share_token && typeof promoted.data.id === 'string') {
        promotedQuoteId = promoted.data.id
      }
    }
    return Response.json({ ok:true, measurement: {
      id:row.id, tenant_id:tenantId, measure_token:row.measure_token, public_token:row.public_token,
      revision:roofMeasurementVersion(row), address:row.address ?? null, postcode:row.postcode ?? null,
      state:row.state ?? null, provider:row.provider ?? null, customer_name:row.customer_name ?? null,
      customer_phone:row.customer_phone ?? null, quote:row.quote ?? null,
      included_indices:row.included_indices ?? null, created_at:row.created_at ?? null,
      released_at:row.released_at ?? null, paid_at:row.paid_at ?? null,
      pricing_authority:pricing?.authority ?? null,
      promoted_quote_id:promotedQuoteId,
      promotion_pending:!!row.quote_share_token && !promotedQuoteId,
    } }, { headers })
  } catch {
    return Response.json({ ok:false,error:'measurement_unavailable' }, { status:503,headers })
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const auth = await resolveTenantRequest(supabase, req, 'id')
  const tenantId = auth?.tenant?.id
  if (typeof tenantId !== 'string') return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { data: row, error: readErr } = await supabase
    .from('roofing_measurements')
    .select('*')
    .eq('measure_token', token)
    .eq('tenant_id', tenantId)
    .maybeSingle<Row>()
  if (readErr) return Response.json({ ok: false, error: 'measurement_unavailable' }, { status: 503 })
  if (!row) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }
  if (row.paid_at) return Response.json({ ok: false, error: 'paid_quote_locked' }, { status: 409 })
  if (parsed.data.expected_revision !== roofMeasurementVersion(row)) return Response.json({ ok: false, error: 'measurement_changed', detail: 'Reload the measurement before saving your changes.' }, { status: 409 })

  // Tradie edge re-price (hips / valleys / box gutter) — re-price the stored
  // structures in place with the confirmed counts, keeping the current
  // selection. Distinct from the included_indices selection update below.
  if (parsed.data.edges) {
    if (!row.quote || structureCount(row.quote) === 0) {
      return Response.json({ ok: false, error: 'no_quote' }, { status: 400 })
    }
    if (!row.tenant_id) {
      return Response.json({ ok: false, error: 'tenant_pricing_required' }, { status: 422 })
    }
    const pricing = await loadTenantRoofingPricingContext(supabase, row.tenant_id, null)
    if (!pricing) {
      return Response.json({ ok: false, error: 'tenant_pricing_required' }, { status: 422 })
    }
    const repriced = repriceWithEdgeOverrides(row.quote, parsed.data.edges, pricing.rateCard)
    const updatedQuote = { ...repriced, pricing_authority: pricing.authority }
    const total = structureCount(updatedQuote)
    const included = sanitizeIndices(
      row.included_indices ?? Array.from({ length: total }, (_, i) => i + 1),
      total,
    )
    const denorm = denormFromSelection(updatedQuote, included)
    return saveRevision(row, { quote: updatedQuote, ...denorm, pdf_path: null }, { repriced: true, ...denorm })
  }

  if (!parsed.data.included_indices) {
    return Response.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  }
  const count = structureCount(row.quote)
  const included = sanitizeIndices(parsed.data.included_indices, count)
  if (included.length === 0) {
    return Response.json(
      { ok: false, error: 'no_structures', detail: 'Keep at least one structure in the job.' },
      { status: 400 },
    )
  }

  const denorm = row.quote
    ? denormFromSelection(row.quote, included)
    : { combined_area_m2: null, combined_better_inc_gst: null, structure_count: included.length }

  return saveRevision(row, { included_indices: included, ...denorm, pdf_path: null }, { included_indices: included, ...denorm })
}

// POST /api/roofing/measurement/[token] — re-scan this measurement for existing
// solar/skylights using tradie-attached close-up roof PHOTOS, merged with the
// per-structure aerial pass, and persist the result onto
// roofing_measurements.quote.solar. Authenticated ownership, version and
// immutable released-quote policy match PATCH. This is the tradie-attached-photo
// source for R2; customer /upload/[token] photo sourcing is gated on the spec's
// open question (roofing jobs don't yet collect customer photos) and not wired.
const RescanBodySchema = z.object({
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
  photos: z
    .array(z.object({ base64: z.string().min(1), mime: z.string().min(3).max(60) }))
    .min(1)
    .max(6),
})

type RescanRow = Record<string, unknown> & {
  id: string
  quote: MultiRoofQuote | null
  tenant_id: string | null
  provider: string | null
  included_indices: number[] | null
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const auth = await resolveTenantRequest(supabase, req, 'id')
  const tenantId = auth?.tenant?.id
  if (typeof tenantId !== 'string') return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = RescanBodySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { data: row, error: readErr } = await supabase
    .from('roofing_measurements')
    .select('*')
    .eq('measure_token', token)
    .eq('tenant_id', tenantId)
    .maybeSingle<RescanRow>()
  if (readErr) return Response.json({ ok: false, error: 'measurement_unavailable' }, { status: 503 })
  if (!row) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  if (row.paid_at) return Response.json({ ok: false, error: 'paid_quote_locked' }, { status: 409 })
  if (parsed.data.expected_revision !== roofMeasurementVersion(row)) return Response.json({ ok: false, error: 'measurement_changed', detail: 'Reload the measurement before saving your changes.' }, { status: 409 })

  const fullQuote = row.quote
  if (!fullQuote || structureCount(fullQuote) === 0) {
    return Response.json({ ok: false, error: 'no_quote' }, { status: 400 })
  }

  const primary =
    fullQuote.structures.find((s) => s.role === 'primary') ?? fullQuote.structures[0]
  const primaryIntent = (primary?.inputs?.intent ?? 'full_reroof') as RoofJobIntent
  if (!row.tenant_id) {
    return Response.json({ ok: false, error: 'tenant_pricing_required' }, { status: 422 })
  }
  const pricing = await loadTenantRoofingPricingContext(supabase, row.tenant_id, null)
  if (!pricing) {
    return Response.json({ ok: false, error: 'tenant_pricing_required' }, { status: 422 })
  }
  const rateCard = pricing.rateCard

  let solarAddon: SolarQuoteAddon | null = null
  try {
    solarAddon = await detectSolarForJob({
      quote: fullQuote,
      // Re-scan always runs (the tradie explicitly attached photos) — pass a
      // non-mock provider so the orchestrator's demo short-circuit is bypassed.
      provider: row.provider === 'mock' ? 'manual' : row.provider ?? 'geoscape',
      primaryIntent,
      rateCard,
      photos: parsed.data.photos,
    })
  } catch {
    solarAddon = null
  }

  if (!solarAddon) {
    return Response.json(
      { ok: true, solar: null, detail: 'No existing solar or skylights detected from the photos.' },
      { status: 200 },
    )
  }

  const updatedQuote = { ...fullQuote, solar: solarAddon, pricing_authority: pricing.authority }
  // Recompute the denormalised summary from the solar-attached quote (same
  // pattern as the PATCH branches) — the allowance changes the better total,
  // and leaving the old value stranded the dashboard list price below what
  // /m, /q/roof and the PDF now show.
  const denorm = denormFromSelection(updatedQuote, row.included_indices ?? null)
  return saveRevision(row, { quote: updatedQuote, ...denorm, pdf_path: null }, { solar: solarAddon })
}


async function saveRevision(row: Row, changes: Record<string, unknown>, result: Record<string, unknown>) {
  const { data: saved, error } = await supabase.rpc('sms_revise_roof_owned', {
    p_tenant_id: row.tenant_id, p_id: row.id, p_expected: row, p_changes: changes,
  })
  if (error || !saved) return Response.json({ ok: false, error: 'measurement_changed_or_unavailable',
    detail: 'The measurement changed while saving. Reload it before trying again.' }, { status: 409 })
  const successor = saved.id !== row.id
  return Response.json({ ok: true, ...result, successor,
    measureToken: saved.measure_token, reviewUrl: `/dashboard/quote-review?family=roof&id=${saved.id}`,
    ...(successor ? { detail: 'Saved a new draft for review. The previous customer quote is unchanged.' } : {}),
  })
}
