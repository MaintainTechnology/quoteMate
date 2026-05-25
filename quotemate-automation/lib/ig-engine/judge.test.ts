// Item 2 — the judge's pure logic decides whether a render is retried
// and what defect feedback the retry receives. A wrong parse either
// discards a good image or loops forever, so parsing, the prompt shape,
// and the feedback builder all need coverage.

import { describe, expect, it } from 'vitest'
import {
  buildJudgePrompt,
  defectFeedback,
  isClaudeJudgeModel,
  parsePreviewJudgement,
  verifyMaxRetries,
} from './judge'

describe('parsePreviewJudgement', () => {
  it('parses a clean all-pass JSON judgement', () => {
    const j = parsePreviewJudgement(
      '{"count_seen":6,"count_ok":true,"product_ok":true,"position_ok":true,"existing_removed_ok":true,"defects":[]}',
    )
    expect(j.pass).toBe(true)
    expect(j.countSeen).toBe(6)
    expect(j.countOk).toBe(true)
    expect(j.defects).toEqual([])
  })

  it('fails the judgement when any check is explicitly false', () => {
    const j = parsePreviewJudgement(
      '{"count_seen":7,"count_ok":false,"product_ok":true,"position_ok":true,"existing_removed_ok":true,"defects":["7 downlights, expected 6"]}',
    )
    expect(j.pass).toBe(false)
    expect(j.countSeen).toBe(7)
    expect(j.countOk).toBe(false)
    expect(j.defects).toContain('7 downlights, expected 6')
  })

  it('treats null checks as not-assessed — they do not fail the judgement', () => {
    const j = parsePreviewJudgement(
      '{"count_ok":true,"product_ok":true,"position_ok":null,"existing_removed_ok":null,"defects":[]}',
    )
    expect(j.pass).toBe(true)
    expect(j.positionOk).toBeNull()
    expect(j.existingRemovedOk).toBeNull()
  })

  it('tolerates markdown fences and surrounding prose', () => {
    const j = parsePreviewJudgement(
      'Here is my assessment:\n```json\n{"count_ok":false,"product_ok":true,"defects":["wrong"]}\n```\nDone.',
    )
    expect(j.pass).toBe(false)
    expect(j.countOk).toBe(false)
  })

  it('coerces string booleans and numbers', () => {
    const j = parsePreviewJudgement(
      '{"count_seen":"5","count_ok":"no","product_ok":"yes","defects":[]}',
    )
    expect(j.countSeen).toBe(5)
    expect(j.countOk).toBe(false)
    expect(j.productOk).toBe(true)
  })

  it('returns inconclusive (pass=true) — never a false reject — when unreadable', () => {
    expect(parsePreviewJudgement('').pass).toBe(true)
    expect(parsePreviewJudgement(undefined).pass).toBe(true)
    expect(parsePreviewJudgement('no json here at all').pass).toBe(true)
    expect(parsePreviewJudgement('{not valid json}').pass).toBe(true)
    expect(parsePreviewJudgement('[1,2,3]').pass).toBe(true)
    // and every check field is null on an inconclusive parse
    expect(parsePreviewJudgement('').countOk).toBeNull()
  })

  it('drops non-string and blank defect entries', () => {
    const j = parsePreviewJudgement(
      '{"count_ok":false,"defects":["real defect","",null,42,"  spaced  "]}',
    )
    expect(j.defects).toEqual(['real defect', 'spaced'])
  })
})

describe('buildJudgePrompt', () => {
  it('asks for the expected count and product name and JSON shape', () => {
    const p = buildJudgePrompt({
      expectedCount: 6,
      productName: 'Dimmable LED downlight (Brilliant)',
      isReplacement: true,
      hasProductRef: true,
    })
    expect(p).toContain('exactly 6')
    expect(p).toContain('Dimmable LED downlight (Brilliant)')
    expect(p).toContain('"count_ok"')
    expect(p).toContain('"existing_removed_ok": <true|false>')
    expect(p).toContain('SECOND image')
  })

  it('nulls out existing_removed_ok for a non-replacement job', () => {
    const p = buildJudgePrompt({
      expectedCount: 3,
      productName: null,
      isReplacement: false,
      hasProductRef: false,
    })
    expect(p).toContain('"existing_removed_ok": null')
    expect(p).not.toContain('SECOND image')
  })
})

