// Zod schemas for the /api/tenant/me PATCH payload — extracted so we
// can unit-test the parsing rules without spinning up the route handler.
//
// Why this lives outside route.ts:
//   • route.ts has top-level Supabase side-effects (createClient) that
//     blow up in a unit-test env without a service key.
//   • The schema itself is pure — easy to import + assert against.

import { z } from 'zod'
import { CATEGORY_ENUM_TUPLE } from '@/lib/estimate/categories'

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
  // Toggle enabled/disabled for a tenant's custom assembly (migration
  // 023). Keys are tenant_custom_assemblies.id values. Lets the same
  // PATCH that flips shared-service toggles also flip custom-service
  // toggles in one round-trip.
  custom_services: z.record(z.string().uuid(), z.boolean()).optional(),
  // v8 Phase A — early-booking discount config. Stored in
  // pricing_book.overlays.early_bird jsonb (no schema migration for
  // config). `discount_pct` is capped at 15% — the same MARGIN GUARD
  // enforced in lib/quote/early-bird.ts (MAX_EARLY_BIRD_DISCOUNT_PCT);
  // the schema rejects anything higher rather than silently clamping so
  // the tradie sees the error. `window_hours` is the offer lifetime —
  // 1h to 14 days.
  early_bird: z
    .object({
      enabled: z.boolean(),
      discount_pct: z.coerce.number().min(0).max(15),
      window_hours: z.coerce.number().min(1).max(336),
    })
    .optional(),
})

// Create/update payload for a single tenant_custom_assemblies row.
// Used by POST /api/tenant/services and PATCH /api/tenant/services/[id].
// Mirrors the shared_assemblies shape that real-world tradies expect
// to fill in plus the two custom-only fields (always_inspection,
// inspection_triggers — Pass 2 surface).
export const CustomServiceSchema = z.object({
  trade: TRADE_ENUM,
  // Optional explicit grounding category (migration 029). Validated
  // against the single source of truth in @/lib/estimate/categories so
  // this list can never drift from the validator's. Empty / omitted →
  // the row falls back to name-regex categorisation (the safe default —
  // a tradie who doesn't know categories is never forced to pick one).
  category: z.enum(CATEGORY_ENUM_TUPLE).optional().or(z.literal('')),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  default_unit: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .optional()
    .or(z.literal('')),
  default_unit_price_ex_gst: z.coerce.number().min(0).max(100_000),
  default_labour_hours: z.coerce.number().min(0).max(80).optional(),
  default_exclusions: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal('')),
  always_inspection: z.boolean().optional(),
  // Pass 2 surface. Empty array is the v1 default. Each entry is a
  // substring/phrase the SMS dispatcher will eventually scan for in
  // customer messages.
  inspection_triggers: z
    .array(z.string().trim().min(1).max(80))
    .max(10)
    .optional(),
  enabled: z.boolean().optional(),
})

export type CustomServiceInput = z.input<typeof CustomServiceSchema>
export type CustomServiceOutput = z.output<typeof CustomServiceSchema>

// PATCH version — every field optional so partial edits work
// (e.g. just toggling `always_inspection` without resubmitting the
// whole row).
export const CustomServicePatchSchema = CustomServiceSchema.partial()
export type CustomServicePatchInput = z.input<typeof CustomServicePatchSchema>
export type CustomServicePatchOutput = z.output<typeof CustomServicePatchSchema>

// WP2 — create/update payload for a single tenant_material_catalogue row
// (migration 028). Used by POST /api/tenant/catalogue and
// PATCH /api/tenant/catalogue/[id]. `category` aligns with the grounding
// validator's tags so a tenant catalogue row grounds exactly like a
// shared one. Empty strings on optional text fields are normalised to
// null by the route (mirrors the services route's emptyToNull).
export const TIER_ENUM = z.enum(['good', 'better', 'best'])
export const MaterialCatalogueSchema = z.object({
  trade: TRADE_ENUM,
  category: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(120),
  brand: z.string().trim().max(60).optional().or(z.literal('')),
  range_series: z.string().trim().max(60).optional().or(z.literal('')),
  supplier: z.string().trim().max(60).optional().or(z.literal('')),
  unit: z.string().trim().min(1).max(30).optional().or(z.literal('')),
  unit_price_ex_gst: z.coerce.number().min(0).max(100_000),
  customer_supply_price_ex_gst: z.coerce
    .number()
    .min(0)
    .max(100_000)
    .optional()
    .or(z.null()),
  tier_hint: TIER_ENUM.optional().or(z.literal('')),
  image_path: z.string().trim().max(300).optional().or(z.literal('')),
  // WP2 completion (migration 034). cost_price = what the tradie PAYS
  // (margin insight; never a sell price — estimator/validator ignore
  // it). description = operator's own product blurb. is_preferred =
  // their go-to product for the category (soft chooseMaterial
  // tiebreaker only).
  cost_price_ex_gst: z.coerce.number().min(0).max(100_000).optional().or(z.null()),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  is_preferred: z.boolean().optional(),
  active: z.boolean().optional(),
})
export type MaterialCatalogueInput = z.input<typeof MaterialCatalogueSchema>
export type MaterialCatalogueOutput = z.output<typeof MaterialCatalogueSchema>

export const MaterialCataloguePatchSchema = MaterialCatalogueSchema.partial()
export type MaterialCataloguePatchInput = z.input<typeof MaterialCataloguePatchSchema>
export type MaterialCataloguePatchOutput = z.output<typeof MaterialCataloguePatchSchema>

// Tenant-owned bill-of-materials line (migration 031). One row = "this
// job needs this much of this material category". Used by POST
// /api/tenant/bom and PATCH /api/tenant/bom/[id]. The job is a
// shared_assemblies row; assembly_id is validated at runtime against
// the catalogue (and the tradie's trades) by the route.
export const TenantBomLineSchema = z.object({
  assembly_id: z.string().uuid(),
  trade: TRADE_ENUM,
  material_category: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional().or(z.literal('')),
  quantity: z.coerce.number().positive().max(10_000),
  required: z.boolean().optional(),
  sort: z.coerce.number().int().min(0).max(999).optional(),
})
export type TenantBomLineInput = z.input<typeof TenantBomLineSchema>
export type TenantBomLineOutput = z.output<typeof TenantBomLineSchema>

export const TenantBomLinePatchSchema = TenantBomLineSchema.partial()
export type TenantBomLinePatchInput = z.input<typeof TenantBomLinePatchSchema>
export type TenantBomLinePatchOutput = z.output<typeof TenantBomLinePatchSchema>

export type UpdateSchemaInput = z.input<typeof UpdateSchema>
export type UpdateSchemaOutput = z.output<typeof UpdateSchema>
