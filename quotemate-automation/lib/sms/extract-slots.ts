// ════════════════════════════════════════════════════════════════════
// SMS slot extractor — turn-by-turn structured NLU.
//
// Runs ONCE per inbound SMS, BEFORE the dialog Sonnet call. Reads the
// current conversation_state, the agent's last outbound (for context),
// and the customer's new inbound, then returns a partial slot update.
//
// The route merges the update via mergeSlotUpdates() and persists the
// new state to sms_conversations.conversation_state.
//
// This is the layer that catches customer corrections in real time.
// Without it, "I'm in Chandler" arrives as plain text in sms_messages,
// nothing tracks the change, and the dialog Sonnet has to re-derive
// from transcript every turn — which is exactly how Con's bug
// (2026-05-11) became a 4-round-trip ordeal.
// ════════════════════════════════════════════════════════════════════

import { anthropic } from '@ai-sdk/anthropic'
import { generateObject } from 'ai'
import { z } from 'zod'
import { withRetry } from '@/lib/util/retry'

// Slot value shape. All fields optional/nullable — the extractor returns
// ONLY the slots the customer's message established this turn.
export const SlotsSchema = z.object({
  first_name: z.string().nullable().optional(),
  // Persistent profile slots — pre-seeded from customers row, eagerly
  // written back to customers row when source='customer_corrected'.
  // The customer expects "update my address to X" to stick across
  // conversations, so we don't wait for finish to persist.
  suburb: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  // Per-job slots — scoped to the current request, not written back.
  job_type: z.enum([
    // ── Electrical SMS auto-classifiable (v3 strategy) ─────────
    'downlights', 'power_points', 'ceiling_fans', 'smoke_alarms', 'outdoor_lighting',
    'oven_cooktop', 'ev_charger', 'fault_finding',
    // ── Plumbing SMS auto-classifiable (v5 strategy) ───────────
    // Dialog flow stays electrical-centric for now (see strategy.md v5
    // deferral); plumbing SMS leads are classified here so the route
    // handler can route them to the portal for richer intake.
    'blocked_drain', 'hot_water', 'tap_repair', 'tap_replace',
    'toilet_repair', 'toilet_replace',
    'gas_fitting', 'cctv_inspection', 'prv_install',
    'unknown', 'out_of_scope',
  ]).nullable().optional(),
  // z.number() (NOT .int()) — Anthropic's structured-output validator rejects
  // EVERY integer-range constraint (minimum, maximum, exclusiveMinimum,
  // exclusiveMaximum), AND the AI SDK silently adds safe-integer bounds the
  // moment you call .int(). Net effect: any z.number().int() schema fails
  // with "For 'integer' type, properties maximum, minimum are not supported".
  // Plain z.number() compiles to {"type": "number"} with no bounds — accepted.
  // We Math.trunc the value server-side wherever it's used as an integer.
  count: z.number().nullable().optional(),
  room: z.string().nullable().optional(),
  ceiling_type: z.enum([
    'flat_plaster', 'raked', 'cathedral', 'sheet_metal', 'unknown',
  ]).nullable().optional(),
  replace_or_new: z.enum(['replace', 'new']).nullable().optional(),
  colour: z.string().nullable().optional(),
  // WP5 — supply mode for the fitting/product. Set ONLY when the
  // customer has clearly stated which way it goes ("I'll supply", "I
  // bought it" / "you supply", "can you provide"). The dialog uses
  // this to ack live ("got it, you'll supply the X"); the intake
  // structurer also reads from the transcript and writes the same
  // value to intake.scope.specs.supplied_by — this slot is the FAST
  // path so a clarifying-question answer doesn't sit idle for one
  // dialog turn.
  supplied_by: z.enum(['tradie', 'customer']).nullable().optional(),
  // True when the customer affirmed a verification summary ("yep", "correct",
  // "all good"). The dialog policy reads this to decide finish vs ask.
  verified: z.boolean().nullable().optional(),
})

// Slots that get persisted back to the customers row when the customer
// corrects them mid-conversation. Other slots (job_type, count, room, etc.)
// are scoped to the current request and don't propagate cross-conversation.
export const PERSISTENT_PROFILE_SLOTS = ['first_name', 'suburb', 'address', 'email'] as const
export type PersistentProfileSlot = typeof PERSISTENT_PROFILE_SLOTS[number]

export type Slots = z.infer<typeof SlotsSchema>
export type SlotKey = keyof Slots

