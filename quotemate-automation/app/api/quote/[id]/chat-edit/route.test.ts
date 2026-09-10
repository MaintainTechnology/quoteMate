// Guard tests for POST /api/quote/[id]/chat-edit. Supabase, the candidate
// loader, and the AI proposer are mocked so the route's auth + pre-condition
// gates are exercised without a live DB or model call. Mirrors the auth/guard
// contract of POST /api/quote/[id]/edit (spec R2/R3 + edge cases).

import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/quote/job-quote-operation', () => ({ readQuoteDraftReadiness: vi.fn(async () => ({ ready: true })) }))

type Row = unknown
const state: {
  user: { id: string } | null
  userErr: unknown
  quote: Row
  tenant: Row
  pricingBook: Row
  intake: Row
} = {
  user: null,
  userErr: null,
  quote: undefined,
  tenant: undefined,
  pricingBook: undefined,
  intake: undefined,
}

// Tripwire — any write method invoked on the Supabase client flips this. The
// chat-edit endpoint must persist NOTHING (spec DoD), so a happy-path request
// that trips this is a failure.
const mutated = { called: false }

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: state.userErr }),
    },
    from: (table: string) => {
      const data =
        table === 'quotes'
          ? state.quote
          : table === 'tenants'
            ? state.tenant
            : table === 'pricing_book'
              ? state.pricingBook
              : table === 'intakes'
                ? state.intake
                : null
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      builder.select = chain
      builder.eq = chain
      builder.limit = chain
      builder.maybeSingle = async () => ({ data })
      // Read-only contract: record (don't silently no-op) any write attempt.
      const mark = () => {
        mutated.called = true
        return builder
      }
      builder.insert = mark
      builder.update = mark
      builder.upsert = mark
      builder.delete = mark
      return builder
    },
  }),
}))

vi.mock('@/lib/estimate/run', () => ({
  loadCandidatePrices: vi.fn(async () => ({ material: [], assembly: [] })),
}))
vi.mock('@/lib/quote/chat-edit', () => ({
  proposeQuoteEdit: vi.fn(async () => ({
    assistantMessage: 'ok',
    proposedTiers: {},
    diff: [],
    anyUngrounded: false,
  })),
}))

import { POST } from './route'
import { quoteEditRevision } from '@/lib/quote/edit-authority'
import { proposeQuoteEdit } from '@/lib/quote/chat-edit'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'

const params = { params: Promise.resolve({ id: 'q1' }) }

