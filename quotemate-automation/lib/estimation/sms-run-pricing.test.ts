import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(), extract: vi.fn(), report: vi.fn(), results: vi.fn(), dispatch: vi.fn(), handoff: vi.fn(), enqueue: vi.fn(), sign: vi.fn(),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mocks.from }) }))
vi.mock('./extract', () => ({ runExtraction: mocks.extract }))
vi.mock('./report-html', () => ({ buildPlanReportHtml: mocks.report }))
vi.mock('@/lib/pdf/branding', () => ({ loadTenantBranding: async () => ({ businessName: 'Test Electrical' }) }))
vi.mock('./plan-request', () => ({ buildPlanResultsSms: mocks.results, buildPlanFailureSms: () => 'retry upload' }))
vi.mock('@/lib/sms/plan-estimation', () => ({
  planUploadUrl: () => 'https://example.test/upload',
  planResultsUrl: () => 'https://example.test/results',
  planReportPdfUrl: () => 'https://example.test/report.pdf',
}))
vi.mock('@/lib/storage/plan-pdf', () => ({
  downloadPlanPdf: async () => Buffer.from('fixture'),
  uploadPlanPdf: async () => 'report-path', signPlanPdfUrl: mocks.sign,
}))
vi.mock('@/lib/pdf/gotenberg', () => ({
  gotenbergConfigured: () => true, renderPdfFromHtml: async () => Buffer.from('report fixture'),
}))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: mocks.dispatch }))
// Delivery owns its separate outbox lifecycle; this suite verifies pricing
// through the real pipeline without enqueuing or sending an external message.
vi.mock('@/lib/sms/durable-outbox', () => ({ enqueueOutbound: mocks.enqueue }))
vi.mock('@/lib/sms/human-handoff', () => ({ persistHumanHandoff: mocks.handoff }))
import { runSmsPlanAnalysis } from './sms-run'

const BOOK = { id: 'book-a', tenant_id: 'tenant-a', trade: 'electrical', hourly_rate: 100,
  default_markup_pct: 0, min_labour_hours: 0, gst_registered: false }
const ASSEMBLY = { id: 'assembly-a', tenant_id: 'tenant-a', trade: 'electrical', enabled: true,
  name: 'LED downlight', default_unit_price_ex_gst: 20, default_labour_hours: 0.5 }
let book: unknown
let priceWriteFails: boolean
let savedExtraction: Record<string,unknown>|null
let writes: Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }>

function query(table: string) {
  let patch: Record<string, unknown> | undefined
  const filters: Array<[string, unknown]> = []
  const result = () => {
    if (table === 'pricing_book') return { data: book, error: null }
    if (table === 'tenant_custom_assemblies') return { data: [ASSEMBLY], error: null }
    if (table === 'plan_upload_requests') return { data: { id: 'request-a', token: 'token-a', tenant_id: 'tenant-a',
      customer_phone: '+61400000000', twilio_number: '+61400000001', sms_conversation_id: null,
      status: 'analysing', plan_upload_id: 'upload-a' }, error: null }
    if (table === 'plan_uploads') return { data: { id: 'upload-a', filename: 'plan.pdf', pdf_path: 'fixture-path' }, error: null }
    if (table === 'tenants') return { data: { business_name: 'Test Electrical' }, error: null }
    if (table === 'plan_extractions') return patch?.priced_bom && priceWriteFails
      ? { data: null, error: { message: 'write failed' } }
      : { data: savedExtraction, error: null }
    return { data: null, error: null }
  }
  const builder = {
    select: () => builder, limit: () => builder,
    eq: (key: string, value: unknown) => { filters.push([key, value]); return builder },
    insert: () => builder,
    upsert: (value:Record<string,unknown>) => { savedExtraction={id:'run-a',...value};return builder },
    update: (value: Record<string, unknown>) => { patch = value; writes.push({ table, patch, filters }); return builder },
    single: async () => result(), maybeSingle: async () => result(),
    then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
  }
  return builder
}

beforeEach(() => {
  vi.clearAllMocks()
  book = { ...BOOK }; writes = []; priceWriteFails = false
  savedExtraction=null
  mocks.from.mockImplementation(query)
  mocks.extract.mockResolvedValue({ parsed: { items: [{ type: 'LED downlight', count: 2 }], sheets_used: [], overall_note: '' }, model: 'fixture', runtimeSeconds: 1 })
  mocks.report.mockReturnValue('fixture HTML')
  mocks.results.mockReturnValue('fixture results')
  mocks.dispatch.mockResolvedValue({ ok: true, channel: 'sms', sid: 'fixture-sid' })
  mocks.handoff.mockResolvedValue({ id: 'review-task-a', notified: false })
  mocks.enqueue.mockResolvedValue({ id: 'outbox-a' })
})

