// POST /api/quote/[id]/edit
//
// Tradie-only endpoint that lets the owner of a quote update its line
// items + tier pricing in place. The customer-facing /q/<token> URL
// stays the same — only the underlying tier JSONBs, headline total,
// and Stripe Checkout Session URLs change.
//
// Auth: Bearer <supabase-access-token>. Validates that the caller's
// user id matches tenants.owner_user_id for the quote's tenant. Any
// other authenticated user (or anon) gets 403.
//
// Behaviour:
//   1. Reject if quote is already paid (immutable once a deposit lands).
//   2. Recompute each tier's subtotal_ex_gst from its line_items.
//   3. Pick the new headline total_inc_gst from the selected_tier (or
//      better/best/good fallback) and apply the same GST treatment the
//      original draft used (pricing_book.gst_registered).
//   4. For every tier whose subtotal changed, expire the old Stripe
//      Checkout Session and create a new one. Tiers whose subtotal
//      didn't change keep their existing URL.
//   5. Persist tier JSONBs + new total + updated stripe_links.
//
// Returns the updated row so the client can render without a follow-up
// fetch.

import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { z } from 'zod'
import {
  expireCheckoutSession,
  createCheckoutSessionForTier,
} from '@/lib/stripe/checkout'
import { connectDestinationForTenant } from '@/lib/stripe/connect'
import { computePriceHoldUntil } from '@/lib/quote/hold'
import { dispatchQuoteWithPdf } from '@/lib/sms/send-quote-pdf'
import { ensureQuotePdf, quotePdfUrl, signQuotePdfUrl } from '@/lib/quote/pdf'
import { archiveAndIngestQuote } from '@/lib/filestore/ingest-quote'
import { buildQuoteKbText } from '@/lib/filestore/minimize'
import { buildQuoteUpdatedSms } from '@/lib/sms/templates'
import { asQuoteKind, isSiteVisitFirstRow } from '@/lib/quote/mint-tier'
import { clampDepositPct } from '@/lib/quote/money'
import { asQuoteTierMode } from '@/lib/quote/tier-visibility'
import { resolveQuoteDisplayMode } from '@/lib/quote/display'
import { loadCandidatePrices } from '@/lib/estimate/run'
import {
  validateQuoteGrounding,
  detectCrossTierDuplicates,
  isManualLine,
  type GroundingFailure,
  type PricingBookForValidation,
} from '@/lib/estimate/validate'
import { tradeGroundingMode } from '@/lib/quote/report-adapters/registry'
import { shouldNotifyOnEdit } from '@/lib/quote/notify-policy'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'
import { type QuoteEditRow, QUOTE_EDIT_FIELDS, quoteEditRevision, validOwnedQuoteBook, preserveLineProvenance } from '@/lib/quote/edit-authority'
import { finiteQuoteNumber } from '@/lib/quote/numeric-input'
import { loadQuotePricingVersion, versionedQuoteGst, QuotePricingVersionError, type QuotePricingVersion } from '@/lib/quote/pricing-version'

export const dynamic = 'force-dynamic'
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
  // total_ex_gst is recomputed server-side from quantity * unit_price.
  total_ex_gst: QuoteNumberSchema.optional(),
  source: z.string().trim().max(120).optional().or(z.literal('')),
  supplied_by: z.enum(['tradie', 'customer']).optional(),
  safety_note: z.string().max(2000).optional(),
})

const TierEditSchema = z.object({
  label: z.string().trim().min(1).max(120),
  timeframe: z.string().trim().max(60).optional().or(z.literal('')),
  line_items: z.array(LineItemSchema).min(1, 'At least one line item'),
})

const BodySchema = z.object({
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  good: TierEditSchema.optional(),
  better: TierEditSchema.optional(),
  best: TierEditSchema.optional(),
  // Controls whether the customer is SMS'd an update after the save.
  // Tradie picks this from the confirmation modal in TradieEditor:
  //   true   — send full updated quote SMS (default when any tier price
  //            changed; tradie can override)
  //   false  — save silently (default when only labels/descriptions
  //            changed; tradie can also force a silent save)
  //   undef  — legacy callers fall back to the prior auto-send behaviour
  //            (notify whenever any tier subtotal changed). Preserved so
  //            scripts/integrations that hit this endpoint pre-modal
  //            keep working.
  notify_customer: z.boolean().optional(),
  // H-2 (2026-05-25) — tradie acknowledges that this edit fails the
  // grounding check and persists it anyway. The quote is stamped with a
  // `tradie_edit_ungrounded:*` risk flag for audit. Default false: an
  // ungrounded edit is rejected with a 422 listing the failing lines.
  force: z.boolean().optional(),
})

