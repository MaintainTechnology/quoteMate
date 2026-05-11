// ════════════════════════════════════════════════════════════════════
// SMS slot extractor — turn-by-turn structured NLU.
//
// Runs ONCE per inbound SMS, BEFORE the dialog Haiku call. Reads the
// current conversation_state, the agent's last outbound (for context),
// and the customer's new inbound, then returns a partial slot update.
//
// The route merges the update via mergeSlotUpdates() and persists the
// new state to sms_conversations.conversation_state.
//
// This is the layer that catches customer corrections in real time.
// Without it, "I'm in Chandler" arrives as plain text in sms_messages,
// nothing tracks the change, and the dialog Haiku has to re-derive
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
    'downlights', 'power_points', 'ceiling_fans', 'smoke_alarms', 'outdoor_lighting',
    'unknown', 'out_of_scope',
  ]).nullable().optional(),
  // .min(1) rather than .positive() — Zod emits exclusiveMinimum: 0 for
  // .positive(), which Anthropic's JSON Schema validator rejects on the
  // 'integer' type ("For 'integer' type, properties exclusiveMinimum,
  // maximum are not supported"). .min(1) emits minimum: 1 which is fine.
  count: z.number().int().min(1).nullable().optional(),
  room: z.string().nullable().optional(),
  ceiling_type: z.enum([
    'flat_plaster', 'raked', 'cathedral', 'sheet_metal', 'unknown',
  ]).nullable().optional(),
  replace_or_new: z.enum(['replace', 'new']).nullable().optional(),
  colour: z.string().nullable().optional(),
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

// Source attribution per slot. Drives both the dialog prompt (so Haiku
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

const SYSTEM_PROMPT = `Extract structured slot values from a customer SMS message in an Australian electrical-quoting conversation.

You are NOT writing a reply. You only extract WHAT THE CUSTOMER JUST SAID.

INPUTS PROVIDED:
  - CURRENT STATE: slots we already know (do NOT re-extract these unless the customer is correcting)
  - LAST AGENT MESSAGE: the question we just asked (gives context for short replies)
  - CUSTOMER MESSAGE: the inbound SMS to extract from

EXTRACTION RULES:
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
  6. JOB_TYPE extraction:
     - downlights / power_points / ceiling_fans / smoke_alarms / outdoor_lighting
     - Anything else (switchboard, EV charger, fault find, ovens, renovation,
       three-phase, rewire) → out_of_scope
     - "GPOs", "power points", "outlets" → power_points
     - "smoke alarms", "smokies", "smoke detectors" → smoke_alarms
  7. COUNT extraction:
     - "6 downlights" → count: 6
     - "a couple" → 2; "a few" → 3; "half a dozen" → 6
     - Don't extract a count from prices ("$199 inspection") or addresses ("12 Main St").
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
}): Promise<SlotExtraction> {
  // Empty/whitespace inbound shouldn't waste a Haiku call.
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

  const { object } = await withRetry(
    () => generateObject({
      model: anthropic('claude-haiku-4-5-20251001'),
      schema: SlotExtractionSchema,
      system: SYSTEM_PROMPT,
      prompt: [
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
      ].join('\n'),
    }),
    {
      maxAttempts: 3,
      baseDelayMs: 800,
      onAttemptFailed: (err, attempt, willRetry) => {
        const msg = err instanceof Error ? err.message : String(err)
        const tag = willRetry ? 'retrying' : 'giving up'
        console.warn(`[sms/extract-slots] Haiku attempt ${attempt}/3 failed - ${tag}`, msg.slice(0, 200))
      },
    },
  )
  return object
}
