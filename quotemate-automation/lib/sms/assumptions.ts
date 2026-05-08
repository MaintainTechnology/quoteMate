// ═════════════════════════════════════════════════════════════════════
// SMS dialog · assumption rules per "easy 5" job type
//
// The dialog agent (lib/sms/dialog.ts) loads this file into its system
// prompt. Each entry tells the agent:
//   safeDefaults  — fields it can fill silently when not stated
//   mustAsk       — fields that genuinely change the quote and have no
//                   safe default → ask in plain English over SMS
//   inspectionTriggers — phrases or conditions that force inspection mode
//                        regardless of how confident the agent is
//
// EDIT THIS FILE WHEN A TRADIE CORRECTS THE AGENT.
// Every "I had to fix downlights to assume raked ceiling" is feedback
// that goes into safeDefaults or mustAsk for that job type.
// ═════════════════════════════════════════════════════════════════════

export type JobType =
  | 'downlights'
  | 'power_points'
  | 'ceiling_fans'
  | 'smoke_alarms'
  | 'outdoor_lighting'

export type AssumptionRule = {
  safeDefaults: Record<string, string>
  mustAsk: string[]
  inspectionTriggers: string[]
}

export const ASSUMPTION_RULES: Record<JobType, AssumptionRule> = {
  downlights: {
    safeDefaults: {
      // Wall type doesn't apply for ceiling fittings — keep as plaster
      // for any wall-related material lookups, no customer-visible impact.
      'access.wall_type':    'plaster',
      // Roof access can be derived once ceiling type is known.
      'access.roof_access':  'true (derive from ceiling_type answer)',
      // Indoor inferred from room name (lounge/kitchen/bedroom = indoor).
      // If the customer says "deck" or "outdoor" we'll catch it as outdoor_lighting.
      'scope.indoor_outdoor':'indoor (when room name is interior — lounge, kitchen, bedroom, etc.)',
      'property.pre_1970':   'false (assume modern unless customer says old/period)',
    },
    mustAsk: [
      'how many downlights',
      'which room or area (one short phrase, e.g. "kitchen")',
      // Ceiling type materially changes labour difficulty — flat plaster
      // is fastest, raked/cathedral need ladders + harnesses, sheet metal
      // needs different tooling. Always ask, do NOT silently default.
      'ceiling type (flat plaster, raked, cathedral, sheet metal, or not sure)',
      // Existing-wiring vs new-install is a labour multiplier of 3-5x
      // (running new cable through ceilings is way more work than swapping
      // a fitting). Even when the customer says "replace", confirm —
      // some customers say "replace" but mean "I want to add new lights".
      'replacing existing downlights (existing wiring) or new install (no fittings there now)',
    ],
    inspectionTriggers: [
      'raked ceiling', 'high ceiling', 'cathedral ceiling',
      'no roof access', 'no manhole',
      'first time installing downlights in this room (no existing wiring)',
      'pre-1970 house', 'asbestos', 'old wiring',
    ],
  },

  power_points: {
    safeDefaults: {
      'scope.is_new_install':'false (assume replacement of existing GPO)',
      'access.wall_type':    'plaster',
      'scope.indoor_outdoor':'indoor',
      'property.pre_1970':   'false',
    },
    mustAsk: [
      'how many GPOs',
      'which room',
    ],
    inspectionTriggers: [
      'new circuit', 'add a circuit', 'no power there now',
      'outdoor', 'weatherproof',
      'kitchen near sink', 'bathroom',
      'three-phase', 'switchboard',
      'pre-1970 house', 'old wiring', 'ceramic fuse',
    ],
  },

  ceiling_fans: {
    safeDefaults: {
      'scope.existing_wiring': 'true (assume existing ceiling rose)',
      'access.ceiling_type':   'flat',
      'scope.indoor_outdoor':  'indoor',
      'property.pre_1970':     'false',
      'scope.fan_supplied_by_customer': 'true (default — customer will supply)',
    },
    mustAsk: [
      'how many fans',
      'which room',
      'do you already have the fan, or do you want us to supply it',
    ],
    inspectionTriggers: [
      'no existing fan or light at that spot',
      'raked ceiling', 'high ceiling',
      'no roof access',
      'pre-1970 house',
    ],
  },

  smoke_alarms: {
    safeDefaults: {
      'scope.is_new_install':'false (assume like-for-like replacement)',
      'access.ceiling_type': 'flat',
      'access.wall_type':    'plaster',
      'property.pre_1970':   'false',
    },
    mustAsk: [
      'how many alarms (or how many bedrooms if doing a full compliance install)',
      'replacing existing alarms, or first installation',
    ],
    inspectionTriggers: [
      'no existing alarms anywhere',
      'pre-1970 house', 'asbestos', 'asbestos ceiling',
      'ceramic fuse', 'old switchboard',
      'rental compliance certificate required',
    ],
  },

  outdoor_lighting: {
    safeDefaults: {
      'scope.indoor_outdoor': 'outdoor',
      'access.wall_type':    'plaster (interior side of exterior wall)',
      'scope.existing_wiring': 'true (assume there is an outdoor circuit nearby)',
      'property.pre_1970':   'false',
    },
    mustAsk: [
      'how many fittings',
      'where (eaves, deck, garden path, etc.)',
      'do you want a sensor or always-on',
    ],
    inspectionTriggers: [
      'no power outside currently',
      'underground cabling', 'bury cable',
      'garden lights along path', 'string lights across yard',
      'three-phase',
      'pre-1970 house',
    ],
  },
}