describe('defectFeedback', () => {
  it('returns empty string when the judgement passed', () => {
    const j = parsePreviewJudgement(
      '{"count_ok":true,"product_ok":true,"position_ok":true,"existing_removed_ok":true,"defects":[]}',
    )
    expect(defectFeedback(j)).toBe('')
  })

  it('names the count defect with the wrong number seen', () => {
    const j = parsePreviewJudgement(
      '{"count_seen":8,"count_ok":false,"defects":[]}',
    )
    const fb = defectFeedback(j)
    expect(fb).toContain('STRICT RE-RENDER')
    expect(fb).toContain('8 fitting')
    expect(fb).toContain('COUNT WRONG')
  })

  it('names the existing-fitting-not-removed defect', () => {
    const j = parsePreviewJudgement(
      '{"count_ok":true,"existing_removed_ok":false,"defects":[]}',
    )
    const fb = defectFeedback(j)
    expect(fb).toContain('OLD FITTING STILL PRESENT')
  })

  it('includes free-text defects from the judge', () => {
    const j = parsePreviewJudgement(
      '{"count_ok":false,"defects":["downlight floating off the ceiling"]}',
    )
    expect(defectFeedback(j)).toContain('downlight floating off the ceiling')
  })
})

describe('verifyMaxRetries', () => {
  it('defaults to 2 when the env var is unset or invalid', () => {
    const prev = process.env.PREVIEW_VERIFY_MAX_RETRIES
    delete process.env.PREVIEW_VERIFY_MAX_RETRIES
    expect(verifyMaxRetries()).toBe(2)
    process.env.PREVIEW_VERIFY_MAX_RETRIES = 'abc'
    expect(verifyMaxRetries()).toBe(2)
    process.env.PREVIEW_VERIFY_MAX_RETRIES = '99'
    expect(verifyMaxRetries()).toBe(2) // out of range → default
    if (prev === undefined) delete process.env.PREVIEW_VERIFY_MAX_RETRIES
    else process.env.PREVIEW_VERIFY_MAX_RETRIES = prev
  })

  it('honours a valid in-range override', () => {
    const prev = process.env.PREVIEW_VERIFY_MAX_RETRIES
    process.env.PREVIEW_VERIFY_MAX_RETRIES = '3'
    expect(verifyMaxRetries()).toBe(3)
    process.env.PREVIEW_VERIFY_MAX_RETRIES = '0'
    expect(verifyMaxRetries()).toBe(0)
    if (prev === undefined) delete process.env.PREVIEW_VERIFY_MAX_RETRIES
    else process.env.PREVIEW_VERIFY_MAX_RETRIES = prev
  })
})

describe('isClaudeJudgeModel', () => {
  it('routes Claude model ids to the AI SDK judge', () => {
    expect(isClaudeJudgeModel('claude-sonnet-4-6')).toBe(true)
    expect(isClaudeJudgeModel('claude-opus-4-7')).toBe(true)
    expect(isClaudeJudgeModel('claude-haiku-4-5-20251001')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isClaudeJudgeModel('CLAUDE-sonnet-4-6')).toBe(true)
  })

  it('treats Gemini and other ids as the Gemini judge', () => {
    expect(isClaudeJudgeModel('gemini-3-pro-image-preview')).toBe(false)
    expect(isClaudeJudgeModel('gemini-2.5-flash')).toBe(false)
    expect(isClaudeJudgeModel('')).toBe(false)
  })
})
