// ════════════════════════════════════════════════════════════════════
// AI sample-gallery generation — 3 coherent Gemini renders of the
// FULLY COMPLETED install (the after state, day-of-handover), framed
// as wide / close-up / in-use. See MASTER RULE 8 (FINAL OUTCOME) in
// lib/ig-engine/prompts.ts — every shot must show the finished result,
// not a "proposed install" or work-in-progress concept render.
//
// PHOTO-TAILORED MODE (default when customer uploaded photos):
// The customer's first uploaded photo is attached to ALL 3 calls as
// a reference. The wide and in-use shots re-render that room from
// new angles / at dusk; the close-up uses the photo only for blurred
// background bokeh. Result: every sample feels like the customer's
// own space, not a stock photo.
//
// FALLBACK MODE (no photos uploaded):
// All 3 calls fall back to text-to-image with a generic Aussie home
// scene — the original behaviour.
//
// Earlier comment said photo-references hurt count accuracy with
// Gemini 2.5 Flash. With gemini-3-pro-image-preview the model is
// much better at honouring the count even with a reference, so we
// can keep the visual fidelity benefit.
//
// All 3 calls run in PARALLEL. We download the reference photo once
// at the top and pass the bytes to each call.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { buildSamplePrompts, pickAnchorImagePath, type PromptIntake, type SystemUserPrompt } from './prompts'
import { loadPromptContext } from './generate'
import { resolveProductImage, type ProductImage } from './product-image'
import { geminiProvider } from './providers/gemini'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BUCKET = 'intake-photos'

// Model selection lives in providers/gemini.ts. Override with the same
// env var as before: GEMINI_IMAGE_MODEL.

export type SamplesStatus = 'idle' | 'generating' | 'ready' | 'partial' | 'failed'

