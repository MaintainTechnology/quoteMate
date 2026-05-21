import { describe, it, expect } from 'vitest'
import { renderPromptTemplate } from './render'

describe('renderPromptTemplate — value substitution', () => {
  it('substitutes string values', () => {
    expect(renderPromptTemplate('Hello {{name}}.', { name: 'world' })).toBe(
      'Hello world.',
    )
  })

  it('coerces numbers exactly like a JS template literal', () => {
    expect(
      renderPromptTemplate('rate={{hourly_rate}}', { hourly_rate: 110 }),
    ).toBe('rate=110')
    expect(
      renderPromptTemplate('hrs={{min_labour_hours}}', {
        min_labour_hours: 1.5,
      }),
    ).toBe('hrs=1.5')
  })

  it('coerces booleans to "true" / "false"', () => {
    expect(
      renderPromptTemplate('gst={{gst_registered}}', { gst_registered: true }),
    ).toBe('gst=true')
    expect(
      renderPromptTemplate('gst={{gst_registered}}', { gst_registered: false }),
    ).toBe('gst=false')
  })

  it('tolerates whitespace inside the braces', () => {
    expect(renderPromptTemplate('{{  name  }}', { name: 'ok' })).toBe('ok')
  })

  it('throws on an unknown placeholder rather than rendering a hole', () => {
    expect(() => renderPromptTemplate('{{missing}}', {})).toThrow(
      /unknown placeholder/,
    )
  })

  it('throws when a placeholder resolves to null/undefined', () => {
    expect(() =>
      renderPromptTemplate('{{licence}}', { licence: null }),
    ).toThrow(/resolved to null/)
    expect(() =>
      renderPromptTemplate('{{licence}}', { licence: undefined }),
    ).toThrow(/resolved to undefined/)
  })

  it('leaves single braces and JSON examples in the prompt untouched', () => {
    const json = 'Output: { "scope": "x", "items": [{ "n": 1 }] }'
    expect(renderPromptTemplate(json, {})).toBe(json)
  })
})

describe('renderPromptTemplate — {{#if}} conditionals', () => {
  it('renders the block when the key is truthy', () => {
    expect(
      renderPromptTemplate('a{{#if flag}}B{{/if}}c', { flag: true }),
    ).toBe('aBc')
  })

  it('drops the block when the key is falsy', () => {
    expect(
      renderPromptTemplate('a{{#if flag}}B{{/if}}c', { flag: false }),
    ).toBe('ac')
  })

  it('treats missing, empty, "false", "0" and 0 as falsy', () => {
    const t = 'x{{#if k}}Y{{/if}}z'
    expect(renderPromptTemplate(t, {})).toBe('xz')
    expect(renderPromptTemplate(t, { k: '' })).toBe('xz')
    expect(renderPromptTemplate(t, { k: 'false' })).toBe('xz')
    expect(renderPromptTemplate(t, { k: '0' })).toBe('xz')
    expect(renderPromptTemplate(t, { k: 0 })).toBe('xz')
  })

  it('honours an {{else}} branch', () => {
    const t = '{{#if k}}YES{{else}}NO{{/if}}'
    expect(renderPromptTemplate(t, { k: true })).toBe('YES')
    expect(renderPromptTemplate(t, { k: false })).toBe('NO')
  })

  it('supports nested conditionals', () => {
    const t = '{{#if a}}A{{#if b}}B{{/if}}{{/if}}'
    expect(renderPromptTemplate(t, { a: true, b: true })).toBe('AB')
    expect(renderPromptTemplate(t, { a: true, b: false })).toBe('A')
    expect(renderPromptTemplate(t, { a: false, b: true })).toBe('')
  })

  it('throws on an unbalanced {{#if}}', () => {
    expect(() =>
      renderPromptTemplate('{{#if k}}oops', { k: true }),
    ).toThrow(/unclosed/)
  })
})

describe('renderPromptTemplate — {{markup}} helper', () => {
  it('computes Math.round(raw * (1 + markupPct/100))', () => {
    // markup 20 — matches plumbing-prompt.ts m() at default_markup_pct=20
    const ctx = { default_markup_pct: 20 }
    expect(renderPromptTemplate('{{markup 35}}', ctx)).toBe('42')
    expect(renderPromptTemplate('{{markup 95}}', ctx)).toBe('114')
    expect(renderPromptTemplate('{{markup 1050}}', ctx)).toBe('1260')
    expect(renderPromptTemplate('{{markup 2500}}', ctx)).toBe('3000')
  })

  it('rounds correctly at a non-round markup', () => {
    // markup 15 — Peppers' book
    const ctx = { default_markup_pct: 15 }
    expect(renderPromptTemplate('{{markup 35}}', ctx)).toBe('40') // 40.25 -> 40
    expect(renderPromptTemplate('{{markup 95}}', ctx)).toBe('109') // 109.25 -> 109
  })

  it('throws when the markup argument is not numeric', () => {
    expect(() =>
      renderPromptTemplate('{{markup abc}}', { default_markup_pct: 20 }),
    ).toThrow(/numeric argument/)
  })

  it('throws when ctx.default_markup_pct is missing', () => {
    expect(() => renderPromptTemplate('{{markup 35}}', {})).toThrow(
      /default_markup_pct/,
    )
  })

  it('throws on an unknown helper', () => {
    expect(() =>
      renderPromptTemplate('{{discount 35}}', { default_markup_pct: 20 }),
    ).toThrow(/unknown helper/)
  })
})
