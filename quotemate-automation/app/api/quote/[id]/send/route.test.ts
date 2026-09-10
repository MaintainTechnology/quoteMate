// POST /api/quote/[id]/send — manual send/resend of a quote to the customer
// via SMS or email, triggered from the dashboard quote viewer.
//
// Supabase is mocked with a TABLE-KEYED chainable builder (each table has its
// own result queue) so the route's query order can change without breaking the
// tests. Auth, SMS dispatch, PDF and email side effects are module-mocked; the
// pure policy (canSendQuote / resolveCustomerContact / buildQuoteEmail) and the
// SMS template run for real.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  type Result = { data: unknown; error: unknown }
  const tables = new Map<string, Result[]>()

  function seed(table: string, ...results: Result[]) {
    tables.set(table, results)
  }

  function from(table: string) {
    const builder: Record<string, unknown> = {}
    for (const op of ['select', 'update', 'insert', 'eq', 'is', 'limit', 'order']) {
      builder[op] = () => builder
    }
    const next = () => {
      const q = tables.get(table)
      return q && q.length > 0 ? q.shift()! : { data: null, error: null }
    }
    builder.maybeSingle = async () => next()
    builder.then = (
      resolve: (r: Result) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(next()).then(resolve, reject)
    return builder
  }

  const releases = new Map<string,unknown>()
  const rpc=vi.fn(async (_name:string,args:{p_outbound?:{deliveryKey?:string}})=>{const key=args.p_outbound?.deliveryKey;if(key && !releases.has(key))releases.set(key,args.p_outbound);return {data:{approved:true,outbound:key?releases.get(key):null,outbox_id:key?'out-1':null},error:null}})
  return { tables, seed, releases, rpc, client: { from,rpc } }
})

vi.mock('next/server',()=>({after:vi.fn()}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: vi.fn() }))
vi.mock('@/lib/quote/job-quote-operation', () => ({ readQuoteDraftReadiness: vi.fn() }))
vi.mock('@/lib/sms/send-quote-pdf', () => ({ dispatchQuoteWithPdf: vi.fn() }))
// Actual origin ownership is covered separately with the approval handlers.
vi.mock('@/lib/sms/quote-origin-conversation', () => ({ resolveQuoteOriginConversation: async () => null }))
vi.mock('@/lib/quote/pdf', () => ({
  ensureQuotePdf: vi.fn(),
  quotePdfUrl: (token: string) => `https://www.quotemax.com.au/api/q/${token}/pdf`,
  signQuotePdfUrl: vi.fn(async () => 'https://signed.example/quote.pdf'),
  downloadQuotePdf: vi.fn(),
}))
vi.mock('@/lib/quote/lifecycle', () => ({ advanceQuoteStatus: vi.fn() }))
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn() }))

import { quoteCustomerReleaseRevision } from '@/lib/quote/customer-release'
import { POST } from './route'
import { POST as approveQuote } from '../approve/route'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { dispatchQuoteWithPdf } from '@/lib/sms/send-quote-pdf'
import { ensureQuotePdf, downloadQuotePdf } from '@/lib/quote/pdf'
import { advanceQuoteStatus } from '@/lib/quote/lifecycle'
import { sendEmail } from '@/lib/email/resend'

const resolveMock = vi.mocked(resolveTenantRequest)
const dispatchMock = vi.mocked(dispatchQuoteWithPdf)
const ensurePdfMock = vi.mocked(ensureQuotePdf)
const downloadPdfMock = vi.mocked(downloadQuotePdf)
const advanceMock = vi.mocked(advanceQuoteStatus)
const sendEmailMock = vi.mocked(sendEmail)

const params = { params: Promise.resolve({ id: 'quote-1' }) }

function req(body: unknown) {
  return new Request('http://localhost/api/quote/quote-1/send', {
    method: 'POST',
    headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
    body: JSON.stringify({expected_revision:quoteCustomerReleaseRevision((h.tables.get('quotes')?.[0]?.data ?? {}) as Record<string,unknown>),...(body && typeof body === 'object' ? body : {})}),
  })
}

