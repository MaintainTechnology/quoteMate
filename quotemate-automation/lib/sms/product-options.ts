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
  resolveTierForBrandRange,
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
 * Pick TWO operator-owned options for a category — a cheaper "Good" and
 * a premium "Better". Operator catalogue ONLY. Prefers is_preferred
 * within a tier. Returns null when fewer than 2 distinct usable
 * products exist (never show a 1-option "choice").
 */
export function selectProductOptions(
  rows: TenantMaterial[],
  category: string,
): [ProductOption, ProductOption] | null {
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

  if (usable.length < 2) return null

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

  // Good = cheapest. Better = the dearest DISTINCT product. If every
  // row is the same price, still return the two most distinct (first
  // vs last) so the customer gets a real 2-way choice.
  const good = sorted[0]
  const better = sorted[sorted.length - 1]
  if (good === better) return null

  // If the operator pinned tiers explicitly, respect their labelling
  // for which is "better" (premium), but keep cheaper-as-Good ordering
  // so price always reads low → high to the customer.
  const goodTier =
    resolveTierForBrandRange(good.brand, good.range_series, good.tier_hint ?? null) ?? 'good'
  void goodTier
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
  options: [ProductOption, ProductOption],
  chooseUrl: string,
  category: string,
): string {
  const [a, b] = options
  const label = categoryLabel(category)
  const compose = (n1: string, n2: string) =>
    `Quick one — which ${label} would you like?\n` +
    `1. ${n1} (Good) — ${money(a.price_ex_gst)}\n` +
    `2. ${n2} (Better) — ${money(b.price_ex_gst)}\n` +
    `Reply 1 or 2. See photos: ${chooseUrl}`

  let msg = compose(a.name, b.name)
  if (msg.length <= 320) return msg
  // Trim names progressively so the link + instruction always survive.
  const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
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
    "link) and I'll lock that into your quote."
  )
}

/**
 * Interpret a customer reply into the chosen option. Accepts "1"/"2",
 * "one"/"two", "first"/"second", or a clear product/brand-name match.
 * Returns null when it isn't an unambiguous choice (the dialog then
 * handles the message normally — WP9 never hijacks a real question).
 */
export function interpretChoiceReply(
  body: string,
  options: [ProductOption, ProductOption],
): ProductOption | null {
  const t = (body ?? '').trim().toLowerCase()
  if (!t) return null
  const [a, b] = options

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
  input: { catalogueId?: string | null; reply?: string | null },
  nowIso: string = new Date().toISOString(),
): ProductChoiceState | null {
  if (!choice) return null
  if (choice.status === 'chosen') return choice // idempotent success
  const opts = choice.options
  if (!Array.isArray(opts) || opts.length < 2) return null
  const pair: [ProductOption, ProductOption] = [opts[0], opts[1]]

  let picked: ProductOption | null = null
  const id = (input.catalogueId ?? '').trim()
  if (id) {
    picked = opts.find((o) => o.catalogue_id === id) ?? null
  } else if (input.reply != null) {
    picked = interpretChoiceReply(input.reply, pair)
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
