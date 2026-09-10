import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => {
  const rows: Record<string, Record<string, unknown> | null> = {}
  const upload = vi.fn<(path: string, data: Buffer, options: unknown) => Promise<{ error: null }>>(async () => ({ error: null }))
  const client = {
    from: (table: string) => {
      let patch: Record<string, unknown> | undefined
      const query = {
        select: () => query, eq: () => query, in: () => query,
        update: (value: Record<string, unknown>) => { patch = value; return query },
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => {
          if (patch) Object.assign(rows[table]!, patch)
          return Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve)
        },
      }
      return query
    },
    rpc: async () => ({ data: 1, error: null }),
    storage: { from: () => ({ upload }) },
  }
  return {
    rows, client, upload,
    generic: vi.fn(() => '<html>generic</html>'), ev: vi.fn(() => '<html>ev</html>'),
    roof: vi.fn(() => '<html>roof</html>'), solar: vi.fn(() => '<html>solar</html>'),
    paint: vi.fn(() => '<html>paint</html>'),
    image: vi.fn(async () => 'data:image/png;base64,cGljdHVyZQ=='),
    render: vi.fn(async () => Buffer.from('PDF')),
  }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/pdf/gotenberg', () => ({ gotenbergConfigured: () => true, renderPdfFromHtml: h.render }))
vi.mock('@/lib/pdf/branding', () => ({ loadTenantBranding: async () => ({ businessName: 'Example Trade' }) }))
vi.mock('@/lib/pdf/image', () => ({ prepareImage: h.image }))
vi.mock('@/lib/storage/upload', () => ({ refreshSignedUrl: vi.fn() }))
vi.mock('@/lib/sms/send-quote-pdf', () => ({ exceedsMmsMediaCap: () => false, MMS_MEDIA_CAP_BYTES: 5_000_000 }))
vi.mock('./report-html', () => ({ buildQuoteReportHtml: h.generic, buildQuoteReportHtmlFromBody: h.generic, REPORT_TEMPLATE_VERSION: 'test' }))
vi.mock('./report-html-ev-charger', async importOriginal => ({
  ...await importOriginal<typeof import('./report-html-ev-charger')>(), buildEvChargerEstimateHtml: h.ev,
}))
vi.mock('@/lib/roofing/report-html', () => ({ buildRoofCustomerReportHtml: h.roof }))
vi.mock('@/lib/solar/report-html', () => ({ buildSolarQuoteReportHtml: h.solar }))
vi.mock('@/lib/painting/report-html', () => ({ buildPaintingQuoteReportHtml: h.paint }))

import {
  quotePdfUrl, roofQuotePdfUrl, solarQuotePdfUrl, paintQuotePdfUrl,
  renderQuoteReportHtml, ensureQuotePdf, ensureRoofQuotePdf, ensureSolarQuotePdf, ensurePaintingPdf,
} from './pdf'

const origin = 'https://customer.quotemax.com.au'
const token = 'saved_customer_quote_123'
const genericPdfPath = `quotes/quote-id/${createHash('sha256').update('PDF').digest('hex')}.pdf`
const builders = [
  ['generic', quotePdfUrl, `/api/q/${token}/pdf`],
  ['roof', roofQuotePdfUrl, `/api/q/roof/${token}/pdf`],
  ['solar', solarQuotePdfUrl, `/api/q/solar/${token}/pdf`],
  ['paint', paintQuotePdfUrl, `/api/q/paint/${token}/pdf`],
] as const

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(h.rows)) delete h.rows[key]
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('PUBLIC_WEB_ORIGIN', origin)
  vi.stubEnv('APP_URL', 'https://legacy-api.up.railway.app')
  vi.stubEnv('ENGINE_BASE_URL', 'https://engine.example.com')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
  vi.stubEnv('SOLAR_PREMIUM_QUOTE', '0')
  vi.stubEnv('FULL_QUOTE_DOC', 'false')
  h.rows.quotes = {
    id: 'quote-id', intake_id: 'intake-id', tenant_id: 'tenant-id', share_token: token,
    good: null, better: { line_items: [], subtotal_ex_gst: 100 }, best: null,
    selected_tier: 'better', total_inc_gst: 110, needs_inspection: false, scope_of_works: 'Install equipment',
    created_at: '2026-09-08T00:00:00Z', preview_status: null, preview_image_paths: [],
  }
  h.rows.intakes = { id: 'intake-id', tenant_id: 'tenant-id', job_type: 'power_points', trade: 'electrical', address: '1 Example St', caller: { name: 'Sam' }, scope: {} }
})
afterEach(() => vi.unstubAllEnvs())

