import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { DEFAULT_CAROUSEL, STUDIO_PHOTOS } from '@/lib/studio/presets'
import { STUDIO_COPY_BYTES, STUDIO_PNG_BYTES } from '@/lib/studio/render-contract'

const h = vi.hoisted(() => ({
  auth: vi.fn(), read: vi.fn(), fonts: vi.fn(), slide: vi.fn(), image: vi.fn(), body: vi.fn(),
  png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
}))
vi.mock('@/lib/marketing/auth', () => ({ tenantFromBearer: h.auth }))
vi.mock('node:fs', () => ({ readFileSync: h.read }))
vi.mock('@/lib/studio/fonts', () => ({ studioFonts: h.fonts }))
vi.mock('@/lib/studio/templates', () => ({ renderSlide: h.slide }))
vi.mock('next/og', () => ({ ImageResponse: class {
  constructor(...args: unknown[]) { h.image(...args) }
  arrayBuffer() { return h.body() }
} }))
import { GET, POST } from './route'

const request = (slide: unknown = DEFAULT_CAROUSEL[0], extra: Record<string, unknown> = {}) => new Request('https://app.invalid/api/studio/render', {
  method: 'POST', headers: { Authorization: 'Bearer owned', 'Content-Type': 'application/json' },
  body: JSON.stringify({ format: 'li-carousel', slide, ...extra }),
})
const get = (query: string) => new Request(`https://app.invalid/api/studio/render?${query}`, { headers: { Authorization: 'Bearer owned' } })
function untouched() { expect(h.read).not.toHaveBeenCalled(); expect(h.fonts).not.toHaveBeenCalled(); expect(h.slide).not.toHaveBeenCalled(); expect(h.image).not.toHaveBeenCalled() }

beforeEach(() => {
  vi.resetAllMocks()
  h.auth.mockResolvedValue({ id: 'owned-tenant' })
  h.read.mockReturnValue(h.png)
  h.fonts.mockReturnValue([])
  h.slide.mockReturnValue('rendered')
  h.body.mockResolvedValue(Uint8Array.from(h.png).buffer)
})

