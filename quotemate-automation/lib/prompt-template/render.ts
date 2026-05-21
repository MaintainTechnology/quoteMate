// Prompt-template engine for the trade_prompts table (admin bulk loader —
// see docs/admin-bulk-loader-spec.md §6.1, §14).
//
// A trade's estimator / SMS / voice prompt text is stored as DATA in the
// trade_prompts table — not hand-wired TypeScript per trade. This engine
// renders that data. It supports exactly three constructs, deliberately
// no more:
//
//   {{key}}                       value substitution
//   {{#if key}}…{{/if}}           conditional block (optional {{else}})
//   {{markup N}}                  one helper: Math.round(N × (1 + markup/100))
//
// The {{markup}} helper exists because the plumbing estimator prompt embeds
// a 21-row "EXACT VALID PRICES" table computed at the tenant's configured
// markup. Without it the plumbing prompt could not migrate string-identical,
// which the Phase 0 exit gate requires. markupPct is read from
// ctx.default_markup_pct.
//
// FAIL LOUD: an unknown {{key}}, an unknown helper, or an unbalanced
// {{#if}} all THROW. A prompt that silently renders with a hole in it —
// or with a dangling {{#if}} — is more dangerous than a hard error, because
// the money-path estimator would run on a malformed system prompt.

export type TemplateValue = string | number | boolean | null | undefined
export type TemplateContext = Record<string, TemplateValue>

type Token =
  | { type: 'text'; value: string }
  | { type: 'tag'; value: string }

// A tag body is non-empty and never contains a brace, so `{{ }}`, `{{{x}}}`
// stray braces, and JSON examples with single `{ }` braces in the prompt
// text are all left as literal text.
const TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

function tokenize(template: string): Token[] {
  const tokens: Token[] = []
  let last = 0
  let m: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((m = TAG_RE.exec(template)) !== null) {
    if (m.index > last) {
      tokens.push({ type: 'text', value: template.slice(last, m.index) })
    }
    tokens.push({ type: 'tag', value: m[1] })
    last = TAG_RE.lastIndex
  }
  if (last < template.length) {
    tokens.push({ type: 'text', value: template.slice(last) })
  }
  return tokens
}

// Truthiness for {{#if}}. Mirrors what a human authoring a prompt expects:
// a missing value, an empty string, a literal "false"/"0", and the number 0
// are all falsy. Everything else is truthy.
function isTruthy(v: TemplateValue): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  const s = String(v).trim().toLowerCase()
  return s !== '' && s !== 'false' && s !== '0'
}

// Coerce a context value to the exact string a JS template literal would
// produce — String(110) === "110", String(true) === "true" — so a template
// authored from a `${…}`-interpolated prompt renders byte-identical.
function coerce(v: TemplateValue): string {
  return String(v)
}

/**
 * Render a prompt template against a context.
 *
 * @throws if a placeholder has no context value, a helper is unknown, a
 *         helper argument is malformed, or an {{#if}} is unbalanced.
 */
export function renderPromptTemplate(
  template: string,
  ctx: TemplateContext,
): string {
  const tokens = tokenize(template)
  let i = 0

  function evalTag(raw: string): string {
    const tag = raw.trim()
    const sp = tag.indexOf(' ')

    // Helper call: "<name> <arg>". The only helper is `markup`.
    if (sp !== -1) {
      const name = tag.slice(0, sp).trim()
      const arg = tag.slice(sp + 1).trim()
      if (name === 'markup') {
        const rawPrice = Number(arg)
        if (!Number.isFinite(rawPrice)) {
          throw new Error(
            `prompt-template: {{markup}} needs a numeric argument, got {{${tag}}}`,
          )
        }
        const markupPct = Number(ctx.default_markup_pct)
        if (!Number.isFinite(markupPct)) {
          throw new Error(
            'prompt-template: {{markup}} needs a numeric ctx.default_markup_pct',
          )
        }
        return String(Math.round(rawPrice * (1 + markupPct / 100)))
      }
      throw new Error(`prompt-template: unknown helper {{${tag}}}`)
    }

    // Plain value substitution.
    if (!(tag in ctx)) {
      throw new Error(`prompt-template: unknown placeholder {{${tag}}}`)
    }
    const v = ctx[tag]
    if (v === undefined || v === null) {
      throw new Error(
        `prompt-template: placeholder {{${tag}}} resolved to ${String(v)}`,
      )
    }
    return coerce(v)
  }

  // Render tokens until a stop tag (consumed before returning) or EOF.
  function renderUntil(stops: readonly string[]): {
    out: string
    stop: string | null
  } {
    let out = ''
    while (i < tokens.length) {
      const t = tokens[i]
      if (t.type === 'text') {
        out += t.value
        i++
        continue
      }
      const tag = t.value.trim()
      const head = tag.split(/\s+/)[0]

      if (stops.includes(head)) {
        i++ // consume the stop tag
        return { out, stop: head }
      }

      if (head === '#if') {
        i++ // consume the {{#if key}}
        const key = tag.split(/\s+/)[1]
        if (!key) throw new Error('prompt-template: {{#if}} is missing a key')
        const cond = isTruthy(ctx[key])

        const ifBranch = renderUntil(['else', '/if'])
        let elseText = ''
        if (ifBranch.stop === 'else') {
          const elseBranch = renderUntil(['/if'])
          if (elseBranch.stop !== '/if') {
            throw new Error(
              `prompt-template: unclosed {{#if ${key}}} (missing {{/if}})`,
            )
          }
          elseText = elseBranch.out
        } else if (ifBranch.stop !== '/if') {
          throw new Error(
            `prompt-template: unclosed {{#if ${key}}} (missing {{/if}})`,
          )
        }

        out += cond ? ifBranch.out : elseText
        continue
      }

      out += evalTag(tag)
      i++
    }
    return { out, stop: null }
  }

  const result = renderUntil([])
  return result.out
}
