// Quote PDF service (migration 105) — generate, store and link the
// Gotenberg-rendered customer quote PDFs for all three SMS quote flows:
//
//   electrical + plumbing  → quotes row (G/B/B jsonb) → quotes.pdf_path
//   roofing                → roofing_measurements row → .pdf_path
//
// Storage: private `quote-pdfs` bucket
//   quotes/<quoteId>/<content SHA-256>.pdf
//   roofs|solar|paint/<token><revision>/<content SHA-256>.pdf
//
// Customers download via the stable token routes (/api/q/[token]/pdf,
// /api/q/roof/[token]/pdf — lazy-generate on first hit); the MMS attach
// uses a short-lived signed URL. Everything here is best-effort from the
// callers' perspective: a PDF failure must never block the quote SMS.

import { createHash } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { renderPdfFromHtml, gotenbergConfigured } from '@/lib/pdf/gotenberg'
import {
  buildQuoteReportHtml,
  buildQuoteReportHtmlFromBody,
  REPORT_TEMPLATE_VERSION,
  type QuoteReportTier,
  type QuoteReportInput,
} from './report-html'
import {
  buildEvChargerEstimateHtml,
  deriveEvDescriptionOfWorks,
  formatEstimateNumber,
  isEvChargerJob,
  EV_ESTIMATE_TEMPLATE_KEY,
  type EvChargerEstimateInput,
  type EvEstimateImage,
} from './report-html-ev-charger'
import { jobMethod } from './job-method'
import { asQuoteTierMode, resolveVisibleTiers, type QuoteTierMode } from './tier-visibility'
import { quotePropertyVisuals } from './property-visuals'
import { tradieProfile } from './tradie-profile'
import { jobDetailsSentence } from './scope-short'
import { INSPECTION_FEE_AUD } from './money'
import { hasPropertyVisuals, propertyVisualsImagePath } from './visuals-image-path'
import {
  quotePdfIsStale,
  quotePdfSignature,
  hashReportContent,
  embeddedImageMissing,
} from './pdf-signature'
import { solarPdfRev } from './pdf-rev'
import { tradeRendersOwnQuotePdf } from './report-adapters/registry'
import { exceedsMmsMediaCap, MMS_MEDIA_CAP_BYTES } from '@/lib/sms/send-quote-pdf'
import { serializeReportDoc } from './report-doc/serialize'
import type { ReportDoc } from './report-doc/types'
import { validateReportStyle } from './report-doc/style'
import { buildRoofCustomerReportHtml, type RoofLayoutOverlay } from '@/lib/roofing/report-html'
import { structureImageRefs, structureStaticMapPath } from '@/lib/roofing/structure-images'
import {
  combinedLayoutMetrics,
  layoutMaterials,
  type LayoutPlan,
} from '@/lib/roofing/layout-plan'
import {
  layoutMapView,
  layoutOverlayImageSrc,
  type LayoutOverlayStructure,
} from '@/lib/roofing/layout-overlay-svg'
import type { MultiRoofQuote } from '@/lib/roofing/types'
import {
  resolveEffectiveIndices,
  resolveRoofRenderSelection,
  type RoofDisplayRow,
} from '@/lib/roofing/selection'
import { buildSolarQuoteReportHtml } from '@/lib/solar/report-html'
import {
  buildSolarPremiumQuote,
  solarPremiumQuoteEnabled,
  type SolarPremiumQuote,
} from '@/lib/solar/premium-quote'
import { loadSolarConfig } from '@/lib/solar/config'
import type { SolarEstimate } from '@/lib/solar/types'
import { buildPaintingQuoteReportHtml } from '@/lib/painting/report-html'
import type { PaintingEstimate } from '@/lib/painting/types'
import { loadTenantBranding } from '@/lib/pdf/branding'
import { prepareImage } from '@/lib/pdf/image'
import { refreshSignedUrl } from '@/lib/storage/upload'
import { publicWebOrigin, publicWebUrl } from '@/lib/sms/public-origin'
import { loadQuoteReportPricing } from './report-pricing'
import { QuotePricingVersionError } from './pricing-version'
import { quoteEditRevision } from './edit-authority'
import { quoteCustomerReleaseRevision } from './customer-release'

const BUCKET = 'quote-pdfs'

// Storage-path revision markers (spec quote-visual-parity): painting/solar/
// roofing rows have no pdf_signature column, so the path itself marks which
// template era a cached PDF came from — pre-marker paths regenerate once.
// Bumped 2026-07-10 (roofing introduced at -v2): PDFs now render as ONE
// continuous page rather than A4 page-by-page, so every cached paginated PDF
// regenerates exactly once on its next download.
// -v4 (2026-07-11): + aerial figure and the customer Materials & time table.
// -v5 (2026-07-11): imagery reorganised — photos row + before/after repaint
// pair; the cached AI render's timestamp joins the path marker so a
// customer recolour regenerates the PDF (see ensurePaintingPdf).
// -v6 (2026-07-11): + price-build derivation tail and "How we measured"
// notes (customer-safe detail parity with /q/paint).
// -v7 (2026-07-11): price-build shows per-surface COST (no false rate
// equation / double-counted multiplier rows); PDF honours the tenant's
// quote_tier_mode so a single-price tenant no longer reveals hidden tiers.
const PAINT_PDF_REV = '-v7'
// SOLAR_PDF_REV + the content-aware solarPdfRev now live in ./pdf-rev (RC-5).
// Bump WHENEVER the layout figure's view/compositing maths change, or cached
// PDFs keep serving a figure whose aerial and zone overlay were projected by
// different code (the misaligned-borders report).
//   -v3 (2026-07-11): selection-aware layout-map framing.
//   -v4 (2026-07-11): fixed-metre ring offsets (fractional scaling pushed the
//   far wings of large L-shaped roofs metres off the roofline).
//   -v5 (2026-07-17): solar detach & reinstate applied to replacement-tier
//   prices (applySolarToTiers) — regenerate every cached PDF so the printed
//   dollars match the customer quote page.
//   -v6 (2026-07-21): the roofing PDF is now the CUSTOMER view — the same five
//   numbered sections /q/roof/[token] renders (buildRoofCustomerReportHtml) —
//   not the tradie's detailed measurement report. Every cached -v5 PDF (the one
//   already sent as MMS media / linked from the quote SMS) regenerates once on
//   its next download.
const ROOF_PDF_REV = '-v7'

/** Legacy PDFs may embed an API origin. A website change rebuilds each cached
 * trade document once at a new storage path, preserving the previous asset.
 */
function pdfWebsiteRevision(): string {
  return `-web-${createHash('sha256').update(publicWebOrigin()).digest('hex').slice(0, 16)}`
}

let _client: SupabaseClient | null = null
function supabase(): SupabaseClient {
  if (_client) return _client
  _client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  return _client
}

/** Stable customer download URL for a trade (G/B/B) quote PDF. */
export function quotePdfUrl(shareToken: string): string {
  return publicWebUrl(`/api/q/${shareToken}/pdf`)
}

/** Stable customer download URL for a roofing quote PDF. */
export function roofQuotePdfUrl(publicToken: string): string {
  return publicWebUrl(`/api/q/roof/${publicToken}/pdf`)
}

/** Stable customer download URL for a solar quote PDF. */
export function solarQuotePdfUrl(publicToken: string): string {
  return publicWebUrl(`/api/q/solar/${publicToken}/pdf`)
}

/** Stable customer download URL for a residential painting quote PDF. */
export function paintQuotePdfUrl(publicToken: string): string {
  return publicWebUrl(`/api/q/paint/${publicToken}/pdf`)
}


function immutableQuotePdfPath(quoteId: string, data: Buffer): string {
  return `quotes/${quoteId}/${createHash('sha256').update(data).digest('hex')}.pdf`
}

function isImmutableQuotePdfPath(quoteId: string, path: string | null): boolean {
  const prefix = `quotes/${quoteId}/`
  return !!path?.startsWith(prefix) && /^[a-f0-9]{64}\.pdf$/.test(path.slice(prefix.length))
}

/** An outbox media key must keep its prepared bytes after later quote edits.
 * A lost upload acknowledgement or simultaneous identical render is reusable
 * only after reading back the exact bytes. Never overwrite an existing object.
 */
async function storeImmutableQuotePdf(quoteId: string, data: Buffer): Promise<string> {
  const path = immutableQuotePdfPath(quoteId, data)
  return storeImmutablePdf(path, data)
}

async function storeImmutablePdf(path: string, data: Buffer): Promise<string> {
  const bucket = supabase().storage.from(BUCKET)
  const { error } = await bucket.upload(path, data, { contentType: 'application/pdf', upsert: false })
  if (!error) return path
  const existing = await bucket.download(path)
  if (!existing.error && existing.data) {
    const bytes = Buffer.from(await existing.data.arrayBuffer())
    if (bytes.equals(data)) return path
  }
  throw new Error('quote-pdf immutable upload could not be confirmed')
}

