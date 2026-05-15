// ════════════════════════════════════════════════════════════════════
// AI preview generation — Gemini 2.5 Flash Image edits the customer's
// uploaded photos to show the proposed work installed.
//
// IMPORTANT: each customer photo gets its OWN edited preview. Two
// uploaded photos → two AI previews. Three uploaded photos → three.
// All paths are stored in quotes.preview_image_paths (text[]).
//
// For backwards compat the legacy quotes.preview_image_path (singular)
// also gets set to the FIRST generated path. Readers prefer the array
// and fall back to the singular when the array is empty.
//
// Atomicity: only one generation per quote runs at a time. The status
// flip from idle/no_photos/failed → generating is a CAS update.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import {
  buildPreviewPrompt,
  buildPreviewPromptV2,
  type PromptContext,
  type PromptIntake,
  type PromptQuote,
  type PromptLineItem,
  type PromptCorrection,
  type SystemUserPrompt,
} from './prompts'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BUCKET = 'intake-photos'

// Default: gemini-3-pro-image-preview ("Nano Banana Pro") — best
// instruction-following + count accuracy of the Gemini image family.
// Override via env to gemini-3.1-flash-image-preview (cheaper/faster)
// or gemini-2.5-flash-image (legacy GA).
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3-pro-image-preview'

const GEMINI_ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

export type PreviewStatus = 'idle' | 'no_photos' | 'generating' | 'ready' | 'failed' | 'partial'

export type PreviewResult =
  | { status: 'ready'; paths: string[] }
  | { status: 'partial'; paths: string[]; failures: number }
  | { status: 'no_photos' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string }

/**
 * Atomically claim and generate one preview per uploaded customer photo.
 * Idempotent. Safe to call from any of the triggers — only one generation
 * runs at a time per quote.
 */
export async function generatePreviewImage(quoteId: string): Promise<PreviewResult> {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[preview] GEMINI_API_KEY not set — skipping')
    return { status: 'skipped', reason: 'GEMINI_API_KEY missing' }
  }

  const { data: quote } = await supabase
    .from('quotes')
    .select('id, intake_id, needs_inspection, preview_status')
    .eq('id', quoteId)
    .maybeSingle()

  if (!quote) return { status: 'skipped', reason: 'quote not found' }
  // Note: inspection-required quotes still get previews. The customer
  // uploaded photos of the site; visualising the proposed work helps
  // them confirm scope ahead of the in-person visit. The price tiers
  // are nulled out elsewhere — this only renders an image of the room.
  if (quote.preview_status === 'ready' || quote.preview_status === 'generating') {
    return { status: 'skipped', reason: `already ${quote.preview_status}` }
  }

  // Atomic claim
  const { data: locked } = await supabase
    .from('quotes')
    .update({
      preview_status: 'generating',
      preview_generated_at: new Date().toISOString(),
      preview_error: null,
    })
    .eq('id', quoteId)
    .in('preview_status', ['idle', 'no_photos', 'failed', 'partial'])
    .select('id, intake_id')
    .maybeSingle()

  if (!locked) {
    return { status: 'skipped', reason: 'claim race lost' }
  }

  console.log('[preview] generation start', { quoteId, intakeId: locked.intake_id })

  try {
    const { data: intake } = await supabase
      .from('intakes')
      .select('id, job_type, scope, access, property, caller, timing, photo_paths')
      .eq('id', locked.intake_id)
      .maybeSingle()

    if (!intake) throw new Error('intake row not found')

    const photoPaths = (Array.isArray(intake.photo_paths) ? intake.photo_paths : []) as string[]

    if (photoPaths.length === 0) {
      await supabase
        .from('quotes')
        .update({ preview_status: 'no_photos', preview_error: null })
        .eq('id', quoteId)
      return { status: 'no_photos' }
    }

    // ── Load richer context for the prompt builder ──
    //
    // PREVIEW_PROMPT_VERSION env var selects which builder runs:
    //   "v2"  → buildPreviewPromptV2 (XML-tag structured, Gemini 2.0+
    //           best practice, ~40% shorter)
    //   else  → buildPreviewPrompt (legacy, box-drawing + verbose prose)
    //
    // Default is v1 (legacy) so this rollout is opt-in. Flip the env
    // to "v2" on a staging or rolling-release deployment, eyeball N
    // generated images against v1 outputs, promote when satisfied.
    const ctx = await loadPromptContext(quoteId, intake as PromptIntake)
    const promptVersion = (process.env.PREVIEW_PROMPT_VERSION ?? 'v1').toLowerCase()
    const prompt = promptVersion === 'v2'
      ? buildPreviewPromptV2(ctx)
      : buildPreviewPrompt(ctx)
    const t0 = Date.now()
    const promptText = `[system v=${promptVersion}]\n${prompt.system}\n\n[user]\n${prompt.user}`

    // Generate ONE preview per uploaded customer photo, in parallel.
    // Each gets its own Gemini call with that specific photo as the
    // reference. Result: N customer photos → N edited previews, all
    // visually consistent (same room from N angles).
    const results = await Promise.allSettled(
      photoPaths.map((path, i) => generateOnePreview({
        intakeId: intake.id as string,
        sourcePath: path,
        index: i,
        prompt,
      }))
    )

    const succeededPaths: string[] = []
    const failureReasons: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        succeededPaths.push(r.value)
      } else {
        const reason = r.reason?.message ?? String(r.reason)
        failureReasons.push(`photo-${i}: ${reason}`)
      }
    })

    const elapsedMs = Date.now() - t0
    console.log('[preview] generation finished', {
      quoteId,
      elapsedMs,
      photoCount: photoPaths.length,
      succeeded: succeededPaths.length,
      failed: failureReasons.length,
    })

    let finalStatus: PreviewStatus
    if (succeededPaths.length === photoPaths.length) finalStatus = 'ready'
    else if (succeededPaths.length > 0) finalStatus = 'partial'
    else finalStatus = 'failed'

    await supabase.from('quotes').update({
      // New plural column — primary read source.
      preview_image_paths: succeededPaths,
      // Legacy singular column — keep in sync for any old reader.
      preview_image_path: succeededPaths[0] ?? null,
      preview_status: finalStatus,
      preview_prompt: promptText,
      preview_error: failureReasons.length > 0 ? failureReasons.join(' | ').slice(0, 500) : null,
      preview_generated_at: new Date().toISOString(),
    }).eq('id', quoteId)

    if (finalStatus === 'failed') return { status: 'failed', error: failureReasons.join(' | ') }
    if (finalStatus === 'partial') return { status: 'partial', paths: succeededPaths, failures: failureReasons.length }
    return { status: 'ready', paths: succeededPaths }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error('[preview] generation FAILED (unhandled)', { quoteId, error: msg })
    await supabase.from('quotes').update({
      preview_status: 'failed',
      preview_error: msg.slice(0, 500),
    }).eq('id', quoteId)
    return { status: 'failed', error: msg }
  }
}

