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
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { buildQuoteUpdatedSms } from '@/lib/sms/templates'
import { loadCandidatePrices } from '@/lib/estimate/run'
import {
  validateQuoteGrounding,
  type PricingBookForValidation,
} from '@/lib/estimate/validate'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const LineItemSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.coerce.number().min(0),
  unit: z.string().trim().max(20).optional().or(z.literal('')),
  unit_price_ex_gst: z.coerce.number().min(0),
  // total_ex_gst is recomputed server-side from quantity * unit_price.
  total_ex_gst: z.coerce.number().min(0).optional(),
  source: z.string().trim().max(120).optional().or(z.literal('')),
})

const TierEditSchema = z.object({
  label: z.string().trim().min(1).max(120),
  timeframe: z.string().trim().max(60).optional().or(z.literal('')),
  line_items: z.array(LineItemSchema).min(1, 'At least one line item'),
})

const BodySchema = z.object({
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

  // ─── Auth ───────────────────────────────────────────────────
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const token = auth.slice(7).trim()
  if (!token) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const { data: userData, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !userData.user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const userId = userData.user.id

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
  const { data: quote } = await supabase
    .from('quotes')
    .select(
      'id, tenant_id, intake_id, share_token, status, paid_at, selected_tier, good, better, best, stripe_links, total_inc_gst, needs_inspection, inspection_reason, estimated_timeframe, risk_flags',
    )
    .eq('id', quoteId)
    .maybeSingle()
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

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, owner_user_id')
    .eq('id', quote.tenant_id)
    .maybeSingle()
  if (!tenant || tenant.owner_user_id !== userId) {
    return Response.json({ ok: false, error: 'not_owner' }, { status: 403 })
  }

  // ─── Pricing context for GST handling + grounding revalidation ─
  // H-2 — we need the full pricing book (not just gst_registered) so
  // the grounding validator can re-check tradie hand-edits against
  // the same hourly_rate / call_out_minimum / markup / min-labour
  // floor that the original draft was graded on.
  const { data: pricingBook } = await supabase
    .from('pricing_book')
    .select(
      'gst_registered, trade, hourly_rate, apprentice_rate, senior_rate, call_out_minimum, default_markup_pct, min_labour_hours',
    )
    .eq('tenant_id', quote.tenant_id)
    .limit(1)
    .maybeSingle()
  const gstRegistered = (pricingBook?.gst_registered ?? true) as boolean

  // ─── Intake context for Stripe product naming + grounding scope ─
  // H-2 — pull intake.trade so candidates can be trade-scoped exactly
  // like the original draft (electrical quotes don't validate against
  // plumbing rows and vice versa).
  const { data: intake } = await supabase
    .from('intakes')
    .select('job_type, scope, caller, trade')
    .eq('id', quote.intake_id)
    .maybeSingle()

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
    const lineItems = edit.line_items.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unit: li.unit || existing.line_items?.[0]?.unit || 'hr',
      unit_price_ex_gst: +li.unit_price_ex_gst.toFixed(2),
      total_ex_gst: +(li.quantity * li.unit_price_ex_gst).toFixed(2),
      source: li.source || 'tradie_edit',
    }))
    const subtotal = +lineItems
      .reduce((acc, li) => acc + li.total_ex_gst, 0)
      .toFixed(2)

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
  // A pricingBook with hourly_rate set is required — without it the
  // validator can't grade labour lines. If pricingBook is missing or
  // malformed (which shouldn't happen on an active tenant — WP1 blocks
  // draft creation), we skip the gate rather than reject the edit. This
  // matches the "fail open on missing infra, fail closed on bad data"
  // pattern used elsewhere.
  let groundingFailures: ReturnType<typeof validateQuoteGrounding> = { valid: true }
  const pricingBookForValidation =
    pricingBook && pricingBook.hourly_rate != null
      ? ({
          hourly_rate: pricingBook.hourly_rate as number | string,
          apprentice_rate: (pricingBook.apprentice_rate ?? pricingBook.hourly_rate) as number | string,
          senior_rate: pricingBook.senior_rate as number | string | null | undefined,
          call_out_minimum: (pricingBook.call_out_minimum ?? 0) as number | string,
          default_markup_pct: (pricingBook.default_markup_pct ?? 28) as number | string,
          min_labour_hours: pricingBook.min_labour_hours as number | string | undefined,
        } satisfies PricingBookForValidation)
      : null

  if (pricingBookForValidation) {
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
      // them. This keeps the gate surgical — an edit to "better" can't
      // be rejected because "good" stopped grounding after a catalogue
      // change.
      const editedDraft = {
        good: edits.good ? nextTiers.good : null,
        better: edits.better ? nextTiers.better : null,
        best: edits.best ? nextTiers.best : null,
      }
      groundingFailures = validateQuoteGrounding(
        editedDraft,
        pricingBookForValidation,
        candidates,
      )
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn('[quote/edit] grounding revalidation threw — skipping gate', {
        quoteId,
        error: msg,
      })
    }
  } else {
    console.warn('[quote/edit] pricing_book unresolvable — grounding gate skipped', {
      quoteId,
      tenantId: quote.tenant_id,
    })
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

  // ─── Headline total — pick from selected_tier or fall back ─
  const selectedKey =
    (quote.selected_tier as 'good' | 'better' | 'best' | null) ?? 'better'
  const headlineTier =
    nextTiers[selectedKey] ?? nextTiers.better ?? nextTiers.best ?? nextTiers.good
  const headlineSubtotal = headlineTier?.subtotal_ex_gst ?? 0
  const gstMultiplier = gstRegistered ? 1.1 : 1.0
  const newTotalIncGst = +(headlineSubtotal * gstMultiplier).toFixed(2)

  // ─── Stripe sync — only re-issue for tiers that changed ───
  const stripeLinks: Record<string, string | undefined> = {
    ...((quote.stripe_links as Record<string, string | undefined>) ?? {}),
  }
  const appUrl =
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    'https://quote-mate-rho.vercel.app'

  for (const key of changedTiers) {
    const oldUrl = stripeLinks[key]
    if (oldUrl) {
      const exp = await expireCheckoutSession(oldUrl)
      if (!exp.ok) {
        console.warn('[quote/edit] expire failed (continuing)', {
          quoteId,
          tier: key,
          reason: exp.reason,
        })
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
        deposit_pct: 30,
      },
      tierKey: key,
      intake: {
        job_type: (intake?.job_type as string) ?? 'other',
        scope: (intake?.scope as { item_count?: number } | null) ?? null,
        caller: (intake?.caller as { name?: string; email?: string } | null) ?? null,
      },
      shareToken: quote.share_token as string,
      appUrl,
    })
    if (newUrl) stripeLinks[key] = newUrl
  }

  // ─── Persist ───────────────────────────────────────────────
  const updateBody: Record<string, unknown> = {
    good: nextTiers.good,
    better: nextTiers.better,
    best: nextTiers.best,
    total_inc_gst: newTotalIncGst,
    stripe_links: stripeLinks,
    // Bump status to 'sent' if the tradie edits a draft — implies they
    // are taking ownership of the price. Keep other statuses untouched.
    status: quote.status === 'draft' ? 'sent' : quote.status,
  }

  // H-2 — if the tradie forced a save through a failed grounding check,
  // append an audit risk_flag so the failure is traceable. We never
  // OVERWRITE existing risk_flags; we append, dedup, and persist.
  if (!groundingFailures.valid && edits.force === true) {
    const existing = Array.isArray(quote.risk_flags) ? (quote.risk_flags as string[]) : []
    const summary = groundingFailures.failures
      .map((f) => `${f.tier}#${f.lineIndex}`)
      .join(',')
    const flag = `tradie_edit_ungrounded:${summary || 'unknown'}`
    updateBody.risk_flags = existing.includes(flag) ? existing : [...existing, flag]
    console.warn('[quote/edit] persisting ungrounded edit under force=true', {
      quoteId,
      failures: groundingFailures.failures,
    })
  }

  const { error: updErr } = await supabase
    .from('quotes')
    .update(updateBody)
    .eq('id', quoteId)
  if (updErr) {
    return Response.json(
      { ok: false, error: `update_failed: ${updErr.message}` },
      { status: 500 },
    )
  }

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
  const shouldNotify =
    edits.notify_customer === true ||
    (edits.notify_customer === undefined && changedTiers.length > 0)

  if (shouldNotify) {
    after(async () => {
      try {
        // Resolve customer phone from the intake.caller JSONB. Voice-
        // sourced quotes can also fall back to calls.caller_number, but
        // the tradie edit overlay is only reachable from /q/<token> on
        // SMS-sourced quotes today so intake.caller.phone is the only
        // path that lands customers.
        const callerObj = (intake?.caller as { name?: string; phone?: string } | null) ?? null
        const callerNumber = callerObj?.phone ?? null
        const firstName = callerObj?.name?.split(' ')[0] ?? undefined
        if (!callerNumber) {
          console.log('[quote/edit] customer notify skipped — no phone resolvable', {
            quoteId,
          })
          return
        }

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
            pay_links: Object.fromEntries(
              Object.entries(stripeLinks).filter(([, v]) => !!v),
            ) as Partial<Record<'good' | 'better' | 'best' | 'inspection', string>>,
            deposit_pct: 30,
            quote_view_url: `${appUrl}/q/${quote.share_token as string}`,
            scope_of_works: null,
            scope_short: null,
            assumptions: null,
          },
        )
        const result = await dispatchQuoteMessage({
          to: callerNumber,
          text,
          from: fromNumber,
        })
        if (result.ok) {
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
    quoteId,
    changedTiers,
    total_inc_gst: newTotalIncGst,
    stripe_links: stripeLinks,
    tiers: {
      good: nextTiers.good,
      better: nextTiers.better,
      best: nextTiers.best,
    },
  })
}
