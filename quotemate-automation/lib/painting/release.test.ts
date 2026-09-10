import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  sendSms: vi.fn(async () => ({ ok: true, sid: 'SM1' })),
  composePaintingQuoteDelivery: vi.fn(
    async (): Promise<{ text: string; mmsUrl?: string }> => ({ text: 'quote' }),
  ),
}))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: h.sendSms }))
vi.mock('./quote-dispatch', () => ({ composePaintingQuoteDelivery: h.composePaintingQuoteDelivery }))

import {
  autoSendPaintingQuote,
  markPaintingQuoteSent,
  notifyPaintingTradie,
  revertPaintingRelease,
  sendPaintingQuoteToCustomer,
} from './release'

afterEach(() => vi.unstubAllEnvs())
beforeEach(()=>vi.stubEnv('PUBLIC_WEB_ORIGIN','https://quotemax.com.au'))

describe('notifyPaintingTradie', () => {
  it('texts the tradie owner_mobile from the tenant number with the /p review link', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }))
    const r = await notifyPaintingTradie({
      tenant: { owner_mobile: '+61400000000', owner_first_name: 'Jo', twilio_sms_number: '+61480000000' },
      customerName: 'Sam',
      address: '5 Smith St',
      betterIncGst: 5000,
      estimateToken: 'etok',
      appUrl: 'https://x.test',
      dispatch,
    })
    expect(r.notified).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '+61400000000',
        from: '+61480000000',
        text: expect.stringContaining('https://x.test/p/etok'),
      }),
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('5 Smith St') }),
    )
  })

  it('says the customer was NOT texted when the auto-send failed (spec painting-auto-send R3)', async () => {
    const dispatch = vi.fn(async (_o: { to: string; text: string; from?: string }) => ({ ok: true }))
    await notifyPaintingTradie({
      tenant: { owner_mobile: '+61400000000', owner_first_name: 'Jo', twilio_sms_number: null },
      address: '5 Smith St',
      estimateToken: 'etok',
      appUrl: 'https://x.test',
      dispatch,
      customerTexted: false,
    })
    const text = dispatch.mock.calls[0][0].text as string
    expect(text).toMatch(/NOT been sent anything/)
    expect(text).toContain('https://x.test/p/etok')
  })

  it('no-ops (no dispatch) when there is no notify number', async () => {
    vi.stubEnv('TRADIE_NOTIFY_NUMBER', '')
    const dispatch = vi.fn(async () => ({ ok: true }))
    const r = await notifyPaintingTradie({
      tenant: { owner_mobile: null, owner_first_name: null, twilio_sms_number: null },
      address: '5 Smith St',
      estimateToken: 'etok',
      appUrl: 'https://x.test',
      dispatch,
    })
    expect(r.notified).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

// ── Spec painting-auto-send R3 — { sent } must be the truth, always. This is
//    the function 3 of 8 live releases lied about.
describe('sendPaintingQuoteToCustomer', () => {
  /** Row lookup + tenant lookup, in the order the function reads them. */
  function client(rows: unknown[]): SupabaseClient {
    const queue = [...rows]
    return {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: queue.shift() ?? null }) }),
        }),
      }),
    } as unknown as SupabaseClient
  }

  const row = {
    public_token: 'pub-1',
    estimate_token: 'est-1',
    estimate: { price: { tiers: [] } },
    customer_phone: '+61400000000',
    tenant_id: 't1',
    routing: 'auto_quote',
    address: '5 Smith St',
    released_at: '2026-09-08T00:00:00Z',
  }

  it('reports sent:false when Twilio REJECTS the message', async () => {
    h.sendSms.mockResolvedValueOnce({ ok: false, smsAttempt:{code: '21610', reason: 'unsubscribed'},smsAttempts:1 } as never)
    const r = await sendPaintingQuoteToCustomer(client([row, { twilio_sms_number: '+61480000000' }]), {
      estimateToken: 'est-1',
      appUrl: 'https://x.test',
    })
    expect(r.sent).toBe(false)
  })

  it('reports sent:false when the row has no customer_phone', async () => {
    h.sendSms.mockClear()
    const r = await sendPaintingQuoteToCustomer(client([{ ...row, customer_phone: null }]), {
      estimateToken: 'est-1',
      appUrl: 'https://x.test',
    })
    expect(r.sent).toBe(false)
    expect(h.sendSms).not.toHaveBeenCalled()
  })

  it('reports sent:true only when Twilio accepted it', async () => {
    h.sendSms.mockResolvedValueOnce({ ok: true, sid: 'SM1', outboxId: 'outbox-1', status: 'queued' } as never)
    const r = await sendPaintingQuoteToCustomer(client([row, { twilio_sms_number: '+61480000000' }]), {
      estimateToken: 'est-1',
      appUrl: 'https://x.test',
    })
    expect(r.sent).toBe(true)
    expect(r).toMatchObject({outboxId:'outbox-1',status:'accepted'})
  })
  it.each([
    ['AMBIGUOUS', 'unknown'], ['429', 'retry'], ['OUTBOX_PENDING', 'recovery_pending'], ['21610', 'failed'],
  ])('retains the durable receipt for %s recovery', async(code,status)=>{
    h.sendSms.mockResolvedValueOnce({ok:false,outboxId:'outbox-1',smsAttempt:{code,reason:'boundary failure'},smsAttempts:1} as never)
    const result=await sendPaintingQuoteToCustomer(client([row,{twilio_sms_number:'+61480000000'}]),{publicToken:'pub-1',appUrl:'https://x.test'})
    expect(result).toEqual({sent:false,outboxId:'outbox-1',status})
  })
  it('holds an unreleased draft and never uses a platform sender when tenant configuration is absent',async()=>{
    vi.stubEnv('TWILIO_SMS_NUMBER','+61499999999')
    h.sendSms.mockClear()
    expect((await sendPaintingQuoteToCustomer(client([{...row,released_at:null}]),{publicToken:'pub-1',appUrl:'https://x.test'})).sent).toBe(false)
    expect((await sendPaintingQuoteToCustomer(client([row,{twilio_sms_number:null}]),{publicToken:'pub-1',appUrl:'https://x.test'})).sent).toBe(false)
    expect(h.sendSms).not.toHaveBeenCalled()
  })
  it('uses the tenant number, tenant scope and stable explicit delivery request',async()=>{
    h.sendSms.mockClear()
    h.sendSms.mockResolvedValueOnce({ok:true,sid:'SM1'} as never)
    await sendPaintingQuoteToCustomer(client([row,{twilio_sms_number:'+61480000000'}]),{
      publicToken:'pub-1',appUrl:'https://x.test',tenantId:'t1',requestId:'resend-1',
    })
    expect(h.sendSms).toHaveBeenCalledWith(expect.objectContaining({
      to:row.customer_phone,from:'+61480000000',tenantId:'t1',deliveryKey:'painting:pub-1:resend:resend-1',
    }))
  })
  it('rejects another tenant before dispatch',async()=>{
    h.sendSms.mockClear()
    expect((await sendPaintingQuoteToCustomer(client([row]),{publicToken:'pub-1',appUrl:'https://x.test',tenantId:'another'})).sent).toBe(false)
    expect(h.sendSms).not.toHaveBeenCalled()
  })
})

