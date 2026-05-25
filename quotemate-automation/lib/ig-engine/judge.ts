// ════════════════════════════════════════════════════════════════════
// Item 2 — expanded verify→retry judge.
//
// A single-shot image prompt is never reliable for count / product /
// position. Production accuracy comes from a loop: generate → judge →
// regenerate with the SPECIFIC defect named. verify.ts (WP4) only
// judged product-match; this judge checks every failure mode the
// operator reported — count, product, positioning, existing-fixture
// removal — and returns STRUCTURED JSON so generate.ts can act on it.
//
// SAFETY (mirrors verify.ts):
//   · Flag-gated by PREVIEW_VERIFY_LOOP (default OFF) — off means not a
//     single extra call, behaviour identical to today.
//   · Best-effort: any error / unreadable answer → an INCONCLUSIVE
//     judgement with pass=true, so the loop keeps the render rather
//     than discarding a good image on a parsing quirk. Verification can
//     never make a quote worse than not having it.
//
// The pure logic — parsePreviewJudgement, buildJudgePrompt,
// defectFeedback, isClaudeJudgeModel — is unit-tested (judge.test.ts).
// judgePreview is thin vision I/O, same style as verify.ts.
//
// JUDGE MODEL: env-swappable via PREVIEW_JUDGE_MODEL. Default is Gemini;
// set it to a Claude model id (e.g. claude-sonnet-4-6) to route to the
// INDEPENDENT Claude-vision judge. A Claude grader is a DIFFERENT model
// from the Gemini generator, so it does not share the generator's
// blind spots — if Gemini miscounted while rendering it tends to
// miscount while judging itself. This is the recommended judge for the
// verify loop.
// ════════════════════════════════════════════════════════════════════

import { geminiProvider } from './providers/gemini'

// The configured judge model. A "claude-*" id routes to the AI SDK
// path; anything else is forwarded to the Gemini provider as the
// per-call model override.
const JUDGE_MODEL =
  process.env.PREVIEW_JUDGE_MODEL ?? 'gemini-3-pro-image-preview'

/** PURE — is the configured judge a Claude model (→ AI SDK path)? */
export function isClaudeJudgeModel(model: string = JUDGE_MODEL): boolean {
  return /claude/i.test(model)
}

export type PreviewJudgement = {
  /** How many fittings the judge counted in the render. */
  countSeen: number | null
  /** Per-check verdicts: true = ok, false = defect, null = not assessed. */
  countOk: boolean | null
  productOk: boolean | null
  positionOk: boolean | null
  existingRemovedOk: boolean | null
  /** Free-text defect descriptions, fed back into the retry render. */
  defects: string[]
  /** Derived: true iff NO individual check is explicitly false. An
   *  inconclusive judgement (all null) passes — never a false reject. */
  pass: boolean
  /** Diagnostic note when the judge response was unreadable. */
  note?: string
}

/** Is the generate→judge→retry loop switched on? Default OFF. */
export function verifyLoopEnabled(): boolean {
  return process.env.PREVIEW_VERIFY_LOOP === '1'
}

/** Max stricter re-renders per photo after the first attempt. Default 2. */
export function verifyMaxRetries(): number {
  const n = Number(process.env.PREVIEW_VERIFY_MAX_RETRIES)
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 2
}

// ─── PURE: coercion helpers ───
function coerceBool(v: unknown): boolean | null {
  if (v === true || v === false) return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === 'yes' || s === 'ok' || s === 'pass') return true
    if (s === 'false' || s === 'no' || s === 'fail') return false
  }
  return null
}

function coerceNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.trim())
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * PURE — turn the judge's response into a structured PreviewJudgement.
 * Robust to markdown fences and surrounding prose. Anything unreadable
 * collapses to an inconclusive judgement with pass=true so the caller
 * keeps the render and stops retrying (never a false reject).
 */