const tenant = { id: 'tenant-1', twilio_sms_number: '+61400000000', business_name: 'Pilot Sparky' }
const identity = { provider: 'clerk' as const, userId: 'u1', email: 'tradie@example.com' }

const baseQuote = {
  id: 'quote-1',
  tenant_id: 'tenant-1',
  intake_id: 'intake-1',
  status: 'draft',
  share_token: 'tok_abc12345xyz',
  good: { label: 'Good', subtotal_ex_gst: 28000, line_items: [] },
  better: null,
  best: null,
  selected_tier: null,
  total_inc_gst: 30800,
  scope_of_works: null,
  assumptions: null,
  estimated_timeframe: null,
  needs_inspection: false,
  inspection_reason: null,
  stripe_links: { good: 'https://stripe.example/sess' },
  deposit_pct: 30,
  display_mode: null,
  price_hold_until: null,
}

const baseIntake = {
  id: 'intake-1',
  tenant_id: 'tenant-1',
  caller: { name: 'Jon Smith', phone: '+61411111111', email: 'jon@example.com' },
  suburb: 'Penrith',
  job_type: 'reroof',
  scope: null,
  call_id: null,
  customer_id: null,
  trade: 'roofing',
}

function seedHappyPath(overrides?: { quote?: Record<string, unknown>; intake?: Record<string, unknown> | null }) {
  h.seed('quotes',
    { data: { ...baseQuote, ...(overrides?.quote ?? {}) }, error: null }, // load
    { data: null, error: null }, // price-hold update (sms path)
  )
  h.seed('intakes', {
    data: overrides && 'intake' in overrides ? overrides.intake : baseIntake,
    error: null,
  })
  h.seed('pricing_book', {
    data: { quote_display: null, gst_registered: true, quote_tier_mode: null },
    error: null,
  })
  h.seed('quote_followup_events', { data: null, error: null })
}

