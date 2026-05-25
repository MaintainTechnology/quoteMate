// Voyage voyage-3-large embeddings @ 1024 native dims.
//
// Pairs with migration 057_voyage3_large_1024.sql which collapsed
// intakes.embedding from vector(1536) (voyage-3 zero-padded) down to
// vector(1024) (voyage-3-large native). No more padding — the column
// dim and the model dim are now identical.
//
// Falls back to a deterministic stub when VOYAGE_API_KEY is unset so
// dev runs without a key still complete end-to-end (the stub is stable
// per-input but not semantic — RAG retrieval will be garbage on stub,
// which is fine for local dev where there's no real history anyway).

import type { Intake } from './schema'

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY
const VOYAGE_MODEL = process.env.VOYAGE_EMBED_MODEL ?? 'voyage-3-large'
const EMBED_DIM = 1024

export async function embedIntake(intake: Intake) {
  // v5: include trade in the embed summary so cross-trade similarity is
  // explicitly distinguished (the SQL match_intakes function also pre-
  // filters by job_type, so this is belt-and-braces).
  const summary = `trade=${intake.trade ?? 'electrical'} ${intake.job_type} count=${intake.scope.item_count ?? '?'} new=${intake.scope.is_new_install ?? '?'} ${intake.scope.indoor_outdoor ?? ''} ${intake.risks.join(' ')}`

  if (!VOYAGE_API_KEY) {
    return stubEmbedding(summary)
  }

  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: [summary], model: VOYAGE_MODEL }),
  })

  if (!res.ok) {
    console.warn(`Voyage embed failed (HTTP ${res.status}); falling back to stub.`)
    return stubEmbedding(summary)
  }

  const data = await res.json()
  const raw: number[] = data.data?.[0]?.embedding ?? []
  if (raw.length !== EMBED_DIM) {
    console.warn(
      `Voyage returned ${raw.length}-dim vector, expected ${EMBED_DIM} (model=${VOYAGE_MODEL}); falling back to stub.`,
    )
    return stubEmbedding(summary)
  }
  return raw
}

function stubEmbedding(text: string): number[] {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  const out = new Array(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) {
    h ^= h << 13; h >>>= 0
    h ^= h >> 17; h >>>= 0
    h ^= h << 5;  h >>>= 0
    out[i] = (h / 0xffffffff) * 2 - 1
  }
  return out
}
