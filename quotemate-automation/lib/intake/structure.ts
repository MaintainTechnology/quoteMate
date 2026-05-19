import { anthropic } from '@ai-sdk/anthropic'
import { generateObject } from 'ai'
import { IntakeSchema, deriveTradeFromJobType } from './schema'

// v5 multi-trade: caller passes the trade detected from earlier dialog
// signals (SMS extract-slots job_type, or 'electrical' for the voice
// receptionist which is electrical-only). The structurer prompt branches
// on this hint so Opus is grounded in the right trade's vocabulary and
// risk model. If unknown, defaults to electrical (the NSW/NECA pilot).
export type TradeHint = 'electrical' | 'plumbing'

export async function structureIntake(
  transcript: string,
  photoUrls: string[] = [],
  tradeHint: TradeHint = 'electrical',
  modelId = 'claude-opus-4-7',
) {
  // `trade` is required on the canonical IntakeSchema (v5 multi-trade) but
  // omitted from generateObject so Opus doesn't have to classify it. We
  // derive it from the emitted job_type below — see deriveTradeFromJobType.
  // The voice path will almost always resolve to 'electrical' (Vapi pilot
  // is electrical-only); the SMS path can resolve to either trade based on
  // the customer's described issue.
  const isPlumbing = tradeHint === 'plumbing'
  const { object } = await generateObject({
    model: anthropic(modelId),
    schema: IntakeSchema.omit({ trade: true }),
    maxRetries: 0, // wrapper handles retries with logging — no double-retry
    // Opus 4.7 ignores temperature (extended-thinking model). The AI SDK
    // warns on every call if it's set, so omit it. Determinism comes from
    // strict system grounding + structured output, not from temperature.
    system: `STRICT GROUNDING — non-negotiable, supersedes everything below
1. ONLY extract what the caller said in the transcript or what is
   visibly present in the photos. Never infer from "what jobs like
   this usually involve."
2. NEVER fill optional fields with assumptions. If the caller didn't
   mention it, leave it null/undefined.
3. NEVER invent caller.name, address, suburb, phone, item_count, or
   any access/property field. Empty string is better than a guess.
4. If a required field (caller.name, suburb, job_type) is missing,
   set it to empty string and drop confidence to LOW with a
   confidence_reason that names the missing field explicitly.
5. risks[] is grounded only in actual customer-stated triggers
   (their words: "burning smell", "tripping", "shocked", etc.).
   Do NOT add risks proactively just because a job type "usually" has them.
6. scope.description must quote or closely paraphrase the caller's
   own wording. Do not add details they didn't mention (e.g. don't
   write "warm-white LEDs" if they only said "downlights").
7. NEVER use placeholder strings like "Unknown", "N/A", "TBD",
   "Not provided", or similar. Empty string is the only acceptable
   placeholder. Numbers/booleans should be omitted entirely if not stated.
8. photo_urls is supplied as image attachments — never describe
   imagined photos in scope.description. If no images are attached,
   the photos contain nothing.
9. scope.specs fields are PRICING-CRITICAL for electrical jobs. Extract
   them when the caller mentions them, leave them undefined otherwise.
   ${isPlumbing ? 'For PLUMBING jobs, the scope.specs fields below are NOT applicable — SKIP this section entirely and leave specs undefined. Plumbing-specific detail goes into scope.description.' : 'See "SPEC EXTRACTION" section below for explicit per-job_type rules.'}

${isPlumbing ? `TRADE: PLUMBING (QLD/QBCC pilot — v5)
This is a plumbing intake. Auto-quoteable plumbing job_types:
  blocked_drain     — kitchen/bathroom drain blocked, gurgling, slow
  hot_water         — HWS replacement (electric/gas/heat-pump)
  tap_repair        — dripping/leaking tap (washer)
  tap_replace       — new tap or mixer install
  toilet_repair     — running cistern, internals
  toilet_replace    — new toilet suite install

ALWAYS inspection_required=true for these plumbing job_types:
  gas_fitting          — gas appliance connection or leak (gas-licence work)
  burst_pipe           — burst/split pipe (access + make-good unknown)
  bathroom_renovation  — rough-in + fit-off, multi-fixture, multi-visit

Map customer language to job_type:
  "drain is blocked" / "slow drain" / "gurgling" / "water sitting in sink"
    → blocked_drain
  "no hot water" / "HWS died" / "hot water unit broken"
    → hot_water
  "dripping tap" / "leaking tap" / "tap washer"
    → tap_repair
  "new tap" / "replace tap" / "kitchen mixer"
    → tap_replace
  "toilet running" / "cistern leaking" / "won't stop filling"
    → toilet_repair
  "new toilet" / "replace toilet"
    → toilet_replace
  "smell gas" / "gas leak" / "smells like gas"
    → gas_fitting + inspection_required=true + urgency=emergency
  "burst pipe" / "pipe burst" / "water everywhere"
    → burst_pipe + inspection_required=true + urgency=emergency
  "bathroom reno" / "renovating bathroom" / "ensuite renovation"
    → bathroom_renovation + inspection_required=true

DO NOT populate scope.specs.* fields (color_temp, dimmable, smart,
weatherproof, supplied_by) for plumbing intakes — those are electrical-only.
` : `TRADE: ELECTRICAL (NSW/NECA pilot — v3)

SPEC EXTRACTION — populate scope.specs.* from the caller's own words

Each spec field below maps directly into a SQL filter on the materials/
assemblies library at estimation time. Missing a spec means the
estimation engine has to guess the SKU — which is exactly the
hallucination class we are trying to eliminate.

  scope.specs.color_temp — only for downlights / outdoor_lighting
    "warm white" / "yellow light" / "soft white"  → 'warm_white'
    "cool white" / "daylight" / "white"            → 'cool_white'
    "tri-colour" / "tri colour" / "colour change"  → 'tri_colour'
    caller didn't mention                          → omit (undefined)

  scope.specs.dimmable — for downlights / fans / lighting
    "dimmable" / "I can dim" / "want a dimmer"     → true
    explicitly NOT dimmable                        → false
    not mentioned                                  → omit

  scope.specs.smart — for downlights / GPOs / fans / outdoor_lighting
    "smart" / "Wi-Fi" / "app-controlled" / "Alexa"
    "Google Home" / "smart home" / "remote app"    → true
    "no smart" / "just basic"                      → false
    not mentioned                                  → omit

  scope.specs.weatherproof — for GPOs / outdoor lights
    "outdoor" + "weatherproof" / "IP-rated" / "IP56"
    "exposed to weather" / "uncovered"             → true
    "covered area" / "indoor"                      → false
    not mentioned but indoor_outdoor='outdoor'     → true (implicit)
    not mentioned                                  → omit

  scope.specs.supplied_by — for ceiling fans, ovens, cooktops
    "I have my own" / "I'll supply" / "I bought"   → 'customer'
    "you supply" / "can you provide"               → 'tradie'
    not mentioned                                  → omit

  Brand preferences (e.g. "Clipsal Iconic", "HPM", "Beacon Lucci") and
  access notes go in scope.description verbatim — they're not separate
  structured fields but the estimation engine reads scope.description
  when narrowing the lookup.
`}
CONFIDENCE RUBRIC — apply uncompromisingly
  HIGH:    every required field captured, scope.item_count known,
           access fields populated when relevant, no ambiguity
  MEDIUM:  required fields captured but a key access/access detail
           or item_count is missing
  LOW:     any required field empty, OR job_type='other', OR
           scope.description shorter than ~10 chars, OR caller used
           placeholder language (${isPlumbing ? '"just need a plumber"' : '"just need an electrician"'})

You extract structured intake data from ${isPlumbing ? 'plumbing' : 'electrical'} quoting calls.
Be conservative — if unsure, leave fields blank and lower confidence.

${isPlumbing ? `Surface real risks (only when the caller's own words trigger them):
- "smell gas" / "gas leak" → inspection_required=true, urgency=emergency, risks=["suspected gas leak"]
- "burst pipe" / "water everywhere" / "water through ceiling" → inspection_required=true, urgency=emergency
- "sewage backing up" / "raw sewage" → inspection_required=true, urgency=emergency
- water damage to walls/ceiling/floor → add to risks + inspection_required=true
- pre-1970 properties → flag galvanised pipework / lead solder risk on supply lines
- pipe under concrete slab / behind tile → inspection_required=true (access unknown)
- whole-property re-pipe / bathroom rough-in / fit-off → inspection_required=true

Auto-quote candidates (inspection_required=false) when scope is clear:
blocked_drain, hot_water, tap_repair, tap_replace, toilet_repair, toilet_replace,
cctv_inspection (standalone), prv_install (no whole-house re-pipe).

Always inspection_required=true: gas_fitting (any), burst_pipe, bathroom_renovation,
and any plumbing job that mentions hidden pipework, water damage, or access through
concrete/tile.` : `Surface real risks (only when the caller's own words trigger them):
- burning smell, buzzing, sparks → mark inspection_required=true, urgency=emergency
- tripping breakers / recurring faults → inspection_required=false when
  the request is for a diagnostic call-out; repairs are quoted after diagnosis
- water damage near electrical fixtures → add to risks + inspection_required=true
- pre-1970 properties → flag asbestos / lead-paint risk on cabling work
- unknown switchboard age or ceramic fuses → recommend inspection
- difficult access (high ceilings, raked ceilings, no roof access, brick/concrete walls)
- mains, underground cabling, three-phase work → always inspection_required=true

Fault finding / breaker tripping is a priced diagnostic call-out when no
burning, sparks, shock, water, switchboard, mains, or load risk is stated.

Auto-quote candidates (inspection_required=false) when scope is clear and photos look clean:
downlights, power_points, ceiling_fans, smoke_alarms, outdoor_lighting.

Always inspection_required=true: switchboard, renovation, rewire, mains/underground/
three-phase work, and any oven_cooktop / power_points / outdoor_lighting job that
mentions a new circuit, mains, or switchboard work. EV charger and fault finding
are inspection_required=false when they map to an enabled priced service row and
no explicit safety/load/switchboard risk is stated.`}`,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Transcript:\n${transcript}` },
        ...photoUrls.map(url => ({ type: 'image' as const, image: url })),
      ],
    }],
  })
  return { ...object, trade: deriveTradeFromJobType(object.job_type) }
}
