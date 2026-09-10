import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>
  const rows: Record<string, Row | null> = {}
  const errors: Record<string, unknown> = {}
  const reads: { table: string; fields: string; filters: Row }[] = []
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown> | null; error: unknown }> => ({
    data: { approved: true, outbound: args.p_outbound ?? null, outbox_id: 'outbox-id' }, error: null,
  }))
  const client = { rpc, from: (table: string) => {
    const read = { table, fields: '', filters: {} as Row }; reads.push(read)
    let write = false
    const result = () => {
      const row = rows[table]
      const owned = row && Object.entries(read.filters).every(([key, value]) => row[key] === value)
      return { data: write ? [] : owned ? Object.fromEntries(read.fields.split(',').map(key => [key.trim(), row[key.trim()]])) : null,
        error: errors[table] ?? null }
    }
    const q = {
      select: (fields: string) => { read.fields = fields; return q },
      eq: (key: string, value: unknown) => { read.filters[key] = value; return q },
      is: () => q, order: () => q, limit: () => q,
      update: () => { write = true; return q }, insert: () => { write = true; return q },
      maybeSingle: async () => {
        const value = result()
        if (read.fields === '*' && value.data) value.data = rows[table]!
        return value
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    }; return q
  } }
  return { rows, errors, reads, rpc, client, tenantId: 'tenant-id' }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => ({
  identity: { userId: 'owner-id', email: 'owner@example.com' },
  tenant: { id: h.tenantId, business_name: 'Owned Trade', twilio_sms_number: '+61400000000' },
}) }))
vi.mock('@/lib/quote/job-quote-operation', () => ({ readQuoteDraftReadiness: async () => ({ ready: true }) }))
vi.mock('@/lib/sms/quote-origin-conversation', () => ({ resolveQuoteOriginConversation: vi.fn(async () => null) }))
vi.mock('@/lib/sms/send-quote-pdf', () => ({ dispatchQuoteWithPdf: vi.fn(async () => ({ ok: true, channel: 'sms', sid: 'SM-test' })) }))
vi.mock('@/lib/quote/pdf', () => ({ ensureQuotePdf: vi.fn(async () => null), signQuotePdfUrl: vi.fn(), downloadQuotePdf: vi.fn() }))
vi.mock('@/lib/quote/lifecycle', () => ({ advanceQuoteStatus: vi.fn() }))
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: 'email-test' })) }))

import { POST as approve } from '@/app/api/quote/[id]/approve/route'
import { POST as send } from '@/app/api/quote/[id]/send/route'
import { quoteCustomerReleaseRevision } from './customer-release'
import { QuotePricingVersionError } from './pricing-version'
import { dispatchQuoteWithPdf } from '@/lib/sms/send-quote-pdf'
import { ensureQuotePdf } from './pdf'
import { sendEmail } from '@/lib/email/resend'
import { resolveQuoteOriginConversation } from '@/lib/sms/quote-origin-conversation'

