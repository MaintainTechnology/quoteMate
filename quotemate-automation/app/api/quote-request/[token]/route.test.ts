// spec: specs/generic-quote-request-form.md §3.
//
// The generic self-serve form POST. What these tests pin down, in priority
// order, is the two rules the painting reference breaks:
//
//   1. NEVER 200 on failure. A failed write or a failed estimate hand-off
//      returns non-2xx, and the row does NOT stay marked submitted.
//   2. supabase-js RESOLVES { data, error } — it does not throw. Every write
//      is checked, including the lead lookup (painting renders a PostgREST
//      outage as "invalid link") and the mark-submitted update (painting
//      bare-awaits it, so a spent link can silently stay live).
//
//   3. NEVER claim a send nobody made. `texted` is a delivery fact —
//      true (a carrier accepted it), false (attempted and refused), or null
//      (the async intake pipeline owns the send). The thank-you page branches
//      on it, so a hardcoded `true` puts "your quote is on its way" in front
//      of a customer who is getting nothing.
//
// Plus: the right Zod branch per trade, and the right estimate path per trade
// — the SHARED dispatcher module the SMS gather calls, so the tradie alert,
// the holding SMS and the conversation state come along with it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
  // Apex, never www: the www host 307-redirects cross-origin and strips
  // Authorization, which would 401 the internal intake hand-off.
  //
  // The two are set to DIFFERENT hosts on purpose — that is the whole point.
  // NEXT_PUBLIC_APP_URL is the repo's www variable (see
  // lib/sms/roofing-measure-dispatch.ts, lib/twilio/sms-webhook-url.test.ts),
  // APP_URL is the apex every internal self-caller reads. Setting both to the
  // apex, as this file used to, made the precedence untestable: flipping the
  // route back to NEXT_PUBLIC-first still passed. The intake-hand-off
  // assertion below now fails if anyone flips it.
  process.env.APP_URL = 'https://quotemax.com.au'
  process.env.NEXT_PUBLIC_APP_URL = 'https://www.quotemax.com.au'
  process.env.CRON_SECRET = 'cron-secret'

  type Result = { data: unknown; error: unknown }
  /** Per-TABLE FIFO, so a test only has to know the order of the calls it
   *  cares about — not the interleaving across tables. */
  const results = new Map<string, Result[]>()
  const writes: { table: string; op: 'insert' | 'update'; row: Record<string, unknown> }[] = []

  function queue(table: string, ...rs: Result[]) {
    const list = results.get(table) ?? []
    list.push(...rs)
    results.set(table, list)
  }

  function from(table: string) {
    const builder: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'order', 'limit', 'maybeSingle', 'single']) {
      builder[op] = () => builder
    }
    for (const op of ['insert', 'update'] as const) {
      builder[op] = (row: Record<string, unknown>) => {
        writes.push({ table, op, row })
        return builder
      }
    }
    builder.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => {
      const r = results.get(table)?.shift() ?? { data: null, error: null }
      return Promise.resolve(r).then(resolve, reject)
    }
    return builder
  }

  return {
    queue,
    results,
    writes,
    client: { from },
    runAndSavePaintingQuote: vi.fn(),
    autoSendPaintingQuote: vi.fn(),
    notifyPaintingTradie: vi.fn(async () => ({ notified: true })),
    persistHumanHandoff: vi.fn(),
    measureAndDispatchRoofing: vi.fn(),
    notifyRoofingTradie: vi.fn(async () => ({ notified: true })),
    dispatchQuoteMessage: vi.fn(async () => ({ ok: true, sid: 'SM9' })),
    sendSms: vi.fn(
      async (
        _opts: { to: string; from?: string; text: string; mediaUrl?: string },
      ): Promise<{ ok: boolean; sid?: string; code?: string; reason?: string }> => ({
        ok: true,
        sid: 'SM1',
      }),
    ),
  }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