function immutableTradePdfPath(prefix: string, data: Buffer): string {
  return `${prefix}${createHash('sha256').update(data).digest('hex')}.pdf`
}

function isImmutableTradePdfPath(prefix: string, path: string | null): boolean {
  return !!path?.startsWith(prefix) && /^[a-f0-9]{64}\.pdf$/.test(path.slice(prefix.length))
}

/**
 * Store an arbitrary asset (e.g. a raw uploaded invoice image) in the same
 * private `quote-pdfs` bucket. Used by the per-tenant file-store archive
 * (spec 2026-06-19, R10) so the FULL invoice document lives in access-controlled
 * Supabase Storage — the KB only ever receives the PII-minimized text.
 */
export async function storeQuoteAsset(
  path: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  const { error } = await supabase()
    .storage.from(BUCKET)
    .upload(path, data, { contentType, upsert: true })
  if (error) throw new Error(`quote-asset upload failed: ${error.message}`)
  return path
}

export async function downloadQuotePdf(path: string): Promise<Buffer> {
  const { data, error } = await supabase().storage.from(BUCKET).download(path)
  if (error || !data) throw new Error(`quote-pdf download failed: ${error?.message ?? 'no data'}`)
  return Buffer.from(await data.arrayBuffer())
}

/** Stored size (bytes) of an object in the quote-pdfs bucket, or null if the
 *  lookup fails. Metadata-only (list), never downloads the PDF. */
async function quotePdfSize(path: string): Promise<number | null> {
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash) : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path
  try {
    const { data } = await supabase().storage.from(BUCKET).list(dir, { search: name, limit: 100 })
    const obj = data?.find((o) => o.name === name)
    const size = (obj?.metadata as { size?: number } | undefined)?.size
    return typeof size === 'number' ? size : null
  } catch {
    return null
  }
}

/** Short-lived public URL (for the Twilio MMS media fetch). RC-7 — refuses an
 *  over-cap PDF: Twilio accepts an oversized media send then fails delivery
 *  asynchronously, so dispatch's synchronous MMS→SMS fallback never fires and
 *  the customer gets a broken MMS. Throwing here degrades dispatchQuoteWithPdf
 *  to a plain SMS whose durable body link still serves the SAME full PDF. */
export async function signQuotePdfUrl(path: string, ttlSeconds = 60 * 60): Promise<string> {
  const size = await quotePdfSize(path)
  if (exceedsMmsMediaCap(size)) {
    throw new Error(
      `quote-pdf ${path} is ${size}B — over the ${MMS_MEDIA_CAP_BYTES}B MMS cap; sending link-only`,
    )
  }
  const { data, error } = await supabase().storage.from(BUCKET).createSignedUrl(path, ttlSeconds)
  if (error || !data?.signedUrl) throw new Error(`quote-pdf sign failed: ${error?.message ?? 'no url'}`)
  return data.signedUrl
}

type QuotePdfRow = {
  id: string
  tenant_id: string | null
  intake_id: string | null
  share_token: string
  good: QuoteReportTier
  better: QuoteReportTier
  best: QuoteReportTier
  selected_tier: 'good' | 'better' | 'best' | null
  total_inc_gst: number | null
  pricing_book_version_id: string | null
  scope_of_works: string | null
  /** Mig 175 — the one-line job summary the customer page prints as section 02
   *  "Job details". The PDF now prints it too (report template v8). */
  scope_short: string | null
  assumptions: string[] | null
  estimated_timeframe: string | null
  needs_inspection: boolean | null
  inspection_reason: string | null
  display_mode: string | null
  parent_quote_id: string | null
  pdf_path: string | null
  pdf_signature: string | null
  report_doc: unknown | null
  report_style: unknown | null
  /** v8 realised early-booking discount (mig 044) — P7: the PDF must show
   *  the same discounted price the page shows and Stripe charges. */
  applied_discount_pct: number | null
  /** Mig 194 — the post-site-visit chain. A 'final' row prints as "FINAL
   *  QUOTE" with the deposit disclaimer instead of "confirmed on site"
   *  (report template v9, spec post-visit-money-sequence R5). */
  quote_kind: string | null
  deposit_pct: number | null
  /** RC-9 — the quote's creation timestamp, rendered as the document date so
   *  the live HTML preview and the cached PDF never disagree (a `new Date()`
   *  fallback drifts by a day whenever they render on opposite sides of midnight). */
  created_at: string | null
  /** Stored by the draft route, rendered on NO surface until the EV charger
   *  estimate's "Optional Upgrades & Recommendations" section (spec R10). */
  optional_upsells: Array<{ name?: string | null; price_ex_gst?: number | null }> | null
  /** The Gemini render of the job in the customer's own photo, produced by
   *  lib/ig-engine/generate.ts at draft/upload time. Read only here — a
   *  document render must never make a billable AI call (spec
   *  ev-charger-location-photo R12/R13). */
  preview_status: string | null
  preview_image_paths: string[] | null
}

type RoofPdfRow = {
  public_token: string
  tenant_id: string | null
  address: string | null
  quote: MultiRoofQuote | null
  routing: string | null
  pdf_path: string | null
  /** AI layout plan cache (migration 170) — embed ONLY when 'ready'. */
  layout_status: string | null
  layout_plan: LayoutPlan | null
  /** Tradie selection — the layout map frames ONLY these structures. */
  included_indices: number[] | null
  confirmed_structure: number | null
}

type SolarPdfRow = {
  public_token: string
  tenant_id: string | null
  address: string | null
  estimate: SolarEstimate | null
  routing: string | null
  pdf_path: string | null
  /** Felt tab (spec 2026-06-13): variant + map record + grounded brief. */
  quote_variant?: string | null
  felt?: { thumbnail_url?: string | null; map_url?: string | null; status?: string | null } | null
  ai_brief?: import('@/lib/solar/ai-brief').SolarAiBriefRecord | null
  /** Cached "roof with panels" AI render — embed ONLY when status is 'ready'. */
  panels_image_status?: string | null
  panels_image_path?: string | null
}

type PaintingPdfRow = {
  public_token: string
  tenant_id: string | null
  address: string | null
  estimate: PaintingEstimate | null
  routing: string | null
  pdf_path: string | null
  /** Cached AI repaint (migration 169) — embed ONLY when status is 'ready'. */
  preview_status: string | null
  preview_image_path: string | null
}

type IntakePdfRow = {
  id: string
  tenant_id: string | null
  job_type: string | null
  caller: { name?: string; email?: string | null; phone?: string | null } | null
  trade: string | null
  address: string | null
  /** Spec R7 — the EV estimate prints the suburb when no street address was
   *  captured for this job, rather than nothing (or a remembered address). */
  suburb: string | null
  scope: unknown
}

// RC-7 — the canonical stored PDF is the FULL-image document, so the dashboard
// download, the /api/q/[token]/pdf link and the live HTML preview all show the
// same complete quote (previously an image-heavy quote over 5 MB was stored
// image-STRIPPED to fit MMS, so the download lost its logo + aerials). The MMS
// media size limit is now enforced only at attach time by signQuotePdfUrl —
// an over-cap PDF degrades to a link-only SMS whose link serves this same PDF.

/** Resolved basis for a quote's report — the quotes row, its intake, and which
 *  tier(s) the tenant's mode surfaces. Shared by the PDF (ensureQuotePdf) and
 *  the inline HTML report (renderQuoteReportHtml) so the two can never drift. */
type QuoteReportContext = {
  quote: QuotePdfRow
  intake: IntakePdfRow | null
  intakeTrade: string
  tierMode: QuoteTierMode
  visibleTierKeys: Array<'good' | 'better' | 'best'>
  visibleTierSet: Set<'good' | 'better' | 'best'>
  recommendedTier: 'good' | 'better' | 'best' | null
  /** Verified saved pricing version, or unambiguous persisted legacy totals. */
  gstRegistered: boolean
  /** tenants.photo_url (mig 180) — the "Your tradie" photo. Null ⇒ the report
   *  renders the placeholder avatar. Also folded into the PDF cache signature
   *  so uploading a photo regenerates already-cached PDFs. */
  tradiePhotoUrl: string | null
}

/**
 * Load a quotes row + its intake and resolve the tenant's visible tiers.
 * Returns null when the quote is missing OR inspection-routed (an inspection
 * quote carries no committable prices — the same guard ensureQuotePdf has always
 * applied). Unverifiable pricing raises a typed review/dependency error.
 */
