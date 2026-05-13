// Regression coverage for the dashboard licence + pricing PATCH payload.
//
// History: the user reported "invalid_payload" in red below the Licence
// form on the dashboard for Peppers Plumbing. Root cause: in Zod 4
// `z.record(z.enum([...]), value)` requires EVERY enum value to be
// present in the record. A plumbing-only tenant submits
// `{licences_by_trade: {plumbing: {...}}}` — Zod rejected it for
// missing the `electrical` key. These tests pin the fix
// (z.partialRecord) so the regression can't sneak back in.

import { describe, expect, it } from 'vitest'
import { UpdateSchema } from './update-schema'

describe('UpdateSchema — licences_by_trade (the bug)', () => {
  it("accepts a plumbing-only tenant's licence PATCH payload", () => {
    const payload = {
      licences_by_trade: {
        plumbing: {
          licence_type: 'QBCC',
          licence_number: '123456',
          licence_state: 'QLD',
          licence_expiry: '2029-05-13',
        },
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it("accepts an electrical-only tenant's licence PATCH payload", () => {
    const payload = {
      licences_by_trade: {
        electrical: {
          licence_type: 'NECA NSW',
          licence_number: '789012',
          licence_state: 'NSW',
          licence_expiry: '2027-01-31',
        },
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('accepts a multi-trade tenant updating both licences in one call', () => {
    const payload = {
      licences_by_trade: {
        electrical: {
          licence_type: 'NECA NSW',
          licence_number: '789012',
          licence_state: 'NSW',
          licence_expiry: '2027-01-31',
        },
        plumbing: {
          licence_type: 'QBCC',
          licence_number: '123456',
          licence_state: 'QLD',
          licence_expiry: '2029-05-13',
        },
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('accepts empty string for every nullable field (the dashboard’s "clear" action)', () => {
    const payload = {
      licences_by_trade: {
        plumbing: {
          licence_type: '',
          licence_number: '',
          licence_state: '',
          licence_expiry: '',
        },
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it("accepts a partial update (only licence_number, other fields untouched)", () => {
    const payload = {
      licences_by_trade: {
        plumbing: { licence_number: '999999' },
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('rejects an unknown trade key (typo guard)', () => {
    const payload = {
      licences_by_trade: {
        electrcial: { licence_number: 'X' }, // typo
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects an invalid licence_state', () => {
    const payload = {
      licences_by_trade: {
        plumbing: { licence_state: 'XX' },
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects an oversized licence_type', () => {
    const payload = {
      licences_by_trade: {
        plumbing: { licence_type: 'X'.repeat(41) },
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })
})

describe('UpdateSchema — pricing_by_trade (same class of bug)', () => {
  it('accepts a plumbing-only tenant updating just their plumbing pricing', () => {
    const payload = {
      pricing_by_trade: {
        plumbing: { hourly_rate: 130, call_out_minimum: 120 },
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('accepts a multi-trade tenant updating only one of their pricing books', () => {
    const payload = {
      pricing_by_trade: {
        electrical: { hourly_rate: 110 },
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('rejects negative hourly_rate', () => {
    const payload = {
      pricing_by_trade: { plumbing: { hourly_rate: -1 } },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })
})

describe('UpdateSchema — combined payloads', () => {
  it('accepts the full dashboard PATCH shape (tenant + pricing + licences + services)', () => {
    const payload = {
      tenant: {
        business_name: 'Peppers Plumbing',
        owner_first_name: 'Jeph',
        state: 'QLD',
      },
      pricing_by_trade: {
        plumbing: { hourly_rate: 120, call_out_minimum: 110, default_markup_pct: 20 },
      },
      licences_by_trade: {
        plumbing: {
          licence_type: 'QBCC',
          licence_number: '123456',
          licence_state: 'QLD',
          licence_expiry: '2029-05-13',
        },
      },
      // Valid UUIDv4 fixtures — Zod 4's z.string().uuid() enforces the
      // RFC 4122 variant bits, so we can't use 1111…1111.
      services: {
        'a1b2c3d4-e5f6-4789-8abc-def012345678': true,
        'b2c3d4e5-f6a7-4890-9bcd-ef0123456789': false,
      },
    }
    const result = UpdateSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('accepts an empty payload (no-op PATCH)', () => {
    const result = UpdateSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})