export function parsePreviewJudgement(
  text: string | null | undefined,
): PreviewJudgement {
  const inconclusive = (note: string): PreviewJudgement => ({
    countSeen: null,
    countOk: null,
    productOk: null,
    positionOk: null,
    existingRemovedOk: null,
    defects: [],
    pass: true,
    note,
  })

  const t = (text ?? '').trim()
  if (!t) return inconclusive('empty judge response')

  // Pull the first {...} block — tolerates ```json fences and prose.
  const m = t.match(/\{[\s\S]*\}/)
  if (!m) return inconclusive('no JSON object in judge response')

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return inconclusive('unparseable judge JSON')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return inconclusive('judge JSON not an object')
  }

  const countOk = coerceBool(obj.count_ok)
  const productOk = coerceBool(obj.product_ok)
  const positionOk = coerceBool(obj.position_ok)
  const existingRemovedOk = coerceBool(obj.existing_removed_ok)
  const countSeen = coerceNum(obj.count_seen)
  const defects = Array.isArray(obj.defects)
    ? (obj.defects as unknown[])
        .filter((d): d is string => typeof d === 'string' && d.trim() !== '')
        .map(d => d.trim())
    : []

  // pass = no explicit failure. null (not assessed) does NOT fail.
  const pass = ![countOk, productOk, positionOk, existingRemovedOk].some(
    v => v === false,
  )

  return { countSeen, countOk, productOk, positionOk, existingRemovedOk, defects, pass }
}

/**
 * PURE — build the QA instruction sent to the judge. Asks for STRICT
 * JSON only, with one boolean per failure mode plus a defect list.
 */
export function buildJudgePrompt(opts: {
  expectedCount: number | null
  productName: string | null
  isReplacement: boolean
  hasProductRef: boolean
}): string {
  const lines: string[] = []
  lines.push(
    `You are a strict QA checker for an AI-rendered home-improvement preview.`,
  )
  lines.push(
    `The FIRST image is an AI-rendered preview of a customer's room with a product installed.`,
  )
  if (opts.hasProductRef) {
    lines.push(
      `The SECOND image is the EXACT real product that was quoted — the rendered product must match it.`,
    )
  }
  lines.push(``)
  lines.push(`Assess the FIRST image against these requirements:`)
  if (opts.expectedCount !== null) {
    lines.push(
      `- COUNT: exactly ${opts.expectedCount} fitting(s) must be visible. Count them carefully.`,
    )
  } else {
    lines.push(`- COUNT: the number of fittings must match a sensible single job.`)
  }
  lines.push(
    opts.productName
      ? `- PRODUCT: the installed product must be "${opts.productName}"${opts.hasProductRef ? ' and match the second image' : ''} — correct type, shape, finish, no generic substitute.`
      : `- PRODUCT: the installed product must be the correct fitting type for the job, not a generic substitute.`,
  )
  lines.push(
    `- POSITION: the fittings must be placed sensibly and evenly for the room, not bunched, floating or clipped.`,
  )
  if (opts.isReplacement) {
    lines.push(
      `- EXISTING REMOVED: this is a replacement job — the OLD fitting must be fully gone, not left in place alongside the new one.`,
    )
  }
  lines.push(``)
  lines.push(`Respond with STRICT JSON only, no prose, exactly this shape:`)
  lines.push(`{`)
  lines.push(`  "count_seen": <integer number of fittings you counted>,`)
  lines.push(`  "count_ok": <true|false>,`)
  lines.push(`  "product_ok": <true|false>,`)
  lines.push(`  "position_ok": <true|false>,`)
  lines.push(
    opts.isReplacement
      ? `  "existing_removed_ok": <true|false>,`
      : `  "existing_removed_ok": null,`,
  )
  lines.push(`  "defects": [<short string per problem, empty array if none>]`)
  lines.push(`}`)
  return lines.join('\n')
}

/**
 * PURE — turn a failed judgement into a corrective instruction appended
 * to the retry render. Empty string when there is nothing to fix.
 */
