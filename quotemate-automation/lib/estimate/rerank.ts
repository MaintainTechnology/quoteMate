// Provider-agnostic reranker for the RAG pipeline.
//
// After pgvector returns top-K cosine-similar past intakes, the reranker
// scores each (query, candidate) pair with a cross-encoder model that
// reads both texts together — much sharper relevance than cosine alone.
//
// Two providers supported: Voyage and Cohere. Either can be the primary
// (RAG_RERANK_PROVIDER=voyage|cohere, default voyage). When both API keys
// are set the secondary is used as automatic fallback if the primary
// call throws (HTTP 5xx, network, rate limit, etc.) — set
// RAG_RERANK_FALLBACK=false to disable that and use primary only.
//
// Disabled at runtime via RAG_RERANK_DISABLED=true. When disabled, the
// RAG pipeline falls back to ordering by cosine similarity alone.

import { pipelineLog } from '@/lib/log/pipeline'

export type RerankedDoc = {
  /** Original index in the input documents array. */
  index: number
  /** Provider-specific relevance score; higher = more relevant. */
  score: number
}

export interface Reranker {
  /** Identifier for logs / metrics, e.g. "voyage:rerank-2.5". */
  name: string
  /**
   * Re-score documents against the query and return them ordered by
   * relevance (highest first). Returns at most `topN` items. Implementations
   * MUST be deterministic for the same (query, docs, topN) tuple.
   */
  rerank(query: string, docs: string[], topN: number): Promise<RerankedDoc[]>
}

// ─────────────────────────────────────────────────────────────────
// Voyage Rerank — https://docs.voyageai.com/docs/reranker
// ─────────────────────────────────────────────────────────────────

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank'
const VOYAGE_MODEL = process.env.VOYAGE_RERANK_MODEL ?? 'rerank-2.5'

export const voyageReranker: Reranker = {
  name: `voyage:${VOYAGE_MODEL}`,
  async rerank(query, docs, topN) {
    if (!process.env.VOYAGE_API_KEY) {
      throw new Error('VOYAGE_API_KEY not set — cannot call Voyage Rerank')
    }
    if (docs.length === 0) return []

    const res = await fetch(VOYAGE_RERANK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        documents: docs,
        model: VOYAGE_MODEL,
        top_k: Math.min(topN, docs.length),
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(unreadable)')
      throw new Error(`Voyage Rerank HTTP ${res.status}: ${errBody.slice(0, 200)}`)
    }

    const json = (await res.json()) as {
      data: Array<{ index: number; relevance_score: number }>
    }
    return json.data.map((d) => ({ index: d.index, score: d.relevance_score }))
  },
}

// ─────────────────────────────────────────────────────────────────
// Cohere Rerank — https://docs.cohere.com/reference/rerank
//
// v2 endpoint accepts the same shape we already feed Voyage:
//   POST https://api.cohere.com/v2/rerank
//   { model, query, documents: string[], top_n }
// and returns
//   { results: [{ index, relevance_score }] } ordered by relevance.
//
// Score range 0.0–1.0 matches Voyage closely enough that the
// MIN_RERANK_SCORE floor in rag.ts (0.30) carries over with no
// per-provider tuning. If we ever observe systematic drift, calibrate
// the floor in rag.ts rather than warping scores here.
// ─────────────────────────────────────────────────────────────────

const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank'
const COHERE_MODEL = process.env.COHERE_RERANK_MODEL ?? 'rerank-v3.5'

export const cohereReranker: Reranker = {
  name: `cohere:${COHERE_MODEL}`,
  async rerank(query, docs, topN) {
    if (!process.env.COHERE_API_KEY) {
      throw new Error('COHERE_API_KEY not set — cannot call Cohere Rerank')
    }
    if (docs.length === 0) return []

    const res = await fetch(COHERE_RERANK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
      },
      body: JSON.stringify({
        model: COHERE_MODEL,
        query,
        documents: docs,
        top_n: Math.min(topN, docs.length),
      }),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(unreadable)')
      throw new Error(`Cohere Rerank HTTP ${res.status}: ${errBody.slice(0, 200)}`)
    }

    const json = (await res.json()) as {
      results: Array<{ index: number; relevance_score: number }>
    }
    return json.results.map((d) => ({ index: d.index, score: d.relevance_score }))
  },
}

// ─────────────────────────────────────────────────────────────────
// Chain-with-fallback wrapper
//
// Try primary; on ANY thrown error fall through to secondary. If the
// secondary also throws, re-throw the secondary error so the caller
// (rag.ts) still falls back to cosine ordering. The primary failure is
// logged so Vercel logs show whether we're being kept alive by the
// secondary — actionable signal when one provider is degraded.
// ─────────────────────────────────────────────────────────────────

export function chainWithFallback(primary: Reranker, secondary: Reranker): Reranker {
  return {
    name: `${primary.name}→${secondary.name}`,
    async rerank(query, docs, topN) {
      try {
        return await primary.rerank(query, docs, topN)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        pipelineLog('estimate').err(
          `rerank primary (${primary.name}) failed — falling back to ${secondary.name}`,
          msg,
        )
        return await secondary.rerank(query, docs, topN)
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────
// Factory — picks the configured primary, optionally wraps with
// fallback to the secondary when both keys are set.
//
// Returns null when reranking is disabled OR when the configured
// primary has no API key (so the caller in rag.ts cleanly degrades
// to cosine ordering instead of throwing on every call).
// ─────────────────────────────────────────────────────────────────

export function getReranker(): Reranker | null {
  if (process.env.RAG_RERANK_DISABLED === 'true') return null

  const provider = (process.env.RAG_RERANK_PROVIDER ?? 'voyage') as 'voyage' | 'cohere'
  const fallbackEnabled = process.env.RAG_RERANK_FALLBACK !== 'false'
  const hasVoyage = !!process.env.VOYAGE_API_KEY
  const hasCohere = !!process.env.COHERE_API_KEY

  if (provider === 'cohere') {
    if (!hasCohere) return null
    return fallbackEnabled && hasVoyage
      ? chainWithFallback(cohereReranker, voyageReranker)
      : cohereReranker
  }

  // Default — voyage primary
  if (!hasVoyage) return null
  return fallbackEnabled && hasCohere
    ? chainWithFallback(voyageReranker, cohereReranker)
    : voyageReranker
}