async function loadQuoteReportContext(quoteId: string): Promise<QuoteReportContext | null> {
  const { data: quote, error: quoteError } = await supabase()
    .from('quotes')
    .select(
      // estimate_number is deliberately NOT here: it arrives with migration 194,
      // and a column missing from this select fails the whole read — which would
      // cost every electrical/plumbing quote its PDF on a pre-194 deploy. The EV
      // path reads it in its own best-effort select instead (spec R5/R6).
      'id, tenant_id, intake_id, share_token, good, better, best, selected_tier, total_inc_gst, pricing_book_version_id, scope_of_works, scope_short, assumptions, estimated_timeframe, needs_inspection, inspection_reason, display_mode, parent_quote_id, pdf_path, pdf_signature, report_doc, report_style, applied_discount_pct, created_at, optional_upsells, quote_kind, deposit_pct, preview_status, preview_image_paths',
    )
    .eq('id', quoteId)
    .maybeSingle<QuotePdfRow>()
  if (quoteError) throw new QuotePricingVersionError('pricing_unavailable', 503)
  if (!quote) return null
  if (quote.needs_inspection) return null
  if (!quote.tenant_id || !quote.intake_id) throw new QuotePricingVersionError('quote_pricing_review_required')

  const intakeRes = quote.intake_id
    ? await supabase()
        .from('intakes')
        .select('id, tenant_id, job_type, caller, trade, address, suburb, scope')
        .eq('id', quote.intake_id)
        .eq('tenant_id', quote.tenant_id)
        .maybeSingle<IntakePdfRow>()
    : { data: null as IntakePdfRow | null, error: null }
  if (intakeRes.error) throw new QuotePricingVersionError('pricing_unavailable', 503)
  const intake = intakeRes.data
  const pricing = await loadQuoteReportPricing(supabase(), quote, intake)

  // Mig 142 — render only the tier(s) this feature's mode surfaces. The full
  // good/better/best stays persisted; the report mirrors the customer page.
  const intakeTrade = pricing.trade
  let tierMode: QuoteTierMode = asQuoteTierMode(pricing.pricingVersion?.snapshot.quote_tier_mode as string | null)
  const gstRegistered = pricing.gstRegistered
  let tradiePhotoUrl: string | null = null
  if (quote.tenant_id) {
    const { data: pb } = await supabase()
      .from('pricing_book')
      .select('quote_tier_mode')
      .eq('tenant_id', quote.tenant_id)
      .eq('trade', intakeTrade)
      .maybeSingle<{ quote_tier_mode: string | null }>()
    if (!pricing.pricingVersion) tierMode = asQuoteTierMode(pb?.quote_tier_mode ?? null)
    // Own best-effort select (the tenant-identity convention): a pre-mig-180
    // deploy errors here and loses only the photo — never the branding/logo.
    const { data: ph } = await supabase()
      .from('tenants')
      .select('photo_url')
      .eq('id', quote.tenant_id)
      .maybeSingle<{ photo_url: string | null }>()
    tradiePhotoUrl = ph?.photo_url ?? null
  }
  const visibleTierKeys = resolveVisibleTiers({
    mode: tierMode,
    present: { good: !!quote.good, better: !!quote.better, best: !!quote.best },
    selectedTier: quote.selected_tier,
  })
  const visibleTierSet = new Set(visibleTierKeys)
  const recommendedTier = visibleTierKeys.length > 1 ? quote.selected_tier : null

  return {
    quote,
    intake,
    intakeTrade,
    tierMode,
    visibleTierKeys,
    visibleTierSet,
    recommendedTier,
    gstRegistered,
    tradiePhotoUrl,
  }
}

/**
 * Resolve the root-relative property-visuals image path for a quote. Roofing
 * quotes linked to a saved measurement centre on the MEASURED building polygon
 * (matching the customer page's RoofHeroStrip) — geocoding the street-only
 * intake address lands on the wrong building on large/rural parcels. Non-roofing
 * trades skip the DB read. Null when the trade has no property visuals.
 */
async function resolveVisualsImagePath(
  trade: string,
  shareToken: string,
  address: string | null,
): Promise<string | null> {
  if (!hasPropertyVisuals(trade)) return null
  let linkedRoofPublicToken: string | null = null
  if (trade === 'roofing') {
    const { data } = await supabase()
      .from('roofing_measurements')
      .select('public_token')
      .eq('quote_share_token', shareToken)
      .maybeSingle<{ public_token: string | null }>()
    linkedRoofPublicToken = data?.public_token ?? null
  }
  return propertyVisualsImagePath({ trade, shareToken, address, linkedRoofPublicToken })
}

/** Build the roof layout-map + estimated-materials overlay from a
 *  roofing_measurements row — CACHED plan only (never generates). Shared by the
 *  roofing-native PDF and the generic quotes-row PDF/HTML so a roofing quote
 *  carries the layout map + BOM whichever report renders it. */
async function buildRoofLayoutOverlay(row: {
  layout_status: string | null
  layout_plan: LayoutPlan | null
  quote: MultiRoofQuote | null
  included_indices: number[] | null
  confirmed_structure: number | null
  public_token: string
}): Promise<RoofLayoutOverlay | null> {
  if (!(row.layout_status === 'ready' && row.layout_plan && row.quote?.structures?.length)) return null
  const overlayStructures: LayoutOverlayStructure[] = row.quote.structures.map((s) => ({
    polygon: s.metrics?.polygon_geojson ?? null,
    form: s.metrics?.form ?? 'unknown',
  }))
  const effective = resolveEffectiveIndices(
    { included: row.included_indices, confirmedStructure: row.confirmed_structure, paramIndices: null },
    row.quote,
  )
  const includedSet = new Set(effective)
  const visibleZones =
    includedSet.size > 0
      ? row.layout_plan.zones.filter((z) => includedSet.has(z.structureIndex))
      : row.layout_plan.zones
  const includedOverlayStructures =
    effective.length > 0
      ? effective.map((i) => overlayStructures[i - 1]).filter(Boolean)
      : overlayStructures
  const includedStructures =
    effective.length > 0
      ? effective.map((i) => row.quote!.structures[i - 1]).filter(Boolean)
      : row.quote.structures
  const view = layoutMapView(includedOverlayStructures, { width: 640, height: 480 })
  const overlaySrc =
    view && visibleZones.length > 0
      ? layoutOverlayImageSrc({
          zones: visibleZones,
          structures: overlayStructures,
          center: view.center,
          zoom: view.zoom,
          width: 640,
          height: 480,
        })
      : null
  if (!overlaySrc) return null
  const sel = effective.length > 0 ? `&sel=${effective.join(',')}` : ''
  const aerialSrc = await prepareImage(publicWebUrl(`/api/roofing/q/${row.public_token}/static-map?fit=1${sel}`))
  if (!aerialSrc) return null
  return {
    header: row.layout_plan.header,
    aerialSrc,
    overlaySrc,
    legend: visibleZones.map((z) => ({ color: z.color, label: z.label })),
    materials: layoutMaterials(combinedLayoutMetrics(includedStructures), row.layout_plan.mode),
  }
}

/** Resolve the roof layout overlay for a GENERIC quotes-row roofing quote by
 *  looking up the linked roofing_measurements (quote_share_token == share_token,
 *  the same link the customer page + aerial use). Null for non-roofing / unlinked
 *  quotes or when the tradie hasn't generated a plan. */
async function resolveRoofLayoutForQuote(shareToken: string): Promise<RoofLayoutOverlay | null> {
  const { data: row } = await supabase()
    .from('roofing_measurements')
    .select('layout_status, layout_plan, quote, included_indices, confirmed_structure, public_token')
    .eq('quote_share_token', shareToken)
    .maybeSingle()
  if (!row) return null
  return buildRoofLayoutOverlay(row as Parameters<typeof buildRoofLayoutOverlay>[0])
}

/** Shape the QuoteReportInput both the PDF and the inline HTML render from —
 *  identical output guarantees the on-screen HTML matches the downloaded PDF.
 *  `visualsImageSrc` is the pre-resolved property image (data URI for the PDF,
 *  token-gated proxy URL for the live preview, null when unavailable). */
function buildQuoteReportInput(
  ctx: QuoteReportContext,
  branding: Awaited<ReturnType<typeof loadTenantBranding>>,
  visualsImageSrc: string | null = null,
  layoutOverlay: RoofLayoutOverlay | null = null,
  /** Resolved "Your tradie" photo: a data: URI for the PDF, the raw public URL
   *  for the live HTML preview. Null ⇒ the placeholder avatar. */
  tradiePhotoSrc: string | null = null,
): QuoteReportInput {
  const { quote, intake, intakeTrade, visibleTierSet, recommendedTier } = ctx
  return {
    reportStyle: validateReportStyle(quote.report_style),
    businessName: branding.businessName,
    branding,
    customerName: intake?.caller?.name ?? null,
    jobType: intake?.job_type ?? 'job',
    scopeOfWorks: quote.scope_of_works,
    // Customer-view parity (report template v8): the page's section 02 sentence
    // and section 03 tradie block now print in the PDF too. Resolved through the
    // SHARED helper — every live quote predates scope_short, so reading that
    // column alone would print job details on the page and nothing here.
    jobDetails: jobDetailsSentence(quote.scope_short, quote.scope_of_works),
    tradie: tradieProfile({
      businessName: branding.businessName,
      photoUrl: tradiePhotoSrc,
      trade: intakeTrade,
    }),
    assumptions: quote.assumptions,
    estimatedTimeframe: quote.estimated_timeframe,
    propertyVisuals: quotePropertyVisuals(intakeTrade, intake?.scope ?? null, visualsImageSrc),
    layoutOverlay,
    good: visibleTierSet.has('good') ? quote.good : null,
    better: visibleTierSet.has('better') ? quote.better : null,
    best: visibleTierSet.has('best') ? quote.best : null,
    selectedTier: recommendedTier,
    // v9 — a post-site-visit final quote prints as one confirmed price, not a
    // "GOOD" option, and drops the "confirmed on site" disclaimer.
    quoteKind: quote.quote_kind ?? null,
    depositPct: quote.deposit_pct ?? null,
    // v7 — the PDF prices what the page shows and Stripe charges (P7/P1).
    appliedDiscountPct: quote.applied_discount_pct ?? null,
    gstRegistered: ctx.gstRegistered,
    quoteViewUrl: publicWebUrl(`/q/${quote.share_token}`),
    // RC-9 — stable document date from the persisted created_at, shared by the
    // live preview and the cached PDF so they never print different days.
    generatedAt: quote.created_at ? new Date(quote.created_at) : undefined,
  }
}

