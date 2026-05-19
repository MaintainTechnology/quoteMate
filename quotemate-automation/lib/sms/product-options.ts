// ════════════════════════════════════════════════════════════════════
// WP9 — mid-conversation product options (pure core).
//
// "Do you want the Clipsal 2000 or the Clipsal Iconic?" — show the
// customer the operator's REAL products mid-chat, record their pick,
// and let it drive both the quote price and the WP4 render.
//
// This module is the brain of WP9 and is PURE + DB-free so every rule
// the spec insists on is provable in isolation before it touches the
// live SMS path (the route wiring is flag-gated by WP9_PRODUCT_OPTIONS):
//   • operator catalogue ONLY — never a generic product the tradie
//     doesn't sell.
//   • exactly TWO options — Good (cheaper) + Better (premium). Jon:
//     "the three gets a bit confusing… we might drop that off".
//   • prefer the operator's is_preferred product within a tier.
//   • a real reply interpreter ("1" / "2" / "first" / a product name).
//   • SMS body stays within the dialog's 320-char reply cap and links
//     to the choice page (AU Twilio MMS is unreliable → SMS + link).
//
// Unit-tested in product-options.test.ts.
// ════════════════════════════════════════════════════════════════════

import {
  normaliseCategory,
  type TenantMaterial,
} from '@/lib/estimate/catalogue'

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === '') return NaN
  return typeof v === 'string' ? parseFloat(v) : v
}

export interface ProductOption {
  catalogue_id: string
  name: string
  brand: string | null
  range_series: string | null
  price_ex_gst: number
  image_path: string | null
  description: string | null
  /** WP9 surfaces only TWO buckets to the customer. */
  tier: 'good' | 'better'
}

export type ProductChoiceStatus = 'pending' | 'chosen'

/** Lives on sms_conversations.conversation_state.product_choice — the
 *  codebase keeps conversational selections in conversation_state jsonb
 *  (same as slots/sources), so WP9 needs NO new table. */
export interface ProductChoiceState {
  category: string
  token: string
  status: ProductChoiceStatus
  options: ProductOption[]
  chosen_catalogue_id?: string | null
  chosen_name?: string | null
  offered_at?: string
  chosen_at?: string
}

/**
 * Pick the operator-owned options for a category to offer the customer.
 * Operator catalogue ONLY. Returns:
 *   • 2 options (cheaper "Good" + premium "Better") when ≥2 exist,
 *   • 1 option when the tradie only has ONE product for the category
 *     (still offered — the customer confirms it),
 *   • null when there are NONE.
 * Prefers is_preferred on the price tie-break.
 */
export function selectProductOptions(
  rows: TenantMaterial[],
  category: string,
): ProductOption[] | null {
  const cat = normaliseCategory(category)
  if (!cat) return null

  const usable = (rows ?? [])
    .filter((r) => (r.active ?? true) && normaliseCategory(r.category) === cat)
    .filter((r) => !!r.id && Number.isFinite(num(r.unit_price_ex_gst)))
    // de-dupe by product name (catalogue has a unique name index anyway)
    .filter(
      (r, i, arr) =>
        arr.findIndex(
          (x) => (x.name ?? '').trim().toLowerCase() === (r.name ?? '').trim().toLowerCase(),
        ) === i,
    )

  if (usable.length === 0) return null

  const toOpt = (r: TenantMaterial, tier: 'good' | 'better'): ProductOption => ({
    catalogue_id: String(r.id),
    name: r.name,
    brand: r.brand ?? null,
    range_series: r.range_series ?? null,
    price_ex_gst: +num(r.unit_price_ex_gst).toFixed(2),
    image_path: r.image_path ?? null,
    description: r.description ?? null,
    tier,
  })

  // Sort cheapest → dearest; tie-break preferring is_preferred so the
  // operator's go-to wins when prices match.
  const sorted = [...usable].sort((a, b) => {
    const pa = num(a.unit_price_ex_gst)
    const pb = num(b.unit_price_ex_gst)
    if (pa !== pb) return pa - pb
    return (b.is_preferred === true ? 1 : 0) - (a.is_preferred === true ? 1 : 0)
  })

  const good = sorted[0]
  const better = sorted[sorted.length - 1]
  // Only one distinct product → offer it as the single option.
  if (good === better) return [toOpt(good, 'good')]
  return [toOpt(good, 'good'), toOpt(better, 'better')]
}