export function defectFeedback(j: PreviewJudgement): string {
  const fixes: string[] = []
  if (j.countOk === false) {
    fixes.push(
      j.countSeen !== null
        ? `COUNT WRONG — your previous render showed ${j.countSeen} fitting(s). Render the exact quantity stated in the brief, no more and no fewer.`
        : `COUNT WRONG — render the exact quantity stated in the brief, no more and no fewer.`,
    )
  }
  if (j.productOk === false) {
    fixes.push(
      `PRODUCT WRONG — the installed product did not match the anchor product / reference photo. Render that exact product, not a generic fitting.`,
    )
  }
  if (j.existingRemovedOk === false) {
    fixes.push(
      `OLD FITTING STILL PRESENT — fully remove the existing fitting before installing the new one. Do not leave both.`,
    )
  }
  if (j.positionOk === false) {
    fixes.push(
      `POSITION WRONG — place the fittings at the positions described in the brief, evenly and sensibly.`,
    )
  }
  for (const d of j.defects) fixes.push(d)

  if (fixes.length === 0) return ''
  return [
    `STRICT RE-RENDER — your previous attempt had these defects. Fix every one:`,
    ...fixes.map(f => `- ${f}`),
  ].join('\n')
}

/** Args for a single preview judgement. */
export type JudgeArgs = {
  rendered: { base64: string; mime: string }
  productRef?: { base64: string; mime: string } | null
  expectedCount: number | null
  productName: string | null
  isReplacement: boolean
}

/**
 * Best-effort vision judgement of a rendered preview. Routes to the
 * INDEPENDENT Claude judge when PREVIEW_JUDGE_MODEL is a Claude model,
 * otherwise the Gemini judge. Returns a PreviewJudgement; NEVER throws.
 * Caller must have checked verifyLoopEnabled() already.
 */
export async function judgePreview(args: JudgeArgs): Promise<PreviewJudgement> {
  return isClaudeJudgeModel()
    ? judgeViaClaude(args, JUDGE_MODEL)
    : judgeViaGemini(args, JUDGE_MODEL)
}

/** Gemini-vision judge — routed through the shared Gemini provider. */
async function judgeViaGemini(
  args: JudgeArgs,
  model: string,
): Promise<PreviewJudgement> {
  try {
    const text = await geminiProvider.generateText!({
      prompt: buildJudgePrompt({
        expectedCount: args.expectedCount,
        productName: args.productName,
        isReplacement: args.isReplacement,
        hasProductRef: !!args.productRef,
      }),
      images: [
        args.rendered,
        ...(args.productRef ? [args.productRef] : []),
      ],
      model,
    })
    return parsePreviewJudgement(text)
  } catch {
    // Inconclusive — includes the missing-key case (provider throws) and
    // any network / 5xx. Never a false reject.
    return parsePreviewJudgement(null)
  }
}

/**
 * Claude-vision judge — an INDEPENDENT grader: a different model from
 * the Gemini generator, so it does not share its blind spots. Routed
 * through the Vercel AI SDK + ANTHROPIC_API_KEY.
 *
 * The AI SDK is DYNAMICALLY imported so the pure logic in this file
 * stays import-light for the unit tests (mirrors lib/sms/intent.ts).
 * Best-effort — any error → inconclusive, never throws.
 */
async function judgeViaClaude(
  args: JudgeArgs,
  model: string,
): Promise<PreviewJudgement> {
  if (!process.env.ANTHROPIC_API_KEY) return parsePreviewJudgement(null)
  try {
    const { anthropic } = await import('@ai-sdk/anthropic')
    const { generateText } = await import('ai')

    const prompt = buildJudgePrompt({
      expectedCount: args.expectedCount,
      productName: args.productName,
      isReplacement: args.isReplacement,
      hasProductRef: !!args.productRef,
    })
    // Text first, then the rendered preview, then the product reference
    // (if any) — same ordering the Gemini judge uses.
    const content = [
      { type: 'text' as const, text: prompt },
      {
        type: 'image' as const,
        image: args.rendered.base64,
        mediaType: args.rendered.mime,
      },
      ...(args.productRef
        ? [
            {
              type: 'image' as const,
              image: args.productRef.base64,
              mediaType: args.productRef.mime,
            },
          ]
        : []),
    ]
    const { text } = await generateText({
      model: anthropic(model),
      temperature: 0,
      messages: [{ role: 'user' as const, content }],
    })
    return parsePreviewJudgement(text)
  } catch {
    return parsePreviewJudgement(null) // inconclusive — never throw
  }
}
