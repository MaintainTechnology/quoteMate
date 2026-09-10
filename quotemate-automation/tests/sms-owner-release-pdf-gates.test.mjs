import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

// Actual public PDF routes and real cached PDF helpers. Only auth, database,
// storage transport and Gotenberg are fixtures; no external I/O is permitted.
const h = vi.hoisted(() => {
  const state = { row: null, family: '', navigationHeaders: {}, readError: null, unexpected: [], downloads: [],
    pdfBytes: '%PDF-1.4\nFixture saved customer price: $18,648 ex GST\n%%EOF' }
  const client = {
    from(table) {
      const allowed = { paint: 'painting_measurements', solar: 'solar_estimates', roof: 'roofing_measurements', aircon: 'aircon_recommendations' }
      if (table !== allowed[state.family]) { state.unexpected.push(`table:${table}`); throw new Error(`Unexpected PDF table ${table}`) }
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: state.row, error: state.readError }) }
      return query
    },
    storage: { from(bucket) {
      if (bucket !== 'quote-pdfs') { state.unexpected.push(`bucket:${bucket}`); throw new Error('Unexpected PDF bucket') }
      return { download: async path => {
        if (path !== state.row?.pdf_path) { state.unexpected.push(`path:${path}`); throw new Error('Unexpected PDF object') }
        state.downloads.push(path)
        return { data: new Blob([state.pdfBytes]), error: null }
      } }
    } },
  }
  return { state, client }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('next/server', () => ({ after: () => {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(h.state.navigationHeaders) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: async (_db, request) => {
  const token = request.headers.get('authorization')
  return token === 'Bearer fixture-owner' ? { tenant: { id: '22222222-2222-4222-8222-222222222222' } }
    : token === 'Bearer fixture-other' ? { tenant: { id: '33333333-3333-4333-8333-333333333333' } } : null
} }))
vi.mock('@/lib/pdf/gotenberg', () => ({ gotenbergConfigured: () => true,
  renderPdfFromHtml: async () => { h.state.unexpected.push('renderer'); throw new Error('Expected the real cached PDF path') } }))
import { GET as paintPdf } from '@/app/api/q/paint/[token]/pdf/route'
import { GET as solarPdf } from '@/app/api/q/solar/[token]/pdf/route'
import { GET as roofPdf } from '@/app/api/q/roof/[token]/pdf/route'
import { POST as airconPdf } from '@/app/api/aircon/pdf/route'
import { solarPdfRev } from '@/lib/quote/pdf-rev'

const WEBSITE = 'https://quotemax.com.au', TOKEN = 'saved_held_quote_token_123456'
beforeEach(() => {
  vi.stubEnv('PUBLIC_WEB_ORIGIN', WEBSITE)
  vi.stubEnv('APP_URL', 'https://offline-engine.invalid')
  vi.stubEnv('SOLAR_PREMIUM_QUOTE', '0')
  h.state.navigationHeaders = {}; h.state.readError = null; h.state.unexpected = []; h.state.downloads = []
  h.state.row = { id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222',
    public_token: TOKEN, routing: 'tradie_review', released_at: null, confirmed_at: null, quote: null, quote_share_token: null, estimate: {} }
  vi.stubGlobal('fetch', async () => { h.state.unexpected.push('fetch'); throw new Error('External I/O prohibited') })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

async function download(family, authorization) {
  h.state.family = family
  if (h.state.row) {
    const websiteRevision = `-web-${createHash('sha256').update(WEBSITE).digest('hex').slice(0, 16)}`
    const prefix = family === 'roof' ? 'roofs' : family
    const revision = family === 'solar' ? solarPdfRev(h.state.row, false) : '-v7'
    // Seed the exact original fixture bytes at their immutable object key.
    // The real cache helper must accept the token/revision/origin prefix;
    // rendering remains forbidden and no old stored object is overwritten.
    const contentHash = createHash('sha256').update(h.state.pdfBytes).digest('hex')
    h.state.row.pdf_path = `${prefix}/${TOKEN}${revision}${websiteRevision}/${contentHash}.pdf`
  }
  const headers = authorization ? { authorization } : {}
  return family === 'aircon'
    ? airconPdf(new Request(`${WEBSITE}/api/aircon/pdf`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: h.state.row?.id }) }))
    : ({ paint: paintPdf, solar: solarPdf, roof: roofPdf }[family])(
      new Request(`${WEBSITE}/api/q/${family}/${TOKEN}/pdf`, { headers }), { params: Promise.resolve({ token: TOKEN }) })
}

describe('actual public PDF access before owner release', () => {
  it.each(['paint', 'solar', 'roof', 'aircon'])('does not download a known held %s PDF for an unauthenticated customer', async family => {
    const response = await download(family)
    expect([401, 403, 409]).toContain(response.status)
    expect(h.state.downloads).toEqual([])
    expect(h.state.unexpected).toEqual([])
  })
  for (const family of ['paint', 'solar']) {
    it(`${family}: rejects the wrong owner before consulting the saved PDF`, async () => {
      expect((await download(family, 'Bearer fixture-other')).status).toBe(409)
      expect(h.state.downloads).toEqual([])
      expect(h.state.unexpected).toEqual([])
    })
    it.each(['bearer', 'cookie'])(`${family}: permits a verified owning %s preview of a held cached PDF`, async credential => {
      if (credential === 'cookie') h.state.navigationHeaders = { cookie: '__session=fixture-owner' }
      const response = await download(family, credential === 'bearer' ? 'Bearer fixture-owner' : undefined)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/pdf')
      expect(await response.text()).toContain('Fixture saved customer price: $18,648 ex GST')
      expect(h.state.downloads).toEqual([h.state.row.pdf_path])
      expect(h.state.unexpected).toEqual([])
    })
    it(`${family}: preserves public access to an already released cached PDF`, async () => {
      h.state.row[family === 'solar' ? 'confirmed_at' : 'released_at'] = '2026-09-08T00:00:00Z'
      const response = await download(family)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('%PDF-1.4')
      expect(h.state.downloads).toEqual([h.state.row.pdf_path])
      expect(h.state.unexpected).toEqual([])
    })
    it(`${family}: distinguishes a failed row read from a nonexistent token`, async () => {
      h.state.row = null; h.state.readError = { code: '42703' }
      expect((await download(family)).status).toBe(503)
      h.state.readError = null
      expect((await download(family)).status).toBe(404)
      expect(h.state.downloads).toEqual([])
      expect(h.state.unexpected).toEqual([])
    })
  }
})
