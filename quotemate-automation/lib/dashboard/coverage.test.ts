// Tests for the catalogue coverage pure module.
// No DB, no fetch — just shape-the-rows → assert-the-report.

import { describe, expect, it } from 'vitest'
import {
  computeCoverage,
  type SharedMaterialRow,
  type TenantMaterialRow,
} from './coverage'

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const SHARED_PLUMBING: SharedMaterialRow[] = [
  // 3 hws_electric rows
  { trade: 'plumbing', category: 'hws_electric' },
  { trade: 'plumbing', category: 'hws_electric' },
  { trade: 'plumbing', category: 'hws_electric' },
  // 2 hws_gas rows
  { trade: 'plumbing', category: 'hws_gas' },
  { trade: 'plumbing', category: 'hws_gas' },
  // 1 hws_heat_pump row
  { trade: 'plumbing', category: 'hws_heat_pump' },
  // 1 tapware_basin row
  { trade: 'plumbing', category: 'tapware_basin' },
]

const SHARED_ELECTRICAL: SharedMaterialRow[] = [
  { trade: 'electrical', category: 'gpo' },
  { trade: 'electrical', category: 'gpo' },
  { trade: 'electrical', category: 'downlight' },
]

const SHARED_ALL = [...SHARED_PLUMBING, ...SHARED_ELECTRICAL]

// ──────────────────────────────────────────────────────────────────────
// computeCoverage — basic shape
// ──────────────────────────────────────────────────────────────────────

describe('computeCoverage — basic shape', () => {
  it('returns one TradeCoverage per tenant trade, even when the tenant has 0 rows', () => {
    const r = computeCoverage(['plumbing', 'electrical'], SHARED_ALL, [])
    expect(r.trades_active).toEqual(['plumbing', 'electrical'])
    expect(r.by_trade).toHaveLength(2)
    expect(r.by_trade[0].trade).toBe('plumbing')
    expect(r.by_trade[1].trade).toBe('electrical')
  })

  it('returns empty by_trade when the tenant has no trades', () => {
    const r = computeCoverage([], SHARED_ALL, [])
    expect(r.trades_active).toEqual([])
    expect(r.by_trade).toEqual([])
  })

  it('drops null/empty trade entries from tradesActive', () => {
    const r = computeCoverage(
      ['plumbing', '', null as unknown as string, '   '],
      SHARED_ALL,
      [],
    )
    expect(r.trades_active).toEqual(['plumbing'])
    expect(r.by_trade).toHaveLength(1)
  })

  it('normalises trade casing on input', () => {
    const r = computeCoverage(['PLUMBING'], SHARED_ALL, [])
    expect(r.trades_active).toEqual(['plumbing'])
  })
})

// ──────────────────────────────────────────────────────────────────────
// Per-trade rollup math
// ──────────────────────────────────────────────────────────────────────

describe('computeCoverage — per-trade rollup', () => {
  it('zero tenant rows → 0% coverage, all categories uncovered', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [])
    const p = r.by_trade[0]
    expect(p.total_shared_categories).toBe(4) // hws_electric, hws_gas, hws_heat_pump, tapware_basin
    expect(p.covered_categories).toBe(0)
    expect(p.uncovered_categories).toBe(4)
    expect(p.coverage_pct).toBe(0)
    // 3 + 2 + 1 + 1 = 7 missing shared rows
    expect(p.missing_rows_total).toBe(7)
  })

  it('one tenant row in one category → that category covered, others missing', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'hws_electric', active: true },
    ])
    const p = r.by_trade[0]
    expect(p.covered_categories).toBe(1)
    expect(p.coverage_pct).toBe(25) // 1 of 4
    // 3 shared - 1 tenant = 2 missing in hws_electric; + 2 hws_gas + 1 hws_heat_pump + 1 tapware = 6 total
    expect(p.missing_rows_total).toBe(6)
    const hwsElec = p.categories.find((c) => c.category === 'hws_electric')!
    expect(hwsElec.shared_count).toBe(3)
    expect(hwsElec.tenant_count).toBe(1)
    expect(hwsElec.missing_count).toBe(2)
    expect(hwsElec.covered).toBe(true)
  })

  it('tenant has more rows than shared → missing_count clamps to 0', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'hws_heat_pump', active: true },
      { trade: 'plumbing', category: 'hws_heat_pump', active: true },
      { trade: 'plumbing', category: 'hws_heat_pump', active: true },
    ])
    const p = r.by_trade[0]
    const heatPump = p.categories.find((c) => c.category === 'hws_heat_pump')!
    expect(heatPump.shared_count).toBe(1)
    expect(heatPump.tenant_count).toBe(3)
    expect(heatPump.missing_count).toBe(0)
    expect(heatPump.covered).toBe(true)
  })

  it('tenant has a category not in the shared catalogue → reported but does NOT lower coverage_pct', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'cctv', active: true },
    ])
    const p = r.by_trade[0]
    // shared categories: 4 (hws_electric, hws_gas, hws_heat_pump, tapware_basin)
    // tenant has 0 of those 4 covered → 0%
    expect(p.total_shared_categories).toBe(4)
    expect(p.covered_categories).toBe(0)
    expect(p.coverage_pct).toBe(0)
    // The cctv category appears in categories[] but shared_count is 0
    const cctv = p.categories.find((c) => c.category === 'cctv')!
    expect(cctv.shared_count).toBe(0)
    expect(cctv.tenant_count).toBe(1)
    expect(cctv.covered).toBe(true)
    expect(cctv.missing_count).toBe(0)
  })

  it('100% coverage when tenant has at least one row in every shared category', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'hws_electric', active: true },
      { trade: 'plumbing', category: 'hws_gas', active: true },
      { trade: 'plumbing', category: 'hws_heat_pump', active: true },
      { trade: 'plumbing', category: 'tapware_basin', active: true },
    ])
    const p = r.by_trade[0]
    expect(p.coverage_pct).toBe(100)
    expect(p.covered_categories).toBe(4)
    expect(p.uncovered_categories).toBe(0)
  })

  it('rounds coverage_pct to the nearest integer', () => {
    // 3 of 4 shared categories covered = 75% — no rounding
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'hws_electric', active: true },
      { trade: 'plumbing', category: 'hws_gas', active: true },
      { trade: 'plumbing', category: 'hws_heat_pump', active: true },
    ])
    expect(r.by_trade[0].coverage_pct).toBe(75)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Per-category breakdown