// ── The write helpers must honour supabase-js's RESOLVED { error }: it does
//    not throw on a DB/PostgREST failure, so a bare await would swallow a
//    failed rollback exactly like the bare sendSms swallowed a failed send.
/** Update double whose `.eq()` resolves to the given { error }. */
function updateClient(error: unknown, seen: Record<string, unknown>[] = []) {
  return {
    client: {
      from: () => ({
        select: () => { const q = { eq: () => q, maybeSingle: async () => ({ data: { released_at: 'approved' }, error: null }) }; return q },
        update: (patch: Record<string, unknown>) => {
          seen.push(patch)
          return { eq: async () => ({ error }) }
        },
      }),
    } as unknown as SupabaseClient,
    seen,
  }
}

describe('revertPaintingRelease', () => {
  it('nulls released_at and reports reverted:true on success', async () => {
    const { client, seen } = updateClient(null)
    const r = await revertPaintingRelease(client, 'pub-1')
    expect(r.reverted).toBe(true)
    expect(seen[0]).toEqual({ released_at: null })
  })

  it('reports reverted:false when the DB rejects the write (resolved, not thrown)', async () => {
    const { client } = updateClient({ message: 'permission denied' })
    const r = await revertPaintingRelease(client, 'pub-1')
    expect(r.reverted).toBe(false)
  })

  it('reports reverted:false when the client throws outright', async () => {
    const throwing = {
      from: () => {
        throw new Error('socket closed')
      },
    } as unknown as SupabaseClient
    expect((await revertPaintingRelease(throwing, 'pub-1')).reverted).toBe(false)
  })
})

