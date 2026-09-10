import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const h = vi.hoisted(() => ({ row: null, releaseReadFails: false, unexpected: [], reads: [] }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from(table) {
  let columns = ''
  const query = { select: value => { columns = value; return query }, eq: () => query,
    maybeSingle: async () => {
      h.reads.push({ table, columns })
      if (table === 'painting_measurements') return h.releaseReadFails && columns.includes('released_at')
        ? { data: null, error: { code: '08006', message: 'Fixture release read failed' } } : { data: h.row, error: null }
      if (table === 'pricing_book') return { data: { quote_tier_mode: 'single' }, error: null }
      if (table === 'tenants') return { data: { business_name: 'Offline Painter' }, error: null }
      h.unexpected.push(`table:${table}`); throw new Error(`Unexpected table ${table}`)
    } }
  return query
} }) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/q/paint/saved-paint-token', notFound: () => { throw new Error('NOT_FOUND') } }))
// Owner overlays mount only in a browser; price/quote components stay real.
vi.mock('@/app/q/_chrome/TradieJobBanner', () => ({ TradieJobBanner: () => null }))
import PaintingQuotePage from '@/app/q/paint/[token]/page'

const seedPath = fileURLToPath(new URL('./fixtures/sms-owner-release-seed.json', import.meta.url))
const seed = JSON.parse(readFileSync(seedPath, 'utf8'))
const seedHash = () => createHash('sha256').update(readFileSync(seedPath)).digest('hex')
const seedEvidence = { path: seedPath, sha256: seedHash(), fixtureVersion: seed.fixtureVersion, provenance: seed.provenance }
const estimate = seed.estimate
beforeAll(() => {
  expect(Object.keys(seed).sort()).toEqual(['estimate','fixtureVersion','provenance','quote'])
  expect(seed.fixtureVersion).toBe(1)
  expect(seed.provenance).toMatchObject({ kind: 'synthetic-test-data',
    sourceArtifact: '2026-09-09-sms-cross-channel-parity-results.json',
    sourceFields: ['results[finding=F16].quote','results[finding=F17].savedEstimate'] })
  expect(seed.provenance.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(estimate).toMatchObject({ provider: 'mock', measurement: { floor_area_m2: 180 },
    price: { routing: { decision: 'tradie_review' } } })
  expect(estimate.price.tiers.map(tier => tier.tier)).toEqual(['good','better','best'])
  expect(estimate.price.tiers.find(tier => tier.tier === 'better').ex_gst).toBe(18648)
  for (const tier of estimate.price.tiers) {
    expect(Number.isFinite(tier.ex_gst) && tier.ex_gst > 0).toBe(true)
    expect(Number.isFinite(tier.inc_gst) && tier.inc_gst > 0).toBe(true)
  }
  console.info('[owner-release/paint-page] synthetic seed', JSON.stringify(seedEvidence))
})
beforeEach(() => {
  h.row = { public_token: 'saved-paint-token', tenant_id: '11111111-1111-4111-8111-111111111111',
    address: '12 Example Road, Sydney NSW 2000', created_at: '2026-09-08T00:00:00Z',
    scopes: ['walls'], estimate, routing: 'tradie_review', released_at: null }
  h.releaseReadFails = false; h.unexpected = []; h.reads = []
  vi.stubEnv('GOOGLE_MAPS_API_KEY', '')
  vi.stubGlobal('fetch', async () => { h.unexpected.push('fetch'); throw new Error('Unexpected network') })
})
afterEach(() => {
  try { expect(seedHash()).toBe(seedEvidence.sha256) }
  finally { vi.unstubAllGlobals(); vi.unstubAllEnvs() }
})
async function html(full = false) {
  const tree = await PaintingQuotePage({ params: Promise.resolve({ token: h.row.public_token }), searchParams: Promise.resolve(full ? { full: '1' } : {}) })
  const rendered = renderToStaticMarkup(tree)
  expect(h.unexpected).toEqual([])
  return rendered
}
describe('actual painting public page release authority', () => {
  it.each([false, true])('withholds saved price and delivery promises while held (full=%s)', async full => {
    const rendered = await html(full)
    expect(rendered).toMatch(/awaiting.*review/i)
    expect(rendered).not.toContain('18,648')
    expect(rendered).not.toMatch(/shortly|on its way|moment it|within a business day|will send/i)
  })
  it('renders saved pricing after an existing owner release', async () => {
    h.row.released_at = '2026-09-08T00:00:00Z'
    expect(await html()).toContain('18,648')
  })
  it('does not reveal the saved price when the release-column read fails', async () => {
    h.releaseReadFails = true
    const rendered = await html()
    expect(rendered).not.toContain('18,648')
    expect(rendered).toMatch(/temporar|unavailable|try again/i)
  })
})
