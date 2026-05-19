// Tenant BOM-line schema coverage (migration 031 recipe editor).

import { describe, expect, it } from 'vitest'
import { TenantBomLineSchema, TenantBomLinePatchSchema } from './update-schema'

// A real RFC-compliant v4 UUID (Zod 4's .uuid() validates variant bits;
// an all-ones string is NOT a valid UUID and is correctly rejected).
const ASM = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

describe('TenantBomLineSchema', () => {
  it('accepts a valid required line', () => {
    const r = TenantBomLineSchema.safeParse({
      assembly_id: ASM,
      trade: 'electrical',
      material_category: 'downlight',
      quantity: 6,
      required: true,
      sort: 1,
    })
    expect(r.success).toBe(true)
  })

  it('accepts a minimal line (required/sort/description omitted)', () => {
    const r = TenantBomLineSchema.safeParse({
      assembly_id: ASM,
      trade: 'plumbing',
      material_category: 'tap',
      quantity: 1,
    })
    expect(r.success).toBe(true)
  })

  it('coerces a numeric-string quantity', () => {
    const r = TenantBomLineSchema.safeParse({
      assembly_id: ASM, trade: 'electrical', material_category: 'sundry', quantity: '2',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.quantity).toBe(2)
  })

  it('rejects a non-uuid assembly, missing category, zero/negative qty, bad trade', () => {
    expect(TenantBomLineSchema.safeParse({ assembly_id: 'nope', trade: 'electrical', material_category: 'x', quantity: 1 }).success).toBe(false)
    expect(TenantBomLineSchema.safeParse({ assembly_id: ASM, trade: 'electrical', quantity: 1 }).success).toBe(false)
    expect(TenantBomLineSchema.safeParse({ assembly_id: ASM, trade: 'electrical', material_category: 'x', quantity: 0 }).success).toBe(false)
    expect(TenantBomLineSchema.safeParse({ assembly_id: ASM, trade: 'gas', material_category: 'x', quantity: 1 }).success).toBe(false)
  })

  it('patch schema allows a single-field partial (e.g. just quantity)', () => {
    expect(TenantBomLinePatchSchema.safeParse({ quantity: 3 }).success).toBe(true)
  })
})
