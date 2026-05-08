// ════════════════════════════════════════════════════════════════════
// AI preview generation — Gemini 2.5 Flash Image edits the customer's
// own uploaded photo to show the proposed work completed.
//
// IMPORTANT: the customer's first uploaded photo is the REFERENCE/BASE
// image fed to Gemini, NOT a stock photo. Same room, same angle —
// only the relevant fixtures are modified. This is by design and
// reinforced in the prompt template (see lib/preview/prompts.ts).
//
// Atomicity: only one generation per quote runs at a time. The status
// flip from idle/no_photos/failed → generating is a CAS update; if the
// row was already 'generating' or 'ready', the claim returns nothing
// and we exit cleanly.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { buildPreviewPrompt, type PromptIntake } from './prompts'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BUCKET = 'intake-photos'

// Default model name. Override via env if Google promotes / renames the
// preview model. Known Gemini 2.5 image-generation aliases at time of
// writing: gemini-2.5-flash-image-preview / gemini-2.5-flash-image.
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image-preview'

const GEMINI_ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

export type PreviewStatus = 'idle' | 'no_photos' | 'generating' | 'ready' | 'failed'

export type PreviewResult =
  | { status: 'ready'; path: string }
  | { status: 'no_photos' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string }

/**
 * Atomically claim and generate a preview image for the given quote.
 * Idempotent. Safe to call from multiple triggers (photo upload, quote
 * draft completion, page load) — only one generation actually runs.
 *
 * Skip cases (returns 'skipped'):
 *   - quote has needs_inspection=true (no meaningful "after" to render)
 *   - claim fails (another worker is generating, or already 'ready')
 *
 * Failure cases (sets DB status='failed'):
 *   - intake / photos missing or unreadable
 *   - Gemini API returns no image bytes
 *   - storage upload fails
 */
export async function generatePreviewImage(quoteId: string): Promise<PreviewResult> {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[preview] GEMINI_API_KEY not set — skipping')
    return { status: 'skipped', reason: 'GEMINI_API_KEY missing' }
  }

  // ─── Pre-flight: fetch the quote so we can short-circuit inspection-only ───
  const { data: quote } = await supabase
    .from('quotes')
    .select('id, intake_id, needs_inspection, preview_status')
    .eq('id', quoteId)
    .maybeSingle()

  if (!quote) {
    console.warn('[preview] quote not found', { quoteId })
    return { status: 'skipped', reason: 'quote not found' }
  }
  if (quote.needs_inspection) {
    return { status: 'skipped', reason: 'inspection-only quote' }
  }
  if (quote.preview_status === 'ready' || quote.preview_status === 'generating') {
    return { status: 'skipped', reason: `already ${quote.preview_status}` }
  }

  // ─── Atomic claim — flip from idle/no_photos/failed → generating ───
  const { data: locked } = await supabase
    .from('quotes')
    .update({
      preview_status: 'generating',
      preview_generated_at: new Date().toISOString(),
      preview_error: null,
    })
    .eq('id', quoteId)
    .in('preview_status', ['idle', 'no_photos', 'failed'])
    .select('id, intake_id')
    .maybeSingle()

  if (!locked) {
    console.log('[preview] CAS claim failed — another worker has it', { quoteId })
    return { status: 'skipped', reason: 'claim race lost' }
  }

  console.log('[preview] generation start', { quoteId, intakeId: locked.intake_id })

  try {
    // ─── Load intake + photo paths ───
    const { data: intake } = await supabase
      .from('intakes')
      .select('id, job_type, scope, access, caller, photo_paths')
      .eq('id', locked.intake_id)
      .maybeSingle()

    if (!intake) throw new Error('intake row not found')

    const photoPaths = (Array.isArray(intake.photo_paths) ? intake.photo_paths : []) as string[]

    if (photoPaths.length === 0) {
      // No photos uploaded yet → status='no_photos' (will be retried on
      // photo-upload trigger when the customer eventually uploads).
      await supabase
        .from('quotes')
        .update({ preview_status: 'no_photos', preview_error: null })
        .eq('id', quoteId)
      console.log('[preview] no photos available, marked no_photos', { quoteId })
      return { status: 'no_photos' }
    }

    // ─── Download the customer's first photo as base64 ───
    const referencePath = photoPaths[0]
    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(referencePath)
    if (dlErr || !blob) throw new Error(`could not download reference photo (${referencePath}): ${dlErr?.message ?? 'no blob'}`)
    const refBuf = Buffer.from(await blob.arrayBuffer())
    const refBase64 = refBuf.toString('base64')
    const refMime = blob.type || 'image/jpeg'

    // ─── Build per-job-type prompt ───
    const prompt = buildPreviewPrompt(intake as PromptIntake)

    // ─── Call Gemini ───
    const apiUrl = `${GEMINI_ENDPOINT(GEMINI_MODEL)}?key=${encodeURIComponent(process.env.GEMINI_API_KEY!)}`
    const t0 = Date.now()
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: refMime, data: refBase64 } },
            ],
          },
        ],
        generation_config: {
          // image-gen models accept these; harmless if ignored.
          temperature: 0.4,
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
      // Sometimes the model returns text-only refusal; surface that.
      const textRefusal = parts.find(p => p.text)?.text
      throw new Error(`Gemini returned no image data after ${elapsedMs}ms${textRefusal ? ` — ${textRefusal.slice(0, 200)}` : ''}`)
    }

    const outMime = inline.mime_type ?? inline.mimeType ?? 'image/png'
    const outExt = outMime === 'image/jpeg' ? 'jpg' : 'png'
    const imageBytes = Buffer.from(inline.data, 'base64')

    console.log('[preview] gemini ok', {
      quoteId,
      elapsedMs,
      bytes: imageBytes.length,
      outMime,
    })

    // ─── Upload to Supabase storage ───
    const previewPath = `${intake.id}/preview-${Date.now()}.${outExt}`
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(previewPath, imageBytes, { contentType: outMime, upsert: false })
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)

    // ─── Mark ready ───
    await supabase.from('quotes').update({
      preview_image_path: previewPath,
      preview_status: 'ready',
      preview_prompt: prompt,
      preview_error: null,
      preview_generated_at: new Date().toISOString(),
    }).eq('id', quoteId)

    console.log('[preview] ready', { quoteId, path: previewPath })
    return { status: 'ready', path: previewPath }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error('[preview] generation FAILED', { quoteId, error: msg })
    await supabase.from('quotes').update({
      preview_status: 'failed',
      preview_error: msg.slice(0, 500),
    }).eq('id', quoteId)
    return { status: 'failed', error: msg }
  }
}

// Minimal shape of the Gemini generateContent response we care about.
// Gemini sometimes returns inline_data, sometimes inlineData (camelCase
// variant in newer SDK responses) — handle both.
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
