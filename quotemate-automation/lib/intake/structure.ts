import { anthropic } from '@ai-sdk/anthropic'
import { generateObject } from 'ai'
import { IntakeSchema } from './schema'

export async function structureIntake(transcript: string, photoUrls: string[] = []) {
  const { object } = await generateObject({
    model: anthropic('claude-opus-4-7'),
    schema: IntakeSchema,
    maxRetries: 0, // wrapper handles retries with logging — no double-retry
    temperature: 0, // determinism: same transcript → same intake fields
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

CONFIDENCE RUBRIC — apply uncompromisingly
  HIGH:    every required field captured, scope.item_count known,
           access fields populated when relevant, no ambiguity
  MEDIUM:  required fields captured but a key access/access detail
           or item_count is missing
  LOW:     any required field empty, OR job_type='other', OR
           scope.description shorter than ~10 chars, OR caller used
           placeholder language ("just need an electrician")

You extract structured intake data from electrical quoting calls.
Be conservative — if unsure, leave fields blank and lower confidence.

Surface real risks (only when the caller's own words trigger them):
- burning smell, buzzing, sparks → mark inspection_required=true, urgency=emergency
- tripping breakers, recurring faults → mark inspection_required=true
- water damage near electrical fixtures → add to risks + inspection_required=true
- pre-1970 properties → flag asbestos / lead-paint risk on cabling work
- unknown switchboard age or ceramic fuses → recommend inspection
- difficult access (high ceilings, raked ceilings, no roof access, brick/concrete walls)
- mains, underground cabling, three-phase work → always inspection_required=true

Auto-quote candidates (inspection_required=false) when scope is clear and photos look clean:
downlights, power_points, ceiling_fans, smoke_alarms, outdoor_lighting.

Always inspection_required=true: switchboard, ev_charger, fault_finding, renovation, and
any oven_cooktop / power_points / outdoor_lighting job that mentions new circuits, mains,
or switchboard work.`,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Transcript:\n${transcript}` },
        ...photoUrls.map(url => ({ type: 'image' as const, image: url })),
      ],
    }],
  })
  return object
}
