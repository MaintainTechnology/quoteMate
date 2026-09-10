// Electrical plan pricing must use an adopted tenant book and tenant-owned
// assemblies. Shared examples are setup material, never customer-price inputs.
// Both interactive and SMS estimators consume this one validated context.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { priceTakeoff, type AssemblyRow, type PricingBook, type TakeoffItem } from './price'

const ASSEMBLY_COLS = 'id, tenant_id, trade, enabled, name, category, default_unit_price_ex_gst, default_labour_hours, default_unit'
const BOOK_COLS = 'id, tenant_id, trade, hourly_rate, default_markup_pct, min_labour_hours, gst_registered'

export class ElectricalPricingError extends Error {
  constructor(
    public readonly code: 'tenant_pricing_required' | 'pricing_unavailable' | 'invalid_takeoff',
    message: string,
    public readonly status = 422,
  ) {
    super(message)
    this.name = 'ElectricalPricingError'
  }
}

export type ElectricalPricingAuthority = {
  source: 'tenant_pricing_book'
  tenant_id: string
  trade: 'electrical'
  pricing_book_id: string
  revision: string
}

export type PricingContext = {
  assemblies: AssemblyRow[]
  book: PricingBook
  bookSource: 'tenant'
  authority: ElectricalPricingAuthority
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteRange(value: unknown, min: number, max = Number.MAX_VALUE): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function required(message: string): never {
  throw new ElectricalPricingError('tenant_pricing_required', message)
}

export async function loadElectricalPricingContext(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<PricingContext> {
  const [own, custom] = await Promise.all([
    supabase.from('pricing_book').select(BOOK_COLS)
      .eq('tenant_id', tenantId).eq('trade', 'electrical').maybeSingle(),
    supabase.from('tenant_custom_assemblies').select(ASSEMBLY_COLS)
      .eq('tenant_id', tenantId).eq('trade', 'electrical').eq('enabled', true),
  ])
  if (own.error || custom.error) {
    throw new ElectricalPricingError('pricing_unavailable', 'Pricing could not be loaded. Please retry.', 503)
  }

  const row = record(own.data)
  if (!row || typeof row.id !== 'string' || !row.id || row.tenant_id !== tenantId || row.trade !== 'electrical') {
    required('Set up your electrical pricing book before pricing this take-off.')
  }
  if (!finiteRange(row.hourly_rate, 0) || row.hourly_rate === 0 ||
      !finiteRange(row.default_markup_pct, 0, 100) ||
      !finiteRange(row.min_labour_hours, 0, 8) || typeof row.gst_registered !== 'boolean') {
    required('Complete your electrical hourly rate, markup, minimum hours and GST settings before pricing.')
  }
  const book: PricingBook = {
    hourly_rate: row.hourly_rate,
    default_markup_pct: row.default_markup_pct,
    min_labour_hours: row.min_labour_hours,
    gst_registered: row.gst_registered,
  }

  if (!Array.isArray(custom.data) || custom.data.length === 0) {
    required('Add your own electrical service prices before pricing this take-off.')
  }
  const owned = custom.data.map((value) => {
    const assembly = record(value)
    if (!assembly || typeof assembly.id !== 'string' || !assembly.id ||
        assembly.tenant_id !== tenantId || assembly.trade !== 'electrical' || assembly.enabled !== true ||
        typeof assembly.name !== 'string' || !assembly.name.trim() ||
        !finiteRange(assembly.default_unit_price_ex_gst, 0, 100_000) ||
        !finiteRange(assembly.default_labour_hours, 0, 80)) {
      required('Complete your enabled electrical service prices and labour hours before pricing.')
    }
    return {
      id: assembly.id,
      name: assembly.name,
      category: typeof assembly.category === 'string' ? assembly.category : null,
      default_unit_price_ex_gst: assembly.default_unit_price_ex_gst,
      default_labour_hours: assembly.default_labour_hours,
      default_unit: typeof assembly.default_unit === 'string' ? assembly.default_unit : null,
    }
  }).sort((a, b) => a.id.localeCompare(b.id))

  // Stable ordering also makes equal-score assembly matching deterministic.
  // Hash the exact normalized data consumed by the pricer, not timestamps that
  // may fail to change when an assembly is edited through another writer.
  const authority: ElectricalPricingAuthority = {
    source: 'tenant_pricing_book',
    tenant_id: tenantId,
    trade: 'electrical',
    pricing_book_id: row.id,
    revision: createHash('sha256')
      .update(JSON.stringify({ tenantId, bookId: row.id, book, assemblies: owned }))
      .digest('hex'),
  }
  return { assemblies: owned, book, bookSource: 'tenant', authority }
}

/** Keep the pure pricer's compatibility defaults away from production inputs. */
export function priceElectricalTakeoff(items: TakeoffItem[], context: PricingContext) {
  if (items.some((item) => typeof item.type !== 'string' || !item.type.trim() ||
    !Number.isSafeInteger(item.count) || item.count < 0)) {
    throw new ElectricalPricingError('invalid_takeoff', 'Item counts must be finite non-negative whole numbers.', 400)
  }
  const bom = priceTakeoff(items, context.assemblies, context.book)
  if ([bom.materialExGst, bom.labourExGst, bom.labourFloorAddedExGst, bom.subtotalExGst,
    bom.gstExGst, bom.totalIncGst, ...bom.lines.flatMap((line) => [line.unitPriceExGst,
      line.materialExGst, line.labourHours, line.labourExGst, line.lineExGst])]
    .some((amount) => !Number.isFinite(amount) || amount < 0)) {
    required('The electrical prices exceed the supported calculation range. Review your rates and quantities.')
  }
  // Empty or zero-count extraction results are counts-only, even when a
  // minimum labour charge could otherwise produce a non-zero total.
  const pricingComplete = bom.lines.some((line) => line.count > 0) && bom.unmatched.length === 0
  return { ...bom, pricingAuthority: context.authority, pricingComplete }
}
