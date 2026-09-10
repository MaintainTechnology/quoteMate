import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => {
  const rows: Record<string, Record<string, unknown> | null> = {}
  const errors: Record<string, unknown> = {}
  const reads: Array<{ table: string; fields: string; filters: Record<string, unknown> }> = []
  const render = vi.fn<(html: string) => Promise<Buffer>>(async () => Buffer.from('PDF'))
  const upload = vi.fn<(path: string, data: Buffer, options: { upsert: boolean }) => Promise<{ error: { message: string } | null }>>(async () => ({ error: null }))
  const download = vi.fn<(path: string) => Promise<{ data: Blob | null; error: { message: string } | null }>>(async () => ({ data: new Blob(['PDF']), error: null }))
  const client = {
    rpc: async (name: string) => {
      if (name !== 'next_quote_estimate_number') throw new Error(`Unexpected RPC: ${name}`)
      return { data: 543, error: null }
    },
    from: (table: string) => {
      const read = { table, fields: '', filters: {} as Record<string, unknown> }
      reads.push(read)
      let patch: Record<string, unknown> | undefined
      const q = {
        select: (fields: string) => { read.fields = fields; return q },
        eq: (key: string, value: unknown) => { read.filters[key] = value; return q },
        in: () => q,
        update: (value: Record<string, unknown>) => { patch = value; return q },
        maybeSingle: async () => {
          const data = rows[table] ?? null
          return { data: data && read.fields !== '*' ? Object.fromEntries(read.fields.split(',').map(key => [key.trim(), data[key.trim()]])) : data,
            error: errors[table] ?? null }
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (patch) Object.assign(rows[table]!, patch)
          return Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve)
        },
      }
      return q
    },
    storage: { from: () => ({ upload, download }) },
  }
  return { rows, errors, reads, client, render, upload, download, configured: true }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/pdf/gotenberg', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/pdf/gotenberg')>(),
  gotenbergConfigured: () => h.configured, renderPdfFromHtml: h.render,
}))
vi.mock('@/lib/pdf/branding', async () => {
  const { brandingFromName } = await import('@/lib/pdf/report-chrome')
  return { loadTenantBranding: async () => brandingFromName('Saved Trade') }
})
vi.mock('@/lib/pdf/image', () => ({ prepareImage: vi.fn(async () => null) }))
vi.mock('@/lib/storage/upload', () => ({ refreshSignedUrl: vi.fn() }))
vi.mock('@/lib/sms/send-quote-pdf', () => ({ exceedsMmsMediaCap: () => false, MMS_MEDIA_CAP_BYTES: 5_000_000 }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => null }))
vi.mock('@/lib/quote/page-owner', () => ({ isQuotePageOwner: async () => true }))
vi.mock('@/lib/filestore/archive-on-download', () => ({ archiveQuoteOnDownload: vi.fn() }))

import { ensureQuotePdf, renderQuoteReportHtml } from './pdf'
import { quoteCustomerReleaseRevision } from './customer-release'
import { GET as pdfGet } from '@/app/api/q/[token]/pdf/route'
import { GET as htmlGet } from '@/app/api/q/[token]/html/route'