// The painting DISPATCHER (lib/sms/painting-estimate-dispatch) runs for real
// here — it is the shared module the SMS gather calls, and the holding SMS,
// the release revert and the tradie alert all live inside it. Only its I/O
// edges are faked, so this file proves the route wires up the whole sequence
// rather than re-implementing half of it.
vi.mock('@/lib/painting/quote-dispatch', () => ({
  runAndSavePaintingQuote: h.runAndSavePaintingQuote,
}))
vi.mock('@/lib/painting/release', () => ({
  autoSendPaintingQuote: h.autoSendPaintingQuote,
  notifyPaintingTradie: h.notifyPaintingTradie,
}))
vi.mock('@/lib/sms/roofing-measure-dispatch', () => ({
  measureAndDispatchRoofing: h.measureAndDispatchRoofing,
  ROOFING_APP_BASE_URL: 'https://quotemax.com.au',
}))
vi.mock('@/lib/sms/roofing-notify', () => ({ notifyRoofingTradie: h.notifyRoofingTradie }))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: h.dispatchQuoteMessage }))
vi.mock('@/lib/sms/human-handoff', () => ({ persistHumanHandoff: h.persistHumanHandoff }))
vi.mock('@/lib/sms/twilio', () => ({ sendSms: h.sendSms }))

import { POST } from './route'

const TOKEN = 'a'.repeat(32)

const LEAD = {
  token: TOKEN,
  trade: 'painting',
  tenant_id: 't1',
  conversation_id: 'c1',
  customer_phone: '+61400000000',
  status: 'pending',
}

const ADDRESS = { address: '5 Smith St, Coorparoo', postcode: '4151', state: 'QLD' }

const PAINT_BODY = {
  address: ADDRESS,
  first_name: 'Sam',
  contact_time: 'morning',
  inputs: {
    scopes: ['walls'],
    coats: 2,
    condition: 'sound',
    ceiling_height: 'standard',
    colour_change: false,
    storeys: 1,
  },
}

const ROOF_BODY = {
  address: ADDRESS,
  first_name: 'Sam',
  contact_time: 'anytime',
  inputs: {
    intent: 'full_reroof',
    material: 'colorbond_trimdek',
    pitch: 'standard',
    storeys: 1,
  },
}

const ELEC_BODY = {
  address: ADDRESS,
  first_name: 'Sam',
  contact_time: 'evening',
  notes: 'kitchen and hallway',
  inputs: {
    job_type: 'downlights',
    quantity: 12,
    ceiling_type: 'flat',
    storeys: 1,
    switch_within_5m: 'yes',
  },
}

const PLUMB_BODY = {
  address: ADDRESS,
  contact_time: 'anytime',
  inputs: {
    job_type: 'hot_water',
    hot_water_energy: 'electric',
    hot_water_capacity_l: 250,
    hot_water_location: 'outdoor',
  },
}

const PRICED_PAINT = {
  ok: true as const,
  token: 'pub-1',
  estimateToken: 'est-1',
  inspection: false,
  estimate: { price: { routing: { decision: 'auto_quote', reason: null }, tiers: [] } },
}

const QUOTE_SMS = 'Your painting quote: good $1, better $2, best $3'

