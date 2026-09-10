import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/quote/job-quote-operation', () => ({ readQuoteDraftReadiness: vi.fn(async () => ({ ready: true })) }))
import { quoteEditRevision } from '@/lib/quote/edit-authority'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'

const state = vi.hoisted(() => ({
  quote: {} as Record<string, unknown>, intake: {} as Record<string, unknown>,
  books: [] as Array<Record<string, unknown>>, tenant: { id: 't1' } as { id: string } | null,
  writes: [] as Array<Record<string, unknown>>, filters: [] as Array<Record<string, unknown>>,
  race: false, writeError: false,
  version: null as Record<string, unknown> | null,
}))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async () => state.tenant ? { tenant: state.tenant } : null }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  from: (table: string) => {
    const filters: Record<string, unknown> = {}
    let update: Record<string, unknown> | null = null
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query },
      is: (key: string, value: unknown) => { filters[key] = value; return query },
      update: (value: Record<string, unknown>) => { update = value; return query },
      maybeSingle: async () => {
        state.filters.push({ table, ...filters })
        if (update) {
          if (state.race) state.quote.paid_at = 'paid'
          if (state.writeError) return { data: null, error: { message: 'failed' } }
          if (Object.entries(filters).some(([key, value]) => {
            const current = state.quote[key] ?? null
            return current && typeof current === 'object' ? JSON.stringify(current) !== value : current !== value
          })) return { data: null, error: null }
          state.writes.push(update)
          state.quote = { ...state.quote, ...structuredClone(update) }
          return { data: structuredClone(state.quote), error: null }
        }
        if (table === 'pricing_book') {
          const books = state.books.filter((book) => Object.entries(filters).every(([key, value]) => book[key] === value))
          return { data: books.length === 1 ? books[0] : null, error: books.length > 1 ? { message: 'multiple' } : null }
        }
        return { data: structuredClone(table === 'quote_pricing_versions' ? state.version : table === 'quotes' ? state.quote : state.intake), error: null }
      },
    }
    return query
  },
}) }))
import { PATCH } from './route'
const params = { params: Promise.resolve({ id: 'q1' }) }
function patch(body: unknown) {
  return PATCH(new Request('https://example.test/api/quote/q1/tier', { method: 'PATCH', body: JSON.stringify(body) }), params)
}
beforeEach(() => {
  state.tenant = { id: 't1' }
  state.quote = { id: 'q1', tenant_id: 't1', intake_id: 'i1', status: 'draft', paid_at: null,
    selected_tier: 'better', needs_inspection: false, good: { subtotal_ex_gst: 10.15 },
    better: { subtotal_ex_gst: 100 }, best: null, total_inc_gst: 110 }
  state.intake = { tenant_id: 't1', trade: 'roofing' }
  state.books = [
    { id: 'pb-p', tenant_id: 't1', trade: 'plumbing', gst_registered: false },
    { id: 'pb-r', tenant_id: 't1', trade: 'roofing', gst_registered: true },
  ]
  state.writes = []; state.filters = []; state.race = false; state.writeError = false
  state.version = null
})
describe('owned quote tier selection', () => {
  it('uses the captured historical tax after the current book is deleted', async () => {
    state.quote.pricing_book_version_id = 'v1'
    state.quote.total_inc_gst = 100
    state.version = { id: 'v1', tenant_id: 't1', trade: 'roofing', pricing_book_id: 'old', content_hash: 'a'.repeat(64),
      snapshot: { id: 'old', tenant_id: 't1', trade: 'roofing', gst_registered: false } }
    state.books = []
    expect(await (await patch({ tier: 'good' })).json()).toMatchObject({ total_inc_gst: 10.15, gst_registered: false })
    expect(state.quote.pricing_book_version_id).toBe('v1')
    expect(state.filters.some(item => item.table === 'pricing_book')).toBe(false)
  })
  it.each(['quote_draft_processing', 'quote_draft_unconfirmed'] as const)('blocks %s before price or mutation', async code => {
    vi.mocked(readQuoteDraftReadiness).mockResolvedValueOnce({ ready: false, code })
    expect(await (await patch({ tier: 'good' })).json()).toMatchObject({ error: code })
    expect(state.writes).toEqual([])
    expect(state.filters.some(item => item.table === 'pricing_book')).toBe(false)
  })
  it.each([false, true])('uses the owned trade regardless of returned book order reverse=%s', async (reverse) => {
    if (reverse) state.books.reverse()
    const response = await patch({ tier: 'good', expected_revision: quoteEditRevision(state.quote) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ total_inc_gst: 11.17, gst_registered: true, edit_revision: quoteEditRevision(state.quote) })
    expect(state.filters).toContainEqual({ table: 'pricing_book', tenant_id: 't1', trade: 'roofing' })
    expect(state.quote.status).toBe('draft')
  })
  it('keeps historical GST false when current owned settings are true', async () => {
    state.quote.total_inc_gst = 100
    expect(await (await patch({ tier: 'good' })).json()).toMatchObject({ total_inc_gst: 10.15, gst_registered: false })
  })
  it.each([null, undefined, 'false', 1])('rejects malformed GST %s', async (gst) => {
    state.books[1].gst_registered = gst
    expect((await patch({ tier: 'good' })).status).toBe(409)
    expect(state.writes).toEqual([])
  })
  it('rejects a missing owned trade book, with no foreign/default fallback', async () => {
    state.books = [{ id: 'foreign', tenant_id: 'other', trade: 'roofing', gst_registered: true }]
    expect((await patch({ tier: 'good' })).status).toBe(409)
    expect(state.writes).toEqual([])
  })
  it('rejects multiple owned books rather than picking a version arbitrarily', async () => {
    state.books.push({ ...state.books[1], id: 'other-version' })
    expect((await patch({ tier: 'good' })).status).toBe(503)
    expect(state.writes).toEqual([])
  })
  it.each([0, 109.99, null, '110'])('requires review when historical tax is ambiguous or inconsistent %s', async (total) => {
    state.quote.total_inc_gst = total
    expect((await patch({ tier: 'good' })).status).toBe(409)
    expect(state.writes).toEqual([])
  })
  it('rejects a payment arriving at the conditional write', async () => {
    state.race = true
    expect((await patch({ tier: 'good' })).status).toBe(409)
    expect(state.writes).toEqual([])
  })
  it('rejects a stale revision before writes', async () => {
    expect((await patch({ tier: 'good', expected_revision: 'a'.repeat(64) })).status).toBe(409)
    expect(state.writes).toEqual([])
  })
  it('does not claim success for failed persistence', async () => {
    state.writeError = true
    expect((await patch({ tier: 'good' })).status).toBe(500)
    expect(state.writes).toEqual([])
  })
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])('rejects unsafe stored tier value %s', async (subtotal) => {
    state.quote.good = { subtotal_ex_gst: subtotal }
    expect((await patch({ tier: 'good' })).status).toBe(400)
    expect(state.writes).toEqual([])
  })
})