// ──────────────────────────────────────────────────────────────────────

describe('computeCoverage — per-category breakdown', () => {
  it('emits one CategoryCoverage per distinct shared category, sorted by slug', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [])
    const slugs = r.by_trade[0].categories.map((c) => c.category)
    expect(slugs).toEqual(['hws_electric', 'hws_gas', 'hws_heat_pump', 'tapware_basin'])
  })

  it('a covered category sets covered=true', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'hws_electric', active: true },
    ])
    const p = r.by_trade[0]
    const hwsElec = p.categories.find((c) => c.category === 'hws_electric')!
    expect(hwsElec.covered).toBe(true)
    const hwsGas = p.categories.find((c) => c.category === 'hws_gas')!
    expect(hwsGas.covered).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Active flag handling
// ──────────────────────────────────────────────────────────────────────

describe('computeCoverage — active flag', () => {
  it('treats active=true as present', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'hws_electric', active: true },
    ])
    expect(r.by_trade[0].categories.find((c) => c.category === 'hws_electric')!.tenant_count).toBe(1)
  })

  it('treats explicit active=false as absent', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'hws_electric', active: false },
    ])
    expect(r.by_trade[0].categories.find((c) => c.category === 'hws_electric')!.tenant_count).toBe(0)
    expect(r.by_trade[0].covered_categories).toBe(0)
  })

  it('treats missing active as present (default true)', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'hws_electric' },
    ])
    expect(r.by_trade[0].categories.find((c) => c.category === 'hws_electric')!.tenant_count).toBe(1)
  })

  it('treats active=null as present (matches dashboard convention)', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: 'plumbing', category: 'hws_electric', active: null },
    ])
    expect(r.by_trade[0].categories.find((c) => c.category === 'hws_electric')!.tenant_count).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Multi-trade isolation
// ──────────────────────────────────────────────────────────────────────

describe('computeCoverage — multi-trade isolation', () => {
  it('counts only the trade-matching rows for each trade rollup', () => {
    const tenantRows: TenantMaterialRow[] = [
      { trade: 'plumbing', category: 'hws_electric', active: true },
      { trade: 'electrical', category: 'gpo', active: true },
    ]
    const r = computeCoverage(['plumbing', 'electrical'], SHARED_ALL, tenantRows)
    const plumbing = r.by_trade.find((t) => t.trade === 'plumbing')!
    const electrical = r.by_trade.find((t) => t.trade === 'electrical')!
    expect(plumbing.covered_categories).toBe(1)
    expect(electrical.covered_categories).toBe(1)
  })

  it('a tenant electrical row does NOT count against plumbing coverage', () => {
    const r = computeCoverage(['plumbing', 'electrical'], SHARED_ALL, [
      { trade: 'electrical', category: 'gpo', active: true },
    ])
    const plumbing = r.by_trade.find((t) => t.trade === 'plumbing')!
    expect(plumbing.covered_categories).toBe(0)
    expect(plumbing.coverage_pct).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Bad/empty inputs
// ──────────────────────────────────────────────────────────────────────

describe('computeCoverage — bad input handling', () => {
  it('drops shared rows with null trade', () => {
    const r = computeCoverage(['plumbing'], [
      { trade: null, category: 'hws_electric' },
      { trade: 'plumbing', category: 'hws_electric' },
    ], [])
    expect(r.by_trade[0].categories.find((c) => c.category === 'hws_electric')!.shared_count).toBe(1)
  })

  it('drops shared rows with null category', () => {
    const r = computeCoverage(['plumbing'], [
      { trade: 'plumbing', category: null },
      { trade: 'plumbing', category: 'hws_electric' },
    ], [])
    expect(r.by_trade[0].total_shared_categories).toBe(1)
  })

  it('drops tenant rows with null trade or category', () => {
    const r = computeCoverage(['plumbing'], SHARED_PLUMBING, [
      { trade: null, category: 'hws_electric', active: true },
      { trade: 'plumbing', category: null, active: true },
    ])
    expect(r.by_trade[0].covered_categories).toBe(0)
  })

  it('shared catalogue empty for a trade → coverage_pct is 0 (no division by zero)', () => {
    const r = computeCoverage(['plumbing'], [], [])
    expect(r.by_trade[0].coverage_pct).toBe(0)
    expect(r.by_trade[0].total_shared_categories).toBe(0)
  })
})
