import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the real handlers, renderer service, saved-price validation and release
// snapshot code together. Only database/provider I/O is replaced here.
const h = vi.hoisted(() => {
  type Row = Record<string, unknown>
  const rows: Record<string, Row | null> = {}
  const state: { rendererRow: Row | null; quoteReads: number } = { rendererRow: null, quoteReads: 0 }
  const rpc = vi.fn(async (_name: string, args: Row): Promise<{ data: Row; error: null }> => ({
    data: { approved: true, outbound: args.p_outbound ?? null, outbox_id: 'outbox-id' }, error: null,
  }))
  const render = vi.fn<(html: string) => Promise<Buffer>>(async () => Buffer.from('reviewed PDF bytes'))
  const upload = vi.fn<(path: string, data: Buffer, options: unknown) => Promise<{ error: null }>>(async () => ({ error: null }))
  const download = vi.fn<(path: string) => Promise<{ data: Blob; error: null }>>(async () => ({ data: new Blob(['reviewed PDF bytes']), error: null }))
  const client = { rpc, storage: { from: () => ({ upload, download }) }, from: (table: string) => {
    let fields = '*'; let patch: Row | null = null; let insert = false
    const filters: Row = {}
    const read = () => {
      // A -> B -> A: only the separate renderer SELECT observes B. The stored
      // row is already back at A by the time a release CAS could execute.
      const row = table === 'quotes' && ++state.quoteReads === 2 && state.rendererRow
        ? state.rendererRow : rows[table]
      const owned = row && Object.entries(filters).every(([key, value]) => row[key] === value)
      const selected = owned ? (fields === '*' ? row : Object.fromEntries(fields.split(',').map(key => [key.trim(), row[key.trim()]]))) : null
      return { data: selected ? structuredClone(selected) : null, error: null }
    }
    const query = {
      select: (value: string) => { fields = value; return query },
      eq: (key: string, value: unknown) => { filters[key] = value; return query },
      is: () => query, order: () => query, limit: () => query, in: () => query,
      update: (value: Row) => { patch = value; return query },
      insert: () => { insert = true; return query },
      maybeSingle: async () => read(),
      then: (resolve: (value: unknown) => unknown) => {
        if (patch) Object.assign(rows[table]!, patch)
        return Promise.resolve(patch || insert ? { data: [], error: null } : read()).then(resolve)
      },
    }
    return query
  } }
  return { rows, state, rpc, client, render, upload, download }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => ({
  identity: { userId: 'owner-id', email: 'owner@example.com' },
  tenant: { id: 'tenant-id', business_name: 'Owned Trade', twilio_sms_number: '+61400000000' },
}) }))
vi.mock('@/lib/quote/job-quote-operation', () => ({ readQuoteDraftReadiness: async () => ({ ready: true }) }))
vi.mock('@/lib/sms/quote-origin-conversation', () => ({ resolveQuoteOriginConversation: vi.fn(async () => null) }))
vi.mock('@/lib/sms/send-quote-pdf', () => ({
  dispatchQuoteWithPdf: vi.fn(async () => ({ ok: true, channel: 'sms', sid: 'SM-test' })),
  exceedsMmsMediaCap: () => false, MMS_MEDIA_CAP_BYTES: 5_000_000,
}))
vi.mock('@/lib/pdf/gotenberg', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/pdf/gotenberg')>(),
  gotenbergConfigured: () => true, renderPdfFromHtml: h.render,
}))
vi.mock('@/lib/pdf/branding', async () => {
  const { brandingFromName } = await import('@/lib/pdf/report-chrome')
  return { loadTenantBranding: async () => brandingFromName('Owned Trade') }
})
vi.mock('@/lib/pdf/image', () => ({ prepareImage: vi.fn(async () => null) }))
vi.mock('@/lib/storage/upload', () => ({ refreshSignedUrl: vi.fn() }))
vi.mock('@/lib/quote/lifecycle', () => ({ advanceQuoteStatus: vi.fn() }))
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: 'email-test' })) }))

import { POST as approve } from '@/app/api/quote/[id]/approve/route'
import { POST as send } from '@/app/api/quote/[id]/send/route'
import { quoteCustomerReleaseRevision } from './customer-release'
import { dispatchQuoteWithPdf } from '@/lib/sms/send-quote-pdf'
import { sendEmail } from '@/lib/email/resend'

