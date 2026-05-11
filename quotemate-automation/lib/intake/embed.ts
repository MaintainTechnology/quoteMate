// ─────────────────────────────────────────────────────────────────
// DEVIATION FROM build-guide.html step 7 (lines 1638-1649):
//
// The build-guide writes:
//     model: anthropic.embedding('voyage-3')
//
// This does not compile. The @ai-sdk/anthropic provider has no
// .embedding() method — Anthropic does not sell an embeddings
// product. Voyage AI is a separate vendor Anthropic recommends.
//
// The build-guide's own note (line 1650) hints at the workaround:
//   "OpenAI's text-embedding-3-small works fine too — just swap the
//    model line."
//
// What this version does:
//   · If VOYAGE_API_KEY is set → direct fetch to Voyage's REST API,
//     pad/truncate the result to 1536 dims to match the schema
//   · Otherwise → deterministic stub embedding so the route still
//     runs end-to-end. Stable per-input but not semantic — replace
//     with real embeddings when you sign up for Voyage or OpenAI.
//
// To upgrade to OpenAI's text-embedding-3-small (1536-dim native):
//   pnpm add @ai-sdk/openai
//   then replace the body of embedIntake with:
//     const { embedding } = await embed({
//       model: openai.embedding('text-embedding-3-small'),
//       value: summary,
//     })
// ─────────────────────────────────────────────────────────────────

import type { Intake } from './schema'

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY
const TARGET_DIM = 1536

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
    body: JSON.stringify({ input: [summary], model: 'voyage-3' }),
  })

  if (!res.ok) {
    console.warn(`Voyage embed failed (HTTP ${res.status}); falling back to stub.`)
    return stubEmbedding(summary)
  }

  const data = await res.json()
  const raw: number[] = data.data?.[0]?.embedding ?? []
  return resizeToTargetDim(raw)
}

function resizeToTargetDim(v: number[]): number[] {
  if (v.length === TARGET_DIM) return v
  if (v.length > TARGET_DIM) return v.slice(0, TARGET_DIM)
  return [...v, ...new Array(TARGET_DIM - v.length).fill(0)]
}

function stubEmbedding(text: string): number[] {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  const out = new Array(TARGET_DIM)
  for (let i = 0; i < TARGET_DIM; i++) {
    h ^= h << 13; h >>>= 0
    h ^= h >> 17; h >>>= 0
    h ^= h << 5;  h >>>= 0
    out[i] = (h / 0xffffffff) * 2 - 1
  }
  return out
}