const quoteId = '11111111-1111-4111-8111-111111111111'
const params = { params: Promise.resolve({ id: quoteId }) }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureQuotePdf).mockReset().mockResolvedValue(null)
  h.tenantId = 'tenant-id'
  h.rpc.mockReset().mockImplementation(async (_name, args) => ({ data: { approved: true,
    outbound: args.p_outbound ?? null, outbox_id: 'outbox-id' }, error: null }))
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://www.quotemax.com.au')
  h.reads.length = 0
  for (const key of Object.keys(h.rows)) delete h.rows[key]
  for (const key of Object.keys(h.errors)) delete h.errors[key]
  h.rows.quotes = { id: quoteId, tenant_id: 'tenant-id', intake_id: 'intake-id',
    status: 'awaiting_tradie_approval', share_token: 'owned-token', quote_kind: 'initial',
    selected_tier: 'good', good: { label: 'Owned work', subtotal_ex_gst: 100.05, line_items: [] },
    better: null, best: null, total_inc_gst: 100.05, applied_discount_pct: 0,
    pricing_book_version_id: 'version-id', deposit_pct: 30, needs_inspection: false, paid_at: null,
    stripe_links: { good: 'stored-link' }, scope_of_works: 'Reviewed scope',
    report_doc: { version: 1, sections: [{ type: 'paragraph', text: 'Reviewed customer narrative' }] },
    report_style: { accentColor: '#112233' } }
  h.rows.intakes = { id: 'intake-id', tenant_id: 'tenant-id', trade: 'roofing', job_type: 'roof_repair',
    caller: { name: 'Sam', phone: '+61411222333', email: 'sam@example.com' } }
  h.rows.pricing_book = { tenant_id: 'tenant-id', trade: 'roofing', gst_registered: true, quote_tier_mode: 'good_better_best' }
  h.rows.quote_pricing_versions = { id: 'version-id', tenant_id: 'tenant-id', trade: 'roofing', pricing_book_id: 'book-id',
    content_hash: 'a'.repeat(64), snapshot: { id: 'book-id', tenant_id: 'tenant-id', trade: 'roofing', gst_registered: false, quote_tier_mode: 'single' } }
})
function request(channel: 'sms' | 'email', proof: unknown, extra: Record<string, unknown> = {}) {
  return new Request('https://www.quotemax.com.au/api/quote/test/send', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel,
      expected_revision: quoteCustomerReleaseRevision(h.rows.quotes!), expected_recipient: proof, ...extra }) })
}
function noDispatch() {
  expect(h.rpc).not.toHaveBeenCalled()
  expect(dispatchQuoteWithPdf).not.toHaveBeenCalled()
  expect(sendEmail).not.toHaveBeenCalled()
  expect(ensureQuotePdf).not.toHaveBeenCalled()
}

