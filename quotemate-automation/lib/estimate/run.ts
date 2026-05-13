import { anthropic } from '@ai-sdk/anthropic'
import { generateText, stepCountIs } from 'ai'
import { createClient } from '@supabase/supabase-js'
import { systemPrompt } from './prompt'
import * as tools from './tools'
import { buildCandidatePrices, validateQuoteGrounding, type GroundingFailure, type PricingBookForValidation } from './validate'
import { fetchSimilarPastQuotesContext } from './rag'
import { pipelineLog } from '@/lib/log/pipeline'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export type EstimationResult = {
  /** The draft quote that the route handler should persist + dispatch.
   *  If grounding validation failed, this draft is downgraded to
   *  inspection-required (good/better/best=null, needs_inspection=true). */
  draft: any
  /** Set when the validator found ungrounded prices — populated for
   *  observability so Vercel logs show exactly which line items failed. */
  groundingFailures?: GroundingFailure[]
  /** True when the draft was forced to inspection-required because
   *  validation failed. The route handler should NOT create three-tier
   *  Stripe sessions in this case. */
  downgradedToInspection?: boolean
}

export async function runEstimation(intake: any, pricingBook: any): Promise<EstimationResult> {
  const cacheLog = pipelineLog('estimate', intake?.id ?? null)

  // RAG: anchor Opus to similar past quotes. Returns null on cold-start
  // (no usable matches), all-inspection results, or if RAG_DISABLED=true.
  // The block goes in the user message — keeps the system message
  // fully cacheable while still informing this specific draft.
  let ragContext: string | null = null
  let ragMatchCount = 0
  try {
    const rag = await fetchSimilarPastQuotesContext(supabase, intake)
    if (rag) {
      ragContext = rag.context
      ragMatchCount = rag.matchCount
      cacheLog.ok('RAG context attached', { match_count: ragMatchCount, chars: rag.context.length })
    } else {
      cacheLog.ok('RAG context skipped', { reason: 'no usable matches or disabled' })
    }
  } catch (e: any) {
    // RAG must never block estimation. Log + carry on.
    cacheLog.err('RAG fetch failed — continuing without similar-quote context', e?.message ?? String(e))
  }

  const userPrompt =
    (ragContext ? `${ragContext}\n` : '') +
    `Draft a quote for this NEW intake:\n\n${JSON.stringify(intake, null, 2)}`

  // Anthropic prompt caching: the system prompt + pricing-book derivation
  // is identical across estimations until pricing_book changes, so we mark
  // it as ephemeral. First call inside the 5-min cache window pays full
  // price (cacheCreationInputTokens > 0); subsequent calls read at ~10%
  // cost (cacheReadInputTokens > 0). Cache invalidates automatically when
  // any pricing_book field changes (different prompt content → different key).
  const result = await generateText({
    model: anthropic('claude-opus-4-7'),
    messages: [
      {
        role: 'system',
        // v5 multi-trade: router picks electrical vs plumbing prompt by intake.trade
        content: systemPrompt(intake, pricingBook),
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' } },
        },
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ],
    tools,
    stopWhen: stepCountIs(10),  // build-guide says `maxSteps: 10`; AI SDK v5+ renamed it to stopWhen+stepCountIs
    maxRetries: 0,              // wrapper handles retries with logging — no double-retry
    // Opus 4.7 ignores temperature — AI SDK warns on every call if it's
    // set. Determinism here comes from the strict tool-call grounding +
    // pricing book lookup, not from temperature.
  })

  const cacheMeta = (result.providerMetadata as any)?.anthropic
  if (cacheMeta) {
    cacheLog.ok('Opus call complete (cache stats)', {
      cache_creation_input_tokens: cacheMeta.cacheCreationInputTokens ?? 0,
      cache_read_input_tokens: cacheMeta.cacheReadInputTokens ?? 0,
      input_tokens: cacheMeta.usage?.inputTokens ?? null,
      output_tokens: cacheMeta.usage?.outputTokens ?? null,
    })
  }

  const draft = parseJsonFromText(result.text)

  // Inspection-required quotes don't carry line items, so there's nothing
  // to validate — accept as-is. The route handler will force tier nulls and
  // the $199 inspection total.
  if (draft?.needs_inspection === true) {
    return { draft }
  }

  // Auto-quote path: every line_item.unit_price_ex_gst MUST be derivable
  // from pricing_book + shared_materials + shared_assemblies. If even one
  // line item fails grounding, downgrade the entire quote to inspection.
  // v5 multi-trade: scope grounding to intake.trade so an electrical quote
  // can never coincidentally validate against a plumbing price (or vice versa).
  const candidates = await loadCandidatePrices(pricingBook, intake?.trade ?? null)
  const check = validateQuoteGrounding(draft, pricingBook as PricingBookForValidation, candidates)

  if (check.valid) {
    return { draft }
  }

  // Log every failure so the next-time diagnosis is one log query away.
  // Without this the only signal we have is the count, which masks
  // whether the failures are price-band, semantic-category, or labour-rate.
  cacheLog.err('grounding validation failed — per-line failures follow', null, {
    failure_count: check.failures.length,
    failures: check.failures.map((f) => ({
      tier: f.tier,
      lineIndex: f.lineIndex,
      description: f.description?.slice(0, 80),
      unit: f.unit,
      price: f.unit_price_ex_gst,
      expected: f.expected,
    })),
  })

  const reason = `Pricing not yet available — ${check.failures.length} line item(s) failed grounding check against the database. A site visit is needed before we can quote accurately.`

  const downgraded = {
    ...draft,
    good: null,
    better: null,
    best: null,
    needs_inspection: true,
    inspection_reason: reason,
    estimated_timeframe: 'After site visit (within 5 business days)',
    // Preserve scope_short for the SMS, but null the assumptions if they
    // referenced fabricated prices/inclusions.
  }

  return {
    draft: downgraded,
    groundingFailures: check.failures,
    downgradedToInspection: true,
  }
}

