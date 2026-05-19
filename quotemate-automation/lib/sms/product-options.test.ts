// WP9 pure-core coverage — proves every rule the spec insists on
// (operator-only, exactly two Good/Better, preferred tie-break, safe
// reply parsing, 320-char SMS cap) before the flag-gated route wiring.

import { describe, expect, it } from 'vitest'
import {
  selectProductOptions,
  buildProductOptionsSms,
  buildChoiceHoldSms,
  interpretChoiceReply,
  recommendedOption,
  applyChoiceSelection,
  categoryForJobType,
  describeChosenProductDirective,
  chosenProductFromChoice,
  type ProductOption,
  type ProductChoiceState,
} from './product-options'
import type { TenantMaterial } from '@/lib/estimate/catalogue'

const taps: TenantMaterial[] = [
  { id: 'P-good', category: 'tap', name: 'Clipsal 2000 Tap', brand: 'Clipsal', range_series: '2000', unit_price_ex_gst: 120, image_path: 'g.jpg', active: true },
  { id: 'P-better', category: 'tap', name: 'Caroma Liano Tap', brand: 'Caroma', range_series: 'Liano', unit_price_ex_gst: 150, image_path: 'b.jpg', active: true, is_preferred: true },
  { id: 'P-off', category: 'tap', name: 'Disabled Tap', unit_price_ex_gst: 1, active: false },
  { id: 'P-other', category: 'toilet', name: 'A Toilet', unit_price_ex_gst: 300, active: true },
]

describe('selectProductOptions', () => {
  it('returns exactly two operator options, cheapest=Good dearest=Better', () => {
    const r = selectProductOptions(taps, 'tap')
    expect(r).not.toBeNull()
    const [good, better] = r!
    expect(good.name).toBe('Clipsal 2000 Tap')
    expect(good.tier).toBe('good')
    expect(better.name).toBe('Caroma Liano Tap')
    expect(better.tier).toBe('better')
    expect(good.price_ex_gst).toBeLessThanOrEqual(better.price_ex_gst)
  })
  it('uses ONLY operator catalogue rows (skips inactive / wrong category / no id / bad price)', () => {
    const r = selectProductOptions(taps, 'tap')!
    const names = r.map((o) => o.name)
    expect(names).not.toContain('Disabled Tap')
    expect(names).not.toContain('A Toilet')
  })
  it('offers the SINGLE product when the tradie only has one (not null)', () => {
    const r = selectProductOptions([taps[0]], 'tap')
    expect(r).toHaveLength(1)
    expect(r![0].name).toBe('Clipsal 2000 Tap')
    expect(r![0].tier).toBe('good')
  })
  it('returns null only when there are NO products for the category', () => {
    expect(selectProductOptions(taps, 'fan')).toBeNull()
    expect(selectProductOptions([], 'tap')).toBeNull()
  })
  it('de-dupes by product name → single option when only one distinct', () => {
    const dup: TenantMaterial[] = [
      { id: 'a', category: 'tap', name: 'Same Tap', unit_price_ex_gst: 100, active: true },
      { id: 'b', category: 'tap', name: 'same tap', unit_price_ex_gst: 200, active: true },
    ]
    expect(selectProductOptions(dup, 'tap')).toHaveLength(1)
  })
  it('prefers is_preferred when prices tie', () => {
    const tie: TenantMaterial[] = [
      { id: 'plain', category: 'tap', name: 'Plain', unit_price_ex_gst: 100, active: true },
      { id: 'goto', category: 'tap', name: 'Go-To', unit_price_ex_gst: 100, active: true, is_preferred: true },
      { id: 'top', category: 'tap', name: 'Top', unit_price_ex_gst: 180, active: true },
    ]
    const r = selectProductOptions(tie, 'tap')!
    expect(r[0].name).toBe('Go-To') // preferred wins the Good slot on the price tie
  })
})

describe('buildProductOptionsSms', () => {
  const opts = selectProductOptions(taps, 'tap')!
  it('includes both prices, a 1/2 instruction and the link', () => {
    const sms = buildProductOptionsSms(opts, 'https://qm.co/q/choose/abc', 'tap')
    expect(sms).toContain('$120')
    expect(sms).toContain('$150')
    expect(sms).toMatch(/reply 1, 2, or "you pick"/i) // 1/2 + defer instruction
    expect(sms).toContain('https://qm.co/q/choose/abc')
  })
  it('never exceeds the dialog 320-char reply cap even with huge names', () => {
    const huge: [ProductOption, ProductOption] = [
      { ...opts[0], name: 'X'.repeat(400) },
      { ...opts[1], name: 'Y'.repeat(400) },
    ]
    const sms = buildProductOptionsSms(huge, 'https://qm.co/q/choose/abcdefgh', 'tap')
    expect(sms.length).toBeLessThanOrEqual(320)
    expect(sms).toContain('https://qm.co/q/choose/abcdefgh')
  })
})

