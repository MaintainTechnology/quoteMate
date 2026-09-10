import { describe, expect, it } from 'vitest'
import { quoteAlreadyDrafted } from './quote-already-drafted'

describe('saved quote completion', () => {
  it('never carries a prior quote into a new conversation', () => {
    expect(quoteAlreadyDrafted('new', { quote_id: 'old-quote', status: 'done' })).toBe(false)
  })
  it('does not confuse intake insertion, structuring or goodbye with saved quote', () => {
    for (const prior of [null, undefined, { intake_id: 'intake-1' }, { status: 'structuring' }, { status: 'done' }, { quote_stage: 'estimate_pending', intake_id: 'intake-1' }]) {
      expect(quoteAlreadyDrafted('reuse', prior)).toBe(false)
      expect(quoteAlreadyDrafted('inflight', prior)).toBe(false)
    }
  })
  it('recognises a persisted quote while review or delivery is still pending', () => {
    for (const stage of ['awaiting_review','send_failed','delivered']) {
      expect(quoteAlreadyDrafted('reuse', { quote_id: 'saved-quote', quote_stage: stage })).toBe(true)
    }
  })
})
