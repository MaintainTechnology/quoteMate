import { tool } from 'ai'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { getReranker } from './rerank'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ─────────────────────────────────────────────────────────────────
// Price-lookup re-ranker — applies to BOTH electrical and plumbing.
//
// SQL ilike + property filters give us a candidate pool. We then run a
// cross-encoder reranker (Voyage by default) to put the BEST semantic
// match for the customer's described need at the top, so Opus's
// natural "pick the first row" instinct lands on the right product.
//
// Without this, Opus gets 5 rows in arbitrary SQL order and may pick
// a poor match (e.g. surfacing "USB GPO" when the customer asked for
// "weatherproof outdoor GPO"). With the reranker, the right SKU is
// always row #1.
//
// Graceful degradation: if VOYAGE_API_KEY is missing, RAG_RERANK_DISABLED
// is set, or the rerank call fails, we fall back to the raw SQL order.
// Never blocks the estimator.
// ─────────────────────────────────────────────────────────────────

const FETCH_LIMIT = 12    // wider candidate pool feeds the reranker
const RETURN_LIMIT = 5    // top-K returned to Opus

async function rerankRows<T>(
  query: string,
  rows: T[],
  topN: number,
  makeDoc: (r: T) => string,
): Promise<T[]> {
  // No point reranking 0-2 rows — return as-is.
  if (rows.length <= 2) return rows
  const reranker = getReranker()
  if (!reranker) return rows.slice(0, topN)

  try {
    const docs = rows.map(makeDoc)
    const ranked = await reranker.rerank(query, docs, topN)
    if (ranked.length === 0) return rows.slice(0, topN)
    return ranked.map((r) => rows[r.index])
  } catch (e: any) {
    // Reranker must never block estimation — log + fall back.
    console.warn(`[tools] reranker failed; falling back to SQL order: ${e?.message ?? String(e)}`)
    return rows.slice(0, topN)
  }
}

// ─────────────────────────────────────────────────────────────────
// Property filters — Opus passes these through from intake.scope.specs
// to narrow the lookup result set deterministically.
//
//   color_temp       — material.properties.color_options must contain it
//                      OR row has no color_options set (generic)
//   dimmable=true    — strict: row.properties.dimmable must be true
//   smart=true       — strict: row.properties.smart must be true
//   weatherproof=true — strict: row.properties.weatherproof must be true
//   supplied_by      — strict: row.properties.supplied_by must match
//
// Filters with `false` or `undefined` are NOT applied (no-op).
// This means asking for a "non-dimmable" doesn't reject dimmable rows
// — Opus picks based on tier, not exclusion. Whereas asking for
// dimmable=true DOES exclude non-dimmable rows.
// ─────────────────────────────────────────────────────────────────

const PropertyFilters = z.object({
  color_temp: z.enum(['warm_white', 'cool_white', 'tri_colour']).optional(),
  dimmable: z.boolean().optional(),
  smart: z.boolean().optional(),
  weatherproof: z.boolean().optional(),
  supplied_by: z.enum(['tradie', 'customer']).optional(),
}).partial()

type PropertyFilters = z.infer<typeof PropertyFilters>

function applyPropertyFilters(query: any, f: PropertyFilters) {
  // color_temp — special-case: row supports the requested temp via the
  // color_options array, OR the row has no color_options set (generic).
  if (f.color_temp) {
    query = query.or(
      `properties->color_options.cs.["${f.color_temp}"],properties->color_options.is.null`
    )
  }
  // Strict-true filters — request true requires row.true.
  if (f.dimmable === true)     query = query.eq('properties->>dimmable', 'true')
  if (f.smart === true)        query = query.eq('properties->>smart', 'true')
  if (f.weatherproof === true) query = query.eq('properties->>weatherproof', 'true')
  // supplied_by is exact-match either way.
  if (f.supplied_by)           query = query.eq('properties->>supplied_by', f.supplied_by)
  return query
}

// Trade enum — v5 multi-trade routing. The DB carries both electrical and
// plumbing rows in shared_assemblies / shared_materials, so callers MUST
// pass `trade` to avoid cross-trade contamination. The prompts (see
// electrical-prompt.ts and plumbing-prompt.ts) instruct Opus to always
// include trade in lookup_* calls.
const TradeEnum = z.enum(['electrical', 'plumbing'])

