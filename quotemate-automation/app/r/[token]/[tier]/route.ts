// Short-link redirector — keeps the SMS body small.
// SMS contains: https://<domain>/r/<token>/<tier>  (~ 60 chars)
//
// Funnel order (lib/quote/booking.ts payRedirectTarget). This is the
// choke-point every generic pay link flows through — the on-page tier
// buttons AND the pay links already sitting in customers' SMS threads —
// so the order enforced here holds everywhere:
//
//   electrical/plumbing G/B/B     → /r/<token>/inspection (2026-08-06: those
//                                   two trades sell only the $99 site visit —
//                                   spec elec-plumb-site-visit-first R1)
//   price hold expired            → /q/<token>       (blocked: refresh needed)
//   already paid                  → /q/<token>/paid  (never re-charge)
//   tenant has NO bookable windows → /q/<token>?slots=0 (never charge into an
//                                   empty calendar — see rule 3)
//   otherwise, not paid           → Stripe Checkout  (PAY-FIRST on every
//                                   funnel since 2026-07-22: pay → pick a time
//                                   → thank-you)
//
// Three hardening rules live here (1 and 2 surfaced 2026-07-01):
//
//   1. EXPIRY GATE. An expired price hold must not lead into booking or
//      checkout — the customer is bounced back to the quote page, which
//      shows the "price expired, reply for a refreshed quote" state.
//      Inspection ($99 fee) has no price hold; an already-paid quote is
//      past this concern — both skip the gate.
//
//   2. FRESH SESSION ON DEMAND. Stripe Checkout Sessions expire after 24h
//      (Stripe's max), far shorter than the 7-day price hold. The Session
//      pre-baked at draft time is therefore usually DEAD by the time a
//      customer clicks (Stripe shows "You're all done here / timed out").
//      So on the stripe path we MINT A FRESH Session per click instead of
//      redirecting to the stored, stale URL. The realised early-booking
//      discount (if any) is re-applied so the price is correct.
//
//   3. NO-SLOTS GUARD (2026-07-22). Pay-first means the customer commits
//      BEFORE seeing any times. If the tenant has published no bookable
//      windows, charging them sells a visit nobody can schedule — so we
//      refuse and send them back to the quote with ?slots=0, which renders
//      "we'll text you to arrange a time" and takes no money. This also
//      closes the old redirect loop: under book-first this case returned
//      kind:'book' → /q/<token>/book, whose no-slots CTA pointed straight
//      back at /r, so the customer could never reach checkout at all.

import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { canTakePayment, payRedirectTarget } from '@/lib/quote/booking'
import { isPriceHoldExpired } from '@/lib/quote/hold'
import { resolveBookingOptions, buildBookedKeys } from '@/lib/quote/slots'
import { tzForState } from '@/lib/quote/availability'
import { resolveMintDiscount } from '@/lib/quote/early-bird'
import {
  CHILD_TIER_FOR_KIND,
  asQuoteKind,
  resolveGenericMintTier,
} from '@/lib/quote/mint-tier'
import {
  INSPECTION_FEE_AUD_CENTS,
} from '@/lib/quote/money'
import { pipelineLog } from '@/lib/log/pipeline'
import {
  createBalanceCheckoutSession,
  createCheckoutSessionForTier,
  createFinalDepositCheckoutSession,
  createInspectionCheckoutSession,
} from '@/lib/stripe/checkout'
import { connectDestinationForTenantId } from '@/lib/stripe/connect'
import { MINT_QUOTE_FIELDS, saveMintState, persistMintedCheckout, type MintQuote } from '@/lib/quote/mint-authority'
import { loadQuotePricingVersion, versionedQuoteGst } from '@/lib/quote/pricing-version'
import { validOwnedQuoteBook } from '@/lib/quote/edit-authority'
import { genericQuoteReleased } from '@/lib/quote/customer-release'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'
import { loadChildQuoteMoney, QuoteChainMoneyError } from '@/lib/quote/chain-money'

// A single Stripe Session create runs on the stripe path — give it headroom
// over the fast-redirect default so a cold start can't time out mid-mint.
export const maxDuration = 30

// Lazy Supabase client — created on first use, NOT at import, so the pure
// helpers (resolvePayRedirect / VALID_TIERS) can be unit-tested without any
// env vars set. Mirrors app/r/solar/[token]/[tier]/route.ts. The tiny
// makeClient() wrapper preserves the inferred (any-row) client type —
// annotating with ReturnType<typeof createClient> resolves rows to `never`.
function makeClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}
let _supabase: ReturnType<typeof makeClient> | null = null
function db() {
  if (!_supabase) _supabase = makeClient()
  return _supabase
}

