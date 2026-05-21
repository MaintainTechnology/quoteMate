// v8 Phase A — early-booking discount.
//
// Pure, dependency-free helpers (unit-tested in early-bird.test.ts). No
// DB, no Stripe, no Next runtime — safe to import from server
// components, API routes, SMS templates, and tests alike. This is the
// single source of truth for "is there a live early-bird offer on this
// quote" and "what does the discounted price come to", so the quote
// page, the booking page, the book API, the Stripe re-issue path, and
// the tradie notification all agree.
//
// The model (see docs/strategy.md v8):
//   • A tenant CONFIGURES an offer in pricing_book.overlays.early_bird
//     — { enabled, discount_pct, window_hours }.
//   • Every quote is STAMPED at draft time with the resolved offer:
//     quotes.early_bird_discount_pct + quotes.early_bird_expires_at.
//   • The customer EARNS the discount by committing a booking time
//     before the deadline; the book API then stamps
//     quotes.applied_discount_pct.
//   • Display + Stripe read applied_discount_pct ONLY.
//
// Grounding: the discount is a quote-LEVEL adjustment. It never touches
// good/better/best line items — lib/estimate/validate.ts is unaffected.

// ── Constants ───────────────────────────────────────────────────────

/**
 * Hard platform ceiling on the discount. Plumbing pricing books run
 * 15–20% markup (see memory project_plumbing_routing_rules); a discount
 * above this could sell a job below cost. Every entry point clamps to
 * this — a misconfigured overlay can never exceed it. Mirrored as a
 * Postgres CHECK constraint in migration 044 for defence in depth.
 */
export const MAX_EARLY_BIRD_DISCOUNT_PCT = 15

/** Offer window used when the overlay omits / fudges `window_hours`. */
export const DEFAULT_EARLY_BIRD_WINDOW_HOURS = 24

/** Upper bound on the configurable window — 14 days. Stops a typo
 *  ("24000") turning a same-day nudge into a permanent discount. */
export const MAX_EARLY_BIRD_WINDOW_HOURS = 24 * 14

const HOUR_MS = 60 * 60 * 1000

// ── Types ───────────────────────────────────────────────────────────

/** Resolved, validated, clamped offer configuration for one tenant. */
export interface EarlyBirdConfig {
  /** False whenever the offer must not apply — disabled, or the config
   *  was garbage, or the discount clamped to 0. Callers can branch on
   *  this single flag and ignore the rest. */
  enabled: boolean
  /** Discount %, clamped to [0, MAX_EARLY_BIRD_DISCOUNT_PCT]. */
  discountPct: number
  /** Offer window in hours, clamped to (0, MAX_EARLY_BIRD_WINDOW_HOURS]. */
  windowHours: number
}

/** A concrete offer stamped onto one quote. */
export interface EarlyBirdOffer {
  /** Discount % the customer can still earn (clamped). */
  discountPct: number
  /** ISO deadline — the offer is live only while now < this. */
  expiresAt: string
}

export type EarlyBirdState =
  /** No offer on this quote (none configured, or discount is 0). */
  | 'none'
  /** Offer configured and the deadline is still in the future. */
  | 'live'
  /** Offer configured but the deadline has passed. */
  | 'expired'

export interface EarlyBirdStatus {
  state: EarlyBirdState
  /** Discount % — 0 unless state is 'live'. */
  discountPct: number
  /** ms until the deadline. Negative once expired, 0 when state 'none'. */
  msRemaining: number
  /** Whole hours remaining, floored, never negative. */
  hoursRemaining: number
  /** The resolved deadline ISO, or null when state === 'none'. */
  expiresAt: string | null
}