export const lookupAssembly = tool({
  description:
    'Search the assembly library by name plus optional filters. Results are ' +
    'returned BEST-MATCH-FIRST via cross-encoder reranker — pick the top row ' +
    'unless property filters point you elsewhere. ' +
    'ALWAYS pass `trade` ("electrical" or "plumbing") — the DB carries both ' +
    'and queries without trade may return cross-trade matches. ' +
    'For electrical jobs, when intake.scope.specs has values (color_temp, ' +
    'dimmable, smart, weatherproof, supplied_by), PASS THEM THROUGH so only ' +
    'matching assemblies are returned. ' +
    'Example: lookupAssembly({ query: "outdoor weatherproof IP-rated light install", trade: "electrical", weatherproof: true }) ' +
    'returns only outdoor-rated electrical assemblies, ranked by relevance to the query.',
  inputSchema: z.object({
    query: z.string(),
    trade: TradeEnum.optional(),
    color_temp: z.enum(['warm_white', 'cool_white', 'tri_colour']).optional(),
    dimmable: z.boolean().optional(),
    smart: z.boolean().optional(),
    weatherproof: z.boolean().optional(),
    supplied_by: z.enum(['tradie', 'customer']).optional(),
  }),
  execute: async ({ query, trade, ...filters }) => {
    let q = supabase.from('shared_assemblies').select('*').ilike('name', `%${query}%`)
    if (trade) q = q.eq('trade', trade)
    q = applyPropertyFilters(q, filters)
    const { data } = await q.limit(FETCH_LIMIT)
    const rows = data ?? []
    // Re-rank: pack name + description so the cross-encoder can read both.
    return rerankRows(
      query,
      rows,
      RETURN_LIMIT,
      (r: any) => r.description ? `${r.name} — ${r.description}` : r.name,
    )
  },
})

export const lookupMaterial = tool({
  description:
    'Search materials by name or brand plus optional filters. Results are ' +
    'returned BEST-MATCH-FIRST via cross-encoder reranker — pick the top row ' +
    'unless the customer asked for a specific tier. ' +
    'ALWAYS pass `trade` ("electrical" or "plumbing") — the DB carries both ' +
    'and unfiltered queries may return cross-trade matches. ' +
    'For electrical jobs, when intake.scope.specs has values, PASS THEM THROUGH. ' +
    'Example: lookupMaterial({ query: "warm white dimmable LED downlight", trade: "electrical", color_temp: "warm_white", dimmable: true }) ' +
    'returns only warm-white-capable, dimmable electrical downlights, ranked best-match-first.',
  inputSchema: z.object({
    query: z.string(),
    trade: TradeEnum.optional(),
    color_temp: z.enum(['warm_white', 'cool_white', 'tri_colour']).optional(),
    dimmable: z.boolean().optional(),
    smart: z.boolean().optional(),
    weatherproof: z.boolean().optional(),
    supplied_by: z.enum(['tradie', 'customer']).optional(),
  }),
  execute: async ({ query, trade, ...filters }) => {
    let q = supabase.from('shared_materials').select('*').or(
      `name.ilike.%${query}%,brand.ilike.%${query}%`
    )
    if (trade) q = q.eq('trade', trade)
    q = applyPropertyFilters(q, filters)
    const { data } = await q.limit(FETCH_LIMIT)
    const rows = data ?? []
    // Re-rank: pack brand + name for a denser cross-encoder doc.
    return rerankRows(
      query,
      rows,
      RETURN_LIMIT,
      (r: any) => r.brand ? `${r.brand} ${r.name}` : r.name,
    )
  },
})

export const applyMarkup = tool({
  description: 'Apply the tradie\'s markup percentage to a base material price. Always pass markupPct explicitly using pricingBook.default_markup_pct (default falls back to 28% — the AU electrical median — only as a safety net).',
  inputSchema: z.object({ basePrice: z.number(), markupPct: z.number().optional() }),
  execute: async ({ basePrice, markupPct }) => {
    const pct = markupPct ?? 28                                // matches pricing_book default
    return { final: +(basePrice * (1 + pct / 100)).toFixed(2), markupPct: pct }
  },
})

export const flagInspectionNeeded = tool({
  description: 'Flag that this job is too complex to quote without a site visit',
  inputSchema: z.object({ reason: z.string() }),
  execute: async ({ reason }) => ({ flagged: true, reason }),
})
