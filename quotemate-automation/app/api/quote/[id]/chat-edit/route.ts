// POST /api/quote/[id]/chat-edit
//
// PROPOSE-ONLY. Turns a tradie's plain-English instruction into a proposed,
// catalogue-grounded edit of an existing quote's Good/Better/Best line items,
// and returns it as a reviewable diff. It persists NOTHING — no DB write, no
// Stripe call, no PDF render, no SMS. The client reviews the proposal and, on
// the tradie's explicit Save, POSTs it to the UNCHANGED
// POST /api/quote/[id]/edit endpoint which does the grounded write.
//
// Auth + guards mirror /api/quote/[id]/edit exactly: Bearer Supabase token →
// must be the owner of the quote's tenant; paid / inspection / misconfigured-
// pricing_book quotes are refused with the same status codes. The grounding
// gate that /edit enforces on Save is re-run here (lib/quote/chat-edit) so the
// `grounded` flags shown to the tradie match what Save will accept or reject.

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { loadCandidatePrices } from '@/lib/estimate/run'
import type { PricingBookForValidation, CandidatePrices } from '@/lib/estimate/validate'
import { tradeGroundingMode } from '@/lib/quote/report-adapters/registry'
import {
  proposeQuoteEdit,
  type ChatEditTier,
  type ChatEditTiers,
} from '@/lib/quote/chat-edit'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'
import { type QuoteEditRow, QUOTE_EDIT_FIELDS, quoteEditRevision, validOwnedQuoteBook, preserveLineProvenance } from '@/lib/quote/edit-authority'
import { finiteQuoteNumber } from '@/lib/quote/numeric-input'
import { loadQuotePricingVersion, versionedQuoteGst, QuotePricingVersionError, type QuotePricingVersion } from '@/lib/quote/pricing-version'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Opus + tool-calling is slow; match the edit route's ceiling (Vercel Hobby's
// 10s would time out — needs Pro or Railway).
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const QuoteNumberSchema = z.preprocess(finiteQuoteNumber, z.number().min(0))
const LineItemSchema = z.object({
  original_line_index: z.number().int().min(0).optional(),
  description: z.string().trim().min(1).max(200),
  quantity: QuoteNumberSchema,
  unit: z.string().trim().max(20).optional().or(z.literal('')),
  unit_price_ex_gst: QuoteNumberSchema,
  source: z.string().trim().max(120).optional().or(z.literal('')),
  supplied_by: z.enum(['tradie', 'customer']).optional(),
  safety_note: z.string().max(2000).optional(),
})

const TierSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    timeframe: z.string().trim().max(60).optional().or(z.literal('')),
    line_items: z.array(LineItemSchema).min(1),
  })
  .nullable()

const BodySchema = z.object({
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  instruction: z.string().trim().min(1).max(1000),
  // The live tiers as the tradie sees them on screen (so follow-up
  // instructions build on the working set). Optional — when absent the
  // endpoint edits the persisted good/better/best instead.
  currentTiers: z
    .object({
      good: TierSchema.optional(),
      better: TierSchema.optional(),
      best: TierSchema.optional(),
    })
    .optional(),
})

type DbTier = {
  label?: string
  timeframe?: string
  subtotal_ex_gst?: number
  line_items?: Array<{
    description: string
    quantity: number
    unit?: string
    unit_price_ex_gst: number
    total_ex_gst?: number
    source?: string
    supplied_by?: 'tradie' | 'customer'
    safety_note?: string
  }>
} | null

