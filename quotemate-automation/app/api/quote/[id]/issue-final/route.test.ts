import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({
  rows: [] as Row[], book: null as Row | null, versions: [] as Row[], intake: {} as Row,
  tenant: null as Row | null, captures: [] as Row[], inserts: [] as Row[],
  captureError: null as { message: string } | null, insertError: false, loseAck: false,
}))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => state.tenant ? { tenant: state.tenant } : null }))
vi.mock('@/lib/stripe/checkout', () => ({ generateShareToken: () => 'new-final-link' }))
vi.mock('@/lib/log/pipeline', () => ({ pipelineLog: () => ({ ok: vi.fn(), err: vi.fn() }) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  rpc: async (_name: string, body: Row) => {
    if (_name === 'prepare_final_quote') {
      const existing = state.rows.find(row => row.parent_quote_id === body.p_parent_id && row.quote_kind === 'final')
      if (existing?.paid_at) return { data: { status: 'final_already_paid' }, error: null }
      if (existing) return { data: { status: 'ready', already: true, quote: existing }, error: null }
      if (!body.p_child) return { data: { status: 'needs_creation' }, error: null }
      if (state.insertError) return { data: null, error: { message: 'write rejected' } }
      const inserted = body.p_child as Row
      state.inserts.push(structuredClone(inserted))
      const saved = { id: 'child', ...inserted }
      state.rows.push(saved)
      return { data: state.loseAck ? null : { status: 'ready', already: false, quote: saved }, error: null }
    }
    state.captures.push(body)
    if (state.captureError) return { data: null, error: state.captureError }
    const captured = { id: 'new-version', tenant_id: body.p_tenant_id, trade: body.p_trade,
      pricing_book_id: body.p_book_id, snapshot: structuredClone(body.p_expected_book), content_hash: 'a'.repeat(64) }
    state.versions.push(captured)
    return { data: captured, error: null }
  },
  from: (table: string) => {
    const filters: Array<(row: Row) => boolean> = []
    let inserted: Row | null = null
    const values = () => (table === 'quotes' ? state.rows : table === 'pricing_book' ? state.book ? [state.book] : []
      : table === 'quote_pricing_versions' ? state.versions : [state.intake]).filter(row => filters.every(test => test(row)))
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query },
      is: (key: string, value: unknown) => { filters.push(row => (row[key] ?? null) === value); return query },
      not: (key: string, _op: string, value: unknown) => { filters.push(row => (row[key] ?? null) !== value); return query },
      limit: () => query,
      insert: (row: Row) => { inserted = row; return query },
      maybeSingle: async () => {
        if (inserted) {
          if (state.insertError) return { data: null, error: { message: 'write rejected' } }
          state.inserts.push(structuredClone(inserted))
          const saved = { id: 'child', ...inserted }
          state.rows.push(saved)
          return { data: state.loseAck ? null : saved, error: null }
        }
        return { data: values()[0] ?? null, error: null }
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: values(), error: null }).then(resolve),
    }
    return query
  },
}) }))
import { POST } from './route'

function parent() { return state.rows[0] }
function post() { return POST(new Request('https://example.test/api/quote/parent/issue-final', { method: 'POST' }), { params: Promise.resolve({ id: 'parent' }) }) }
beforeEach(() => {
  state.rows = [{ id: 'parent', tenant_id: 't1', intake_id: 'i1', quote_kind: 'initial', paid_at: 'paid',
    paid_tier: 'inspection', selected_tier: null, good: null, better: null, best: null }]
  state.book = { id: 'book', tenant_id: 't1', trade: 'electrical', gst_registered: false,
    hourly_rate: 125, overlays: { deposit_pct_by_job_type: { ev_charger: 50 } } }
  state.intake = { id: 'i1', tenant_id: 't1', trade: 'electrical', job_type: 'ev_charger' }
  state.tenant = { id: 't1', stripe_connect_account_id: 'acct_t1', stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true }
  state.versions = []; state.captures = []; state.inserts = []
  state.captureError = null; state.insertError = false; state.loseAck = false
})