export type SamplesResult =
  | { status: 'ready'; paths: string[] }
  | { status: 'partial'; paths: string[]; failures: number }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string }

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
  // Note: inspection-required quotes still get sample images. They're
  // job-type driven (no customer-photo dependency) and help the
  // customer picture the install before the on-site visit.
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
      .select('id, job_type, scope, access, property, caller, timing, photo_paths')
      .eq('id', locked.intake_id)
      .maybeSingle()
    if (!intake) throw new Error('intake row not found')

    // ─── Resolve reference photo (if any) ─────────────────────────────
    // Use the first uploaded customer photo as the visual anchor for
    // all 3 sample calls. If no photos are uploaded, fall back to
    // generic text-to-image renders.
    const photoPaths = (Array.isArray((intake as { photo_paths?: unknown }).photo_paths)
      ? ((intake as { photo_paths: unknown[] }).photo_paths as string[])
      : []) as string[]
    const referencePath = photoPaths[0] ?? null

    let referencePhoto: { base64: string; mime: string } | null = null
    if (referencePath) {
      const { data: blob, error: dlErr } = await supabase.storage
        .from(BUCKET)
        .download(referencePath)
      if (dlErr || !blob) {
        console.warn('[samples] reference-photo download failed; falling back to text-to-image', {
          referencePath,
          error: dlErr?.message,
        })
      } else {
        const buf = Buffer.from(await blob.arrayBuffer())
        referencePhoto = { base64: buf.toString('base64'), mime: blob.type || 'image/jpeg' }
        console.log('[samples] reference photo loaded', { path: referencePath, bytes: buf.length })
      }
    }

    // Load the richer prompt context (quote + line items + corrections).
    // Best-effort — degrades gracefully if any fetch fails.
    const ctx = await loadPromptContext(quoteId, intake as PromptIntake)

    // WP4 — the EXACT product photo, resolved once and shared across
    // all 3 sample shots so wide / close-up / in-use show the SAME
    // product (consistency requirement). null → today's behaviour.
    const productRef = await resolveProductImage(pickAnchorImagePath(ctx))
    if (productRef) {
      console.log('[samples] product reference photo attached (WP4)', { quoteId })
    }

    const prompts = buildSamplePrompts(ctx, {
      usePhotoReference: referencePhoto !== null,
    })
    if (!prompts) {
      await supabase.from('quotes')
        .update({ samples_status: 'failed', samples_error: 'no sample prompts for this job_type' })
        .eq('id', quoteId)
      return { status: 'skipped', reason: 'no sample prompts for job_type' }
    }

    const t0 = Date.now()

    const succeededPaths: string[] = []
    const failureReasons: string[] = []

    // All 3 in parallel — no inter-shot dependency. Reference photo
    // (if present) is shared across all 3 calls.
    console.log('[samples] running 3 parallel calls', {
      mode: referencePhoto ? 'photo-tailored' : 'text-to-image',
    })
    const results = await Promise.allSettled([
      generateOneSample({ intakeId: intake.id as string, prompt: prompts.wide,   label: 'wide',   referencePhoto, productRef }),
      generateOneSample({ intakeId: intake.id as string, prompt: prompts.detail, label: 'detail', referencePhoto, productRef }),
      generateOneSample({ intakeId: intake.id as string, prompt: prompts.lit,    label: 'lit',    referencePhoto, productRef }),
    ])
    const labels = ['wide', 'detail', 'lit'] as const
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        succeededPaths.push(r.value.path)
      } else {
        failureReasons.push(`${labels[i]}: ${r.reason?.message ?? String(r.reason)}`)
      }
    })

    const elapsedMs = Date.now() - t0
    console.log('[samples] generation finished', {
      quoteId,
      elapsedMs,
      succeeded: succeededPaths.length,
      failed: failureReasons.length,
    })

    let finalStatus: SamplesStatus
    if (succeededPaths.length === 3) finalStatus = 'ready'
    else if (succeededPaths.length > 0) finalStatus = 'partial'
    else finalStatus = 'failed'

    // Persist the wide-shot prompt so we can audit what was sent to Gemini.
    // The 3 sample prompts share the customer-prefs block (only the
    // shot-specific footer differs), so storing one is sufficient for
    // verifying that customer choices propagated through.
    const samplesPrompt = `[system]\n${prompts.wide.system}\n\n[user]\n${prompts.wide.user}`
    await supabase.from('quotes').update({
      sample_image_paths: succeededPaths,
      samples_status: finalStatus,
      samples_error: failureReasons.length > 0 ? failureReasons.join(' | ').slice(0, 500) : null,
      samples_generated_at: new Date().toISOString(),
      samples_prompt: samplesPrompt,
    }).eq('id', quoteId)

    if (finalStatus === 'failed') return { status: 'failed', error: failureReasons.join(' | ') }
    if (finalStatus === 'partial') return { status: 'partial', paths: succeededPaths, failures: failureReasons.length }
    return { status: 'ready', paths: succeededPaths }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error('[samples] generation FAILED (unhandled)', { quoteId, error: msg })
    await supabase.from('quotes').update({
      samples_status: 'failed',
      samples_error: msg.slice(0, 500),
    }).eq('id', quoteId)
    return { status: 'failed', error: msg }
  }
}

async function generateOneSample(opts: {
  intakeId: string
  prompt: SystemUserPrompt
  label: 'wide' | 'detail' | 'lit'
  referencePhoto: { base64: string; mime: string } | null
  productRef?: ProductImage | null
}): Promise<{ path: string; imageBytes: Buffer; mimeType: string }> {
  // Render via the Gemini provider — wire format identical to the
  // previous inline fetch (contract-tested in providers/gemini.test.ts).
  const out = await geminiProvider.renderImage({
    system: opts.prompt.system,
    user: opts.prompt.user,
    sourceImage: opts.referencePhoto ?? undefined,
    reference: opts.productRef
      ? {
          image: opts.productRef,
          // Shorter product-reference label — the preview path uses the
          // long-form override; samples just need the model to replicate
          // the same product across all 3 shots (MASTER RULE 2b).
          label:
            'PRODUCT REFERENCE — the FINAL image below is the EXACT real product ' +
            'the customer is quoted. Replicate it precisely (brand, model, shape, ' +
            'colour, finish). It is the literal product, not a style hint.',
        }
      : undefined,
  })

  const outExt = out.mime === 'image/jpeg' ? 'jpg' : 'png'
  const imageBytes = Buffer.from(out.base64, 'base64')

  const samplePath = `${opts.intakeId}/sample-${opts.label}-${Date.now()}.${outExt}`
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(samplePath, imageBytes, { contentType: out.mime, upsert: false })
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)

  return { path: samplePath, imageBytes, mimeType: out.mime }
}

// (Gemini wire-format types now live in providers/gemini.ts.)