/** Map a persisted quote tier JSONB to the chat-edit tier shape. */
function dbTierToChatEdit(t: DbTier, key: string): ChatEditTier {
  if (!t) return null
  if (t.line_items?.some((line) => finiteQuoteNumber(line.quantity) === null || finiteQuoteNumber(line.quantity)! < 0 ||
      finiteQuoteNumber(line.unit_price_ex_gst) === null || finiteQuoteNumber(line.unit_price_ex_gst)! < 0)) {
    throw new Error('stored_line_price_invalid')
  }
  return {
    label: t.label ?? `${key} option`,
    timeframe: t.timeframe || undefined,
    line_items: (t.line_items ?? []).map((li, index) => ({
      original_line_index: index,
      description: li.description,
      quantity: finiteQuoteNumber(li.quantity)!,
      unit: li.unit || undefined,
      unit_price_ex_gst: finiteQuoteNumber(li.unit_price_ex_gst)!,
      ...(li.source ? { source: li.source } : {}),
      ...(li.supplied_by !== undefined ? { supplied_by: li.supplied_by } : {}),
      ...(li.safety_note !== undefined ? { safety_note: li.safety_note } : {}),
    })),
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: quoteId } = await params

  // ─── Auth (dual-auth: Clerk OR legacy Supabase token) ───────
  const resolved = await resolveTenantRequest(supabase, req, 'id')
  if (!resolved) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const tenant = resolved.tenant as { id: string } | null

  // ─── Parse body ─────────────────────────────────────────────
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        error: 'validation_failed',
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    )
  }
  const { instruction, currentTiers: bodyTiers } = parsed.data

  // ─── Load + authorise (same guards as /edit) ───────────────
  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select(
      `${QUOTE_EDIT_FIELDS.join(',')},scope_of_works,assumptions`,
    )
    .eq('id', quoteId)
    .maybeSingle<QuoteEditRow>()
  if (quoteError) return Response.json({ ok: false, error: 'quote_unavailable' }, { status: 503 })
  if (!quote) return Response.json({ ok: false, error: 'no_quote' }, { status: 404 })
  if (!quote.tenant_id) {
    return Response.json({ ok: false, error: 'unscoped_quote' }, { status: 403 })
  }
  if (quote.paid_at) {
    return Response.json({ ok: false, error: 'quote_already_paid' }, { status: 409 })
  }
  if (quote.needs_inspection) {
    return Response.json(
      {
        ok: false,
        error: 'cannot_edit_inspection_quote',
        hint: 'Inspection-required quotes are flat $99 — there are no tiers to edit.',
      },
      { status: 409 },
    )
  }

  if (!tenant || quote.tenant_id !== tenant.id) {
    return Response.json({ ok: false, error: 'not_owner' }, { status: 403 })
  }
  const readiness = await readQuoteDraftReadiness(supabase, quote)
  if (!readiness.ready) return Response.json({ ok: false, error: readiness.code }, { status: 409 })
  const revision = quoteEditRevision(quote)
  if (parsed.data.expected_revision && parsed.data.expected_revision !== revision) {
    return Response.json({ ok: false, error: 'quote_changed' }, { status: 409 })
  }

  // ─── Trade + grounding mode ────────────────────────────────
  const { data: intake, error: intakeError } = await supabase
    .from('intakes')
    .select('tenant_id,trade')
    .eq('id', quote.intake_id)
    .eq('tenant_id', tenant.id)
    .maybeSingle()
  if (intakeError) return Response.json({ ok: false, error: 'pricing_unavailable' }, { status: 503 })
  if (!intake || intake.tenant_id !== tenant.id || typeof intake.trade !== 'string' || !intake.trade.trim()) {
    return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  }

  let savedVersion: QuotePricingVersion | null
  try { savedVersion = await loadQuotePricingVersion(supabase, quote, intake.trade) }
  catch (error) {
    return Response.json({ ok: false, error: error instanceof QuotePricingVersionError ? error.code : 'pricing_unavailable' },
      { status: error instanceof QuotePricingVersionError ? error.status : 503 })
  }
  const { data: currentBook, error: bookError } = savedVersion ? { data: null, error: null } : await supabase
    .from('pricing_book')
    .select(
      'id,tenant_id,gst_registered,trade, hourly_rate, apprentice_rate, senior_rate, call_out_minimum, default_markup_pct, min_labour_hours, after_hours_multiplier',
    )
    .eq('tenant_id', quote.tenant_id)
    .eq('trade', intake.trade)
    .maybeSingle()
  const pricingBook = savedVersion?.snapshot ?? currentBook
  if (bookError) return Response.json({ ok: false, error: 'pricing_unavailable' }, { status: 503 })

  const trade = intake.trade as string
  if (!validOwnedQuoteBook(pricingBook, tenant.id, trade) || versionedQuoteGst(quote, savedVersion) === null) {
    return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  }
  const groundingMode = tradeGroundingMode(trade)

  // Catalogue trades (electrical/plumbing) need a complete pricing_book for the
  // grounding validator. Tradie-authored trades (solar/roof/paint) don't ground
  // against a catalogue, so a sparse pricing_book is fine.
  if (
    groundingMode === 'catalogue' &&
    (!pricingBook || typeof pricingBook.hourly_rate !== 'number' || !Number.isFinite(pricingBook.hourly_rate) || pricingBook.hourly_rate <= 0 ||
      typeof pricingBook.default_markup_pct !== 'number' || !Number.isFinite(pricingBook.default_markup_pct) || pricingBook.default_markup_pct < 0 || pricingBook.default_markup_pct > 100)
  ) {
    return Response.json(
      {
        ok: false,
        error: 'pricing_book_misconfigured',
        hint:
          "This tenant's pricing_book is missing required fields (hourly_rate, " +
          'default_markup_pct). Cannot propose grounded edits. Re-check the Pricing tab.',
      },
      { status: 409 },
    )
  }

  const pricingBookForValidation: PricingBookForValidation = {
    hourly_rate: (pricingBook?.hourly_rate ?? 0) as number | string,
    apprentice_rate: (pricingBook?.apprentice_rate ?? pricingBook?.hourly_rate ?? 0) as number | string,
    senior_rate: pricingBook?.senior_rate as number | string | null | undefined,
    call_out_minimum: (pricingBook?.call_out_minimum ?? 0) as number | string,
    default_markup_pct: (pricingBook?.default_markup_pct ?? 0) as number | string,
    min_labour_hours: pricingBook?.min_labour_hours as number | string | undefined,
    after_hours_multiplier: pricingBook?.after_hours_multiplier as
      | number
      | string
      | null
      | undefined,
  }

  // ─── Resolve the tiers to edit ─────────────────────────────
  let currentTiers: ChatEditTiers
  try {
    currentTiers = bodyTiers
    ? {
        ...(bodyTiers.good !== undefined ? { good: bodyTiers.good as ChatEditTier } : {}),
        ...(bodyTiers.better !== undefined ? { better: bodyTiers.better as ChatEditTier } : {}),
        ...(bodyTiers.best !== undefined ? { best: bodyTiers.best as ChatEditTier } : {}),
      }
    : {
        good: dbTierToChatEdit(quote.good as DbTier, 'good'),
        better: dbTierToChatEdit(quote.better as DbTier, 'better'),
        best: dbTierToChatEdit(quote.best as DbTier, 'best'),
      }
  } catch {
    return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  }

  if (bodyTiers) {
    for (const key of ['good', 'better', 'best'] as const) {
      const tier = currentTiers[key]
      if (!tier) continue
      const indices = tier.line_items.flatMap((line) => line.original_line_index === undefined ? [] : [line.original_line_index])
      if (indices.length && !parsed.data.expected_revision) {
        return Response.json({ ok: false, error: 'revision_required_for_line_identity' }, { status: 400 })
      }
      if (new Set(indices).size !== indices.length) return Response.json({ ok: false, error: 'duplicate_line_identity' }, { status: 400 })
      const stored = (quote[key] as DbTier)?.line_items ?? []
      for (const line of tier.line_items) {
        const provenance = preserveLineProvenance(line, stored, groundingMode === 'catalogue')
        if (!provenance) return Response.json({ ok: false, error: 'line_provenance_conflict' }, { status: 409 })
        Object.assign(line, provenance)
      }
    }
  }

  // ─── Candidates + propose ──────────────────────────────────
  try {
    // Catalogue trades load their priced catalogue for grounding; tradie-
    // authored trades have none, so pass an empty set (grounding is skipped).
    const candidates: CandidatePrices =
      groundingMode === 'catalogue'
        ? await loadCandidatePrices(pricingBookForValidation, trade, quote.tenant_id as string)
        : { material: [], assembly: [] }
    const result = await proposeQuoteEdit({
      instruction,
      currentTiers,
      trade,
      tenantId: quote.tenant_id as string,
      pricingBook: pricingBookForValidation,
      candidates,
      groundingMode,
      scopeOfWorks: (quote.scope_of_works as string | null) ?? null,
      assumptions: (quote.assumptions as unknown) ?? null,
    })
    return Response.json({ ok: true, edit_revision: revision, ...result })
  } catch (e: unknown) {
    console.error('[quote/chat-edit] propose failed', {
      quoteId,
      error: e instanceof Error ? e.message : String(e),
    })
    return Response.json(
      {
        ok: false,
        error: 'propose_failed',
        hint: "Couldn't draft that change — try rephrasing the instruction.",
      },
      { status: 502 },
    )
  }
}
