import { STUDIO_COPY_BYTES, STUDIO_PNG_BYTES, StudioRenderSchema, isPng } from './render-contract'
import type { Format, Slide } from './types'

export type StudioToken = () => Promise<string | null>

export async function fetchStudioPng(slide: Slide, format: Format, getToken: StudioToken, signal: AbortSignal): Promise<Blob> {
  const input = StudioRenderSchema.safeParse({ slide, format })
  if (!input.success) throw new Error('Some slide fields are too long or unsupported. Shorten the copy and try again.')
  const body = JSON.stringify(input.data)
  if (new TextEncoder().encode(body).length > STUDIO_COPY_BYTES) throw new Error('This slide contains too much copy. Shorten it and try again.')
  const token = await getToken()
  signal.throwIfAborted()
  if (!token) throw new Error('Sign in to your business account to preview or export.')
  const response = await fetch('/api/studio/render', {
    method: 'POST', signal, cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body,
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) throw new Error('Sign in to your business account to preview or export.')
    if (response.status === 400 || response.status === 413) throw new Error('Some slide fields are too long or unsupported. Shorten the copy and try again.')
    throw new Error('Studio could not render this slide. Your edits are still here. Try again.')
  }
  if (response.headers.get('content-type')?.split(';')[0].toLowerCase() !== 'image/png' || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Studio returned an incomplete image. Try again.')
  }
  const reader = response.body.getReader()
  let length = 0
  const parts: Uint8Array<ArrayBuffer>[] = []
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > STUDIO_PNG_BYTES) throw new Error('Studio returned an unsupported image. Try again.')
      parts.push(new Uint8Array(value))
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined)
    throw cause
  } finally { reader.releaseLock() }
  signal.throwIfAborted()
  const blob = new Blob(parts, { type: 'image/png' })
  if (!isPng(new Uint8Array(await blob.slice(0, 9).arrayBuffer()))) throw new Error('Studio returned an incomplete image. Try again.')
  return blob
}

export async function renderStudioCarousel(slides: readonly Slide[], format: Format, getToken: StudioToken, signal: AbortSignal): Promise<Blob[]> {
  const images: Blob[] = []
  for (const slide of slides) images.push(await fetchStudioPng(slide, format, getToken, signal))
  return images
}

export function studioBlobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The image could not be read.'))
    reader.onerror = () => reject(new Error('The image could not be read.'))
    reader.onabort = () => reject(new Error('The image read was cancelled.'))
    reader.readAsDataURL(blob)
  })
}