describe('issue final — version binding at actual route/database action boundary', () => {
  it.each([true, false])('captures owned GST %s before creating an explicitly zero-priced final draft', async gst => {
    state.book!.gst_registered = gst
    const response = await post()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ quote_id: 'child', deposit_pct: 50, already: false })
    expect(state.captures).toEqual([{ p_tenant_id: 't1', p_trade: 'electrical', p_book_id: 'book', p_expected_book: state.book }])
    expect(state.inserts[0]).toMatchObject({ pricing_book_version_id: 'new-version', total_inc_gst: 0,
      deposit_pct: 50, status: 'draft', selected_tier: 'good', stripe_links: {},
      good: { subtotal_ex_gst: 0, line_items: [{ quantity: 1, unit_price_ex_gst: 0 }] } })
  })
  it('reopens an already-created final without consulting a changed or deleted book', async () => {
    state.rows.push({ id: 'existing', parent_quote_id: 'parent', intake_id: 'i1', tenant_id: 't1', quote_kind: 'final', paid_at: null, share_token: 'old-link' })
    state.book = null
    expect(await (await post()).json()).toMatchObject({ already: true, quote_id: 'existing', share_token: 'old-link' })
    expect(state.captures).toHaveLength(0); expect(state.inserts).toHaveLength(0)
  })
  it('retains historical price/GST when copying a priced parent and keeps current deposit policy separate', async () => {
    state.book!.gst_registered = true
    parent().pricing_book_version_id = 'old-version'
    parent().selected_tier = 'good'
    parent().good = { label: 'Quoted', subtotal_ex_gst: 100, line_items: [{ description: 'Work', quantity: 1, unit_price_ex_gst: 100, source: 'assembly:a' }] }
    state.versions = [{ id: 'old-version', tenant_id: 't1', trade: 'electrical', pricing_book_id: 'old-book',
      content_hash: 'b'.repeat(64), snapshot: { id: 'old-book', tenant_id: 't1', trade: 'electrical', gst_registered: false, hourly_rate: 75 } }]
    expect((await post()).status).toBe(200)
    expect(state.inserts[0]).toMatchObject({ pricing_book_version_id: 'old-version', total_inc_gst: 100, gst: 0,
      deposit_pct: 50, good: { line_items: [{ source: 'assembly:a', unit_price_ex_gst: 100 }] } })
  })
  it('does not assign current-book provenance to a copied legacy price', async () => {
    parent().good = { subtotal_ex_gst: 100 }
    expect(await (await post()).json()).toMatchObject({ error: 'quote_pricing_review_required' })
    expect(state.inserts).toHaveLength(0); expect(state.captures).toHaveLength(0)
  })
  it.each([null, '', ' ', -1])('rejects invalid stored line price %s before any capture/insert', async price => {
    parent().good = { subtotal_ex_gst: 100, line_items: [{ description: 'Work', quantity: 1, unit_price_ex_gst: price }] }
    expect((await post()).status).toBe(409)
    expect(state.inserts).toHaveLength(0); expect(state.captures).toHaveLength(0)
  })
  it.each([0, 1])('does not attach current history to an inconsistent/legacy zero-total priced line, quantity %s', async quantity => {
    parent().good = { subtotal_ex_gst: 0, line_items: [{ description: 'Old rate', quantity, unit_price_ex_gst: 100 }] }
    expect((await post()).status).toBe(409)
    expect(state.inserts).toHaveLength(0); expect(state.captures).toHaveLength(0)
  })
  it.each([null, 'false'])('does not default a missing/invalid tax setting %s', async tax => {
    state.book!.gst_registered = tax
    expect((await post()).status).toBe(409)
    expect(state.inserts).toHaveLength(0)
  })
  it('does not write a child if book revision changed at capture', async () => {
    state.captureError = { message: 'pricing revision changed' }
    const response = await post()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'pricing_revision_changed' })
    expect(state.inserts).toHaveLength(0)
  })
  it.each(['rejected', 'lost'])('does not report a child success when persistence is %s', async outcome => {
    state.insertError = outcome === 'rejected'; state.loseAck = outcome === 'lost'
    const response = await post()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false, error: 'final_prepare_unconfirmed' })
  })
})