describe('Studio owner render boundary', () => {
  it.each([GET, POST])('rejects anonymous/revoked/no-owner access before files or renderer', async (handler) => {
    h.auth.mockResolvedValue(null)
    const response = await handler(request())
    expect(response.status).toBe(401); untouched()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
  it('fails closed on auth dependency failure without exposing details', async () => {
    h.auth.mockRejectedValue(new Error('secret database endpoint'))
    const response = await POST(request())
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'studio_unavailable' }); untouched()
  })
  it.each(['../../.env', '/studio/photos/../../.env', 'C:\\secret.png', 'https://evil.invalid/x.png', 'data:image/png;base64,AAAA', '/studio/photos/hero-main.png?x=1', '__proto__'])('rejects unapproved photo %s before any I/O', async (src) => {
    const response = await POST(request({ ...DEFAULT_CAROUSEL[0], photo: { src } }))
    expect(response.status).toBe(400); untouched()
  })
  it.each(['__proto__', 'constructor', 'toString', 'flyer-a4', 'ig-story', 'li-single'])('rejects unoffered/prototype format %s', async (format) => {
    expect((await GET(get(`format=${format}`))).status).toBe(400); untouched()
  })
  it.each([
    null, [], {}, { kind: 'unknown' },
    { ...DEFAULT_CAROUSEL[0], lines: [['one', 'two']] },
    { ...DEFAULT_CAROUSEL[0], lines: [['one', 'two', 'three'], ['a', 'b'], ['c', 'd']] },
    { ...DEFAULT_CAROUSEL[0], sub: { src: '/secret' } },
    { ...DEFAULT_CAROUSEL[0], sub: 'x'.repeat(501) },
    { ...DEFAULT_CAROUSEL[0], sub: 'Customer private 中文' },
    { ...DEFAULT_CAROUSEL[0], sub: 'Emoji 😀' },
    { ...DEFAULT_CAROUSEL[0], bar: Array(7).fill('x') },
    { ...DEFAULT_CAROUSEL[0], photo: { src: '/studio/photos/hero-main.png', pos: 'url(https://evil.invalid)' } },
    { ...DEFAULT_CAROUSEL[0], photo: { src: '/studio/photos/hero-main.png', extra: true } },
  ])('rejects malformed or oversized nested input %#', async (slide) => {
    expect((await POST(request(slide))).status).toBe(400); untouched()
  })
  it('rejects caller tenant selection instead of accepting a foreign tenant ID', async () => {
    expect((await POST(request(DEFAULT_CAROUSEL[0], { tenantId: 'foreign' }))).status).toBe(400); untouched()
  })
  it.each(['slide=5', 'slide=-1', 'slide=0oops', 'slide=0&slide=1', 'format=li-carousel&format=constructor', 'd=####', 'd=', 'd=e30=&slide=0', 'token=guest'])('rejects ambiguous or invalid GET %s', async (query) => {
    expect((await GET(get(query))).status).toBe(400); untouched()
  })
  it('rejects oversized encoded GET before decoding/rendering', async () => {
    expect((await GET(get(`d=${'A'.repeat(4 * Math.ceil(STUDIO_COPY_BYTES / 3) + 4)}`))).status).toBe(413); untouched()
  })
  it('enforces actual POST bytes when Content-Length is absent or false', async () => {
    const req = new Request('https://app.invalid/api/studio/render', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1' }, body: ' '.repeat(STUDIO_COPY_BYTES + 1) })
    expect((await POST(req)).status).toBe(413); untouched()
  })
  it('rejects malformed JSON and non-JSON POSTs', async () => {
    expect((await POST(new Request('https://app.invalid/api/studio/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }))).status).toBe(400)
    expect((await POST(new Request('https://app.invalid/api/studio/render', { method: 'POST', body: '{}' }))).status).toBe(415); untouched()
  })
  it.each(DEFAULT_CAROUSEL.map((slide, index) => [index, slide] as const))('preserves slide %i fields, layout, and fixed dimensions', async (index, slide) => {
    const response = await POST(request(slide))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('vary')).toBe('Authorization')
    expect(h.slide).toHaveBeenCalledWith({ ...slide, ...(slide.photo ? { photo: { ...slide.photo, src: `data:image/png;base64,${h.png.toString('base64')}` } } : {}) }, 'li-carousel')
    expect(h.image).toHaveBeenCalledWith('rendered', { width: 1080, height: 1350, fonts: [] })
    expect(Buffer.from(await response.arrayBuffer())).toEqual(h.png)
    expect(index).toBeGreaterThanOrEqual(0)
  })
  it('supports every exact approved asset and None without arbitrary path reads', async () => {
    for (const id of STUDIO_PHOTOS) {
      expect((await POST(request({ ...DEFAULT_CAROUSEL[0], photo: { src: `/studio/photos/${id}.png` } }))).status).toBe(200)
      expect(h.read).toHaveBeenLastCalledWith(join(process.cwd(), 'public', `studio/photos/${id}.png`))
    }
    h.read.mockClear()
    expect((await POST(request({ ...DEFAULT_CAROUSEL[0], photo: null }))).status).toBe(200)
    expect(h.read).not.toHaveBeenCalled()
  })
  it('keeps authenticated GET preset and encoded Unicode copy compatible', async () => {
    expect((await GET(get('slide=2'))).status).toBe(200)
    const slide = { ...DEFAULT_CAROUSEL[0], sub: 'Café — review {first}.' }
    expect((await GET(get(`d=${encodeURIComponent(Buffer.from(JSON.stringify(slide)).toString('base64'))}`))).status).toBe(200)
    expect(h.slide.mock.lastCall?.[0].sub).toBe(slide.sub)
  })
  it('does not silently omit a missing or corrupt approved photo', async () => {
    h.read.mockImplementationOnce(() => { throw new Error('secret absolute filename') })
    const response = await POST(request())
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'render_unavailable' })
    h.read.mockReturnValue(Buffer.from('not png'))
    expect((await POST(request())).status).toBe(503)
    expect(h.image).not.toHaveBeenCalled()
  })
  it('converts lazy renderer failures and invalid/oversized outputs into controlled errors', async () => {
    h.body.mockRejectedValueOnce(new Error('secret renderer stack'))
    expect((await POST(request())).status).toBe(503)
    h.body.mockResolvedValueOnce(new ArrayBuffer(0))
    expect((await POST(request())).status).toBe(503)
    h.body.mockResolvedValueOnce(new ArrayBuffer(STUDIO_PNG_BYTES + 1))
    expect((await POST(request())).status).toBe(503)
  })
})