// Source attribution per slot. Drives both the dialog prompt (so Sonnet
// knows to acknowledge corrections) and the scrub (so it bails on values
// the customer just corrected).
//   from_memory:        pre-seeded from customers row at conversation start
//   from_transcript:    extracted fresh from this conversation's messages
//   customer_corrected: extracted value differs from a previously stored value
export type SlotSource = 'from_memory' | 'from_transcript' | 'customer_corrected'
export type SlotSources = Partial<Record<SlotKey, SlotSource>>

export const SlotExtractionSchema = z.object({
  updates: SlotsSchema,
  reasoning: z.string().max(300).default(''),
})

export type SlotExtraction = z.infer<typeof SlotExtractionSchema>

// Persisted shape of sms_conversations.conversation_state.
export type ConversationState = {
  slots: Slots
  sources: SlotSources
  last_extracted_at: string | null
}

export const EMPTY_STATE: ConversationState = {
  slots: {},
  sources: {},
  last_extracted_at: null,
}

// Coerces whatever shape lives on the row (could be {} from the default)
// into a valid ConversationState. Defensive — protects downstream code from
// JSON columns that drifted before the migration landed.
export function normaliseState(raw: unknown): ConversationState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE }
  const r = raw as Partial<ConversationState>
  return {
    slots: (r.slots && typeof r.slots === 'object') ? r.slots as Slots : {},
    sources: (r.sources && typeof r.sources === 'object') ? r.sources as SlotSources : {},
    last_extracted_at: r.last_extracted_at ?? null,
  }
}

// Pre-seed initial state from the customers row at conversation start.
// Any field present is marked source='from_memory' so:
//   - the dialog prompt knows to skip re-asking
//   - the scrub knows the value came from storage (not the customer's mouth)
//   - if the customer corrects it later, mergeSlotUpdates flips the source
//     to 'customer_corrected' and the route eagerly writes back to customers
// Accepts a generic shape so this module stays free of CustomerProfile coupling.
export function seedStateFromKnownFields(args: {
  first_name?: string | null
  suburb?: string | null
  address?: string | null
  email?: string | null
}): ConversationState {
  const slots: Slots = {}
  const sources: SlotSources = {}
  if (args.first_name && args.first_name.trim()) {
    slots.first_name = args.first_name.trim()
    sources.first_name = 'from_memory'
  }
  if (args.suburb && args.suburb.trim()) {
    slots.suburb = args.suburb.trim()
    sources.suburb = 'from_memory'
  }
  if (args.address && args.address.trim()) {
    slots.address = args.address.trim()
    sources.address = 'from_memory'
  }
  if (args.email && args.email.trim()) {
    slots.email = args.email.trim()
    sources.email = 'from_memory'
  }
  return {
    slots,
    sources,
    last_extracted_at: null,
  }
}

// Pure function: merge an extractor's updates into existing state and
// compute source attribution for each changed slot. No DB / LLM here —
// makes this trivially testable.
//   - slot already null → from_transcript (newly extracted this conversation)
//   - slot already set + value differs → customer_corrected
//   - slot already set + value matches → no-op (no source change)
// `verified` is special-cased: it's a transient handshake flag, not a
// fact about the customer, so it never carries customer_corrected.
export function mergeSlotUpdates(
  current: ConversationState,
  updates: Slots,
): ConversationState {
  const nextSlots: Slots = { ...current.slots }
  const nextSources: SlotSources = { ...current.sources }
  let changed = false

  for (const [key, rawValue] of Object.entries(updates) as [SlotKey, unknown][]) {
    if (rawValue === null || rawValue === undefined) continue
    const oldValue = current.slots[key]
    if (oldValue === rawValue) continue

    // Type-erased assignment is safe here — the Zod schema already validated.
    ;(nextSlots as Record<string, unknown>)[key] = rawValue
    changed = true

    if (key === 'verified') {
      nextSources[key] = 'from_transcript'
    } else {
      nextSources[key] = (oldValue === null || oldValue === undefined)
        ? 'from_transcript'
        : 'customer_corrected'
    }
  }

  return {
    slots: nextSlots,
    sources: nextSources,
    last_extracted_at: changed ? new Date().toISOString() : current.last_extracted_at,
  }
}

