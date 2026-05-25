// H-1 (2026-05-25) coverage for applyCustomerSupplyMode — the pure helper
// behind makeLookupMaterial's WP5 supply-mode pricing.
//
// Pre-2026-05-25 behaviour: when the caller asked for customer-supply
// pricing but the tenant row had no customer_supply_price_ex_gst set,
// the row silently fell through to the full supply-and-install price
// with is_customer_supply=false. The prompt rule still wrote
// "Customer to supply — …" on the line, so the customer was double-
// billed for materials they were already buying themselves AND the
// grounding validator couldn't catch it because the resulting price IS
// in the candidate set.
//
// New behaviour: rows that can't satisfy a customer-supply request are
// DROPPED. The prompt's new step 7 ("FALLBACK") teaches Opus to call
// flag_inspection_needed when no customer-supply-capable row remains.

import { describe, expect, it } from 'vitest'
import { applyCustomerSupplyMode } from './tools'

describe('applyCustomerSupplyMode (WP5 + H-1)', () => {
  const row = {
    id: 'mat-1',
    tenant_id: 't-1',
    trade: 'electrical',
    name: 'Clipsal Iconic GPO',
    brand: 'Clipsal',
    range_series: 'Iconic',
    unit_price_ex_gst: 22,
    customer_supply_price_ex_gst: 8,
    active: true,
  }

  describe('tradie-supply mode (wantCustomerSupply=false)', () => {
    it('returns the row with the standard unit_price and is_customer_supply=false', () => {
      const result = applyCustomerSupplyMode(row, false)
      expect(result).not.toBeNull()
      expect(result!.default_unit_price_ex_gst).toBe(22)
      expect(result!.is_customer_supply).toBe(false)
      expect(result!.is_tenant).toBe(true)
    })

    it('does NOT drop rows missing customer_supply_price_ex_gst (tradie mode is unaffected)', () => {
      const rowNoCs = { ...row, customer_supply_price_ex_gst: null }
      const result = applyCustomerSupplyMode(rowNoCs, false)
      expect(result).not.toBeNull()
      expect(result!.default_unit_price_ex_gst).toBe(22)
      expect(result!.is_customer_supply).toBe(false)
    })
  })

  describe('customer-supply mode (wantCustomerSupply=true) — VALID csPrice', () => {
    it('flips to customer_supply_price_ex_gst and stamps is_customer_supply=true', () => {
      const result = applyCustomerSupplyMode(row, true)
      expect(result).not.toBeNull()
      expect(result!.default_unit_price_ex_gst).toBe(8)
      expect(result!.is_customer_supply).toBe(true)
    })

    it('parses string-encoded csPrice (numeric strings from Supabase)', () => {
      const rowStringCs = { ...row, customer_supply_price_ex_gst: '12.50' }
      const result = applyCustomerSupplyMode(rowStringCs, true)
      expect(result).not.toBeNull()
      expect(result!.default_unit_price_ex_gst).toBe(12.5)
      expect(result!.is_customer_supply).toBe(true)
    })
  })

  describe('customer-supply mode (wantCustomerSupply=true) — INVALID csPrice (H-1)', () => {
    it('returns null when csPrice is null', () => {
      const rowNoCs = { ...row, customer_supply_price_ex_gst: null }
      expect(applyCustomerSupplyMode(rowNoCs, true)).toBeNull()
    })

    it('returns null when csPrice is undefined', () => {
      const rowNoCs = { ...row, customer_supply_price_ex_gst: undefined }
      expect(applyCustomerSupplyMode(rowNoCs, true)).toBeNull()
    })

    it('returns null when csPrice is 0', () => {
      const rowZeroCs = { ...row, customer_supply_price_ex_gst: 0 }
      expect(applyCustomerSupplyMode(rowZeroCs, true)).toBeNull()
    })

    it('returns null when csPrice is negative', () => {
      const rowNegCs = { ...row, customer_supply_price_ex_gst: -5 }
      expect(applyCustomerSupplyMode(rowNegCs, true)).toBeNull()
    })

    it('returns null when csPrice is NaN', () => {
      const rowNanCs = { ...row, customer_supply_price_ex_gst: 'not-a-number' }
      expect(applyCustomerSupplyMode(rowNanCs, true)).toBeNull()
    })

    it('CRITICAL: never returns the row with the full unit_price labelled as customer-supply', () => {
      // This is the pre-H-1 bug: the row would come back with
      // default_unit_price_ex_gst=22 (full price) and is_customer_supply=false,
      // but the prompt would still write "Customer to supply — …" because
      // the SCOPE.SPECS.SUPPLIED_BY was 'customer'. The customer paid for
      // the GPO they already bought themselves.
      const rowNoCs = { ...row, customer_supply_price_ex_gst: null }
      const result = applyCustomerSupplyMode(rowNoCs, true)
      // The fix: the row is filtered out entirely. If it WERE returned,
      // is_customer_supply would have to be true (so the prompt could
      // mark the line correctly) AND the price would have to be
      // install-only — neither is possible without a configured csPrice.
      expect(result).toBeNull()
    })
  })
})
