import { anthropic } from '@ai-sdk/anthropic'
import { generateText, stepCountIs } from 'ai'
import { createClient } from '@supabase/supabase-js'
import { systemPrompt } from './prompt'
import { makeTools } from './tools'
import { buildCandidatePrices, validateQuoteGrounding, type GroundingFailure, type PricingBookForValidation } from './validate'
import { catalogueCandidateRows, formatCatalogueHint, formatBomHint, type CatalogueHintRow, type BomHintRow } from './catalogue'
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

export async function runEstimation(intake: any, pricingBook: any, modelId = 'claude-opus-4-7'): Promise<EstimationResult> {
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

  // Brand preferences (migration 022). Soft hint appended to the system
  // prompt so Opus biases material picks toward the tradie's preferred
  // brands when multiple candidates fit the customer's tier/spec. Never
  // a hard filter — the grounding validator (loadCandidatePrices +
  // validateQuoteGrounding below) keeps the safety guarantees regardless
  // of which brand Opus picks. Preferences are scoped to intake.trade so
  // a plumbing-only quote doesn't see electrical-brand hints and vice
  // versa.
  const preferencesBlock = await buildPreferencesBlock(
    (intake?.tenant_id as string | null) ?? null,
    (intake?.trade as string | null) ?? null,
    cacheLog,
  )

  // WP2 — operator brand+range catalogue hint. WP3 — structured BOM hint.
  // Both soft, both null when the tenant has no catalogue / the BOM table
  // is unseeded, so this is purely additive (no change for legacy data).
  const catalogueBlock = await buildCatalogueHint(
    (intake?.tenant_id as string | null) ?? null,
    (intake?.trade as string | null) ?? null,
    cacheLog,
  )
  const bomBlock = await buildBomHint(intake, (intake?.trade as string | null) ?? null, cacheLog)

  const userPrompt =
    (ragContext ? `${ragContext}\n` : '') +
    (preferencesBlock ? `${preferencesBlock}\n` : '') +
    (catalogueBlock ? `${catalogueBlock}\n` : '') +
    (bomBlock ? `${bomBlock}\n` : '') +
    `Draft a quote for this NEW intake:\n\n${JSON.stringify(intake, null, 2)}`

  // Tenant-scoped tool factory. lookupAssembly now reads BOTH
  // shared_assemblies AND this tenant's tenant_custom_assemblies
  // (migration 023). Legacy intakes without tenant_id get the
  // shared catalogue only — same behaviour as pre-023.
  const tools = makeTools((intake?.tenant_id as string | null) ?? null)

  // Anthropic prompt caching: the system prompt + pricing-book derivation
  // is identical across estimations until pricing_book changes, so we mark
  // it as ephemeral. First call inside the 5-min cache window pays full
  // price (cacheCreationInputTokens > 0); subsequent calls read at ~10%
  // cost (cacheReadInputTokens > 0). Cache invalidates automatically when
  // any pricing_book field changes (different prompt content → different key).
  const result = await generateText({
    model: anthropic(modelId),
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
    cacheLog.ok(`${modelId} call complete (cache stats)`, {
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
  // from pricing_book + shared_materials + shared_assemblies + the
  // tenant's tenant_custom_assemblies (migration 023). If even one
  // line item fails grounding, downgrade the entire quote to inspection.
  // v5 multi-trade: scope grounding to intake.trade so an electrical quote
  // can never coincidentally validate against a plumbing price (or vice versa).
  const candidates = await loadCandidatePrices(
    pricingBook,
    intake?.trade ?? null,
    (intake?.tenant_id as string | null) ?? null,
  )
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
 *
 * v6+ migration 023: also pulls tenant_custom_assemblies for this tenant
 * so prices the LLM grounded on a tenant-owned custom assembly pass
 * validation. always_inspection=true rows are excluded (matching the
 * tool exclusion) so the validator never accepts a price derived from
 * a service the tradie wanted to always inspect.
 */
async function loadCandidatePrices(
  pricingBook: any,
  trade: string | null,
  tenantId: string | null,
) {
  const materialsQuery = supabase
    .from('shared_materials')
    .select('name, default_unit_price_ex_gst, trade')
  const assembliesQuery = supabase
    .from('shared_assemblies')
    .select('name, default_unit_price_ex_gst, trade')

  const customAssembliesPromise = tenantId
    ? (() => {
        let q = supabase
          .from('tenant_custom_assemblies')
          .select('name, default_unit_price_ex_gst, trade')
          .eq('tenant_id', tenantId)
          .eq('enabled', true)
          .eq('always_inspection', false)
        if (trade) q = q.eq('trade', trade)
        return q
      })()
    : Promise.resolve({ data: [] as Array<{ name: string; default_unit_price_ex_gst: number | string; trade: string }> })

  // WP2 TRAP-FIX (lockstep with tools.ts makeLookupMaterial): lookupMaterial
  // now returns operator-owned tenant_material_catalogue rows (migration
  // 028), so the validator MUST accept prices grounded on them or every
  // branded quote is downgraded to inspection. Absent table (prod pre-028)
  // → supabase-js returns {data:null} (no throw) → [] → behaviour identical
  // to pre-WP2. always-active filter mirrors the lookup tool's filter.
  const tenantCataloguePromise = tenantId
    ? (() => {
        let q = supabase
          .from('tenant_material_catalogue')
          .select('name, unit_price_ex_gst, customer_supply_price_ex_gst, active, trade')
          .eq('tenant_id', tenantId)
          .eq('active', true)
        if (trade) q = q.eq('trade', trade)
        return q
      })()
    : Promise.resolve({ data: [] as Array<{ name: string; unit_price_ex_gst: number | string; customer_supply_price_ex_gst: number | string | null; active: boolean; trade: string }> })

  const [
    { data: materials },
    { data: assemblies },
    { data: customAssemblies },
    { data: tenantCatalogue },
  ] = await Promise.all([
    trade ? materialsQuery.eq('trade', trade) : materialsQuery,
    trade ? assembliesQuery.eq('trade', trade) : assembliesQuery,
    customAssembliesPromise,
    tenantCataloguePromise,
  ])

  // Merge shared + custom assemblies into one candidate set — the
  // validator treats them identically as a (name, price) pair.
  const allAssemblies = [
    ...(assemblies ?? []),
    ...(customAssemblies ?? []),
  ]

  // Expand the tenant catalogue (supply + customer-supply price variants)
  // into material candidates so a branded tenant-priced line grounds.
  const tenantMaterialCandidates = catalogueCandidateRows(
    (tenantCatalogue ?? []) as any[],
  )

  return buildCandidatePrices(
    [
      ...(materials ?? []).map((r: any) => ({ name: r.name, price: r.default_unit_price_ex_gst })),
      ...tenantMaterialCandidates,
    ],
    allAssemblies.map((r: any) => ({ name: r.name, price: r.default_unit_price_ex_gst })),
    pricingBook,
  )
}

/**
 * Build the "Preferred brands" hint block for the user message.
 *
 * Reads tenant_material_preferences and joins to shared_materials to
 * confirm each (category, brand) pair still exists in the catalogue.
 * Returns null when:
 *   • intake has no tenant_id (legacy pre-v6 or dev intakes)
 *   • the tenant has set no preferences
 *   • the preferences table is unavailable (migration 022 not run)
 *
 * Lives in the USER message, not the system message, so per-tenant
 * variance doesn't fragment the system-prompt cache. The system prompt
 * stays identical across all tenants — only the per-call user message
 * carries tenant-specific hints.
 *
 * Soft instruction phrasing: "prefer X when matching candidates exist"
 * — never starves a quote when the customer needs a tier the preferred
 * brand can't fulfil.
 */
async function buildPreferencesBlock(
  tenantId: string | null,
  trade: string | null,
  log: ReturnType<typeof pipelineLog>,
): Promise<string | null> {
  if (!tenantId) return null

  try {
    const { data, error } = await supabase
      .from('tenant_material_preferences')
      .select('category, preferred_brand')
      .eq('tenant_id', tenantId)

    if (error) {
      // Table missing or RLS blocking — log + carry on. Estimation
      // continues without preferences (current behaviour pre-022).
      log.err('preferences fetch failed — continuing without brand hints', error.message)
      return null
    }
    if (!data || data.length === 0) return null

    // Scope hints to the intake's trade so an electrical quote doesn't
    // see plumbing-side brand picks. We join to shared_materials.category
    // to filter — but a single category slug can technically be reused
    // across trades (e.g. "sundries"), so we use an IN-list filter via
    // a category lookup rather than assuming exclusivity.
    if (trade) {
      const categories = data.map((p) => p.category as string)
      const { data: catRows } = await supabase
        .from('shared_materials')
        .select('category')
        .in('category', categories)
        .eq('trade', trade)
        .limit(categories.length * 4)

      const validCategories = new Set<string>(
        (catRows ?? []).map((r) => r.category as string),
      )
      const scoped = data.filter((p) =>
        validCategories.has(p.category as string),
      )
      if (scoped.length === 0) return null
      return formatPreferencesBlock(scoped)
    }

    return formatPreferencesBlock(data)
  } catch (e: any) {
    log.err('preferences block build failed', e?.message ?? String(e))
    return null
  }
}

function formatPreferencesBlock(
  rows: Array<{ category: string | null; preferred_brand: string | null }>,
): string {
  const lines = rows
    .filter((r): r is { category: string; preferred_brand: string } =>
      typeof r.category === 'string' && typeof r.preferred_brand === 'string',
    )
    .map((r) => `  • ${r.category}: ${r.preferred_brand}`)

  if (lines.length === 0) return ''

  return [
    'Tradie preferred brands (soft hint — apply ONLY when picking materials):',
    ...lines,
    'When multiple shared_materials candidates fit the customer\'s tier and specs,',
    'prefer the row whose brand matches the tradie\'s preference for that category.',
    'If no preferred-brand candidate matches the customer\'s actual need, pick the',
    'best fit regardless of brand — never sacrifice tier/spec match for brand.',
    'Grounding validation runs after your output regardless of brand choice.',
  ].join('\n')
}

/**
 * WP2 — operator catalogue hint. Lists the tenant's active
 * tenant_material_catalogue rows (brand + range -> tier) so Opus
 * prefers their real products. Resilient: missing table / no rows /
 * error -> null, so legacy tenants are unaffected.
 */
async function buildCatalogueHint(
  tenantId: string | null,
  trade: string | null,
  log: ReturnType<typeof pipelineLog>,
): Promise<string | null> {
  if (!tenantId) return null
  try {
    let q = supabase
      .from('tenant_material_catalogue')
      .select('category, name, brand, range_series, tier_hint')
      .eq('tenant_id', tenantId)
      .eq('active', true)
    if (trade) q = q.eq('trade', trade)
    const { data, error } = await q
    if (error) {
      log.err('catalogue hint fetch failed — continuing without it', error.message)
      return null
    }
    return formatCatalogueHint((data ?? []) as CatalogueHintRow[])
  } catch (e: any) {
    log.err('catalogue hint build failed', e?.message ?? String(e))
    return null
  }
}

/**
 * WP3 — structured bill-of-materials hint. Finds shared_assemblies that
 * match the job, pulls their shared_assembly_bom rows, and lists the
 * baseline parts so the same job quotes the same parts every time.
 * Resilient: no matching assembly / unseeded BOM / error -> null.
 */
async function buildBomHint(
  intake: any,
  trade: string | null,
  log: ReturnType<typeof pipelineLog>,
): Promise<string | null> {
  const jobType = (intake?.job_type as string | null) ?? null
  if (!jobType) return null
  try {
    const term = jobType.replace(/_/g, ' ')
    let aq = supabase.from('shared_assemblies').select('id, name, trade').ilike('name', `%${term}%`)
    if (trade) aq = aq.eq('trade', trade)
    const { data: asm, error: aerr } = await aq.limit(5)
    if (aerr || !asm || asm.length === 0) return null
    const ids = asm.map((a: any) => a.id)
    const { data: bom, error: berr } = await supabase
      .from('shared_assembly_bom')
      .select('material_category, quantity, required, description, sort')
      .in('assembly_id', ids)
      .order('sort', { ascending: true })
    if (berr) {
      log.err('BOM hint fetch failed — continuing without it', berr.message)
      return null
    }
    return formatBomHint((bom ?? []) as BomHintRow[])
  } catch (e: any) {
    log.err('BOM hint build failed', e?.message ?? String(e))
    return null
  }
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