function expectApprovalHold() {
  expect(mocks.results).not.toHaveBeenCalled()
  expect(mocks.sign).not.toHaveBeenCalled()
  expect(mocks.handoff).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: 'tenant-a', resourceType: 'plan', resourceId: 'run-a', requestKey: 'plan:run-a:review',
  }))
  expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
    text: expect.stringContaining('awaiting approval'), to: '+61400000000', from: '+61400000001', tenantId: 'tenant-a',
  }))
  for (const message of [mocks.enqueue.mock.calls[0][0], mocks.dispatch.mock.calls[0][0]]) {
    expect(message.mediaUrl).toBeUndefined()
    expect(message.text).not.toMatch(/\$|report\.pdf|signed|\b140\b|\b154\b/)
  }
  expect(mocks.handoff.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0])
}

describe('SMS estimator uses the same owned pricing boundary', () => {
  it.each([null, { ...BOOK, gst_registered: null }])('keeps counts-only result when tenant pricing is unavailable %j', async (value) => {
    book = value
    await runSmsPlanAnalysis('request-a')
    expect(writes.some((write) => write.patch.priced_bom)).toBe(false)
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ bom: null }))
    expectApprovalHold()
    expect(writes).toContainEqual(expect.objectContaining({ table: 'plan_upload_requests', patch: expect.objectContaining({ status: 'complete', plan_extraction_id: 'run-a' }) }))
  })

  it('does not send partial owned-line subtotal when other items are unmatched', async () => {
    mocks.extract.mockResolvedValue({ parsed: { items: [{ type: 'LED downlight', count: 2 }, { type: 'Ceiling fan', count: 1 }], sheets_used: [] }, model: 'fixture', runtimeSeconds: 1 })
    await runSmsPlanAnalysis('request-a')
    expect(writes.some((write) => write.patch.priced_bom)).toBe(false)
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ bom: null }))
    expectApprovalHold()
  })

  it.each([false, true])('persists the GST=%s owned proof for tradie review without publishing money', async (gst) => {
    book = { ...BOOK, gst_registered: gst }
    await runSmsPlanAnalysis('request-a')
    const write = writes.find((entry) => entry.patch.priced_bom)
    expect(write?.patch.priced_bom).toMatchObject({ subtotalExGst: 140, totalIncGst: gst ? 154 : 140,
      pricingAuthority: { tenant_id: 'tenant-a', pricing_book_id: 'book-a', source: 'tenant_pricing_book' } })
    expect(write?.filters).toEqual([['id', 'run-a'], ['tenant_id', 'tenant-a'], ['trade', 'electrical']])
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ bom: write?.patch.priced_bom }))
    expectApprovalHold()
  })

  it.each([
    { items: [], minimumHours: 0 },
    { items: [{ type: 'LED downlight', count: 0 }], minimumHours: 0 },
    { items: [], minimumHours: 2 },
    { items: [{ type: 'LED downlight', count: 0 }], minimumHours: 2 },
  ])('keeps empty/zero-count extraction counts-only with minimum $minimumHours', async ({ items, minimumHours }) => {
    book = { ...BOOK, min_labour_hours: minimumHours }
    mocks.extract.mockResolvedValue({ parsed: { items, sheets_used: [] }, model: 'fixture', runtimeSeconds: 1 })
    await runSmsPlanAnalysis('request-a')
    expect(writes.some((write) => write.patch.priced_bom)).toBe(false)
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ bom: null }))
    expectApprovalHold()
  })

  it('falls back to counts only after failed persistence instead of sending unsaved prices', async () => {
    priceWriteFails = true
    await runSmsPlanAnalysis('request-a')
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ bom: null }))
    expectApprovalHold()
  })

  it('does not promise a review or complete the request when saving the review task fails', async () => {
    mocks.handoff.mockRejectedValueOnce(new Error('Could not persist review task'))
    await expect(runSmsPlanAnalysis('request-a')).rejects.toThrow('Could not persist review task')
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(writes.some(write => write.patch.status === 'complete')).toBe(false)
  })

  it('does not mark complete if the durable customer notification cannot be saved', async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error('Outbox unavailable'))
    await expect(runSmsPlanAnalysis('request-a')).rejects.toThrow('Outbox unavailable')
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(writes.some(write => write.patch.status === 'complete')).toBe(false)
  })
})