// 'deposit'/'balance' are the post-site-visit child literals (spec
// post-visit-money-sequence R7). They are deliberately NOT reused tier names:
// paid_tier, the Payouts label and the webhook's metadata all read this value,
// so a child charge that said 'good' would be indistinguishable from a real
// tier deposit everywhere downstream.
export const VALID_TIERS = new Set(['good', 'better', 'best', 'inspection', 'deposit', 'balance'])

export type PayRedirectDecision =
  /** Price hold lapsed — bounce to the quote page (shows the expired state). */
  | { kind: 'expired'; url: string }
  /** Already paid — thank-you page. */
  | { kind: 'paid'; url: string }
  /** Tenant has no bookable windows — back to the quote, uncharged. */
  | { kind: 'no-slots'; url: string }
  /** Payment is the next step — caller mints a FRESH Session (no static URL). */
  | { kind: 'stripe' }

/**
 * Pure redirect decision for /r/<token>/<tier> — kept side-effect-free so
 * the funnel order (and the new expiry gate) can be unit-tested without a
 * DB or Stripe. The 'stripe' kind carries no URL: the impure GET handler
 * mints a live Session for it (the stored link is usually expired).
 */
export function resolvePayRedirect(input: {
  tier: string
  paid: boolean
  scheduledAt: string | null | undefined
  /** isPriceHoldExpired(price_hold_until, created_at) computed by the caller. */
  expired: boolean
  token: string
  appUrl: string
  /** How many bookable windows the tenant currently has, resolved by the
   *  caller with resolveBookingOptions — the SAME resolver the booking page
   *  renders from, so this answer and the calendar can never disagree. */
  bookableCount: number
  /** quotes.quote_kind (spec post-visit-money-sequence R7). A 'final' or
   *  'balance' child skips BOTH of the gates below, and for opposite reasons
   *  to each other:
   *    • the PRICE HOLD is an initial-quote concept (a 7-day freshness window
   *      on an unaccepted estimate). A child carries no hold, but
   *      isPriceHoldExpired derives one from created_at when the column is
   *      null, so leaving the gate on would silently kill a deposit link 7
   *      days after the final quote went out;
   *    • the NO-SLOTS guard exists because pay-first means committing before
   *      seeing any times. The site visit already happened — there is nothing
   *      left to book — so refusing a deposit because the tenant's calendar is
   *      empty would block money for a job already underway.
   *  The 'paid' check is NOT skipped: never re-charge, on any row. */
  quoteKind?: string | null | undefined
}): PayRedirectDecision {
  const { tier, paid, scheduledAt, expired, token, appUrl, bookableCount } = input
  const isChild = input.quoteKind === 'final' || input.quoteKind === 'balance'

  // Expiry gate — priced tiers only. Inspection has no price hold, and an
  // already-paid quote has transacted, so neither is blocked.
  if (!isChild && tier !== 'inspection' && !paid && expired) {
    return { kind: 'expired', url: `${appUrl}/q/${token}` }
  }

  const target = payRedirectTarget({ paid, scheduledAt, tier })
  if (target === 'paid') {
    return { kind: 'paid', url: `${appUrl}/q/${token}/paid?tier=${tier}&already=1` }
  }

  // About to charge — refuse if there is nothing to book afterwards. Checked
  // AFTER 'paid' so an already-paid customer is never bounced: they are not
  // being charged again, and their booking page handles the empty case itself.
  if (!isChild && !canTakePayment({ bookableCount })) {
    return { kind: 'no-slots', url: `${appUrl}/q/${token}?slots=0` }
  }

  return { kind: 'stripe' }
}

/**
 * Mint a fresh deposit Checkout Session for this quote+tier and persist the
 * URL back onto quotes.stripe_links (so the /paid page and any re-click stay
 * consistent). Returns a URL only after the unchanged owned row acknowledges it.
 */