describe('markPaintingQuoteSent', () => {
  it('stamps quote_sent_at — and only quote_sent_at', async () => {
    const { client, seen } = updateClient(null)
    expect((await markPaintingQuoteSent(client, 'pub-1')).marked).toBe(true)
    expect(Object.keys(seen[0])).toEqual(['quote_sent_at'])
    expect(Number.isNaN(Date.parse(seen[0].quote_sent_at as string))).toBe(false)
  })

  it('reports marked:false on a resolved DB error', async () => {
    const { client } = updateClient({ message: 'nope' })
    expect((await markPaintingQuoteSent(client, 'pub-1')).marked).toBe(false)
  })
})

// ── The ONE auto-send both draft-time origins share (spec R2/R3/E).
describe('autoSendPaintingQuote', () => {
  const disp = {
    ok: true as const,
    token: 'pub-1',
    estimateToken: 'est-1',
    inspection: false,
    estimate: { price: { routing: { decision: 'auto_quote', reason: '' }, tiers: [] } },
  } as never

  function args(send: (t: string, m?: string) => Promise<boolean>, error: unknown = null) {
    const { client, seen } = updateClient(error)
    return {
      call: { supabase: client, disp, address: '5 Smith St', appUrl: 'https://x.test', tenantId: 'tenant-1', send },
      seen,
    }
  }

  beforeEach(() => {
    h.composePaintingQuoteDelivery.mockReset().mockResolvedValue({ text: 'quote', mmsUrl: 'https://pdf' })
  })

  it('sends the composed quote and stamps quote_sent_at on acceptance', async () => {
    const send = vi.fn(async () => true)
    const { call, seen } = args(send)
    expect((await autoSendPaintingQuote(call)).sent).toBe(true)
    expect(send).toHaveBeenCalledWith('quote', 'https://pdf')
    expect(seen[0]).toHaveProperty('quote_sent_at')
  })

  it('preserves existing approval without stamping sent when the carrier refuses', async () => {
    const { call, seen } = args(async () => false)
    expect((await autoSendPaintingQuote(call)).sent).toBe(false)
    expect(seen).toEqual([])
  })

  it('preserves existing approval when composing throws, and never reports sent', async () => {
    h.composePaintingQuoteDelivery.mockRejectedValue(new Error('gotenberg down'))
    const send = vi.fn(async () => true)
    const { call, seen } = args(send)
    expect((await autoSendPaintingQuote(call)).sent).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })
})

it('legacy draft-time auto-send cannot bypass the persisted human approval', async () => {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { released_at: null }, error: null }) }
  const send = vi.fn(async () => true)
  const result = await autoSendPaintingQuote({ supabase: { from: () => q } as never, disp: { token: 'held' } as never, address: 'Street', appUrl: 'https://x.test', tenantId: 'tenant-1', send })
  expect(result.sent).toBe(false)
  expect(send).not.toHaveBeenCalled()
})