// Universal MUST-ASK fields — required for EVERY job, regardless of
// job_type. The Intake Agent (lib/intake/structure.ts) drops confidence
// to LOW when any of these are missing, and the quality gate
// (lib/intake/quality.ts) then short-circuits the quote and sends a
// callback-request SMS instead. The dialog agent must therefore ensure
// all three are present in the transcript before returning 'finish'.
//
// Mirrors the voice receptionist's opening sequence
// (scripts/update-vapi-prompt-confirm.mjs): name → suburb → job_type.
export const UNIVERSAL_MUST_ASK = [
  "customer's first name (intake field: caller.name)",
  "suburb where the job is (intake field: suburb)",
  "what electrical work they need — must be one of the easy 5 (intake field: job_type)",
]

// Universal escalation — applies regardless of job type. Any of these in
// the customer's message immediately routes to inspection mode.
export const UNIVERSAL_INSPECTION_TRIGGERS = [
  'burning smell', 'smoke', 'sparks', 'sparking', 'electric shock', 'shocked',
  'switchboard', 'fuse box', 'ceramic fuse', 'old fuses',
  'ev charger', 'tesla wall', 'wall connector',
  'tripping breaker', 'breaker keeps tripping', 'fault finding', 'fault find',
  'rewire', 'renovation', 'extension',
  'three-phase', 'three phase',
  'water damage', 'flooded',
  'pre-1970', 'asbestos',
]

// Helper used by the dialog system prompt — produces a compact, readable
// summary of the rules for a given job type.
export function rulesAsText(jobType: JobType): string {
  const r = ASSUMPTION_RULES[jobType]
  const defaults = Object.entries(r.safeDefaults)
    .map(([k, v]) => `  - ${k}: ${v}`).join('\n')
  return [
    `JOB TYPE: ${jobType}`,
    `SAFE DEFAULTS (apply silently if customer didn't state otherwise):`,
    defaults,
    `MUST ASK (no safe default — short SMS question):`,
    `  - ${r.mustAsk.join('\n  - ')}`,
    `INSPECTION TRIGGERS (force inspection_required=true if any of these match):`,
    `  - ${r.inspectionTriggers.join('\n  - ')}`,
  ].join('\n')
}