describe.each([{ name: 'approve SMS', handler: approve, channel: 'sms' as const, proof: '+61411222333' },
  { name: 'send SMS', handler: send, channel: 'sms' as const, proof: '+61411222333' },
  { name: 'send email', handler: send, channel: 'email' as const, proof: 'sam@example.com' }])('$name authority boundary', ({ handler, channel, proof }) => {
  it('rejects changed recipient before render, release, origin attachment or provider work', async () => {
    const res = await handler(request(channel, channel === 'sms' ? '+61411222334' : 'other@example.com'), params)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'quote_recipient_changed' })
    noDispatch(); expect(resolveQuoteOriginConversation).not.toHaveBeenCalled()
  })
  it.each([null, '', ' '])('rejects invalid supplied recipient proof %j', async invalid => {
    const res = await handler(request(channel, invalid), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_expected_recipient' })
    noDispatch()
  })
  it.each(['error', 'missing', 'foreign'])('fails closed on %s intake', async kind => {
    if (kind === 'error') h.errors.intakes = { code: 'XX000' }
    if (kind === 'missing') h.rows.intakes = null
    if (kind === 'foreign') h.rows.intakes!.tenant_id = 'other'
    const res = await handler(request(channel, proof), params)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'quote_contact_unavailable' })
    noDispatch()
  })
  it('does not choose a lower-priority contact after a failed SMS lookup', async () => {
    h.rows.intakes!.caller = { name: 'Sam', email: 'sam@example.com' }
    h.rows.intakes!.customer_id = 'customer-id'
    h.errors.sms_conversations = { code: 'XX000' }
    h.rows.customers = { id: 'customer-id', tenant_id: 'tenant-id', phone_number: '+61411222333' }
    const res = await handler(request(channel, proof), params)
    expect(res.status).toBe(503); noDispatch()
    expect(h.reads.some(read => read.table === 'customers')).toBe(false)
  })
  it.each(['missing version', 'foreign version', 'invalid amount', 'missing deposit'])('rejects %s saved price before any release', async kind => {
    if (kind === 'missing version') h.rows.quote_pricing_versions = null
    if (kind === 'foreign version') h.rows.quote_pricing_versions!.tenant_id = 'other'
    if (kind === 'invalid amount') h.rows.quotes!.total_inc_gst = 123
    if (kind === 'missing deposit') h.rows.quotes!.deposit_pct = null
    const res = await handler(request(channel, proof), params)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'quote_pricing_review_required' }); noDispatch()
  })
  it('keeps a failed historical price read unavailable', async () => {
    h.errors.quote_pricing_versions = { code: 'XX000' }
    const res = await handler(request(channel, proof), params)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'pricing_unavailable' }); noDispatch()
  })
  it('uses saved GST and the exact reviewed destination when today\'s book is gone', async () => {
    h.rows.pricing_book = null
    const res = await handler(request(channel, proof), params)
    expect(res.status).toBe(200)
    expect(ensureQuotePdf).toHaveBeenCalledWith(quoteId, expect.objectContaining({
      expectedReleaseRevision: quoteCustomerReleaseRevision(h.rows.quotes!), strictPricing: true,
    }))
    expect(h.reads.find(read => read.table === 'intakes')?.filters).toEqual({ id: 'intake-id', tenant_id: 'tenant-id' })
    expect(h.reads.find(read => read.table === 'quotes')?.fields).toContain('pricing_book_version_id')
    if (channel === 'sms') {
      const outgoing = vi.mocked(dispatchQuoteWithPdf).mock.calls[0][0]
      expect(outgoing.to).toBe(proof)
      expect(outgoing.text).toContain('No GST')
      expect(outgoing.text).toContain('$100.05')
      expect(outgoing.text).toContain('$30.02')
      expect(outgoing.text).not.toContain('inc 10% GST')
    } else expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: proof }))
  })
  it('blocks a pricing validation error from the later PDF read before releasing', async () => {
    vi.mocked(ensureQuotePdf).mockRejectedValueOnce(new QuotePricingVersionError('quote_pricing_review_required'))
    const res = await handler(request(channel, proof), params)
    expect(res.status).toBe(409)
    expect(h.rpc).not.toHaveBeenCalled(); expect(dispatchQuoteWithPdf).not.toHaveBeenCalled(); expect(sendEmail).not.toHaveBeenCalled()
  })
})
describe('send compatibility and monetary text', () => {
  it('retains omitted expected-recipient compatibility for existing web callers', async () => {
    expect((await send(request('sms', undefined), params)).status).toBe(200)
  })
  it('compares a deliberate override against that exact destination without attaching another customer conversation', async () => {
    expect((await send(request('sms', '0411 222 334', { to: '0411222334' }), params)).status).toBe(200)
    expect(dispatchQuoteWithPdf).toHaveBeenCalledWith(expect.objectContaining({ to: '+61411222334' }))
    expect(resolveQuoteOriginConversation).not.toHaveBeenCalled()
  })
  it('keeps a genuine inspection quote at the fixed fee without inventing tier tax evidence', async () => {
    Object.assign(h.rows.quotes!, { good: null, needs_inspection: true, total_inc_gst: 99, pricing_book_version_id: null })
    expect((await approve(request('sms', '+61411222333'), params)).status).toBe(200)
    expect(ensureQuotePdf).not.toHaveBeenCalled()
    expect(vi.mocked(dispatchQuoteWithPdf).mock.calls[0][0].text).toContain('$99')
    expect(h.reads.some(read => read.table === 'quote_pricing_versions')).toBe(false)
  })
  it('preserves cent-precise final total, credit, fee and balance from the saved non-GST price', async () => {
    Object.assign(h.rows.quotes!, { quote_kind: 'final', total_inc_gst: 1000.05,
      good: { label: 'Final work', subtotal_ex_gst: 1000.05, line_items: [] } })
    expect((await send(request('sms', '+61411222333'), params)).status).toBe(200)
    const text = vi.mocked(dispatchQuoteWithPdf).mock.calls[0][0].text
    expect(text).toContain('$1,000.05 No GST')
    expect(text).toContain('$300.02 less your $99')
    expect(text).toContain('$205.04')
    expect(text).toContain('$700.03')
  })
})

