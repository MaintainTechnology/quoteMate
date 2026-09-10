// Owner-only, non-persistent Brand Studio rendering. POST keeps custom copy
// out of URLs; GET remains compatible with authenticated preset/custom callers.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tenantFromBearer } from '@/lib/marketing/auth'
import { FORMATS, type Slide } from '@/lib/studio/types'
import { studioFonts } from '@/lib/studio/fonts'
import { renderSlide } from '@/lib/studio/templates'
import { DEFAULT_CAROUSEL } from '@/lib/studio/presets'
import { STUDIO_ASSETS, STUDIO_COPY_BYTES, STUDIO_PNG_BYTES, StudioRenderSchema, isPng } from '@/lib/studio/render-contract'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization', 'X-Content-Type-Options': 'nosniff' }
const error = (code: string, status: number) => Response.json({ error: code }, { status, headers })

class InvalidRender extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}

// Never join a caller path. The validated ID selects a constant asset path.
function inlinePhoto(slide: Slide): Slide {
  if (!slide.photo) return slide
  const asset = Object.hasOwn(STUDIO_ASSETS, slide.photo.src) ? STUDIO_ASSETS[slide.photo.src] : null
  if (!asset) throw new InvalidRender('invalid_render')
  const data = readFileSync(join(process.cwd(), 'public', asset))
  if (!isPng(data)) throw new Error('unavailable_asset')
  return { ...slide, photo: { ...slide.photo, src: `data:image/png;base64,${data.toString('base64')}` } }
}

async function inputFromRequest(req: Request): Promise<unknown> {
  const url = new URL(req.url)
  if (req.method === 'GET') {
    const params = url.searchParams
    if ([...params.keys()].some((key) => !['format', 'slide', 'd'].includes(key) || params.getAll(key).length !== 1)) throw new InvalidRender('invalid_render')
    const format = params.get('format') ?? 'li-carousel'
    if (format !== 'li-carousel' || (params.has('d') && params.has('slide'))) throw new InvalidRender('invalid_render')
    if (params.has('d')) {
      const encoded = params.get('d')!
      if (encoded.length > 4 * Math.ceil(STUDIO_COPY_BYTES / 3)) throw new InvalidRender('render_too_large', 413)
      if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new InvalidRender('invalid_render')
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length > STUDIO_COPY_BYTES) throw new InvalidRender('render_too_large', 413)
      return { format, slide: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    }
    const index = params.get('slide') ?? '0'
    if (!/^[0-4]$/.test(index)) throw new InvalidRender('invalid_render')
    return { format, slide: DEFAULT_CAROUSEL[Number(index)] }
  }
  if (url.search) throw new InvalidRender('invalid_render')
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new InvalidRender('invalid_content_type', 415)
  const length = req.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > STUDIO_COPY_BYTES)) throw new InvalidRender('render_too_large', 413)
  if (!req.body) throw new InvalidRender('invalid_render')
  const reader = req.body.getReader()
  let count = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > STUDIO_COPY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new InvalidRender('render_too_large', 413)
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

async function render(req: Request) {
  // Established marketing contract: authenticated tenant owner, no paid-plan
  // requirement. No caller tenant or public token is used.
  try {
    if (!(await tenantFromBearer(req))) return error('unauthorized', 401)
  } catch { return error('studio_unavailable', 503) }

  let input
  try {
    const parsed = StudioRenderSchema.safeParse(await inputFromRequest(req))
    if (!parsed.success) return error('invalid_render', 400)
    input = parsed.data
  } catch (cause) {
    return cause instanceof InvalidRender ? error(cause.code, cause.status) : error('invalid_render', 400)
  }
  try {
    const size = FORMATS[input.format]
    // next/og loads its bundled fonts/WASM on import. Keep even that file work
    // behind ownership and complete shape/size/glyph validation.
    const { ImageResponse } = await import('next/og')
    const response = new ImageResponse(renderSlide(inlinePhoto(input.slide), input.format), {
      width: size.w, height: size.h, fonts: studioFonts() as never,
    })
    // ImageResponse renders lazily. Materialise before returning successful
    // HTTP headers, so a stream failure cannot look like a completed export.
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > STUDIO_PNG_BYTES || !isPng(new Uint8Array(bytes))) throw new Error('invalid_image')
    return new Response(bytes, { headers: { ...headers, 'Content-Type': 'image/png' } })
  } catch { return error('render_unavailable', 503) }
}

export async function GET(req: Request) { return render(req) }
export async function POST(req: Request) { return render(req) }