async function generateOnePreview(opts: {
  intakeId: string
  sourcePath: string
  index: number
  prompt: SystemUserPrompt
}): Promise<string> {
  // Download the source photo from storage.
  const { data: blob, error: dlErr } = await supabase.storage
    .from(BUCKET)
    .download(opts.sourcePath)
  if (dlErr || !blob) throw new Error(`could not download reference photo (${opts.sourcePath}): ${dlErr?.message ?? 'no blob'}`)
  const refBuf = Buffer.from(await blob.arrayBuffer())
  const refBase64 = refBuf.toString('base64')
  const refMime = blob.type || 'image/jpeg'

  // Call Gemini.
  const apiUrl = `${GEMINI_ENDPOINT(GEMINI_MODEL)}?key=${encodeURIComponent(process.env.GEMINI_API_KEY!)}`
  const t0 = Date.now()
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Authoritative rules — sent in systemInstruction so Gemini treats
      // them as command-style instructions, not mixed in with the brief.
      systemInstruction: {
        parts: [{ text: opts.prompt.system }],
      },
      contents: [
        {
          role: 'user',
          parts: [
            { text: opts.prompt.user },
            { inline_data: { mime_type: refMime, data: refBase64 } },
          ],
        },
      ],
      generation_config: {
        // Low temperature — follow the JOB BRIEF tightly, no improv.
        temperature: 0.1,
        response_modalities: ['IMAGE'],
      },
    }),
  })
  const elapsedMs = Date.now() - t0

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 500)
    throw new Error(`Gemini HTTP ${res.status} after ${elapsedMs}ms: ${errText}`)
  }

  const data = await res.json() as GeminiResponse
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const imagePart = parts.find(p => p.inline_data?.data || p.inlineData?.data)
  const inline = imagePart?.inline_data ?? imagePart?.inlineData
  if (!inline?.data) {
    const textRefusal = parts.find(p => p.text)?.text
    throw new Error(`Gemini returned no image data after ${elapsedMs}ms${textRefusal ? ` — ${textRefusal.slice(0, 200)}` : ''}`)
  }

  const outMime = inline.mime_type ?? inline.mimeType ?? 'image/png'
  const outExt = outMime === 'image/jpeg' ? 'jpg' : 'png'
  const imageBytes = Buffer.from(inline.data, 'base64')

  const previewPath = `${opts.intakeId}/preview-${opts.index}-${Date.now()}.${outExt}`
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(previewPath, imageBytes, { contentType: outMime, upsert: false })
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)

  return previewPath
}