beforeEach(() => {
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://www.quotemax.com.au')
  h.tables.clear();h.releases.clear();h.rpc.mockClear();vi.stubEnv('PUBLIC_WEB_ORIGIN','https://www.quotemax.com.au')
  resolveMock.mockReset()
  dispatchMock.mockReset()
  ensurePdfMock.mockReset()
  downloadPdfMock.mockReset()
  advanceMock.mockReset()
  sendEmailMock.mockReset()
  vi.mocked(readQuoteDraftReadiness).mockReset().mockResolvedValue({ ready: true })

  resolveMock.mockResolvedValue({ identity, tenant })
  ensurePdfMock.mockResolvedValue('quote-pdfs/quote-1.pdf')
  downloadPdfMock.mockResolvedValue(Buffer.from('pdfbytes'))
  advanceMock.mockResolvedValue({ advanced: true, from: 'draft', to: 'sent' })
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/quote/[id]/send', () => {
  it.each(['quote_draft_processing', 'quote_draft_unconfirmed'] as const)('blocks approval and send while readiness reports %s before provider work', async code => {
    vi.mocked(readQuoteDraftReadiness).mockResolvedValue({ ready: false, code })
    for (const handler of [POST, approveQuote]) {
      seedHappyPath({ quote: { status: 'awaiting_tradie_approval', quote_kind: 'initial' } })
      const response = await handler(req({ channel: 'sms' }), params)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ ok: false, error: code })
      expect(h.tables.get('quotes')).toHaveLength(1)
    }
    expect(ensurePdfMock).not.toHaveBeenCalled()
    expect(dispatchMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(advanceMock).not.toHaveBeenCalled()
  })

  it('approve and send recover one saved initial intent before and after a lost response', async () => {
    seedHappyPath({quote:{status:'awaiting_tradie_approval'}})
    dispatchMock.mockResolvedValue({ok:false,outboxId:'out-1',smsAttempt:{code:'AMBIGUOUS',reason:'network'}} as never)
    const approved=await approveQuote(req({}),params)
    expect(approved.status).toBe(202)
    const first=dispatchMock.mock.calls[0][0]
    seedHappyPath({quote:{status:'awaiting_tradie_approval'}})
    dispatchMock.mockResolvedValue({ok:true,outboxId:'out-1',channel:'sms',sid:'SM-original'} as never)
    expect((await POST(req({channel:'sms'}),params)).status).toBe(200)
    expect(dispatchMock.mock.calls[1][0].deliveryKey).toBe(first.deliveryKey)
    expect(dispatchMock.mock.calls[1][0].text).toBe(first.text)
    expect(h.releases.size).toBe(1)
    seedHappyPath({quote:{status:'sent'}})
    expect((await POST(req({channel:'sms',requestId:'33333333-3333-4333-8333-333333333333'}),params)).status).toBe(200)
    expect(h.releases.size).toBe(2)
  })
  it('does not call the carrier when approval and outbox persistence fail', async () => {
    seedHappyPath()
    h.rpc.mockResolvedValueOnce({data:null,error:{code:'08006'}} as never)
    expect((await POST(req({channel:'sms'}),params)).status).toBe(409)
    expect(dispatchMock).not.toHaveBeenCalled()
  })
  it.each([undefined,'0'.repeat(64)])('refuses first release without the exact displayed revision (%s)',async expected_revision=>{
    for(const handler of [POST,approveQuote]) {
      seedHappyPath({quote:{status:'awaiting_tradie_approval'}})
      const response=await handler(req({channel:'sms',expected_revision}),params)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({error:'quote_review_required',review_url:'/dashboard/quote/tok_abc12345xyz'})
    }
    expect(h.rpc).not.toHaveBeenCalled();expect(dispatchMock).not.toHaveBeenCalled()
  })
  it('permits a legacy released resend without adding a new review requirement',async()=>{
    seedHappyPath({quote:{status:'sent'}})
    dispatchMock.mockResolvedValue({ok:true,channel:'sms',sid:'SM-old'} as never)
    expect((await POST(req({channel:'sms',expected_revision:undefined}),params)).status).toBe(200)
  })
  it('401 when the caller has no resolvable tenant', async () => {
    resolveMock.mockResolvedValue(null)
    const res = await POST(req({ channel: 'sms' }), params)
    expect(res.status).toBe(401)
  })

  it("403 when the quote belongs to another tenant", async () => {
    h.seed('quotes', { data: { ...baseQuote, tenant_id: 'tenant-other' }, error: null })
    const res = await POST(req({ channel: 'sms' }), params)
    expect(res.status).toBe(403)
  })

  it('404 when the quote does not exist', async () => {
    h.seed('quotes', { data: null, error: null })
    const res = await POST(req({ channel: 'sms' }), params)
    expect(res.status).toBe(404)
  })

  it('409 when the quote is already paid', async () => {
    h.seed('quotes', { data: { ...baseQuote, status: 'paid' }, error: null })
    const res = await POST(req({ channel: 'sms' }), params)
    expect(res.status).toBe(409)
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('400 on an unknown channel', async () => {
    const res = await POST(req({ channel: 'carrier-pigeon' }), params)
    expect(res.status).toBe(400)
  })

  it('400 when SMS is requested but no phone is on file anywhere', async () => {
    seedHappyPath({ intake: { ...baseIntake, caller: { name: 'Jon Smith', phone: '' } } })
    const res = await POST(req({ channel: 'sms' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('no_customer_phone')
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('sends the SMS to the resolved number from the tenant number and advances to sent', async () => {
    seedHappyPath()
    dispatchMock.mockResolvedValue({ ok: true, channel: 'sms', sid: 'SM123' } as never)

    const res = await POST(req({ channel: 'sms' }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, channel: 'sms', sid: 'SM123', status: 'sent' })

    expect(dispatchMock).toHaveBeenCalledTimes(1)
    const arg = dispatchMock.mock.calls[0][0]
    expect(arg.to).toBe('+61411111111')
    expect(arg.from).toBe('+61400000000')
    expect(arg.text).toContain('/q/tok_abc12345xyz')
    expect(advanceMock).toHaveBeenCalledWith(expect.anything(), 'quote-1', 'sent')
  })

  it('saves approval with pending delivery on dispatch failure without claiming sent', async () => {
    seedHappyPath()
    dispatchMock.mockResolvedValue({
      ok: false,
      smsAttempt: { code: 30007, reason: 'carrier filtered' },
    } as never)

    const res = await POST(req({ channel: 'sms' }), params)
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({approved:true,accepted:false,outboxId:'out-1'})
    expect(h.rpc).toHaveBeenCalledWith('approve_generic_quote_release',expect.objectContaining({p_quote_id:'quote-1'}))
    expect(advanceMock).not.toHaveBeenCalled()
    // The seeded quotes queue held [load, hold-update]; a failed dispatch must
    // consume only the load — the hold restamp belongs to a successful send.
    expect(h.tables.get('quotes')!.length).toBe(1)
  })

  it('normalises an AU-local SMS override to E.164 before dispatch', async () => {
    seedHappyPath()
    dispatchMock.mockResolvedValue({ ok: true, channel: 'sms', sid: 'SM456' } as never)

    const res = await POST(req({ channel: 'sms', to: '0412 345 678' }), params)
    expect(res.status).toBe(200)
    expect(dispatchMock.mock.calls[0][0].to).toBe('+61412345678')
  })

  it('400 on an SMS override that is not a valid AU mobile', async () => {
    seedHappyPath()
    const res = await POST(req({ channel: 'sms', to: 'not a number' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_recipient')
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('emails the quote with the PDF attached, honouring a recipient override', async () => {
    seedHappyPath()
    sendEmailMock.mockResolvedValue({ ok: true, messageId: 'msg_1' })

    const res = await POST(req({ channel: 'email', to: 'override@example.com' }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, channel: 'email', messageId: 'msg_1', status: 'sent' })

    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const opts = sendEmailMock.mock.calls[0][0]
    expect(opts.to).toBe('override@example.com')
    expect(opts.replyTo).toBe('tradie@example.com')
    expect(opts.html).toContain('/q/tok_abc12345xyz')
    expect(opts.attachments).toEqual([
      { filename: 'quote-tok_abc1.pdf', content: Buffer.from('pdfbytes').toString('base64') },
    ])
    expect(advanceMock).toHaveBeenCalledWith(expect.anything(), 'quote-1', 'sent')
  })

  it('still emails (link-only) when the PDF cannot be produced', async () => {
    seedHappyPath()
    ensurePdfMock.mockResolvedValue(null)
    sendEmailMock.mockResolvedValue({ ok: true, messageId: 'msg_2' })

    const res = await POST(req({ channel: 'email' }), params)
    expect(res.status).toBe(200)
    const opts = sendEmailMock.mock.calls[0][0]
    expect(opts.to).toBe('jon@example.com')
    expect(opts.attachments).toBeUndefined()
  })

  it('400 when email is requested but no address is on file and none is given', async () => {
    seedHappyPath({ intake: { ...baseIntake, caller: { name: 'Jon Smith' } } })
    const res = await POST(req({ channel: 'email' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('no_customer_email')
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('400 on a malformed email override', async () => {
    seedHappyPath()
    const res = await POST(req({ channel: 'email', to: 'not-an-email' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_recipient')
  })

  it('502 when the email provider rejects the send, without advancing status', async () => {
    seedHappyPath()
    sendEmailMock.mockResolvedValue({ ok: false, code: 'http_422', reason: 'invalid' })

    const res = await POST(req({ channel: 'email' }), params)
    expect(res.status).toBe(502)
    expect(advanceMock).not.toHaveBeenCalled()
  })
})
