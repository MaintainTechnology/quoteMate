// Zod schemas for the /api/tenant/me PATCH payload — extracted so we
// can unit-test the parsing rules without spinning up the route handler.
//
// Why this lives outside route.ts:
//   • route.ts has top-level Supabase side-effects (createClient) that
//     blow up in a unit-test env without a service key.
//   • The schema itself is pure — easy to import + assert against.

import { z } from 'zod'

export const TRADE_ENUM = z.enum(['electrical', 'plumbing'])
export const STATE_ENUM = z.enum(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'])

export const PricingFields = z.object({
  hourly_rate: z.coerce.number().positive().optional(),
  call_out_minimum: z.coerce.number().nonnegative().optional(),
  default_markup_pct: z.coerce.number().min(0).max(100).optional(),
  apprentice_rate: z.coerce.number().nonnegative().optional(),
  senior_rate: z.coerce.number().nonnegative().optional(),
  after_hours_multiplier: z.coerce.number().min(1).max(3).optional(),
  min_labour_hours: z.coerce.number().min(0).max(8).optional(),
  risk_buffer_pct: z.coerce.number().min(0).max(100).optional(),
  gst_registered: z.boolean().optional(),
})

export const LicenceFields = z.object({
  licence_type: z.string().trim().max(40).optional().or(z.literal('')),
  licence_number: z.string().trim().max(60).optional().or(z.literal('')),
  licence_state: STATE_ENUM.optional().or(z.literal('')),
  licence_expiry: z.string().trim().optional().or(z.literal('')),
})

// IMPORTANT: in Zod 4, `z.record(z.enum([...]), schema)` requires
// EVERY enum value to be present as a key — i.e. it is exhaustive.
// That's wrong for our use case: a plumbing-only tenant must be able to
// PATCH `{plumbing: {...}}` without also supplying `{electrical: {...}}`.
// `z.partialRecord(...)` keeps the key-set constrained to valid trades
// but makes each individual key optional, which is what we want.
const PartialTradeRecord = <T extends z.ZodTypeAny>(value: T) =>
  z.partialRecord(TRADE_ENUM, value)

export const UpdateSchema = z.object({
  tenant: z
    .object({
      business_name: z.string().trim().min(2).max(80).optional(),
      owner_first_name: z.string().trim().min(1).max(40).optional(),
      owner_email: z.string().trim().email().max(120).optional(),
      owner_mobile: z.string().trim().min(8).max(20).optional(),
      trade: TRADE_ENUM.optional(),
      state: STATE_ENUM.optional(),
      abn: z.string().trim().max(20).optional().or(z.literal('')),
      // Legacy single-licence triple — still written to tenants.licence_*
      // for back-compat with code paths that read the scalar columns.
      licence_type: z.string().trim().max(40).optional().or(z.literal('')),
      licence_number: z.string().trim().max(60).optional().or(z.literal('')),
      licence_expiry: z.string().trim().optional().or(z.literal('')),
    })
    .optional(),
  // Legacy single-pricing payload: applies the same fields to EVERY
  // pricing_book row this tenant owns.
  pricing: PricingFields.optional(),
  // Per-trade pricing — keys are trade names. Allow partial (only the
  // trades the tradie actually has) — see the partialRecord note above.
  pricing_by_trade: PartialTradeRecord(PricingFields).optional(),
  // Per-trade licence storage (migration 018). Same constraint as
  // pricing_by_trade — only present trades come through.
  licences_by_trade: PartialTradeRecord(LicenceFields).optional(),
  // Map of assembly_id → enabled flag. Service offerings toggles.
  services: z.record(z.string().uuid(), z.boolean()).optional(),
  // Map of material category (e.g. "downlight", "hws_gas", "toilet")
  // → preferred brand. Null/empty string clears the preference. The
  // route deletes existing rows when the value is null and upserts
  // otherwise. Categories are validated lazily at runtime against
  // shared_materials.category to avoid coupling this schema to the
  // catalogue's evolving category list.
  material_preferences: z
    .record(
      z.string().min(1).max(40),
      z.union([z.string().trim().min(1).max(80), z.null(), z.literal('')]),
    )
    .optional(),
})

export type UpdateSchemaInput = z.input<typeof UpdateSchema>
export type UpdateSchemaOutput = z.output<typeof UpdateSchema>
