import { describe, it, expect } from 'vitest'
import { planServicesUpload, planMaterialsUpload } from './batch'
import { SERVICES_CSV_COLUMNS, serviceKey, type ServicesRowContext } from './services-csv'
import { MATERIALS_CSV_COLUMNS, type MaterialsRowContext } from './materials-csv'
import { tradeNameKey } from './csv'

const SVC_HEADER = SERVICES_CSV_COLUMNS.join(',')
const MAT_HEADER = MATERIALS_CSV_COLUMNS.join(',')

function svcCtx(over: Partial<ServicesRowContext> = {}): ServicesRowContext {
  return {
    knownTrades: new Set(['electrical', 'plumbing']),
    knownCategories: new Set(['downlight', 'gpo', 'hot_water']),
    existingServiceKeys: new Set<string>(),
    tradeHasLiveTenants: () => false,
    ...over,
  }
}

function matCtx(over: Partial<MaterialsRowContext> = {}): MaterialsRowContext {
  return {
    knownTrades: new Set(['electrical', 'plumbing']),
    existingMaterialKeys: new Set<string>(),
    ...over,
  }
}

describe('planServicesUpload', () => {
  it('returns a structural failure for a bad header', () => {
    const plan = planServicesUpload('trade,name\nelectrical,X', svcCtx())
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.structuralErrors.length).toBeGreaterThan(0)
  })

  it('classifies NEW, UPDATE and REJECT rows in one batch', () => {
    const csv = [
      SVC_HEADER,
      'electrical,Install downlight,d,each,35,1.5,none,downlight,,,,,,false', // NEW
      'electrical,Replace GPO,d,each,22,0.3,none,gpo,,,,,,false', // UPDATE (seeded below)
      'electrical,Bad row,d,each,0,1,none,downlight,,,,,,false', // REJECT (fee 0)
      'carpentry,Wrong trade,d,each,50,1,none,downlight,,,,,,false', // REJECT (trade)
    ].join('\n')
    const plan = planServicesUpload(
      csv,
      svcCtx({
        existingServiceKeys: new Set([serviceKey('electrical', 'Replace GPO')]),
      }),
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.summary).toEqual({ newCount: 1, updateCount: 1, rejectedCount: 2 })
      expect(plan.stagedRows).toHaveLength(2)
      expect(plan.stagedRows.every((r) => r.target_table === 'shared_assemblies')).toBe(true)
      // Reject line numbers are 1-based and include the header row.
      expect(plan.rejected.map((r) => r.line)).toEqual([4, 5])
    }
  })

  it('counts rows whose default_enabled was forced false (§9 rule 3)', () => {
    const csv = [
      SVC_HEADER,
      'electrical,Svc A,d,each,35,1,none,downlight,,,,,,true',
      'electrical,Svc B,d,each,35,1,none,gpo,,,,,,true',
    ].join('\n')
    const plan = planServicesUpload(csv, svcCtx({ tradeHasLiveTenants: () => true }))
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.forcedDisabledCount).toBe(2)
      expect(plan.stagedRows.every((r) => r.payload.default_enabled === false)).toBe(true)
    }
  })

  it('rejects an intra-batch duplicate (trade,name)', () => {
    const csv = [
      SVC_HEADER,
      'electrical,Dup,d,each,35,1,none,downlight,,,,,,false',
      'electrical,Dup,d,each,40,1,none,downlight,,,,,,false',
    ].join('\n')
    const plan = planServicesUpload(csv, svcCtx())
    if (plan.ok) {
      expect(plan.summary.newCount).toBe(1)
      expect(plan.summary.rejectedCount).toBe(1)
    }
  })
})

describe('planMaterialsUpload', () => {
  it('classifies NEW and UPDATE material rows', () => {
    const csv = [
      MAT_HEADER,
      'plumbing,Electric HWS 250L,Rheem,each,750', // UPDATE (seeded)
      'plumbing,Heat pump HWS 270L,Reclaim,each,2200', // NEW
    ].join('\n')
    const plan = planMaterialsUpload(
      csv,
      matCtx({
        existingMaterialKeys: new Set([
          tradeNameKey('plumbing', 'Electric HWS 250L'),
        ]),
      }),
    )
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.summary).toEqual({ newCount: 1, updateCount: 1, rejectedCount: 0 })
      expect(plan.target_table).toBe('shared_materials')
      expect(plan.forcedDisabledCount).toBe(0)
    }
  })

  it('rejects a material with a non-positive price', () => {
    const csv = `${MAT_HEADER}\nplumbing,Freebie,Acme,each,0`
    const plan = planMaterialsUpload(csv, matCtx())
    if (plan.ok) {
      expect(plan.summary.rejectedCount).toBe(1)
      expect(plan.stagedRows).toHaveLength(0)
    }
  })
})