const SYSTEM_PROMPT = `Extract structured slot values from a customer SMS message in an Australian trade-quoting conversation (electrical or plumbing — both share this SMS line).

You are NOT writing a reply. You only extract WHAT THE CUSTOMER JUST SAID.

INPUTS PROVIDED:
  - CURRENT STATE: slots we already know (do NOT re-extract these unless the customer is correcting)
  - LAST AGENT MESSAGE: the question we just asked (gives context for short replies)
  - CUSTOMER MESSAGE: the inbound SMS to extract from

EXTRACTION RULES:

  ★ 0. CONTEXT BINDING (MOST IMPORTANT, READ FIRST) ★
     The LAST AGENT MESSAGE tells you which slot the customer is answering.
     A short customer reply ALMOST ALWAYS belongs to the slot the agent
     just asked about. Map the question to the slot like this:

       Agent asked …                                  → slot
       "what suburb is the job in?"                   → suburb
       "what's your first name?" / "what's your name?" → first_name
       "which room…?" / "where in the house…?"        → room
       "how many…?" / "how many fittings…?"           → count
       "flat plaster or raked?" / "ceiling type?"     → ceiling_type
       "warm white / cool white / tri-colour…?"       → colour
       "replacing existing or new install?"           → replace_or_new
       "supplied by you, or by us?" / "you supplying or us?" → supplied_by
       "Sound right?" / "just to confirm…?"           → verified (on affirm)

     DO NOT reclassify the customer's reply into a different slot unless
     their words are EXPLICITLY about a different field (e.g.
     "Lounge, but actually my name is Mike" → first_name: "Mike", room: "Lounge").

     CRITICAL ANTI-PATTERN: the agent asked "what suburb?" → customer
     replies "Bondi" → the answer is suburb: "Bondi". DO NOT store "Bondi"
     as a room. Suburbs are city/town names (Bondi, Coorparoo, Chandler).
     Rooms are interior spaces (lounge, kitchen, bedroom).

  ★ 0b. MULTI-FACT OPENING MESSAGES (also high-priority) ★
     When the customer's FIRST message packs multiple facts into one SMS
     (name + suburb + job type + count + room + replace-or-new + fuel
     type + colour temperature, etc.), extract EVERY fact present — not
     just the most obvious one. Long openings are the most common
     failure mode where extraction misses obvious facts.

     Worked examples:

       Customer: "Hi I am Sarah from Coorparoo 4151. My 315L electric
                  hot water system died this morning, no hot water.
                  Need a like-for-like replacement in the laundry."
       Extract: first_name="Sarah", suburb="Coorparoo",
                job_type="hot_water", room="laundry",
                replace_or_new="replace"

       Customer: "I'm Mike from Newtown 2042. Need 2 GPOs replaced
                  in the laundry, the existing ones are loose."
       Extract: first_name="Mike", suburb="Newtown",
                job_type="power_points", count=2, room="laundry",
                replace_or_new="replace"

       Customer: "Hi I am Lisa from Surry Hills 2010. Need to install
                  2 ceiling fans in our master bedroom and kids bedroom.
                  Ceilings are raked. AC fans with remote please."
       Extract: first_name="Lisa", suburb="Surry Hills",
                job_type="ceiling_fans", count=2, room="master bedroom",
                ceiling_type="raked", replace_or_new="new"

       Customer: "Hi I am Kim from Marrickville 2204. Need 4 hardwired
                  smoke alarms in our 1980s house, replacing the old
                  battery ones. Photoelectric please, interconnected."
       Extract: first_name="Kim", suburb="Marrickville",
                job_type="smoke_alarms", count=4,
                replace_or_new="replace"

       Customer: "Kitchen sink drain is blocked, water sitting in the
                  sink and not going down."
       Extract: job_type="blocked_drain", room="kitchen"

       Customer: "Half the power points in my kitchen stopped working,
                  need someone to find the fault."
       Extract: job_type="fault_finding", room="kitchen"
       (NOT smoke_alarms — "stopped working" + "find the fault" is the
       textbook fault-finding cue; the count "half" is not a quantity.)

       Customer: "Bathroom exhaust fan needs replacing, ducted to the eave."
       Extract: job_type="ceiling_fans", room="bathroom",
                replace_or_new="replace"
       (Exhaust / extractor / rangehood fans all map to ceiling_fans —
       the SMS classifier doesn't have a separate exhaust_fan value.)

     Buried facts count — "in the laundry as I said" still produces
     room="laundry"; "replacing the old battery ones" still produces
     replace_or_new="replace". Do not require explicit Q/A framing.

  1. Return ONLY slots the customer's message confirms or corrects.
     Do not infer, do not guess, do not pull from prior agent messages.
  2. If the customer is correcting a stored value (e.g. agent said "still at
     Coorparoo?" and customer says "Chandler" or "No, Chandler"), output the
     new value as the slot — the route will mark it as customer_corrected.
  3. Short answers ARE valid extractions when the agent's question gives context:
     - Agent: "what suburb?" / Customer: "Chandler" → suburb: "Chandler"
     - Agent: "how many?" / Customer: "6" → count: 6
     - Agent: "still at Coorparoo?" / Customer: "yep" → no update (state already correct)
     - Agent: "still at Coorparoo?" / Customer: "Chandler" → suburb: "Chandler"
     - Agent: "still at Coorparoo?" / Customer: "No Chandler" → suburb: "Chandler"
  4. NAME extraction:
     - Customer must clearly state a name. "I'm Mike", "Mike", "It's Sarah" → first_name.
     - Don't extract from greetings ("Hey there"), suburbs, or colours.
     - When the agent's last message asks for a name, a single short word reply IS the name.
     - Explicit update phrases: "update my name to Jeff", "change my name to Jeff",
       "my name is actually Jeff", "it's Jeff not Jeph" → first_name: "Jeff"
  5. SUBURB extraction:
     - Australian suburb names are 1-3 words, letters only (e.g. Chandler, Bondi,
       Coorparoo, Surry Hills, Bondi Beach).
     - Common patterns: "in Chandler", "at Bondi", "Chandler", "Bondi Beach".
     - Strip leading "in " / "at " / "no, " / "actually " before storing.
     - Explicit update phrases: "update my suburb to X", "change my suburb to X",
       "I've moved to X", "my new suburb is X" → suburb: "X"
  5a. ADDRESS extraction (street + number, not suburb):
     - Patterns: "12 Smith St", "12 Smith Street, Bondi", "Unit 4 / 18 Hall Rd"
     - Explicit update phrases: "update my address to 12 Smith St",
       "change my address to X", "my new address is X", "I'm at 12 Smith St now"
       → address: "12 Smith St" (full street line, no suburb)
     - If a customer's message contains BOTH a street address AND a suburb
       ("12 Smith St, Bondi"), extract address: "12 Smith St" AND suburb: "Bondi".
     - Do NOT extract a bare suburb name as an address (street numbers required).
  5b. EMAIL extraction:
     - Standard email pattern. "my email is sam@example.com",
       "update my email to sam@example.com", "send it to sam@example.com"
       → email: "sam@example.com"
     - Lowercase the value before storing.
  5c. ROOM extraction (interior space, NOT a suburb):
     - Valid room names: lounge, living room, kitchen, bedroom, master bedroom,
       ensuite, bathroom, dining, dining room, study, office, hallway, garage,
       deck, patio, courtyard, backyard, laundry, rumpus, theatre.
     - Common patterns: "in the lounge", "kitchen", "Lounge", "master bedroom".
     - If the customer says BOTH a room and a ceiling type in one message
       ("Lounge, flat plaster" / "Kitchen and raked ceiling"), extract BOTH
       fields: room AND ceiling_type.
     - DO NOT confuse rooms with suburbs. Suburbs are city/town names
       (Bondi, Coorparoo, Chandler, Surry Hills). Rooms are interior spaces
       inside a single home. When in doubt, look at the LAST AGENT MESSAGE
       (Rule 0): if it asked "what suburb?" → suburb; if it asked
       "which room?" → room.
  6. JOB_TYPE extraction:
     ELECTRICAL (auto-quote subset):
     - downlights / power_points / ceiling_fans / smoke_alarms / outdoor_lighting
     - "GPOs", "power points", "outlets" → power_points
     - "smoke alarms", "smokies", "smoke detectors" → smoke_alarms
       BUT: a customer saying their power points / lights / circuits
       "stopped working" or "tripped" is NOT smoke_alarms — that's fault_finding.
       Only classify smoke_alarms when the message is specifically about
       smoke alarm installation, replacement, or testing.
     - "oven", "cooktop", "stove hardwire" → oven_cooktop
     - "exhaust fan", "extractor fan", "bathroom fan", "rangehood fan",
       "ceiling fan" → ceiling_fans (the SMS enum's ceiling_fans value
       covers ALL fan installs, including exhaust / extractor variants)
     - "EV charger", "Tesla wall connector", "wall charger" → ev_charger
     - "fault find", "fault finding", "fault find call out", "breaker
       tripping", "RCD tripping", "safety switch keeps tripping",
       "stopped working", "half the lights stopped", "half the power
       points stopped", "lost power to X", "find the fault", "investigate
       why X stopped" → fault_finding
     - Other electrical (switchboard, renovation, three-phase, rewire,
       mains, underground cabling) → out_of_scope

     PLUMBING (auto-quote subset — v5 multi-trade):
     - "blocked drain", "drain blocked", "slow drain", "gurgling" → blocked_drain
     - "hot water", "HWS", "no hot water", "hot water unit dead" → hot_water
     - "dripping tap", "leaking tap", "tap washer" → tap_repair
     - "new tap", "replace tap", "upgrade tapware", "kitchen mixer" → tap_replace
     - "running toilet", "cistern leaking", "toilet won't stop" → toilet_repair
     - "new toilet", "replace toilet suite" → toilet_replace
     - "connect gas appliance", "gas appliance connection", "connect gas
       cooktop/stove" → gas_fitting
     - "CCTV drain inspection", "drain camera", "camera inspection" → cctv_inspection
     - "PRV", "pressure reduction valve", "pressure reducing valve" → prv_install
     - Other plumbing (gas leak / smell gas, burst pipe, bathroom reno,
       sewage emergency, water damage) → out_of_scope
  7. COUNT extraction:
     - "6 downlights" → count: 6
     - "a couple" → 2; "a few" → 3; "half a dozen" → 6
     - Don't extract a count from prices ("$99 inspection") or addresses ("12 Main St").
  8. CEILING_TYPE: flat_plaster | raked | cathedral | sheet_metal | unknown
     - "flat ceiling" / "plaster ceiling" / "standard" → flat_plaster
     - "raked" / "sloped" / "vaulted" → raked
     - "cathedral" → cathedral
     - "metal" / "colorbond ceiling" → sheet_metal
     - "not sure" / "don't know" → unknown
  9. REPLACE_OR_NEW:
     - "replacing existing", "swap out", "swap them", "like-for-like" → replace
     - "new install", "first time", "no fittings there now", "from scratch" → new
  10. COLOUR (downlights only):
      - "warm white" → "warm white"; "cool white" → "cool white";
        "tri-colour", "tri-color", "tricolour" → "tri-colour";
        "dimmable" → "dimmable"; "smart" → "smart"; "no preference" → "standard"
  10b. SUPPLIED_BY (WP5 — who provides the fitting/unit itself):
      - Set ONLY when the customer's words are explicit about supply.
      - 'customer' (the customer is supplying):
        "I'll supply", "I'll buy it", "I have my own", "I've already got
        one", "I'm providing the X", "I bought it already", "we'll
        supply the fan", "got my own".
      - 'tradie' (the customer wants the tradie to supply):
        "you supply", "can you provide one", "include the unit",
        "supply and install", "with a new fan/tap/etc", "we want one
        supplied".
      - Agent context: a question like "are you supplying the X yourself,
        or would you like us to supply it?" → the customer's reply
        ALMOST ALWAYS sets this slot. "I'll buy it" → 'customer';
        "supply it for me" / "yes please" → 'tradie'.
      - DO NOT infer from a generic affirmation; the words must be about
        WHO PROVIDES THE ITEM.
  11. VERIFIED: true ONLY when the customer affirms a verification summary the
      agent just sent. Triggers: "yep", "yes", "correct", "that's right",
      "perfect", "all good", "spot on", "sounds good", "no worries", "yeah".
      Set true ONLY if the agent's last message was a verification ("Sound right?"
      / "just to confirm" / similar). Don't set verified=true on a bare "yep" with
      no prior summary.
  12. If the customer corrects something AND affirms in the same message
      ("Chandler, yep"), extract the correction but leave verified false — they
      need to confirm the corrected summary on the next turn.

OUTPUT:
  - updates: object with ONLY the fields the customer's message established.
    Omit (or set null for) any field they did not address. Empty object is fine.
  - reasoning: ONE short sentence (under 200 chars) describing what you extracted
    and why. Used for debug logs only — never shown to the customer.

If the message contains no extractable slots, return updates: {} with a brief
reasoning ("greeting only", "off-topic", "ack with no info", etc.).`

