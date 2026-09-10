import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchStudioPng, renderStudioCarousel } from './client-render'
import { DEFAULT_CAROUSEL } from './presets'
import { STUDIO_PNG_BYTES } from './render-contract'
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
const token = vi.fn(async () => 'fresh-owner-token')
const run = (signal = new AbortController().signal) => fetchStudioPng(DEFAULT_CAROUSEL[0], 'li-carousel', token, signal)
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('authenticated Studio preview/export transport', () => {
  it('sends private copy in JSON and credentials only in the bearer header', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(png, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetcher)
    expect((await run()).type).toBe('image/png')
    expect(fetcher).toHaveBeenCalledWith('/api/studio/render', expect.objectContaining({ method: 'POST', cache: 'no-store', headers: { Authorization: 'Bearer fresh-owner-token', 'Content-Type': 'application/json' } }))
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ format: 'li-carousel', slide: DEFAULT_CAROUSEL[0] })
  })
  it.each([401, 403, 400, 413, 429, 503])('never downloads an HTTP %i response as a PNG', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private server error', { status })))
    await expect(run()).rejects.toThrow()
  })
  it('rejects false PNG MIME, empty and oversized bodies', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('not png', { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(STUDIO_PNG_BYTES + 1), { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(run()).rejects.toThrow(); await expect(run()).rejects.toThrow(); await expect(run()).rejects.toThrow()
  })
  it('does not request a render after cancellation during token retrieval', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const waiting = fetchStudioPng(DEFAULT_CAROUSEL[0], 'li-carousel', async () => { controller.abort(); return 'late-token' }, controller.signal)
    await expect(waiting).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('never calls the server without a token', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(fetchStudioPng(DEFAULT_CAROUSEL[0], 'li-carousel', async () => null, new AbortController().signal)).rejects.toThrow('Sign in')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('renders all five pages in rail order using a fresh token for each', async () => {
    const fetcher = vi.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await renderStudioCarousel(DEFAULT_CAROUSEL, 'li-carousel', token, new AbortController().signal)).toHaveLength(5)
    expect(fetcher.mock.calls.map((args: unknown[]) => JSON.parse((args[1] as RequestInit).body as string).slide.kind)).toEqual(['stat', 'list', 'steps', 'quote', 'cta'])
    expect(token).toHaveBeenCalledTimes(5)
  })
  it('fails the whole carousel on a failed page without continuing or changing the edited source', async () => {
    const before = JSON.stringify(DEFAULT_CAROUSEL)
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png' } })).mockResolvedValueOnce(new Response('outage', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(renderStudioCarousel(DEFAULT_CAROUSEL, 'li-carousel', token, new AbortController().signal)).rejects.toThrow('edits are still here')
    expect(fetcher).toHaveBeenCalledTimes(2); expect(JSON.stringify(DEFAULT_CAROUSEL)).toBe(before)
  })
})
