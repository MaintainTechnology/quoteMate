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
  // ── Electrical SMS-auto-quoteable (v3) ─────────────
  | 'downlights'
  | 'power_points'
  | 'ceiling_fans'
  | 'smoke_alarms'
  | 'outdoor_lighting'
  // ── Plumbing SMS-auto-quoteable (v5) ──────────────
  | 'blocked_drain'
  | 'hot_water'
  | 'tap_repair'
  | 'tap_replace'
  | 'toilet_repair'
  | 'toilet_replace'

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
      // Colour/feature preference anchors the 3 tiers around what the
      // customer actually wants. shared_materials has: Basic warm white
      // ($28), Tri-colour ($48), Dimmable IP-rated ($72). Without
      // preference the agent generates 3 tiers blindly; with it,
      // tiers become refinements of the same product family.
      'colour or feature preference (warm white, cool white, tri-colour, dimmable, smart Wi-Fi, or no preference / standard)',
    ],
    inspectionTriggers: [
      // Trimmed 2026-05-26 — removed:
      //   - 'high ceiling' (ambiguous; raked/cathedral cover the real cases)
      //   - 'first time installing downlights in this room (no existing wiring)'
      //     (now covered by shared_assemblies row "Install LED downlight
      //      (new install, single-storey)" added in mig 069, which carries
      //      its own narrower inspection_triggers)
      'raked ceiling', 'cathedral ceiling',
      'no roof access', 'no manhole',
      'pre-1970 house', 'asbestos', 'old wiring',
    ],
  },

  power_points: {
    safeDefaults: {
      // "new GPO" is customer shorthand for a new fitting, not proof
      // that a new switchboard circuit is needed. Ask before escalating.
      'scope.is_new_install':'false (assume replacement/add-on using existing nearby power unless customer says otherwise)',
      'access.wall_type':    'plaster',
      'scope.indoor_outdoor':'indoor',
      'property.pre_1970':   'false',
    },
    mustAsk: [
      'how many GPOs',
      'which room',
      'is it replacing existing GPOs, adding near existing power, or a brand-new run from the switchboard',
      'if the room is bathroom/ensuite/laundry/kitchen: is the GPO at least 600mm away from any basin, sink, shower or bath',
    ],
    inspectionTriggers: [
      // Phase 5 cleanup 2026-05-27 — the five "metric-able" triggers
      // below were REMOVED because the price-bands recipe engine
      // (mig 074, lib/estimate/merge-recipes.ts) now turns those scope
      // gaps into priced line items via the Replace-double-GPO recipe:
      //
      //   - 'dedicated 20A+ circuit'                          → recipe
      //         answers circuit_required='20A' → swaps to
      //         "Install 20A dedicated GPO" assembly
      //   - 'new sub-circuit from switchboard requiring a spare way'
      //     'brand-new run from the switchboard'              → recipe
      //         distance_to_existing_power band + risk_flag
      //         ("switchboard spare way required") covers this
      //   - 'no power within 5 metres of the GPO location'    → recipe
      //         distance_to_existing_power 5-10m band adds 0.5-1.0hr
      //         labour + per-metre TPS cable line items
      //   - 'three-phase'                                     → recipe
      //         answers circuit_required='three-phase' → swaps to
      //         "Install 32A three-phase outlet" assembly
      //
      // Retained triggers genuinely need eyes on site — they're NOT
      // priceable from a customer's SMS answer:
      //   - wet-area zoning (AS/NZS 3000 — regulatory clearance check)
      //   - pre-1970 / old wiring / ceramic fuse (asbestos + ESV-style
      //     switchboard inspection — safety, not a metric)
      'within 600mm of a basin, sink, shower or bath',
      'inside a wet-area zone',
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
      // Trimmed 2026-05-26 — removed:
      //   - 'no existing fan or light at that spot' (now covered by mig 069's
      //     "Install ceiling fan (new wiring, no existing rose)" row)
      //   - 'high ceiling' (ambiguous; raked covers the real case)
      'raked ceiling',
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
      // Trimmed 2026-05-26 — removed 'no existing alarms anywhere' (now
      // covered by mig 069's "Hardwire 240V smoke alarm (whole-house
      // compliance install)" row).
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
      // Trimmed + tightened 2026-05-26:
      //   - 'no power outside currently' removed (now covered by mig 069's
      //     "Install outdoor light (new circuit from indoor power)" row)
      //   - 'garden lights along path' → '(5 or more fittings)' qualifier:
      //     2-3 path lights are quotable; a designed lighting scheme isn't
      'underground cabling', 'bury cable',
      'garden lights along path (5 or more fittings)',
      'string lights across yard',
      'three-phase',
      'pre-1970 house',
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // PLUMBING (QLD/QBCC pilot — v5 multi-trade)
  //
  // Plumbing rules are deliberately MINIMAL. The plumbing intake schema
  // doesn't carry structured scope.specs (those fields are electrical-
  // specific), so most plumbing detail flows via scope.description.
  // safeDefaults are kept tight; mustAsk focuses on the 1-2 fields that
  // genuinely change the quote tier; inspectionTriggers cover scenarios
  // where pricing-without-eyes-on is unsafe (water damage, behind-wall
  // pipework, gas-line work, pipe-material unknowns).
  // ──────────────────────────────────────────────────────────────────

  blocked_drain: {
    safeDefaults: {
      'scope.indoor_outdoor': 'indoor (most kitchen/bathroom drain blockages)',
      'property.pre_1970':   'false',
    },
    mustAsk: [
      'which drain is blocked (kitchen sink, bathroom basin, shower, toilet, or external)',
      'is it slow draining or completely blocked',
    ],
    inspectionTriggers: [
      'sewage backing up', 'multiple fixtures affected', 'tree roots known',
      'recurring blockage every few months', 'pipe under concrete slab',
      'pre-1970 house',
    ],
  },

  hot_water: {
    safeDefaults: {
      'scope.indoor_outdoor': 'unknown (HWS can be indoor or outdoor — confirm in description)',
      'property.pre_1970':   'false',
    },
    mustAsk: [
      'current system type (electric storage, gas storage, continuous-flow gas, or heat pump)',
      'roughly what size / capacity (e.g. 250L, 315L, or "not sure")',
      'where is it located (laundry, outside back wall, roof, garage)',
    ],
    inspectionTriggers: [
      // Tightened 2026-05-26 (Jon's "we'll need to run a new circuit"
      // chat exposed that 'no power or gas point at install location'
      // was too broad). First pass split it into 'no gas connection at
      // install location' + 'requires new dedicated circuit run over 15
      // metres'; both removed in a follow-up the same day — gas HWS
      // already routes to inspection via the row-level
      // always_inspection=true flag on the "Install gas HWS" row
      // (migration 068, per AS/NZS 5601), so the dialog-level phrase is
      // duplicative; and the >15m circuit case is rare enough to let
      // through to the validator/router. Kept here are the genuine
      // eyes-on cases (switchboard work, gas-line upgrade, roof, three-
      // phase, asbestos, pre-1970).
      'switchboard upgrade needed', 'gas-line upgrade needed',
      'roof-mounted',
      'three-phase electric required', 'asbestos', 'pre-1970 house',
    ],
  },

  tap_repair: {
    safeDefaults: {
      'scope.indoor_outdoor': 'indoor',
      'property.pre_1970':   'false',
      'scope.existing_wiring': 'true (existing supply pipework present — repair only)',
    },
    mustAsk: [
      'which tap (kitchen, basin, laundry, outdoor)',
      'is it dripping, leaking from body, or stuck',
    ],
    inspectionTriggers: [
      // Tightened 2026-05-26 — 'no isolation valve' on its own is fine
      // (plumbers can install one as part of the job); only escalate
      // when no isolation AND old galvanised supply (= retrofit risk).
      'leak through wall', 'water damage to cabinetry',
      'no isolation valve and old galvanised supply',
      'pre-1970 house', 'galvanised supply lines',
    ],
  },

  tap_replace: {
    safeDefaults: {
      'scope.indoor_outdoor': 'indoor',
      'property.pre_1970':   'false',
      'scope.existing_wiring': 'true (existing supply present)',
      'scope.specs.supplied_by': 'tradie (default — plumber supplies tapware)',
    },
    mustAsk: [
      'which tap (kitchen mixer, basin, laundry, outdoor)',
      'are you supplying the tap or do you want the plumber to supply',
    ],
    inspectionTriggers: [
      // Tightened 2026-05-26 — removed 'no isolation valve under sink'.
      // Plumbers fit an isolation valve as part of a normal tap replace
      // (typical 0.25hr extra labour); not a $99 site-visit case.
      'wall-mounted with no existing wall-tap', 'tiles need cutting',
      'pre-1970 house',
    ],
  },

  toilet_repair: {
    safeDefaults: {
      'scope.indoor_outdoor': 'indoor',
      'property.pre_1970':   'false',
    },
    mustAsk: [
      'which toilet (main, ensuite, second bathroom)',
      'symptom (constantly running, leaking at base, won\'t flush)',
    ],
    inspectionTriggers: [
      'leaking at floor base', 'visible water damage to floor',
      'cracked porcelain', 'pre-1970 house',
    ],
  },

  toilet_replace: {
    safeDefaults: {
      'scope.indoor_outdoor': 'indoor',
      'property.pre_1970':   'false',
      'scope.specs.supplied_by': 'tradie (default — plumber supplies toilet suite)',
    },
    mustAsk: [
      'which toilet (main, ensuite)',
      'style preference (standard close-coupled, wall-faced, or in-wall cistern premium)',
      'are you supplying the suite or do you want the plumber to supply',
    ],
    inspectionTriggers: [
      'in-wall cistern install (higher complexity, framing required)',
      'concrete slab penetration needed', 'rotted floor at base',
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
  "what work they need — must be one of the trade-specific auto-quoteable list OR an enabled tenant service from the Services catalogue (intake field: job_type/scope)",
]

// Universal escalation — applies regardless of job type. Any of these in
// the customer's message immediately routes to inspection mode.
// v5: extended with plumbing-specific triggers (gas, burst pipe, sewage,
// hidden pipework / behind-wall leaks).
export const UNIVERSAL_INSPECTION_TRIGGERS = [
  // ── Electrical ──────────────────────────────────────────
  'burning smell', 'smoke coming from switchboard', 'smoke coming from outlet',
  'sparks', 'sparking', 'electric shock', 'shocked',
  // 'switchboard' alone was too broad (lots of casual mentions —
  // "near the switchboard", "switchboard is in the garage") wrongly
  // escalated. Tightened 2026-05-26 to the four cases that genuinely
  // require switchboard-level intervention:
  'switchboard upgrade', 'switchboard damaged', 'switchboard at capacity',
  'no spare ways on switchboard',
  'fuse box', 'ceramic fuse', 'old fuses',
  'rewire', 'three-phase', 'three phase',
  // EV chargers are explicit inspection-only per strategy.md v3 (mains
  // current, load calcs, switchboard interaction, dedicated circuit
  // required). The parity harness asserts this trigger set covers them.
  'ev charger', 'ev charging', 'electric vehicle charger', 'tesla charger',
  'wallbox', 'wall charger',
  // ── Plumbing (v5) ───────────────────────────────────────
  'smell gas', 'gas leak', 'gas smell', 'leaking gas',
  'burst pipe', 'pipe burst', 'water everywhere',
  'water coming through ceiling', 'water through ceiling',
  'sewage overflow', 'sewage backing up', 'raw sewage',
  'leak behind wall', 'pipe behind wall', 'pipe under slab',
  'bathroom reno', 'bathroom renovation', 'kitchen reno',
  // ── Cross-trade ─────────────────────────────────────────
  // 'renovation' alone was too broad (a tap renovation = a tap_replace,
  // not a $99 visit). Tightened 2026-05-26 to the whole-scope cases.
  'full renovation', 'whole-house renovation', 'extension',
  'water damage', 'flooded',
  'pre-1970', 'asbestos',
]

// Helper used by the dialog system prompt — produces a compact, readable
// summary of the rules for a given job type. As of migration 065
// (2026-05-26), the MUST ASK section is NOT emitted here — those
// questions now live per-row on shared_assemblies.clarifying_questions
// and are injected by customServicesDirective() in dialog.ts. We keep
// safeDefaults + inspectionTriggers here because they are genuinely
// job-type-level policy (assumption-fill + keyword routing) and don't
// fit the per-row clarifying_questions shape. The `mustAsk` arrays on
// ASSUMPTION_RULES are kept for now as a fallback / documentation but
// are no longer surfaced to the AI through this function.
export function rulesAsText(jobType: JobType): string {
  const r = ASSUMPTION_RULES[jobType]
  const defaults = Object.entries(r.safeDefaults)
    .map(([k, v]) => `  - ${k}: ${v}`).join('\n')
  return [
    `JOB TYPE: ${jobType}`,
    `SAFE DEFAULTS (apply silently if customer didn't state otherwise):`,
    defaults,
    `INSPECTION TRIGGERS (force inspection_required=true if any of these match):`,
    `  - ${r.inspectionTriggers.join('\n  - ')}`,
  ].join('\n')
}