export async function extractSlots(args: {
  state: ConversationState
  lastAgentMessage: string | null
  customerMessage: string
  /**
   * Trades the tenant offers (v6 multi-tenant). When provided and the
   * customer mentions a job that's clearly outside those trades (e.g. a
   * "blocked drain" inbound on an electrical-only tenant's number), the
   * extractor classifies job_type='out_of_scope' instead of writing the
   * wrong-trade value into conversation_state. This keeps the state clean
   * for the dialog Sonnet, which already redirects wrong-trade requests
   * via the TENANT TRADE SCOPE block in its own prompt.
   *
   * Undefined / empty → permissive (extract any trade) for legacy
   * pre-v6 single-pilot traffic.
   */
  tenantTrades?: ReadonlyArray<'electrical' | 'plumbing'>
}): Promise<SlotExtraction> {
  // Empty/whitespace inbound shouldn't waste a Sonnet call.
  if (!args.customerMessage.trim()) {
    return { updates: {}, reasoning: 'empty inbound, skipped extraction' }
  }

  const stateLines = Object.entries(args.state.slots).filter(([, v]) => v !== null && v !== undefined)
  const stateBlock = stateLines.length === 0
    ? '  (none yet)'
    : stateLines.map(([k, v]) => {
        const src = args.state.sources[k as SlotKey]
        return `  ${k}: ${JSON.stringify(v)}${src ? `  (source: ${src})` : ''}`
      }).join('\n')

  // Build the per-call tenant trade-scope hint. The slot extractor's
  // job_type enum still accepts every job from both trades (schema is
  // shared across tenants), but with this hint Sonnet will classify
  // off-trade jobs as 'out_of_scope' instead of leaking the wrong-trade
  // job_type into conversation_state.
  const trades = new Set(args.tenantTrades ?? ['electrical', 'plumbing'])
  const both = trades.has('electrical') && trades.has('plumbing')
  const tradeScope = both
    ? null
    : trades.has('electrical')
      ? [
          `TENANT TRADE SCOPE: this tradie covers ELECTRICAL jobs ONLY.`,
          `If the customer's message describes a PLUMBING job`,
          `(blocked drain, hot water / HWS, tap, toilet, leak, pipe, gas,`,
          `bathroom reno, drain camera), classify job_type='out_of_scope'.`,
          `Do NOT extract any plumbing-trade job_type for this tenant.`,
        ].join(' ')
      : [
          `TENANT TRADE SCOPE: this tradie covers PLUMBING jobs ONLY.`,
          `If the customer's message describes an ELECTRICAL job`,
          `(downlights, GPO, power point, ceiling fan, smoke alarm,`,
          `outdoor light, switchboard, EV charger), classify`,
          `job_type='out_of_scope'. Do NOT extract any electrical-trade`,
          `job_type for this tenant.`,
        ].join(' ')

  const { object } = await withRetry(
    () => generateObject({
      // Upgraded 2026-05-14 from Haiku 4.5 → Sonnet 4.6. The extractor is
      // the layer that pulls every fact (name, suburb, room, count,
      // replace-vs-new, fuel type, ceiling type) out of long multi-fact
      // opening messages. Sonnet is markedly better at not missing
      // buried facts (e.g. "in the laundry as I said" still produces
      // room="laundry"; "replacing the old battery ones" still produces
      // replace_or_new="replace"). The dialog Rule 0 + the new rule 0b
      // worked examples in this prompt only help if the extractor sees
      // every fact in the first place.
      model: anthropic('claude-sonnet-4-6'),
      schema: SlotExtractionSchema,
      system: SYSTEM_PROMPT,
      prompt: [
        tradeScope, // null for both-trades + legacy fallback — .filter(Boolean) drops it
        tradeScope ? '' : null,
        `CURRENT STATE (slots we already know):`,
        stateBlock,
        '',
        `LAST AGENT MESSAGE (for context, empty on first turn):`,
        args.lastAgentMessage
          ? `  ${args.lastAgentMessage.slice(0, 400)}`
          : '  (none - first turn)',
        '',
        `CUSTOMER MESSAGE (extract from this):`,
        `  ${args.customerMessage.slice(0, 600)}`,
      ].filter((l) => l !== null).join('\n'),
    }),
    {
      maxAttempts: 3,
      baseDelayMs: 800,
      onAttemptFailed: (err, attempt, willRetry) => {
        const msg = err instanceof Error ? err.message : String(err)
        const tag = willRetry ? 'retrying' : 'giving up'
        console.warn(`[sms/extract-slots] Sonnet attempt ${attempt}/3 failed - ${tag}`, msg.slice(0, 200))
      },
    },
  )
  return object
}
