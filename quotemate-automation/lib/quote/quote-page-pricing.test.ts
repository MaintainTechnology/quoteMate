import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const rows: Record<string, Record<string, unknown> | null> = {}
  const errors: Record<string, unknown> = {}
  const reads: Array<{ table: string; fields: string; filters: Record<string, unknown> }> = []
  const client = { from: (table: string) => {
    const read = { table, fields: '', filters: {} as Record<string, unknown> }; reads.push(read)
    const q = {
      select: (fields: string) => { read.fields = fields; return q },
      eq: (k: string, v: unknown) => { read.filters[k] = v; return q },
      in: () => q, not: () => q, is: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => {
        const data = rows[table] ?? null
        return { data: data && read.fields !== '*' ? Object.fromEntries(read.fields.split(',').map(key => [key.trim(), data[key.trim()]])) : data,
          error: errors[read.fields.startsWith('early_bird_discount_pct') ? 'early_bird' : table] ?? null }
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    }; return q
  } }
  return { rows, errors, reads, client }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('next/server', () => ({ after: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => '/q/saved-token', notFound: () => { throw Error('404') }, redirect: (path: string) => { throw Error(`redirect:${path}`) } }))
vi.mock('@/lib/quote/page-owner', () => ({ isQuotePageOwner: async () => true }))
vi.mock('@/lib/ig-engine/generate', () => ({ generatePreviewImage: vi.fn() }))
vi.mock('@/lib/ig-engine/samples', () => ({ generateSampleImages: vi.fn() }))
vi.mock('@/lib/storage/upload', () => ({ refreshSignedUrl: vi.fn(async () => null) }))
vi.mock('@/app/q/[token]/TradieEditor', () => ({ default: () => null }))
vi.mock('@/app/dashboard/quote/[token]/QuoteReportViewerClient', () => ({ default: () => null }))
vi.mock('@/lib/quote/send-customer', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/quote/send-customer')>(),
  resolveCustomerContact: async () => ({ phone: null, email: null }),
}))

import DashboardQuoteViewerPage from '@/app/dashboard/quote/[token]/page'
import PublicQuotePage from '@/app/q/[token]/page'
import { QuotePricingReview } from '@/app/q/_chrome/QuotePricingReview'
import { QuoteUnavailable } from '@/app/q/_chrome/QuoteUnavailable'
import { TradeTiers } from '@/app/q/[token]/TradeTiers'
const params = () => ({ params: Promise.resolve({ token: 'saved-token' }) })
function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join(' ')
  if (value && typeof value === 'object' && 'props' in value) return textOf((value as { props: { children?: unknown } }).props.children)
  return ''
}
beforeEach(() => {
  vi.stubGlobal('React', React)
  h.reads.length = 0
  for (const key of Object.keys(h.rows)) delete h.rows[key]
  for (const key of Object.keys(h.errors)) delete h.errors[key]
  h.rows.quotes = { id: 'quote-id', tenant_id: 'tenant-id', intake_id: 'intake-id', share_token: 'saved-token',
    quote_kind: 'initial', parent_quote_id: null, good: null, best: null,
    better: { label: 'Saved work', subtotal_ex_gst: 100.05, line_items: [
      { description: 'Owned item', quantity: 1, unit: 'each', unit_price_ex_gst: 100.05, total_ex_gst: 100.05 },
    ] }, total_inc_gst: 100.05, selected_tier: 'better', pricing_book_version_id: 'version-id',
    needs_inspection: false, status: 'sent', paid_at: null, deposit_pct: 30,
    created_at: '2026-09-08T00:00:00Z', scope_of_works: 'Customer scope only', risk_flags: ['PRIVATE SAFETY FLAG'],
    assumptions: [], stripe_links: {}, report_doc: null, optional_upsells: [], applied_discount_pct: 0 }
  h.rows.intakes = { id: 'intake-id', tenant_id: 'tenant-id', trade: 'electrical', job_type: 'power_points',
    caller: { name: 'Sam' }, scope: {}, photo_paths: [] }
  h.rows.quote_pricing_versions = { id: 'version-id', tenant_id: 'tenant-id', trade: 'electrical', pricing_book_id: 'book-id',
    content_hash: 'a'.repeat(64), snapshot: { id: 'book-id', tenant_id: 'tenant-id', trade: 'electrical', gst_registered: false, quote_tier_mode: 'single' } }
  h.rows.pricing_book = { gst_registered: true, quote_tier_mode: 'good_better_best' }
})

