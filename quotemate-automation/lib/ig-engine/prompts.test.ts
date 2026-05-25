// Item 1 — the pruned V2 preview prompt. The whole point of the prune
// is a short, high-signal instruction set: this suite locks in the
// word-count ceiling, the absence of text-LLM cargo-culting, and that
// the high-signal facts (count, anchor product) survived. Item 3's
// removal prompt and the replacement detector are covered here too.

import { describe, expect, it } from 'vitest'
import {
  buildPreviewPrompt,
  buildPreviewPromptV2,
  buildRemovalPrompt,
  isReplacementJob,
  type PromptContext,
} from './prompts'

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

// Cargo-culted text-LLM phrases an image model cannot act on — these
// must NOT survive into the pruned V2 prompt.
const CARGO_CULT = [
  'out loud',
  'redraft',
  'self-verify',
  'mentally',
  'verify_before_emit',
]

function ctx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    intake: {
      job_type: 'downlights',
      scope: {
        item_count: 6,
        is_new_install: false,
        description: 'replace the old downlights in the lounge room',
        specs: { color_temp: 'warm_white' },
      },
      access: { ceiling_type: 'flat' },
      caller: { name: 'Sarah' },
    },
    quote: { selected_tier: 'better', needs_inspection: false },
    lineItems: [
      {
        tier: 'better',
        description: '6 × Dimmable LED downlight (Brilliant)',
        quantity: 6,
        source: 'material',
      },
    ],
    corrections: [],
    ...overrides,
  }
}

describe('buildPreviewPromptV2 — pruned prompt', () => {
  it('stays within the 600-word ceiling', () => {
    const p = buildPreviewPromptV2(ctx())
    const total = wordCount(p.system) + wordCount(p.user)
    expect(total).toBeLessThanOrEqual(600)
    expect(total).toBeGreaterThan(120) // still substantive
  })

  it('is dramatically shorter than the legacy V1 prompt', () => {
    const v1 = buildPreviewPrompt(ctx())
    const v2 = buildPreviewPromptV2(ctx())
    const v1Words = wordCount(v1.system) + wordCount(v1.user)
    const v2Words = wordCount(v2.system) + wordCount(v2.user)
    expect(v2Words).toBeLessThan(v1Words)
  })

  it('keeps the high-signal facts: exact count and the anchor product', () => {
    const p = buildPreviewPromptV2(ctx())
    expect(p.system).toContain('6') // the count
    expect(p.system).toContain('downlights')
    expect(p.system).toContain('Brilliant') // the anchor product name
  })

  it('drops text-LLM cargo-culting phrases', () => {
    const p = buildPreviewPromptV2(ctx())
    const blob = `${p.system}\n${p.user}`.toLowerCase()
    for (const phrase of CARGO_CULT) {
      expect(blob).not.toContain(phrase)
    }
  })

  it('flags a replacement job so the old fitting gets removed', () => {
    const p = buildPreviewPromptV2(ctx())
    expect(p.system.toLowerCase()).toContain('replacement')
  })

  it('still produces a prompt when there is no anchor or count', () => {
    const bare = buildPreviewPromptV2(
      ctx({
        intake: { job_type: 'power_points', caller: { name: 'Joe' } },
        lineItems: [],
      }),
    )
    expect(bare.system.length).toBeGreaterThan(0)
    expect(bare.user.length).toBeGreaterThan(0)
  })
})

describe('buildRemovalPrompt — two-pass pass 1', () => {
  it('instructs removal of the existing fittings only', () => {
    const p = buildRemovalPrompt(ctx())
    expect(p.system.toLowerCase()).toContain('remove')
    expect(p.system).toContain('downlights')
    expect(p.user.toLowerCase()).toContain('removal only')
  })

  it('explicitly forbids installing anything new in pass 1', () => {
    const p = buildRemovalPrompt(ctx())
    expect(p.system.toLowerCase()).toContain('only removes')
  })

  it('is short and single-purpose', () => {
    const p = buildRemovalPrompt(ctx())
    expect(wordCount(p.system)).toBeLessThan(180)
  })
})

describe('isReplacementJob', () => {
  it('is true when is_new_install is explicitly false', () => {
    expect(isReplacementJob(ctx())).toBe(true)
  })

  it('is false for a new install', () => {
    expect(
      isReplacementJob(
        ctx({
          intake: {
            job_type: 'downlights',
            scope: { item_count: 6, is_new_install: true },
            caller: { name: 'Sarah' },
          },
        }),
      ),
    ).toBe(false)
  })

  it('is false when is_new_install is unknown (null/undefined)', () => {
    expect(
      isReplacementJob(
        ctx({
          intake: {
            job_type: 'downlights',
            scope: { item_count: 6 },
            caller: { name: 'Sarah' },
          },
        }),
      ),
    ).toBe(false)
  })
})