async function mintFreshDepositUrl(
  quote: {
    id: string
    intake_id: string | null
    tenant_id: string | null
    good: unknown
    better: unknown
    best: unknown
    stripe_links: Record<string, string> | null
    /** Per-quote deposit % (quotes.deposit_pct, DB default 30). */
    deposit_pct: number | null
  },
  tier: string,
  token: string,
  authority: MintQuote,
): Promise<string | null> {
  const appUrl = process.env.APP_URL!
  let expected = authority
  try {
    // Connect routing (2% platform fee, destination = the tenant's live
    // connected account) — same decision the draft-time Session used.
    const connect = await connectDestinationForTenantId(db(), quote.tenant_id)

    const { data: intakeRow, error: intakeError } = await db()
      .from('intakes')
      .select('job_type, scope, caller, trade')
      .eq('id', quote.intake_id)
      .eq('tenant_id', quote.tenant_id!)
      .maybeSingle()
    if (intakeError || !intakeRow) return null
    if (resolveGenericMintTier(tier, typeof intakeRow.trade === 'string' ? intakeRow.trade : null, 'initial').kind !== 'passthrough') return null
    const intake = {
      job_type: (intakeRow?.job_type as string) ?? 'other',
      scope: (intakeRow?.scope as { item_count?: number; description?: string } | null) ?? null,
      caller: (intakeRow?.caller as { name?: string; email?: string } | null) ?? null,
    }

    let url: string | null = null
    if (tier === 'inspection') {
      url = await createInspectionCheckoutSession({
        quoteId: quote.id,
        intake,
        shareToken: token,
        appUrl,
        connect,
      })
    } else {
      const trade = typeof intakeRow.trade === 'string' ? intakeRow.trade : null
      if (!trade || !quote.tenant_id || typeof quote.deposit_pct !== 'number' || !Number.isFinite(quote.deposit_pct) ||
          quote.deposit_pct < 1 || quote.deposit_pct > 90) return null
      const version = await loadQuotePricingVersion(db(), authority, trade)
      if (!version) {
        const { data: book, error } = await db().from('pricing_book').select('id,tenant_id,trade,gst_registered')
          .eq('tenant_id', quote.tenant_id).eq('trade', trade).maybeSingle()
        if (error || !validOwnedQuoteBook(book, quote.tenant_id, trade)) return null
      }
      const gstRegistered = versionedQuoteGst(authority, version)
      if (gstRegistered === null) return null
      // REALISE the early-booking discount here — this mint is the money
      // choke-point under pay-first. (It used to be realised in the book API
      // when the customer committed a time, but that ran only for unpaid
      // quotes; pay-first means they are always paid by then, so leaving it
      // there would have killed the discount for everyone.)
      //
      const decision = resolveMintDiscount({
          appliedPct: Number(expected.applied_discount_pct ?? 0),
          offerPct: (expected.early_bird_discount_pct as number | null) ?? null,
          expiresAt: (expected.early_bird_expires_at as string | null) ?? null,
          tier,
        })
      const discountPct = decision.pct
      if (decision.stamp) {
        const saved = await saveMintState(db(), expected, {
          applied_discount_pct: decision.pct, applied_discount_at: new Date().toISOString(),
        })
        if (!saved || saved.applied_discount_pct !== decision.pct) return null
        expected = saved
      }

      type CheckoutOpts = Parameters<typeof createCheckoutSessionForTier>[0]
      url = await createCheckoutSessionForTier({
        quote: {
          id: quote.id,
          good: quote.good ?? null,
          better: quote.better ?? null,
          best: quote.best ?? null,
          // Honour the per-quote deposit % (quotes.deposit_pct, stamped
          // from the tenant rate card at draft time; DB default 30). The
          // column was previously ignored here — a hardcoded 30 — so a
          // tenant deposit change never reached the charge.
          deposit_pct: quote.deposit_pct,
          gst_registered: gstRegistered,
        } as unknown as CheckoutOpts['quote'],
        tierKey: tier as 'good' | 'better' | 'best',
        intake: intake as unknown as CheckoutOpts['intake'],
        shareToken: token,
        appUrl,
        discountPct,
        connect,
      })
    }

    return url && await persistMintedCheckout(db(), expected, tier, url) ? url : null
  } catch (e: unknown) {
    pipelineLog('dispatch').err(
      'fresh deposit Session mint unavailable',
      e instanceof Error ? e.message : String(e),
      { quote_id: quote.id, tier },
    )
    return null
  }
}

