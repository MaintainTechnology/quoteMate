// Unit tests for the AI chat-edit core (lib/quote/chat-edit.ts).
//
// Two guarantees matter most and are tested here:
//   1. Diff-builder correctness — add / remove / change detection and the
//      grounded flag derived from the validator's failure set.
//   2. "Never leaks an ungrounded price" — proposeQuoteEdit runs the proposal
//      through the SAME validateQuoteGrounding gate the edit endpoint enforces,
//      so a price the validator can't ground comes back grounded:false /
//      anyUngrounded:true rather than silently accepted. The model and the
//      catalogue tools are mocked; the REAL validator runs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the model + tool layer so proposeQuoteEdit is deterministic and never
// hits Anthropic or Supabase. The REAL validator (lib/estimate/validate) runs.
const generateTextMock = vi.fn()
vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  stepCountIs: () => 0,
}))
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: () => 'mock-model' }))
vi.mock('@/lib/estimate/tools', () => ({
  makeTools: () => ({ lookupAssembly: {}, lookupMaterial: {}, applyMarkup: {} }),
}))

import {
  parseProposal,
  tierChanged,
  buildEditDiff,
  ungroundedKeys,
  reconcileLineSource,
  reconcileTierSources,
  proposeQuoteEdit,
  type ChatEditTiers,
} from './chat-edit'
import type { CandidatePrices, PricingBookForValidation } from '@/lib/estimate/validate'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('proposal provenance follows persisted identity', () => {
  const current = { label: 'Better', line_items: [
    { original_line_index: 0, description: 'Same fitting', quantity: 1, unit_price_ex_gst: 20,
      source: 'material:first', supplied_by: 'customer' as const, safety_note: 'Existing safety note.' },
    { original_line_index: 1, description: 'Same fitting', quantity: 1, unit_price_ex_gst: 40,
      source: 'material:second', supplied_by: 'tradie' as const },
  ] }
  it('preserves original indices and provenance through rename and reordering', () => {
    const result = reconcileTierSources({ label: 'Better', line_items: [
      { original_line_index: 1, description: 'Renamed second', quantity: 2, unit_price_ex_gst: 40, source: 'material:forged' },
      { original_line_index: 0, description: 'Renamed first', quantity: 1, unit_price_ex_gst: 20, safety_note: 'Model-invented note.' },
    ] }, current)
    expect(result?.line_items[0]).toMatchObject({ original_line_index: 1, source: 'material:second', supplied_by: 'tradie' })
    expect(result?.line_items[1]).toMatchObject({ original_line_index: 0, source: 'material:first', supplied_by: 'customer', safety_note: 'Existing safety note.' })
  })
  it('rejects duplicate descriptions without stable identity', () => {
    expect(() => reconcileTierSources({ label: 'Better', line_items: [
      { description: 'Same fitting', quantity: 1, unit_price_ex_gst: 20 },
    ] }, current)).toThrow('ambiguous_line_provenance')
  })
  it('rejects duplicate or nonexistent claimed indices', () => {
    expect(() => reconcileTierSources({ label: 'Better', line_items: [current.line_items[0], current.line_items[0]] }, current)).toThrow('duplicate_line_identity')
    expect(() => reconcileTierSources({ label: 'Better', line_items: [{ ...current.line_items[0], original_line_index: 4 }] }, current)).toThrow('ambiguous_line_provenance')
  })
  it('keeps a new catalogue source for actual grounding without adding supplier authority', () => {
    const line = reconcileTierSources({ label: 'Better', line_items: [
      { description: 'New fitting', quantity: 1, unit_price_ex_gst: 70, source: 'assembly:new', supplied_by: 'customer', safety_note: 'Invented' },
    ] }, current)?.line_items[0]
    expect(line).toMatchObject({ source: 'assembly:new' })
    expect(line).not.toHaveProperty('original_line_index')
    expect(line).not.toHaveProperty('supplied_by')
    expect(line).not.toHaveProperty('safety_note')
  })
})