describe('PDF website origins at the exported boundary', () => {
  it.each(builders)('%s download uses the canonical website and resolves configuration lazily', (_name, build, path) => {
    expect(build(token)).toBe(origin + path)
    vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://new-customer.quotemax.com.au')
    expect(build(token)).toBe('https://new-customer.quotemax.com.au' + path)
  })

  it.each([
    ['missing', ''],
    ['engine', 'https://engine.example.com'],
    ['Railway API', 'https://receptionist.up.railway.app'],
    ['local', 'http://localhost:3000'],
    ['path', 'https://customer.quotemax.com.au/api'],
    ['credentials', 'https://secret@customer.quotemax.com.au'],
  ])('rejects %s website configuration in every builder', (_name, invalid) => {
    vi.stubEnv('PUBLIC_WEB_ORIGIN', invalid)
    vi.stubEnv('APP_URL', '')
    for (const [, build] of builders) expect(() => build(token)).toThrow()
  })

  it('can import the PDF module without configured link origins', async () => {
    vi.stubEnv('PUBLIC_WEB_ORIGIN', '')
    vi.stubEnv('APP_URL', '')
    vi.resetModules()
    const pdfModule = await import('./pdf')
    expect(() => pdfModule.quotePdfUrl(token)).toThrow('PUBLIC_WEB_ORIGIN')
  })

  it.each(['power_points', 'ev_charger'])('passes the canonical quote URL to the %s report', async jobType => {
    h.rows.intakes!.job_type = jobType
    await renderQuoteReportHtml('quote-id')
    const report = jobType === 'ev_charger' ? h.ev : h.generic
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ quoteViewUrl: `${origin}/q/${token}` }))
  })

  it('uses the website for generic roofing report images', async () => {
    h.rows.intakes!.trade = 'roofing'
    h.rows.roofing_measurements = { public_token: token }
    expect(await ensureQuotePdf('quote-id')).toBe(genericPdfPath)
    expect(h.image).toHaveBeenCalledWith(`${origin}/api/roofing/q/${token}/static-map?b=1`, { maxEdge: 640 })
    expect(h.generic).toHaveBeenCalledWith(expect.objectContaining({ quoteViewUrl: `${origin}/q/${token}` }))
  })

  it('uses the website for the roof report and each structure image', async () => {
    h.rows.roofing_measurements = {
      public_token: token, tenant_id: null,
      quote: { structures: [{ buildingId: 'house', label: 'House' }, { buildingId: 'shed', label: 'Shed' }], combined: { tiers: [] } },
    }
    expect(await ensureRoofQuotePdf(token, { displayRows: [] })).toMatch(/^roofs\/saved_customer_quote_123-v7-web-[a-f0-9]{16}\/[a-f0-9]{64}\.pdf$/)
    expect(h.image).toHaveBeenCalledWith(`${origin}/api/roofing/q/${token}/static-map?b=1`)
    expect(h.image).toHaveBeenCalledWith(`${origin}/api/roofing/q/${token}/static-map?b=2`)
    expect(h.roof).toHaveBeenCalledWith(expect.objectContaining({ quoteViewUrl: `${origin}/q/roof/${token}` }))
  })

  it('uses the website for solar report, map, heatmap and cached panel image', async () => {
    h.rows.solar_estimates = {
      public_token: token, tenant_id: null, estimate: { context: { sun: { flux_image_path: 'cached.png' } } },
      panels_image_status: 'ready', panels_image_path: 'panels.png',
    }
    expect(await ensureSolarQuotePdf(token)).toMatch(/^solar\/saved_customer_quote_123-v3-ps-web-[a-f0-9]{16}\/[a-f0-9]{64}\.pdf$/)
    expect(h.solar).toHaveBeenCalledWith(expect.objectContaining({
      quoteViewUrl: `${origin}/q/solar/${token}`, staticMapUrl: `${origin}/api/solar/q/${token}/static-map`,
      fluxImageUrl: `${origin}/api/solar/q/${token}/flux-heatmap`, panelsAfterUrl: `${origin}/api/solar/q/${token}/panels-after`,
    }))
  })

  it('uses the website for painting report and property images', async () => {
    h.rows.painting_measurements = {
      public_token: token, tenant_id: null, estimate: { price: { tiers: [] } },
      preview_status: 'ready', preview_image_path: 'painting/after-123.png',
    }
    expect(await ensurePaintingPdf(token)).toMatch(/^paint\/saved_customer_quote_123-v7-123-web-[a-f0-9]{16}\/[a-f0-9]{64}\.pdf$/)
    for (const image of ['street-view', 'static-map', 'after-image']) {
      expect(h.image).toHaveBeenCalledWith(`${origin}/api/painting/q/${token}/${image}`, { maxEdge: 640 })
    }
    expect(h.paint).toHaveBeenCalledWith(expect.objectContaining({ quoteViewUrl: `${origin}/q/paint/${token}` }))
  })

  it('refreshes a legacy generic PDF once, then only when the website changes', async () => {
    const savedPrice = structuredClone(h.rows.quotes!.better)
    h.rows.quotes!.pdf_path = 'quotes/quote-id.pdf'
    h.rows.quotes!.pdf_signature = 'vtest|single|t=better|r='
    expect(await ensureQuotePdf('quote-id')).toBe(genericPdfPath)
    expect(h.render).toHaveBeenCalledTimes(1)
    expect(h.rows.quotes!.pdf_signature).toContain(`|web=${origin}`)
    expect(await ensureQuotePdf('quote-id')).toBe(genericPdfPath)
    expect(h.render).toHaveBeenCalledTimes(1)
    vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://new-customer.quotemax.com.au')
    await ensureQuotePdf('quote-id')
    expect(h.render).toHaveBeenCalledTimes(2)
    expect(h.generic).toHaveBeenLastCalledWith(expect.objectContaining({ quoteViewUrl: `https://new-customer.quotemax.com.au/q/${token}`, better: savedPrice }))
    await ensureQuotePdf('quote-id')
    expect(h.render).toHaveBeenCalledTimes(2)
    expect(h.rows.quotes!.better).toEqual(savedPrice)
  })

  it.each(['roof', 'solar', 'paint'] as const)('migrates %s cache paths once and preserves stored prices on an origin change', async family => {
    const table = { roof: 'roofing_measurements', solar: 'solar_estimates', paint: 'painting_measurements' }[family]
    const legacyPath = `${family === 'roof' ? 'roofs' : family}/${token}-${family === 'solar' ? 'v3' : 'v7'}.pdf`
    h.rows[table] = {
      public_token: token, tenant_id: null, pdf_path: legacyPath,
      quote: { structures: [], combined: { tiers: [] } },
      estimate: { context: {}, price: { tiers: [], total_inc_gst: 3210 } },
    }
    const original = structuredClone(h.rows[table])
    const ensure = () => family === 'roof' ? ensureRoofQuotePdf(token, { displayRows: [] })
      : family === 'solar' ? ensureSolarQuotePdf(token) : ensurePaintingPdf(token)
    const currentPath = await ensure()
    expect(currentPath).toContain('-web-')
    expect(currentPath).not.toBe(legacyPath)
    expect(await ensure()).toBe(currentPath)
    expect(h.render).toHaveBeenCalledTimes(1)
    vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://new-customer.quotemax.com.au')
    const updatedPath = await ensure()
    expect(updatedPath).not.toBe(currentPath)
    expect(await ensure()).toBe(updatedPath)
    expect(h.render).toHaveBeenCalledTimes(2)
    expect(h.upload.mock.calls.map(call => call[0])).toEqual([currentPath, updatedPath])
    expect(h.rows[table]!.estimate).toEqual(original!.estimate)
    expect(h.rows[table]!.quote).toEqual(original!.quote)
  })
})