describe('buildChoiceHoldSms', () => {
  it('is a short pick-prompt, well under the SMS cap, no "quote on its way"', () => {
    const s = buildChoiceHoldSms()
    expect(s).toMatch(/reply 1 or 2/i)
    expect(s.length).toBeLessThanOrEqual(160)
    expect(s).not.toMatch(/quote (is )?on its way|drafting now/i)
  })
})

describe('interpretChoiceReply', () => {
  const opts = selectProductOptions(taps, 'tap')!
  it('reads 1 / one / first / option 1 as the first option', () => {
    for (const r of ['1', ' 1 ', 'one', 'First', 'option 1', '#1']) {
      expect(interpretChoiceReply(r, opts)?.catalogue_id).toBe('P-good')
    }
  })
  it('reads 2 / two / second as the second option', () => {
    for (const r of ['2', 'two', 'the second one', 'option 2']) {
      expect(interpretChoiceReply(r, opts)?.catalogue_id).toBe('P-better')
    }
  })
  it('matches by product / brand name', () => {
    expect(interpretChoiceReply('the caroma please', opts)?.catalogue_id).toBe('P-better')
    expect(interpretChoiceReply('Clipsal 2000', opts)?.catalogue_id).toBe('P-good')
  })
  it('returns null on ambiguous / unrelated messages (never hijacks a real reply)', () => {
    expect(interpretChoiceReply('I actually need 2 taps installed', opts)).toBeNull()
    expect(interpretChoiceReply('what is the warranty?', opts)).toBeNull()
    expect(interpretChoiceReply('', opts)).toBeNull()
    expect(interpretChoiceReply('1 or 2?', opts)).toBeNull() // both signals → ambiguous
  })
  it('maps tier words to the right option', () => {
    expect(interpretChoiceReply('the cheaper one', opts)?.catalogue_id).toBe('P-good')
    expect(interpretChoiceReply('go basic thanks', opts)?.catalogue_id).toBe('P-good')
    expect(interpretChoiceReply('the better one', opts)?.catalogue_id).toBe('P-better')
    expect(interpretChoiceReply('premium please', opts)?.catalogue_id).toBe('P-better')
  })
  it('"you pick / no preference" → the recommended (Better) option', () => {
    for (const r of [
      'you pick', 'whatever you recommend', 'no preference', 'up to you',
      'either is fine', "doesn't matter", 'surprise me', "you're the expert",
    ]) {
      expect(interpretChoiceReply(r, opts)?.catalogue_id).toBe('P-better')
    }
  })
})

describe('recommendedOption', () => {
  it('is the Better (premium) option', () => {
    const o = selectProductOptions(taps, 'tap')!
    expect(recommendedOption(o).catalogue_id).toBe('P-better')
  })
})

describe('applyChoiceSelection', () => {
  const base = (): ProductChoiceState => ({
    category: 'tap',
    token: 'tok123',
    status: 'pending',
    options: selectProductOptions(taps, 'tap')!,
  })
  it('records a page tap by catalogue_id', () => {
    const s = applyChoiceSelection(base(), { catalogueId: 'P-better' }, 'NOW')!
    expect(s.status).toBe('chosen')
    expect(s.chosen_catalogue_id).toBe('P-better')
    expect(s.chosen_name).toBe('Caroma Liano Tap')
    expect(s.chosen_at).toBe('NOW')
  })
  it('records an SMS reply ("1")', () => {
    const s = applyChoiceSelection(base(), { reply: '1' }, 'NOW')!
    expect(s.status).toBe('chosen')
    expect(s.chosen_catalogue_id).toBe('P-good')
  })
  it('defer:true (page "let tradie choose") → recommended option', () => {
    const s = applyChoiceSelection(base(), { defer: true }, 'NOW')!
    expect(s.status).toBe('chosen')
    expect(s.chosen_catalogue_id).toBe('P-better') // the recommended one
  })
  it('is idempotent — an already-chosen state is returned unchanged', () => {
    const chosen = applyChoiceSelection(base(), { reply: '2' }, 'T1')!
    const again = applyChoiceSelection(chosen, { reply: '1' }, 'T2')!
    expect(again.chosen_catalogue_id).toBe(chosen.chosen_catalogue_id) // unchanged
    expect(again.chosen_at).toBe('T1')
  })
  it('returns null when the input does not resolve (caller falls back to dialog)', () => {
    expect(applyChoiceSelection(base(), { reply: 'what colours?' }, 'NOW')).toBeNull()
    expect(applyChoiceSelection(base(), { catalogueId: 'P-nope' }, 'NOW')).toBeNull()
    expect(applyChoiceSelection(null, { reply: '1' }, 'NOW')).toBeNull()
  })
})