describe('actual sender release race with SQL215', () => {
  let pg: PGlite
  const tenant = '22222222-2222-4222-8222-222222222222'
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`create role anon;create role authenticated;create role service_role;
      create table tenants(id uuid primary key);
      create table sms_conversations(id uuid primary key,from_number text,to_number text,status text,conversation_type text,tenant_id uuid);
      create table sms_messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,direction text,body text,twilio_message_sid text,audience text,to_number text,tenant_id uuid);
      create table intakes(id uuid primary key);
      create table quotes(id uuid primary key,tenant_id uuid,intake_id uuid,status text,paid_at timestamptz,sent_at timestamptz,price_hold_until timestamptz,
        share_token text,good jsonb,better jsonb,best jsonb,total_inc_gst numeric,selected_tier text,scope_of_works text,assumptions jsonb,estimated_timeframe text,
        needs_inspection boolean,inspection_reason text,deposit_pct numeric,display_mode text,applied_discount_pct numeric,quote_kind text,
        parent_quote_id uuid,pricing_book_version_id uuid,report_doc jsonb,report_style jsonb);
      create table plan_upload_requests(id uuid primary key default gen_random_uuid(),token text unique,tenant_id uuid,sms_conversation_id uuid,customer_phone text,twilio_number text,status text,created_at timestamptz default now(),updated_at timestamptz default now(),expires_at timestamptz);`)
    for (const file of ['198_sms_durable_work.sql','199_sms_delivery_outbox.sql','205_generic_quote_customer_release.sql','215_generic_release_snapshot.sql']) {
      await pg.exec(readFileSync('sql/migrations/' + file, 'utf8'))
    }
    await pg.query('insert into tenants values($1)', [tenant])
  }, 30_000)
  afterAll(async () => { await pg?.close() })
  beforeEach(async () => {
    h.tenantId = tenant
    for (const row of Object.values(h.rows)) if (row?.tenant_id === 'tenant-id') row.tenant_id = tenant
    ;(h.rows.quote_pricing_versions!.snapshot as Record<string, unknown>).tenant_id = tenant
    h.rows.quotes!.intake_id = h.rows.intakes!.id = '33333333-3333-4333-8333-333333333333'
    h.rows.quotes!.pricing_book_version_id = h.rows.quote_pricing_versions!.id = '44444444-4444-4444-8444-444444444444'
    await pg.exec('delete from sms_outbox;delete from quotes;')
    await pg.query('insert into quotes select * from jsonb_populate_record(null::quotes,$1::jsonb)', [JSON.stringify(h.rows.quotes)])
    h.rpc.mockImplementation(async (name, args) => {
      try {
        const pairs = Object.entries(args)
        const result = await pg.query<{ value: Record<string, unknown> }>(`select ${name}(${pairs.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) value`, pairs.map(([, value]) => value))
        return { data: result.rows[0].value, error: null }
      } catch (error) { return { data: null, error } }
    })
  })
  describe.each([{ name: 'approve SMS', handler: approve, channel: 'sms' as const, proof: '+61411222333' },
    { name: 'send SMS', handler: send, channel: 'sms' as const, proof: '+61411222333' },
    { name: 'send email', handler: send, channel: 'email' as const, proof: 'sam@example.com' }])('$name', ({ handler, channel, proof }) => {
    it.each([
      ['report_doc', { version: 1, sections: [{ type: 'paragraph', text: 'Changed after review' }] }],
      ['report_style', { accentColor: '#445566' }],
      ['pricing_book_version_id', '55555555-5555-4555-8555-555555555555'],
      ['parent_quote_id', '66666666-6666-4666-8666-666666666666'],
    ])('blocks a %s change during PDF work before any customer dispatch', async (field, value) => {
      vi.mocked(ensureQuotePdf).mockImplementationOnce(async () => {
        await pg.query(`update quotes set ${field}=$1 where id=$2`, [typeof value === 'object' ? JSON.stringify(value) : value, quoteId])
        return null
      })
      const response = await handler(request(channel, proof), params)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'approval_unavailable' })
      expect(dispatchQuoteWithPdf).not.toHaveBeenCalled(); expect(sendEmail).not.toHaveBeenCalled()
      expect((await pg.query('select id from sms_outbox')).rows).toHaveLength(0)
      expect((await pg.query<{ customer_released_at: null }>('select customer_released_at from quotes where id=$1', [quoteId])).rows[0].customer_released_at).toBeNull()
    })
    it('accepts an unchanged complete snapshot at the real release boundary', async () => {
      expect((await handler(request(channel, proof), params)).status).toBe(200)
      const args = h.rpc.mock.calls.find(([name]) => name === 'approve_generic_quote_release')![1]
      expect(args.p_snapshot).toMatchObject({ report_doc: h.rows.quotes!.report_doc, report_style: h.rows.quotes!.report_style,
        pricing_book_version_id: h.rows.quotes!.pricing_book_version_id })
      expect((await pg.query<{ customer_released_at: string }>('select customer_released_at from quotes where id=$1', [quoteId])).rows[0].customer_released_at).toBeTruthy()
      if (channel === 'sms') expect(dispatchQuoteWithPdf).toHaveBeenCalledOnce()
      else expect(sendEmail).toHaveBeenCalledOnce()
    })
  })
})
