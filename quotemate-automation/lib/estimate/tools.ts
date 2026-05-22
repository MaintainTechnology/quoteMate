import { tool } from 'ai'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { getReranker } from './rerank'
import { buildAssemblyOrFilter } from './assembly-search'

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

// ─────────────────────────────────────────────────────────────────
// Factory variant — makeTools(tenantId) returns a tools object whose
// lookupAssembly UNIONs shared_assemblies with this tenant's
// tenant_custom_assemblies (migration 023). Custom rows are scoped
// strictly to the calling tenant so one tradie's "Install pool light"
// never leaks into another tradie's quote.
//
// always_inspection=true custom rows are EXCLUDED from results so
// the LLM can't ground a price on them — the grounding validator
// then forces inspection routing for any service that matches.
//
// The static exports below (lookupAssembly, lookupMaterial, etc.)
// preserve backward compatibility for code paths that haven't been
// migrated to the factory yet (scripts, tests).
// ─────────────────────────────────────────────────────────────────

function makeLookupAssembly(tenantId: string | null) {
  return tool({
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
      // Shared catalogue lookup. The name search is synonym + token
      // expanded (buildAssemblyOrFilter) so a customer-worded query
      // ("power point") still finds a trade-named assembly ("Replace
      // double GPO") — the reranker below picks the best of the pool.
      let sharedQ = supabase
        .from('shared_assemblies')
        .select('*')
        .or(buildAssemblyOrFilter(query))
      if (trade) sharedQ = sharedQ.eq('trade', trade)
      sharedQ = applyPropertyFilters(sharedQ, filters)
      const sharedRes = await sharedQ.limit(FETCH_LIMIT)
      const sharedRows = (sharedRes.data ?? []).map((r: any) => ({
        ...r,
        is_custom: false,
      }))

      // Tenant-owned custom assemblies (migration 023). Only when the
      // intake carries a tenant_id AND the row is enabled AND it's NOT
      // flagged always_inspection (those force inspection routing and
      // must never produce an auto-quote price).
      let customRows: any[] = []
      if (tenantId) {
        let customQ = supabase
          .from('tenant_custom_assemblies')
          .select('*')
          .or(buildAssemblyOrFilter(query))
          .eq('tenant_id', tenantId)
          .eq('enabled', true)
          .eq('always_inspection', false)
        if (trade) customQ = customQ.eq('trade', trade)
        customQ = applyPropertyFilters(customQ, filters)
        const customRes = await customQ.limit(FETCH_LIMIT)
        customRows = (customRes.data ?? []).map((r: any) => ({
          ...r,
          is_custom: true,
        }))
      }

      // Combine — custom rows go first so the reranker can promote
      // them when they're a tighter match. The reranker decides the
      // final order regardless.
      const rows = [...customRows, ...sharedRows]
      return rerankRows(
        query,
        rows,
        RETURN_LIMIT,
        (r: any) => (r.description ? `${r.name} — ${r.description}` : r.name),
      )
    },
  })
}

/**
 * Build a tools object scoped to one tenant. Pass `tenantId=null` to
 * preserve the pre-023 behaviour (shared catalogue only). The result
 * is shaped exactly like the static module exports below so callers
 * can drop it into `generateText({ tools })`.
 */
export function makeTools(tenantId: string | null) {
  return {
    lookupAssembly: makeLookupAssembly(tenantId),
    lookupMaterial: makeLookupMaterial(tenantId),
    applyMarkup,
    flagInspectionNeeded,
  }
}

// Backward-compat static export — used by any caller that doesn't
// (yet) thread tenantId through. Behaves like the pre-023 tool:
// shared catalogue only.
export const lookupAssembly = makeLookupAssembly(null)