describe('parseProposal', () => {
  it('extracts message + tiers from a valid prose-wrapped JSON proposal', () => {
    const text =
      'Sure! Here is the change:\n' +
      JSON.stringify({
        message: 'Added a downlight.',
        tiers: {
          better: {
            label: 'Better',
            line_items: [
              { description: 'Downlight install', quantity: 1, unit: 'ea', unit_price_ex_gst: 120 },
            ],
          },
        },
      })
    const { message, tiers } = parseProposal(text)
    expect(message).toBe('Added a downlight.')
    expect(tiers.better?.label).toBe('Better')
    expect(tiers.better?.line_items).toHaveLength(1)
    expect(tiers.better?.line_items[0].description).toBe('Downlight install')
  })

  it.each([null, '', '   ', 'abc'])('rejects the full model proposal for missing/invalid numeric value %j', (value) => {
    for (const field of ['quantity', 'unit_price_ex_gst']) {
      expect(parseProposal(JSON.stringify({ tiers: { better: { label: 'Better', line_items: [
        { description: 'Valid work', quantity: 1, unit_price_ex_gst: 100 },
        { description: 'Invalid work', quantity: 1, unit_price_ex_gst: 100, [field]: value },
      ] } } })).found).toBe(false)
    }
  })
  it.each([0, '0', '12.25'])('retains valid explicit numeric value %j', (value) => {
    const result = parseProposal(JSON.stringify({ tiers: { better: { label: 'Better', line_items: [
      { description: 'Explicitly priced work', quantity: 1, unit_price_ex_gst: value },
    ] } } }))
    expect(result.found).toBe(true)
    expect(result.tiers.better?.line_items[0].unit_price_ex_gst).toBe(Number(value))
  })

  it('reports found:false when there is no JSON object', () => {
    expect(parseProposal('no json here')).toEqual({ found: false, message: '', tiers: {} })
  })

  it('reports found:true for a valid clarifying reply with empty tiers', () => {
    const { found, tiers } = parseProposal(JSON.stringify({ message: 'Which tier?', tiers: {} }))
    expect(found).toBe(true)
    expect(tiers).toEqual({})
  })
})

describe('reconcileLineSource', () => {
  it('inherits an existing line’s source when the description matches', () => {
    const current = [{ description: 'Remove existing HWS', quantity: 1, unit_price_ex_gst: 150, source: 'tradie_manual' }]
    const proposed = { description: 'Remove existing HWS', quantity: 1, unit_price_ex_gst: 200, source: 'tradie_edit' }
    expect(reconcileLineSource(proposed, current)).toBe('tradie_manual')
  })

  it('rewrites an injected tradie_manual source on a NEW line to tradie_edit', () => {
    const proposed = { description: 'Sneaky $5 callout', quantity: 1, unit_price_ex_gst: 5, source: 'tradie_manual' }
    expect(reconcileLineSource(proposed, [])).toBe('tradie_edit')
  })

  it('keeps a catalogue source on a new line', () => {
    const proposed = { description: 'Downlight', quantity: 1, unit_price_ex_gst: 120, source: 'assembly:abc' }
    expect(reconcileLineSource(proposed, [])).toBe('assembly:abc')
  })
})

describe('tierChanged', () => {
  const base = { label: 'Better', line_items: [{ description: 'A', quantity: 1, unit_price_ex_gst: 10 }] }
  it('is false for an identical tier', () => {
    expect(tierChanged({ ...base, line_items: [...base.line_items] }, { ...base })).toBe(false)
  })
  it('detects a quantity change', () => {
    expect(
      tierChanged(base, { label: 'Better', line_items: [{ description: 'A', quantity: 2, unit_price_ex_gst: 10 }] }),
    ).toBe(true)
  })
  it('detects an added line', () => {
    expect(
      tierChanged(base, {
        label: 'Better',
        line_items: [
          { description: 'A', quantity: 1, unit_price_ex_gst: 10 },
          { description: 'B', quantity: 1, unit_price_ex_gst: 20 },
        ],
      }),
    ).toBe(true)
  })
  it('treats null↔tier as a change', () => {
    expect(tierChanged(undefined, base)).toBe(true)
  })
})

