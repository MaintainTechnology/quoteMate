// POST /api/quote/[id]/issue-final — the step that unblocks a job stuck at
// "site visit paid" (spec post-visit-money-sequence R3).
//
// Before this route, an electrical/plumbing job was structurally TERMINAL
// once the customer paid the $99: the quotes row holds exactly one payment
// (`paid_at` is claimed conditionally and the webhook drops any later
// session), and every tradie mutation — edit, chat-edit, send — 409s on it.
// The only post-payment action was releasing the $99 to the tradie's bank.
//
// So the forward path is a NEW row, not a second payment on the old one: a
// 'final' child carrying the price the tradie confirmed on site, linked to
// the paid parent by parent_quote_id. The parent stays frozen and truthful
// (it records the $99 that was actually paid); the child is a normal
// editable draft that the tradie prices, sends, and collects a deposit on.
//
//   1. Auth via resolveTenantRequest → the tenant must own the parent.
//   2. Preconditions — the site visit is paid, the parent is an initial row,
//      and the tenant can actually be paid (Connect).
//   3. Resolve the deposit % for this job type from the tenant's pricing book.
//   4. Migration 214 locks the paid root and all child history, validates the
//      exact source/version/deposit snapshots, and creates at most one final
//      for the lifetime of the job. No provider calls or sends occur here.
//
// Response: { ok, share_token, quote_id, already } — the dashboard navigates
// to /dashboard/quote/<share_token>.

