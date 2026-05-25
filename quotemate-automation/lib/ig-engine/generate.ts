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
  buildRemovalPrompt,
  isReplacementJob,
  pickAnchorImagePath,
  pickAnchorProduct,
  type PromptContext,
  type PromptIntake,
  type PromptQuote,
  type PromptLineItem,
  type PromptCorrection,
  type SystemUserPrompt,
} from './prompts'
import { resolveProductImage, type ProductImage } from './product-image'
import { renderVerifyEnabled, verifyRenderMatchesProduct } from './verify'
import { aspectRatioFromImage } from './image-config'
import {
  defectFeedback,
  judgePreview,
  verifyLoopEnabled,
  verifyMaxRetries,
} from './judge'
import { geminiProvider } from './providers/gemini'

// Item 3 — two-pass editing for replacement jobs. Default OFF: when on,
// a replacement job first gets a removal-only edit (strip the old
// fitting → clean surface), and the install render uses that cleaned
// image as its reference. Off → single-pass, identical to before.
function twoPassEnabled(): boolean {
  return process.env.PREVIEW_TWO_PASS === '1'
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BUCKET = 'intake-photos'

// Model selection lives in providers/gemini.ts (GEMINI_IMAGE_MODEL env).
// Override stays the same: GEMINI_IMAGE_MODEL=gemini-3.1-flash-image-preview
// or gemini-2.5-flash-image (legacy GA).

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
    // V2 (pruned, XML-structured) is now the default — see prompts.ts.
    // Set PREVIEW_PROMPT_VERSION=v1 to fall back to the legacy builder.
    const promptVersion = (process.env.PREVIEW_PROMPT_VERSION ?? 'v2').toLowerCase()
    const prompt = promptVersion === 'v1'
      ? buildPreviewPrompt(ctx)
      : buildPreviewPromptV2(ctx)
    const t0 = Date.now()
    const promptText = `[system v=${promptVersion}]\n${prompt.system}\n\n[user]\n${prompt.user}`

    // WP4 — resolve the anchor product's real photo ONCE and reuse it
    // across every per-photo preview call so all N previews show the
    // SAME exact product. null → today's text-only render (no
    // regression). Best-effort; never throws.
    const productRef = await resolveProductImage(pickAnchorImagePath(ctx))
    if (productRef) {
      console.log('[preview] product reference photo attached (WP4)', { quoteId })
    }

    // Generate ONE preview per uploaded customer photo, in parallel.
    // Each photo runs the full per-photo pipeline: optional two-pass
    // removal (Item 3) → render → optional judge→retry loop (Item 2).
    // Result: N customer photos → N edited previews, all visually
    // consistent (same room from N angles).
    const results = await Promise.allSettled(
      photoPaths.map((path, i) => generateOnePreviewPipeline({
        intakeId: intake.id as string,
        sourcePath: path,
        index: i,
        prompt,
        productRef,
        ctx,
        quoteId,
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

    // Status reflects ONLY the actual room previews — computed before
    // the WP4 step so appending the exact-product photo can never flip
    // a 'ready' set to 'partial'.
    let finalStatus: PreviewStatus
    if (succeededPaths.length === photoPaths.length) finalStatus = 'ready'
    else if (succeededPaths.length > 0) finalStatus = 'partial'
    else finalStatus = 'failed'

    // ── WP4 step 4 — render-accuracy quality gate (flag-gated) ───────
    // Verify the rendered preview actually shows the quoted product. On
    // a confirmed mismatch, append the REAL product photo as an extra
    // image so the customer always sees the exact product they'll get
    // ("here's the exact product you'll get"). Default OFF → not one
    // extra Gemini call, behaviour identical to today. Best-effort:
    // any error never blocks or discards a good render.
    // The new judge→retry loop (Item 2) supersedes this WP4 block — when
    // PREVIEW_VERIFY_LOOP is on, verification already ran per-photo, so
    // skip the legacy product-only check to avoid double verification.
    if (renderVerifyEnabled() && !verifyLoopEnabled() && productRef && succeededPaths.length > 0) {
      try {
        const { data: rblob } = await supabase.storage
          .from(BUCKET)
          .download(succeededPaths[0])
        if (rblob) {
          const rbuf = Buffer.from(await rblob.arrayBuffer())
          const verdict = await verifyRenderMatchesProduct({
            rendered: { base64: rbuf.toString('base64'), mime: rblob.type || 'image/png' },
            product: productRef,
          })
          console.log('[preview] WP4 render verification', { quoteId, verdict })
          if (verdict.match === false) {
            // ── Step 1: ONE bounded stricter re-render ──────────────
            // Re-render the representative preview (photo 0) with a hard
            // "match the product reference EXACTLY" instruction, then
            // re-verify. Strictly one attempt — a second Gemini render
            // is the cost ceiling. If it now passes (or is inconclusive)
            // we swap the better image in; only a SECOND confirmed
            // mismatch falls through to the product-photo fallback.
            let recovered = false
            try {
              const retryPath = await generateOnePreview({
                intakeId: intake.id as string,
                sourcePath: photoPaths[0],
                index: 0,
                prompt,
                productRef,
                extraStrict:
                  'STRICT RE-RENDER: your previous attempt did NOT match the ' +
                  'PRODUCT REFERENCE photo. The installed product MUST be the ' +
                  'exact product in the final attached image — same brand, model, ' +
                  'shape, colour and finish. Do not substitute or generalise it.',
              })
              const { data: r2blob } = await supabase.storage
                .from(BUCKET)
                .download(retryPath)
              if (r2blob) {
                const r2buf = Buffer.from(await r2blob.arrayBuffer())
                const verdict2 = await verifyRenderMatchesProduct({
                  rendered: {
                    base64: r2buf.toString('base64'),
                    mime: r2blob.type || 'image/png',
                  },
                  product: productRef,
                })
                console.log('[preview] WP4 stricter re-render verification', {
                  quoteId,
                  verdict2,
                })
                if (verdict2.match !== false) {
                  // Swap the better render in for the rejected one.
                  succeededPaths[0] = retryPath
                  recovered = true
                  console.log(
                    '[preview] WP4 — stricter re-render recovered the product match',
                    { quoteId },
                  )
                }
              }
            } catch (reErr: any) {
              console.warn('[preview] WP4 stricter re-render failed (non-fatal)', {
                quoteId,
                error: reErr?.message ?? String(reErr),
              })
            }

            // ── Step 2: still wrong → log only ─────────────────────
            // Do NOT push the raw product photo into the room-preview
            // gallery — a floating product on a white background shown
            // as "AI PREVIEW · YOUR ROOM" confuses customers (it looks
            // like a broken render). The customer already sees the real
            // product in the quote line + catalogue; the room gallery
            // must contain ONLY actual room renders. We just record the
            // mismatch for diagnostics.
            if (!recovered) {
              console.warn(
                '[preview] WP4 product mismatch persisted after re-render (no gallery pollution)',
                { quoteId, reason: verdict.reason },
              )
            }
          }
        }
      } catch (e: any) {
        console.warn('[preview] WP4 verification skipped (non-fatal)', {
          quoteId,
          error: e?.message ?? String(e),
        })
      }
    }

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
  productRef?: ProductImage | null
  /** WP4 / verify loop — extra hard wording appended to the user
   *  message on a stricter re-render attempt. */
  extraStrict?: string
  /** Item 3 — pre-loaded reference bytes (e.g. the cleaned image from
   *  the two-pass removal step). When set, the storage download is
   *  skipped and these bytes are used as the reference photo. */
  sourceBytes?: { base64: string; mime: string }
}): Promise<string> {
  // Reference photo bytes — either pre-supplied (two-pass) or fetched.
  let refBuf: Buffer
  let refBase64: string
  let refMime: string
  if (opts.sourceBytes) {
    refBase64 = opts.sourceBytes.base64
    refMime = opts.sourceBytes.mime
    refBuf = Buffer.from(refBase64, 'base64')
  } else {
    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(opts.sourcePath)
    if (dlErr || !blob) throw new Error(`could not download reference photo (${opts.sourcePath}): ${dlErr?.message ?? 'no blob'}`)
    refBuf = Buffer.from(await blob.arrayBuffer())
    refBase64 = refBuf.toString('base64')
    refMime = blob.type || 'image/jpeg'
  }

  // Item 4 — keep the rendered preview framed like the customer's photo
  // instead of letting Gemini reframe/crop into its default ratio.
  // null (unrecognised format) → omit imageConfig, no regression.
  const aspectRatio = aspectRatioFromImage(refBuf)

  // Render via the Gemini provider — wire-format identical to the
  // previous inline fetch (the provider adapter's payload shape is
  // contract-tested in providers/gemini.test.ts).
  const out = await geminiProvider.renderImage({
    system: opts.prompt.system,
    user: opts.prompt.user,
    sourceImage: { base64: refBase64, mime: refMime },
    reference: opts.productRef
      ? {
          image: opts.productRef,
          // WP4 — the EXACT product photo, labelled so Gemini replicates
          // this specific product (MASTER RULE 2b). Long-form override
          // wording matches the prior inline implementation byte-for-byte.
          label:
            'PRODUCT REFERENCE — the FINAL image below is the EXACT real product ' +
            'the customer is quoted and will receive. Replicate it precisely in the ' +
            'install (same brand, model, shape, colour, finish). It is the literal ' +
            'product, NOT a style hint. Do not substitute a generic fitting. ' +
            'OVERRIDE: this product wins over the job-type label and any ' +
            'count/placement guidance about fixture appearance — if the job says ' +
            '"downlights" but this reference is a different fixture type (bulb, ' +
            'pendant, batten, panel, etc.), install THIS product’s exact form, ' +
            'not a generic downlight. Keep the requested quantity. The ' +
            '"product_details" line in the brief describes exactly what this ' +
            'product is — use that description together with this photo.',
        }
      : undefined,
    extraStrict: opts.extraStrict,
    aspectRatio: aspectRatio ?? undefined,
  })

  const outExt = out.mime === 'image/jpeg' ? 'jpg' : 'png'
  const imageBytes = Buffer.from(out.base64, 'base64')

  const previewPath = `${opts.intakeId}/preview-${opts.index}-${Date.now()}.${outExt}`
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(previewPath, imageBytes, { contentType: out.mime, upsert: false })
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`)

  return previewPath
}

// ════════════════════════════════════════════════════════════════════
// Per-photo pipeline — two-pass removal (Item 3) → render → judge→retry
// loop (Item 2). Each step is flag-gated and best-effort: with both
// flags off this is exactly one generateOnePreview call — identical
// behaviour and cost to before.
// ════════════════════════════════════════════════════════════════════
async function generateOnePreviewPipeline(opts: {
  intakeId: string
  sourcePath: string
  index: number
  prompt: SystemUserPrompt
  productRef?: ProductImage | null
  ctx: PromptContext
  quoteId: string
}): Promise<string> {
  // ── Item 3 — two-pass removal for replacement jobs ──────────────────
  // Strip the existing fitting FIRST so the install render starts from a
  // clean surface and cannot leave the old fitting in place. Best-effort:
  // any failure falls back to single-pass on the original photo.
  let sourceBytes: { base64: string; mime: string } | undefined
  if (twoPassEnabled() && isReplacementJob(opts.ctx)) {
    try {
      const cleaned = await runRemovalPass(opts.sourcePath, opts.ctx)
      if (cleaned) {
        sourceBytes = cleaned
        console.log('[preview] two-pass removal applied', {
          quoteId: opts.quoteId, index: opts.index,
        })
      }
    } catch (e: any) {
      console.warn('[preview] two-pass removal failed (non-fatal, single-pass fallback)', {
        quoteId: opts.quoteId, index: opts.index, error: e?.message ?? String(e),
      })
    }
  }

  // ── Render (pass 2 / only pass) ─────────────────────────────────────
  let path = await generateOnePreview({
    intakeId: opts.intakeId,
    sourcePath: opts.sourcePath,
    index: opts.index,
    prompt: opts.prompt,
    productRef: opts.productRef,
    sourceBytes,
  })

  // ── Item 2 — judge→retry loop ───────────────────────────────────────
  if (!verifyLoopEnabled()) return path

  const expectedCount =
    (opts.ctx.intake.scope?.item_count && opts.ctx.intake.scope.item_count > 0)
      ? opts.ctx.intake.scope.item_count
      : null
  const productName = pickAnchorProduct(opts.ctx)
  const isReplacement = isReplacementJob(opts.ctx)
  const maxRetries = verifyMaxRetries()

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Fetch the rendered bytes to judge. Can't read → keep what we have.
    let renderedBytes: { base64: string; mime: string }
    try {
      const { data: rblob } = await supabase.storage.from(BUCKET).download(path)
      if (!rblob) break
      const rbuf = Buffer.from(await rblob.arrayBuffer())
      renderedBytes = { base64: rbuf.toString('base64'), mime: rblob.type || 'image/png' }
    } catch {
      break
    }

    const judgement = await judgePreview({
      rendered: renderedBytes,
      productRef: opts.productRef ?? null,
      expectedCount,
      productName,
      isReplacement,
    })
    console.log('[preview] judge verdict', {
      quoteId: opts.quoteId, index: opts.index, attempt,
      pass: judgement.pass, countSeen: judgement.countSeen,
      defects: judgement.defects.slice(0, 4),
    })
    if (judgement.pass) break
    if (attempt === maxRetries) break // retries exhausted — keep best effort

    const feedback = defectFeedback(judgement)
    if (!feedback) break
    try {
      path = await generateOnePreview({
        intakeId: opts.intakeId,
        sourcePath: opts.sourcePath,
        index: opts.index,
        prompt: opts.prompt,
        productRef: opts.productRef,
        sourceBytes,
        extraStrict: feedback,
      })
    } catch (e: any) {
      console.warn('[preview] judge-retry render failed (non-fatal, keeping prior render)', {
        quoteId: opts.quoteId, index: opts.index, error: e?.message ?? String(e),
      })
      break
    }
  }

  return path
}

// Item 3 — pass 1: remove the existing fitting, returning the cleaned
// image bytes. Best-effort — returns null on ANY failure so the caller
// falls back to single-pass. Never throws.
async function runRemovalPass(
  sourcePath: string,
  ctx: PromptContext,
): Promise<{ base64: string; mime: string } | null> {
  try {
    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(sourcePath)
    if (dlErr || !blob) return null
    const srcBuf = Buffer.from(await blob.arrayBuffer())
    const aspectRatio = aspectRatioFromImage(srcBuf)

    const removal = buildRemovalPrompt(ctx)
    // Provider returns the cleaned-image bytes in the same {base64, mime}
    // shape this function returns to its caller — pass through unchanged.
    return await geminiProvider.renderImage({
      system: removal.system,
      user: removal.user,
      sourceImage: {
        base64: srcBuf.toString('base64'),
        mime: blob.type || 'image/jpeg',
      },
      aspectRatio: aspectRatio ?? undefined,
    })
  } catch {
    return null
  }
}

// (Gemini wire-format types now live in providers/gemini.ts.)

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
    type InlineLi = {
      description?: string
      quantity?: number
      source?: string
      // WP4 — render-link stamped by enrichLinesWithCatalogue / the
      // deterministic builder. Carried through so the preview can show
      // THE EXACT product.
      catalogue_id?: string | null
      image_path?: string | null
      // Operator's catalogue blurb — extra "what the product is"
      // context fed alongside the photo.
      product_description?: string | null
    }
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
          catalogue_id: li.catalogue_id ?? null,
          image_path: li.image_path ?? null,
          product_description: li.product_description ?? null,
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
