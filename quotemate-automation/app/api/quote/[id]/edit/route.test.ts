// Regression test for POST /api/quote/[id]/edit — the persisted update MUST
// invalidate the cached customer PDF (quotes.pdf_path) on every edit.
//
// Bug (2026-07-01): a tradie added a "$9000 scaffold" line via the "Edit with
// AI" chat + Save on a roofing quote. It persisted to quotes.good/better/best
// but never appeared in the downloaded PDF. Root cause: the only PDF-regenerate
// call lived inside the `if (shouldNotify)` after() block, so a quote held for
// review (status = 'awaiting_tradie_approval') or a silent save (notify_customer
// = false) persisted the tiers but left the cached PDF untouched. Because
// quotes.pdf_signature captures only template/tier-mode/visible-tiers — NOT
// line-item content (lib/quote/pdf-signature.ts) — the next /api/q/[token]/pdf
// hit served the STALE cached PDF. The fix: null pdf_path (+ pdf_signature) in
// the persisted update so the next download/preview/send regenerates from the
// freshly-saved tiers, regardless of whether the customer is notified now.
//
// Uses a roofing quote so `tradeGroundingMode('roofing') === 'tradie-authored'`
// (lib/quote/report-adapters/registry.ts) skips the catalogue grounding gate —
// matching the real scenario in the bug report.

import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/quote/job-quote-operation', () => ({ readQuoteDraftReadiness: vi.fn(async () => ({ ready: true })) }))

type Row = unknown
const state: {
  user: { id: string } | null
  userErr: unknown
  quote: Row
  tenant: Row
  pricingBook: Row
  /** Multi-row pricing_book fixture — when set, the mock honours an
   *  eq('trade', …) filter and returns the FIRST row when unfiltered. */
  pricingBooks?: Row[]
  intake: Row
  updErr: unknown
  quoteErr?: unknown
  raceOnSave?: boolean
  version?: Row
} = {
  user: null,
  userErr: null,
  quote: undefined,
  tenant: undefined,
  pricingBook: undefined,
  intake: undefined,
  updErr: null,
}

// Captures the payload passed to quotes.update(...) so the test can assert the
// PDF cache was invalidated.
const captured: { quotesUpdate: Record<string, unknown> | null; callbacks: Array<() => unknown>; effects: string[] } = { quotesUpdate: null, callbacks: [], effects: [] }

vi.mock('next/server', () => ({
  // Held-quote / silent-save edits take the no-notify path, so after() never
  // fires in this test; noop is enough and keeps the notify block out.
  after: (_cb: () => unknown) => {
    captured.callbacks.push(_cb)
  },
}))

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
                : table === 'quote_pricing_versions' ? state.version : null
      const builder: Record<string, unknown> = {}
      const filters: Record<string, unknown> = {}
      const chain = () => builder
      builder.select = chain
      builder.eq = (col: string, val: unknown) => {
        filters[col] = val
        return builder
      }
      builder.limit = chain
      let update: Record<string, unknown> | null = null
      builder.is = builder.eq
      builder.maybeSingle = async () => {
        if (update) {
          captured.effects.push('save')
          if (state.raceOnSave) { (state.quote as Record<string, unknown>).paid_at = 'paid'; state.raceOnSave = false }
          if (state.updErr) return { data: null, error: state.updErr }
          const current = state.quote as Record<string, unknown>
          if (!current || Object.entries(filters).some(([key, value]) => {
            const actual = current[key] ?? null
            return typeof actual === 'object' && actual !== null
              ? JSON.stringify(actual) !== value : actual !== value
          })) return { data: null, error: null }
          state.quote = { ...current, ...structuredClone(update) }
          captured.quotesUpdate = { ...captured.quotesUpdate, ...structuredClone(update) }
          return { data: structuredClone(state.quote), error: null }
        }
        if (table === 'pricing_book' && Array.isArray(state.pricingBooks)) {
          const rows = state.pricingBooks.filter((r) => Object.entries(filters).every(
            ([key, value]) => (r as Record<string, unknown>)[key] === value,
          ))
          return { data: rows.length === 1 ? rows[0] : null, error: rows.length > 1 ? { message: 'multiple rows' } : null }
        }
        return { data: structuredClone(data), error: table === 'quotes' ? state.quoteErr : null }
      }
      builder.update = (body: Record<string, unknown>) => { update = body; return builder }
      builder.insert = async () => ({ error: null })
      return builder
    },
  }),
}))