function req(body?: unknown, bearer?: string) {
  return new Request('http://localhost/api/quote/q1/chat-edit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const VALID_BODY = { instruction: 'add a downlight to better' }

it.each(['quote_draft_processing', 'quote_draft_unconfirmed'] as const)('blocks %s before model proposal', async code => {
  vi.mocked(readQuoteDraftReadiness).mockResolvedValueOnce({ ready: false, code })
  expect(await (await POST(req(VALID_BODY, 'tok'), params)).json()).toMatchObject({ error: code })
  expect(proposeQuoteEdit).not.toHaveBeenCalled()
  expect(mutated.called).toBe(false)
})

beforeEach(() => {
  vi.clearAllMocks()
  mutated.called = false
  state.user = { id: 'owner-1' }
  state.userErr = null
  state.quote = {
    id: 'q1',
    tenant_id: 't1',
    intake_id: 'i1',
    paid_at: null,
    needs_inspection: false,
    good: null,
    better: { label: 'Better', subtotal_ex_gst: 100, line_items: [] },
    total_inc_gst: 110,
    best: null,
    scope_of_works: null,
    assumptions: null,
  }
  state.tenant = { id: 't1', owner_user_id: 'owner-1' }
  state.pricingBook = {
    id: 'pb1', tenant_id: 't1', gst_registered: true,
    trade: 'electrical',
    hourly_rate: 110,
    apprentice_rate: 75,
    senior_rate: 140,
    call_out_minimum: 120,
    default_markup_pct: 28,
    min_labour_hours: 2,
    after_hours_multiplier: null,
  }
  state.intake = { tenant_id: 't1', trade: 'electrical' }
})

describe('POST /api/quote/[id]/chat-edit — guards', () => {
  it('401 without a bearer token', async () => {
    const res = await POST(req(VALID_BODY), params)
    expect(res.status).toBe(401)
  })

  it('401 when the token resolves to no user', async () => {
    state.user = null
    const res = await POST(req(VALID_BODY, 'tok'), params)
    expect(res.status).toBe(401)
  })

  it('400 on an empty/invalid body', async () => {
    const res = await POST(req({}, 'tok'), params)
    expect(res.status).toBe(400)
  })

  it('404 when the quote does not exist', async () => {
    state.quote = null
    const res = await POST(req(VALID_BODY, 'tok'), params)
    expect(res.status).toBe(404)
  })

  it('409 when the quote is already paid', async () => {
    state.quote = { ...(state.quote as object), paid_at: '2026-06-01T00:00:00Z' }
    const res = await POST(req(VALID_BODY, 'tok'), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('quote_already_paid')
  })

  it('409 when the quote needs inspection', async () => {
    state.quote = { ...(state.quote as object), needs_inspection: true }
    const res = await POST(req(VALID_BODY, 'tok'), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('cannot_edit_inspection_quote')
  })

  it('403 when the caller is not the tenant owner', async () => {
    // New model: the caller resolves to their OWN tenant (a different tenant than
    // the quote's t1), so quote.tenant_id !== resolved tenant id → not_owner.
    state.tenant = { id: 'other-tenant', owner_user_id: 'owner-1' }
    const res = await POST(req(VALID_BODY, 'tok'), params)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('not_owner')
  })

  it('409 when the pricing book is misconfigured', async () => {
    state.pricingBook = { trade: 'electrical', hourly_rate: null, default_markup_pct: null }
    const res = await POST(req(VALID_BODY, 'tok'), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('quote_pricing_review_required')
  })

  it('200 and ok:true on the happy path, and persists nothing', async () => {
    const res = await POST(req(VALID_BODY, 'tok'), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty('diff')
    expect(body).toHaveProperty('proposedTiers')
    // DoD: no DB write occurs on a chat-edit request.
    expect(mutated.called).toBe(false)
  })
})

describe('chat proposal source and identity boundary', () => {
  it.each([null, '', ' '])('rejects stored missing/blank money %j without model work', async (value) => {
    for (const field of ['quantity', 'unit_price_ex_gst']) {
      Object.assign(state.quote as object, { better: { label: 'Better', subtotal_ex_gst: 100, line_items: [
        { description: 'Valid work', quantity: 1, unit_price_ex_gst: 100 },
        { description: 'Invalid stored price', quantity: 1, unit_price_ex_gst: 10, [field]: value },
      ] } })
      expect((await POST(req(VALID_BODY, 'tok'), params)).status).toBe(409)
    }
    expect(proposeQuoteEdit).not.toHaveBeenCalled()
  })
  it('retains an explicit stored zero in the model input', async () => {
    Object.assign(state.quote as object, { better: { label: 'Better', subtotal_ex_gst: 100, line_items: [
      { description: 'Included service', quantity: 1, unit_price_ex_gst: 0 },
    ] } })
    expect((await POST(req(VALID_BODY, 'tok'), params)).status).toBe(200)
    expect(vi.mocked(proposeQuoteEdit).mock.calls[0][0].currentTiers.better?.line_items[0].unit_price_ex_gst).toBe(0)
  })
  it.each([null, '', ' ', true])('rejects missing/invalid numeric current-tier values %j before model work', async (value) => {
    const response = await POST(req({ ...VALID_BODY, currentTiers: { better: { label: 'Better', line_items: [
      { description: 'Existing work', quantity: 1, unit_price_ex_gst: value },
    ] } } }, 'tok'), params)
    expect(response.status).toBe(400)
    expect(proposeQuoteEdit).not.toHaveBeenCalled()
  })
  it('passes stored supplier and safety provenance with exact line index to the proposer', async () => {
    const quote = state.quote as Record<string, unknown>
    quote.better = { label: 'Better', subtotal_ex_gst: 100, line_items: [
      { description: 'Customer fitting', quantity: 1, unit: 'ea', unit_price_ex_gst: 100,
        source: 'material:owned-id', supplied_by: 'customer', safety_note: 'AU certified only.' },
    ] }
    const response = await POST(req(VALID_BODY, 'tok'), params)
    expect(response.status).toBe(200)
    expect(vi.mocked(proposeQuoteEdit).mock.calls[0][0].currentTiers.better?.line_items[0]).toMatchObject({
      original_line_index: 0, supplied_by: 'customer', safety_note: 'AU certified only.', source: 'material:owned-id',
    })
    expect(await response.json()).toMatchObject({ edit_revision: quoteEditRevision(quote) })
    expect(mutated.called).toBe(false)
  })
  it('rejects stale currentTiers before candidate or model work', async () => {
    const response = await POST(req({ ...VALID_BODY, expected_revision: 'a'.repeat(64) }, 'tok'), params)
    expect(response.status).toBe(409)
    expect(proposeQuoteEdit).not.toHaveBeenCalled()
  })
  it('rejects injected supplier metadata instead of passing it to the proposer', async () => {
    const response = await POST(req({ ...VALID_BODY, currentTiers: { better: {
      label: 'Better', line_items: [{ description: 'Invented fitting', quantity: 1, unit: 'ea', unit_price_ex_gst: 100, supplied_by: 'customer' }],
    } } }, 'tok'), params)
    expect(response.status).toBe(409)
    expect(proposeQuoteEdit).not.toHaveBeenCalled()
  })
})
