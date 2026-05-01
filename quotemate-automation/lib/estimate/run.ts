import { anthropic } from '@ai-sdk/anthropic'
import { generateText, stepCountIs } from 'ai'
import { createClient } from '@supabase/supabase-js'
import { systemPrompt } from './prompt'
import * as tools from './tools'
import { buildCandidatePrices, validateQuoteGrounding, type GroundingFailure, type PricingBookForValidation } from './validate'

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
  const result = await generateText({
    model: anthropic('claude-opus-4-7'),
    system: systemPrompt(pricingBook),
    prompt: `Draft a quote for this intake:\n\n${JSON.stringify(intake, null, 2)}`,
    tools,
    stopWhen: stepCountIs(10),  // build-guide says `maxSteps: 10`; AI SDK v5+ renamed it to stopWhen+stepCountIs
    maxRetries: 0,              // wrapper handles retries with logging — no double-retry
    temperature: 0,             // determinism: same intake → same draft quote
  })

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
  const candidates = await loadCandidatePrices(pricingBook)
  const check = validateQuoteGrounding(draft, pricingBook as PricingBookForValidation, candidates)

  if (check.valid) {
    return { draft }
  }

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
 * Load every shared_materials.default_unit_price_ex_gst and
 * shared_assemblies.default_unit_price_ex_gst, then expand each into
 * raw + marked-up forms so the validator can do O(n) membership checks.
 */
async function loadCandidatePrices(pricingBook: any) {
  const [{ data: materials }, { data: assemblies }] = await Promise.all([
    supabase.from('shared_materials').select('default_unit_price_ex_gst'),
    supabase.from('shared_assemblies').select('default_unit_price_ex_gst'),
  ])

  return buildCandidatePrices(
    (materials ?? []).map((r: any) => r.default_unit_price_ex_gst),
    (assemblies ?? []).map((r: any) => r.default_unit_price_ex_gst),
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
