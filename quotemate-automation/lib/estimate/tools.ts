import { tool } from 'ai'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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
    'Search the assembly library by name plus optional filters. ' +
    'ALWAYS pass `trade` ("electrical" or "plumbing") — the DB carries both ' +
    'and queries without trade may return non-sensical cross-trade matches. ' +
    'For electrical jobs, when intake.scope.specs has values (color_temp, ' +
    'dimmable, smart, weatherproof, supplied_by), PASS THEM THROUGH so only ' +
    'matching assemblies are returned. ' +
    'Example: lookupAssembly({ query: "outdoor light", trade: "electrical", weatherproof: true }) ' +
    'returns only outdoor-rated electrical assemblies.',
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
    const { data } = await q.limit(5)
    return data ?? []
  },
})

export const lookupMaterial = tool({
  description:
    'Search materials by name or brand plus optional filters. ' +
    'ALWAYS pass `trade` ("electrical" or "plumbing") — the DB carries both ' +
    'and unfiltered queries may return cross-trade matches. ' +
    'For electrical jobs, when intake.scope.specs has values, PASS THEM THROUGH. ' +
    'Example: lookupMaterial({ query: "downlight", trade: "electrical", color_temp: "warm_white", dimmable: true }) ' +
    'returns only warm-white-capable, dimmable electrical downlights.',
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
    const { data } = await q.limit(5)
    return data ?? []
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