describe('categoryForJobType', () => {
  it('maps known job types to a catalogue category', () => {
    expect(categoryForJobType('tap_replace')).toBe('tap')
    expect(categoryForJobType('toilet_repair')).toBe('toilet')
    expect(categoryForJobType('downlights')).toBe('downlight')
    expect(categoryForJobType('power_points')).toBe('gpo')
    expect(categoryForJobType('hot_water')).toBe('hot_water')
  })
  it('returns null for unknown / empty (→ no offer, safe default)', () => {
    expect(categoryForJobType('unknown')).toBeNull()
    expect(categoryForJobType('')).toBeNull()
    expect(categoryForJobType(null)).toBeNull()
  })
})

describe('describeChosenProductDirective', () => {
  const chosen = (): ProductChoiceState => ({
    category: 'tap',
    token: 't',
    status: 'chosen',
    options: selectProductOptions(taps, 'tap')!,
    chosen_catalogue_id: 'P-better',
    chosen_name: 'Caroma Liano Tap',
  })
  it('produces a grounded directive naming the chosen product + brand/range', () => {
    const d = describeChosenProductDirective(chosen())!
    expect(d).toContain('Caroma Liano Tap')
    expect(d).toContain('Caroma Liano') // brand + range label
    expect(d).toMatch(/quote THIS exact product/i)
  })
  it('is null when nothing was chosen', () => {
    expect(describeChosenProductDirective(null)).toBeNull()
    expect(
      describeChosenProductDirective({ ...chosen(), status: 'pending', chosen_catalogue_id: null }),
    ).toBeNull()
  })
})

describe('chosenProductFromChoice', () => {
  const base = (): ProductChoiceState => ({
    category: 'tap',
    token: 't',
    status: 'chosen',
    options: selectProductOptions(taps, 'tap')!,
    chosen_catalogue_id: 'P-better',
    chosen_name: 'Caroma Liano Tap',
  })
  it('returns the chosen product with its catalogue price + photo', () => {
    const p = chosenProductFromChoice(base())!
    expect(p.catalogue_id).toBe('P-better')
    expect(p.name).toBe('Caroma Liano Tap')
    expect(p.price_ex_gst).toBe(150) // the catalogue price, not generic
    expect(p.image_path).toBe('b.jpg')
    expect(p.category).toBe('tap')
  })
  it('is null when not chosen / no matching option / bad price', () => {
    expect(chosenProductFromChoice(null)).toBeNull()
    expect(chosenProductFromChoice({ ...base(), status: 'pending' })).toBeNull()
    expect(chosenProductFromChoice({ ...base(), chosen_catalogue_id: 'nope' })).toBeNull()
  })
})

describe('single-option offer (tradie stocks ONE product)', () => {
  const one = selectProductOptions([taps[0]], 'tap')! // [Clipsal 2000 Tap $120]

  it('SMS offers the one product for confirmation (not "1 or 2")', () => {
    const sms = buildProductOptionsSms(one, 'https://qm.co/q/choose/z', 'tap')
    expect(sms).toContain('Clipsal 2000 Tap')
    expect(sms).toContain('$120')
    expect(sms).toContain('https://qm.co/q/choose/z')
    expect(sms).toMatch(/reply "yes"/i)
    expect(sms).not.toMatch(/1\. [\s\S]*2\. /) // no two-option list
    expect(sms.length).toBeLessThanOrEqual(320)
  })
  it('interpretChoiceReply: affirmative / name / defer → the one; "no" → null', () => {
    for (const r of ['yes', '1', 'yep', 'sounds good', 'do it', 'Clipsal', 'you pick']) {
      expect(interpretChoiceReply(r, one)?.catalogue_id).toBe('P-good')
    }
    expect(interpretChoiceReply('no thanks not that', one)).toBeNull()
    expect(interpretChoiceReply('what colour is it?', one)).toBeNull()
  })
  it('applyChoiceSelection records the single option via reply or defer', () => {
    const choice: ProductChoiceState = {
      category: 'tap', token: 't', status: 'pending', options: one,
    }
    expect(applyChoiceSelection(choice, { reply: 'yes' }, 'NOW')?.chosen_catalogue_id).toBe('P-good')
    expect(applyChoiceSelection(choice, { defer: true }, 'NOW')?.chosen_catalogue_id).toBe('P-good')
  })
})
