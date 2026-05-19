// CustomServiceSchema.category — proves the custom-service input path is
// wired to the SAME category list the validator uses, and that the safe
// default (omit / empty = auto-detect from name) still works so a tradie
// is never forced to pick a category.

import { describe, expect, it } from 'vitest'
import { CustomServiceSchema } from './update-schema'
import { CATEGORIES } from '@/lib/estimate/categories'

const base = {
  trade: 'electrical' as const,
  name: 'Install pool light',
  default_unit_price_ex_gst: 120,
}

describe('CustomServiceSchema — category', () => {
  it('accepts a valid category from the shared list', () => {
    const r = CustomServiceSchema.safeParse({ ...base, category: 'downlight' })
    expect(r.success).toBe(true)
  })

  it('accepts every category the dashboard dropdown can offer', () => {
    for (const c of CATEGORIES) {
      const r = CustomServiceSchema.safeParse({ ...base, category: c.value })
      expect(r.success, `category ${c.value} should be accepted`).toBe(true)
    }
  })

  it('accepts an omitted category (auto-detect from name — the default)', () => {
    const r = CustomServiceSchema.safeParse(base)
    expect(r.success).toBe(true)
  })

  it("accepts '' (the form's 'auto-detect' option)", () => {
    const r = CustomServiceSchema.safeParse({ ...base, category: '' })
    expect(r.success).toBe(true)
  })

  it('rejects a category that is not in the shared list', () => {
    const r = CustomServiceSchema.safeParse({ ...base, category: 'made_up' })
    expect(r.success).toBe(false)
  })
})