describe('actual dashboard saved price reader', () => {
  it('passes saved non-GST evidence to the editor even after current GST changes', async () => {
    const view = await DashboardQuoteViewerPage(params())
    expect(view.props.gstRegistered).toBe(false)
    expect(h.reads.find(r => r.table === 'intakes')?.filters).toEqual({ id: 'intake-id', tenant_id: 'tenant-id' })
    h.rows.pricing_book = null
    expect((await DashboardQuoteViewerPage(params())).props.gstRegistered).toBe(false)
  })
  it('shows an explicit review state for unavailable historical evidence', async () => {
    h.rows.quote_pricing_versions = null
    expect(textOf(await DashboardQuoteViewerPage(params()))).toContain('pricing needs review')
  })
  it('keeps inspection chain actions available without inventing an editor tax value', async () => {
    Object.assign(h.rows.quotes!, { needs_inspection: true, paid_at: '2026-09-08', paid_tier: 'inspection', better: null, total_inc_gst: 99 })
    const view = await DashboardQuoteViewerPage(params())
    expect(view.props.gstRegistered).toBeNull()
    expect(view.props.chainAction).toBe('issue-final')
    expect(view.props.docEditorEnabled).toBe(false)
  })
  it.each(['quotes', 'intakes', 'quote_pricing_versions'])('keeps %s failure retryable', async table => {
    h.errors[table] = { code: 'XX000' }
    expect(textOf(await DashboardQuoteViewerPage(params()))).toContain('temporarily unavailable')
  })
})
describe('actual public quote saved price reader', () => {
  it('uses saved false GST and tier mode after the current book changes or disappears', async () => {
    const view = await PublicQuotePage(params())
    expect(JSON.stringify(view)).toContain('No GST')
    expect(JSON.stringify(view)).not.toContain('All prices include 10% GST')
    h.rows.pricing_book = null
    expect(JSON.stringify(await PublicQuotePage(params()))).toContain('No GST')
    expect(h.reads.find(r => r.table === 'quotes')?.fields).toContain('pricing_book_version_id')
    expect(h.reads.find(r => r.table === 'intakes')?.filters).toEqual({ id: 'intake-id', tenant_id: 'tenant-id' })
  })
  it('renders cent-precise public tier totals from the saved tax basis', async () => {
    const html = renderToStaticMarkup(await PublicQuotePage(params()))
    expect(html).toContain('100.05')
    expect(html).toContain('No GST')
    expect(html).not.toContain('include 10% GST')
  })
  it('preserves the saved discount when the optional offer/countdown read fails', async () => {
    h.rows.quotes!.applied_discount_pct = 5
    h.errors.early_bird = { code: 'XX000' }
    const html = renderToStaticMarkup(await PublicQuotePage(params()))
    expect(html).toContain('95.05')
    expect(html).toContain('5% off applied')
    expect(h.reads.find(r => r.table === 'quotes')?.fields).toContain('applied_discount_pct')
  })
  it('renders non-generic tier totals and deposit cents without adding GST', () => {
    const html = renderToStaticMarkup(React.createElement(TradeTiers, {
      tiers: { good: { label: 'Saved', subtotal_ex_gst: 100.05 }, better: null, best: null },
      token: 'saved-token', stripeLinks: {}, depositPct: 30, selectedTier: 'good', appliedDiscountPct: 0,
      isPaid: false, paidTier: null, gstRegistered: false, depositEnabled: true,
    }))
    expect(html).toContain('$100.05')
    expect(html).toContain('$30.02')
    expect(html).toContain('No GST')
    expect(html).not.toContain('inc GST')
  })
  it('keeps customer scope and known site-visit action when prices need review, without private flags', async () => {
    h.rows.quote_pricing_versions = null
    const view = await PublicQuotePage(params())
    expect(view.type).toBe(QuotePricingReview)
    expect(view.props).toEqual({ scope: 'Customer scope only', inspectionUrl: '/r/saved-token/inspection' })
    expect(JSON.stringify(view)).not.toContain('PRIVATE SAFETY FLAG')
  })
  it('does not offer a second site visit on a final quote whose history is invalid', async () => {
    Object.assign(h.rows.quotes!, { quote_kind: 'final', parent_quote_id: 'parent-id' })
    h.rows.quote_pricing_versions = null
    const view = await PublicQuotePage(params())
    expect(view.type).toBe(QuotePricingReview)
    expect(view.props.inspectionUrl).toBeUndefined()
  })
  it.each([null, 0, 91])('withholds deposit prices when the stored deposit is invalid: %j', async deposit => {
    h.rows.intakes!.trade = 'painting'
    h.rows.quote_pricing_versions!.trade = 'painting'
    ;(h.rows.quote_pricing_versions!.snapshot as Record<string, unknown>).trade = 'painting'
    h.rows.quotes!.deposit_pct = deposit
    expect((await PublicQuotePage(params())).type).toBe(QuotePricingReview)
  })
  it.each(['intakes', 'quote_pricing_versions'])('returns the retryable unavailable view for %s errors', async table => {
    h.errors[table] = { code: 'XX000' }
    expect((await PublicQuotePage(params())).type).toBe(QuoteUnavailable)
  })
  it('rejects a foreign intake before looking up any pricing book', async () => {
    h.rows.intakes!.tenant_id = 'other'
    expect((await PublicQuotePage(params())).type).toBe(QuotePricingReview)
    expect(h.reads.some(r => ['pricing_book', 'quote_pricing_versions'].includes(r.table))).toBe(false)
  })
})
