// SINGLE SOURCE OF TRUTH for grounding categories.
//
// Why this module exists: the grounding category set used to live as a
// bare union inside validate.ts. The validator, the custom-service Zod
// schema, and the dashboard form each need that set — and the day a
// category is added (migration 029 added 9), every hand-maintained copy
// drifts out of sync. That drift is *exactly* the bug class that left 10
// catalogue services uncategorised in the first place.
//
// The fix: ONE array. The `Category` type is DERIVED from it (there is no
// separate union to forget), and every consumer reads from here:
//   • lib/estimate/validate.ts      — categorise() + grounding guard
//   • lib/tenant/update-schema.ts   — CustomServiceSchema.category enum
//   • app/dashboard/page.tsx        — the "Category" <select> options
//
// Adding a new category = add ONE { value, label } line below. The type,
// the validator's accepted set, the API's allowed values, and the form
// dropdown all update automatically. The drift guard in
// categories.test.ts fails the build if a value is duplicated.
//
// Pure data — no DB, no Next, no regex. Safe to import into a client
// component (the dashboard form) without bundling the validator engine.

export const CATEGORIES = [
  // ── Electrical ───────────────────────────────────────────────────
  { value: 'downlight', label: 'Downlights' },
  { value: 'gpo', label: 'GPO / power points' },
  { value: 'smoke_alarm', label: 'Smoke alarms' },
  { value: 'fan', label: 'Ceiling / exhaust fans' },
  { value: 'outdoor_light', label: 'Outdoor / flood lighting' },
  { value: 'rcbo', label: 'Safety switches / RCBO' },
  { value: 'oven_cooktop', label: 'Oven / cooktop' },
  { value: 'ev_charger', label: 'EV charger' },
  { value: 'switchboard', label: 'Switchboard' },
  { value: 'fault_find', label: 'Fault finding / diagnostics' },
  { value: 'strip_light', label: 'LED strip lighting' },
  { value: 'security_camera', label: 'Security cameras' },
  { value: 'doorbell_intercom', label: 'Doorbell / intercom' },
  // ── Plumbing ─────────────────────────────────────────────────────
  { value: 'drain', label: 'Blocked drains' },
  { value: 'hot_water', label: 'Hot water systems' },
  { value: 'tap', label: 'Taps / mixers' },
  { value: 'toilet', label: 'Toilets / cisterns' },
  { value: 'cctv', label: 'Drain camera (CCTV)' },
  { value: 'gas', label: 'Gas fitting / gas leak' },
  { value: 'prv', label: 'Pressure reduction valve' },
  { value: 'dishwasher', label: 'Dishwasher connection' },
  { value: 'rainwater_tank', label: 'Rainwater tank' },
  { value: 'water_filter', label: 'Water filter / filtration' },
  { value: 'leak_detection', label: 'Leak detection' },
  { value: 'shower', label: 'Shower head' },
  // ── Shared ───────────────────────────────────────────────────────
  { value: 'sundry', label: 'Sundries / consumables' },
  { value: 'general', label: 'General (no specific category)' },
] as const

/** The grounding category union — DERIVED from CATEGORIES so there is no
 *  second list to keep in sync. Add to CATEGORIES and this widens itself. */
export type Category = (typeof CATEGORIES)[number]['value']

/** Fast membership check used by the validator's explicit-category fold-in
 *  and the Zod schema's runtime guard. */
export const CATEGORY_VALUES: ReadonlySet<Category> = new Set(
  CATEGORIES.map((c) => c.value),
)

export function isCategory(v: string | null | undefined): v is Category {
  return !!v && (CATEGORY_VALUES as ReadonlySet<string>).has(v)
}

/** z.enum needs a non-empty literal tuple. CATEGORIES.map() loses the
 *  tuple type, so the cast is centralised here (one place, not per
 *  consumer). Runtime value is just the list of category strings. */
export const CATEGORY_ENUM_TUPLE = CATEGORIES.map((c) => c.value) as unknown as [
  Category,
  ...Category[],
]