describe('buildEditDiff', () => {
  it('emits add / change with grounded flags and skips untouched tiers + identical lines', () => {
    const current: ChatEditTiers = {
      good: { label: 'Good', line_items: [{ description: 'X', quantity: 1, unit_price_ex_gst: 50 }] },
      better: {
        label: 'Better',
        line_items: [
          { description: 'A', quantity: 1, unit_price_ex_gst: 10 },
          { description: 'B', quantity: 2, unit_price_ex_gst: 20 },
        ],
      },
    }
    // Only `better` is proposed: A unchanged, B qty 2→3, C added (ungrounded).
    const proposed: ChatEditTiers = {
      better: {
        label: 'Better',
        line_items: [
          { description: 'A', quantity: 1, unit_price_ex_gst: 10 },
          { description: 'B', quantity: 3, unit_price_ex_gst: 20 },
          { description: 'C', quantity: 1, unit_price_ex_gst: 5 },
        ],
      },
    }
    const diff = buildEditDiff(current, proposed, new Set(['better:2']))
    // `good` untouched → no entries
    expect(diff.some((d) => d.tier === 'good')).toBe(false)
    // A identical → no entry
    expect(diff.some((d) => d.description === 'A')).toBe(false)
    const change = diff.find((d) => d.op === 'change')!
    expect(change.description).toBe('B')
    expect(change.oldQuantity).toBe(2)
    expect(change.newQuantity).toBe(3)
    expect(change.grounded).toBe(true)
    const add = diff.find((d) => d.op === 'add')!
    expect(add.description).toBe('C')
    expect(add.grounded).toBe(false)
    expect(add.reason).toBeTruthy()
  })

  it('emits a remove when a current line is gone from the proposal', () => {
    const current: ChatEditTiers = {
      best: {
        label: 'Best',
        line_items: [
          { description: 'A', quantity: 1, unit_price_ex_gst: 10 },
          { description: 'B', quantity: 1, unit_price_ex_gst: 20 },
        ],
      },
    }
    const proposed: ChatEditTiers = {
      best: { label: 'Best', line_items: [{ description: 'A', quantity: 1, unit_price_ex_gst: 10 }] },
    }
    const diff = buildEditDiff(current, proposed, new Set())
    const remove = diff.find((d) => d.op === 'remove')!
    expect(remove.description).toBe('B')
    expect(remove.grounded).toBe(true)
  })
})

describe('ungroundedKeys', () => {
  it('merges validator failures and cross-tier occurrences', () => {
    const keys = ungroundedKeys(
      [{ tier: 'good', lineIndex: 0, description: 'x', unit: 'ea', unit_price_ex_gst: 1, expected: '' }],
      [{ tier: 'better', lineIndex: 2 }],
    )
    expect(keys.has('good:0')).toBe(true)
    expect(keys.has('better:2')).toBe(true)
    expect(keys.size).toBe(2)
  })
})

