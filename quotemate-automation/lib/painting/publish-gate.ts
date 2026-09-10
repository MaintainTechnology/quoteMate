// ════════════════════════════════════════════════════════════════════
// Painting — the tradie-release gate (mirrors lib/solar/publish.ts).
//
// ⚠ Since spec painting-auto-send (docs/strategy.md v21) NO origin drafts a
// held priced row any more: SMS/self-serve leads are released at save time
// like dashboard saves always were, so a priced quote shows immediately.
// These predicates are UNCHANGED and still load-bearing — an unreleased row
// (a legacy held draft, or one whose customer send failed and was rolled
// back) must still be withheld, which is exactly what they do.
//
// canShowPaintingPrices gates the /q/paint/[token] page; paintingRelease
// Eligibility makes the release idempotent (a second Send is a no-op).
// ⚠ paintingDepositLocked is now UNUSED BY /r/paint — since spec
// painting-site-visit-first the route's release gate is resolvePaintMintTier
// (lib/painting/pay-redirect.ts), which admits the $99 site visit on a
// released ∨ inspection-routed row and 302s a held one back to the quote
// page. The helper is kept for its remaining callers/tests.
//
// PURE — no I/O. Fully unit-testable.
// ════════════════════════════════════════════════════════════════════

export type PaintingPublishGateInput = {
  /** painting_measurements.released_at — null until the tradie sends. */
  releasedAt: string | null | undefined
}

export type PaintingPublishGateResult = {
  /** Whether the customer page may render tier prices + the pay CTA. */
  showPrices: boolean
  /** Customer-facing reason when withheld; null when prices show. */
  reason: string | null
}

/**
 * PURE — may /q/paint/[token] reveal prices + the payable $99 site visit?
 * Only once the tradie has released the quote. Until then the customer sees a
 * holding message, not a number.
 */
export function canShowPaintingPrices(input: PaintingPublishGateInput): PaintingPublishGateResult {
  if (!input.releasedAt) {
    return {
      showPrices: false,
      reason:
        'Your painting draft is saved and awaiting your painter’s review and approval. The prices have not been released yet.',
    }
  }
  return { showPrices: true, reason: null }
}

/**
 * PURE — is a per-tier deposit short-link locked? No customer surface mints a
 * tier deposit any more (spec painting-site-visit-first), so /r/paint no
 * longer consults this; the invariant it encodes — nothing resolves to Stripe
 * before the tradie releases — now lives in resolvePaintMintTier.
 */
export function paintingDepositLocked(releasedAt: string | null | undefined): boolean {
  return !releasedAt
}

export type PaintingReleaseEligibility =
  | { ok: true; stamp: boolean; send: boolean }
  | { ok: false; status: number; error: string }

/**
 * PURE — decide whether a "Send to customer" should stamp released_at and/or
 * text the customer. With auto-send live this drives the RESEND and the retry
 * of a failed auto-send, not a review gate.
 *   not released yet                     → stamp + send (the first release)
 *   released, never SENT                 → send WITHOUT restamping — the row is
 *     released but the customer has nothing. This is every dashboard save
 *     (app/api/painting/save releases at save time and texts no one) plus any
 *     row whose release predates quote_sent_at. Without this arm the primary
 *     button was a dead no-op on first press for the dominant population.
 *   already released AND sent            → no-op (idempotent; a double-click never re-texts)
 *   already released AND sent + resend   → send again WITHOUT restamping — the tradie
 *     explicitly asked to deliver the post-edit numbers (on-site revision flow)
 * Mirrors lib/solar/release.ts confirmEligibility (painting has no guardrail
 * flags, so there is no blocked case).
 */
export function paintingReleaseEligibility(input: {
  alreadyReleasedAt: string | null | undefined
  /** painting_measurements.quote_sent_at — evidence a carrier accepted the
   *  quote. Absent ⇒ the customer has never been texted, whatever released_at
   *  says, so a Send must actually send. */
  alreadySentAt?: string | null | undefined
  resend?: boolean
}): PaintingReleaseEligibility {
  if (input.alreadyReleasedAt) {
    return { ok: true, stamp: false, send: !input.alreadySentAt || !!input.resend }
  }
  return { ok: true, stamp: true, send: true }
}