/**
 * Flag-gated (FULL_QUOTE_DOC): render the customer document body from report_doc
 * (via the deterministic serializer) inside the SAME chrome the PDF uses, else
 * today's template. The doc's pricing node renders from the same
 * tier-visibility-filtered good/better/best on `input`, so prices stay grounded,
 * tier-gated, and Stripe-consistent — free text never becomes a price.
 */
/** Exported for the selection test (spec R17): which document a quote renders
 *  is the one behaviour of this module that is pure and worth pinning. */
export function renderQuoteDocumentHtml(
  input: QuoteReportInput,
  reportDoc: unknown | null,
  /** Resolved EV estimate inputs, or null for every other quote (spec R1). */
  ev: EvChargerEstimateInput | null = null,
): string {
  input = { ...input, reportStyle: process.env.FULL_QUOTE_DOC === 'true' ? validateReportStyle(input.reportStyle) : null }
  if (process.env.FULL_QUOTE_DOC === 'true' && reportDoc && typeof reportDoc === 'object') {
    const body = serializeReportDoc(reportDoc as ReportDoc, {
      good: input.good,
      better: input.better,
      best: input.best,
      selectedTier: input.selectedTier,
      gstRegistered: input.gstRegistered,
      appliedDiscountPct: input.appliedDiscountPct,
      quoteKind: input.quoteKind,
    })
    return buildQuoteReportHtmlFromBody(input, body)
  }
  // Spec ev-charger-estimate-template R1 — the EV charger estimate document,
  // for electrical ev_charger quotes only. Deliberately AFTER the report_doc
  // branch: a tradie who authored a document in the editor has overridden the
  // template, and that must keep winning.
  //
  // R16 — a bug in this template degrades to the generic report, never to a
  // failed send. The quote SMS is built and dispatched around this call; a
  // throw here would surface to the draft route's outer catch and replace the
  // customer's quote with the "we hit a snag" fallback.
  if (ev) {
    try {
      return buildEvChargerEstimateHtml({ ...ev, reportStyle: input.reportStyle })
    } catch (e) {
      console.error('[quote-pdf] EV estimate template failed, using generic report', {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return buildQuoteReportHtml(input)
}

/** True when this quote is an electrical EV charger job — the only case the EV
 *  estimate document applies to (spec R1). The predicate itself is pure and
 *  unit-tested in report-html-ev-charger.test.ts. */
function isEvChargerEstimate(ctx: QuoteReportContext): boolean {
  return isEvChargerJob(ctx.intake?.job_type, ctx.intakeTrade)
}

/** Everything the EV estimate needs that the base context does not carry.
 *  Every read is best-effort: a failure degrades one section, never the
 *  document (spec R6/R9/R16). */
type EvEstimateExtras = {
  estimateRef: string
  customerEmail: string | null
  customerPhone: string | null
  siteAddress: string | null
  exclusions: string[]
  chargerUnitIds: string[]
  suppliedBy: 'tradie' | 'customer' | null
  chosenProductImagePath: string | null
  chosenProductName: string | null
}

/** The pre-194 fallback reference — the same 8 characters the customer quote
 *  page has always shown as "Quote ref". */
function fallbackQuoteRef(quoteId: string): string {
  return quoteId.slice(0, 8).toUpperCase()
}

/**
 * Draw this quote's estimate number, assigning one on first use (spec R5).
 *
 * `where … and estimate_number is null` makes it idempotent under concurrency:
 * a second writer matches no row, so the number assigned first stands and is
 * read back below. Entirely best-effort — a missing column (pre-migration-194
 * deploy), a failed write or a race all fall back to the quote reference, and
 * none of them may cost the customer their document.
 */
async function resolveEstimateRef(quoteId: string): Promise<string> {
  try {
    // Migration 194's function does the guarded UPDATE and the read-back in one
    // statement — PostgREST cannot express `set x = nextval(...)`, and doing it
    // as read-then-write from here would race two concurrent renders.
    const { data, error } = await supabase().rpc('next_quote_estimate_number', {
      p_quote_id: quoteId,
    })
    // supabase-js RESOLVES with {data, error} — it does not throw — so the error
    // has to be checked explicitly or a pre-194 deploy silently prints "EST-NaN".
    if (!error) {
      const n = typeof data === 'number' ? data : Number(data)
      if (Number.isFinite(n) && n > 0) return formatEstimateNumber(n)
    } else {
      console.error('[quote-pdf] estimate number RPC failed, using quote ref', {
        quoteId,
        error: error.message,
      })
    }
  } catch (e) {
    console.error('[quote-pdf] estimate number unavailable, using quote ref', {
      quoteId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
  return fallbackQuoteRef(quoteId)
}


/** Narrow the intake's untyped `scope` jsonb to the EV fields this document
 *  reads. Everything is optional — an older intake simply yields nulls. */
function readEvScope(scope: unknown): {
  description: string | null
  suppliedBy: 'tradie' | 'customer' | null
  chosenProductImagePath: string | null
  chosenProductName: string | null
} {
  const s = (scope ?? {}) as {
    description?: unknown
    specs?: { supplied_by?: unknown }
    chosen_product?: { image_path?: unknown; name?: unknown }
  }
  const supplied = s.specs?.supplied_by
  return {
    description: typeof s.description === 'string' ? s.description : null,
    suppliedBy: supplied === 'tradie' || supplied === 'customer' ? supplied : null,
    chosenProductImagePath:
      typeof s.chosen_product?.image_path === 'string' ? s.chosen_product.image_path : null,
    chosenProductName: typeof s.chosen_product?.name === 'string' ? s.chosen_product.name : null,
  }
}

/** The assembly uuids a tier's line items were priced from. */
function assemblyIdsFromTiers(ctx: QuoteReportContext): string[] {
  const ids = new Set<string>()
  for (const key of ctx.visibleTierKeys) {
    for (const li of ctx.quote[key]?.line_items ?? []) {
      const m = /^assembly:(.+)$/i.exec(((li as { source?: string }).source ?? '').trim())
      if (m) ids.add(m[1].trim())
    }
  }
  return [...ids]
}

/** Split an assembly's `default_exclusions` blob into individual bullets. */
function splitExclusions(text: unknown): string[] {
  if (typeof text !== 'string') return []
  return text
    .split(/(?<=[.!?])\s+|\r?\n|;/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Load the EV-only inputs (spec R5/R6/R9). Every read is its own best-effort
 * select: a failure logs and degrades ONE section — the document still renders,
 * and the quote SMS is never delayed or failed by it.
 */
async function loadEvEstimateExtras(ctx: QuoteReportContext): Promise<EvEstimateExtras> {
  const scope = readEvScope(ctx.intake?.scope)
  const extras: EvEstimateExtras = {
    estimateRef: await resolveEstimateRef(ctx.quote.id),
    customerEmail: ctx.intake?.caller?.email ?? null,
    customerPhone: null,
    // R7 — the street address when this job has one, else the suburb alone.
    siteAddress: ctx.intake?.address ?? ctx.intake?.suburb ?? null,
    exclusions: [],
    chargerUnitIds: [],
    suppliedBy: scope.suppliedBy,
    chosenProductImagePath: scope.chosenProductImagePath,
    chosenProductName: scope.chosenProductName,
  }

  // R6 — the customer's OWN number for this thread. intakes.caller.phone is not
  // populated by the SMS path, and a remembered customers row is exactly the
  // wrong source (it is how a stale roofing address reached an EV quote once).
  if (ctx.quote.intake_id) {
    const { data, error } = await supabase()
      .from('sms_conversations')
      .select('from_number')
      .eq('intake_id', ctx.quote.intake_id)
      .maybeSingle<{ from_number: string | null }>()
    if (error) {
      console.error('[quote-pdf] EV estimate: customer number unavailable', {
        quoteId: ctx.quote.id,
        error: error.message,
      })
    } else {
      extras.customerPhone = data?.from_number ?? null
    }
  }

  // R9 — the priced assemblies' own exclusions. A tradie edit that stripped the
  // `source` uuid simply contributes nothing, and the section is omitted when
  // nothing survives.
  const assemblyIds = assemblyIdsFromTiers(ctx)
  if (assemblyIds.length > 0) {
    const [shared, custom] = await Promise.all([
      supabase()
        .from('shared_assemblies')
        .select('default_exclusions')
        .in('id', assemblyIds),
      supabase()
        .from('tenant_custom_assemblies')
        .select('default_exclusions')
        .in('id', assemblyIds),
    ])
    if (shared.error) {
      console.error('[quote-pdf] EV estimate: shared exclusions unavailable', {
        quoteId: ctx.quote.id,
        error: shared.error.message,
      })
    }
    if (custom.error) {
      console.error('[quote-pdf] EV estimate: custom exclusions unavailable', {
        quoteId: ctx.quote.id,
        error: custom.error.message,
      })
    }
    extras.exclusions = [
      ...(shared.data ?? []),
      ...(custom.data ?? []),
    ].flatMap((r) => splitExclusions((r as { default_exclusions?: unknown }).default_exclusions))
  }

  // R4 — which line is the charger UNIT, so it lands in fit-off rather than the
  // rough-in. The tenant's own catalogue is the only authority on that.
  if (ctx.quote.tenant_id) {
    const { data, error } = await supabase()
      .from('tenant_material_catalogue')
      .select('id')
      .eq('tenant_id', ctx.quote.tenant_id)
      .eq('category', 'ev_charger')
    if (error) {
      console.error('[quote-pdf] EV estimate: charger catalogue unavailable', {
        quoteId: ctx.quote.id,
        error: error.message,
      })
    } else {
      extras.chargerUnitIds = (data ?? []).map((r) => String((r as { id: unknown }).id))
    }
  }

  return extras
}

/** At most this many images on the estimate (spec R14). The document is a
 *  single continuous page attached to an MMS with a 5 MB cap; images are the
 *  first thing dropped, never the document. */
const EV_MAX_IMAGES = 3

/**
 * The EV document's cache key: the template version plus the AI render set
 * (spec ev-charger-location-photo R14).
 *
 * The render is generated asynchronously by lib/ig-engine/generate.ts, so it
 * usually arrives AFTER the send-time PDF was cached. Nothing else in
 * quotePdfSignature changes when an image lands, so without the render state in
 * the key the customer would download the image-less document forever. Hashing
 * the paths (rather than listing them) keeps the stored signature short and
 * still changes whenever the set does.
 */
export function evTemplateCacheKey(ctx: {
  quote: { preview_status: string | null; preview_image_paths: string[] | null }
}): string {
  const status = (ctx.quote.preview_status ?? '').trim()
  const paths = Array.isArray(ctx.quote.preview_image_paths)
    ? ctx.quote.preview_image_paths.filter((p) => typeof p === 'string' && p.trim())
    : []
  // Only a set the document would actually RENDER counts — a 'generating' or
  // 'failed' status contributes nothing to the document, so it must not
  // invalidate the cache either.
  if ((status !== 'ready' && status !== 'partial') || paths.length === 0) {
    return EV_ESTIMATE_TEMPLATE_KEY
  }
  return `${EV_ESTIMATE_TEMPLATE_KEY}+img${hashReportContent(paths.join('|'), null)}`
}

/**
 * Images for the estimate (spec R14): the tenant's own charger product shot
 * first, then any photos the customer sent. `embed` produces data URIs for the
 * PDF (Gotenberg must not depend on a network fetch) and is skipped for the
 * live HTML preview, which can reference URLs directly.
 *
 * Best-effort throughout — a failed fetch drops that image and is reported back
 * so ensureQuotePdf can mark the cached PDF stale and retry on the next
 * download rather than caching an image-less document forever.
 */
async function resolveEvImages(
  ctx: QuoteReportContext,
  extras: EvEstimateExtras,
  opts: { embed: boolean },
): Promise<{ images: EvEstimateImage[]; expected: number; missing: boolean }> {
  const candidates: Array<{ src: string; caption: string | null; signed: boolean }> = []
  // Spec ev-charger-location-photo R12 — the AI render leads, because it is the
  // one image that shows the customer the finished job in their own spot.
  //
  // READ ONLY (R13): generatePreviewImage is called at draft time and on upload,
  // never from here. A document render must never make a billable AI call, so a
  // status that is not ready/partial simply contributes nothing and the next
  // download picks it up once the render lands.
  if (ctx.quote.preview_status === 'ready' || ctx.quote.preview_status === 'partial') {
    const renderPaths = Array.isArray(ctx.quote.preview_image_paths)
      ? ctx.quote.preview_image_paths
      : []
    for (const p of renderPaths) {
      if (candidates.length >= EV_MAX_IMAGES) break
      if (typeof p === 'string' && p.trim()) {
        candidates.push({
          src: p.trim(),
          caption: 'Indicative - how the charger could look in this spot',
          signed: true,
        })
      }
    }
  }
  if (ctx.quote.intake_id && candidates.length < EV_MAX_IMAGES) {
    const { data, error } = await supabase()
      .from('intakes')
      .select('photo_paths')
      .eq('id', ctx.quote.intake_id)
      .maybeSingle<{ photo_paths: string[] | null }>()
    if (error) {
      console.error('[quote-pdf] EV estimate: intake photos unavailable', {
        quoteId: ctx.quote.id,
        error: error.message,
      })
    }
    for (const p of data?.photo_paths ?? []) {
      if (candidates.length >= EV_MAX_IMAGES) break
      if (typeof p === 'string' && p.trim()) {
        candidates.push({ src: p.trim(), caption: null, signed: true })
      }
    }
  }
  // The tenant's product shot comes LAST (R12): the render and the customer's
  // own photo are about THIS job, a stock product photo is not. In production
  // no tenant stocks a charger, so this is empty today either way.
  if (extras.chosenProductImagePath && candidates.length < EV_MAX_IMAGES) {
    // catalogue-images is a public bucket — the stored path is already a URL.
    candidates.push({
      src: extras.chosenProductImagePath,
      caption: extras.chosenProductName,
      signed: false,
    })
  }

  const images: EvEstimateImage[] = []
  let missing = false
  for (const c of candidates.slice(0, EV_MAX_IMAGES)) {
    try {
      // intake-photos is private: re-sign before anything can fetch it.
      const url = c.signed ? await refreshSignedUrl(c.src) : c.src
      const src = opts.embed ? await prepareImage(url, { maxEdge: 640 }) : url
      if (src) images.push({ src, caption: c.caption })
      else missing = true
    } catch (e) {
      missing = true
      console.error('[quote-pdf] EV estimate: image skipped', {
        quoteId: ctx.quote.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return { images, expected: candidates.length, missing }
}

/** Assemble the EV estimate's input from the shared context plus its extras. */
function buildEvEstimateInput(
  ctx: QuoteReportContext,
  branding: Awaited<ReturnType<typeof loadTenantBranding>>,
  extras: EvEstimateExtras,
  images: EvEstimateImage[],
): EvChargerEstimateInput {
  const { quote, visibleTierSet } = ctx
  const scope = readEvScope(ctx.intake?.scope)
  const method = jobMethod('electrical', 'ev_charger')
  const good = visibleTierSet.has('good') ? quote.good : null
  const better = visibleTierSet.has('better') ? quote.better : null
  const best = visibleTierSet.has('best') ? quote.best : null
  const lineItems = [good, better, best].flatMap((t) => t?.line_items ?? [])
  return {
    businessName: branding.businessName,
    branding,
    estimateRef: extras.estimateRef,
    customerName: ctx.intake?.caller?.name ?? null,
    customerEmail: extras.customerEmail,
    customerPhone: extras.customerPhone,
    siteAddress: extras.siteAddress,
    scopeOfWorks: quote.scope_of_works,
    descriptionOfWorks: deriveEvDescriptionOfWorks({
      scopeDescription: scope.description,
      methodSteps: method?.steps ?? null,
      lineItems,
    }),
    assumptions: quote.assumptions,
    exclusions: extras.exclusions,
    optionalUpsells: (quote.optional_upsells ?? [])
      .filter((u) => typeof u?.name === 'string' && u.name.trim())
      .map((u) => ({ name: String(u.name), price_ex_gst: u.price_ex_gst ?? null })),
    images,
    good,
    better,
    best,
    selectedTier: ctx.recommendedTier,
    appliedDiscountPct: quote.applied_discount_pct ?? null,
    gstRegistered: ctx.gstRegistered,
    quoteViewUrl: publicWebUrl(`/q/${quote.share_token}`),
    estimatedTimeframe: quote.estimated_timeframe,
    suppliedBy: extras.suppliedBy,
    chargerUnitIds: extras.chargerUnitIds,
    generatedAt: quote.created_at ? new Date(quote.created_at) : undefined,
  }
}

/**
 * The report as self-contained HTML (the exact document Gotenberg renders to
 * PDF), for the dashboard quote viewer's inline, editable preview. Returns null
 * for a missing or inspection-routed quote (mirrors ensureQuotePdf). Reads the
 * live quotes row every call, so it reflects a structured edit the instant it
 * saves — no PDF regeneration needed for the preview to update.
 */
export async function renderQuoteReportHtml(quoteId: string): Promise<string | null> {
  const ctx = await loadQuoteReportContext(quoteId)
  if (!ctx) return null
  // RC-1 — commercial painting authors its own tender PDF (no generic HTML
  // equivalent). Returning null makes the dashboard preview show the "use
  // Download PDF" placeholder — which serves the tender — instead of a
  // misleading generic Good/Better/Best document the customer never receives.
  if (tradeRendersOwnQuotePdf(ctx.intakeTrade)) return null
  const branding = await loadTenantBranding(supabase(), ctx.quote.tenant_id, ctx.intakeTrade)
  // Live preview: reference the token-gated satellite proxy directly (relative
  // URL — the preview renders on the app origin), exactly like the customer
  // page's RoofHeroStrip (roofing centres on the measured polygon, not the
  // geocoded address). The PDF path embeds a data URI instead.
  const visualsImageSrc = await resolveVisualsImagePath(
    ctx.intakeTrade,
    ctx.quote.share_token,
    ctx.intake?.address ?? null,
  )
  // Roofing: the layout map + estimated materials from the linked measurement.
  const layoutOverlay =
    ctx.intakeTrade === 'roofing' ? await resolveRoofLayoutForQuote(ctx.quote.share_token) : null
  // Spec R1 — the dashboard preview must show the SAME document the customer
  // downloads, so the EV branch is resolved here too. Preview references image
  // URLs directly rather than embedding data URIs.
  let ev: EvChargerEstimateInput | null = null
  if (isEvChargerEstimate(ctx)) {
    const extras = await loadEvEstimateExtras(ctx)
    const { images } = await resolveEvImages(ctx, extras, { embed: false })
    ev = buildEvEstimateInput(ctx, branding, extras, images)
  }
  return renderQuoteDocumentHtml(
    // Preview: reference the tradie photo by its public URL (the PDF embeds a
    // data URI instead) — same treatment as the property visual above.
    buildQuoteReportInput(ctx, branding, visualsImageSrc, layoutOverlay, ctx.tradiePhotoUrl),
    ctx.quote.report_doc,
    ev,
  )
}

/**
 * Generate (or reuse) the PDF for an electrical/plumbing quote.
 * Returns the storage path, or null when generation isn't possible
 * (Gotenberg unconfigured, inspection-only quote, quote not found).
 * By default errors return null for existing SMS callers. Download callers
 * opt into typed pricing errors so a missing basis is an explicit review state.
 */
export async function ensureQuotePdf(
  quoteId: string,
  opts: { regenerate?: boolean; strictPricing?: boolean; expectedReleaseRevision?: string } = {},
): Promise<string | null> {
  try {
    // Inspection-routed quotes carry no committable prices — a "quote PDF"
    // would put indicative numbers in a document that reads as final —
    // loadQuoteReportContext returns null for them (and for a missing quote).
    const ctx = await loadQuoteReportContext(quoteId)
    if (!ctx) return null
    const { quote, intakeTrade, tierMode, visibleTierKeys, recommendedTier } = ctx

    // Bind the separately loaded renderer row to the exact reviewed release.
    // SQL's final CAS alone cannot detect A -> B (render) -> A (release).
    if (opts.expectedReleaseRevision !== undefined &&
        opts.expectedReleaseRevision !== quoteCustomerReleaseRevision(quote)) {
      throw new QuotePricingVersionError('quote_review_required')
    }

    // RC-1 — commercial painting rendered + stored its OWN tender PDF at
    // quotes/<id>.pdf (save-quote). Serve it verbatim. Its row carries a pdf_path
    // but no pdf_signature, so the stale-check below would otherwise regenerate
    // the generic Good/Better/Best template and upsert it OVER the tender —
    // destroying the tender bytes and MMS'ing a legally-weaker document. This
    // guard wins over opts.regenerate: a resend must never clobber it.
    if (tradeRendersOwnQuotePdf(intakeTrade)) return quote.pdf_path

    // Mig 146 — self-heal: serve the cached PDF only when it was rendered from
    // the SAME template version + tier mode + visible tiers + recommended tier.
    // A tradie flipping the Pricing-settings tier mode (or a template bump)
    // changes the signature, so the next download/send regenerates instead of
    // serving a stale Good/Better/Best PDF.
    // Fold the document content hash into the signature ONLY when the doc render
    // is active, so a report_doc/report_style edit regenerates the PDF. Flag off
    // ⇒ docHash '' ⇒ signature byte-identical to the pre-Phase-1 format (no
    // spurious regeneration of existing cached PDFs).
    const docHash =
      process.env.FULL_QUOTE_DOC === 'true'
        ? hashReportContent(quote.report_doc, quote.report_style)
        : ''
    const freshSignature = `${quotePdfSignature({
      templateVersion: REPORT_TEMPLATE_VERSION,
      tierMode,
      visibleTierKeys,
      recommendedTier,
      docHash,
      // P7 — a discount stamped at booking time (after the draft-time PDF was
      // cached) must regenerate the PDF at the discounted price.
      appliedDiscountPct: ctx.quote.applied_discount_pct,
      // The saved tax basis participates in the signature. Today's rate-card
      // GST changes do not reprice an already issued quote.
      gstRegistered: ctx.gstRegistered,
      // v8 — a photo uploaded from the Account tab AFTER this PDF was cached
      // must replace the placeholder avatar on the next download.
      tradiePhotoUrl: ctx.tradiePhotoUrl,
      // Spec R15 — EV charger quotes render a different document. Keying it here
      // rather than bumping REPORT_TEMPLATE_VERSION regenerates ONLY those PDFs;
      // every other electrical/plumbing signature stays byte-identical.
      //
      // ev-charger-location-photo R14 folds the RENDER SET into that key. The
      // Gemini image is produced asynchronously, so the first PDF is very often
      // cached before it lands; without this the customer would keep downloading
      // the render-less document forever, because nothing else in the signature
      // changes when an image appears.
      templateKey: isEvChargerEstimate(ctx) ? evTemplateCacheKey(ctx) : null,
    })}|web=${publicWebOrigin()}|pricing=${quoteEditRevision(quote)}`
    if (
      isImmutableQuotePdfPath(quoteId, quote.pdf_path) &&
      !quotePdfIsStale({
        pdfPath: quote.pdf_path,
        storedSignature: quote.pdf_signature,
        freshSignature,
        regenerate: opts.regenerate,
      })
    ) {
      return quote.pdf_path
    }
    if (!gotenbergConfigured()) return null

    const branding = await loadTenantBranding(supabase(), quote.tenant_id, intakeTrade)
    // Property visuals image (roofing / commercial painting) — fetched via the
    // same token-gated satellite proxy the customer page uses, embedded as a
    // data URI (mirrors ensureRoofQuotePdf). Roofing centres on the measured
    // polygon (not the geocoded street address). Best-effort: prepareImage never
    // throws; null just renders the stats-only block.
    const visualsPath = await resolveVisualsImagePath(
      intakeTrade,
      quote.share_token,
      ctx.intake?.address ?? null,
    )
    const visualsImageSrc = visualsPath
      ? await prepareImage(publicWebUrl(visualsPath), { maxEdge: 640 })
      : null
    // Roofing: layout map + estimated materials from the linked measurement, so
    // the downloadable/sent quote PDF carries them (they live on the measurement,
    // not the quotes row).
    const layoutOverlay =
      intakeTrade === 'roofing' ? await resolveRoofLayoutForQuote(quote.share_token) : null
    // "Your tradie" photo, embedded as a data URI (Gotenberg must not depend on
    // a network fetch). Best-effort: null falls back to the placeholder avatar.
    const tradiePhotoSrc = ctx.tradiePhotoUrl
      ? await prepareImage(ctx.tradiePhotoUrl, { maxEdge: 320 })
      : null
    // Spec R1/R14 — the EV charger estimate, with its images embedded as data
    // URIs so the render never depends on a network fetch.
    let ev: EvChargerEstimateInput | null = null
    let evImagesMissing = false
    if (isEvChargerEstimate(ctx)) {
      const extras = await loadEvEstimateExtras(ctx)
      const resolved = await resolveEvImages(ctx, extras, { embed: true })
      evImagesMissing = resolved.missing
      ev = buildEvEstimateInput(ctx, branding, extras, resolved.images)
    }
    const html = renderQuoteDocumentHtml(
      buildQuoteReportInput(ctx, branding, visualsImageSrc, layoutOverlay, tradiePhotoSrc),
      quote.report_doc,
      ev,
    )
    let pdf = await renderPdfFromHtml(html)
    // Spec R14 — images are dropped before the document is. An image-heavy EV
    // estimate that lands over the MMS cap would otherwise degrade the whole
    // send to link-only; re-rendering without the images keeps the document
    // attachable, and the customer can still see the photos on the quote page.
    if (ev && ev.images?.length && exceedsMmsMediaCap(pdf.byteLength)) {
      console.warn('[quote-pdf] EV estimate over the MMS cap — re-rendering without images', {
        quoteId,
        bytes: pdf.byteLength,
      })
      const withoutImages = renderQuoteDocumentHtml(
        buildQuoteReportInput(ctx, branding, visualsImageSrc, layoutOverlay, tradiePhotoSrc),
        quote.report_doc,
        { ...ev, images: [] },
      )
      pdf = await renderPdfFromHtml(withoutImages)
      // The stored document is now image-less BY DESIGN, not degraded by a
      // failed fetch. Leaving the missing flag set would store a NULL signature,
      // so every later download would be judged stale and repeat BOTH renders —
      // two Gotenberg round trips per request, forever, on a route capped at 60s.
      evImagesMissing = false
    }
    const path = await storeImmutableQuotePdf(quoteId, pdf)
    // RC-8 — if an image was EXPECTED but prepareImage returned null (a transient
    // fetch blip), this PDF is missing it while the live HTML preview still shows
    // the raw <img>. Storing a null signature marks it stale so the next download
    // regenerates once the fetch recovers — rather than caching + serving the
    // degraded PDF forever. Covers BOTH render-time images: the property visual
    // (roofing/commercial aerial) and the tradie photo — a blip on the latter
    // would otherwise cache the placeholder avatar permanently for a tradie who
    // HAS uploaded a photo.
    const imageMissing =
      embeddedImageMissing(visualsPath, visualsImageSrc) ||
      embeddedImageMissing(ctx.tradiePhotoUrl, tradiePhotoSrc) ||
      // Spec R14 — an EV estimate image that failed to fetch takes the same
      // NULL-signature retry rather than caching the document without it.
      evImagesMissing
    await supabase()
      .from('quotes')
      .update({ pdf_path: path, pdf_signature: imageMissing ? null : freshSignature })
      .eq('id', quoteId)
    return path
  } catch (e) {
    if ((opts.strictPricing || opts.expectedReleaseRevision !== undefined) && e instanceof QuotePricingVersionError) throw e
    console.error('[quote-pdf] ensureQuotePdf failed (non-fatal)', {
      quoteId,
      message: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

/**
 * Generate (or reuse) the PDF for a roofing quote. Pass `quote` to render
 * a narrowed (structure-subset) version — the stored row keeps the full
 * quote. Never throws.
 */
export async function ensureRoofQuotePdf(
  publicToken: string,
  opts: { regenerate?: boolean; quote?: MultiRoofQuote; displayRows?: RoofDisplayRow[] } = {},
): Promise<string | null> {
  try {
    if (!gotenbergConfigured()) return null
    const { data: row } = await supabase()
      .from('roofing_measurements')
      .select(
        'public_token, tenant_id, address, quote, routing, pdf_path, layout_status, layout_plan, included_indices, confirmed_structure',
      )
      .eq('public_token', publicToken)
      .maybeSingle<RoofPdfRow>()
    if (!row) return null
    // Inspection-routed roofs carry no committable price — no quote PDF
    // (mirrors the paint/solar guard; defense-in-depth behind the UI gate).
    if (row.routing === 'inspection_required') return null
    // Path rev marker (see ROOF_PDF_REV) — a cached PDF from an older figure/
    // template era regenerates once on the next download. A cached PDF is
    // valid even for narrowed (opts.quote) calls: the narrowed quote derives
    // from the persisted selection, and the selection-update route NULLS
    // pdf_path on change (app/api/roofing/measurement/[token]/route.ts), so a
    // surviving pdf_path always reflects the current selection.
    // A cache refresh must retain every PDF object already attached to a send.
    // The revision identifies reusable content; the final key binds its bytes.
    const expectedPrefix = `roofs/${publicToken}${ROOF_PDF_REV}${pdfWebsiteRevision()}/`
    if (isImmutableTradePdfPath(expectedPrefix, row.pdf_path) && !opts.regenerate) {
      return row.pdf_path
    }

    // RC-3 — selection-aware by default: a no-arg regenerate (e.g. the AI
    // layout-plan route) narrows to the persisted included_indices instead of
    // pricing every detected structure into the shared cache. Explicit callers
    // (SMS send's finalQuote, the download route's pre-partitioned quote+rows)
    // still win verbatim.
    const { quote } = resolveRoofRenderSelection(
      {
        quote: row.quote,
        included_indices: row.included_indices,
        confirmed_structure: row.confirmed_structure,
      },
      { quote: opts.quote, displayRows: opts.displayRows },
    )
    if (!quote) return null

    // Mig 148 — honour the tenant's roofing tier mode (dashboard Pricing
    // settings) so a single-price roofer's PDF shows one option, not the full
    // Good/Better/Best layout. Mirrors the roofing SMS path
    // (app/api/sms/inbound/route.ts) and ensureQuotePdf for electrical/plumbing.
    let roofTierMode: QuoteTierMode = 'single'
    if (row.tenant_id) {
      const { data: rb } = await supabase()
        .from('pricing_book')
        .select('quote_tier_mode')
        .eq('tenant_id', row.tenant_id)
        .eq('trade', 'roofing')
        .maybeSingle<{ quote_tier_mode: string | null }>()
      roofTierMode = asQuoteTierMode(rb?.quote_tier_mode ?? null)
    }
    const visibleTierKeys = resolveVisibleTiers({
      mode: roofTierMode,
      present: {
        good: quote.combined.tiers.some((t) => t.tier === 'good'),
        better: quote.combined.tiers.some((t) => t.tier === 'better'),
        best: quote.combined.tiers.some((t) => t.tier === 'best'),
      },
      selectedTier: null,
    })

    const branding = await loadTenantBranding(supabase(), row.tenant_id, 'roofing')

    // Aerial photo(s) — section 01's figure. One per INCLUDED structure, each
    // centred on its building via static-map ?b=. Map the rendered (narrowed/
    // included) structures back to their 1-based index in the FULL stored quote
    // (row.quote) by buildingId, because the static-map endpoint indexes the
    // full quote and the rendered quote may be a re-ordered subset from a
    // separate DB read. Deriving this INSIDE ensureRoofQuotePdf means every
    // entry point (download route, SMS send, file-store) gets the
    // multi-structure aerials, even those that pass a narrowed `quote` and no
    // `displayRows`. Single structure → the page's single unlabelled aerial.
    // (spec roofing-pdf-multi-structure-images R2)
    const imageRefs = structureImageRefs(row.quote?.structures, quote.structures)
    const aerials =
      imageRefs.length > 1
        ? await Promise.all(
            imageRefs.map(async (r) => ({
              label: r.label,
              src: await prepareImage(
                publicWebUrl(structureStaticMapPath(publicToken, r.index1Based)),
              ),
            })),
          )
        : [
            {
              label: '',
              src: await prepareImage(publicWebUrl(`/api/roofing/q/${publicToken}/static-map`)),
            },
          ]

    // "Your tradie" photo, embedded as a data URI (Gotenberg must not depend on
    // a network fetch). Best-effort: null falls back to the placeholder avatar.
    let tradiePhotoUrl: string | null = null
    if (row.tenant_id) {
      const { data: t } = await supabase()
        .from('tenants')
        .select('photo_url')
        .eq('id', row.tenant_id)
        .maybeSingle<{ photo_url: string | null }>()
      tradiePhotoUrl = t?.photo_url ?? null
    }
    const tradiePhotoSrc = tradiePhotoUrl
      ? await prepareImage(tradiePhotoUrl, { maxEdge: 320 })
      : null

    // The CUSTOMER view — the same five numbered sections /q/roof/[token]
    // renders for a confirmed customer. The tradie's detailed measurement
    // report (buildRoofQuoteReportHtml) stays on the ?full=1 page; this is the
    // document the customer receives over SMS/MMS/email, so the two agree.
    const html = buildRoofCustomerReportHtml({
      businessName: branding.businessName,
      branding,
      address: row.address ?? '',
      quote,
      visibleTierKeys,
      aerials,
      tradie: tradieProfile({
        businessName: branding.businessName,
        photoUrl: tradiePhotoSrc,
        trade: 'roofing',
      }),
      inspectionFeeAud: INSPECTION_FEE_AUD,
      quoteViewUrl: publicWebUrl(`/q/roof/${publicToken}`),
    })
    const pdf = await renderPdfFromHtml(html)
    const path = await storeImmutablePdf(immutableTradePdfPath(expectedPrefix, pdf), pdf)
    await supabase().from('roofing_measurements').update({ pdf_path: path }).eq('public_token', publicToken)
    return path
  } catch (e) {
    console.error('[quote-pdf] ensureRoofQuotePdf failed (non-fatal)', {
      publicToken: publicToken.slice(0, 8) + '…',
      message: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

/**
 * Generate (or reuse) the PDF for a solar quote (migration 106). Reads the
 * full persisted SolarEstimate from solar_estimates.estimate, so no
 * recomputation. Inspection-routed estimates carry no committable price and
 * return null. Stored under solar/<publicToken><revision>/<content-hash>.pdf
 * in the same quote-pdfs bucket. Never throws.
 */
export async function ensureSolarQuotePdf(
  publicToken: string,
  opts: { regenerate?: boolean } = {},
): Promise<string | null> {
  try {
    if (!gotenbergConfigured()) return null
    const { data: row } = await supabase()
      .from('solar_estimates')
      .select(
        'public_token, tenant_id, address, estimate, routing, pdf_path, quote_variant, felt, ai_brief, panels_image_status, panels_image_path',
      )
      .eq('public_token', publicToken)
      .maybeSingle<SolarPdfRow>()
    if (!row) return null
    if (row.routing === 'inspection_required') return null
    // RC-5 — content-aware rev (solarPdfRev) instead of the static SOLAR_PDF_REV
    // marker: the panels-after image, sun & shade heatmap, felt map, AI brief and
    // the premium flag are produced/read AFTER the auto-release freeze, so a
    // static marker served a section-less PDF forever while the live page showed
    // them. The rev now shifts when each lands, so the next fetch regenerates
    // once and every channel serves the same enriched document.
    const premiumEnabled = solarPremiumQuoteEnabled(process.env.SOLAR_PREMIUM_QUOTE)
    const rev = solarPdfRev(row, premiumEnabled)
    const expectedPrefix = `solar/${publicToken}${rev}${pdfWebsiteRevision()}/`
    if (isImmutableTradePdfPath(expectedPrefix, row.pdf_path) && !opts.regenerate) {
      return row.pdf_path
    }

    const estimate = row.estimate
    if (!estimate) return null
    const branding = await loadTenantBranding(supabase(), row.tenant_id, 'solar')

    // Premium proposal sections (spec 2026-06-12 §4.4), behind the same
    // SOLAR_PREMIUM_QUOTE flag the page uses. theme 'light' = print
    // palette. The PDF only generates for confirmed, non-inspection
    // estimates, so the money sections are safely renderable.
    let premium: SolarPremiumQuote | null = null
    if (premiumEnabled) {
      const config = await loadSolarConfig(supabase())
      premium = buildSolarPremiumQuote({ estimate, config, theme: 'light' })
    }

    const html = buildSolarQuoteReportHtml({
      businessName: branding.businessName,
      branding,
      address: row.address ?? '',
      estimate,
      quoteViewUrl: publicWebUrl(`/q/solar/${publicToken}`),
      premium,
      staticMapUrl: publicWebUrl(`/api/solar/q/${publicToken}/static-map`),
      // Sun & shade heatmap (build 2026-06-13) — only referenced when the
      // cached asset exists, so the PDF never embeds a 404.
      fluxImageUrl: estimate.context.sun?.flux_image_path
        ? publicWebUrl(`/api/solar/q/${publicToken}/flux-heatmap`)
        : null,
      // "Roof with panels" AI visual (spec quote-visual-parity R5) — only the
      // CACHED render is referenced, so the PDF never triggers a Gemini bill.
      panelsAfterUrl:
        row.panels_image_status === 'ready' && row.panels_image_path
          ? publicWebUrl(`/api/solar/q/${publicToken}/panels-after`)
          : null,
      // Felt variant (spec 2026-06-13 §4.7-8): the PDF carries the map
      // thumbnail + live link (an iframe can't print) and the grounded
      // AI brief. Instant rows pass null and render identically to today.
      feltMap:
        row.quote_variant === 'felt' && row.felt?.thumbnail_url
          ? {
              thumbnailUrl: row.felt.thumbnail_url ?? null,
              mapUrl: row.felt.map_url ?? null,
            }
          : null,
      aiBrief: row.quote_variant === 'felt' ? (row.ai_brief ?? null) : null,
    })
    const pdf = await renderPdfFromHtml(html)
    const path = await storeImmutablePdf(immutableTradePdfPath(expectedPrefix, pdf), pdf)
    await supabase().from('solar_estimates').update({ pdf_path: path }).eq('public_token', publicToken)
    return path
  } catch (e) {
    console.error('[quote-pdf] ensureSolarQuotePdf failed (non-fatal)', {
      publicToken: publicToken.slice(0, 8) + '…',
      message: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

/**
 * Generate (or reuse) the PDF for a residential painting quote (migration
 * 115). Reads the full persisted PaintingEstimate from
 * painting_measurements.estimate, so no recomputation. Inspection-routed
 * jobs carry no committable price and return null. Stored at
 * paint/<publicToken><revision>/<content-hash>.pdf in the same quote-pdfs
 * bucket. Never throws.
 */
export async function ensurePaintingPdf(
  publicToken: string,
  opts: { regenerate?: boolean } = {},
): Promise<string | null> {
  try {
    if (!gotenbergConfigured()) return null
    const { data: row } = await supabase()
      .from('painting_measurements')
      .select(
        'public_token, tenant_id, address, estimate, routing, pdf_path, preview_status, preview_image_path',
      )
      .eq('public_token', publicToken)
      .maybeSingle<PaintingPdfRow>()
    if (!row) return null
    if (row.routing === 'inspection_required') return null
    // Rev path marker = rendered by the current layout (spec
    // quote-visual-parity R2) — a stale cached PDF regenerates once on the
    // next download; self-heal without a migration. When an AI repaint is
    // cached, the render's timestamp (painting/<id>/after-<ts>.<ext>) is
    // appended so a customer recolour also invalidates the PDF — the PDF
    // always embeds the CURRENT colour choice.
    const wantAfter = row.preview_status === 'ready' && !!row.preview_image_path
    const afterStamp = wantAfter
      ? ((row.preview_image_path as string).match(/after-(\d+)/)?.[1] ?? 'r')
      : null
    const paintRev = afterStamp ? `${PAINT_PDF_REV}-${afterStamp}` : PAINT_PDF_REV
    const expectedPrefix = `paint/${publicToken}${paintRev}${pdfWebsiteRevision()}/`
    if (isImmutableTradePdfPath(expectedPrefix, row.pdf_path) && !opts.regenerate) {
      return row.pdf_path
    }

    const estimate = row.estimate
    if (!estimate) return null

    // Honour the tenant's painting tier mode (mig 142) so a single-price
    // tenant's PDF shows one option, exactly like /q/paint — never revealing
    // the hidden Good/Best tiers, their relation rows or materials. Mirrors
    // ensureRoofQuotePdf and the /q/paint page's own tier gating.
    const paintTiers = estimate.price?.tiers ?? []
    let paintTierMode: QuoteTierMode = 'single'
    if (row.tenant_id) {
      const { data: ppb } = await supabase()
        .from('pricing_book')
        .select('quote_tier_mode')
        .eq('tenant_id', row.tenant_id)
        .eq('trade', 'painting')
        .maybeSingle<{ quote_tier_mode: string | null }>()
      paintTierMode = asQuoteTierMode(ppb?.quote_tier_mode ?? null)
    }
    const paintVisibleTierKeys = resolveVisibleTiers({
      mode: paintTierMode,
      present: {
        good: paintTiers.some((t) => t.tier === 'good'),
        better: paintTiers.some((t) => t.tier === 'better'),
        best: paintTiers.some((t) => t.tier === 'best'),
      },
      selectedTier: 'better',
    })

    // Property imagery (spec quote-visual-parity R2) — the same token-gated
    // proxies the /p and /q/paint pages use, embedded as data URIs.
    // Street View + the aerial are plain proxy fetches; the AI repaint
    // embeds ONLY when the render is already cached ('ready') so PDF
    // generation never bills Gemini. All fetches are independent.
    const [branding, streetViewSrc, aerialSrc, afterImageSrc] = await Promise.all([
      loadTenantBranding(supabase(), row.tenant_id, 'painting'),
      prepareImage(publicWebUrl(`/api/painting/q/${publicToken}/street-view`), { maxEdge: 640 }),
      prepareImage(publicWebUrl(`/api/painting/q/${publicToken}/static-map`), { maxEdge: 640 }),
      wantAfter
        ? prepareImage(publicWebUrl(`/api/painting/q/${publicToken}/after-image`), { maxEdge: 640 })
        : Promise.resolve(null),
    ])

    const html = buildPaintingQuoteReportHtml({
      businessName: branding.businessName,
      branding,
      address: row.address ?? '',
      estimate,
      visibleTierKeys: paintVisibleTierKeys,
      streetViewSrc,
      aerialSrc,
      afterImageSrc,
      quoteViewUrl: publicWebUrl(`/q/paint/${publicToken}`),
    })
    const pdf = await renderPdfFromHtml(html)
    const path = await storeImmutablePdf(immutableTradePdfPath(expectedPrefix, pdf), pdf)
    await supabase().from('painting_measurements').update({ pdf_path: path }).eq('public_token', publicToken)
    return path
  } catch (e) {
    console.error('[quote-pdf] ensurePaintingPdf failed (non-fatal)', {
      publicToken: publicToken.slice(0, 8) + '…',
      message: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}