vi.mock('@/lib/stripe/checkout', () => ({
  expireCheckoutSession: vi.fn(async () => { captured.effects.push('expire'); return { ok: true } }),
  createCheckoutSessionForTier: vi.fn(async () => { captured.effects.push('mint'); return 'https://stripe.test/session/better' }),
}))

vi.mock('@/lib/quote/pdf', () => ({
  ensureQuotePdf: vi.fn(async () => 'quotes/q1.pdf'),
  quotePdfUrl: () => 'https://app.test/api/q/tok/pdf',
  signQuotePdfUrl: vi.fn(async () => 'https://signed.test/q1.pdf'),
}))

vi.mock('@/lib/sms/send-quote-pdf', () => ({
  dispatchQuoteWithPdf: vi.fn(async () => ({ ok: true, channel: 'sms', sid: 'SM1' })),
}))
vi.mock('@/lib/filestore/ingest-quote', () => ({ archiveAndIngestQuote: vi.fn(async () => {}) }))
vi.mock('@/lib/filestore/minimize', () => ({
  buildQuoteKbText: () => ({ markdown: '', contentHash: 'h' }),
}))
vi.mock('@/lib/estimate/run', () => ({
  loadCandidatePrices: vi.fn(async () => ({ material: [], assembly: [] })),
}))
vi.mock('@/lib/estimate/validate', () => ({
  validateQuoteGrounding: () => ({ valid: true }),
  detectCrossTierDuplicates: () => [],
  isManualLine: () => false,
}))

import { POST } from './route'
import { createCheckoutSessionForTier, expireCheckoutSession } from '@/lib/stripe/checkout'
import { dispatchQuoteWithPdf } from '@/lib/sms/send-quote-pdf'
import { quoteEditRevision } from '@/lib/quote/edit-authority'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'

const params = { params: Promise.resolve({ id: 'q1' }) }