/** Title-case-ish, human label for the category in the SMS. */
function categoryLabel(category: string): string {
  return normaliseCategory(category).replace(/_/g, ' ') || 'option'
}

function money(n: number): string {
  return `$${Number(n).toFixed(0)}`
}

/**
 * Build the outbound SMS. Two options with prices, an explicit
 * "Reply 1 or 2", and a link to the choice page (which shows the real
 * product photos — AU Twilio MMS is unreliable, so SMS + link is the
 * channel). Kept within the dialog's 320-char reply cap; long product
 * names are trimmed before the message is allowed to overflow.
 */
export function buildProductOptionsSms(
  options: ProductOption[],
  chooseUrl: string,
  category: string,
): string {
  const label = categoryLabel(category)
  const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

  // Single option — the tradie stocks one product for this job. Offer
  // it for confirmation rather than skipping.
  if (options.length === 1) {
    const o = options[0]
    const composeOne = (n: string) =>
      `Quick one — for your ${label} we use: ${n} — ${money(o.price_ex_gst)}. ` +
      `Tap to see the photo: ${chooseUrl}\n` +
      `Reply "yes" (or 1) to lock it in.`
    let m = composeOne(o.name)
    if (m.length <= 320) return m
    for (const cap of [40, 30, 22, 16]) {
      m = composeOne(trim(o.name, cap))
      if (m.length <= 320) return m
    }
    return m.slice(0, 320)
  }

  const [a, b] = options
  const compose = (n1: string, n2: string) =>
    `Quick one — 2 ${label} options in our catalogue. Tap for photos ` +
    `+ to pick: ${chooseUrl}\n` +
    `1. ${n1} (Good) — ${money(a.price_ex_gst)}\n` +
    `2. ${n2} (Better) — ${money(b.price_ex_gst)}\n` +
    `Reply 1, 2, or "you pick" for our pick.`

  let msg = compose(a.name, b.name)
  if (msg.length <= 320) return msg
  for (const cap of [40, 30, 22, 16]) {
    msg = compose(trim(a.name, cap), trim(b.name, cap))
    if (msg.length <= 320) return msg
  }
  return msg.slice(0, 320)
}

/**
 * The short "I'm holding your quote until you pick" nudge. Sent as the
 * dialog reply while a product choice is pending so the customer is
 * never told "quote on its way" before they've chosen. Kept brief; the
 * options + photo link were already sent in the options SMS.
 */
export function buildChoiceHoldSms(): string {
  return (
    "Take your pick from the 2 options above — reply 1 or 2 (or tap the " +
    "link). No preference? Just say \"you pick\" and I'll go with our " +
    "recommended one."
  )
}

/** The option we'd recommend when the customer doesn't want to choose
 *  ("you pick"). The dearest/"Better" option, or the only one when the
 *  tradie stocks a single product. Pure. */
export function recommendedOption(
  options: ProductOption[],
): ProductOption {
  return options[options.length - 1] ?? options[0]
}

