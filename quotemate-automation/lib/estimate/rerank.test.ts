// Reranker tests — provider impls + chain-with-fallback + factory.
//
// Mock the global fetch so we can drive HTTP response shape/status
// without actually calling Voyage or Cohere. Env vars are stubbed per-
// test so each scenario controls exactly which providers are "available".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  voyageReranker,
  cohereReranker,
  chainWithFallback,
  getReranker,
  type Reranker,
  type RerankedDoc,
} from './rerank'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

// Snapshot the env vars we mutate so each test resets cleanly. vi.stubEnv
// would also work but explicit save/restore mirrors the existing pattern
// in lib/ig-engine/providers/gemini.test.ts.
const ENV_KEYS = [
  'VOYAGE_API_KEY',
  'COHERE_API_KEY',
  'RAG_RERANK_PROVIDER',
  'RAG_RERANK_FALLBACK',
  'RAG_RERANK_DISABLED',
] as const

function saveEnv() {
  const snap: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) snap[k] = process.env[k]
  return snap
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k]
    else process.env[k] = snap[k]
  }
}

// ─── voyageReranker ───────────────────────────────────────────────

describe('voyageReranker', () => {
  let snap: Record<string, string | undefined>
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    snap = saveEnv()
    process.env.VOYAGE_API_KEY = 'voyage-test'
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    restoreEnv(snap)
  })

  it('returns parsed results ordered as the API returned them', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        data: [
          { index: 2, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.65 },
        ],
      }),
    )
    const out = await voyageReranker.rerank('q', ['a', 'b', 'c'], 2)
    expect(out).toEqual<RerankedDoc[]>([
      { index: 2, score: 0.91 },
      { index: 0, score: 0.65 },
    ])
  })

  it('sends a Bearer token + the Voyage payload shape', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: [] }))
    await voyageReranker.rerank('q', ['a', 'b'], 5)
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.voyageai.com/v1/rerank')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer voyage-test')
    const body = JSON.parse(init.body as string)
    expect(body.query).toBe('q')
    expect(body.documents).toEqual(['a', 'b'])
    expect(body.top_k).toBe(2) // clamped to docs.length
  })

  it('throws when VOYAGE_API_KEY is missing', async () => {
    delete process.env.VOYAGE_API_KEY
    await expect(voyageReranker.rerank('q', ['a'], 1)).rejects.toThrow(/VOYAGE_API_KEY/)
  })

  it('throws on non-2xx HTTP responses (so the chain wrapper can fall back)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse('rate limited', false, 429))
    await expect(voyageReranker.rerank('q', ['a'], 1)).rejects.toThrow(/Voyage Rerank HTTP 429/)
  })

  it('returns [] for empty input without calling the API', async () => {
    const out = await voyageReranker.rerank('q', [], 5)
    expect(out).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─── cohereReranker ───────────────────────────────────────────────

describe('cohereReranker', () => {
  let snap: Record<string, string | undefined>
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    snap = saveEnv()
    process.env.COHERE_API_KEY = 'cohere-test'
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    restoreEnv(snap)
  })

  it('maps Cohere `results` to the shared RerankedDoc shape', async () => {
    // Cohere uses `results` (not `data`) and `top_n` (not `top_k`).
    fetchSpy.mockResolvedValue(
      jsonResponse({
        results: [
          { index: 1, relevance_score: 0.88 },
          { index: 0, relevance_score: 0.42 },
        ],
      }),
    )
    const out = await cohereReranker.rerank('q', ['a', 'b'], 2)
    expect(out).toEqual<RerankedDoc[]>([
      { index: 1, score: 0.88 },
      { index: 0, score: 0.42 },
    ])
  })

  it('sends the v2 endpoint + Cohere payload shape', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ results: [] }))
    await cohereReranker.rerank('q', ['a', 'b'], 5)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.cohere.com/v2/rerank')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cohere-test')
    const body = JSON.parse(init.body as string)
    expect(body.top_n).toBe(2) // Cohere field name, clamped to docs.length
    expect(body.documents).toEqual(['a', 'b'])
  })

  it('throws when COHERE_API_KEY is missing', async () => {
    delete process.env.COHERE_API_KEY
    await expect(cohereReranker.rerank('q', ['a'], 1)).rejects.toThrow(/COHERE_API_KEY/)
  })

  it('throws on non-2xx HTTP (so the chain wrapper can fall back)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse('server error', false, 503))
    await expect(cohereReranker.rerank('q', ['a'], 1)).rejects.toThrow(/Cohere Rerank HTTP 503/)
  })
})

// ─── chainWithFallback ────────────────────────────────────────────