function req(body?: unknown, bearer?: string) {
  return new Request('http://localhost/api/quote/q1/edit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

// A roofing G/B/B quote HELD for tradie review — the exact state where the bug
// bit: it persists the edit but takes the no-notify branch.
function roofingTier(label: string, desc: string) {
  return {
    label,
    subtotal_ex_gst: 110352,
    line_items: [
      { description: desc, quantity: 968, unit: 'm²', unit_price_ex_gst: 114, total_ex_gst: 110352 },
    ],
  }
}

// Adds a "$9000 scaffold" line to the Better tier (a real price change).
const EDIT_BODY = {
  better: {
    label: 'Re-roof',
    line_items: [
      { description: 'Re-roof priced across 2 structures.', quantity: 968, unit: 'm²', unit_price_ex_gst: 114 },
      { description: 'Scaffold supply and setup.', quantity: 1, unit_price_ex_gst: 9000 },
    ],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  captured.quotesUpdate = null
  captured.callbacks = []
  captured.effects = []
  state.raceOnSave = false
  state.quoteErr = null
  state.user = { id: 'owner-1' }
  state.userErr = null
  state.updErr = null
  state.quote = {
    id: 'q1',
    tenant_id: 't1',
    intake_id: 'i1',
    share_token: 'tok_abc12345',
    status: 'awaiting_tradie_approval',
    paid_at: null,
    selected_tier: 'better',
    good: roofingTier('Patch / repair', 'Patch / repair priced across 2 structures.'),
    better: roofingTier('Re-roof', 'Re-roof priced across 2 structures.'),
    best: roofingTier('Upgrade', 'Upgrade priced across 2 structures.'),
    stripe_links: {},
    total_inc_gst: 121387.2,
    needs_inspection: false,
    inspection_reason: null,
    estimated_timeframe: null,
    risk_flags: [],
    applied_discount_pct: 0,
    deposit_pct: 30,
    scope_of_works: null,
    assumptions: null,
    pdf_path: 'quotes/q1.pdf',
    pdf_signature: 'v3|single|t=better|r=',
  }
  state.tenant = { id: 't1', owner_user_id: 'owner-1' }
  // Roofing is a tradie-authored trade → no catalogue, sparse book is fine.
  state.pricingBook = { id: 'pb1', tenant_id: 't1', trade: 'roofing', gst_registered: true }
  state.pricingBooks = undefined
  state.version = null
  state.intake = { tenant_id: 't1', trade: 'roofing', job_type: 'reroof', caller: null, scope: null }
})

describe('POST /api/quote/[id]/edit — pricing book is scoped to the quote trade', () => {
  it('retains captured GST after the current book is deleted', async () => {
    const quote = state.quote as Record<string, unknown>
    quote.pricing_book_version_id = 'v1'
    quote.total_inc_gst = 110352
    state.version = { id: 'v1', tenant_id: 't1', trade: 'roofing', pricing_book_id: 'old', content_hash: 'a'.repeat(64),
      snapshot: { id: 'old', tenant_id: 't1', trade: 'roofing', gst_registered: false } }
    state.pricingBook = null
    const response = await POST(req(EDIT_BODY, 'tok'), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ gst_registered: false, persisted: true })
    expect(captured.quotesUpdate?.total_inc_gst).toBe(119352)
    expect((state.quote as Record<string, unknown>).pricing_book_version_id).toBe('v1')
  })
  it.each(['quote_draft_processing', 'quote_draft_unconfirmed'] as const)('blocks %s before write/provider', async code => {
    vi.mocked(readQuoteDraftReadiness).mockResolvedValueOnce({ ready: false, code })
    expect(await (await POST(req(EDIT_BODY, 'tok'), params)).json()).toMatchObject({ error: code })
    expect(captured.effects).toEqual([])
  })
  it("reads the INTAKE trade's row, not whichever row limit(1) returns first", async () => {
    // Multi-trade tenant, plumbing row FIRST — live shape (Atomic): an
    // unscoped .eq('tenant_id').limit(1) read returns the plumbing row, so
    // this electrical quote's GST recompute and grounding rates came from
    // the wrong trade's book (audit 2026-07-23). The draft route and the
    // customer page are trade-scoped; the edit route must match.
    state.pricingBooks = [
      { id: 'pb-plumbing', tenant_id: 't1', trade: 'plumbing', gst_registered: false, hourly_rate: 120, default_markup_pct: 18 },
      { id: 'pb-electrical', tenant_id: 't1', trade: 'electrical', gst_registered: true, hourly_rate: 110, default_markup_pct: 30 },
    ]
    state.intake = { tenant_id: 't1', trade: 'electrical', job_type: 'downlights', caller: null, scope: null }

    const res = await POST(req(EDIT_BODY, 'tok'), params)
    expect(res.status).toBe(200)
    expect(captured.quotesUpdate).not.toBeNull()

    // gst_registered comes from the ELECTRICAL row (true) → the persisted
    // headline total carries GST. The plumbing-first unscoped read (false)
    // would persist total === subtotal exactly.
    const better = captured.quotesUpdate!.better as { subtotal_ex_gst: number }
    const total = captured.quotesUpdate!.total_inc_gst as number
    expect(total).toBeCloseTo(+(better.subtotal_ex_gst * 1.1).toFixed(2), 2)
  })
})

describe('POST /api/quote/[id]/edit — the tier mint is trade-gated (spec elec-plumb-site-visit-first)', () => {
  // The retired path: for these two trades /r/<token>/<G|B|B> 302s onto the
  // inspection mint and nothing exposes stripe_links[tier], so re-minting a
  // Session on every edit burns a Stripe call and writes a dead link.
  it.each(['electrical', 'plumbing'])(
    '%s: drops + expires the stale tier links and mints NOTHING',
    async (trade) => {
      state.intake = { tenant_id: 't1', trade, job_type: 'downlights', caller: null, scope: null }
      // Catalogue trades require a COMPLETE book (route: the grounding validator
      // grades edits against it) — a sparse row 409s before the mint loop.
      state.pricingBook = { id: 'pb1', tenant_id: 't1', trade, gst_registered: true, hourly_rate: 110, default_markup_pct: 30 }
      ;(state.quote as Record<string, unknown>).stripe_links = {
        good: 'https://stripe.test/old-good',
        better: 'https://stripe.test/old-better',
        inspection: 'https://stripe.test/site-visit',
      }

      const res = await POST(req(EDIT_BODY, 'tok'), params)
      expect(res.status).toBe(200)

      expect(vi.mocked(createCheckoutSessionForTier)).not.toHaveBeenCalled()
      // Only the CHANGED tier's stale Session is expired…
      expect(vi.mocked(expireCheckoutSession).mock.calls.map((c) => c[0])).toEqual([
        'https://stripe.test/old-better',
      ])
      // …and the live $99 link survives, along with untouched tiers.
      expect(captured.quotesUpdate!.stripe_links).toEqual({
        good: 'https://stripe.test/old-good',
        inspection: 'https://stripe.test/site-visit',
      })
    },
  )

  it.each(['solar', 'commercial_painting'])(
    '%s: still re-mints the tier Session exactly as before',
    async (trade) => {
      state.intake = { tenant_id: 't1', trade, job_type: 'other', caller: null, scope: null }
      state.pricingBook = { id: 'pb1', tenant_id: 't1', trade, gst_registered: true }
      ;(state.quote as Record<string, unknown>).stripe_links = {
        better: 'https://stripe.test/old-better',
      }

      const res = await POST(req(EDIT_BODY, 'tok'), params)
      expect(res.status).toBe(200)

      expect(vi.mocked(createCheckoutSessionForTier)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(expireCheckoutSession).mock.calls.map((c) => c[0])).toEqual([
        'https://stripe.test/old-better',
      ])
      expect(captured.quotesUpdate!.stripe_links).toEqual({
        better: 'https://stripe.test/session/better',
      })
    },
  )

  it('a trade-less legacy row requires review and never re-mints', async () => {
    state.intake = { tenant_id: 't1', trade: null, job_type: 'other', caller: null, scope: null }
    const res = await POST(req(EDIT_BODY, 'tok'), params)
    expect(res.status).toBe(409)
    expect(vi.mocked(createCheckoutSessionForTier)).not.toHaveBeenCalled()
  })
})

describe('POST /api/quote/[id]/edit — cached PDF invalidation', () => {
  it('nulls quotes.pdf_path on a held-quote edit so the stale PDF regenerates', async () => {
    const res = await POST(req(EDIT_BODY, 'tok'), params)
    expect(res.status).toBe(200)

    // Sanity: the edit persisted and the Better subtotal picked up the +$9000.
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.changedTiers).toContain('better')

    // The bug: without this, the persisted update leaves pdf_path pointing at
    // the pre-edit PDF, and pdf_signature (which ignores line items) still
    // matches — so /api/q/[token]/pdf keeps serving the stale document.
    expect(captured.quotesUpdate).not.toBeNull()
    expect(captured.quotesUpdate!.pdf_path).toBeNull()
    expect(captured.quotesUpdate!.pdf_signature).toBeNull()
  })
})

