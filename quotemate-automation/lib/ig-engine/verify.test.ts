// WP4 step 4 — the verdict parser is the only logic that decides
// whether a render is rejected. It must read Gemini's YES/NO answer
// robustly and, crucially, fall back to "inconclusive" (never a false
// reject) when the answer is unreadable — so verification can never
// discard a good render on a parsing quirk.

import { describe, expect, it } from 'vitest'
import { parseVerificationVerdict } from './verify'

describe('parseVerificationVerdict', () => {
  it('reads a leading YES as a match', () => {
    expect(parseVerificationVerdict('YES — same Caroma Liano tap.').match).toBe(true)
    expect(parseVerificationVerdict('Yes, identical product.').match).toBe(true)
    expect(parseVerificationVerdict('**YES**. Matches.').match).toBe(true)
  })
  it('reads a leading NO as a mismatch', () => {
    expect(parseVerificationVerdict('NO - this is a generic tap, not Caroma Liano.').match).toBe(false)
    expect(parseVerificationVerdict('no. different finish.').match).toBe(false)
  })
  it('keeps a short readable reason', () => {
    const v = parseVerificationVerdict('NO, the rendered tap is chrome but the product is matte black.')
    expect(v.match).toBe(false)
    expect(v.reason).toContain('matte black')
  })
  it('detects an explicit mismatch phrase without a leading NO', () => {
    expect(parseVerificationVerdict('These are different products.').match).toBe(false)
    expect(parseVerificationVerdict('mismatch — wrong model').match).toBe(false)
  })
  it('returns inconclusive (null) — never a false reject — when unreadable', () => {
    expect(parseVerificationVerdict('').match).toBeNull()
    expect(parseVerificationVerdict(undefined).match).toBeNull()
    expect(parseVerificationVerdict('Hmm, hard to tell from this angle, possibly.').match).toBeNull()
  })
})