/**
 * Load every shared_materials and shared_assemblies row (name + price) and
 * expand each into raw + marked-up candidate prices so the validator can
 * enforce both price-grounding AND semantic-category-grounding.
 *
 * v5 multi-trade: pass `trade` to scope candidates to the intake's trade.
 * Without this filter, an electrical quote could "pass" validation by
 * coincidentally matching a plumbing price — the trade column is now the
 * canonical scope.
 */
async function loadCandidatePrices(pricingBook: any, trade: string | null) {
  const materialsQuery = supabase.from('shared_materials').select('name, default_unit_price_ex_gst, trade')
  const assembliesQuery = supabase.from('shared_assemblies').select('name, default_unit_price_ex_gst, trade')

  const [{ data: materials }, { data: assemblies }] = await Promise.all([
    trade ? materialsQuery.eq('trade', trade) : materialsQuery,
    trade ? assembliesQuery.eq('trade', trade) : assembliesQuery,
  ])

  return buildCandidatePrices(
    (materials ?? []).map((r: any) => ({ name: r.name, price: r.default_unit_price_ex_gst })),
    (assemblies ?? []).map((r: any) => ({ name: r.name, price: r.default_unit_price_ex_gst })),
    pricingBook,
  )
}

// Opus often prefixes its response with reasoning ("Calculation: ...", "Here is the quote:")
// or wraps in ```json fences. Extract the first balanced { ... } block.
function parseJsonFromText(text: string): any {
  // Try direct parse first (happy path)
  const direct = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try { return JSON.parse(direct) } catch {}

  // Fallback: find the first { and walk forward counting braces (respecting strings)
  const start = text.indexOf('{')
  if (start < 0) throw new Error(`No JSON object found in Opus output. First 300 chars: ${text.slice(0, 300)}`)

  let depth = 0, inStr = false, esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        const candidate = text.slice(start, i + 1)
        try { return JSON.parse(candidate) }
        catch (e: any) {
          throw new Error(`Found JSON-shaped block but couldn't parse it: ${e.message}\n\nFirst 300 chars of candidate:\n${candidate.slice(0, 300)}`)
        }
      }
    }
  }

  throw new Error(`Unbalanced braces in Opus output. First 300 chars: ${text.slice(0, 300)}`)
}