// "Don't make me choose — you pick / whatever you recommend" signals.
// Curated so it can't swallow a real question; checked only AFTER the
// explicit 1/2 + name matching below.
const DEFER_RE =
  /\b(you (pick|choose|decide)|your (choice|call|recommendation)|up to you|whatever('?s| is| you)|recommend(ed)?|no (pref(erence)?|idea)|don'?t mind|doesn'?t matter|either( one| is fine)?|surprise me|you'?re the expert|trust you|i'?ll trust|just (pick|choose|go ahead)|skip|no thanks)\b/i

/**
 * Interpret a customer reply into the chosen option. Accepts "1"/"2",
 * "one"/"two", "first"/"second", a clear product/brand-name match,
 * the tier words "good/cheaper" vs "better/premium", OR a "you pick /
 * no preference" reply (→ the recommended option). Returns null only
 * when it isn't an unambiguous choice (the dialog then handles the
 * message normally — WP9 never hijacks a real question).
 */
export function interpretChoiceReply(
  body: string,
  options: ProductOption[],
): ProductOption | null {
  const t = (body ?? '').trim().toLowerCase()
  if (!t) return null
  const [a, b] = options

  // Single-option offer ("we use X — reply yes"): accept any clear
  // affirmative, a name match, or a defer phrase → that one product.
  // An explicit "no/nope/not that" → null (let the dialog handle it).
  if (options.length === 1) {
    if (/\b(no|nope|nah|not (that|this|it)|don'?t want)\b/.test(t)) return null
    const nameHit =
      t.length <= 60 &&
      [a.name, a.brand, a.range_series]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase())
        .some((h) => h.length >= 3 && (t.includes(h) || h.includes(t)))
    if (
      /^(1|yes|yep|yeah|yup|ok(ay)?|sure|sounds good|go( ahead)?|do it|that one|please|confirm|lock it in|👍)\b/.test(t) ||
      nameHit ||
      DEFER_RE.test(t)
    ) {
      return a
    }
    return null
  }

  // If BOTH a "1" and a "2" appear, it's a question ("1 or 2?"), not a
  // pick — bail to the normal dialog. \b2\b deliberately does NOT match
  // inside a product code like "2000".
  if (/\b1\b/.test(t) && /\b2\b/.test(t)) return null

  // Strong choice signals. "one"/"two" only as the WHOLE reply so
  // "the second one" → 2 (second beats the filler "one"), and a bare
  // leading digit must be the start of the message.
  const has = (re: RegExp) => re.test(t)
  const wantOne =
    has(/\bfirst\b/) || has(/\b(?:option|opt)\s*1\b/) || has(/^#?\s*1\b/) || t === 'one'
  const wantTwo =
    has(/\bsecond\b/) || has(/\btwo\b/) || has(/\b(?:option|opt)\s*2\b/) || has(/^#?\s*2\b/) || t === 'two'
  if (wantOne && !wantTwo) return a
  if (wantTwo && !wantOne) return b

  // Name / brand / range match (short replies only, to stay safe).
  if (t.length <= 60) {
    const hit = (o: ProductOption) => {
      const hay = [o.name, o.brand, o.range_series]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase())
      return hay.some((h) => h.length >= 3 && (t.includes(h) || h.includes(t)))
    }
    const ha = hit(a)
    const hb = hit(b)
    if (ha && !hb) return a
    if (hb && !ha) return b
  }

  // Tier words — natural replies to a "Good vs Better" offer.
  const cheap = has(/\b(good|cheap(er|est)?|basic|budget|standard|lower)\b/)
  const prem = has(/\b(better|premium|dearer|nicer|higher|top|best)\b/)
  if (cheap && !prem) return a
  if (prem && !cheap) return b

  // "You pick / no preference" → the recommended (Better) option, so
  // the customer is never trapped by the hold and the quote still uses
  // a real catalogue product + price.
  if (DEFER_RE.test(t)) return recommendedOption(options)

  return null
}

/**
 * Resolve a pending choice from EITHER a page tap (catalogueId) or an
 * SMS reply text, and return the updated state. Idempotent: a choice
 * that's already 'chosen' is returned unchanged (re-taps / repeated
 * replies are safe). Returns null when the input doesn't resolve to one
 * of the two offered options and nothing was previously chosen — the
 * caller then lets the normal dialog handle the message. Pure (the
 * timestamp is injectable for tests).
 */
export function applyChoiceSelection(
  choice: ProductChoiceState | null | undefined,
  input: { catalogueId?: string | null; reply?: string | null; defer?: boolean },
  nowIso: string = new Date().toISOString(),
): ProductChoiceState | null {
  if (!choice) return null
  if (choice.status === 'chosen') return choice // idempotent success
  const opts = choice.options
  if (!Array.isArray(opts) || opts.length < 1) return null

  let picked: ProductOption | null = null
  const id = (input.catalogueId ?? '').trim()
  if (input.defer === true) {
    // "Let the tradie choose" (page button) → the recommended option.
    picked = recommendedOption(opts)
  } else if (id) {
    picked = opts.find((o) => o.catalogue_id === id) ?? null
  } else if (input.reply != null) {
    picked = interpretChoiceReply(input.reply, opts)
  }
  if (!picked) return null

  return {
    ...choice,
    status: 'chosen',
    chosen_catalogue_id: picked.catalogue_id,
    chosen_name: picked.name,
    chosen_at: nowIso,
  }
}

// Map an SMS dialog job_type → the operator-catalogue category WP9
// should pull options from. Returns null for job types with no clean
// single product category (→ no offer; safe default). Pure.
const JOB_TYPE_CATEGORY: Record<string, string> = {
  // electrical
  downlights: 'downlight',
  power_points: 'gpo',
  ceiling_fans: 'fan',
  smoke_alarms: 'smoke_alarm',
  outdoor_lighting: 'outdoor_light',
  // plumbing
  blocked_drain: 'drain',
  hot_water: 'hot_water',
  tap_repair: 'tap',
  tap_replace: 'tap',
  toilet_repair: 'toilet',
  toilet_replace: 'toilet',
}
export function categoryForJobType(jobType: string | null | undefined): string | null {
  const k = (jobType ?? '').trim().toLowerCase()
  return JOB_TYPE_CATEGORY[k] ?? null
}

/**
 * One-line, grounded directive describing the customer's chosen product
 * — appended to the intake scope so the estimator quotes THAT product
 * (the catalogue hint + grounding validator still govern; WP4 links the
 * line back by name → renders the right photo). null when nothing was
 * chosen. Pure.
 */
export function describeChosenProductDirective(
  choice: ProductChoiceState | null | undefined,
): string | null {
  if (!choice || choice.status !== 'chosen' || !choice.chosen_catalogue_id) return null
  const picked =
    (choice.options ?? []).find((o) => o.catalogue_id === choice.chosen_catalogue_id) ?? null
  const name = (picked?.name ?? choice.chosen_name ?? '').trim()
  if (!name) return null
  const label = [picked?.brand, picked?.range_series].filter(Boolean).join(' ').trim()
  return (
    `Customer explicitly chose this product mid-conversation: ${name}` +
    (label ? ` (${label})` : '') +
    `. Quote THIS exact product for the ${choice.category} and price it from the operator catalogue.`
  )
}

/** The customer's chosen product as structured data — stashed on the
 *  intake so the estimator can DETERMINISTICALLY force this exact
 *  product + its catalogue price + photo into the quote (not just hint
 *  at it). null when nothing was chosen. Pure. */
export interface ChosenProduct {
  catalogue_id: string
  name: string
  price_ex_gst: number
  image_path: string | null
  category: string
}
export function chosenProductFromChoice(
  choice: ProductChoiceState | null | undefined,
): ChosenProduct | null {
  if (!choice || choice.status !== 'chosen' || !choice.chosen_catalogue_id) return null
  const o =
    (choice.options ?? []).find((x) => x.catalogue_id === choice.chosen_catalogue_id) ?? null
  if (!o || !o.name) return null
  const price = Number(o.price_ex_gst)
  if (!Number.isFinite(price) || price < 0) return null
  return {
    catalogue_id: o.catalogue_id,
    name: o.name,
    price_ex_gst: +price.toFixed(2),
    image_path: o.image_path ?? null,
    category: choice.category,
  }
}