/**
 * Mint the Checkout Session for a post-site-visit child row (spec
 * post-visit-money-sequence R7) and persist it under its own tier key.
 *
 * Everything the charge needs is read from the row's STORED
 * `total_inc_gst` + `deposit_pct` rather than recomputed from the tier
 * subtotal and a live `gst_registered` lookup the way the initial mint does.
 * That matters because the deposit and the balance are minted at different
 * times: recomputing would let `T` shift between the two clicks (a
 * gst_registered flip, an edited subtotal) and the three charges would stop
 * adding up to the total the customer accepted.
 */
async function mintChildChargeUrl(
  quote: {
    id: string
    intake_id: string | null
    tenant_id: string | null
    parent_quote_id: string | null
    total_inc_gst: number | string | null
    deposit_pct: number | null
    stripe_links: Record<string, string> | null
  },
  kind: 'final' | 'balance',
  token: string,
  authority: MintQuote,
): Promise<{ url: string | null; reason?: 'no_connect' | 'invalid_chain' | 'chain_unavailable' | 'error' }> {
  const appUrl = process.env.APP_URL!
  try {
    // A child charge MUST route through Connect. Unlike the $99 — which falls
    // back to a platform-direct charge — a platform-direct deposit can never
    // be released to the tradie (payoutReleaseDecision → 'not_connect_routed'),
    // so the money would strand in QuoteMax's account. Refuse instead.
    const connect = await connectDestinationForTenantId(db(), quote.tenant_id)
    if (!connect) return { url: null, reason: 'no_connect' }

    const { data: intakeRow, error: intakeError } = await db()
      .from('intakes')
      .select('job_type, caller, trade')
      .eq('id', quote.intake_id)
      .eq('tenant_id', quote.tenant_id!)
      .maybeSingle()
    if (intakeError) throw new QuoteChainMoneyError(503)
    if (!intakeRow) throw new QuoteChainMoneyError(409)
    const jobLabel = ((intakeRow?.job_type as string) ?? 'job').replace(/_/g, ' ')
    const email = (intakeRow?.caller as { email?: string } | null)?.email ?? null

    const proof = await loadChildQuoteMoney(db(), authority, typeof intakeRow.trade === 'string' ? intakeRow.trade : null)
    const readiness = await readQuoteDraftReadiness(db(), {
      id: quote.id, tenant_id: quote.tenant_id, intake_id: quote.intake_id, quote_kind: kind,
    })
    if (!readiness.ready) throw new QuoteChainMoneyError(readiness.code === 'quote_draft_processing' ? 409 : 503)
    const totalCents = kind === 'balance' ? proof.money.current_payment_base_cents! : proof.finalTotal!
    const depositPct = proof.depositPercent!
    // The two child kinds store DIFFERENT things in total_inc_gst, and
    // conflating them undercharges the tradie by half the job:
    //   • a FINAL row holds the whole job total, so the deposit is derived
    //     from it — pct% less the $99 already paid;
    //   • a BALANCE row holds the balance ITSELF (request-final-payment
    //     computed it once, from the final row, and stamped it). Running the
    //     balance formula over it again would deduct the $99 credit and a
    //     second deposit from an amount that already has both taken out.
    const base = proof.money.current_payment_base_cents!

    const fee = proof.money.platform_fee_cents!
    const shared = {
      quoteId: quote.id,
      shareToken: token,
      baseCents: base,
      surchargeCents: fee,
      jobLabel,
      customerEmail: email,
      appUrl,
      connect,
      audit: {
        quoteKind: kind,
        parentQuoteId: quote.parent_quote_id,
        totalIncGstCents: totalCents,
        depositPct,
      },
    }
    const url =
      kind === 'final'
        ? await createFinalDepositCheckoutSession({
            ...shared,
            creditCents: INSPECTION_FEE_AUD_CENTS,
          })
        : await createBalanceCheckoutSession(shared)

    return { url: url && await persistMintedCheckout(db(), authority, CHILD_TIER_FOR_KIND[kind], url) ? url : null }
  } catch (e: unknown) {
    if (e instanceof QuoteChainMoneyError) return { url: null, reason: e.status === 503 ? 'chain_unavailable' : 'invalid_chain' }
    pipelineLog('dispatch').err(
      'child charge Session mint failed',
      e instanceof Error ? e.message : String(e),
      { quote_id: quote.id, kind },
    )
    return { url: null, reason: 'error' }
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string; tier: string }> }) {
  const { token, tier } = await ctx.params
  if (!VALID_TIERS.has(tier)) {
    return new Response('Invalid tier', { status: 400 })
  }

  const { data: quote, error: readError } = await db()
    .from('quotes')
    .select(MINT_QUOTE_FIELDS.join(','))
    .eq('share_token', token)
    .single<MintQuote>()

  if (readError) return new Response('Payment unavailable', { status: 503 })
  if (!quote) return new Response('Not found', { status: 404 })
  if (!genericQuoteReleased(quote)) return Response.redirect(new URL(`/q/${token}?pay=unavailable`, req.url), 302)
  if (quote.quote_kind != null && !['initial', 'final', 'balance'].includes(String(quote.quote_kind))) {
    return Response.redirect(new URL(`/q/${token}?pay=unavailable`, req.url), 302)
  }
  if (!quote.paid_at && (quote.quote_kind == null || quote.quote_kind === 'initial')) {
    const readiness = await readQuoteDraftReadiness(db(), {
      id: quote.id, tenant_id: quote.tenant_id, intake_id: typeof quote.intake_id === 'string' ? quote.intake_id : null,
      quote_kind: quote.quote_kind,
    })
    if (!readiness.ready) return Response.redirect(new URL(`/q/${token}?pay=unavailable`, req.url), 302)
  }

  const quoteKind = asQuoteKind(quote.quote_kind as string | null)

  // ── Post-site-visit child rows (spec post-visit-money-sequence R7) ──
  // A child charges exactly one literal ('deposit' on a final row, 'balance'
  // on a balance row). Every other tier — a stale G/B/B link from the parent's
  // SMS thread, and above all 'inspection' — mints NOTHING and bounces to the
  // quote page. That last case is the load-bearing one: 'inspection' is
  // passthrough for every row today, so without this refusal a click would
  // mint a live second $99, claim the child's single paid_at slot with
  // paid_tier='inspection', and permanently block the deposit.
  if (quoteKind !== 'initial') {
    const childGate = resolveGenericMintTier(tier, null, quoteKind)
    if (childGate.kind !== 'passthrough') {
      return Response.redirect(new URL(`/q/${token}`, req.url), 302)
    }

    // Never re-charge a paid child — the same rule every other row follows.
    const childDecision = resolvePayRedirect({
      tier,
      paid: !!quote.paid_at,
      scheduledAt: null,
      expired: false,
      token,
      appUrl: process.env.APP_URL!,
      bookableCount: 1,
      quoteKind,
    })
    if (childDecision.kind !== 'stripe') {
      return Response.redirect(childDecision.url, 302)
    }

    const minted = await mintChildChargeUrl(
      {
        id: quote.id as string,
        intake_id: (quote.intake_id as string | null) ?? null,
        tenant_id: (quote.tenant_id as string | null) ?? null,
        parent_quote_id: (quote.parent_quote_id as string | null) ?? null,
        total_inc_gst: (quote.total_inc_gst as number | string | null) ?? null,
        deposit_pct: (quote.deposit_pct as number | null) ?? null,
        stripe_links: (quote.stripe_links as Record<string, string> | null) ?? null,
      },
      quoteKind,
      token,
      quote,
    )
    if (minted.url) return Response.redirect(minted.url, 302)
    if (minted.reason === 'chain_unavailable' || minted.reason === 'invalid_chain') {
      return Response.json({ ok: false, error: minted.reason === 'chain_unavailable' ? 'quote_chain_unavailable' : 'quote_chain_not_payable' },
        { status: minted.reason === 'chain_unavailable' ? 503 : 409 })
    }
    // No silent fallback to a stored link here: a child's amounts are
    // computed per click, so a stale Session could charge the wrong money.
    // Bounce to the quote page with a reason the page can render.
    const q = minted.reason === 'no_connect' ? '?connect=0' : '?pay=unavailable'
    return Response.redirect(new URL(`/q/${token}${q}`, req.url), 302)
  }

  // ── $99-site-visit gate (spec elec-plumb-site-visit-first R1, 2026-08-06) ──
  // Electrical and plumbing sell ONE customer payment: the flat $99 refundable
  // site inspection. Their G/B/B links — including the ones already sitting in
  // customers' SMS threads — 302 onto the inspection mint here rather than 400,
  // so no previously-sent link dies. This runs BEFORE resolvePayRedirect on
  // purpose: that resolver's price-hold gate would otherwise bounce a lapsed
  // elec/plumb link to a dead end, when the $99 it now redirects to has no hold.
  //
  // ⚠ ALLOWLIST ONLY. This route is shared by five trades — solar,
  // commercial_painting and the roofing rows on `quotes` still mint real G/B/B
  // deposits below. A trade we can't resolve (tenant-less/legacy row, missing
  // intake) FAILS OPEN to today's behaviour: it is not provably elec/plumb.
  // Only a priced tier can be redirected, so 'inspection' skips the lookup.
  if (tier !== 'inspection' && quote.intake_id) {
    const { data: tradeRow, error: tradeError } = await db()
      .from('intakes')
      .select('trade')
      .eq('id', quote.intake_id)
      .eq('tenant_id', quote.tenant_id!)
      .maybeSingle()
    if (tradeError || !tradeRow || typeof tradeRow.trade !== 'string') {
      return Response.redirect(new URL(`/q/${token}?pay=unavailable`, req.url), 302)
    }
    const gate = resolveGenericMintTier(tier, (tradeRow?.trade as string | null) ?? null, quoteKind)
    if (gate.kind === 'redirect_to_inspection') {
      // Same-app hop, so base it on the REQUEST rather than APP_URL: the two
      // provisioned Twilio webhook hosts both serve this app, and an unset
      // APP_URL would otherwise produce "undefined/r/…" and break the link.
      return Response.redirect(new URL(`/r/${token}/inspection`, req.url), 302)
    }
  }

  // Inspection-required quotes are EXEMPT from the price-hold gate — their
  // tier prices are indicative (final price confirmed on-site) and the /q
  // page already exempts them (priceExpired requires !isInspection), so
  // gating here would silently bounce their CTAs back to a banner-less page.
  const expired =
    !quote.needs_inspection &&
    isPriceHoldExpired(
      quote.price_hold_until as string | null,
      quote.created_at as string | null,
    )

  // How many windows the customer will actually be able to choose from after
  // paying. Derived with resolveBookingOptions — the SAME resolver the booking
  // page renders from — so the guard and the calendar can never disagree.
  // Best-effort: a lookup failure must not block a legitimate payment, so an
  // unknown count is treated as "slots exist" and the customer proceeds.
  let bookableCount = 1
  if (quote.tenant_id) {
    try {
      const { data: tenantRow } = await db()
        .from('tenants')
        .select('available_slots, default_availability, state')
        .eq('id', quote.tenant_id)
        .maybeSingle()
      if (tenantRow) {
        const tz = tzForState((tenantRow as { state?: string | null }).state ?? null)
        const { data: bookedRows } = await db()
          .from('quotes')
          .select('scheduled_at, scheduled_window')
          .eq('tenant_id', quote.tenant_id)
          .in('booking_state', ['reserved', 'booked'])
          .not('scheduled_at', 'is', null)
          .neq('id', quote.id)
        bookableCount = resolveBookingOptions({
          availability:
            (tenantRow as { default_availability?: unknown }).default_availability ?? null,
          availableSlots: (tenantRow as { available_slots?: unknown }).available_slots,
          timezone: tz,
          bookedKeys: buildBookedKeys(bookedRows ?? [], tz),
        }).length
      }
    } catch (e: unknown) {
      pipelineLog('dispatch').err(
        'slot count lookup failed — allowing payment through',
        e instanceof Error ? e.message : String(e),
        { quote_id: quote.id },
      )
    }
  }

  const decision = resolvePayRedirect({
    tier,
    paid: !!quote.paid_at,
    scheduledAt: (quote.scheduled_at as string | null) ?? null,
    expired,
    token,
    appUrl: process.env.APP_URL!,
    bookableCount,
    quoteKind,
  })

  if (decision.kind !== 'stripe') {
    return Response.redirect(decision.url, 302)
  }

  // Deposit is the last step — mint a live Session (the stored one is
  // almost always past Stripe's 24h expiry by now).
  const fresh = await mintFreshDepositUrl(
    {
      id: quote.id as string,
      intake_id: (quote.intake_id as string | null) ?? null,
      tenant_id: (quote.tenant_id as string | null) ?? null,
      deposit_pct: (quote.deposit_pct as number | null) ?? null,
      good: quote.good,
      better: quote.better,
      best: quote.best,
      stripe_links: (quote.stripe_links as Record<string, string> | null) ?? null,
    },
    tier,
    token,
    quote,
  )
  if (fresh) return Response.redirect(fresh, 302)

  return Response.redirect(new URL(`/q/${token}?pay=unavailable`, req.url), 302)
}