/** The disabled config — returned for any garbage / opted-out input. */
const DISABLED: EarlyBirdConfig = {
  enabled: false,
  discountPct: 0,
  windowHours: DEFAULT_EARLY_BIRD_WINDOW_HOURS,
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Coerce an unknown to a finite number, or null. Accepts numeric
 *  strings (overlays jsonb can carry "10" if hand-edited). */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Clamp a discount % into [0, MAX]. NaN / null → 0. */
export function clampDiscountPct(v: unknown): number {
  const n = toFiniteNumber(v)
  if (n === null || n <= 0) return 0
  return Math.min(n, MAX_EARLY_BIRD_DISCOUNT_PCT)
}

// ── Config resolution ───────────────────────────────────────────────

/**
 * Parse + validate a raw `early_bird` config object (the value of the
 * `early_bird` key inside pricing_book.overlays). Anything missing,
 * malformed, disabled, or clamping to a 0 discount yields the DISABLED
 * config — callers only ever have to check `.enabled`.
 */
export function parseEarlyBirdConfig(raw: unknown): EarlyBirdConfig {
  if (!raw || typeof raw !== 'object') return DISABLED
  const o = raw as Record<string, unknown>

  // `enabled` must be explicitly true. Absent / falsey → off, so an
  // overlay that carries a discount_pct but no enabled flag stays dark
  // until the tradie deliberately turns it on.
  if (o.enabled !== true) return DISABLED

  const discountPct = clampDiscountPct(o.discount_pct)
  if (discountPct <= 0) return DISABLED

  const rawWindow = toFiniteNumber(o.window_hours)
  const windowHours =
    rawWindow === null || rawWindow <= 0
      ? DEFAULT_EARLY_BIRD_WINDOW_HOURS
      : Math.min(rawWindow, MAX_EARLY_BIRD_WINDOW_HOURS)

  return { enabled: true, discountPct, windowHours }
}

/**
 * Pull the early-bird config out of a pricing_book row's `overlays`
 * jsonb. Convenience over parseEarlyBirdConfig for the common call
 * site (the estimate/draft route reads the whole pricing_book row).
 */
export function earlyBirdConfigFromOverlays(
  overlays: unknown,
): EarlyBirdConfig {
  if (!overlays || typeof overlays !== 'object') return DISABLED
  return parseEarlyBirdConfig((overlays as Record<string, unknown>).early_bird)
}

// ── Offer computation (draft time) ──────────────────────────────────

/**
 * Given a tenant's config and the quote's creation time, produce the
 * concrete offer to stamp onto the quote. Returns null when there is no
 * offer to make (disabled config, or an unparseable created-at).
 */
export function computeEarlyBirdOffer(
  config: EarlyBirdConfig,
  quoteCreatedAtIso: string | null | undefined,
): EarlyBirdOffer | null {
  if (!config.enabled || config.discountPct <= 0) return null
  if (!quoteCreatedAtIso) return null
  const created = Date.parse(quoteCreatedAtIso)
  if (!Number.isFinite(created)) return null
  const expiresAt = new Date(
    created + config.windowHours * HOUR_MS,
  ).toISOString()
  return { discountPct: config.discountPct, expiresAt }
}

// ── Status (any time) ───────────────────────────────────────────────

/**
 * Resolve the live state of an offer stamped on a quote. Pass the
 * quote's early_bird_discount_pct + early_bird_expires_at. `state` is
 * 'none' when there is no usable offer, 'live' before the deadline,
 * 'expired' after it.
 */
export function earlyBirdStatus(
  discountPct: unknown,
  expiresAtIso: string | null | undefined,
  nowMs: number = Date.now(),
): EarlyBirdStatus {
  const pct = clampDiscountPct(discountPct)
  if (pct <= 0 || !expiresAtIso) {
    return { state: 'none', discountPct: 0, msRemaining: 0, hoursRemaining: 0, expiresAt: null }
  }
  const until = Date.parse(expiresAtIso)
  if (!Number.isFinite(until)) {
    return { state: 'none', discountPct: 0, msRemaining: 0, hoursRemaining: 0, expiresAt: null }
  }
  const msRemaining = until - nowMs
  if (msRemaining <= 0) {
    return {
      state: 'expired',
      discountPct: 0,
      msRemaining,
      hoursRemaining: 0,
      expiresAt: expiresAtIso,
    }
  }
  return {
    state: 'live',
    discountPct: pct,
    msRemaining,
    hoursRemaining: Math.floor(msRemaining / HOUR_MS),
    expiresAt: expiresAtIso,
  }
}

/**
 * True when an offer is still claimable. The book API gates the
 * server-side discount stamp on this — it must decide from the
 * DB-stamped deadline, never from anything the client sends.
 */
export function isEarlyBirdLive(
  discountPct: unknown,
  expiresAtIso: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  return earlyBirdStatus(discountPct, expiresAtIso, nowMs).state === 'live'
}

// ── Money ───────────────────────────────────────────────────────────

/**
 * Apply a discount % to a dollar amount, returning the discounted
 * amount rounded to the nearest dollar. The pct is clamped defensively
 * so an out-of-range value can never over-discount. A non-positive or
 * non-finite amount returns 0.
 *
 *   applyEarlyBirdDiscount(1000, 10)  → 900
 *   applyEarlyBirdDiscount(1000, 0)   → 1000   (no-op)
 *   applyEarlyBirdDiscount(1000, 999) → 850    (clamped to 15%)
 */
export function applyEarlyBirdDiscount(
  amount: number,
  discountPct: unknown,
): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const pct = clampDiscountPct(discountPct)
  if (pct <= 0) return Math.round(amount)
  return Math.round(amount * (1 - pct / 100))
}

/**
 * The dollar value of the discount itself (original − discounted).
 * Useful for "you save $X" copy and the tradie notification.
 */
export function earlyBirdSavingAmount(
  amount: number,
  discountPct: unknown,
): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.round(amount) - applyEarlyBirdDiscount(amount, discountPct)
}

// ── Formatting ──────────────────────────────────────────────────────

/**
 * Short AU date+time label for the offer deadline, ASCII-only so it is
 * GSM-7 safe for SMS, e.g. "Thu 22 May, 9:00pm". Returns '' for
 * missing / unparseable input.
 */
export function fmtEarlyBirdDeadlineAU(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  try {
    return new Date(t)
      .toLocaleString('en-AU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Australia/Sydney',
      })
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([ap])m\b/i, '$1m')
      .trim()
  } catch {
    return ''
  }
}

/**
 * Human "time left" label for the countdown banner, e.g. "9 hours left"
 * / "Last hour to lock it in" / "Today only". Returns '' when not live.
 */
export function fmtEarlyBirdRemaining(status: EarlyBirdStatus): string {
  if (status.state !== 'live') return ''
  const h = status.hoursRemaining
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d} day${d === 1 ? '' : 's'} left`
  }
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'} left`
  return 'Last hour to lock it in'
}