type TierEdit = z.infer<typeof TierEditSchema>

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: quoteId } = await params

  // ─── Auth (dual-auth: Clerk OR legacy Supabase token) ───────
  // Resolve the caller's own tenant (with the Connect columns the Stripe
  // re-issue below needs) up front; the ownership check moves to comparing
  // quote.tenant_id against this resolved tenant.id.
  const resolved = await resolveTenantRequest(
    supabase,
    req,
    'id, stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_payouts_enabled',
  )
  if (!resolved) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const tenant = resolved.tenant as {
    id: string
    stripe_connect_account_id: string | null
    stripe_connect_charges_enabled: boolean | null
    stripe_connect_payouts_enabled: boolean | null
  } | null

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
  const edits = parsed.data
  if (!edits.good && !edits.better && !edits.best) {
    return Response.json({ ok: false, error: 'no_changes' }, { status: 400 })
  }

  // ─── Load + authorise ──────────────────────────────────────
  // C-1 (2026-05-25) — pull `applied_discount_pct` so the Stripe Session
  // re-issue below can preserve the early-bird discount the customer
  // already locked in at booking time. Previously the discount was
  // silently dropped — customer saw discounted SMS but paid full price.
  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select(
      // R8 (2026-06-18) — scope_of_works + assumptions are REAL quotes
      // columns (sql/init.sql) and carry the customer-visible framing that
      // detectCrossTierDuplicates reads to allow a legitimately-explained
      // "3 vs 6" quantity difference across tiers. They were previously
      // unselected, so fullDraft saw no framing and a framed multi-quantity
      // quote got a spurious 422 the moment any tier was edited. NOTE:
      // `scope_short` became a real quotes column with migration 175 (the
      // five-sections spec ended its ephemeral, draft-only life), but it is
      // deliberately NOT selected here: this route neither reads nor writes
      // it (Section 2 is generated, not tradie-edited in v1), and leaving it
      // unselected keeps this edit path working on a pre-175 database.
      `${QUOTE_EDIT_FIELDS.join(',')}, share_token, inspection_reason, estimated_timeframe, scope_of_works, assumptions, display_mode`,
    )
    .eq('id', quoteId)
    .maybeSingle<QuoteEditRow>()
  if (quoteError) return Response.json({ ok: false, error: 'quote_unavailable' }, { status: 503 })
  if (!quote) return Response.json({ ok: false, error: 'no_quote' }, { status: 404 })
  if (!quote.tenant_id) {
    return Response.json({ ok: false, error: 'unscoped_quote' }, { status: 403 })
  }
  if (quote.paid_at) {
    return Response.json(
      { ok: false, error: 'quote_already_paid' },
      { status: 409 },
    )
  }
  // M-4 (2026-05-25) — inspection quotes are flat $99 with no tier
  // structure. Editing one was silently producing `total_inc_gst: 0`
  // because the headline-tier fallback chain falls through to a null tier.
  if (quote.needs_inspection) {
    return Response.json(
      {
        ok: false,
        error: 'cannot_edit_inspection_quote',
        hint: 'Inspection-required quotes are flat $99 — there are no tiers to edit. Re-quote from a new intake instead.',
      },
      { status: 409 },
    )
  }

  if (!tenant || quote.tenant_id !== tenant.id) {
    return Response.json({ ok: false, error: 'not_owner' }, { status: 403 })
  }
  const readiness = await readQuoteDraftReadiness(supabase, quote)
  if (!readiness.ready) return Response.json({ ok: false, error: readiness.code }, { status: 409 })
  if (edits.expected_revision && edits.expected_revision !== quoteEditRevision(quote)) {
    return Response.json({ ok: false, error: 'quote_changed' }, { status: 409 })
  }
  if (!edits.expected_revision && [edits.good, edits.better, edits.best].some(
    (tier) => tier?.line_items.some((line) => line.original_line_index !== undefined),
  )) return Response.json({ ok: false, error: 'revision_required_for_line_identity' }, { status: 400 })

  // quotes.quote_kind — 'final'/'balance' rows are post-site-visit children
  // (spec post-visit-money-sequence R4). They carry a tradie-confirmed price,
  // are sent only by the explicit Send button, and never mint tier Sessions.
  const quoteKind = asQuoteKind(quote.quote_kind as string | null)

  // ─── Intake context FIRST — its trade scopes the pricing read below ─
  // H-2 — pull intake.trade so candidates can be trade-scoped exactly
  // like the original draft (electrical quotes don't validate against
  // plumbing rows and vice versa).
  const { data: intake, error: intakeError } = await supabase
    .from('intakes')
    .select('tenant_id, job_type, scope, caller, trade, customer_id, call_id')
    .eq('id', quote.intake_id)
    .eq('tenant_id', tenant.id)
    .maybeSingle()
  if (intakeError) return Response.json({ ok: false, error: 'pricing_unavailable' }, { status: 503 })
  if (!intake || intake.tenant_id !== tenant.id || typeof intake.trade !== 'string' || !intake.trade.trim()) {
    return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  }

  // ─── Pricing context for GST handling + grounding revalidation ─
  // H-2 — we need the full pricing book (not just gst_registered) so
  // the grounding validator can re-check tradie hand-edits against
  // the same hourly_rate / call_out_minimum / markup / min-labour
  // floor that the original draft was graded on.
  //
  // Scoped to the QUOTE'S trade (audit 2026-07-23): an unscoped
  // .eq('tenant_id').limit(1) handed a multi-trade tenant whichever row
  // Postgres returned first, so an electrical hand-edit could be GST'd
  // and grounded against the plumbing book. The draft route and the
  // customer page are already trade-scoped — this read must match them.
  let savedVersion: QuotePricingVersion | null
  try { savedVersion = await loadQuotePricingVersion(supabase, quote, intake.trade) }
  catch (error) {
    return Response.json({ ok: false, error: error instanceof QuotePricingVersionError ? error.code : 'pricing_unavailable' },
      { status: error instanceof QuotePricingVersionError ? error.status : 503 })
  }
  const pricingBookQuery = supabase
    .from('pricing_book')
    .select(
      'id, tenant_id, gst_registered, trade, hourly_rate, apprentice_rate, senior_rate, call_out_minimum, default_markup_pct, min_labour_hours, after_hours_multiplier, quote_display, quote_tier_mode',
    )
    .eq('tenant_id', quote.tenant_id).eq('trade', intake.trade)
  const intakeTrade = intake.trade as string
  const { data: currentBook, error: bookError } = savedVersion ? { data: null, error: null } : await pricingBookQuery.maybeSingle()
  const pricingBook = savedVersion?.snapshot ?? currentBook
  if (bookError) return Response.json({ ok: false, error: 'pricing_unavailable' }, { status: 503 })
  const gstRegistered = versionedQuoteGst(quote, savedVersion)
  if (!validOwnedQuoteBook(pricingBook, tenant.id, intakeTrade) || gstRegistered === null) {
    return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  }

  // Per-trade grounding posture: catalogue trades (electrical/plumbing) are
  // gated by the grounding validator; tradie-authored trades (solar/roof/paint)
  // have no catalogue, so the tradie owns the prices and the gate is skipped.
  //
  // A post-site-visit FINAL quote is exempt (spec post-visit-money-sequence
  // R4): the tradie has BEEN to the property and is typing the price they
  // confirmed there. That lump sum has no catalogue line to ground against,
  // so the gate would 422 the one edit the whole chain exists to enable and
  // force `force:true` — which stamps a `tradie_edit_ungrounded` risk flag on
  // a price that is in fact the most reliable number in the system.
  const groundingMode =
    quoteKind !== 'initial'
      ? 'tradie'
      : tradeGroundingMode(
          (intake?.trade as string | null | undefined) ??
            (pricingBook?.trade as string | null | undefined) ??
            null,
        )

  // ─── Apply per-tier edits ──────────────────────────────────
  type TierJson = {
    label?: string
    timeframe?: string
    subtotal_ex_gst?: number
    line_items?: Array<{
      description: string
      quantity: number
      unit?: string
      unit_price_ex_gst: number
      total_ex_gst: number
      source?: string
      supplied_by?: 'tradie' | 'customer'
      safety_note?: string
    }>
  } | null

  const tierKeys: Array<'good' | 'better' | 'best'> = ['good', 'better', 'best']
  const nextTiers: Record<'good' | 'better' | 'best', TierJson> = {
    good: (quote.good as TierJson) ?? null,
    better: (quote.better as TierJson) ?? null,
    best: (quote.best as TierJson) ?? null,
  }
  const changedTiers: Array<'good' | 'better' | 'best'> = []

  for (const key of tierKeys) {
    const edit: TierEdit | undefined = edits[key]
    if (!edit) continue
    const existing = nextTiers[key]
    if (!existing) {
      return Response.json(
        { ok: false, error: `cannot_edit_missing_tier:${key}` },
        { status: 400 },
      )
    }

    // Recompute every line item's total from quantity × unit_price. We
    // trust the unit + description from the caller but never the totals
    // — those have to be derived so a buggy or malicious client can't
    // ship a Stripe Session that doesn't match the visible line items.
    const identities = edit.line_items.flatMap((li) => li.original_line_index === undefined ? [] : [li.original_line_index])
    if (new Set(identities).size !== identities.length) {
      return Response.json({ ok: false, error: 'duplicate_line_identity' }, { status: 400 })
    }
    const provenance = edit.line_items.map((li) => preserveLineProvenance(li, existing.line_items ?? [], groundingMode === 'catalogue'))
    if (provenance.some((item) => item === null)) {
      return Response.json({ ok: false, error: 'line_provenance_conflict', tier: key }, { status: 409 })
    }
    const lineItems = edit.line_items.map((li, index) => ({
      description: li.description,
      quantity: li.quantity,
      unit: li.unit || existing.line_items?.[0]?.unit || 'hr',
      unit_price_ex_gst: +li.unit_price_ex_gst.toFixed(2),
      total_ex_gst: +(li.quantity * +li.unit_price_ex_gst.toFixed(2)).toFixed(2),
      source: provenance[index]!.source,
      ...(provenance[index]!.supplied_by !== undefined ? { supplied_by: provenance[index]!.supplied_by } : {}),
      ...(provenance[index]!.safety_note !== undefined ? { safety_note: provenance[index]!.safety_note } : {}),
    }))
    const subtotal = +lineItems
      .reduce((acc, li) => acc + li.total_ex_gst, 0)
      .toFixed(2)
    if (!Number.isFinite(subtotal) || !Number.isSafeInteger(Math.round(subtotal * 100)) ||
        lineItems.some((li) => !Number.isFinite(li.total_ex_gst))) {
      return Response.json({ ok: false, error: 'invalid_price_range' }, { status: 400 })
    }

    const oldSubtotal =
      typeof existing.subtotal_ex_gst === 'number'
        ? +existing.subtotal_ex_gst.toFixed(2)
        : null
    if (oldSubtotal === null || Math.abs(subtotal - oldSubtotal) > 0.001) {
      changedTiers.push(key)
    }

    nextTiers[key] = {
      ...existing,
      label: edit.label,
      timeframe: edit.timeframe || existing.timeframe || '',
      line_items: lineItems,
      subtotal_ex_gst: subtotal,
    }
  }

  // ─── H-2: Re-ground edited tiers against pricing_book + candidates ─
  // The draft path runs validateQuoteGrounding before persisting; tradie
  // edits used to bypass it entirely, which meant a tradie could push a
  // $20 GPO line (under cost), a fabricated "supervisor fee", or a
  // call-out below pricing_book.call_out_minimum and the system would
  // happily re-issue a Stripe Session at that amount. We now re-run the
  // same gate on ONLY the tiers the tradie actually edited — untouched
  // tiers stay as-is (they were already grounded at draft time).
  //
  // M-1 + M-2 (2026-05-25) — fail CLOSED on misconfigured pricing book.
  // Pre-fix: if hourly_rate was null we'd silently skip the gate with a
  // warn log, letting arbitrary prices through. We also defaulted
  // default_markup_pct to 28% if missing, which validated edits against
  // a wrong markup band. Both are CONFIG errors masquerading as infra
  // failures — WP1 (the draft path) blocks them on create, so by the
  // time an edit lands the row must already be complete. If it isn't,
  // the right move is a 409 the operator can see, not a silent bypass.
  // Catalogue trades MUST have a complete pricing_book (the grounding validator
  // grades edits against it). Tradie-authored trades (solar/roof/paint) don't
  // ground against a catalogue, so a sparse book is acceptable.
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
          'This tenant\'s pricing_book is missing required fields ' +
          '(hourly_rate, default_markup_pct). Cannot validate edits. ' +
          'Re-check the Pricing tab in the dashboard.',
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
    after_hours_multiplier: pricingBook?.after_hours_multiplier as number | string | null | undefined,
  }

  let groundingFailures: ReturnType<typeof validateQuoteGrounding> = { valid: true }
  // Grounding gate runs ONLY for catalogue trades (electrical/plumbing).
  // Tradie-authored trades (solar/roof/paint) have no catalogue to validate
  // against — the edit saves as the tradie's own prices, with the dashboard
  // diff-review + Save as the human backstop.
  if (groundingMode === 'catalogue') {
   try {
    const trade =
      (intake?.trade as string | null | undefined) ??
      (pricingBook?.trade as string | null | undefined) ??
      null
    const candidates = await loadCandidatePrices(
      pricingBookForValidation,
      trade,
      quote.tenant_id as string,
    )
    // Build a draft-shaped object containing ONLY the tiers the tradie
    // edited; untouched tiers are nulled out so the validator skips
    // them. This keeps the per-line / within-tier gate surgical — an
    // edit to "better" can't be rejected because "good" stopped grounding
    // after a catalogue change.
    const editedDraft = {
      good: edits.good ? nextTiers.good : null,
      better: edits.better ? nextTiers.better : null,
      best: edits.best ? nextTiers.best : null,
    }
    const perTier = validateQuoteGrounding(
      editedDraft,
      pricingBookForValidation,
      candidates,
    )

    // R8 (2026-06-18) — CROSS-TIER dedup must see ALL THREE tiers, not just
    // the edited ones. The surgical per-tier gate above nulls untouched
    // tiers, so a tradie adding a line in GOOD that duplicates a line still
    // sitting in BETTER would slip through (the customer would be charged
    // for the same catalogue row in whichever single tier they pick — the
    // cross-tier shape R6 guards). Run detectCrossTierDuplicates over the
    // FULL merged tier set (nextTiers) and fold any unframed cross-tier
    // double/over-charge into the same failure list the 422/force/risk-flag
    // path already handles.
    //
    // We carry forward the draft's existing scope_of_works / assumptions
    // framing (an unedited quote keeps whatever framing it shipped with) so
    // a legitimately framed "3 vs 6" tier difference is NOT flagged.
    // scope_of_works + assumptions are now SELECTed on the quote row above
    // (R8 fix, 2026-06-18) — they are top-level quote columns (sql/init.sql),
    // NOT nested inside the tier JSONB, so we read them straight off the
    // freshly-loaded row. detectCrossTierDuplicates expects scope_of_works as
    // a string and assumptions as an array; null is tolerated for each.
    // scope_short is a real quotes column since migration 175 but is
    // deliberately NOT selected on this route (neither read nor written
    // here), so it stays null — the persisted scope_of_works carries the
    // same framing text the validator scans.
    const fullDraft = {
      scope_of_works: (quote.scope_of_works as unknown) ?? null,
      scope_short: null,
      assumptions: (quote.assumptions as unknown) ?? null,
      good: nextTiers.good,
      better: nextTiers.better,
      best: nextTiers.best,
    }
    const crossTier = detectCrossTierDuplicates(fullDraft, candidates)
    const crossTierFailures: GroundingFailure[] = crossTier.map((dup) => {
      const first = dup.occurrences[0]
      const firstLi = (nextTiers[first.tier]?.line_items ?? [])[first.lineIndex]
      const where = dup.occurrences.map((o) => `${o.tier}#${o.lineIndex}`).join(', ')
      return {
        tier: first.tier,
        lineIndex: first.lineIndex,
        description: String(firstLi?.description ?? dup.sourceName ?? '(no description)'),
        unit: String(firstLi?.unit ?? '?'),
        unit_price_ex_gst: Number(firstLi?.unit_price_ex_gst),
        expected:
          `cross-tier duplicate ${dup.anchor} ("${dup.sourceName}") appears at ${where} ` +
          `with differing quantities and no scope framing the change. Same product at ` +
          `different quantities across tiers is only allowed when the quantity difference ` +
          `is documented in the quote scope.`,
      }
    })

    const allFailures = [
      ...(perTier.valid ? [] : perTier.failures),
      ...crossTierFailures,
    ]
    groundingFailures =
      allFailures.length === 0 ? { valid: true } : { valid: false, failures: allFailures }
  } catch (e: unknown) {
    // Genuine INFRA failure (DB unreachable mid-edit). Preserve the
    // pre-M-1 "fail open on infra" intent — edit proceeds, validator
    // result stays { valid: true }, warn logged. A misconfigured book
    // is caught above as 409; this is the strictly-infra path.
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[quote/edit] grounding revalidation failed', {
      quoteId,
      error: msg,
    })
    return Response.json({ ok: false, error: 'grounding_unavailable' }, { status: 503 })
   }
  }

  if (!groundingFailures.valid && edits.force !== true) {
    return Response.json(
      {
        ok: false,
        error: 'grounding_failed',
        failures: groundingFailures.failures,
        hint:
          'One or more edited line items do not derive from this tenant\'s ' +
          'pricing_book + catalogue. Either correct the prices to match a ' +
          'real DB row (raw or ±5pp around your configured markup) OR re-send ' +
          'with { "force": true } to persist anyway. Forced edits are stamped ' +
          'with a tradie_edit_ungrounded risk flag for audit.',
      },
      { status: 422 },
    )
  }
  if (!groundingFailures.valid && edits.force === true) {
    // A forced human price may be saved under existing policy, but must not
    // keep claiming that an unverified catalogue source established it.
    for (const failure of groundingFailures.failures) {
      const line = nextTiers[failure.tier]?.line_items?.[failure.lineIndex]
      if (line) line.source = 'tradie_edit'
    }
  }

  // ─── Headline total — pick from selected_tier or fall back ─
  const selectedKey =
    (quote.selected_tier as 'good' | 'better' | 'best' | null) ?? 'better'
  const headlineTier =
    nextTiers[selectedKey] ?? nextTiers.better ?? nextTiers.best ?? nextTiers.good
  const headlineSubtotal = headlineTier?.subtotal_ex_gst ?? 0
  const gstMultiplier = gstRegistered ? 1.1 : 1.0
  const newTotalIncGst = +(headlineSubtotal * gstMultiplier).toFixed(2)

  // ─── Stripe sync — only re-issue for tiers that changed ───
  const originalStripeLinks: Record<string, string | undefined> = {
    ...((quote.stripe_links as Record<string, string | undefined>) ?? {}),
  }
  const stripeLinks = { ...originalStripeLinks }
  for (const key of changedTiers) delete stripeLinks[key]
  const appUrl =
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    'https://www.quotemax.com.au'

  // C-1 (2026-05-25) — preserve any early-booking discount the customer
  // already locked in. `applied_discount_pct` is stamped at booking time
  // by /api/q/[token]/book; if the tradie edits a tier AFTER the
  // customer has booked but BEFORE they've paid, the re-issued Session
  // MUST carry the same discount or the customer gets charged full price.
  // `clampDiscountPct` inside createCheckoutSessionForTier caps it at the
  // 15% platform limit and treats 0/null as no-discount (pre-C-1 behaviour
  // for any quote that wasn't booked yet).
  const appliedDiscountPct = ((quote.applied_discount_pct as number | null | undefined) ?? 0)
  const storedDepositPct = quote.deposit_pct
  if (changedTiers.length && quoteKind === 'initial' && !isSiteVisitFirstRow({ trade: intakeTrade, quoteKind }) &&
      (typeof storedDepositPct !== 'number' || !Number.isFinite(storedDepositPct) || storedDepositPct < 1 || storedDepositPct > 90)) {
    return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  }

  // ─── Persist ───────────────────────────────────────────────
  const updateBody: Record<string, unknown> = {
    good: nextTiers.good,
    better: nextTiers.better,
    best: nextTiers.best,
    total_inc_gst: newTotalIncGst,
    stripe_links: stripeLinks,
    // Mig 146 — INVALIDATE the cached customer PDF on every edit. The
    // pdf_signature (lib/quote/pdf-signature.ts) captures only template version
    // + tier mode + visible tiers — NOT line-item content — so an edited price,
    // label, quantity, or added/removed line would otherwise keep serving the
    // STALE cached quotes.pdf_path on the next /api/q/[token]/pdf hit
    // (quotePdfIsStale sees an unchanged signature). The notify path below
    // eagerly regenerates with { regenerate: true }; but a quote held for review
    // (status 'awaiting_tradie_approval') or a silent save (notify_customer:
    // false) takes the NO-notify branch and never regenerates — that was the
    // "edit didn't reach the PDF" bug. Nulling pdf_path forces quotePdfIsStale →
    // true, so the next preview/download/send regenerates from these saved
    // tiers regardless of whether the customer is SMS'd now.
    pdf_path: null,
    pdf_signature: null,
    // M-3 (2026-05-25) — only bump status when an actual price changed.
    // A label-only or description-only edit shouldn't transition the
    // quote from 'draft' to 'sent' (that signals tradie price-ownership
    // downstream — e.g. follow-up automation treats 'sent' as formally
    // quoted, vs 'draft' as still-being-fixed). Tradies routinely use
    // the editor for typo fixes; those should stay 'draft'.
    // A FINAL quote is sent ONLY by the explicit Send button (spec R4): the
    // tradie prices it on site over several saves, and auto-flipping it to
    // 'sent' would both mislabel the pipeline and let the follow-up queues
    // start chasing a quote the customer has never seen.
    status: quote.status,
    // 2026-07-02 — restart the 7-day price hold whenever a price actually
    // changed. The /q expired banner tells the customer to "reply for a
    // refreshed quote" and THIS is that refresh: without the restamp, an
    // edited quote older than 7 days stayed permanently blocked by the
    // /r + booking expiry gates. Label/typo-only edits keep the old hold.
    ...(changedTiers.length > 0
      ? { price_hold_until: computePriceHoldUntil(new Date().toISOString()) }
      : {}),
  }

  // Audit risk_flags. Two append-only sources, merged + deduped onto the
  // quote's existing flags (we never OVERWRITE):
  //   - every tradie-entered manual line (`tradie_manual_line:<tier>#<idx>`)
  //     — an ungrounded human-entered price the customer can see, kept
  //     traceable even though the grounding gate exempts it.
  //   - H-2: a forced save through a failed grounding check
  //     (`tradie_edit_ungrounded:<tier>#<idx>,...`).
  const existingFlags = Array.isArray(quote.risk_flags) ? (quote.risk_flags as string[]) : []
  const flagsToAdd: string[] = []
  for (const key of tierKeys) {
    const items = nextTiers[key]?.line_items ?? []
    for (let i = 0; i < items.length; i++) {
      if (isManualLine(items[i])) flagsToAdd.push(`tradie_manual_line:${key}#${i}`)
    }
  }
  if (!groundingFailures.valid && edits.force === true) {
    const summary = groundingFailures.failures
      .map((f) => `${f.tier}#${f.lineIndex}`)
      .join(',')
    flagsToAdd.push(`tradie_edit_ungrounded:${summary || 'unknown'}`)
    console.warn('[quote/edit] persisting ungrounded edit under force=true', {
      quoteId,
      failures: groundingFailures.failures,
    })
  }
  if (flagsToAdd.length > 0) {
    const merged = [...existingFlags]
    for (const f of flagsToAdd) if (!merged.includes(f)) merged.push(f)
    updateBody.risk_flags = merged
  }

  let save = supabase
    .from('quotes')
    .update(updateBody)
    .eq('id', quoteId)
    .eq('tenant_id', tenant.id)
    .is('paid_at', null)
  for (const key of QUOTE_EDIT_FIELDS) {
    if (['id', 'tenant_id', 'paid_at'].includes(key)) continue
    const value = quote[key]
    save = value == null ? save.is(key, null) : save.eq(key,
      typeof value === 'object' ? JSON.stringify(value) : value)
  }
  const { data: persisted, error: updErr } = await save.select(QUOTE_EDIT_FIELDS.join(',')).maybeSingle<QuoteEditRow>()
  if (updErr) {
    return Response.json(
      { ok: false, error: `update_failed: ${updErr.message}` },
      { status: 500 },
    )
  }
  if (!persisted) return Response.json({ ok: false, error: 'quote_changed' }, { status: 409 })

  // External checkout work starts only after the conditional financial save.
  let checkoutSync: 'complete' | 'pending' = 'complete'
  try {
  // A post-site-visit child takes this branch for the SAME reason as
  // electrical/plumbing: its charge is not a G/B/B tier Session. /r mints the
  // deposit per click from the row's stored total, so a tier Session minted
  // here would be unreachable — and a stale one left behind could be paid at
  // a price the tradie has just changed.
  if (quoteKind !== 'initial' || isSiteVisitFirstRow({ trade: intakeTrade, quoteKind })) {
    // Electrical/plumbing sell ONE thing: the flat $99 site visit (spec
    // elec-plumb-site-visit-first). A G/B/B Session minted here would be
    // permanently unreachable — /r/<token>/<tier> 302s those tiers onto the
    // inspection mint and no surface exposes the stored URL — so re-minting is
    // a wasted Stripe call plus a dead stripe_links write on every edit.
    // Instead DROP the stale tier link and EXPIRE it, so a Checkout tab left
    // open from the deposit era can never complete at a price the tradie has
    // just changed. Same treatment painting gave its retired tier mint
    // (app/api/painting/edit/[token]/route.ts).
    //
    // ⚠ stripe_links.inspection is deliberately untouched: it is the LIVE $99
    // Session, and it does not move with the tier prices.
    const stale: string[] = []
    for (const key of changedTiers) {
      const oldUrl = originalStripeLinks[key]
      if (oldUrl) stale.push(oldUrl)
      delete stripeLinks[key]
    }
    const expirations = await Promise.allSettled(stale.map((url) => expireCheckoutSession(url)))
    if (expirations.some((result) => result.status === 'rejected' || !result.value.ok)) checkoutSync = 'pending'
  } else {
    // Connect routing (2% platform fee) — same decision the original Session
    // used, re-read off the tenant row loaded for the ownership check above.
    const connect = connectDestinationForTenant(tenant)

    for (const key of changedTiers) {
      const oldUrl = originalStripeLinks[key]
      if (oldUrl) {
        const exp = await expireCheckoutSession(oldUrl)
        if (!exp.ok) {
          checkoutSync = 'pending'
          console.warn('[quote/edit] expire failed', {
            quoteId,
            tier: key,
            reason: exp.reason,
          })
          continue
        }
      }
      // Cast each tier to the Stripe helper's strict { label, subtotal_ex_gst }
      // shape — by this point every tier we'd actually re-issue has those
      // fields populated (label from the edit, subtotal recomputed above).
      type StripeTierShape = { label: string; subtotal_ex_gst: number | string } | null
      const newUrl = await createCheckoutSessionForTier({
        quote: {
          id: quote.id as string,
          good: nextTiers.good as StripeTierShape,
          better: nextTiers.better as StripeTierShape,
          best: nextTiers.best as StripeTierShape,
          deposit_pct: storedDepositPct as number,
          // P1 — the re-issued Session honours gst_registered exactly like the
          // total_inc_gst recomputed above.
          gst_registered: gstRegistered,
        },
        tierKey: key,
        intake: {
          job_type: (intake?.job_type as string) ?? 'other',
          scope: (intake?.scope as { item_count?: number } | null) ?? null,
          caller: (intake?.caller as { name?: string; email?: string } | null) ?? null,
        },
        shareToken: quote.share_token as string,
        appUrl,
        discountPct: appliedDiscountPct,
        connect,
      })
      if (newUrl) stripeLinks[key] = newUrl
      else checkoutSync = 'pending'
    }
  }

  } catch {
    checkoutSync = 'pending'
  }
  let linkSave = supabase.from('quotes').update({ stripe_links: stripeLinks })
    .eq('id', quoteId).eq('tenant_id', tenant.id).is('paid_at', null)
  for (const key of QUOTE_EDIT_FIELDS) {
    if (['id', 'tenant_id', 'paid_at'].includes(key)) continue
    const value = persisted[key]
    linkSave = value == null ? linkSave.is(key, null) : linkSave.eq(key,
      typeof value === 'object' ? JSON.stringify(value) : value)
  }
  const { data: linked, error: linkError } = await linkSave.select(QUOTE_EDIT_FIELDS.join(',')).maybeSingle<QuoteEditRow>()
  if (linkError || !linked) checkoutSync = 'pending'


  // Notify the customer that their quote was updated. Three modes,
  // driven by the optional `notify_customer` flag on the request body:
  //
  //   true       — always send the update SMS, even if only a label
  //                changed. Tradie explicitly opted in via the
  //                TradieEditor confirmation modal.
  //   false      — skip the SMS entirely. Tradie chose "save quietly"
  //                in the modal, typically because they're mid-edit or
  //                only fixing typos.
  //   undefined  — legacy auto-send behaviour: notify whenever any tier
  //                subtotal changed. Preserved so older clients hitting
  //                this endpoint pre-modal keep working.
  //
  // We always fire AFTER the response returns so the tradie's UI update
  // isn't blocked on SMS dispatch.
  // A quote still held for tradie approval has NOT been shown to the customer;
  // an edit must not be their first contact (only Approve releases it).
  // shouldNotifyOnEdit suppresses the SMS while held, otherwise applies the
  // explicit-opt-in / legacy-price-change rule.
  // A FINAL quote never auto-texts on edit (spec R4). The updated-quote SMS
  // is built for the initial tier shape — it would carry the $99 site-visit
  // line and no deposit maths — and the tradie is mid-pricing on site. The
  // explicit Send is the only thing that reaches the customer.
  const shouldNotify =
    checkoutSync === 'complete' && quoteKind === 'initial' &&
    shouldNotifyOnEdit({
      status: quote.status as string | null | undefined,
      notifyCustomer: edits.notify_customer,
      changedTiersCount: changedTiers.length,
    })

  if (shouldNotify) {
    after(async () => {
      try {
        const { data: current, error: currentError } = await supabase.from('quotes')
          .select(QUOTE_EDIT_FIELDS.join(',')).eq('id', quoteId).eq('tenant_id', tenant.id).maybeSingle<QuoteEditRow>()
        if (currentError || !current || current.paid_at ||
            quoteEditRevision(current) !== quoteEditRevision(linked ?? persisted)) return
        // Resolve customer phone through a 4-source fallback chain.
        // intake.caller.phone is often EMPTY STRING on SMS-sourced quotes
        // (the structurer doesn't always backfill it from the conversation
        // row), so the route used to silently skip the customer SMS even
        // though the number was sitting on sms_conversations.from_number.
        // Surfaced 2026-05-28 on quote db0f7864 — tradie edited + sent,
        // log read "no phone resolvable", customer received nothing.
        //
        // Sources in priority order:
        //   1. intake.caller.phone  (the original JSONB — authoritative
        //      when the structurer populated it)
        //   2. sms_conversations.from_number  (SMS-sourced quotes — the
        //      number the customer actually texted from)
        //   3. calls.caller_number  (voice-sourced via Vapi)
        //   4. customers.phone  (linked customer row, if any)
        //
        // Empty strings are treated as missing (`.trim() || null`).
        const callerObj = (intake?.caller as { name?: string; phone?: string } | null) ?? null
        let callerNumber: string | null = (callerObj?.phone ?? '').trim() || null
        let phoneSource: 'intake_caller' | 'sms_conversation' | 'call' | 'customer' | null =
          callerNumber ? 'intake_caller' : null

        if (!callerNumber && quote.intake_id) {
          const { data: convo } = await supabase
            .from('sms_conversations')
            .select('from_number')
            .eq('intake_id', quote.intake_id)
            .maybeSingle()
          const fromNumber = (convo?.from_number as string | null)?.trim() || null
          if (fromNumber) {
            callerNumber = fromNumber
            phoneSource = 'sms_conversation'
          }
        }

        if (!callerNumber && intake?.call_id) {
          const { data: call } = await supabase
            .from('calls')
            .select('caller_number')
            .eq('id', intake.call_id as string)
            .maybeSingle()
          const num = (call?.caller_number as string | null)?.trim() || null
          if (num) {
            callerNumber = num
            phoneSource = 'call'
          }
        }

        if (!callerNumber && intake?.customer_id) {
          const { data: cust } = await supabase
            .from('customers')
            .select('phone')
            .eq('id', intake.customer_id as string)
            .maybeSingle()
          const num = (cust?.phone as string | null)?.trim() || null
          if (num) {
            callerNumber = num
            phoneSource = 'customer'
          }
        }

        if (!callerNumber) {
          console.log('[quote/edit] customer notify skipped — no phone resolvable', {
            quoteId,
            intake_id: quote.intake_id,
            had_caller_obj: !!callerObj,
            caller_phone_empty: callerObj?.phone === '',
          })
          return
        }
        console.log('[quote/edit] customer phone resolved', {
          quoteId,
          phoneSource,
        })

        // Pull tenant's outbound number so the SMS lands in the SAME
        // thread as the original quote. Falls back to the env if the
        // tenant somehow doesn't have one set yet.
        let tenantSmsNumber: string | null = null
        if (quote.tenant_id) {
          const { data: t } = await supabase
            .from('tenants')
            .select('twilio_sms_number')
            .eq('id', quote.tenant_id)
            .maybeSingle()
          tenantSmsNumber = (t?.twilio_sms_number as string | null) ?? null
        }
        const fromNumber = tenantSmsNumber ?? process.env.TWILIO_SMS_NUMBER ?? undefined

        // Migration 105 — the tiers just changed, so REGENERATE the quote
        // PDF before the re-send (a stale document contradicting the SMS
        // would be worse than none). Best-effort; never blocks the SMS.
        const quotePdfPath = quote.needs_inspection
          ? null
          : await ensureQuotePdf(quoteId, { regenerate: true })

        // Build the full updated-quote SMS — same shape as the original
        // buildQuoteSms output (three tier breakdown with prices + pay
        // links) but with an "updated" preamble so the customer sees the
        // refresh framing. Construct the SMS-shaped quote payload from
        // the updated tier JSON we just persisted.
        // Build the full updated-quote SMS — same shape as the original
        // buildQuoteSms output (three tier breakdown with prices + pay
        // links) but with an "updated" preamble so the customer sees the
        // refresh framing. Construct the SMS-shaped quote payload from
        // the updated tier JSON we just persisted.
        const text = buildQuoteUpdatedSms(
          {
            caller: (intake?.caller as { name?: string } | null) ?? null,
            job_type: ((intake?.job_type as string | null) ?? 'other') as string,
            scope: (intake?.scope as { item_count?: number } | null) ?? null,
          },
          {
            // Cast our internal TierJson (optional label) to the SMS
            // template's stricter Tier shape — at this point every tier
            // we kept around has a label populated, either from the
            // edit body or the pre-existing JSON.
            good: nextTiers.good as unknown as { label: string; subtotal_ex_gst: number } | null,
            better: nextTiers.better as unknown as { label: string; subtotal_ex_gst: number } | null,
            best: nextTiers.best as unknown as { label: string; subtotal_ex_gst: number } | null,
            selected_tier: (quote.selected_tier as 'good' | 'better' | 'best' | null) ?? null,
            estimated_timeframe: (quote.estimated_timeframe as string | null) ?? null,
            needs_inspection: !!quote.needs_inspection,
            inspection_reason: (quote.inspection_reason as string | null) ?? null,
            // Gated /r short-links, not the raw Stripe URLs: raw links die
            // after Stripe's 24h expiry (unchanged tiers still carried
            // draft-time Sessions here) and skip /r's book-first funnel +
            // price-hold gate + fresh-Session mint.
            pay_links: {
              ...(Object.fromEntries(
                Object.entries(stripeLinks)
                  .filter(([, v]) => !!v)
                  .map(([k]) => [k, `${appUrl}/r/${quote.share_token as string}/${k}`]),
              ) as Partial<Record<'good' | 'better' | 'best' | 'inspection', string>>),
              // Spec elec-plumb-site-visit-first R5 — electrical/plumbing sell
              // only the $99 site visit, so the revised-quote message needs that
              // link even when stripe_links still holds G/B/B only.
              // /r/<token>/inspection mints a fresh Session per click.
              ...(isSiteVisitFirstRow({ trade: intakeTrade, quoteKind })
                ? { inspection: `${appUrl}/r/${quote.share_token as string}/inspection` }
                : null),
            },
            // The row's OWN deposit %, not a hardcoded 30: a job type with a
            // configured rate (EV chargers at 50%) would otherwise be
            // advertised at 30% in the revised-quote SMS and then charged at
            // 50% by the mint, which reads quotes.deposit_pct.
            deposit_pct: clampDepositPct(quote.deposit_pct as number | null),
            quote_view_url: `${appUrl}/q/${quote.share_token as string}`,
            pdf_url: quotePdfPath ? quotePdfUrl(quote.share_token as string) : null,
            scope_of_works: null,
            scope_short: null,
            assumptions: null,
            // P6 — the updated-quote SMS must print the SAME discounted,
            // GST-correct numbers the Stripe Session (re-issued above with
            // this exact discount) charges. Post-booking edits previously
            // texted the full price while the link charged the discounted one.
            applied_discount_pct: appliedDiscountPct,
            gst_registered: gstRegistered,
          },
          {
            // Phase A/B — honour the per-quote override (if present) over
            // the tenant preference. The resolver tolerates both being
            // null and defaults to 'itemised', preserving current
            // behaviour for any tenant that hasn't opted in.
            displayMode: resolveQuoteDisplayMode({
              perQuoteOverride: (quote as { display_mode?: string | null }).display_mode ?? null,
              tenantPreference:
                (pricingBook as { quote_display?: string | null } | null)?.quote_display ?? null,
            }),
            // Mig 142 — per-feature tier mode (single-price tradies get one option).
            tierMode: asQuoteTierMode(
              (pricingBook as { quote_tier_mode?: string | null } | null)?.quote_tier_mode ?? null,
            ),
            // Spec elec-plumb-site-visit-first R5 — the trade decides whether
            // the message sells per-tier deposits or the one $99 site visit.
            trade: intakeTrade,
            // …and post-visit-money-sequence R6 — the KIND decides whether the
            // trade gate applies at all. Threaded even though the notify gate
            // above already excludes children, so the builder is correct on
            // its own inputs rather than relying on a caller-side guard.
            quoteKind,
          },
        )
        // Best-effort MMS attach of the refreshed PDF (shared helper signs
        // the media URL and degrades to plain SMS on failure/rejection).
        const result = await dispatchQuoteWithPdf({
          to: callerNumber,
          text,
          from: fromNumber,
          pdfPath: quotePdfPath,
          signMediaUrl: signQuotePdfUrl,
        })
        if (result.ok) {
          // Provider acceptance is distinct from a quiet edit. A held quote
          // never enters this path, and a later edit/payment cannot be stamped
          // sent by an older queued callback.
          if (quote.status === 'draft') {
            let accepted = supabase.from('quotes').update({ status: 'sent', sent_at: new Date().toISOString() })
              .eq('id', quoteId).eq('tenant_id', tenant.id).is('paid_at', null)
            for (const key of QUOTE_EDIT_FIELDS) {
              if (['id', 'tenant_id', 'paid_at'].includes(key)) continue
              const value = current[key]
              accepted = value == null ? accepted.is(key, null) : accepted.eq(key,
                typeof value === 'object' ? JSON.stringify(value) : value)
            }
            await accepted.select('id').maybeSingle()
          }
          console.log('[quote/edit] customer notify sent', {
            quoteId,
            channel: result.channel,
            sid: result.sid,
          })
        } else {
          console.warn('[quote/edit] customer notify failed (both channels)', {
            quoteId,
            sms_code: result.smsAttempt.code,
            sms_reason: result.smsAttempt.reason,
            wa_code: result.waAttempt?.code,
          })
        }

        // Per-tenant file-store ingest — best-effort, post-send. Runs only
        // on this notify path (customer was notified / a tier price changed,
        // i.e. a material re-draft), reusing the PDF just regenerated above.
        // STUBs when TENANT_FILESTORE_ENABLED !== 'true' and no-ops on
        // missing inputs, so it never blocks or alters the re-send.
        try {
          if (quotePdfPath) {
            const ingestTrade =
              (intake?.trade as string | null | undefined) ??
              (pricingBook?.trade as string | null | undefined) ??
              'electrical'
            // Reflect the just-persisted edits in the KB text: merge the
            // updated tiers + headline total onto the loaded quote row.
            const ingestQuote = {
              ...(quote as Record<string, unknown>),
              good: nextTiers.good,
              better: nextTiers.better,
              best: nextTiers.best,
              total_inc_gst: newTotalIncGst,
            }
            const { markdown, contentHash } = buildQuoteKbText({
              quote: ingestQuote,
              trade: ingestTrade,
            })
            await archiveAndIngestQuote({
              tenantId: (quote.tenant_id as string | null) ?? null,
              sourceKind: 'quote',
              sourceId: quote.id as string,
              trade: ingestTrade,
              fullDocPath: quotePdfPath,
              kbText: markdown,
              contentHash,
            })
          }
        } catch {
          /* best-effort */
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[quote/edit] customer notify threw — edit IS persisted, only SMS failed', {
          quoteId,
          error: msg,
        })
      }
    })
  }

  return Response.json({
    ok: true,
    persisted: true,
    edit_revision: quoteEditRevision(linked ?? persisted),
    checkout_sync: checkoutSync,
    notification_requested: shouldNotify,
    gst_registered: gstRegistered,
    quoteId,
    changedTiers,
    total_inc_gst: newTotalIncGst,
    stripe_links: linked ? stripeLinks : persisted.stripe_links,
    tiers: {
      good: nextTiers.good,
      better: nextTiers.better,
      best: nextTiers.best,
    },
  })
}