function fakeReranker(name: string, behaviour: () => Promise<RerankedDoc[]>): Reranker {
  return { name, rerank: behaviour }
}

describe('chainWithFallback', () => {
  it('returns primary result and never calls secondary on success', async () => {
    const secondarySpy = vi.fn(async () => [{ index: 0, score: 0.1 }])
    const primary = fakeReranker('p', async () => [{ index: 0, score: 0.9 }])
    const secondary = fakeReranker('s', secondarySpy)
    const chain = chainWithFallback(primary, secondary)
    const out = await chain.rerank('q', ['a'], 1)
    expect(out).toEqual([{ index: 0, score: 0.9 }])
    expect(secondarySpy).not.toHaveBeenCalled()
  })

  it('falls through to secondary when primary throws', async () => {
    const primary = fakeReranker('p', async () => {
      throw new Error('primary down')
    })
    const secondary = fakeReranker('s', async () => [{ index: 0, score: 0.7 }])
    const chain = chainWithFallback(primary, secondary)
    const out = await chain.rerank('q', ['a'], 1)
    expect(out).toEqual([{ index: 0, score: 0.7 }])
  })

  it('re-throws when secondary also fails — caller falls back to cosine', async () => {
    const primary = fakeReranker('p', async () => {
      throw new Error('primary down')
    })
    const secondary = fakeReranker('s', async () => {
      throw new Error('secondary down too')
    })
    const chain = chainWithFallback(primary, secondary)
    await expect(chain.rerank('q', ['a'], 1)).rejects.toThrow(/secondary down too/)
  })

  it('chain.name reflects the order so logs show which was primary', () => {
    const chain = chainWithFallback(
      fakeReranker('voyage:rerank-2.5', async () => []),
      fakeReranker('cohere:rerank-v3.5', async () => []),
    )
    expect(chain.name).toBe('voyage:rerank-2.5→cohere:rerank-v3.5')
  })
})

// ─── getReranker factory ──────────────────────────────────────────

describe('getReranker', () => {
  let snap: Record<string, string | undefined>
  beforeEach(() => {
    snap = saveEnv()
    // Start each test from a clean slate — no keys, no provider override.
    for (const k of ENV_KEYS) delete process.env[k]
  })
  afterEach(() => {
    restoreEnv(snap)
  })

  it('returns null when RAG_RERANK_DISABLED=true regardless of keys', () => {
    process.env.RAG_RERANK_DISABLED = 'true'
    process.env.VOYAGE_API_KEY = 'v'
    process.env.COHERE_API_KEY = 'c'
    expect(getReranker()).toBeNull()
  })

  it('returns null when no API keys are set (degrade to cosine)', () => {
    expect(getReranker()).toBeNull()
  })

  it('returns null when primary provider has no key, even if other key is set', () => {
    // Cohere requested but no Cohere key — do NOT silently fall back to
    // Voyage as primary; that would hide a config bug. The caller in
    // rag.ts treats null as "cosine ordering only".
    process.env.RAG_RERANK_PROVIDER = 'cohere'
    process.env.VOYAGE_API_KEY = 'v'
    expect(getReranker()).toBeNull()
  })

  it('default provider = voyage, no Cohere key → returns Voyage alone (back-compat)', () => {
    process.env.VOYAGE_API_KEY = 'v'
    const r = getReranker()
    expect(r?.name).toBe(voyageReranker.name)
  })

  it('default provider = voyage, both keys set → returns voyage→cohere chain', () => {
    process.env.VOYAGE_API_KEY = 'v'
    process.env.COHERE_API_KEY = 'c'
    const r = getReranker()
    expect(r?.name).toBe(`${voyageReranker.name}→${cohereReranker.name}`)
  })

  it('provider=cohere, both keys set → returns cohere→voyage chain', () => {
    process.env.RAG_RERANK_PROVIDER = 'cohere'
    process.env.VOYAGE_API_KEY = 'v'
    process.env.COHERE_API_KEY = 'c'
    const r = getReranker()
    expect(r?.name).toBe(`${cohereReranker.name}→${voyageReranker.name}`)
  })

  it('RAG_RERANK_FALLBACK=false → returns primary alone even when both keys set', () => {
    process.env.VOYAGE_API_KEY = 'v'
    process.env.COHERE_API_KEY = 'c'
    process.env.RAG_RERANK_FALLBACK = 'false'
    const r = getReranker()
    expect(r?.name).toBe(voyageReranker.name)
  })

  it('provider=cohere alone (no voyage key) → returns Cohere alone, not null', () => {
    process.env.RAG_RERANK_PROVIDER = 'cohere'
    process.env.COHERE_API_KEY = 'c'
    const r = getReranker()
    expect(r?.name).toBe(cohereReranker.name)
  })
})