// WP2 — factory variant. When the intake carries a tenant_id, lookupMaterial
// UNIONs shared_materials with this tenant's active tenant_material_catalogue
// (migration 028) — their real brands/ranges (Clipsal Iconic vs 2000),
// ranked AHEAD of the generic shared catalogue. Tenant rows alias
// unit_price_ex_gst → default_unit_price_ex_gst so Opus reads the SAME
// price field regardless of source. Mirrors makeLookupAssembly (023).
//
// The grounding validator MUST also accept these prices (see
// run.ts loadCandidatePrices) or every branded quote dumps to inspection
// — that lockstep is shipped in the same change.
function makeLookupMaterial(tenantId: string | null) {
  return tool({
    description:
      'Search materials by name or brand plus optional filters. Results are ' +
      'returned BEST-MATCH-FIRST via cross-encoder reranker — pick the top row ' +
      'unless the customer asked for a specific tier. ' +
      'When this tenant has an operator-owned materials catalogue (their real ' +
      'brands/ranges, e.g. Clipsal Iconic vs Clipsal 2000), those rows are ' +
      'UNIONed in and ranked ahead of the generic shared catalogue. ' +
      'ALWAYS pass `trade` ("electrical" or "plumbing") — the DB carries both ' +
      'and unfiltered queries may return cross-trade matches. ' +
      'When intake.scope.specs has values, PASS THEM THROUGH. ' +
      'IMPORTANT — supply mode (WP5): if intake.scope.specs.supplied_by is "customer", ALWAYS pass `supplied_by: "customer"` to this tool. ' +
      'Tenant catalogue rows then return their install-only price (customer_supply_price_ex_gst) and stamp `is_customer_supply: true` — use that price for the line item and prefix the description with "Customer to supply — ". ' +
      'If supplied_by is "tradie" or unset, the row returns the standard supply-and-install price (today\'s behaviour). ' +
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
      // Shared catalogue (unchanged behaviour).
      let sharedQ = supabase.from('shared_materials').select('*').or(
        `name.ilike.%${query}%,brand.ilike.%${query}%`
      )
      if (trade) sharedQ = sharedQ.eq('trade', trade)
      sharedQ = applyPropertyFilters(sharedQ, filters)
      const sharedRes = await sharedQ.limit(FETCH_LIMIT)
      const sharedRows = (sharedRes.data ?? []).map((r: any) => ({ ...r, is_tenant: false }))

      // Operator-owned catalogue (migration 028). Absent table (prod
      // pre-028) → supabase-js returns {data:null} (no throw) → [] →
      // shared-only, identical to pre-WP2 behaviour.
      //
      // WP5 — supply-mode pricing. When the caller passes
      // `supplied_by: 'customer'` AND the tenant row has a non-null
      // `customer_supply_price_ex_gst`, the row's effective price flips
      // to that install-only number. is_customer_supply=true is stamped
      // so the prompt / line-item builder can mark the line as
      // "Customer to supply …". When the column is null we fall through
      // to the standard unit_price_ex_gst (no regression for tenants who
      // never filled it in). When supplied_by is unset or 'tradie', the
      // row's price is always the tradie-supply price — today's
      // behaviour, untouched.
      let tenantRows: any[] = []
      if (tenantId) {
        let tq = supabase
          .from('tenant_material_catalogue')
          .select('*')
          .or(`name.ilike.%${query}%,brand.ilike.%${query}%`)
          .eq('tenant_id', tenantId)
          .eq('active', true)
        if (trade) tq = tq.eq('trade', trade)
        tq = applyPropertyFilters(tq, filters)
        const tRes = await tq.limit(FETCH_LIMIT)
        const wantCustomerSupply = filters.supplied_by === 'customer'
        tenantRows = (tRes.data ?? []).map((r: any) => {
          const csPrice =
            typeof r.customer_supply_price_ex_gst === 'string'
              ? parseFloat(r.customer_supply_price_ex_gst)
              : r.customer_supply_price_ex_gst
          const useCs = wantCustomerSupply && Number.isFinite(csPrice) && csPrice > 0
          return {
            ...r,
            default_unit_price_ex_gst: useCs ? csPrice : r.unit_price_ex_gst,
            is_tenant: true,
            is_customer_supply: useCs,
          }
        })
      }

      // Tenant rows first so the reranker can promote them; the reranker
      // decides final order regardless.
      const rows = [...tenantRows, ...sharedRows]
      return rerankRows(
        query,
        rows,
        RETURN_LIMIT,
        (r: any) => {
          const brandRange = [r.brand, r.range_series].filter(Boolean).join(' ')
          return brandRange ? `${brandRange} ${r.name}` : r.name
        },
      )
    },
  })
}

// Backward-compat static export — shared catalogue only (pre-WP2 behaviour).
export const lookupMaterial = makeLookupMaterial(null)

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
