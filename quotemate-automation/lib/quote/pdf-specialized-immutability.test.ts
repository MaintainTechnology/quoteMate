import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// This boundary fixture runs the actual three ensure functions. SQL transport,
// branding, report HTML and Gotenberg are deterministic local substitutes; the
// private storage model enforces upsert and exposes every retained object's bytes.
const h = vi.hoisted(() => {
  const rows: Record<string, Record<string, unknown>> = {}
  const objects = new Map<string, Buffer>()
  const state = { branding: 'Reviewed business', upload: 'normal', readback: 'normal' }
  const writes: Array<{ table: string; patch: Record<string, unknown> }> = []
  const upload = vi.fn(async (path: string, bytes: Buffer, options: { upsert: boolean }) => {
    if (state.upload === 'refused') return { error: { message: 'Upload unconfirmed' } }
    if (objects.has(path) && !options.upsert) return { error: { message: 'Already exists' } }
    objects.set(path, Buffer.from(bytes))
    return { error: state.upload === 'lost-ack' ? { message: 'Acknowledgement lost' } : null }
  })
  const download = vi.fn(async (path: string) => {
    if (state.readback === 'throw') throw new Error('Storage read failed')
    if (state.readback === 'error') return { data: null, error: { message: 'Unavailable' } }
    if (state.readback === 'missing') return { data: null, error: null }
    const bytes = state.readback === 'different' ? Buffer.from('Unrelated PDF') : objects.get(path)
    return { data: bytes ? new Blob([new Uint8Array(bytes)]) : null, error: null }
  })
  const client = {
    from: (table: string) => {
      if (!['roofing_measurements', 'solar_estimates', 'painting_measurements'].includes(table)) {
        throw new Error(`Unexpected table ${table}`)
      }
      let patch: Record<string, unknown> | undefined
      const query = {
        select: () => query,
        eq: (field: string, value: string) => {
          expect(field).toBe('public_token')
          expect(value).toBe(rows[table].public_token)
          return query
        },
        maybeSingle: async () => ({ data: structuredClone(rows[table]), error: null }),
        update: (value: Record<string, unknown>) => { patch = value; return query },
        then: (resolve: (value: unknown) => unknown) => {
          if (!patch) throw new Error('Expected cache update')
          expect(Object.keys(patch)).toEqual(['pdf_path'])
          writes.push({ table, patch: { ...patch } })
          Object.assign(rows[table], patch)
          return Promise.resolve({ data: null, error: null }).then(resolve)
        },
      }
      return query
    },
    storage: { from: (bucket: string) => {
      expect(bucket).toBe('quote-pdfs')
      return { upload, download }
    } },
  }
  const report = vi.fn((input: unknown) => JSON.stringify(input))
  const render = vi.fn(async (html: string) => Buffer.from(`%PDF-fixture:${html}`))
  return { rows, objects, state, writes, upload, download, client, report, render }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/pdf/gotenberg', () => ({ gotenbergConfigured: () => true, renderPdfFromHtml: h.render }))
vi.mock('@/lib/pdf/branding', () => ({ loadTenantBranding: async () => ({ businessName: h.state.branding }) }))
vi.mock('@/lib/pdf/image', () => ({ prepareImage: async () => null }))
vi.mock('@/lib/roofing/report-html', () => ({ buildRoofCustomerReportHtml: h.report }))
vi.mock('@/lib/solar/report-html', () => ({ buildSolarQuoteReportHtml: h.report }))
vi.mock('@/lib/painting/report-html', () => ({ buildPaintingQuoteReportHtml: h.report }))

import { ensureRoofQuotePdf, ensureSolarQuotePdf, ensurePaintingPdf } from './pdf'

const token = 'specialized_saved_customer_token'
const origin = 'https://customer.quotemax.com.au'
const webRev = createHash('sha256').update(origin).digest('hex').slice(0, 16)
const families = [
  { family: 'roof', table: 'roofing_measurements', prefix: `roofs/${token}-v7-web-${webRev}`,
    ensure: (regenerate = false) => ensureRoofQuotePdf(token, { displayRows: [], regenerate }) },
  { family: 'solar', table: 'solar_estimates', prefix: `solar/${token}-v3-web-${webRev}`,
    ensure: (regenerate = false) => ensureSolarQuotePdf(token, { regenerate }) },
  { family: 'paint', table: 'painting_measurements', prefix: `paint/${token}-v7-web-${webRev}`,
    ensure: (regenerate = false) => ensurePaintingPdf(token, { regenerate }) },
] as const

beforeEach(() => {
  vi.clearAllMocks()
  h.objects.clear()
  h.writes.length = 0
  Object.assign(h.state, { branding: 'Reviewed business', upload: 'normal', readback: 'normal' })
  for (const { table } of families) h.rows[table] = {
    public_token: token, tenant_id: null, pdf_path: null, routing: 'auto_quote',
    quote: { structures: [], combined: { tiers: [], total_inc_gst: 3210.01 } },
    estimate: { context: {}, price: { tiers: [], total_inc_gst: 3210.01 } },
  }
  vi.stubEnv('PUBLIC_WEB_ORIGIN', origin)
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('SOLAR_PREMIUM_QUOTE', '0')
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe.each(families)('$family specialized PDF object immutability', ({ table, prefix, ensure }) => {
  it('keeps accepted bytes when profile cache invalidation triggers a fresh render', async () => {
    const original = structuredClone(h.rows[table])
    const acceptedPath = await ensure()
    expect(acceptedPath).not.toBeNull()
    const acceptedBytes = Buffer.from(h.objects.get(acceptedPath!)!)
    h.rows[table].pdf_path = null // The profile route invalidates this cache column.
    h.state.branding = 'Updated business profile'
    const freshPath = await ensure()
    expect(h.objects.get(acceptedPath!)).toEqual(acceptedBytes)
    expect(freshPath).not.toBe(acceptedPath)
    expect(h.objects.get(freshPath!)?.toString()).toContain('Updated business profile')
    expect(freshPath).toBe(`${prefix}/${createHash('sha256').update(h.objects.get(freshPath!)!).digest('hex')}.pdf`)
    expect(await ensure()).toBe(freshPath)
    expect(h.render).toHaveBeenCalledTimes(2)
    expect(h.objects.size).toBe(2)
    expect(h.upload.mock.calls.every(([, , options]) => options.upsert === false)).toBe(true)
    expect({ ...h.rows[table], pdf_path: null }).toEqual(original)
  })

  it('keeps earlier bytes on explicit regeneration without cache invalidation', async () => {
    const firstPath = await ensure()
    const firstBytes = Buffer.from(h.objects.get(firstPath!)!)
    h.state.branding = 'Updated explicit render'
    const nextPath = await ensure(true)
    expect(nextPath).not.toBe(firstPath)
    expect(h.objects.get(firstPath!)).toEqual(firstBytes)
    expect(h.objects.size).toBe(2)
  })

  it('reuses concurrent identical renders only after exact existing-byte readback', async () => {
    const paths = await Promise.all([ensure(true), ensure(true)])
    expect(paths[0]).not.toBeNull()
    expect(paths[1]).toBe(paths[0])
    expect(h.objects.size).toBe(1)
    expect(h.upload).toHaveBeenCalledTimes(2)
    expect(h.download).toHaveBeenCalledExactlyOnceWith(paths[0])
    expect(h.upload.mock.calls.every(([, , options]) => options.upsert === false)).toBe(true)
  })

  it('recovers a lost upload acknowledgement only after exact byte readback', async () => {
    h.state.upload = 'lost-ack'
    const path = await ensure()
    expect(path).not.toBeNull()
    expect(h.download).toHaveBeenCalledExactlyOnceWith(path)
    expect(h.objects.size).toBe(1)
    expect(h.rows[table].pdf_path).toBe(path)
  })

  it.each(['different', 'missing', 'error', 'throw'])('keeps the prior cache when unconfirmed upload readback is %s', async readback => {
    const firstPath = await ensure()
    const firstBytes = Buffer.from(h.objects.get(firstPath!)!)
    const oldWrites = h.writes.length
    h.state.branding = 'New unconfirmed render'
    h.state.upload = 'refused'
    h.state.readback = readback
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await ensure(true)).toBeNull()
    expect(h.rows[table].pdf_path).toBe(firstPath)
    expect(h.objects.get(firstPath!)).toEqual(firstBytes)
    expect(h.writes).toHaveLength(oldWrites)
    expect(h.download).toHaveBeenCalledTimes(1)
  })

  it('refreshes a current-revision mutable legacy cache once without changing its bytes', async () => {
    const legacyPath = `${prefix}.pdf`
    const legacyBytes = Buffer.from('Previously accepted legacy PDF')
    h.objects.set(legacyPath, legacyBytes)
    h.rows[table].pdf_path = legacyPath
    const path = await ensure()
    expect(path).not.toBe(legacyPath)
    expect(h.objects.get(legacyPath)).toEqual(legacyBytes)
    expect(await ensure()).toBe(path)
    expect(h.render).toHaveBeenCalledTimes(1)
    expect(h.upload).toHaveBeenCalledTimes(1)
  })

  it.each(['token', 'revision', 'origin'])('refreshes a hash-shaped cache belonging to a different %s', async mismatch => {
    const otherPrefix = mismatch === 'token' ? prefix.replace(token, 'other_customer_token')
      : mismatch === 'revision' ? prefix.replace(/-v\d+/, '-v0') : prefix.replace(webRev, '0'.repeat(16))
    const priorBytes = Buffer.from('Other cache scope')
    const priorPath = `${otherPrefix}/${createHash('sha256').update(priorBytes).digest('hex')}.pdf`
    h.rows[table].pdf_path = priorPath
    h.objects.set(priorPath, priorBytes)
    const path = await ensure()
    expect(path).not.toBeNull()
    expect(path).not.toBe(priorPath)
    expect(h.objects.get(priorPath)).toEqual(priorBytes)
    expect(h.render).toHaveBeenCalledTimes(1)
  })
})