type GeminiInline = {
  inline_data?: { mime_type?: string; mimeType?: string; data: string }
  inlineData?: { mime_type?: string; mimeType?: string; data: string }
  text?: string
}
type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiInline[] }
    finish_reason?: string
  }>
  error?: { message?: string; code?: number }
}

// ════════════════════════════════════════════════════════════════════
// Shared prompt-context loader
//
// Pulls the additional data the new flexible builder relies on:
//   · quote     — selected_tier, scope_of_works, assumptions
//   · lineItems — quote_line_items for the selected tier (specific
//                 products like "USB double GPO (Clipsal)")
//   · corrections — slot names the customer corrected mid-SMS, from
//                 sms_conversations.conversation_state.sources
//
// Every fetch is best-effort. Missing data degrades gracefully — the
// builder skips any section whose data is absent.
// ════════════════════════════════════════════════════════════════════
export async function loadPromptContext(
  quoteId: string,
  intake: PromptIntake,
): Promise<PromptContext> {
  // Fetch quote (with inline tier JSONB), separate line-items table, and
  // SMS conversation in parallel. The estimator writes tier objects with
  // an inline `line_items[]` array on the JSONB columns (quotes.good /
  // .better / .best), and SOMETIMES also writes individual rows to the
  // `quote_line_items` table. Plumbing quotes today only get the inline
  // JSONB version, so we read from BOTH sources and merge.
  const intakeId = (intake as { id?: string }).id ?? null

  const [quoteRes, lineItemsRes, convoRes] = await Promise.all([
    supabase
      .from('quotes')
      .select('selected_tier, scope_of_works, assumptions, needs_inspection, good, better, best')
      .eq('id', quoteId)
      .maybeSingle(),
    supabase
      .from('quote_line_items')
      .select('tier, description, quantity, source')
      .eq('quote_id', quoteId),
    intakeId
      ? supabase
          .from('sms_conversations')
          .select('conversation_state')
          .eq('intake_id', intakeId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const quote: PromptQuote | null = quoteRes?.data ? {
    selected_tier: (quoteRes.data.selected_tier ?? null) as PromptQuote['selected_tier'],
    scope_of_works: quoteRes.data.scope_of_works ?? null,
    assumptions: Array.isArray(quoteRes.data.assumptions)
      ? (quoteRes.data.assumptions as string[])
      : null,
    needs_inspection: quoteRes.data.needs_inspection ?? null,
  } : null

  // Prefer the quote_line_items table (richer schema). If it's empty
  // (plumbing quotes today), fall back to the inline tier JSONB columns
  // so pickAnchorProduct() can find the headline material.
  let lineItems: PromptLineItem[] = Array.isArray(lineItemsRes?.data)
    ? lineItemsRes.data.map(li => ({
        tier: li.tier,
        description: li.description,
        quantity: li.quantity ?? null,
        source: li.source ?? null,
      }))
    : []

  if (lineItems.length === 0 && quoteRes?.data) {
    // Map source mappings from the inline JSONB shape to the
    // PromptLineItem source vocabulary: 'material:<id>' -> 'material',
    // 'labour' -> 'labour', 'callout' -> 'call_out'.
    const flattenSource = (s: unknown): string | null => {
      if (typeof s !== 'string') return null
      if (s.startsWith('material')) return 'material'
      if (s === 'callout' || s === 'call_out') return 'call_out'
      if (s === 'labour') return 'labour'
      return s
    }
    type InlineLi = { description?: string; quantity?: number; source?: string }
    type InlineTier = { line_items?: InlineLi[] } | null | undefined
    const tiers: Array<['good' | 'better' | 'best', InlineTier]> = [
      ['good',   quoteRes.data.good   as InlineTier],
      ['better', quoteRes.data.better as InlineTier],
      ['best',   quoteRes.data.best   as InlineTier],
    ]
    for (const [tierName, tier] of tiers) {
      const items = Array.isArray(tier?.line_items) ? tier!.line_items : []
      for (const li of items) {
        if (!li?.description) continue
        lineItems.push({
          tier: tierName,
          description: li.description,
          quantity: li.quantity ?? null,
          source: flattenSource(li.source),
        })
      }
    }
  }

  // Corrections: pull slots flagged customer_corrected and pair with
  // their current value.
  const corrections: PromptCorrection[] = []
  const state = (convoRes?.data as { conversation_state?: unknown } | null)?.conversation_state
  if (state && typeof state === 'object') {
    const s = state as {
      slots?: Record<string, unknown>
      sources?: Record<string, string>
    }
    const sources = s.sources ?? {}
    const slots = s.slots ?? {}
    for (const [slot, src] of Object.entries(sources)) {
      if (src !== 'customer_corrected') continue
      const v = slots[slot]
      if (v === null || v === undefined || v === '') continue
      corrections.push({ slot, finalValue: String(v) })
    }
  }

  return { intake, quote, lineItems, corrections }
}
