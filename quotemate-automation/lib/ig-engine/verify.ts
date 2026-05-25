// ════════════════════════════════════════════════════════════════════
// WP4 step 4 — render-accuracy validation.
//
// After a preview is generated, ask Gemini (vision) to compare the
// RENDERED image against the real PRODUCT photo and answer YES/NO:
// "is this the same product?". On a NO the caller does ONE bounded
// stricter re-render and re-verifies; if that recovers the match the
// better image is swapped in. Only a SECOND confirmed mismatch falls
// back to showing the real product photo to the customer directly
// ("here's the exact product you'll get") so they always see the
// truth — the spec's "quality gate". The retry is capped at one
// attempt (a second Gemini render is the cost ceiling).
//
// SAFETY / cost control:
//   • Flag-gated by WP4_RENDER_VERIFY (default OFF). Off → not a single
//     extra Gemini call, zero added latency/cost, behaviour identical
//     to today. Mirrors the DETERMINISTIC_BOM / PREVIEW_PROMPT_VERSION
//     rollout pattern already used in this codebase.
//   • Best-effort: any error / unparseable answer → treated as
//     "inconclusive" (do NOT block or discard the render). Verification
//     can never make a quote worse than not having it.
//
// The verdict PARSER is pure + unit-tested (verify.test.ts). The Gemini
// call is thin I/O, same style as generate.ts / samples.ts.
// ════════════════════════════════════════════════════════════════════

import type { ProductImage } from './product-image'

const GEMINI_TEXT_MODEL =
  process.env.GEMINI_VERIFY_MODEL ?? 'gemini-3-pro-image-preview'
const GEMINI_ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

export type Verdict = {
  /** true = same product, false = mismatch, null = inconclusive/skip */
  match: boolean | null
  reason: string
}

/** Is the post-render accuracy check switched on? Default OFF. */
export function renderVerifyEnabled(): boolean {
  return process.env.WP4_RENDER_VERIFY === '1'
}

/**
 * PURE — turn Gemini's free-text answer into a verdict. The prompt asks
 * it to start with YES or NO; we read the first explicit token and keep
 * the rest as the reason. Anything we can't read → inconclusive (null)
 * so the caller keeps the render rather than discarding a good image on
 * a parsing quirk.
 */
export function parseVerificationVerdict(text: string | null | undefined): Verdict {
  const t = (text ?? '').trim()
  if (!t) return { match: null, reason: 'empty verification response' }
  // First word/token, ignoring markdown / punctuation.
  const m = t.match(/[a-z]+/i)
  const head = (m?.[0] ?? '').toUpperCase()
  const reason = t.replace(/\s+/g, ' ').slice(0, 300)
  if (head === 'YES') return { match: true, reason }
  if (head === 'NO') return { match: false, reason }
  // Defensive: a clear yes/no anywhere in a short answer.
  if (/^\s*(match|same product|identical)\b/i.test(t)) return { match: true, reason }
  if (/\b(different|mismatch|not the same|generic)\b/i.test(t) && t.length < 160) {
    return { match: false, reason }
  }
  return { match: null, reason: `inconclusive: ${reason}` }
}

/**
 * Best-effort Gemini vision comparison. Returns a Verdict; never throws.
 * Caller must already have checked renderVerifyEnabled().
 */
export async function verifyRenderMatchesProduct(args: {
  rendered: { base64: string; mime: string }
  product: ProductImage
  productName?: string | null
}): Promise<Verdict> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return { match: null, reason: 'no GEMINI_API_KEY' }
  const prompt =
    `You are a strict QA checker. The FIRST image is an AI-rendered preview ` +
    `of a customer's space with a product installed. The SECOND image is the ` +
    `EXACT real product${args.productName ? ` ("${args.productName}")` : ''} ` +
    `that was quoted.\n\n` +
    `Does the installed product in the first image match the real product in ` +
    `the second image — same brand family, model, shape, colour and finish?\n\n` +
    `Answer with EXACTLY "YES" or "NO" as the first word, then one short ` +
    `sentence explaining. Be strict: a different model/finish/shape is NO.`
  try {
    const res = await fetch(
      `${GEMINI_ENDPOINT(GEMINI_TEXT_MODEL)}?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                { inline_data: { mime_type: args.rendered.mime, data: args.rendered.base64 } },
                { inline_data: { mime_type: args.product.mime, data: args.product.base64 } },
              ],
            },
          ],
          generation_config: { temperature: 0, response_modalities: ['TEXT'] },
        }),
      },
    )
    if (!res.ok) return { match: null, reason: `verify HTTP ${res.status}` }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text
    return parseVerificationVerdict(text)
  } catch (e: any) {
    return { match: null, reason: `verify error: ${e?.message ?? String(e)}` }
  }
}