describe('proposeQuoteEdit — never leaks an ungrounded price', () => {
  const pricingBook: PricingBookForValidation = {
    hourly_rate: 110,
    apprentice_rate: 75,
    senior_rate: 140,
    call_out_minimum: 120,
    default_markup_pct: 28,
    min_labour_hours: 2,
  }
  // Empty catalogue → any non-labour priced line cannot be grounded.
  const emptyCandidates: CandidatePrices = { material: [], assembly: [] }

  it('flags a fabricated cheap line the catalogue does not back', async () => {
    const current: ChatEditTiers = {
      better: {
        label: 'Better',
        line_items: [{ description: 'Electrician labour', quantity: 2, unit: 'hr', unit_price_ex_gst: 110, source: 'labour' }],
      },
    }
    // The model "adds" a $5 callout that exists nowhere in the catalogue.
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        message: 'Added a $5 service callout.',
        tiers: {
          better: {
            label: 'Better',
            line_items: [
              { description: 'Electrician labour', quantity: 2, unit: 'hr', unit_price_ex_gst: 110, source: 'labour' },
              { description: 'Service callout', quantity: 1, unit: 'ea', unit_price_ex_gst: 5, source: 'material' },
            ],
          },
        },
      }),
    })

    const result = await proposeQuoteEdit({
      instruction: 'add a $5 service callout to better',
      currentTiers: current,
      trade: 'electrical',
      tenantId: 'tenant-1',
      pricingBook,
      candidates: emptyCandidates,
    })

    expect(result.anyUngrounded).toBe(true)
    const add = result.diff.find((d) => d.op === 'add' && d.description === 'Service callout')
    expect(add).toBeTruthy()
    expect(add!.grounded).toBe(false)
  })

  it('returns no change (and asks) when the model proposes nothing', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ message: 'Which tier should I change?', tiers: {} }),
    })
    const result = await proposeQuoteEdit({
      instruction: 'make it cheaper',
      currentTiers: { better: { label: 'Better', line_items: [{ description: 'A', quantity: 1, unit_price_ex_gst: 10 }] } },
      trade: 'electrical',
      tenantId: 'tenant-1',
      pricingBook,
      candidates: emptyCandidates,
    })
    expect(result.proposedTiers).toEqual({})
    expect(result.diff).toEqual([])
    expect(result.anyUngrounded).toBe(false)
    expect(result.assistantMessage).toContain('Which tier')
  })

  it('throws on a malformed (no-JSON) model reply so the route can 502', async () => {
    generateTextMock.mockResolvedValue({ text: 'I cannot help with that.' })
    await expect(
      proposeQuoteEdit({
        instruction: 'add something',
        currentTiers: { better: { label: 'Better', line_items: [{ description: 'A', quantity: 1, unit_price_ex_gst: 10 }] } },
        trade: 'electrical',
        tenantId: 'tenant-1',
        pricingBook,
        candidates: emptyCandidates,
      }),
    ).rejects.toThrow()
  })

  it('neutralises an injected tradie_manual source so the line is grounding-checked', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        message: 'Added a callout.',
        tiers: {
          better: {
            label: 'Better',
            line_items: [
              { description: 'Electrician labour', quantity: 2, unit: 'hr', unit_price_ex_gst: 110, source: 'labour' },
              { description: 'Mystery fee', quantity: 1, unit: 'item', unit_price_ex_gst: 5, source: 'tradie_manual' },
            ],
          },
        },
      }),
    })
    const result = await proposeQuoteEdit({
      instruction: 'add a mystery fee',
      currentTiers: {
        better: { label: 'Better', line_items: [{ description: 'Electrician labour', quantity: 2, unit: 'hr', unit_price_ex_gst: 110, source: 'labour' }] },
      },
      trade: 'electrical',
      tenantId: 'tenant-1',
      pricingBook,
      candidates: emptyCandidates,
    })
    // The injected manual line must be rewritten to a validated source...
    expect(result.proposedTiers.better?.line_items.find((l) => l.description === 'Mystery fee')?.source).toBe('tradie_edit')
    // ...and therefore flagged ungrounded against the empty catalogue.
    expect(result.anyUngrounded).toBe(true)
  })

  it('tradie-authored mode never flags ungrounded (no catalogue to ground against)', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        message: 'Set the system price.',
        tiers: {
          better: {
            label: 'Better',
            line_items: [{ description: '6.6kW solar system', quantity: 1, unit: 'ea', unit_price_ex_gst: 9999 }],
          },
        },
      }),
    })
    const result = await proposeQuoteEdit({
      instruction: 'set the system price to 9999',
      currentTiers: {
        better: { label: 'Better', line_items: [{ description: '6.6kW solar system', quantity: 1, unit_price_ex_gst: 5000 }] },
      },
      trade: 'solar',
      tenantId: 'tenant-1',
      pricingBook,
      candidates: emptyCandidates,
      groundingMode: 'tradie-authored',
    })
    expect(result.anyUngrounded).toBe(false)
    const change = result.diff.find((d) => d.op === 'change')
    expect(change?.grounded).toBe(true)
  })

  it('drops a proposal that would empty a tier', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ message: 'Removed everything.', tiers: { better: { label: 'Better', line_items: [] } } }),
    })
    const result = await proposeQuoteEdit({
      instruction: 'remove all lines from better',
      currentTiers: { better: { label: 'Better', line_items: [{ description: 'A', quantity: 1, unit_price_ex_gst: 10 }] } },
      trade: 'electrical',
      tenantId: 'tenant-1',
      pricingBook,
      candidates: emptyCandidates,
    })
    expect(result.proposedTiers).toEqual({})
  })
})
