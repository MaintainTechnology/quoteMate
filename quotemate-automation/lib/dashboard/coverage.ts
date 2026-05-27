// Catalogue coverage — pure module that computes the diff between the
// global shared_materials catalogue and a tenant's own
// tenant_material_catalogue, surfaced on the dashboard's Catalogue tab.
//
// "Coverage" answers the question: of all the material categories the
// shared catalogue stocks for this tenant's trade(s), how many does the
// tenant have AT LEAST ONE row for, and how many shared rows would they
// still be missing per category if they wanted full breadth?
//
// The dashboard panel uses the output to nudge the tradie:
//   "Plumbing — 1 of 8 categories covered, 24 shared rows missing.
//    [▸ See gaps]"
// and the See-gaps expander deep-links into the Browse Supplier Catalogue
// tab pre-filtered to a specific (trade, category) pair.
//
// This module is intentionally pure — no DB, no fetch, no React. The
// caller queries shared_materials + tenant_material_catalogue, hands the
// rows to computeCoverage(), and gets back the report. Easy to test
// without mocking Supabase.

// ─────────────────────────────────────────────────────────────────────
// Row shapes — only the columns coverage cares about.
// ─────────────────────────────────────────────────────────────────────

export type SharedMaterialRow = {
  trade: string | null
  category: string | null
}

export type TenantMaterialRow = {
  trade: string | null
  category: string | null
  active?: boolean | null
}

// ─────────────────────────────────────────────────────────────────────
// Output shape
// ─────────────────────────────────────────────────────────────────────

/** One category's slice of the coverage report. */
export type CategoryCoverage = {
  /** Category slug as stored on the rows (e.g. "hws_electric"). */
  category: string
  /** How many shared rows exist for this (trade, category). */
  shared_count: number
  /** How many ACTIVE tenant rows exist for this (trade, category). */
  tenant_count: number
  /** Shared rows the tenant doesn't have yet. clamped to >= 0 so an
   *  over-stocked tenant (more tenant rows than shared) reports 0. */
  missing_count: number
  /** True when the tenant has at least one row in this category. */
  covered: boolean
}

/** Per-trade rollup. */
export type TradeCoverage = {
  trade: string
  /** Distinct categories the shared catalogue stocks for this trade. */
  total_shared_categories: number
  /** Distinct categories the tenant has AT LEAST ONE active row in. */
  covered_categories: number
  /** total_shared_categories - covered_categories. */
  uncovered_categories: number
  /** Sum of missing_count across every shared category. */
  missing_rows_total: number
  /** 0..100, integer, derived from covered_categories /
   *  total_shared_categories. Returns 0 when there are no shared
   *  categories at all. */
  coverage_pct: number
  /** All categories the shared catalogue stocks for this trade, sorted
   *  by category slug. Even covered categories appear so the dashboard
   *  can show "you have 1 of 4 hws_electric — 3 missing". */
  categories: CategoryCoverage[]
}

/** Top-level report returned by the /api/tenant/catalogue/coverage route. */
export type CoverageReport = {
  /** The trades the tenant operates in (mirrors what the route resolves
   *  from tenants.trades). */
  trades_active: string[]
  /** Per-trade rollups, in the same order as trades_active. */
  by_trade: TradeCoverage[]
}

// ─────────────────────────────────────────────────────────────────────
// Pure computation
// ─────────────────────────────────────────────────────────────────────

function normTrade(t: string | null | undefined): string | null {
  const s = (t ?? '').trim().toLowerCase()
  return s.length > 0 ? s : null
}

function normCategory(c: string | null | undefined): string | null {
  const s = (c ?? '').trim().toLowerCase()
  return s.length > 0 ? s : null
}

/**
 * Compute the coverage report from raw rows.
 *
 * @param tradesActive  Trades the tenant operates in (e.g. ["electrical","plumbing"]).
 *                      The report includes one TradeCoverage per entry, even
 *                      when the tenant has zero rows in that trade.
 * @param sharedRows    Every shared_materials row across all trades. Filtered
 *                      internally by trade. NULL trade/category are dropped.
 * @param tenantRows    Every tenant_material_catalogue row for THIS tenant.
 *                      Inactive rows are skipped. NULL trade/category are dropped.
 */
export function computeCoverage(
  tradesActive: string[],
  sharedRows: SharedMaterialRow[],
  tenantRows: TenantMaterialRow[],
): CoverageReport {
  const trades = tradesActive
    .map(normTrade)
    .filter((t): t is string => t !== null)

  // Group shared rows by trade -> category -> count
  const sharedByTrade = new Map<string, Map<string, number>>()
  for (const row of sharedRows) {
    const trade = normTrade(row.trade)
    const category = normCategory(row.category)
    if (!trade || !category) continue
    if (!sharedByTrade.has(trade)) sharedByTrade.set(trade, new Map())
    const cats = sharedByTrade.get(trade)!
    cats.set(category, (cats.get(category) ?? 0) + 1)
  }

  // Group active tenant rows by trade -> category -> count
  const tenantByTrade = new Map<string, Map<string, number>>()
  for (const row of tenantRows) {
    // Default active to true when the column is missing/undefined — matches
    // the dashboard's own treatment (the catalogue tab hides explicitly
    // active=false rows but treats missing as active).
    if (row.active === false) continue
    const trade = normTrade(row.trade)
    const category = normCategory(row.category)
    if (!trade || !category) continue
    if (!tenantByTrade.has(trade)) tenantByTrade.set(trade, new Map())
    const cats = tenantByTrade.get(trade)!
    cats.set(category, (cats.get(category) ?? 0) + 1)
  }

  const byTrade: TradeCoverage[] = trades.map((trade) => {
    const sharedCats = sharedByTrade.get(trade) ?? new Map<string, number>()
    const tenantCats = tenantByTrade.get(trade) ?? new Map<string, number>()

    // Every shared category for this trade, plus any tenant categories
    // that AREN'T in the shared catalogue (those report shared_count=0,
    // useful as a "tenant has a one-off custom category" signal).
    const allCats = new Set<string>([
      ...sharedCats.keys(),
      ...tenantCats.keys(),
    ])

    const categories: CategoryCoverage[] = Array.from(allCats)
      .sort()
      .map((category) => {
        const sharedCount = sharedCats.get(category) ?? 0
        const tenantCount = tenantCats.get(category) ?? 0
        const missingCount = Math.max(0, sharedCount - tenantCount)
        return {
          category,
          shared_count: sharedCount,
          tenant_count: tenantCount,
          missing_count: missingCount,
          covered: tenantCount >= 1,
        }
      })

    // Coverage stats are computed off the SHARED catalogue universe only —
    // a tenant-only custom category doesn't penalise their coverage_pct.
    const sharedCategories = categories.filter((c) => c.shared_count > 0)
    const coveredCategories = sharedCategories.filter((c) => c.covered).length
    const totalSharedCategories = sharedCategories.length
    const missingRowsTotal = sharedCategories.reduce(
      (sum, c) => sum + c.missing_count,
      0,
    )
    const coveragePct =
      totalSharedCategories === 0
        ? 0
        : Math.round((coveredCategories / totalSharedCategories) * 100)

    return {
      trade,
      total_shared_categories: totalSharedCategories,
      covered_categories: coveredCategories,
      uncovered_categories: totalSharedCategories - coveredCategories,
      missing_rows_total: missingRowsTotal,
      coverage_pct: coveragePct,
      categories,
    }
  })

  return {
    trades_active: trades,
    by_trade: byTrade,
  }
}