const quoteId = '11111111-1111-4111-8111-111111111111'
const params = { params: Promise.resolve({ id: quoteId }) }
beforeEach(() => {
  vi.clearAllMocks()
  h.state.quoteReads = 0; h.state.rendererRow = null
  h.rpc.mockReset().mockImplementation(async (_name, args) => ({ data: {
    approved: true, outbound: args.p_outbound ?? null, outbox_id: 'outbox-id',
  }, error: null }))
  for (const key of Object.keys(h.rows)) delete h.rows[key]
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://www.quotemax.com.au')
  vi.stubEnv('FULL_QUOTE_DOC', 'true'); vi.stubEnv('SMS_QUOTE_PDF_MMS', '0')
  h.rows.quotes = { id: quoteId, tenant_id: 'tenant-id', intake_id: 'intake-id',
    status: 'awaiting_tradie_approval', share_token: 'owned-token', quote_kind: 'initial',
    selected_tier: 'good', good: { label: 'Owned work', subtotal_ex_gst: 100.05, line_items: [] },
    better: null, best: null, total_inc_gst: 100.05, applied_discount_pct: 0,
    pricing_book_version_id: 'version-id', deposit_pct: 30, needs_inspection: false, paid_at: null,
    stripe_links: { good: 'stored-link' }, scope_of_works: 'Reviewed scope',
    created_at: '2026-09-08T00:00:00Z', report_doc: null, report_style: null }
  h.rows.intakes = { id: 'intake-id', tenant_id: 'tenant-id', trade: 'roofing', job_type: 'roof_repair',
    caller: { name: 'Sam', phone: '+61411222333', email: 'sam@example.com' } }
  h.rows.pricing_book = { tenant_id: 'tenant-id', trade: 'roofing', gst_registered: true, quote_tier_mode: 'good_better_best' }
  h.rows.quote_pricing_versions = { id: 'version-id', tenant_id: 'tenant-id', trade: 'roofing', pricing_book_id: 'book-id',
    content_hash: 'a'.repeat(64), snapshot: { id: 'book-id', tenant_id: 'tenant-id', trade: 'roofing', gst_registered: false, quote_tier_mode: 'single' } }
})
afterEach(() => vi.unstubAllEnvs())

describe.each([
  { name: 'approve SMS', handler: approve, channel: 'sms' },
  { name: 'send SMS', handler: send, channel: 'sms' },
  { name: 'send email', handler: send, channel: 'email' },
])('$name actual PDF release binding', ({ handler, channel }) => {
  const request = () => new Request('https://www.quotemax.com.au/api/quote/test/send', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      channel, expected_revision: quoteCustomerReleaseRevision(h.rows.quotes!),
      expected_recipient: channel === 'sms' ? '+61411222333' : 'sam@example.com',
    }),
  })
  it.each([
    ['scope', { scope_of_works: 'Unreviewed transient scope' }],
    ['style', { report_style: { fontFamily: 'serif', accentColor: '#2563EB', headingStyle: 'bar' } }],
    ['narrative', { report_doc: { version: 1, blocks: [{ type: 'paragraph', content: [{ text: 'Unreviewed transient narrative' }] }, { type: 'pricing' }] } }],
    ['priced total', { good: { label: 'Changed work', subtotal_ex_gst: 200.05, line_items: [] }, total_inc_gst: 200.05 }],
    ['parent', { parent_quote_id: '22222222-2222-4222-8222-222222222222' }],
  ])('rejects A -> B(%s render) -> A before PDF/provider/release work', async (_name, patch) => {
    const reviewedRevision = quoteCustomerReleaseRevision(h.rows.quotes!)
    h.state.rendererRow = { ...structuredClone(h.rows.quotes!), ...patch }
    const response = await handler(request(), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'quote_review_required' })
    expect(h.state.quoteReads).toBe(2)
    expect(quoteCustomerReleaseRevision(h.rows.quotes!)).toBe(reviewedRevision)
    expect(h.render).not.toHaveBeenCalled(); expect(h.upload).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
    expect(dispatchQuoteWithPdf).not.toHaveBeenCalled(); expect(sendEmail).not.toHaveBeenCalled()
  })
  it('renders and releases the same reviewed snapshot with immutable PDF bytes', async () => {
    const response = await handler(request(), params)
    expect(response.status).toBe(200)
    expect(h.render).toHaveBeenCalledOnce()
    expect(h.render.mock.calls[0][0]).toContain('Reviewed scope')
    expect(h.upload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^quotes/${quoteId}/[a-f0-9]{64}\\.pdf$`)),
      Buffer.from('reviewed PDF bytes'), { contentType: 'application/pdf', upsert: false })
    expect(h.rpc).toHaveBeenCalledOnce()
    if (channel === 'sms') expect(dispatchQuoteWithPdf).toHaveBeenCalledWith(expect.objectContaining({ pdfPath: h.upload.mock.calls[0][0] }))
    else expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ attachments: [expect.objectContaining({ content: Buffer.from('reviewed PDF bytes').toString('base64') })] }))
  })
})

it.each([{ name: 'approve', handler: approve }, { name: 'send', handler: send }])('$name replay keeps the media key already retained by the outbox', async ({ handler }) => {
  const retainedPath = `quotes/${quoteId}/${'b'.repeat(64)}.pdf`
  h.rpc.mockImplementation(async (_name, args) => ({ data: { approved: true, outbox_id: 'retained-outbox',
    outbound: { ...(args.p_outbound as Record<string, unknown>), mediaKey: retainedPath },
  }, error: null }))
  const response = await handler(new Request('https://www.quotemax.com.au/api/quote/test/send', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'sms',
      expected_revision: quoteCustomerReleaseRevision(h.rows.quotes!), expected_recipient: '+61411222333' }),
  }), params)
  expect(response.status).toBe(200)
  expect(h.upload.mock.calls[0][0]).not.toBe(retainedPath)
  expect(dispatchQuoteWithPdf).toHaveBeenCalledWith(expect.objectContaining({ mediaKey: retainedPath, pdfPath: retainedPath }))
})
