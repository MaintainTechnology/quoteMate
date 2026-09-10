import { afterEach, describe, expect, it, vi } from 'vitest'
import { PNG } from 'pngjs'
import { DEFAULT_CAROUSEL } from '@/lib/studio/presets'
import { studioLocalGlyphs } from '@/lib/studio/local-glyphs'
import type { Slide } from '@/lib/studio/types'
vi.mock('@/lib/marketing/auth', () => ({ tenantFromBearer: async () => ({ id: 'isolated-fixture-owner' }) }))
import { POST } from '@/app/api/studio/render/route'
afterEach(() => vi.unstubAllGlobals())

describe('Studio actual offline PNG output', () => {
  const allLocalGlyphs = Array.from({ length: 9000 }, (_, code) => String.fromCodePoint(code)).filter(studioLocalGlyphs).join('')
  const fixtures: Slide[] = [...DEFAULT_CAROUSEL, { ...DEFAULT_CAROUSEL[4], kind: 'cta', h: 'Local character coverage', btn: `${allLocalGlyphs}→` } as Slide]
  it.each(fixtures.map((slide, index) => [`${slide.kind}-${index}`, slide] as const))('renders %s from bundled fonts/photos at its declared dimensions', async (_kind, slide) => {
    // No provider, auth or network side effects are allowed by these fixtures.
    const originalFetch = globalThis.fetch
    const network = vi.fn()
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      // WASM uses an inline data URI on initial load; it has no network I/O.
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('data:application/octet-stream;base64,')) return originalFetch(input, init)
      network(url)
      return Promise.reject(new Error('Network disabled in Studio fixture'))
    })
    const response = await POST(new Request('https://app.invalid/api/studio/render', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'li-carousel', slide }),
    }))
    expect(response.status).toBe(200)
    const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()))
    expect([png.width, png.height]).toEqual([1080, 1350])
    // The real output contains content, rather than one solid or blank page.
    const first = png.data.readUInt32BE(0)
    let varied = false
    for (let offset = 4; offset < png.data.length; offset += 4) {
      if (png.data.readUInt32BE(offset) !== first) { varied = true; break }
    }
    expect(varied).toBe(true)
    expect(network).not.toHaveBeenCalled()
  })
})