function tier(amount = 100.05) {
  return { label: 'Saved work', subtotal_ex_gst: amount,
    line_items: [{ description: 'Owned item', quantity: 1, unit: 'each', unit_price_ex_gst: amount, total_ex_gst: amount }] }
}
function version(gst = false) {
  return { id: 'version-id', tenant_id: 'tenant-id', trade: 'electrical', pricing_book_id: 'book-id',
    content_hash: 'a'.repeat(64), snapshot: { id: 'book-id', tenant_id: 'tenant-id', trade: 'electrical', gst_registered: gst, quote_tier_mode: 'single' } }
}
beforeEach(() => {
  vi.clearAllMocks()
  h.render.mockReset().mockResolvedValue(Buffer.from('PDF'))
  h.upload.mockReset().mockResolvedValue({ error: null })
  h.download.mockReset().mockResolvedValue({ data: new Blob(['PDF']), error: null })
  for (const key of Object.keys(h.rows)) delete h.rows[key]
  for (const key of Object.keys(h.errors)) delete h.errors[key]
  h.reads.length = 0
  h.configured = true
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://www.quotemax.com.au')
  vi.stubEnv('FULL_QUOTE_DOC', 'false')
  h.rows.quotes = { id: 'quote-id', tenant_id: 'tenant-id', intake_id: 'intake-id', share_token: 'token',
    quote_kind: 'initial', good: null, better: tier(), best: null, total_inc_gst: 100.05, selected_tier: 'better',
    pricing_book_version_id: 'version-id', needs_inspection: false, status: 'sent',
    created_at: '2026-09-08T00:00:00Z', scope_of_works: 'Saved customer scope', report_doc: null,
    applied_discount_pct: 0, pdf_path: 'old.pdf', pdf_signature: 'old', optional_upsells: [] }
  h.rows.intakes = { id: 'intake-id', tenant_id: 'tenant-id', trade: 'electrical', job_type: 'power_points', caller: { name: 'Sam' }, scope: {} }
  h.rows.quote_pricing_versions = version()
  h.rows.pricing_book = { gst_registered: true, quote_tier_mode: 'single' }
})
afterEach(() => vi.unstubAllEnvs())
const request = (handler: typeof pdfGet) => handler(new Request('https://www.quotemax.com.au/api/q/token/pdf'), { params: Promise.resolve({ token: 'token' }) })
const pdfPath = (bytes: string) => `quotes/quote-id/${createHash('sha256').update(bytes).digest('hex')}.pdf`