import { createClient } from '@supabase/supabase-js'
import { generateShareToken } from '@/lib/stripe/checkout'
import { connectDestinationForTenant, type TenantConnectState } from '@/lib/stripe/connect'
import { resolveDepositPct, totalIncGstCents } from '@/lib/quote/money'
import { asQuoteKind, isSiteVisitFirstTrade } from '@/lib/quote/mint-tier'
import { seedLineItems, type SeedableLineItem } from '@/lib/quote/tier-materialise'
import { pipelineLog } from '@/lib/log/pipeline'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { captureQuotePricingVersion, loadQuotePricingVersion, QuotePricingVersionError } from '@/lib/quote/pricing-version'
import { finiteQuoteNumber } from '@/lib/quote/numeric-input'
import { quoteEditRevision } from '@/lib/quote/edit-authority'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Tier = {
  label?: string | null
  subtotal_ex_gst?: number | string | null
  line_items?: SeedableLineItem[] | null
} | null

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const log = pipelineLog('dispatch')
  const { id: parentId } = await ctx.params
  let expectedRevision: string | undefined
  try {
    const raw = await req.text()
    const input: unknown = raw ? JSON.parse(raw) : {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid body')
    const expected = (input as Record<string, unknown>).expected_revision
    if (expected !== undefined) {
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid revision')
      expectedRevision = expected
    }
  } catch {
    return Response.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  }

  const resolved = await resolveTenantRequest(
    supabase,
    req,
    'id, stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_payouts_enabled',
  )
  if (!resolved) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const tenant = resolved.tenant as (TenantConnectState & { id: string }) | null

  const { data: parent, error: parentErr } = await supabase
    .from('quotes')
    .select('*')
    .eq('id', parentId)
    .maybeSingle()

  // Distinguish "no such quote" from "the read failed" — same reason the
  // pricing_book and intakes reads below check {error}: supabase-js resolves
  // on failure, so a bare read makes an outage look like a 404.
  if (parentErr) {
    log.err('parent quote read failed', parentErr.message, { parent_id: parentId })
    return Response.json({ ok: false, error: 'lookup_failed' }, { status: 500 })
  }
  if (!parent) return Response.json({ ok: false, error: 'no_quote' }, { status: 404 })

  // Legacy tenant-less rows can't be owned, priced against a pricing book, or
  // paid out — refuse rather than create an unreachable child.
  if (!parent.tenant_id) {
    return Response.json({ ok: false, error: 'parent_unscoped' }, { status: 409 })
  }
  if (!tenant || parent.tenant_id !== tenant.id) {
    return Response.json({ ok: false, error: 'not_owner' }, { status: 403 })
  }
  if (asQuoteKind(parent.quote_kind as string | null) !== 'initial' || parent.parent_quote_id) {
    return Response.json({ ok: false, error: 'not_initial' }, { status: 409 })
  }
  // The final quote exists to charge the balance of a job that has BEEN
  // visited. Without the paid site visit there is no $99 to credit and no
  // confirmed price to quote.
  if (!parent.paid_at || parent.paid_tier !== 'inspection') {
    return Response.json({ ok: false, error: 'site_visit_not_paid' }, { status: 409 })
  }
  // Unlike the $99 — which falls back to a platform-direct charge — a deposit
  // MUST be Connect-routed: a platform-direct child can never be released to
  // the tradie (payoutReleaseDecision → 'not_connect_routed'), so the money
  // would strand in QuoteMax's account. Refuse before creating the row.
  if (!connectDestinationForTenant(tenant)) {
    return Response.json({ ok: false, error: 'connect_required' }, { status: 409 })
  }

  // ─── Trade + job type drive the gate and the deposit % ───────────
  // supabase-js RESOLVES {data,error} on failure rather than throwing, so a
  // bare `const { data }` here would make a transient read error look
  // identical to "this intake has no trade" — and answer with a misleading
  // not_site_visit_first 409.
  const { data: intakeRow, error: intakeErr } = await supabase
    .from('intakes')
    .select('*')
    .eq('id', parent.intake_id)
    .eq('tenant_id', tenant.id)
    .maybeSingle()
  if (intakeErr) {
    log.err('intake read failed', intakeErr.message, { parent_id: parent.id })
    return Response.json({ ok: false, error: 'intake_unavailable' }, { status: 500 })
  }
  if (!intakeRow || intakeRow.tenant_id !== tenant.id || intakeRow.id !== parent.intake_id) {
    return Response.json({ ok: false, error: 'intake_ownership_review_required' }, { status: 409 })
  }
  if (expectedRevision !== undefined && expectedRevision !== quoteEditRevision(parent)) {
    return Response.json({ ok: false, error: 'quote_review_required' }, { status: 409 })
  }
  const trade = (intakeRow.trade as string | null) ?? null
  const jobType = (intakeRow?.job_type as string | null) ?? null

  // Only the site-visit-first trades have a post-visit step to unblock. The
  // other trades on this shared funnel still sell a deposit up front.
  if (!trade || !isSiteVisitFirstTrade(trade)) {
    return Response.json({ ok: false, error: 'not_site_visit_first' }, { status: 409 })
  }
  // An already-created child keeps its own immutable pricing basis even if
  // the mutable book has since changed or been removed.
  const prepare = async (child: Record<string, unknown> | null, depositVersionId: string | null) => {
    const { data, error } = await supabase.rpc('prepare_final_quote', {
      p_parent_id: parent.id, p_tenant_id: tenant.id, p_parent_snapshot: parent,
      p_intake_snapshot: intakeRow, p_child: child, p_deposit_version_id: depositVersionId,
    })
    if (error || !data) return { response: Response.json({ ok: false, error: 'final_prepare_unconfirmed' }, { status: 409 }) }
    if (data.status === 'final_already_paid') return { response: Response.json({ ok: false, error: 'final_already_paid' }, { status: 409 }) }
    if (data.status === 'needs_creation' && !child) return { response: null }
    const saved = data.quote
    if (data.status !== 'ready' || !saved?.id || !saved.share_token || saved.tenant_id !== tenant.id ||
      saved.parent_quote_id !== parent.id || saved.intake_id !== parent.intake_id || saved.quote_kind !== 'final' || saved.paid_at) {
      return { response: Response.json({ ok: false, error: 'final_prepare_unconfirmed' }, { status: 409 }) }
    }
    return { response: Response.json({ ok: true, already: data.already === true, quote_id: saved.id, parent_quote_id: parent.id,
      share_token: saved.share_token, deposit_pct: saved.deposit_pct }) }
  }
  const prior = await prepare(null, null)
  if (prior.response) return prior.response

  const selectedKey = (parent.selected_tier as 'good' | 'better' | 'best' | null) ?? null
  const source: Tier =
    (selectedKey ? (parent[selectedKey] as Tier) : null) ??
    (parent.better as Tier) ?? (parent.good as Tier) ?? (parent.best as Tier) ?? null
  const sourceSubtotal = source ? finiteQuoteNumber(source.subtotal_ex_gst) : 0
  if (sourceSubtotal === null || sourceSubtotal < 0 || !Number.isSafeInteger(Math.round(sourceSubtotal * 100)) ||
    sourceSubtotal !== Math.round(sourceSubtotal * 100) / 100 ||
    (source?.line_items != null && !Array.isArray(source.line_items))) {
    return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
  }
  let sourceHasPricedLine = sourceSubtotal > 0
  if (source?.line_items?.length) {
    let sum = 0
    for (const line of source.line_items) {
      const quantity = finiteQuoteNumber(line.quantity)
      const price = finiteQuoteNumber(line.unit_price_ex_gst)
      if (!line.description?.trim() || quantity === null || price === null || quantity < 0 || price < 0) {
        return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
      }
      if (line.total_ex_gst !== undefined) {
        const lineTotal = finiteQuoteNumber(line.total_ex_gst)
        if (lineTotal === null || lineTotal < 0 || lineTotal !== Math.round(quantity * price * 100) / 100) {
          return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
        }
      }
      sourceHasPricedLine ||= price > 0
      sum += Math.round(quantity * price * 100)
    }
    if (!Number.isSafeInteger(sum) || sum !== Math.round(sourceSubtotal * 100)) {
      return Response.json({ ok: false, error: 'quote_pricing_review_required' }, { status: 409 })
    }
  }

  // ─── Deposit % for this job type (spec R2) ───────────────────────
  // Read the tenant's book for THIS trade only — no any-row fallback: on a
  // multi-trade tenant that would silently price an electrical job off the
  // plumbing (or roofing) book's map.
  //
  // The `error` check is load-bearing, not hygiene: this row decides the
  // deposit PERCENTAGE that gets stamped on the child and charged for real.
  // A swallowed read error would leave overlays null, resolveDepositPct would
  // return the platform default 30, and an EV charger job configured at 50%
  // would quietly collect a deposit short by 20% of the job — with nothing
  // downstream able to tell it apart from a correctly-resolved 30%. Refuse
  // instead: the tradie can retry, and a retry costs nothing.
  const { data: book, error: bookErr } = await supabase
    .from('pricing_book')
    .select('*')
    .eq('tenant_id', parent.tenant_id)
    .eq('trade', trade)
    .maybeSingle()
  if (bookErr) {
    log.err('pricing_book read failed', bookErr.message, {
      parent_id: parent.id,
      trade,
    })
    return Response.json({ ok: false, error: 'pricing_book_unavailable' }, { status: 500 })
  }
  let pricingVersion
  let depositVersion
  try {
    // Deposit policy remains the current owned policy, persisted separately on
    // the child. Copied line prices retain the parent's historical book.
    if (sourceHasPricedLine) {
      pricingVersion = await loadQuotePricingVersion(supabase, parent, trade)
      if (!pricingVersion) throw new QuotePricingVersionError('quote_pricing_review_required')
    }
    depositVersion = await captureQuotePricingVersion(supabase, book ?? {}, tenant.id, trade)
    pricingVersion ??= depositVersion
  }
  catch (error) {
    return Response.json({ ok: false, error: error instanceof QuotePricingVersionError ? error.code : 'pricing_unavailable' },
      { status: error instanceof QuotePricingVersionError ? error.status : 503 })
  }
  const overlays = (depositVersion.snapshot.overlays as Record<string, unknown> | null) ?? null
  const gstRegistered = pricingVersion.snapshot.gst_registered as boolean
  const depositPct = resolveDepositPct(overlays?.deposit_pct_by_job_type, jobType)

  // ─── The child's price ───────────────────────────────────────────
  // Start from whatever the parent actually quoted. An inspection-routed
  // parent has NULL tiers by design (an Opus-drafted inspection quote may
  // not ship fabricated prices) — which is the COMMON electrical case — so
  // seed a single whole-of-job line at $0 for the tradie to price on site.
  const seeded = source ? seedLineItems({ ...source, subtotal_ex_gst: sourceSubtotal }) : []
  const good = {
    label: source?.label?.trim() || 'Final quote',
    subtotal_ex_gst: sourceSubtotal,
    line_items:
      seeded.length > 0
        ? seeded
        : [
            {
              description: 'Job as quoted — confirmed on site',
              quantity: 1,
              unit: 'job',
              unit_price_ex_gst: 0,
              total_ex_gst: 0,
            },
          ],
  }

  const totalIncGst = totalIncGstCents(sourceSubtotal, { gstRegistered }) / 100
  const gst = +(totalIncGst - sourceSubtotal).toFixed(2)

  const shareToken = generateShareToken()
  const childRow = {
    // Copied from the parent — same job, same customer, same scope.
    intake_id: parent.intake_id,
    tenant_id: parent.tenant_id,
    pricing_book_version_id: pricingVersion.id,
    scope_of_works: parent.scope_of_works,
    scope_short: parent.scope_short ?? null,
    assumptions: parent.assumptions ?? [],
    risk_flags: parent.risk_flags ?? [],
    estimated_timeframe: parent.estimated_timeframe,
    gst_note: parent.gst_note,
    display_mode: parent.display_mode ?? null,
    optional_upsells: parent.optional_upsells ?? [],

    // The chain.
    quote_kind: 'final',
    parent_quote_id: parent.id,
    share_token: shareToken,
    deposit_pct: depositPct,

    // A normal editable draft — NOT inspection-routed, or the editor 409s
    // (`cannot_edit_inspection_quote`) and the PDF refuses to render.
    status: 'draft',
    needs_inspection: false,
    inspection_reason: null,
    // One confirmed price, in the `good` slot. 'good' (not the DB default
    // 'better') so the single populated tier is the selected one everywhere.
    selected_tier: 'good',
    good,
    better: null,
    best: null,
    subtotal_ex_gst: sourceSubtotal,
    gst,
    total_inc_gst: totalIncGst,

    // Deliberately NOT copied — each would misrepresent the child:
    //   paid_*/stripe_links/pdf_*/sent_at → this row has transacted nothing;
    //   booking_state/scheduled_* → the visit is behind us;
    //   early_bird_*/applied_discount_pct → an inherited live offer would let
    //     resolveMintDiscount silently discount the deposit;
    //   price_hold_until → a final quote is not a 7-day estimate, and the
    //     mint skips the hold gate for children anyway.
    stripe_links: {},
    price_hold_until: null,
  }

  const result = await prepare(childRow, depositVersion.id)
  return result.response ?? Response.json({ ok: false, error: 'final_prepare_unconfirmed' }, { status: 409 })
}
