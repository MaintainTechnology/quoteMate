// ════════════════════════════════════════════════════════════════════
// Mocked tier photos — Priority #5 from sms-progress.html (Output section).
//
// Each Good/Better/Best card on /q/[token] renders an indicative photo so
// the customer can SEE what the tier actually looks like, not just read a
// line item. v1 implementation uses placehold.co URLs with tier-coloured
// backgrounds and descriptive labels — clearly mocked, easy to swap to
// real on-site photos later by replacing the URL string.
//
// Replacement path when real photos are ready:
//   1. Drop product photos into `public/images/quote-tiers/<job_type>/<tier>.jpg`
//   2. Change PHOTO_URL_BASE to '' and update getTierPhoto to return
//      `/images/quote-tiers/${jobType}/${tier}.jpg` directly.
// ════════════════════════════════════════════════════════════════════

export type TierKey = 'good' | 'better' | 'best'

export type TierPhoto = {
  url: string
  alt: string
  /** Brand-aligned tag rendered as a small chip on top of the image */
  caption: string
}

// Tier accent colours (hex without #) used on placehold.co.
// Match the quote page's TierCard accent palette so the placeholder
// reads as part of the design rather than a stray asset.
const TIER_BG: Record<TierKey, string> = {
  good:   'e4e4e7',  // zinc-200
  better: 'dbeafe',  // blue-100
  best:   'ede9fe',  // violet-100
}
const TIER_FG: Record<TierKey, string> = {
  good:   '52525b',  // zinc-600
  better: '1d4ed8',  // blue-700
  best:   '6d28d9',  // violet-700
}

// Per-(job_type, tier) human-readable descriptions of what the photo
// would represent. Customer-facing — keep these short and tradie-natural.
const TIER_DESCRIPTIONS: Record<string, Record<TierKey, string>> = {
  // ── Electrical (v3) ──────────────────────────
  downlights: {
    good:   'Standard 9W LED downlight',
    better: 'Tri-colour dimmable LED',
    best:   'Smart tunable-white LED',
  },
  power_points: {
    good:   'Standard double GPO',
    better: 'Double GPO with USB-A + USB-C',
    best:   'Smart Wi-Fi GPO with energy monitor',
  },
  ceiling_fans: {
    good:   '52" 3-blade with light',
    better: '52" DC motor, remote controlled',
    best:   'Smart DC fan with app control',
  },
  smoke_alarms: {
    good:   '10-year sealed lithium alarm',
    better: '240V hardwired photoelectric',
    best:   'Interconnected wireless alarm system',
  },
  outdoor_lighting: {
    good:   'IP54 bulkhead light',
    better: 'PIR sensor floodlight',
    best:   'Smart RGBW deck/path lighting',
  },
  // ── Plumbing (v5) ────────────────────────────
  blocked_drain: {
    good:   'Hand-rod clearing of blocked drain',
    better: 'High-pressure jet blast clear',
    best:   'Jet blast + CCTV inspection with report',
  },
  hot_water: {
    good:   'Electric storage 250L HWS (Rheem)',
    better: 'Continuous-flow gas HWS (Rinnai)',
    best:   'Heat pump HWS 270L (QLD rebate eligible)',
  },
  tap_repair: {
    good:   'Tap washer replacement',
    better: 'Full tap replacement, chrome',
    best:   'Tap replace + new isolation valve',
  },
  tap_replace: {
    good:   'Standard chrome basin tap (Caroma)',
    better: 'Kitchen mixer tap (Methven)',
    best:   'Premium wall-mounted mixer (Phoenix)',
  },
  toilet_repair: {
    good:   'Cistern internals (fill + flush valve)',
    better: 'Full close-coupled suite replace',
    best:   'Wall-faced suite replace',
  },
  toilet_replace: {
    good:   'Standard close-coupled suite (Caroma)',
    better: 'Wall-faced suite (Caroma Liano)',
    best:   'In-wall cistern suite (Caroma Cube)',
  },
}

// Generic fallback for job types we haven't mapped yet (oven_cooktop,
// switchboard, etc. — those usually go to the inspection branch and
// don't render tier cards anyway, but defence-in-depth).
const FALLBACK_DESCRIPTIONS: Record<TierKey, string> = {
  good:   'Standard option',
  better: 'Mid-range option',
  best:   'Premium option',
}

export function getTierPhoto(jobType: string | null | undefined, tier: TierKey): TierPhoto {
  const descs = (jobType && TIER_DESCRIPTIONS[jobType]) || FALLBACK_DESCRIPTIONS
  const label = descs[tier]
  const bg = TIER_BG[tier]
  const fg = TIER_FG[tier]
  // placehold.co accepts URL-safe text in the path; spaces become +.
  const text = encodeURIComponent(label).replace(/%20/g, '+')
  return {
    url: `https://placehold.co/800x450/${bg}/${fg}/png?text=${text}&font=lato`,
    alt: `${label} — indicative product image`,
    caption: label,
  }
}