describe('actual saved quote HTML/PDF pricing boundary', () => {
  it.each(['report_doc', 'report_style', 'parent_quote_id', 'inspection_reason', 'display_mode', 'estimated_timeframe'])('rejects a changed %s before cache reuse or rendering', async field => {
    await ensureQuotePdf('quote-id')
    const reviewed = quoteCustomerReleaseRevision(h.rows.quotes!)
    h.rows.quotes![field] = field === 'report_style' ? { fontFamily: 'serif' } : 'changed'
    await expect(ensureQuotePdf('quote-id', { expectedReleaseRevision: reviewed })).rejects.toMatchObject({ code: 'quote_review_required', status: 409 })
    expect(h.render).toHaveBeenCalledTimes(1)
    expect(h.upload).toHaveBeenCalledTimes(1)
  })
  it('accepts the exact release snapshot including non-default parent, display and inspection fields', async () => {
    Object.assign(h.rows.quotes!, { parent_quote_id: 'owned-parent', display_mode: 'summary', inspection_reason: 'saved explanation' })
    const expectedReleaseRevision = quoteCustomerReleaseRevision(h.rows.quotes!)
    expect(await ensureQuotePdf('quote-id', { expectedReleaseRevision })).toBe(pdfPath('PDF'))
    expect(h.render).toHaveBeenCalledTimes(1)
  })
  it('preserves a prepared document after a later edit and never overwrites its media key', async () => {
    const objects = new Map<string, Buffer>()
    h.upload.mockImplementation(async (path, bytes, options) => {
      expect(options.upsert).toBe(false)
      if (objects.has(path)) return { error: { message: 'Already exists' } }
      objects.set(path, Buffer.from(bytes))
      return { error: null }
    })
    h.download.mockImplementation(async path => ({
      data: objects.has(path) ? new Blob([new Uint8Array(objects.get(path)!)]) : null,
      error: objects.has(path) ? null : { message: 'Not found' },
    }))
    h.render.mockResolvedValueOnce(Buffer.from('Reviewed PDF')).mockResolvedValue(Buffer.from('Edited PDF'))
    const releasedMedia = await ensureQuotePdf('quote-id')
    Object.assign(h.rows.quotes!, { better: tier(200.05), total_inc_gst: 200.05 })
    const next = await ensureQuotePdf('quote-id')
    expect(releasedMedia).toBe(pdfPath('Reviewed PDF'))
    expect(next).toBe(pdfPath('Edited PDF'))
    expect(objects.get(releasedMedia!)?.toString()).toBe('Reviewed PDF')
    expect(objects.get(next!)?.toString()).toBe('Edited PDF')
    // A concurrent identical render may reuse only the verified identical bytes.
    expect(await ensureQuotePdf('quote-id', { regenerate: true })).toBe(next)
    expect(h.download).toHaveBeenCalledWith(next)
    expect(objects.size).toBe(2)
  })
  it('migrates a mutable legacy path even when its pricing/template signature matches', async () => {
    await ensureQuotePdf('quote-id')
    h.rows.quotes!.pdf_path = 'quotes/quote-id.pdf'
    expect(await ensureQuotePdf('quote-id')).toBe(pdfPath('PDF'))
    expect(h.render).toHaveBeenCalledTimes(2)
    expect(h.upload.mock.calls.every(([path]) => path !== 'quotes/quote-id.pdf')).toBe(true)
  })
  it('recovers an upload acknowledgement loss only after exact byte readback', async () => {
    h.upload.mockResolvedValue({ error: { message: 'Upload acknowledgement lost' } })
    expect(await ensureQuotePdf('quote-id')).toBe(pdfPath('PDF'))
    expect(h.download).toHaveBeenCalledWith(pdfPath('PDF'))
  })
  it.each(['different bytes', 'missing', 'read failure'])('retains the previous cache when immutable upload readback has %s', async state => {
    h.upload.mockResolvedValue({ error: { message: 'Upload acknowledgement lost' } })
    h.download.mockResolvedValue({ data: state === 'different bytes' ? new Blob(['wrong PDF']) : null,
      error: state === 'read failure' ? { message: 'Unavailable' } : null })
    const before = { path: h.rows.quotes!.pdf_path, signature: h.rows.quotes!.pdf_signature }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await ensureQuotePdf('quote-id')).toBeNull()
      expect(h.rows.quotes!.pdf_path).toBe(before.path)
      expect(h.rows.quotes!.pdf_signature).toBe(before.signature)
    } finally { log.mockRestore() }
  })
  it('applies saved appearance identically to HTML and regenerated PDF while preserving narrative and money', async () => {
    vi.stubEnv('FULL_QUOTE_DOC', 'true')
    Object.assign(h.rows.quotes!, {
      report_doc: { version: 1, blocks: [{ type: 'heading', content: [{ text: 'Customer scope' }] }, { type: 'paragraph', content: [{ text: 'Reviewed work', marks: ['bold'] }] }, { type: 'pricing' }] },
      report_style: { fontFamily: 'serif', accentColor: '#2563EB', headingStyle: 'bar' },
    })
    const html = await renderQuoteReportHtml('quote-id')
    expect(html).toContain('body{font-family:Georgia,')
    expect(html).toContain('--accent:#2563EB;')
    expect(html).toContain('h2{border:0;background:var(--accent);')
    expect(html).toContain('<strong>Reviewed work</strong>')
    expect(html).toContain('$100.05')
    expect(html).toContain('No GST')
    await ensureQuotePdf('quote-id')
    expect(h.render).toHaveBeenLastCalledWith(html)
    const firstSignature = h.rows.quotes!.pdf_signature
    await ensureQuotePdf('quote-id')
    expect(h.render).toHaveBeenCalledTimes(1)
    h.rows.quotes!.report_style = { fontFamily: 'mono', accentColor: '#16A34A', headingStyle: 'underline' }
    const changed = await renderQuoteReportHtml('quote-id')
    expect(changed).toContain("body{font-family:'JetBrains Mono',")
    await ensureQuotePdf('quote-id')
    expect(h.render).toHaveBeenLastCalledWith(changed)
    expect(h.rows.quotes!.pdf_signature).not.toBe(firstSignature)
    h.rows.quotes!.report_style = null
    const reset = await renderQuoteReportHtml('quote-id')
    expect(reset).not.toContain('Saved quote appearance')
    expect(reset).toContain('<strong>Reviewed work</strong>')
    await ensureQuotePdf('quote-id')
    expect(h.render).toHaveBeenLastCalledWith(reset)
  })
  it('leaves the rollout-disabled report unchanged by saved document and appearance', async () => {
    const original = await renderQuoteReportHtml('quote-id')
    h.rows.quotes!.report_style = { fontFamily: 'mono', accentColor: '#9333EA', headingStyle: 'bar' }
    h.rows.quotes!.report_doc = { version: 1, blocks: [{ type: 'heading', content: [{ text: 'Inactive narrative' }] }, { type: 'pricing' }] }
    expect(await renderQuoteReportHtml('quote-id')).toBe(original)
  })
  it('applies style-only changes to the dedicated EV report without replacing its template', async () => {
    vi.stubEnv('FULL_QUOTE_DOC', 'true')
    h.rows.intakes!.job_type = 'ev_charger'
    h.rows.quotes!.report_style = { fontFamily: 'serif', accentColor: '#0F1722', headingStyle: 'bar' }
    const html = await renderQuoteReportHtml('quote-id')
    expect(html).toContain('Prepared For:')
    expect(html).toContain('Terms &amp; Conditions')
    expect(html).toContain('body{font-family:Georgia,')
    expect(html).toContain('--accent:#0F1722;--accent-ink:#FFFFFF;')
    expect(html).toContain('.ev-body .ev-secthead h2{color:var(--accent-ink);}')
    expect(html).toContain('$100.05')
    expect(html).not.toContain('Quotation</div>')
    await ensureQuotePdf('quote-id')
    expect(h.render).toHaveBeenLastCalledWith(html)
  })
  it('keeps saved non-GST cents when the current book flips tax or disappears', async () => {
    const first = await renderQuoteReportHtml('quote-id')
    expect(first).toContain('$100.05')
    expect(first).toContain('No GST is charged')
    expect(first).not.toContain('include 10% GST')
    h.rows.pricing_book = null
    h.errors.pricing_book = { message: 'unavailable current card' }
    expect(await renderQuoteReportHtml('quote-id')).toBe(first)
    expect(await ensureQuotePdf('quote-id')).toBe(pdfPath('PDF'))
    expect(h.render).toHaveBeenCalledWith(first)
    expect(h.reads.find(r => r.table === 'intakes')?.filters).toMatchObject({ id: 'intake-id', tenant_id: 'tenant-id' })
    expect(h.reads.find(r => r.table === 'quote_pricing_versions')?.filters).toEqual({ id: 'version-id', tenant_id: 'tenant-id', trade: 'electrical' })
    expect(h.reads.filter(r => r.table === 'quotes')[0].fields).toContain('pricing_book_version_id')
    expect(h.reads.filter(r => r.table === 'quotes')[0].fields).toContain('total_inc_gst')
  })
  it('renders true GST using cent precision instead of whole-dollar rounding', async () => {
    h.rows.quote_pricing_versions = version(true)
    h.rows.quotes!.total_inc_gst = 110.06
    h.rows.pricing_book!.gst_registered = false
    expect(await renderQuoteReportHtml('quote-id')).toContain('$110.06')
  })
  it('passes tax, discount and final-kind through a stored narrative pricing marker', async () => {
    vi.stubEnv('FULL_QUOTE_DOC', 'true')
    Object.assign(h.rows.quotes!, { quote_kind: 'final', deposit_pct: 12.5, applied_discount_pct: 5,
      report_doc: { version: 1, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Approved narrative' }] }, { type: 'pricing' }] } })
    const html = await renderQuoteReportHtml('quote-id')
    expect(html).toContain('Approved narrative')
    expect(html).toContain('$95.05')
    expect(html).toContain('FINAL QUOTE')
    expect(html).toContain('No GST')
    // Final-chain policy rounds the validated percentage in the shared money
    // helpers. Its disclaimer must describe that same effective percentage.
    expect(html).toContain('Deposit 13%')
  })
  it('can prove legacy tax from the exact saved amounts without a current book', async () => {
    h.rows.quotes!.pricing_book_version_id = null
    h.rows.pricing_book = null
    expect(await renderQuoteReportHtml('quote-id')).toContain('No GST')
  })
  it.each(['missing', 'foreign tenant', 'foreign trade', 'inconsistent totals', 'unknown trade', 'foreign intake', 'orphan'])('rejects %s history before rendering or storage', async problem => {
    if (problem === 'missing') h.rows.quote_pricing_versions = null
    if (problem === 'foreign tenant') h.rows.quote_pricing_versions!.tenant_id = 'other'
    if (problem === 'foreign trade') h.rows.quote_pricing_versions!.trade = 'plumbing'
    if (problem === 'inconsistent totals') h.rows.quotes!.total_inc_gst = 110.06
    if (problem === 'unknown trade') h.rows.intakes!.trade = null
    if (problem === 'foreign intake') h.rows.intakes!.tenant_id = 'other'
    if (problem === 'orphan') h.rows.quotes!.tenant_id = null
    expect((await request(htmlGet)).status).toBe(409)
    expect((await request(pdfGet)).status).toBe(409)
    expect(h.render).not.toHaveBeenCalled()
    expect(h.upload).not.toHaveBeenCalled()
    expect(h.download).not.toHaveBeenCalled()
  })
  it.each([null, '', ' ', true, 'NaN'])('does not turn missing stored line money %j into zero', async value => {
    const saved = h.rows.quotes!.better as ReturnType<typeof tier>
    ;(saved.line_items[0] as Record<string, unknown>).unit_price_ex_gst = value
    expect((await request(pdfGet)).status).toBe(409)
    expect(h.render).not.toHaveBeenCalled()
  })
  it('rejects ambiguous legacy zero but accepts explicitly versioned zero', async () => {
    Object.assign(h.rows.quotes!, { better: tier(0), total_inc_gst: 0, pricing_book_version_id: null })
    expect((await request(pdfGet)).status).toBe(409)
    h.rows.quotes!.pricing_book_version_id = 'version-id'
    expect((await request(pdfGet)).status).toBe(200)
  })
  it.each(['quotes', 'intakes', 'quote_pricing_versions'])('returns retryable errors for %s read failures without old-PDF fallback', async table => {
    h.errors[table] = { message: 'database unavailable' }
    expect((await request(pdfGet)).status).toBe(503)
    expect((await request(htmlGet)).status).toBe(503)
    expect(h.download).not.toHaveBeenCalled()
  })
  it('serves a verified matching cache while renderer is offline, but never a stale cache', async () => {
    expect((await request(pdfGet)).status).toBe(200)
    h.configured = false
    expect((await request(pdfGet)).status).toBe(200)
    expect(h.render).toHaveBeenCalledTimes(1)
    Object.assign(h.rows.quotes!, { better: tier(200.05), total_inc_gst: 200.05 })
    expect((await request(pdfGet)).status).toBe(503)
    expect(h.download).toHaveBeenCalledTimes(2)
  })
  it('validates history even when a matching PDF has already been cached', async () => {
    expect((await request(pdfGet)).status).toBe(200)
    h.rows.quote_pricing_versions = null
    expect((await request(pdfGet)).status).toBe(409)
    expect(h.download).toHaveBeenCalledTimes(1)
  })
})
