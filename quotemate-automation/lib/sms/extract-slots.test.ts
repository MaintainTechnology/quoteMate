// Phase 4 — unit tests for the slot-extractor module.
//
// The LLM-driven extractSlots() call is integration-level (hits Anthropic)
// so these tests focus on the pure-function surface:
//   • SlotsSchema accepts the new Phase 4 fields (distance + circuit)
//   • SlotsSchema rejects malformed values (negative distance, bad enum)
//   • mergeSlotUpdates writes from_transcript on first capture and
//     customer_corrected on a subsequent change for the new slots
//   • normaliseState round-trips drafts that carry the new slots
//   • Source attribution behaves identically to existing slots
//   • Verified-flag exemption still applies (regression guard)

import { describe, expect, it } from 'vitest'
import {
  SlotsSchema,
  SlotExtractionSchema,
  EMPTY_STATE,
  mergeSlotUpdates,
  normaliseState,
  extractJsonObject,
  type ConversationState,
} from './extract-slots'

describe('Phase 4: SlotsSchema accepts the new recipe slots', () => {
  it('accepts a numeric distance_to_existing_power', () => {
    const r = SlotsSchema.safeParse({ distance_to_existing_power: 8 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.distance_to_existing_power).toBe(8)
  })

  it('accepts decimal distance', () => {
    const r = SlotsSchema.safeParse({ distance_to_existing_power: 2.5 })
    expect(r.success).toBe(true)
  })

  it('accepts null distance (optional/nullable)', () => {
    const r = SlotsSchema.safeParse({ distance_to_existing_power: null })
    expect(r.success).toBe(true)
  })

  it('rejects a non-numeric distance string', () => {
    // "8 metres" should be parsed by the extractor BEFORE schema validation
    // (the LLM is meant to emit a plain number). A string here is a schema
    // violation, not a recoverable input.
    const r = SlotsSchema.safeParse({ distance_to_existing_power: '8 metres' })
    expect(r.success).toBe(false)
  })

  it('accepts each valid circuit_required value', () => {
    for (const v of ['10A', '20A', 'three-phase', 'unknown'] as const) {
      const r = SlotsSchema.safeParse({ circuit_required: v })
      expect(r.success, `failed for ${v}`).toBe(true)
    }
  })

  it('rejects circuit_required outside the enum', () => {
    const r = SlotsSchema.safeParse({ circuit_required: '15A' })
    expect(r.success).toBe(false)
  })

  it('accepts BOTH new slots alongside existing ones in one update', () => {
    const r = SlotsSchema.safeParse({
      job_type: 'power_points',
      count: 1,
      room: 'garage',
      replace_or_new: 'new',
      distance_to_existing_power: 8,
      circuit_required: '10A',
    })
    expect(r.success).toBe(true)
  })

  it('SlotExtractionSchema (the wire format) accepts the new slots in updates', () => {
    const r = SlotExtractionSchema.safeParse({
      updates: {
        distance_to_existing_power: 15,
        circuit_required: 'three-phase',
      },
      reasoning: 'Customer wants a Tesla wall charger, 15m from switchboard',
    })
    expect(r.success).toBe(true)
  })
})

describe('Phase 4: mergeSlotUpdates handles the new recipe slots', () => {
  it('first capture of distance_to_existing_power → from_transcript source', () => {
    const next = mergeSlotUpdates(EMPTY_STATE, {
      distance_to_existing_power: 8,
    })
    expect(next.slots.distance_to_existing_power).toBe(8)
    expect(next.sources.distance_to_existing_power).toBe('from_transcript')
    expect(next.last_extracted_at).not.toBeNull()
  })

  it('first capture of circuit_required → from_transcript source', () => {
    const next = mergeSlotUpdates(EMPTY_STATE, { circuit_required: '20A' })
    expect(next.slots.circuit_required).toBe('20A')
    expect(next.sources.circuit_required).toBe('from_transcript')
  })

  it('changing distance later → customer_corrected', () => {
    const initial: ConversationState = {
      slots: { distance_to_existing_power: 5 },
      sources: { distance_to_existing_power: 'from_transcript' },
      last_extracted_at: '2026-05-27T00:00:00Z',
    }
    const next = mergeSlotUpdates(initial, {
      distance_to_existing_power: 12,
    })
    expect(next.slots.distance_to_existing_power).toBe(12)
    expect(next.sources.distance_to_existing_power).toBe('customer_corrected')
  })

  it('changing circuit_required later → customer_corrected', () => {
    const initial: ConversationState = {
      slots: { circuit_required: '10A' },
      sources: { circuit_required: 'from_transcript' },
      last_extracted_at: '2026-05-27T00:00:00Z',
    }
    const next = mergeSlotUpdates(initial, { circuit_required: '20A' })
    expect(next.sources.circuit_required).toBe('customer_corrected')
  })

  it('same value re-extracted → no-op, source unchanged', () => {
    const initial: ConversationState = {
      slots: { distance_to_existing_power: 8 },
      sources: { distance_to_existing_power: 'from_transcript' },
      last_extracted_at: '2026-05-27T00:00:00Z',
    }
    const next = mergeSlotUpdates(initial, {
      distance_to_existing_power: 8,
    })
    expect(next.sources.distance_to_existing_power).toBe('from_transcript')
    // last_extracted_at should NOT update on no-op
    expect(next.last_extracted_at).toBe(initial.last_extracted_at)
  })

  it('null update on existing slot → skipped (matches Phase-1 behaviour)', () => {
    const initial: ConversationState = {
      slots: { distance_to_existing_power: 8 },
      sources: { distance_to_existing_power: 'from_transcript' },
      last_extracted_at: '2026-05-27T00:00:00Z',
    }
    const next = mergeSlotUpdates(initial, {
      distance_to_existing_power: null,
    })
    expect(next.slots.distance_to_existing_power).toBe(8)
  })

  it('parallel update of both new slots → both flagged correctly', () => {
    const next = mergeSlotUpdates(EMPTY_STATE, {
      distance_to_existing_power: 15,
      circuit_required: 'three-phase',
    })
    expect(next.sources.distance_to_existing_power).toBe('from_transcript')
    expect(next.sources.circuit_required).toBe('from_transcript')
  })

  it('regression: verified flag still exempt from customer_corrected', () => {
    const initial: ConversationState = {
      slots: { verified: false },
      sources: { verified: 'from_transcript' },
      last_extracted_at: null,
    }
    const next = mergeSlotUpdates(initial, { verified: true })
    expect(next.slots.verified).toBe(true)
    // verified MUST NOT be tagged customer_corrected — it's a handshake
    // flag, not a fact about the customer (long-standing behaviour).
    expect(next.sources.verified).not.toBe('customer_corrected')
  })
})

describe('Phase 4: normaliseState round-trips new slot data', () => {
  it('preserves distance + circuit_required through normalise', () => {
    const raw = {
      slots: {
        distance_to_existing_power: 8,
        circuit_required: '20A',
      },
      sources: {
        distance_to_existing_power: 'from_transcript',
        circuit_required: 'customer_corrected',
      },
      last_extracted_at: '2026-05-27T01:23:45Z',
    }
    const r = normaliseState(raw)
    expect(r.slots.distance_to_existing_power).toBe(8)
    expect(r.slots.circuit_required).toBe('20A')
    expect(r.sources.circuit_required).toBe('customer_corrected')
  })

  it('handles legacy state (no recipe slots) without crashing', () => {
    const raw = {
      slots: { first_name: 'Anant', suburb: 'Chandler' },
      sources: { first_name: 'from_memory', suburb: 'from_memory' },
      last_extracted_at: null,
    }
    const r = normaliseState(raw)
    expect(r.slots.first_name).toBe('Anant')
    expect(r.slots.distance_to_existing_power).toBeUndefined()
    expect(r.slots.circuit_required).toBeUndefined()
  })
})

// 2026-05-27 hotfix tests — covers the generateText + manual JSON
// parse path that replaced generateObject after Anthropic tightened
// tool_use schema-complexity validation.
describe('extractJsonObject — JSON extraction from LLM text output', () => {
  it('returns the JSON unchanged when the response is already a bare object', () => {
    const raw = '{"updates": {"first_name": "Jon"}, "reasoning": "name only"}'
    expect(extractJsonObject(raw)).toBe(raw)
  })

  it('strips leading/trailing whitespace', () => {
    const raw = '  \n  {"updates": {}, "reasoning": "noop"}  \n  '
    expect(extractJsonObject(raw)).toBe('{"updates": {}, "reasoning": "noop"}')
  })

  it('strips markdown fences (```json ... ```)', () => {
    const raw = '```json\n{"updates": {"suburb": "Chandler"}, "reasoning": "suburb only"}\n```'
    expect(extractJsonObject(raw)).toBe(
      '{"updates": {"suburb": "Chandler"}, "reasoning": "suburb only"}',
    )
  })

  it('strips bare ``` fences (no language tag)', () => {
    const raw = '```\n{"updates": {}, "reasoning": "x"}\n```'
    expect(extractJsonObject(raw)).toBe('{"updates": {}, "reasoning": "x"}')
  })

  it('extracts the first balanced JSON object when Sonnet adds preamble', () => {
    const raw =
      "Here's the extraction:\n{\"updates\": {\"first_name\": \"Anant\"}, \"reasoning\": \"name\"}\n\nLet me know if you need more.";
    const out = extractJsonObject(raw)
    expect(out).toBe('{"updates": {"first_name": "Anant"}, "reasoning": "name"}')
  })

  it('handles nested JSON objects (balanced-brace tracking)', () => {
    const raw =
      '{"updates": {"first_name": "Jon", "nested": {"inner": "value"}}, "reasoning": "test"}'
    expect(extractJsonObject(raw)).toBe(raw)
  })

  it('handles deeply nested objects without truncating early', () => {
    const raw =
      'Preamble. {"updates": {"a": {"b": {"c": "d"}}}, "reasoning": "nested"} trailing'
    const out = extractJsonObject(raw)
    // The extracted JSON should round-trip cleanly through JSON.parse.
    expect(out).not.toBeNull()
    if (!out) return
    const parsed = JSON.parse(out)
    expect(parsed.updates.a.b.c).toBe('d')
  })

  it('returns null on empty/whitespace input', () => {
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject('   ')).toBeNull()
  })

  it('returns null when no JSON object is present', () => {
    expect(extractJsonObject('Sorry, I cannot extract that.')).toBeNull()
    expect(extractJsonObject('[1, 2, 3]')).toBeNull() // array, not object
  })

  it('returns null on unbalanced braces', () => {
    expect(extractJsonObject('{"unterminated": "value"')).toBeNull()
  })

  it('handles non-string inputs gracefully', () => {
    expect(extractJsonObject(null as unknown as string)).toBeNull()
    expect(extractJsonObject(undefined as unknown as string)).toBeNull()
  })

  it('output round-trips through JSON.parse for the SlotExtractionSchema', () => {
    const raw =
      '```json\n{"updates": {"first_name": "Anant", "suburb": "Chandler", "count": 4}, "reasoning": "name + suburb + count"}\n```'
    const json = extractJsonObject(raw)
    expect(json).not.toBeNull()
    if (!json) return
    const parsed = SlotExtractionSchema.parse(JSON.parse(json))
    expect(parsed.updates.first_name).toBe('Anant')
    expect(parsed.updates.suburb).toBe('Chandler')
    expect(parsed.updates.count).toBe(4)
    expect(parsed.reasoning).toBe('name + suburb + count')
  })
})
