import type { SupabaseClient } from '@supabase/supabase-js'
import type { QuoteFamily } from './quote-actions'
import { createHash } from 'node:crypto'
import { readRichPaintReview } from '@/lib/commercial-painting/rich-run-review'

export const REVIEW_TABLES = { roof: 'roofing_measurements', paint: 'painting_measurements', solar: 'solar_estimates',
  plan: 'plan_extractions', aircon: 'aircon_recommendations', 'commercial-paint': 'paint_runs' } as const
export type ReviewFamily = keyof typeof REVIEW_TABLES
type Row = Record<string, unknown>
const obj = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const strings = (value: unknown): string[] => list(value).filter((s): s is string => typeof s === 'string')
const money = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
export type SavedQuoteReview = {
  family: QuoteFamily; id: string; token: string; address: string; customerPhone: string | null; createdAt: string
  approved: boolean; canApprove: boolean; warnings: string[]; scope: string[]
  amounts: Array<{ label: string; incGst: number | null; highIncGst?: number | null }>
  quantities: Array<{ label: string; quantity: string }>
  version: string
  /** Internal comparison only; the GET response strips the full row. */
  sourceSnapshot: Row
}

export async function loadSavedQuoteReview(db: SupabaseClient, tenantId: string, family: ReviewFamily, id: string): Promise<SavedQuoteReview | null> {
  const { data, error } = await db.from(REVIEW_TABLES[family]).select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle()
  if (error) throw new Error('Saved result temporarily unavailable')
  if (!data) return null
  const row = data as Row
  let phone = typeof row.customer_phone === 'string' ? row.customer_phone : null
  let content = obj(family === 'roof' ? row.quote : family === 'aircon' ? row.recommendation : row.estimate)
  let paintBinding: Awaited<ReturnType<typeof readRichPaintReview>>['binding'] = null
  if (family === 'solar' && !phone && row.intake_id) {
    const result = await db.from('intakes').select('caller').eq('tenant_id',tenantId).eq('id',row.intake_id).maybeSingle()
    if (result.error) throw new Error('Customer contact unavailable')
    const candidate = obj(result.data?.caller).phone
    phone = typeof candidate === 'string' ? candidate : null
  }
  if (family === 'plan') {
    const result = await db.from('plan_upload_requests').select('customer_phone').eq('tenant_id',tenantId).eq('plan_extraction_id',id).order('created_at',{ascending:false}).limit(1).maybeSingle()
    if (result.error) throw new Error('Plan customer contact unavailable')
    phone = result.data?.customer_phone ?? null
    content = row
  }
  if (family === 'commercial-paint') {
    const result = await readRichPaintReview(db, tenantId, row)
    content = result.content
    paintBinding = result.binding
  }
  const tiers = family === 'roof' ? list(obj(content.combined).tiers) : list(obj(content.price).tiers)
  const amounts: SavedQuoteReview['amounts'] = tiers.map((value) => {
    const tier = obj(value)
    return { label: String(tier.label ?? tier.tier ?? 'Quote'), incGst: money(tier.net_inc_gst ?? tier.inc_gst) }
  })
  if (family === 'aircon') for (const value of list(content.options)) {
    const option = obj(value); const price = obj(option.price)
    amounts.push({ label: String(option.system_type ?? 'System'), incGst: money(price.low), highIncGst: money(price.high) })
  }
  if (family === 'commercial-paint') amounts.push({ label: 'Tender total', incGst: money(content.totalIncGst) })
  if (family === 'plan' && row.priced_bom) amounts.push({ label: 'Plan total', incGst: money(obj(row.priced_bom).totalIncGst) })
  const scope = [...strings(content.assumptions), ...strings(content.exclusions), ...tiers.flatMap((value) => {
    const tier = obj(value); return typeof tier.scope === 'string' ? [tier.scope] : strings(tier.scope)
  })]
  if (family === 'roof') for (const value of list(content.structures)) {
    const structure = obj(value)
    scope.push(String(structure.label ?? 'Roof structure'))
    for (const tier of list(obj(structure.price).tiers)) if (typeof obj(tier).scope === 'string') scope.push(String(obj(tier).scope))
  }
  if (family === 'aircon') for (const value of list(content.options)) {
    const option = obj(value)
    scope.push(`${String(option.system_type ?? 'System')}: ${String(option.capacity_kw ?? 'unspecified')} kW`, ...strings(option.pros), ...strings(option.cons))
  }
  if (family === 'solar') for (const value of list(obj(content.sizing).tiers)) {
    const tier = obj(value)
    scope.push(`${String(tier.tier ?? 'System')}: ${String(tier.panels_count ?? 'unspecified')} panels, ${String(tier.system_kw_dc ?? 'unspecified')} kW`)
  }
  if (family === 'plan') scope.push(...strings(obj(row.priced_bom).assumptions), ...strings(obj(row.priced_bom).exclusions))
  const routingReason = obj(content.routing).reason ?? obj(obj(content.price).routing).reason
  const warnings = [...strings(content.guardrail_flags), ...(typeof routingReason === 'string' ? [routingReason] : [])]
  if (family === 'plan' && !Array.isArray(row.corrected_items)) warnings.push('Review and save the plan quantities before approving.')
  if (!Object.keys(content).length) warnings.push('The saved result is incomplete. Return to the estimating tool to complete it.')
  const quantities = (family === 'plan' ? list(row.corrected_items ?? row.items) : family === 'commercial-paint' ? list(content.lines) : []).map((value) => {
    const line = obj(value); return { label: String(line.item ?? line.label ?? line.surface ?? line.room ?? 'Item'), quantity: String(line.count ?? line.quantity ?? '—') }
  })
  const validPrices = amounts.length > 0 && amounts.every((amount) => amount.incGst != null && amount.incGst > 0 &&
    (amount.highIncGst == null || amount.highIncGst >= amount.incGst))
  const canApprove = family === 'plan' ? Array.isArray(row.corrected_items) && quantities.length > 0 && (!row.priced_bom || validPrices)
    : validPrices && (family !== 'solar' || (Array.isArray(row.guardrail_flags) && row.guardrail_flags.length === 0)) &&
      (family !== 'commercial-paint' || (row.status === 'priced' && paintBinding !== null))
  if (!canApprove) warnings.push('Complete the saved quantities, pricing and outstanding checks in the estimating tool before sharing this result.')
  return { family, id, token: String(row.public_token ?? row.share_token ?? ''), address: String(row.address ?? row.site_address ?? row.job_name ?? 'Requested work'),
    customerPhone: phone, createdAt: String(row.created_at ?? ''), approved: Boolean(row.released_at ?? row.confirmed_at), canApprove,
    warnings, scope, amounts, quantities, sourceSnapshot: family === 'commercial-paint' ? {...row,_review_priced_bom:content,_review_paint_pricing:paintBinding} : row,
    version: createHash('sha256').update(JSON.stringify(family === 'commercial-paint' ? [row,content,phone,paintBinding] : [row,content,phone])).digest('hex') }
}
