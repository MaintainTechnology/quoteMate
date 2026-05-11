import { z } from 'zod'

export const IntakeSchema = z.object({
  // Trade routing — required at root, not optional, to keep below the
  // 24-optional-field cap on Anthropic's generateObject schema (see
  // brand_preference removal comment below). The structurer / receptionist
  // sets this before calling generateObject; defaults to 'electrical' on
  // legacy intake rows.
  trade: z.enum(['electrical', 'plumbing']),
  job_type: z.enum([
    // ── Electrical (NSW/NECA pilot, v3 strategy) ────────────────
    'downlights',
    'power_points',
    'ceiling_fans',
    'smoke_alarms',
    'outdoor_lighting',
    'switchboard',
    'oven_cooktop',
    'ev_charger',
    'fault_finding',
    'renovation',
    // ── Plumbing (QLD/QBCC pilot, v5 strategy) ──────────────────
    'blocked_drain',
    'hot_water',
    'tap_repair',
    'tap_replace',
    'toilet_repair',
    'toilet_replace',
    'gas_fitting',
    'burst_pipe',
    'bathroom_renovation',
    'cctv_inspection',
    'prv_install',
    // ── Fallback ────────────────────────────────────────────────
    'other',
  ]),
  address: z.string(),
  suburb: z.string(),
  scope: z.object({
    item_count: z.number().optional(),                                       // e.g., # of downlights, # of GPOs
    is_new_install: z.boolean().optional(),                                  // vs replacing existing
    existing_wiring: z.boolean().optional(),                                 // is wiring already there?
    indoor_outdoor: z.enum(['indoor', 'outdoor', 'both', 'unknown']).optional(),
    description: z.string(),
    // Structured pricing-critical specs — extracted by the intake agent
    // and passed straight into lookup_material/lookup_assembly filters at
    // estimation time. Keeping them as discrete fields (not buried in the
    // freeform description) means the estimation engine can deterministically
    // pick the right SKU instead of re-parsing prose.
    //
    // NOTE: brand_preference removed 2026-05-07 — Anthropic generateObject
    // caps optional-parameter count at 24 across the whole schema and we
    // were at 26. Brand mentions still flow via scope.description as
    // freeform text; Opus reads them when narrowing material lookups.
    specs: z.object({
      color_temp: z.enum(['warm_white', 'cool_white', 'tri_colour', 'unknown']).optional(),
      dimmable: z.boolean().optional(),
      smart: z.boolean().optional(),                  // Wi-Fi / app control / smart-home compatible
      weatherproof: z.boolean().optional(),           // IP-rated for outdoor / wet-area use
      supplied_by: z.enum(['tradie', 'customer']).optional(),  // who provides the fitting itself
    }).optional(),
  }),
  access: z.object({
    roof_access: z.boolean().optional(),
    ceiling_type: z.enum(['flat', 'raked', 'high', 'unknown']).optional(),
    wall_type: z.enum(['plaster', 'brick', 'concrete', 'tile', 'unknown']).optional(),
    // notes field removed 2026-05-07 — see specs comment above.
    // Access concerns still captured in scope.description.
  }).optional(),
  property: z.object({
    bedrooms: z.number().optional(),                                         // for smoke-alarm jobs
    levels: z.number().optional(),
    pre_1970: z.boolean().optional(),                                        // asbestos / lead risk
    has_solar: z.boolean().optional(),                                       // affects switchboard / EV-charger work
    phase: z.enum(['single', 'three', 'unknown']).optional(),
  }).optional(),
  risks: z.array(z.string()),                                                // burning smell, tripping breakers, water damage, asbestos, old switchboard
  inspection_required: z.boolean(),                                          // true for switchboard, fault_finding, ev_charger, renovation, anything with mains/underground
  caller: z.object({
    name: z.string(),
    phone: z.string(),
    email: z.string().optional(),
  }),
  timing: z.object({
    urgency: z.enum(['emergency', 'this_week', 'this_month', 'flexible']).optional(),
    preferred_date: z.string().optional(),
  }).optional(),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  confidence_reason: z.string(),
})

export type Intake = z.infer<typeof IntakeSchema>

// v5 multi-trade: derive trade from job_type. Used by the intake structurer
// (lib/intake/structure.ts) and the SMS path so callers never have to set
// trade explicitly — they just emit a job_type and the trade falls out.
// Job types not in the plumbing set (including 'other' and 'renovation')
// default to electrical.
const PLUMBING_JOB_TYPES = new Set<string>([
  'blocked_drain',
  'hot_water',
  'tap_repair',
  'tap_replace',
  'toilet_repair',
  'toilet_replace',
  'gas_fitting',
  'burst_pipe',
  'bathroom_renovation',
  'cctv_inspection',
  'prv_install',
])

export function deriveTradeFromJobType(jobType: string | null | undefined): 'electrical' | 'plumbing' {
  if (jobType && PLUMBING_JOB_TYPES.has(jobType)) return 'plumbing'
  return 'electrical'
}