describe('POST edit — revision, provenance and delivery boundaries', () => {
  it('keeps an initial quiet price save as draft and sends nothing', async () => {
    Object.assign(state.quote as object, { status: 'draft', quote_kind: 'initial' })
    const response = await POST(req({ ...EDIT_BODY, notify_customer: false }, 'tok'), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ persisted: true, notification_requested: false })
    expect(captured.quotesUpdate?.status).toBe('draft')
    expect(captured.callbacks).toHaveLength(0)
    expect(dispatchQuoteWithPdf).not.toHaveBeenCalled()
  })

  it.each(['awaiting_tradie_approval', 'draft'])('does not send a final child in %s on edit', async (status) => {
    Object.assign(state.quote as object, { status, quote_kind: 'final' })
    const response = await POST(req({ ...EDIT_BODY, notify_customer: true }, 'tok'), params)
    expect(response.status).toBe(200)
    expect(captured.quotesUpdate?.status).toBe(status)
    expect(captured.callbacks).toHaveLength(0)
    expect(createCheckoutSessionForTier).not.toHaveBeenCalled()
  })

  it('rejects a payment arriving at the conditional save before any checkout or send', async () => {
    state.raceOnSave = true
    const response = await POST(req(EDIT_BODY, 'tok'), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'quote_changed' })
    expect(captured.quotesUpdate).toBeNull()
    expect(captured.effects).toEqual(['save'])
    expect(captured.callbacks).toHaveLength(0)
  })

  it('rejects a stale client revision before writes and provider work', async () => {
    const response = await POST(req({ ...EDIT_BODY, expected_revision: 'a'.repeat(64) }, 'tok'), params)
    expect(response.status).toBe(409)
    expect(captured.effects).toEqual([])
  })

  it('preserves exact owned provenance through rename, reorder and saved readback', async () => {
    const quote = state.quote as Record<string, unknown>
    const tier = quote.better as { line_items: Array<Record<string, unknown>> }
    Object.assign(tier.line_items[0], { source: 'material:stored-id', supplied_by: 'customer', safety_note: 'Use AU-certified equipment.' })
    const revision = quoteEditRevision(quote)
    const response = await POST(req({ expected_revision: revision, notify_customer: false, better: {
      label: 'Revised roof', line_items: [{ original_line_index: 0, description: 'Renamed existing work', quantity: 968, unit: 'job', unit_price_ex_gst: 114 }],
    } }, 'tok'), params)
    expect(response.status).toBe(200)
    const saved = (state.quote as typeof quote).better as typeof tier
    expect(saved.line_items[0]).toMatchObject({ description: 'Renamed existing work', source: 'material:stored-id', supplied_by: 'customer', safety_note: 'Use AU-certified equipment.' })
    expect(saved.line_items[0]).not.toHaveProperty('original_line_index')
    expect(await response.json()).toMatchObject({ edit_revision: quoteEditRevision(state.quote as Record<string, unknown>) })
  })

  it.each([
    { source: 'material:injected' }, { supplied_by: 'customer' }, { safety_note: 'Forged safety claim' },
  ])('rejects conflicting injected provenance %j', async (injected) => {
    const response = await POST(req({ expected_revision: quoteEditRevision(state.quote as Record<string, unknown>), better: {
      label: 'Re-roof', line_items: [{ ...EDIT_BODY.better.line_items[0], original_line_index: 0, ...injected }],
    } }, 'tok'), params)
    expect(response.status).toBe(409)
    expect(captured.effects).toEqual([])
  })

  it('rejects duplicate original line identities', async () => {
    const line = { ...EDIT_BODY.better.line_items[0], original_line_index: 0 }
    const response = await POST(req({ expected_revision: quoteEditRevision(state.quote as Record<string, unknown>), better: {
      label: 'Re-roof', line_items: [line, line],
    } }, 'tok'), params)
    expect(response.status).toBe(400)
    expect(captured.effects).toEqual([])
  })

  it('requires a revision to use persisted line indices', async () => {
    const response = await POST(req({ better: { label: 'Re-roof', line_items: [{ ...EDIT_BODY.better.line_items[0], original_line_index: 0 }] } }, 'tok'), params)
    expect(response.status).toBe(400)
    expect(captured.effects).toEqual([])
  })

  it('preserves historically unregistered tax after current settings change', async () => {
    Object.assign(state.quote as object, { total_inc_gst: 110352 })
    const response = await POST(req({ ...EDIT_BODY, notify_customer: false }, 'tok'), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ gst_registered: false, total_inc_gst: 119352 })
    expect(vi.mocked(createCheckoutSessionForTier).mock.calls[0][0].quote.gst_registered).toBe(false)
  })

  it.each([null, 'true', undefined])('rejects absent or invalid owned GST %s', async (gst_registered) => {
    Object.assign(state.pricingBook as object, { gst_registered })
    expect((await POST(req(EDIT_BODY, 'tok'), params)).status).toBe(409)
    expect(captured.effects).toEqual([])
  })

  it('fails review on historical whole-dollar total that cannot establish exact GST', async () => {
    Object.assign(state.quote as object, { total_inc_gst: 121387 })
    expect((await POST(req(EDIT_BODY, 'tok'), params)).status).toBe(409)
    expect(captured.effects).toEqual([])
  })

  it('never stamps a requested notification Sent before provider acceptance', async () => {
    Object.assign(state.quote as object, { status: 'draft' })
    Object.assign(state.intake as object, { caller: { phone: '+61400000000' } })
    const response = await POST(req({ ...EDIT_BODY, notify_customer: true }, 'tok'), params)
    expect(response.status).toBe(200)
    expect((state.quote as Record<string, unknown>).status).toBe('draft')
    expect(captured.callbacks).toHaveLength(1)
    await captured.callbacks[0]()
    expect(dispatchQuoteWithPdf).toHaveBeenCalledTimes(1)
    expect((state.quote as Record<string, unknown>).status).toBe('sent')
    expect(captured.effects[0]).toBe('save')
  })

  it('keeps draft when notification fails', async () => {
    Object.assign(state.quote as object, { status: 'draft' })
    Object.assign(state.intake as object, { caller: { phone: '+61400000000' } })
    vi.mocked(dispatchQuoteWithPdf).mockResolvedValueOnce({ ok: false, smsAttempt: { code: 1, reason: 'failed' } } as never)
    await POST(req({ ...EDIT_BODY, notify_customer: true }, 'tok'), params)
    await captured.callbacks[0]()
    expect((state.quote as Record<string, unknown>).status).toBe('draft')
  })

  it('surfaces an acknowledged save with pending checkout reconciliation on provider failure', async () => {
    vi.mocked(createCheckoutSessionForTier).mockRejectedValueOnce(new Error('network lost'))
    const response = await POST(req({ ...EDIT_BODY, notify_customer: true }, 'tok'), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ persisted: true, checkout_sync: 'pending', notification_requested: false })
    expect(captured.callbacks).toHaveLength(0)
  })
  it.each(['roofing', 'electrical'])('keeps checkout pending for a resolved expiry failure on %s', async (trade) => {
    Object.assign(state.intake as object, { trade })
    Object.assign(state.pricingBook as object, { trade, hourly_rate: 100, default_markup_pct: 20 })
    Object.assign(state.quote as object, { stripe_links: { better: 'old-session' }, status: 'draft' })
    vi.mocked(expireCheckoutSession).mockResolvedValueOnce({ ok: false, reason: 'network_error' } as never)
    const response = await POST(req({ ...EDIT_BODY, notify_customer: true }, 'tok'), params)
    expect(await response.json()).toMatchObject({ persisted: true, checkout_sync: 'pending', notification_requested: false })
    expect(captured.callbacks).toHaveLength(0)
    expect(createCheckoutSessionForTier).not.toHaveBeenCalled()
  })
  it.each(['roofing', 'electrical'])('keeps checkout pending for a rejected expiry on %s', async (trade) => {
    Object.assign(state.intake as object, { trade })
    Object.assign(state.pricingBook as object, { trade, hourly_rate: 100, default_markup_pct: 20 })
    Object.assign(state.quote as object, { stripe_links: { better: 'old-session' }, status: 'draft' })
    vi.mocked(expireCheckoutSession).mockRejectedValueOnce(new Error('network lost'))
    const response = await POST(req({ ...EDIT_BODY, notify_customer: true }, 'tok'), params)
    expect(await response.json()).toMatchObject({ persisted: true, checkout_sync: 'pending', notification_requested: false })
    expect(captured.callbacks).toHaveLength(0)
    expect(createCheckoutSessionForTier).not.toHaveBeenCalled()
  })
  it('keeps checkout pending when the required replacement mint returns null', async () => {
    Object.assign(state.quote as object, { status: 'draft' })
    vi.mocked(createCheckoutSessionForTier).mockResolvedValueOnce(null)
    const response = await POST(req({ ...EDIT_BODY, notify_customer: true }, 'tok'), params)
    expect(await response.json()).toMatchObject({ persisted: true, checkout_sync: 'pending', notification_requested: false })
    expect(captured.callbacks).toHaveLength(0)
  })
  it.each([10, 50])('preserves the stored %s percent deposit in replacement checkout', async (deposit_pct) => {
    Object.assign(state.quote as object, { deposit_pct })
    expect((await POST(req({ ...EDIT_BODY, notify_customer: false }, 'tok'), params)).status).toBe(200)
    expect(vi.mocked(createCheckoutSessionForTier).mock.calls[0][0].quote.deposit_pct).toBe(deposit_pct)
  })
  it.each([undefined, null, '30', 0, 100])('rejects invalid or missing stored deposit %s before financial mutation', async (deposit_pct) => {
    Object.assign(state.quote as object, { deposit_pct })
    expect((await POST(req(EDIT_BODY, 'tok'), params)).status).toBe(409)
    expect(captured.effects).toEqual([])
  })
  it('calculates line total from the exact cent-rounded unit price it stores', async () => {
    const response = await POST(req({ better: { label: 'Re-roof', line_items: [
      { description: 'Manual work', quantity: 3, unit: 'job', unit_price_ex_gst: 1.234 },
    ] }, notify_customer: false }, 'tok'), params)
    expect(response.status).toBe(200)
    expect(((state.quote as Record<string, unknown>).better as { line_items: unknown[] }).line_items[0]).toMatchObject({ unit_price_ex_gst: 1.23, total_ex_gst: 3.69 })
  })
  it.each([null, '', ' ', true])('rejects invalid numeric value %j before saving a mixed positive tier', async (value) => {
    for (const field of ['quantity', 'unit_price_ex_gst']) {
      const response = await POST(req({ better: { label: 'Re-roof', line_items: [
        ...EDIT_BODY.better.line_items, { description: 'Missing price', quantity: 1, unit_price_ex_gst: 100, [field]: value },
      ] }, notify_customer: false }, 'tok'), params)
      expect(response.status).toBe(400)
    }
    expect(captured.effects).toEqual([])
  })
  it.each([0, '0', '12.25'])('accepts explicit numeric price %j in a positive tier', async (value) => {
    const response = await POST(req({ better: { label: 'Re-roof', line_items: [
      ...EDIT_BODY.better.line_items, { description: 'Explicit price', quantity: 1, unit_price_ex_gst: value },
    ] }, notify_customer: false }, 'tok'), params)
    expect(response.status).toBe(200)
  })
})