function req(body: unknown = PAINT_BODY, raw?: string) {
  return new Request(`http://localhost/api/quote-request/${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  })
}
const ctx = { params: Promise.resolve({ token: TOKEN }) }

/** lead lookup → claim (1 row) ; conversation read ; message insert. */
function queueHappy(lead: Record<string, unknown> = LEAD) {
  h.queue('trade_lead_requests', { data: lead, error: null }, { data: [{ token: TOKEN }], error: null })
  h.queue('sms_conversations', { data: { to_number: '+61480000000', conversation_state: { slots: {} } }, error: null })
  h.queue('painting_measurements', { data: { id: 'painting-row' }, error: null })
}

const writesTo = (table: string) => h.writes.filter((w) => w.table === table)
const leadUpdates = () => writesTo('trade_lead_requests').filter((w) => w.op === 'update')

beforeEach(() => {
  h.results.clear()
  h.writes.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  h.runAndSavePaintingQuote.mockReset().mockResolvedValue(PRICED_PAINT)
  // Stands in for compose + send + stamp/revert. It reports whatever the
  // route's own transport said, which is exactly the contract that makes the
  // real helper revert an undelivered release.
  h.autoSendPaintingQuote
    .mockReset()
    .mockImplementation(async (a: { send: (t: string) => Promise<boolean> }) => ({
      sent: await a.send(QUOTE_SMS),
    }))
  h.notifyPaintingTradie.mockClear()
  h.persistHumanHandoff.mockReset().mockResolvedValue({ id: 'task-1', notified: true })
  // The real dispatcher texts the customer through the injected sendReply —
  // mock it the same way, or the route's delivery tracking is never exercised
  // and a hardcoded `texted: true` would sail through this file.
  h.measureAndDispatchRoofing
    .mockReset()
    .mockImplementation(async (a: { sendReply: (t: string) => Promise<{ ok: boolean }> }) => {
      const sent = await a.sendReply('Your roof draft is saved and awaiting review')
      if (!sent.ok) return { ok: false, reason: 'Status send failed' }
      return { ok: true, token: 'roof-1', quote: {}, state: { slots: {}, last_step: 'closed', workflow_stage: 'awaiting_review' } }
    })
  h.notifyRoofingTradie.mockClear()
  h.dispatchQuoteMessage.mockReset().mockResolvedValue({ ok: true, sid: 'SM9' })
  h.sendSms.mockReset().mockResolvedValue({ ok: true, sid: 'SM1' })
})

describe('POST /api/quote-request/[token] — token gate', () => {
  it('404s an unknown token and hands nothing off', async () => {
    h.queue('trade_lead_requests', { data: null, error: null })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_link' })
    expect(h.writes).toHaveLength(0)
  })

  it('503s a lookup failure instead of calling a DB outage an invalid link', async () => {
    h.queue('trade_lead_requests', { data: null, error: { message: 'PostgREST down' } })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, error: 'lookup_failed' })
  })

  it('409s an already-submitted link', async () => {
    h.queue('trade_lead_requests', { data: { ...LEAD, status: 'submitted' }, error: null })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'already_submitted' })
  })

  it('410s an expired link', async () => {
    h.queue('trade_lead_requests', { data: { ...LEAD, status: 'expired' }, error: null })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ error: 'link_expired' })
  })

  it('500s a trade this form cannot serve, rather than guessing a pipeline', async () => {
    h.queue('trade_lead_requests', { data: { ...LEAD, trade: 'solar' }, error: null })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'unsupported_trade' })
    expect(h.writes).toHaveLength(0)
  })

  it('409s when the claim matches no row (a second tab won the race)', async () => {
    h.queue('trade_lead_requests', { data: LEAD, error: null }, { data: [], error: null })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect(h.runAndSavePaintingQuote).not.toHaveBeenCalled()
  })

  it('503s a failed claim write and never runs the estimate', async () => {
    h.queue('trade_lead_requests', { data: LEAD, error: null }, { data: null, error: { message: 'write failed' } })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'claim_failed' })
    expect(h.runAndSavePaintingQuote).not.toHaveBeenCalled()
  })
})

describe('POST /api/quote-request/[token] — per-trade validation', () => {
  it('400s malformed JSON', async () => {
    h.queue('trade_lead_requests', { data: LEAD, error: null })
    const res = await POST(req(undefined, '{nope'), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_json' })
    expect(h.writes).toHaveLength(0)
  })

  it("400s a payload that is valid for another trade but not this lead's", async () => {
    h.queue('trade_lead_requests', { data: { ...LEAD, trade: 'electrical' }, error: null })
    const res = await POST(req(PAINT_BODY), ctx)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_request')
    expect(Array.isArray(body.issues)).toBe(true)
    expect(h.writes).toHaveLength(0)
  })

  it('400s a hot-water plumbing job with no energy source (it grounds the assembly)', async () => {
    h.queue('trade_lead_requests', { data: { ...LEAD, trade: 'plumbing' }, error: null })
    const res = await POST(req({ ...PLUMB_BODY, inputs: { job_type: 'hot_water' } }), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
  })
})

describe('POST /api/quote-request/[token] — painting hand-off', () => {
  it('saves the draft, texts its review status and records the same token', async () => {
    queueHappy()
    const res = await POST(req(PAINT_BODY), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, inspection: false, texted: false })

    expect(h.runAndSavePaintingQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        customerPhone: '+61400000000',
        request: expect.objectContaining({ address: ADDRESS }),
      }),
    )
    expect(h.autoSendPaintingQuote).not.toHaveBeenCalled()
    expect(h.dispatchQuoteMessage).toHaveBeenCalledWith(expect.objectContaining({ to: '+61400000000', text: expect.stringMatching(/saved and awaiting review/i), deliveryKey: `quote-form:${TOKEN}:status` }))
    expect(leadUpdates().at(-1)?.row).toMatchObject({ quote_token: 'pub-1' })
  })

  it('tells the painter about the lead — a form quote nobody hears about is a dead lead', async () => {
    queueHappy()
    await POST(req(PAINT_BODY), ctx)
    expect(h.persistHumanHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', customerPhone: '+61400000000', resourceType: 'paint', resourceId: 'painting-row' }),
    )
  })

  it("advances painting_state so the receptionist doesn't re-ask a job it just quoted", async () => {
    queueHappy()
    await POST(req(PAINT_BODY), ctx)
    // The thread was pinned at last_step:'offer_form'. Left there, the next
    // customer message restarts the whole painting Q&A on a quoted job.
    const stateUpdate = writesTo('sms_conversations').at(-1)
    expect(stateUpdate?.row).toMatchObject({
      painting_state: expect.objectContaining({ last_step: 'closed', workflow_stage: 'awaiting_review', pending_quote_token: 'pub-1' }),
    })
  })

  it('writes the submission onto the SMS thread so the tradie can see it', async () => {
    queueHappy()
    await POST(req(PAINT_BODY), ctx)
    const msg = writesTo('sms_messages')[0]
    expect(msg?.row).toMatchObject({ conversation_id: 'c1', direction: 'inbound' })
    expect(String(msg?.row.body)).toContain('5 Smith St, Coorparoo')
    expect(String(msg?.row.body)).toContain('Quote request form (painting)')
  })

  it('502s a failed estimate and releases the link back to pending', async () => {
    queueHappy()
    h.runAndSavePaintingQuote.mockResolvedValue({ ok: false, reason: 'no footprint' })
    const res = await POST(req(PAINT_BODY), ctx)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, error: 'estimate_failed' })
    expect(leadUpdates().at(-1)?.row).toMatchObject({ status: 'pending', submitted_at: null })
  })

  it('retains the review task and allows retry when the status SMS is refused', async () => {
    queueHappy()
    h.dispatchQuoteMessage.mockResolvedValue({ ok: false } as never)
    const res = await POST(req(PAINT_BODY), ctx)
    // `texted:false` is what stops the thank-you page saying "your quote is on
    // its way". The release revert itself lives in autoSendPaintingQuote (its
    // own tests cover it) and fires off this same false.
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, error: 'estimate_failed' })
    // The customer hears SOMETHING rather than silence.
    expect(h.persistHumanHandoff).toHaveBeenCalled()
    expect(leadUpdates().at(-1)?.row).toMatchObject({ status: 'pending' })
  })

  it('502s a failed thread write rather than quoting off an unrecorded brief', async () => {
    h.queue('trade_lead_requests', { data: LEAD, error: null }, { data: [{ token: TOKEN }], error: null })
    h.queue('sms_conversations', { data: { to_number: '+61480000000' }, error: null })
    h.queue('sms_messages', { data: null, error: { message: 'PGRST204' } })
    const res = await POST(req(PAINT_BODY), ctx)
    expect(res.status).toBe(502)
    expect(h.runAndSavePaintingQuote).not.toHaveBeenCalled()
    expect(leadUpdates().at(-1)?.row).toMatchObject({ status: 'pending' })
  })
})

describe('POST /api/quote-request/[token] — roofing hand-off', () => {
  const roofLead = { ...LEAD, trade: 'roofing' }

  it('measures through the shared SMS dispatcher and persists the roofing state', async () => {
    queueHappy(roofLead)
    const res = await POST(req(ROOF_BODY), ctx)
    expect(res.status).toBe(200)
    expect(h.measureAndDispatchRoofing).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c1',
        customerPhone: '+61400000000',
        // The deterministic pricer owns the inspection decision — the form
        // must not pre-empt it.
        isInspection: false,
        slots: expect.objectContaining({
          address: '5 Smith St, Coorparoo',
          postcode: '4151',
          state: 'QLD',
          material: 'colorbond_trimdek',
          pitch: 'standard',
          intent: 'full_reroof',
        }),
      }),
    )
    const stateUpdate = writesTo('sms_conversations').at(-1)
    expect(stateUpdate?.row).toMatchObject({ roofing_state: { slots: {}, last_step: 'closed', workflow_stage: 'awaiting_review' } })
    expect(await res.json()).toMatchObject({ texted: false })
  })

  it('passes stable ownership to the dispatcher that persists the roofer review task', async () => {
    queueHappy(roofLead)
    await POST(req(ROOF_BODY), ctx)
    expect(h.measureAndDispatchRoofing).toHaveBeenCalledWith(expect.objectContaining({tenantId:'t1',conversationId:'c1',requestKey:`quote-form:${TOKEN}`}))
    expect(h.notifyRoofingTradie).not.toHaveBeenCalled()
  })

  it('never claims a delivery Twilio refused', async () => {
    queueHappy(roofLead)
    // The roofing link is only ever delivered by this SMS, so a hardcoded
    // `texted: true` told the customer their quote was on its way when the
    // carrier had just refused it and they were getting nothing.
    h.dispatchQuoteMessage.mockResolvedValue({ ok: false } as never)
    const res = await POST(req(ROOF_BODY), ctx)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, error: 'estimate_failed' })
  })

  it('502s a failed measure and releases the link back to pending', async () => {
    queueHappy(roofLead)
    h.measureAndDispatchRoofing.mockResolvedValue({ ok: false, reason: 'provider down' })
    const res = await POST(req(ROOF_BODY), ctx)
    expect(res.status).toBe(502)
    expect(leadUpdates().at(-1)?.row).toMatchObject({ status: 'pending', submitted_at: null })
  })
})

describe('POST /api/quote-request/[token] — electrical / plumbing hand-off', () => {
  it('fires the internal intake pipeline with the shared secret', async () => {
    queueHappy({ ...LEAD, trade: 'electrical' })
    const res = await POST(req(ELEC_BODY), ctx)
    expect(res.status).toBe(200)

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call[0])).toBe('https://quotemax.com.au/api/intake/structure')
    expect(call[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer cron-secret' }),
    })
    expect(JSON.parse(String(call[1].body))).toMatchObject({ conversationId: 'c1', sourceChannel: 'sms' })
  })

  it('seeds the job_type slot so the structurer picks the right trade', async () => {
    queueHappy({ ...LEAD, trade: 'plumbing' })
    await POST(req(PLUMB_BODY), ctx)
    const patch = writesTo('sms_conversations').at(-1)?.row as { conversation_state?: { slots?: { job_type?: string } } }
    expect(patch?.conversation_state?.slots?.job_type).toBe('hot_water')
  })

  it("leaves the job_type slot alone when there is no honest mapping ('other')", async () => {
    queueHappy({ ...LEAD, trade: 'plumbing' })
    await POST(req({ ...PLUMB_BODY, inputs: { job_type: 'other' } }), ctx)
    const patches = writesTo('sms_conversations').map((w) => JSON.stringify(w.row))
    expect(patches.join(' ')).not.toContain('job_type')
  })

  it('502s when the intake pipeline rejects the hand-off', async () => {
    queueHappy({ ...LEAD, trade: 'electrical' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const res = await POST(req(ELEC_BODY), ctx)
    expect(res.status).toBe(502)
    expect(leadUpdates().at(-1)?.row).toMatchObject({ status: 'pending', submitted_at: null })
  })

  it('502s a lead with no SMS thread instead of dropping the enquiry', async () => {
    h.queue(
      'trade_lead_requests',
      { data: { ...LEAD, trade: 'electrical', conversation_id: null }, error: null },
      { data: [{ token: TOKEN }], error: null },
    )
    const res = await POST(req(ELEC_BODY), ctx)
    expect(res.status).toBe(502)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(leadUpdates().at(-1)?.row).toMatchObject({ status: 'pending' })
  })
})
