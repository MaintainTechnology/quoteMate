// ════════════════════════════════════════════════════════════════════
// AI sample-gallery generation — 3 generic Gemini text-to-image
// renders showing typical examples of the proposed work.
//
// Distinct from generate.ts (which edits the customer's actual photo).
// These samples are generic by design — "examples of similar work" —
// and complement the room-specific preview above them on the page.
//
// All 3 generations run in parallel for speed. Partial success is
// allowed (samples_status='partial') — render whatever succeeded.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { buildSamplePrompts, type PromptIntake } from './prompts'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BUCKET = 'intake-photos'
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image-preview'
const GEMINI_ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

export type SamplesStatus = 'idle' | 'generating' | 'ready' | 'partial' | 'failed'

export type SamplesResult =
  | { status: 'ready'; paths: string[] }
  | { status: 'partial'; paths: string[]; failures: number }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string }

/**
 * Atomically claim and generate up to 3 generic sample images for the
 * given quote. Idempotent. Safe to call from any of the same triggers
 * as the main preview — only one generation actually runs.
 *
 * Skip cases (returns 'skipped'):
 *   - quote has needs_inspection=true
 *   - DISABLE_AI_SAMPLES env truthy (kill switch for cost control)
 *   - claim fails (already generating or ready)
 *   - job_type doesn't have a SamplePromptSet (out-of-scope job)
 */
export async function generateSampleImages(quoteId: string): Promise<SamplesResult> {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[samples] GEMINI_API_KEY not set — skipping')
    return { status: 'skipped', reason: 'GEMINI_API_KEY missing' }
  }
  if (process.env.DISABLE_AI_SAMPLES) {
    return { status: 'skipped', reason: 'DISABLE_AI_SAMPLES env set' }
  }

  const { data: quote } = await supabase
    .from('quotes')
    .select('id, intake_id, needs_inspection, samples_status')
    .eq('id', quoteId)
    .maybeSingle()

  if (!quote) return { status: 'skipped', reason: 'quote not found' }
  if (quote.needs_inspection) return { status: 'skipped', reason: 'inspection-only quote' }
  if (quote.samples_status === 'ready' || quote.samples_status === 'generating') {
    return { status: 'skipped', reason: `already ${quote.samples_status}` }
  }

  // Atomic claim
  const { data: locked } = await supabase
    .from('quotes')
    .update({
      samples_status: 'generating',
      samples_generated_at: new Date().toISOString(),
      samples_error: null,
    })
    .eq('id', quoteId)
    .in('samples_status', ['idle', 'failed', 'partial'])
    .select('id, intake_id')
    .maybeSingle()

  if (!locked) {
    return { status: 'skipped', reason: 'claim race lost' }
  }

  console.log('[samples] generation start', { quoteId, intakeId: locked.intake_id })

  try {
    const { data: intake } = await supabase
      .from('intakes')
      .select('id, job_type, scope, access, caller')
      .eq('id', locked.intake_id)
      .maybeSingle()
    if (!intake) throw new Error('intake row not found')

    const prompts = buildSamplePrompts(intake as PromptIntake)
    if (!prompts) {
      // Out-of-scope job_type — no sample prompts defined.
      await supabase.from('quotes')
        .update({ samples_status: 'failed', samples_error: 'no sample prompts for this job_type' })
        .eq('id', quoteId)
      return { status: 'skipped', reason: 'no sample prompts for job_type' }
    }

    // Fire all 3 in parallel
    const t0 = Date.now()
    const labels = ['wide', 'detail', 'lit'] as const
    const results = await Promise.allSettled(
      labels.map(label => generateOneSample(intake.id as string, prompts[label], label))
    )
    const elapsedMs = Date.now() - t0

    const succeededPaths: string[] = []
    let failures = 0
    const failureReasons: string[] = []

    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        succeededPaths.push(r.value)
      } else {
        failures++
        const reason = r.status === 'rejected' ? (r.reason?.message ?? String(r.reason)) : 'no result'
        failureReasons.push(`${labels[i]}: ${reason}`)
      }
    })

    console.log('[samples] generation finished', {
      quoteId,
      elapsedMs,
      succeeded: succeededPaths.length,
      failed: failures,
    })

    let finalStatus: SamplesStatus
    if (succeededPaths.length === 3) finalStatus = 'ready'
    else if (succeededPaths.length > 0) finalStatus = 'partial'
    else finalStatus = 'failed'

    await supabase.from('quotes').update({
      sample_image_paths: succeededPaths,
      samples_status: finalStatus,
      samples_error: failureReasons.length > 0 ? failureReasons.join(' | ').slice(0, 500) : null,
      samples_generated_at: new Date().toISOString(),
    }).eq('id', quoteId)

    if (finalStatus === 'failed') return { status: 'failed', error: failureReasons.join(' | ') }
    if (finalStatus === 'partial') return { status: 'partial', paths: succeededPaths, failures }
    return { status: 'ready', paths: succeededPaths }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error('[samples] generation FAILED', { quoteId, error: msg })
    await supabase.from('quotes').update({
      samples_status: 'failed',
      samples_error: msg.slice(0, 500),
    }).eq('id', quoteId)
    return { status: 'failed', error: msg }
  }
}

/**
 * Generate one sample image. Returns the storage path on success,
 * throws on failure (let the parallel orchestrator handle which
 * succeeded vs failed).
 */
async function generateOneSample(intakeId: string, prompt: string, label: string): Promise<string> {
  const apiUrl = `${GEMINI_ENDPOINT(GEMINI_MODEL)}?key=${encodeURIComponent(process.env.GEMINI_API_KEY!)}`

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: prompt }],
      }],
      generation_config: {
        temperature: 0.7,
        response_modalities: ['IMAGE'],
      },
    }),
  })

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 300)
    throw new Error(`Gemini HTTP ${res.status}: ${errText}`)
  }

  const data = await res.json() as GeminiResponse
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const imagePart = parts.find(p => p.inline_data?.data || p.inlineData?.data)
  const inline = imagePart?.inline_data ?? imagePart?.inlineData
  if (!inline?.data) {
    const textRefusal = parts.find(p => p.text)?.text
    throw new Error(`no image data${textRefusal ? ` — ${textRefusal.slice(0, 150)}` : ''}`)
  }

  const outMime = inline.mime_type ?? inline.mimeType ?? 'image/png'
  const outExt = outMime === 'image/jpeg' ? 'jpg' : 'png'
  const imageBytes = Buffer.from(inline.data, 'base64')

  const samplePath = `${intakeId}/sample-${label}-${Date.now()}.${outExt}`
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(samplePath, imageBytes, { contentType: outMime, upsert: false })
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)

  return samplePath
}

type GeminiInline = {
  inline_data?: { mime_type?: string; mimeType?: string; data: string }
  inlineData?: { mime_type?: string; mimeType?: string; data: string }
  text?: string
}
type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiInline[] }
  }>
  error?: { message?: string; code?: number }
}
