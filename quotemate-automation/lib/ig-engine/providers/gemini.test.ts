// IG Engine — Gemini provider adapter tests. Mock the global fetch
// so we can inspect the exact payload the adapter sends, plus parse
// behaviour on the response. This is the contract Phase 1 promises:
// callers can swap from inline fetch to provider.renderImage() and the
// wire format stays byte-identical to the prior implementation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { geminiProvider } from './gemini'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const IMAGE_OK = {
  candidates: [
    {
      content: {
        parts: [
          {
            inline_data: { mime_type: 'image/png', data: 'AAA' },
          },
        ],
      },
    },
  ],
}

const TEXT_OK = {
  candidates: [
    {
      content: { parts: [{ text: 'YES — matches.' }] },
    },
  ],
}

describe('geminiProvider.renderImage', () => {
  const prevKey = process.env.GEMINI_API_KEY
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key'
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(IMAGE_OK))
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = prevKey
  })

  it('sends systemInstruction + user text + low-temp image config', async () => {
    await geminiProvider.renderImage({
      system: 'SYS',
      user: 'USER',
    })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.systemInstruction.parts[0].text).toBe('SYS')
    expect(body.contents[0].role).toBe('user')
    expect(body.contents[0].parts[0]).toEqual({ text: 'USER' })
    expect(body.generation_config.temperature).toBe(0.1)
    expect(body.generation_config.response_modalities).toEqual(['IMAGE'])
    expect(body.generation_config.image_config).toBeUndefined()
  })

  it('attaches source image then labelled reference image, in order', async () => {
    await geminiProvider.renderImage({
      system: 'SYS',
      user: 'USER',
      sourceImage: { base64: 'SRC', mime: 'image/jpeg' },
      reference: {
        image: { base64: 'REF', mime: 'image/png' },
        label: 'PRODUCT REFERENCE — exact product',
      },
    })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.contents[0].parts).toEqual([
      { text: 'USER' },
      { inline_data: { mime_type: 'image/jpeg', data: 'SRC' } },
      { text: 'PRODUCT REFERENCE — exact product' },
      { inline_data: { mime_type: 'image/png', data: 'REF' } },
    ])
  })

  it('appends extraStrict feedback to the user message', async () => {
    await geminiProvider.renderImage({
      system: 'SYS',
      user: 'USER',
      extraStrict: 'FIX THE COUNT',
    })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.contents[0].parts[0].text).toBe('USER\n\nFIX THE COUNT')
  })

  it('passes aspect ratio through as image_config.aspect_ratio', async () => {
    await geminiProvider.renderImage({
      system: 'SYS',
      user: 'USER',
      aspectRatio: '16:9',
    })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.generation_config.image_config).toEqual({ aspect_ratio: '16:9' })
  })

  it('returns the inline image bytes from the response', async () => {
    const out = await geminiProvider.renderImage({ system: 'SYS', user: 'USER' })
    expect(out).toEqual({ base64: 'AAA', mime: 'image/png' })
  })

  it('throws when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY
    await expect(
      geminiProvider.renderImage({ system: 'SYS', user: 'USER' }),
    ).rejects.toThrow(/GEMINI_API_KEY/)
  })

  it('throws with the status code on a non-200 response', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false, 500))
    await expect(
      geminiProvider.renderImage({ system: 'SYS', user: 'USER' }),
    ).rejects.toThrow(/Gemini HTTP 500/)
  })

  it('throws when the response carries no image data', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'refused' }] } }],
      }),
    )
    await expect(
      geminiProvider.renderImage({ system: 'SYS', user: 'USER' }),
    ).rejects.toThrow(/no image data/)
  })
})

describe('geminiProvider.generateText', () => {
  const prevKey = process.env.GEMINI_API_KEY
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key'
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(TEXT_OK))
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = prevKey
  })

  it('sends prompt + image inputs with TEXT response modality', async () => {
    const out = await geminiProvider.generateText!({
      prompt: 'judge this',
      images: [{ base64: 'IMG', mime: 'image/png' }],
    })
    expect(out).toBe('YES — matches.')
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.contents[0].parts).toEqual([
      { text: 'judge this' },
      { inline_data: { mime_type: 'image/png', data: 'IMG' } },
    ])
    expect(body.generation_config.response_modalities).toEqual(['TEXT'])
    expect(body.generation_config.temperature).toBe(0)
  })

  it('returns empty string when the response has no text', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ candidates: [{ content: { parts: [] } }] }),
    )
    const out = await geminiProvider.generateText!({ prompt: 'x' })
    expect(out).toBe('')
  })
})

describe('per-call model override', () => {
  const prevKey = process.env.GEMINI_API_KEY
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key'
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(IMAGE_OK))
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = prevKey
  })

  it('renderImage uses req.model when provided', async () => {
    await geminiProvider.renderImage({
      system: 'SYS',
      user: 'USER',
      model: 'gemini-other-model',
    })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('gemini-other-model:generateContent')
  })

  it('generateText uses req.model when provided', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(TEXT_OK))
    await geminiProvider.generateText!({
      prompt: 'judge',
      model: 'gemini-judge-model',
    })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('gemini-judge-model:generateContent')
  })
})

describe('geminiProvider.capabilities', () => {
  it('advertises edit, text-to-image and vision', () => {
    expect(geminiProvider.name).toBe('gemini')
    expect(geminiProvider.capabilities).toEqual({
      edit: true,
      textToImage: true,
      vision: true,
    })
  })
})
