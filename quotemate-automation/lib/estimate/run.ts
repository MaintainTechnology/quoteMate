import { anthropic } from '@ai-sdk/anthropic'
import { generateText, stepCountIs } from 'ai'
import { createClient } from '@supabase/supabase-js'
import { systemPrompt } from './prompt'
import { makeTools } from './tools'
import { buildCandidatePrices, validateQuoteGrounding, type GroundingFailure, type PricingBookForValidation } from './validate'
import {
  catalogueCandidateRows,
  formatCatalogueHint,
  formatBomHint,
  formatTierLadderHint,
  effectiveAssembly,
  enrichLinesWithCatalogue,
  applyChosenProduct,
  type CatalogueHintRow,
  type BomHintRow,
  type TierLadderHintRow,
  type TenantMaterial,
  type SharedMaterial,
  type BomLine,
  type CatalogueProductRef,
} from './catalogue'
import { applyMinLabourFloor } from './min-labour'
import { reconcileTierMath, collapseDuplicateTiers, checkQuantityVsItemCount } from './reconcile'
import { specGuardMode, evaluateSpecGuard } from './spec-guard'
import {
  mergeRecipesIntoDraft,
  buildRecipeSlots,
  type AssemblyMeta,
  type DraftWithTiers,
} from './merge-recipes'
import type { PriceQuestion } from './price-bands'
import {
  summarisePriceHistory,
  formatPriceHistoryHint,
  type PastQuoteTiers,
} from './price-history'
import { buildDeterministicTiers, type DeterministicTierInput } from './deterministic-bom'
import { fetchSimilarPastQuotesContext } from './rag'
import { pipelineLog } from '@/lib/log/pipeline'
import { createTracer, stopwatch } from '@/lib/log/trace'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export type EstimationResult = {
  /** The draft quote that the route handler should persist + dispatch.
   *  If grounding validation failed, this draft is downgraded to
   *  inspection-required (good/better/best=null, needs_inspection=true). */
  draft: any
  /** Set when the validator found ungrounded prices — populated for
   *  observability so Vercel logs show exactly which line items failed. */
  groundingFailures?: GroundingFailure[]
  /** True when the draft was forced to inspection-required because
   *  validation failed. The route handler should NOT create three-tier
   *  Stripe sessions in this case. */
  downgradedToInspection?: boolean
}

/** Phase 6 (2026-05-27) — optional conversation_state for the price-bands
 *  recipe engine. When the caller is the SMS route, it loads the
 *  sms_conversations.conversation_state for the intake and passes it here
 *  so the merge step (buildRecipeSlots) can see the customer's most
 *  recent slot answers (distance_to_existing_power, circuit_required,
 *  etc.). Voice and other callers pass null — they don't have an SMS
 *  conversation state — and the recipe falls back to intake.scope.
 *
 *  Kept loose-typed because callers persist this as jsonb; runtime shape
 *  is normalised inside lib/sms/extract-slots.ts before consumption by
 *  the dialog. Here we only forward .slots into buildRecipeSlots, so a
 *  malformed shape produces an empty slot map rather than a crash. */
export type RecipeConversationState = {
  slots?: Record<string, unknown> | null
} | null | undefined

export async function runEstimation(
  intake: any,
  pricingBook: any,
  modelId = 'claude-opus-4-8',
  conversationState: RecipeConversationState = null,
): Promise<EstimationResult> {
  const cacheLog = pipelineLog('estimate', intake?.id ?? null)
  // Phase 7 — structured tracer. Fires fire-and-forget DB writes to
  // pipeline_traces (mig 076) at every key transition so the dashboard
  // Pipeline tab can render a step-by-step timeline. console.log lines
  // via `cacheLog` still go to Vercel logs — these are additive, never
  // replacing the existing scannable lines.
  const trace = createTracer(supabase, {
    tenant_id: (intake?.tenant_id as string | null) ?? null,
    intake_id: (intake?.id as string | null) ?? null,
  })
  const totalSw = stopwatch()
  trace('estimate', 'ok', {
    substep: 'start',
    message: `runEstimation invoked (model=${modelId})`,
    inputs: {
      intake_id: intake?.id ?? null,
      job_type: intake?.job_type ?? null,
      trade: intake?.trade ?? null,
      confidence: intake?.confidence ?? null,
      tenant_id: intake?.tenant_id ?? null,
      hourly_rate: (pricingBook as { hourly_rate?: unknown })?.hourly_rate ?? null,
      markup_pct:
        (pricingBook as { default_markup_pct?: unknown })?.default_markup_pct ?? null,
      conversation_state_slot_count:
        conversationState && typeof conversationState === 'object' && conversationState.slots
          ? Object.keys(conversationState.slots).length
          : 0,
    },
  })

  // RAG: anchor Opus to similar past quotes. Returns null on cold-start
  // (no usable matches), all-inspection results, or if RAG_DISABLED=true.
  // The block goes in the user message — keeps the system message
  // fully cacheable while still informing this specific draft.
  let ragContext: string | null = null
  let ragMatchCount = 0
  try {
    const rag = await fetchSimilarPastQuotesContext(supabase, intake)
    if (rag) {
      ragContext = rag.context
      ragMatchCount = rag.matchCount
      cacheLog.ok('RAG context attached', { match_count: ragMatchCount, chars: rag.context.length })
    } else {
      cacheLog.ok('RAG context skipped', { reason: 'no usable matches or disabled' })
    }
  } catch (e: any) {
    // RAG must never block estimation. Log + carry on.
    cacheLog.err('RAG fetch failed — continuing without similar-quote context', e?.message ?? String(e))
  }

  // Brand preferences (migration 022). Soft hint appended to the system
  // prompt so Opus biases material picks toward the tradie's preferred
  // brands when multiple candidates fit the customer's tier/spec. Never
  // a hard filter — the grounding validator (loadCandidatePrices +
  // validateQuoteGrounding below) keeps the safety guarantees regardless
  // of which brand Opus picks. Preferences are scoped to intake.trade so
  // a plumbing-only quote doesn't see electrical-brand hints and vice
  // versa.
  const preferencesBlock = await buildPreferencesBlock(
    (intake?.tenant_id as string | null) ?? null,
    (intake?.trade as string | null) ?? null,
    cacheLog,
  )

  // WP2 — operator brand+range catalogue hint. WP3 — structured BOM hint.
  // Both soft, both null when the tenant has no catalogue / the BOM table
  // is unseeded, so this is purely additive (no change for legacy data).
  const catalogueBlock = await buildCatalogueHint(
    (intake?.tenant_id as string | null) ?? null,
    (intake?.trade as string | null) ?? null,
    cacheLog,
  )
  const bomBlock = await buildBomHint(intake, (intake?.trade as string | null) ?? null, cacheLog)

  // WP2 historical-pricing (safe slice). SOFT advisory only — appended
  // to the user prompt exactly like the catalogue/BOM hints, NEVER fed
  // to the grounding validator, so it can only nudge and can never
  // over-reject or change an accepted price. Flag-gated off by default
  // (PRICE_HISTORY_HINT) and best-effort → fully inert until enabled.
  const priceHistoryBlock =
    process.env.PRICE_HISTORY_HINT === '1'
      ? await buildPriceHistoryHint(
          (intake?.tenant_id as string | null) ?? null,
          (intake?.job_type as string | null) ?? null,
          cacheLog,
        )
      : null

  const userPrompt =
    (ragContext ? `${ragContext}\n` : '') +
    (preferencesBlock ? `${preferencesBlock}\n` : '') +
    (catalogueBlock ? `${catalogueBlock}\n` : '') +
    (bomBlock ? `${bomBlock}\n` : '') +
    (priceHistoryBlock ? `${priceHistoryBlock}\n` : '') +
    `Draft a quote for this NEW intake:\n\n${JSON.stringify(intake, null, 2)}`

  // Tenant-scoped tool factory. lookupAssembly now reads BOTH
  // shared_assemblies AND this tenant's tenant_custom_assemblies
  // (migration 023). Legacy intakes without tenant_id get the
  // shared catalogue only — same behaviour as pre-023.
  const tools = makeTools((intake?.tenant_id as string | null) ?? null)

  // Anthropic prompt caching: the system prompt + pricing-book derivation
  // is identical across estimations until pricing_book changes, so we mark
  // it as ephemeral. First call inside the 5-min cache window pays full
  // price (cacheCreationInputTokens > 0); subsequent calls read at ~10%
  // cost (cacheReadInputTokens > 0). Cache invalidates automatically when
  // any pricing_book field changes (different prompt content → different key).
  const llmSw = stopwatch()
  const result = await generateText({
    model: anthropic(modelId),
    messages: [
      {
        role: 'system',
        // Data-driven router: loads the trade's trade_prompts template
        // (bundled-template + oracle fallback). See lib/estimate/prompt.ts.
        content: await systemPrompt(intake, pricingBook),
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' } },
        },
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ],
    tools,
    stopWhen: stepCountIs(10),  // build-guide says `maxSteps: 10`; AI SDK v5+ renamed it to stopWhen+stepCountIs
    maxRetries: 0,              // wrapper handles retries with logging — no double-retry
    // Opus 4.7 ignores temperature — AI SDK warns on every call if it's
    // set. Determinism here comes from the strict tool-call grounding +
    // pricing book lookup, not from temperature.
  })

  const cacheMeta = (result.providerMetadata as any)?.anthropic
  if (cacheMeta) {
    cacheLog.ok(`${modelId} call complete (cache stats)`, {
      cache_creation_input_tokens: cacheMeta.cacheCreationInputTokens ?? 0,
      cache_read_input_tokens: cacheMeta.cacheReadInputTokens ?? 0,
      input_tokens: cacheMeta.usage?.inputTokens ?? null,
      output_tokens: cacheMeta.usage?.outputTokens ?? null,
    })
  }

  const draft = parseJsonFromText(result.text)

  // Phase 7 — record the LLM-call outcome.
  trace('estimate', 'ok', {
    substep: 'llm_draft',
    message: `${modelId} produced draft (needs_inspection=${!!draft?.needs_inspection})`,
    inputs: {
      // The full prompt is too large to store; record what shaped it.
      model: modelId,
      rag_match_count: ragMatchCount,
    },
    outputs: {
      needs_inspection: !!draft?.needs_inspection,
      job_type: intake?.job_type ?? null,
      good_subtotal: draft?.good?.subtotal_ex_gst ?? null,
      better_subtotal: draft?.better?.subtotal_ex_gst ?? null,
      best_subtotal: draft?.best?.subtotal_ex_gst ?? null,
      inspection_reason: draft?.inspection_reason ?? null,
      assumptions_count: Array.isArray(draft?.assumptions) ? draft.assumptions.length : 0,
      risk_flags_count: Array.isArray(draft?.risk_flags) ? draft.risk_flags.length : 0,
    },
    decisions: {
      cache_read_input_tokens: cacheMeta?.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: cacheMeta?.cacheCreationInputTokens ?? 0,
    },
    duration_ms: llmSw.elapsed(),
  })

  // Inspection-required quotes don't carry line items, so there's nothing
  // to validate — accept as-is. The route handler will force tier nulls and
  // the $99 inspection total.
  if (draft?.needs_inspection === true) {
    trace('estimate', 'warn', {
      substep: 'route_to_inspection',
      message: 'draft self-reported needs_inspection=true; skipping validation',
      decisions: { route: 'inspection', cause: 'llm_self_reported' },
      duration_ms: totalSw.elapsed(),
    })
    return { draft }
  }

  // ── Phase 2 — DETERMINISTIC BOM (flag-gated, default OFF) ──────────
  // When DETERMINISTIC_BOM=1 AND this tenant has a curated recipe +
  // catalogue for the job, REBUILD good/better/best from their own data
  // so the same job quotes the same parts at the same prices every
  // time. Opus's scope_of_works / assumptions / framing are kept; only
  // the priced line items are replaced. Any safe-failure (no recipe,
  // service off, unpriceable required part, no rate) → leave Opus's
  // draft exactly as-is (zero regression). The min-labour floor + the
  // grounding validator below STILL run on the result, so a drifted
  // deterministic price self-corrects to inspection — same safety
  // envelope as the Opus path. This block is fully dormant until the
  // env flag is explicitly set.
  if (process.env.DETERMINISTIC_BOM === '1') {
    try {
      const loaded = await loadDeterministicInputs(intake, pricingBook)
      if (loaded.input) {
        const built = buildDeterministicTiers(loaded.input)
        if (built.tiers) {
          for (const tier of ['good', 'better', 'best'] as const) {
            const prev =
              draft[tier] && typeof draft[tier] === 'object' ? draft[tier] : {}
            draft[tier] = {
              ...prev,
              line_items: built.tiers[tier].line_items,
              subtotal_ex_gst: built.tiers[tier].subtotal_ex_gst,
            }
          }
          draft.needs_inspection = false
          cacheLog.ok('deterministic BOM applied (recipe × catalogue — same job, same price)', {
            assembly: loaded.assemblyName,
            good_subtotal: built.tiers.good.subtotal_ex_gst,
            better_subtotal: built.tiers.better.subtotal_ex_gst,
            best_subtotal: built.tiers.best.subtotal_ex_gst,
          })
        } else {
          cacheLog.ok('deterministic BOM skipped — falling back to Opus draft', {
            reason: built.reason,
          })
        }
      } else {
        cacheLog.ok('deterministic BOM skipped — falling back to Opus draft', {
          reason: loaded.reason,
        })
      }
    } catch (e: any) {
      // Never let the deterministic path break estimation — fall back.
      cacheLog.err(
        'deterministic BOM errored — falling back to Opus draft',
        e?.message ?? String(e),
      )
    }
  }

  // Apply the configured minimum-charge floor BEFORE grounding so a
  // small but correctly-priced job (e.g. one GPO) is quoted at the
  // tradie's own minimum instead of being bounced to a $99 inspection.
  // Deterministic + grounded (tops labour up at pricing_book.hourly_rate);
  // never undercharges, never fabricates; no-ops when already compliant.
  // This mutates `draft` in place, so validation below sees the floor.
  const floorSw = stopwatch()
  const floored = applyMinLabourFloor(draft, pricingBook)
  if (floored.adjustedTiers.length > 0) {
    cacheLog.ok('min-labour floor applied (small-job minimum charge — not bounced to inspection)', {
      tiers: floored.adjustedTiers,
      min_labour_hours: (pricingBook as any)?.min_labour_hours ?? 2.0,
    })
    trace('estimate', 'ok', {
      substep: 'min_labour_floor',
      message: `floor applied to ${floored.adjustedTiers.length} tier(s)`,
      decisions: {
        adjusted_tiers: floored.adjustedTiers,
        min_labour_hours: (pricingBook as any)?.min_labour_hours ?? 2.0,
      },
      duration_ms: floorSw.elapsed(),
    })
  }

  // ── Phase 3 — PRICE-BANDS RECIPE MERGE ─────────────────────────────
  // For each tier where Opus picked an assembly that carries a
  // price_recipe (jsonb), evaluate the recipe against the customer's
  // slot answers (intake.scope + conversation_state.slots) and merge
  // the resulting extras into the tier — extra labour, cable per
  // metre, risk flags, and optionally a base-assembly SWAP. Lets the
  // GPO recipe (mig 074) auto-quote installs that previously routed
  // to a $99 inspection because the customer mentioned a non-default
  // distance or amperage. No-op when the assembly has no recipe; falls
  // back silently on load errors so the un-banded draft still ships.
  let mergedDraft: DraftWithTiers = draft
  try {
    const recipeCtx = await loadRecipeContext(
      (intake?.trade as string | null) ?? null,
      (intake?.tenant_id as string | null) ?? null,
    )
    if (recipeCtx.recipesByAssemblyId.size > 0) {
      // Phase 6: SMS callers thread sms_conversations.conversation_state
      // through here. buildRecipeSlots gives conversation slots priority
      // over intake.scope (newer signal wins), so live customer answers
      // captured by the slot extractor (Phase 4) reach the recipe engine.
      // Other callers (voice, /api/quote/[id]/edit) pass null and the
      // recipe falls back to intake.scope only — same as Phase 3-5 behaviour.
      const slots = buildRecipeSlots(
        intake,
        conversationState && typeof conversationState === 'object'
          ? { slots: (conversationState.slots ?? {}) as Record<string, unknown> }
          : null,
      )
      const { draft: postMerge, outcome } = mergeRecipesIntoDraft(draft, {
        recipesByAssemblyId: recipeCtx.recipesByAssemblyId,
        assembliesById: recipeCtx.assembliesById,
        slots,
        pricingBook,
      })
      mergedDraft = postMerge
      if (outcome.any_changed) {
        // Copy mutations back onto the original `draft` reference so
        // downstream code (validator, enrich, WP9, downgrade path) sees
        // them. mergeRecipesIntoDraft is purely functional; we apply
        // its result onto the live draft here.
        Object.assign(draft, postMerge)
        trace('estimate', 'ok', {
          substep: 'recipe_merge',
          message: 'price-bands recipe modifiers applied',
          decisions: {
            good_recipes_fired: outcome.good.recipes_fired,
            good_swapped_to: outcome.good.swapped_to,
            good_added_line_items: outcome.good.added_line_items,
            better_recipes_fired: outcome.better.recipes_fired,
            best_recipes_fired: outcome.best.recipes_fired,
            good_subtotal_after: draft?.good?.subtotal_ex_gst ?? null,
          },
        })
        cacheLog.ok('price-bands recipe merge applied', {
          good: outcome.good.changed
            ? {
                recipes_fired: outcome.good.recipes_fired,
                swapped_to: outcome.good.swapped_to,
                added_lines: outcome.good.added_line_items,
                defaults_used: outcome.good.defaults_used,
              }
            : null,
          better: outcome.better.changed
            ? {
                recipes_fired: outcome.better.recipes_fired,
                swapped_to: outcome.better.swapped_to,
                added_lines: outcome.better.added_line_items,
                defaults_used: outcome.better.defaults_used,
              }
            : null,
          best: outcome.best.changed
            ? {
                recipes_fired: outcome.best.recipes_fired,
                swapped_to: outcome.best.swapped_to,
                added_lines: outcome.best.added_line_items,
                defaults_used: outcome.best.defaults_used,
              }
            : null,
        })
      }
    }
  } catch (e: any) {
    // Recipe merge must NEVER block estimation. Log + carry on.
    cacheLog.err(
      'price-bands recipe merge errored — continuing with un-banded draft',
      e?.message ?? String(e),
    )
  }

  // Auto-quote path: every line_item.unit_price_ex_gst MUST be derivable
  // from pricing_book + shared_materials + shared_assemblies + the
  // tenant's tenant_custom_assemblies (migration 023). If even one
  // line item fails grounding, downgrade the entire quote to inspection.
  // v5 multi-trade: scope grounding to intake.trade so an electrical quote
  // can never coincidentally validate against a plumbing price (or vice versa).
  const candidates = await loadCandidatePrices(
    pricingBook,
    intake?.trade ?? null,
    (intake?.tenant_id as string | null) ?? null,
  )
  const validateSw = stopwatch()
  const check = validateQuoteGrounding(draft, pricingBook as PricingBookForValidation, candidates)

  if (check.valid) {
    trace('estimate', 'ok', {
      substep: 'validate_grounding',
      message: 'all line items grounded',
      decisions: {
        good_subtotal: draft?.good?.subtotal_ex_gst ?? null,
        better_subtotal: draft?.better?.subtotal_ex_gst ?? null,
        best_subtotal: draft?.best?.subtotal_ex_gst ?? null,
        route: 'auto_quote',
      },
      duration_ms: validateSw.elapsed(),
    })
    // WP4 — link each grounded material line back to the operator
    // catalogue product that priced it (catalogue_id + image_path) so
    // the render can show THE EXACT product. STRICTLY render-only: this
    // runs AFTER grounding, mutates only render metadata, never a
    // price/total/route, and is best-effort (any failure → today's
    // text-only behaviour, no regression). The deterministic path has
    // already stamped exact links; enrichment is idempotent there.
    // Loaded once and reused by both WP4 enrichment and the WP9
    // live-product re-resolve below.
    let catalogueRefs: CatalogueProductRef[] = []
    try {
      catalogueRefs = await loadCatalogueProductRefs(
        (intake?.tenant_id as string | null) ?? null,
        (intake?.trade as string | null) ?? null,
      )
      if (catalogueRefs.length > 0) {
        const e = enrichLinesWithCatalogue(draft, catalogueRefs)
        if (e.linked > 0) {
          cacheLog.ok('WP4 — linked quote lines to operator catalogue products', {
            linked: e.linked,
          })
        }
      }
    } catch (err: any) {
      cacheLog.err(
        'WP4 catalogue-link enrichment failed (non-fatal — quote unaffected)',
        err?.message ?? String(err),
      )
    }

    // WP9 — if the customer picked a specific product mid-chat, FORCE it
    // (name + its catalogue price + photo) into every priced tier's
    // headline line. Deterministic, not a hint. Runs AFTER grounding;
    // the price is the operator's own catalogue price (the WP2-grounded
    // legitimate price the customer literally selected) so this is
    // consistent with the money model — same post-draft adjustment
    // pattern as applyMinLabourFloor. Flag-gated + best-effort.
    if (process.env.WP9_PRODUCT_OPTIONS === '1') {
      try {
        const chosen = (intake?.scope as { chosen_product?: any } | null)?.chosen_product
        if (chosen) {
          // The SMS offer froze a snapshot of the product when it was
          // sent. If the tradie uploaded/edited the photo or description
          // AFTER that, the snapshot is stale. Re-resolve the CURRENT
          // photo + blurb from the live catalogue row by id so the
          // latest uploaded image + description always win the render.
          const live = catalogueRefs.find(
            (rf) =>
              rf?.id != null &&
              chosen?.catalogue_id != null &&
              String(rf.id) === String(chosen.catalogue_id),
          )
          const chosenLive = {
            ...chosen,
            image_path:
              live?.image_path && String(live.image_path).trim() !== ''
                ? live.image_path
                : chosen.image_path ?? null,
            description:
              live?.description && String(live.description).trim() !== ''
                ? live.description
                : chosen.description ?? null,
          }
          // SPEC GUARD — does the product about to be locked contradict the
          // spec the customer agreed to (intake.scope.specs.requested_specs)?
          // Shadow (default) logs only; enforce skips the lock so a wrong-
          // spec product is never forced — the quote keeps its conventional
          // grounded Good/Better/Best. Degrade-never-block: only a positive
          // same-key contradiction blocks; unknown/missing never does.
          const guardMode = specGuardMode()
          let guardBlocked = false
          if (guardMode !== 'off') {
            try {
              const requestedSpecs =
                (intake?.scope as { specs?: { requested_specs?: unknown } } | null)
                  ?.specs?.requested_specs ?? null
              const decision = evaluateSpecGuard({
                requested: requestedSpecs as Record<string, string> | null,
                properties: chosen?.properties ?? null,
                name: chosen?.name,
                trade: (intake?.trade as string | null) ?? chosen?.trade ?? null,
                category: chosen?.category ?? null,
                mode: guardMode,
              })
              if (decision.verdict === 'mismatch') {
                cacheLog.err(
                  `WP9 spec guard [${guardMode}] — chosen product contradicts requested spec${decision.block ? ' (BLOCKED lock)' : ' (shadow — not blocked)'}`,
                  decision.reason,
                  { product: chosen?.name, conflicts: decision.conflicts },
                )
                guardBlocked = decision.block
              }
            } catch (gErr: any) {
              cacheLog.err('WP9 spec guard errored (non-fatal — lock proceeds)', gErr?.message ?? String(gErr))
            }
          }
          const r = guardBlocked
            ? { applied: [] as string[] }
            : applyChosenProduct(draft, chosenLive)
          if (r.applied.length > 0) {
            // The customer already PICKED one product — Good/Better/Best
            // no longer makes sense (all three now hold the same chosen
            // product at the same price, which reads as 3 confusing
            // identical tiers). Collapse to ONE option: keep the chosen
            // tier, drop the others. The SMS builder + /q page + Stripe
            // pay-links already support <3 tiers (this is the same shape
            // as "BEST dropped"), so this is safe.
            const keep = (r.applied.includes('good')
              ? 'good'
              : r.applied[0]) as 'good' | 'better' | 'best'
            if (draft[keep]) {
              for (const t of ['good', 'better', 'best'] as const) {
                if (t !== keep) draft[t] = null
              }
              draft.selected_tier = keep
            }
            cacheLog.ok('WP9 — chosen product forced into the quote (single option)', {
              product: chosen?.name,
              price: chosen?.price_ex_gst,
              kept_tier: keep,
            })
          }
        }
      } catch (err: any) {
        cacheLog.err(
          'WP9 chosen-product apply failed (non-fatal — quote unaffected)',
          err?.message ?? String(err),
        )
      }
    }

    // ── Deterministic quote-integrity backstops (post-grounding, pre-return) ──
    // Grounding proved each UNIT price; these make the BILL consistent with
    // those proven prices, collapse fake-identical tiers, and flag a quantity
    // that disagrees with item_count — without fabricating a price, changing a
    // billed quantity, or downgrading a good quote. Best-effort: a failure here
    // must never break an already-grounded quote.
    try {
      const { corrections } = reconcileTierMath(draft)
      collapseDuplicateTiers(draft)
      const qtyFlags = checkQuantityVsItemCount(draft, intake?.scope?.item_count)
      if (qtyFlags.length > 0) {
        draft.risk_flags = [
          ...(Array.isArray(draft.risk_flags) ? draft.risk_flags : []),
          ...qtyFlags,
        ]
      }
      if (corrections.length > 0 || qtyFlags.length > 0) {
        cacheLog.ok('reconcile backstops applied', {
          math_corrections: corrections.length,
          quantity_flags: qtyFlags.length,
        })
      }
    } catch (err: any) {
      cacheLog.err(
        'reconcile backstops failed (non-fatal — quote unaffected)',
        err?.message ?? String(err),
      )
    }

    trace('estimate', 'ok', {
      substep: 'done',
      message: 'auto-quote returned (grounded, enriched)',
      decisions: {
        route: 'auto_quote',
        tier_count: ['good', 'better', 'best'].filter((k) => draft?.[k]).length,
      },
      duration_ms: totalSw.elapsed(),
    })
    return { draft }
  }

  // Log every failure so the next-time diagnosis is one log query away.
  // Without this the only signal we have is the count, which masks
  // whether the failures are price-band, semantic-category, or labour-rate.
  cacheLog.err('grounding validation failed — per-line failures follow', null, {
    inspection_cause: 'grounding_failed',
    failure_count: check.failures.length,
    failures: check.failures.map((f) => ({
      tier: f.tier,
      lineIndex: f.lineIndex,
      description: f.description?.slice(0, 80),
      unit: f.unit,
      price: f.unit_price_ex_gst,
      expected: f.expected,
    })),
  })
  trace('estimate', 'err', {
    substep: 'validate_grounding',
    message: `grounding validation failed — ${check.failures.length} line(s) ungrounded`,
    outputs: {
      failure_count: check.failures.length,
      failures: check.failures.slice(0, 10).map((f) => ({
        tier: f.tier,
        line_index: f.lineIndex,
        description: f.description?.slice(0, 80),
        unit: f.unit,
        price: f.unit_price_ex_gst,
        expected: f.expected,
      })),
    },
    decisions: {
      route: 'inspection',
      cause: 'grounding_failed',
    },
    duration_ms: validateSw.elapsed(),
  })

  const reason = `Pricing not yet available — ${check.failures.length} line item(s) failed grounding check against the database. A site visit is needed before we can quote accurately.`

  const downgraded = {
    ...draft,
    good: null,
    better: null,
    best: null,
    needs_inspection: true,
    inspection_reason: reason,
    estimated_timeframe: 'After site visit (within 5 business days)',
    // Preserve scope_short for the SMS, but null the assumptions if they
    // referenced fabricated prices/inclusions.
  }

  trace('estimate', 'warn', {
    substep: 'done',
    message: 'returned inspection-downgrade (grounding failed)',
    decisions: { route: 'inspection', cause: 'grounding_failed' },
    duration_ms: totalSw.elapsed(),
  })

  return {
    draft: downgraded,
    groundingFailures: check.failures,
    downgradedToInspection: true,
  }
}

/**
 * Load every shared_materials and shared_assemblies row (name + price) and
 * expand each into raw + marked-up candidate prices so the validator can
 * enforce both price-grounding AND semantic-category-grounding.
 *
 * v5 multi-trade: pass `trade` to scope candidates to the intake's trade.
 * Without this filter, an electrical quote could "pass" validation by
 * coincidentally matching a plumbing price — the trade column is now the
 * canonical scope.
 *
 * v6+ migration 023: also pulls tenant_custom_assemblies for this tenant
 * so prices the LLM grounded on a tenant-owned custom assembly pass
 * validation. always_inspection=true rows are excluded (matching the
 * tool exclusion) so the validator never accepts a price derived from
 * a service the tradie wanted to always inspect.
 *
 * Exported for re-use by /api/quote/[id]/edit so tradie hand-edits get the
 * same grounding gate the LLM draft gets (H-2, 2026-05-25).
 */
/**
 * Phase 3 (2026-05-27) — recipe context loader for mergeRecipesIntoDraft.
 *
 * Returns two parallel maps keyed by assembly_id:
 *   • recipesByAssemblyId — the parsed PriceQuestion[] for any
 *     shared_assemblies / tenant_custom_assemblies row whose
 *     price_recipe column is set
 *   • assembliesById — name + default_unit_price + default_labour_hours
 *     for EVERY assembly in the trade+tenant scope, so the merge module
 *     can resolve assembly_override_id swaps regardless of whether the
 *     swap target itself carries a recipe.
 *
 * Both maps are scoped to the intake's trade + tenant (with the same
 * always_inspection=false filter that loadCandidatePrices uses for
 * tenant_custom_assemblies — we never let the recipe path price a
 * service the tradie wants to always inspect).
 *
 * Deploy-order-safe: a pre-074 prod (no price_recipe column) yields
 * recipesByAssemblyId.size === 0, which short-circuits the merge in
 * runEstimation to a no-op. Same SELECT * approach used by
 * loadCandidatePrices for the same reason.
 */
async function loadRecipeContext(
  trade: string | null,
  tenantId: string | null,
): Promise<{
  recipesByAssemblyId: Map<string, readonly PriceQuestion[]>
  assembliesById: Map<string, AssemblyMeta>
}> {
  let sharedQ = supabase.from('shared_assemblies').select('*')
  if (trade) sharedQ = sharedQ.eq('trade', trade)

  const tenantCustomPromise = tenantId
    ? (() => {
        let q = supabase
          .from('tenant_custom_assemblies')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('always_inspection', false)
        if (trade) q = q.eq('trade', trade)
        return q
      })()
    : Promise.resolve({ data: [] as any[] })

  const [{ data: shared }, { data: custom }] = await Promise.all([
    sharedQ,
    tenantCustomPromise,
  ])

  const recipesByAssemblyId = new Map<string, readonly PriceQuestion[]>()
  const assembliesById = new Map<string, AssemblyMeta>()

  for (const row of (shared ?? []) as any[]) {
    if (!row?.id) continue
    assembliesById.set(row.id, {
      id: row.id,
      name: row.name,
      default_unit_price_ex_gst: row.default_unit_price_ex_gst,
      default_labour_hours: row.default_labour_hours,
    })
    if (Array.isArray(row.price_recipe) && row.price_recipe.length > 0) {
      recipesByAssemblyId.set(row.id, row.price_recipe as PriceQuestion[])
    }
  }
  // Tenant custom rows override shared by id (custom never shares an id
  // with shared via UUID birthright; this loop is additive — sets that
  // key for any tenant-owned id that wasn't in shared).
  for (const row of (custom ?? []) as any[]) {
    if (!row?.id) continue
    assembliesById.set(row.id, {
      id: row.id,
      name: row.name,
      default_unit_price_ex_gst: row.default_unit_price_ex_gst,
      default_labour_hours: row.default_labour_hours,
    })
    if (Array.isArray(row.price_recipe) && row.price_recipe.length > 0) {
      recipesByAssemblyId.set(row.id, row.price_recipe as PriceQuestion[])
    }
  }

  return { recipesByAssemblyId, assembliesById }
}

export async function loadCandidatePrices(
  pricingBook: any,
  trade: string | null,
  tenantId: string | null,
) {
  const materialsQuery = supabase
    .from('shared_materials')
    .select('*')
  // select('*') (not an explicit column list) so a pre-029 prod where
  // `category` doesn't exist yet can't turn into a PostgREST
  // missing-column error → null data → ZERO assembly candidates → every
  // quote dumped to inspection. Missing column just yields
  // r.category===undefined → null → name-regex fallback. Same pattern as
  // tools.ts makeLookupAssembly. Makes code/migration deploy order safe.
  const assembliesQuery = supabase
    .from('shared_assemblies')
    .select('*')

  // M-6 (2026-05-25) — DELIBERATE difference from the lookup tools.
  // The tools filter `enabled=true` / `active=true` so DISABLED rows are
  // never offered to a NEW quote. But the VALIDATOR's job is different
  // — it accepts prices that Opus already chose. If a tradie disables a
  // product seconds after Opus grounded a draft on it, the row vanishes
  // from the validator's candidate set and the otherwise-valid quote
  // dumps to a $99 inspection. That race is purely time-based and
  // operator-visible to no-one.
  //
  // The fix: load ALL tenant rows for this trade as candidates, not
  // just currently-active ones. `always_inspection=true` rows are STILL
  // excluded because they're a different semantic (services the tradie
  // explicitly wants to inspect, not "I deactivated this product").
  // shared_assemblies + shared_materials have no enabled/active flag,
  // so they remain unchanged.
  const customAssembliesPromise = tenantId
    ? (() => {
        let q = supabase
          .from('tenant_custom_assemblies')
          .select('*') // see assembliesQuery note — deploy-order-safe
          .eq('tenant_id', tenantId)
          // .eq('enabled', true) ← REMOVED (M-6). See block comment above.
          .eq('always_inspection', false)
        if (trade) q = q.eq('trade', trade)
        return q
      })()
    : Promise.resolve({ data: [] as Array<{ name: string; default_unit_price_ex_gst: number | string; trade: string; category: string | null }> })

  // WP2 TRAP-FIX (lockstep with tools.ts makeLookupMaterial): lookupMaterial
  // now returns operator-owned tenant_material_catalogue rows (migration
  // 028), so the validator MUST accept prices grounded on them or every
  // branded quote is downgraded to inspection. Absent table (prod pre-028)
  // → supabase-js returns {data:null} (no throw) → [] → behaviour identical
  // to pre-WP2.
  //
  // M-6 (2026-05-25) — like customAssembliesPromise above, the `active=true`
  // filter is DELIBERATELY OMITTED here. Deactivating a product is a
  // tradie-facing UX action; it shouldn't retroactively invalidate a
  // draft Opus has already grounded on. The lookup tool still filters
  // active=true so no NEW draft will reach for the deactivated row.
  //
  // R-3 (2026-05-25) — `id` is now in the SELECT so the validator's
  // strict UUID path can resolve `source: "material:<id>"` lines back
  // to the exact catalogue row.
  const tenantCataloguePromise = tenantId
    ? (() => {
        let q = supabase
          .from('tenant_material_catalogue')
          .select('id, name, category, unit_price_ex_gst, customer_supply_price_ex_gst, active, trade')
          .eq('tenant_id', tenantId)
          // .eq('active', true) ← REMOVED (M-6). See block comment above.
        if (trade) q = q.eq('trade', trade)
        return q
      })()
    : Promise.resolve({ data: [] as Array<{ id?: string; name: string; unit_price_ex_gst: number | string; customer_supply_price_ex_gst: number | string | null; active: boolean; trade: string }> })

  const [
    { data: materials },
    { data: assemblies },
    { data: customAssemblies },
    { data: tenantCatalogue },
  ] = await Promise.all([
    trade ? materialsQuery.eq('trade', trade) : materialsQuery,
    trade ? assembliesQuery.eq('trade', trade) : assembliesQuery,
    customAssembliesPromise,
    tenantCataloguePromise,
  ])

  // Merge shared + custom assemblies into one candidate set — the
  // validator treats them identically as a (name, price) pair.
  const allAssemblies = [
    ...(assemblies ?? []),
    ...(customAssemblies ?? []),
  ]

  // Expand the tenant catalogue (supply + customer-supply price variants)
  // into material candidates so a branded tenant-priced line grounds.
  const tenantMaterialCandidates = catalogueCandidateRows(
    (tenantCatalogue ?? []) as any[],
  )

  // R-3 (2026-05-25) — propagate the DB row `id` through the candidate
  // builder so the validator's strict path can match by UUID. Shared
  // rows (shared_materials, shared_assemblies) carry an id since they
  // were created with `gen_random_uuid()` (sql/init.sql). Tenant rows
  // (tenant_material_catalogue, tenant_custom_assemblies) likewise.
  return buildCandidatePrices(
    [
      ...(materials ?? []).map((r: any) => ({
        id: r.id ?? null,
        name: r.name,
        price: r.default_unit_price_ex_gst,
        category: r.category ?? null,
      })),
      ...tenantMaterialCandidates,
    ],
    // Migration 029: pass the explicit row category through. NULL on
    // pre-029 prod or un-backfilled rows → buildCandidatePrices falls
    // back to name-regex categorisation (identical to old behaviour).
    allAssemblies.map((r: any) => ({
      id: r.id ?? null,
      name: r.name,
      price: r.default_unit_price_ex_gst,
      category: r.category ?? null,
    })),
    pricingBook,
  )
}

/**
 * Build the "Preferred brands" hint block for the user message.
 *
 * Reads tenant_material_preferences and joins to shared_materials to
 * confirm each (category, brand) pair still exists in the catalogue.
 * Returns null when:
 *   • intake has no tenant_id (legacy pre-v6 or dev intakes)
 *   • the tenant has set no preferences
 *   • the preferences table is unavailable (migration 022 not run)
 *
 * Lives in the USER message, not the system message, so per-tenant
 * variance doesn't fragment the system-prompt cache. The system prompt
 * stays identical across all tenants — only the per-call user message
 * carries tenant-specific hints.
 *
 * Soft instruction phrasing: "prefer X when matching candidates exist"
 * — never starves a quote when the customer needs a tier the preferred
 * brand can't fulfil.
 */
async function buildPreferencesBlock(
  tenantId: string | null,
  trade: string | null,
  log: ReturnType<typeof pipelineLog>,
): Promise<string | null> {
  if (!tenantId) return null

  try {
    const { data, error } = await supabase
      .from('tenant_material_preferences')
      .select('category, preferred_brand')
      .eq('tenant_id', tenantId)

    if (error) {
      // Table missing or RLS blocking — log + carry on. Estimation
      // continues without preferences (current behaviour pre-022).
      log.err('preferences fetch failed — continuing without brand hints', error.message)
      return null
    }
    if (!data || data.length === 0) return null

    // Scope hints to the intake's trade so an electrical quote doesn't
    // see plumbing-side brand picks. We join to shared_materials.category
    // to filter — but a single category slug can technically be reused
    // across trades (e.g. "sundries"), so we use an IN-list filter via
    // a category lookup rather than assuming exclusivity.
    if (trade) {
      const categories = data.map((p) => p.category as string)
      const { data: catRows } = await supabase
        .from('shared_materials')
        .select('category')
        .in('category', categories)
        .eq('trade', trade)
        .limit(categories.length * 4)

      const validCategories = new Set<string>(
        (catRows ?? []).map((r) => r.category as string),
      )
      const scoped = data.filter((p) =>
        validCategories.has(p.category as string),
      )
      if (scoped.length === 0) return null
      return formatPreferencesBlock(scoped)
    }

    return formatPreferencesBlock(data)
  } catch (e: any) {
    log.err('preferences block build failed', e?.message ?? String(e))
    return null
  }
}

function formatPreferencesBlock(
  rows: Array<{ category: string | null; preferred_brand: string | null }>,
): string {
  const lines = rows
    .filter((r): r is { category: string; preferred_brand: string } =>
      typeof r.category === 'string' && typeof r.preferred_brand === 'string',
    )
    .map((r) => `  • ${r.category}: ${r.preferred_brand}`)

  if (lines.length === 0) return ''

  return [
    'Tradie preferred brands (soft hint — apply ONLY when picking materials):',
    ...lines,
    'When multiple shared_materials candidates fit the customer\'s tier and specs,',
    'prefer the row whose brand matches the tradie\'s preference for that category.',
    'If no preferred-brand candidate matches the customer\'s actual need, pick the',
    'best fit regardless of brand — never sacrifice tier/spec match for brand.',
    'Grounding validation runs after your output regardless of brand choice.',
  ].join('\n')
}

/**
 * WP2 — operator catalogue hint. Lists the tenant's active
 * tenant_material_catalogue rows (brand + range -> tier) so Opus
 * prefers their real products. Resilient: missing table / no rows /
 * error -> null, so legacy tenants are unaffected.
 */
async function buildCatalogueHint(
  tenantId: string | null,
  trade: string | null,
  log: ReturnType<typeof pipelineLog>,
): Promise<string | null> {
  if (!tenantId) return null
  try {
    let q = supabase
      .from('tenant_material_catalogue')
      .select('category, name, brand, range_series, tier_hint')
      .eq('tenant_id', tenantId)
      .eq('active', true)
    if (trade) q = q.eq('trade', trade)
    const { data, error } = await q
    if (error) {
      log.err('catalogue hint fetch failed — continuing without it', error.message)
      return null
    }
    const baseHint = formatCatalogueHint((data ?? []) as CatalogueHintRow[])

    // v7 Phase 3 — prepend the tenant's explicit Good/Better/Best ladder
    // (tenant_tier_ladder, migration 043) when present. The ladder hint is
    // the strongest soft signal we surface; the grounding validator still
    // governs the money path regardless. Resilient: missing table /
    // empty ladder → baseHint unchanged.
    try {
      let lq = supabase
        .from('tenant_tier_ladder')
        .select(
          'category, tier, ' +
            'tenant_material_catalogue!inner ( name, brand, trade )',
        )
        .eq('tenant_id', tenantId)
      if (trade) lq = lq.eq('tenant_material_catalogue.trade', trade)
      const { data: ladderRows } = await lq
      const hintRows: TierLadderHintRow[] = []
      for (const r of (ladderRows ?? []) as any[]) {
        const cat = r.category as string
        const tier = r.tier as TierLadderHintRow['tier']
        const tmc = Array.isArray(r.tenant_material_catalogue)
          ? r.tenant_material_catalogue[0]
          : r.tenant_material_catalogue
        if (!tmc) continue
        hintRows.push({
          category: cat,
          tier,
          product_name: tmc.name as string,
          brand: (tmc.brand ?? null) as string | null,
        })
      }
      const ladderHint = formatTierLadderHint(hintRows)
      if (ladderHint && baseHint) return `${ladderHint}\n\n${baseHint}`
      if (ladderHint) return ladderHint
    } catch (e: any) {
      // Pre-043 prod / FK absent → fall through to baseHint quietly.
      log.err('tier ladder hint fetch failed — continuing without it', e?.message ?? String(e))
    }
    return baseHint
  } catch (e: any) {
    log.err('catalogue hint build failed', e?.message ?? String(e))
    return null
  }
}

/**
 * WP3 — structured bill-of-materials hint. Finds shared_assemblies that
 * match the job, pulls their shared_assembly_bom rows, and lists the
 * baseline parts so the same job quotes the same parts every time.
 * Resilient: no matching assembly / unseeded BOM / error -> null.
 */
async function buildBomHint(
  intake: any,
  trade: string | null,
  log: ReturnType<typeof pipelineLog>,
): Promise<string | null> {
  const jobType = (intake?.job_type as string | null) ?? null
  if (!jobType) return null
  try {
    const term = jobType.replace(/_/g, ' ')
    let aq = supabase.from('shared_assemblies').select('id, name, trade').ilike('name', `%${term}%`)
    if (trade) aq = aq.eq('trade', trade)
    const { data: asm, error: aerr } = await aq.limit(5)
    if (aerr || !asm || asm.length === 0) return null
    const ids = asm.map((a: any) => a.id)
    const tenantId = (intake?.tenant_id as string | null) ?? null

    // Prefer this tradie's OWN recipe (tenant_assembly_bom, migration
    // 031) over the shared baseline. Absent table (prod pre-031) →
    // supabase returns {data:null} (no throw) → [] → falls back to
    // shared, so this is purely additive / no behaviour change.
    if (tenantId) {
      const { data: ownBom } = await supabase
        .from('tenant_assembly_bom')
        .select('material_category, quantity, required, description, sort')
        .eq('tenant_id', tenantId)
        .in('assembly_id', ids)
        .order('sort', { ascending: true })
      if (ownBom && ownBom.length > 0) {
        return formatBomHint(ownBom as BomHintRow[])
      }
    }

    const { data: bom, error: berr } = await supabase
      .from('shared_assembly_bom')
      .select('material_category, quantity, required, description, sort')
      .in('assembly_id', ids)
      .order('sort', { ascending: true })
    if (berr) {
      log.err('BOM hint fetch failed — continuing without it', berr.message)
      return null
    }
    return formatBomHint((bom ?? []) as BomHintRow[])
  } catch (e: any) {
    log.err('BOM hint build failed', e?.message ?? String(e))
    return null
  }
}

/**
 * WP2 historical-pricing (safe slice). Best-effort: pulls THIS tenant's
 * own past priced quotes for the same job_type (the same data RAG
 * already uses — no external import) and summarises them into a SOFT
 * per-tier $ band hint. Resilient: missing rows / error / too-few
 * samples → null (no hint, behaviour unchanged). NEVER feeds the
 * validator — advisory only.
 */
async function buildPriceHistoryHint(
  tenantId: string | null,
  jobType: string | null,
  log: ReturnType<typeof pipelineLog>,
): Promise<string | null> {
  if (!tenantId || !jobType) return null
  try {
    const { data, error } = await supabase
      .from('quotes')
      .select('good, better, best, needs_inspection, created_at, intakes!inner(tenant_id, job_type)')
      .eq('intakes.tenant_id', tenantId)
      .eq('intakes.job_type', jobType)
      .order('created_at', { ascending: false })
      .limit(60)
    if (error) {
      log.err('price-history hint fetch failed — continuing without it', error.message)
      return null
    }
    const past: PastQuoteTiers[] = (data ?? [])
      .filter((r: any) => r?.needs_inspection !== true)
      .map((r: any) => ({
        good: r?.good?.subtotal_ex_gst ?? null,
        better: r?.better?.subtotal_ex_gst ?? null,
        best: r?.best?.subtotal_ex_gst ?? null,
      }))
    return formatPriceHistoryHint(summarisePriceHistory(past, jobType))
  } catch (e: any) {
    log.err('price-history hint build failed', e?.message ?? String(e))
    return null
  }
}

/**
 * Phase 2 — load the DB inputs the deterministic BOM builder needs.
 * Returns { input:null, reason } whenever the job cannot be honoured
 * deterministically (no recipe / service switched off / no rate) so
 * the caller falls straight back to the Opus draft (zero regression).
 * Only ever invoked behind the DETERMINISTIC_BOM flag in runEstimation,
 * so it is completely dormant until explicitly enabled.
 */
async function loadDeterministicInputs(
  intake: any,
  pricingBook: any,
): Promise<
  | { input: DeterministicTierInput; assemblyName: string }
  | { input: null; reason: string }
> {
  const jobType = (intake?.job_type as string | null) ?? null
  const tenantId = (intake?.tenant_id as string | null) ?? null
  const trade = (intake?.trade as string | null) ?? null
  if (!jobType) return { input: null, reason: 'no job_type' }
  if (!tenantId) return { input: null, reason: 'no tenant_id' }

  // Match the job the same way buildBomHint does (name ilike job term,
  // trade-scoped). default_labour_hours grounds the labour line.
  const term = jobType.replace(/_/g, ' ')
  let aq = supabase
    .from('shared_assemblies')
    .select('id, name, trade, default_labour_hours')
    .ilike('name', `%${term}%`)
  if (trade) aq = aq.eq('trade', trade)
  const { data: asm, error: aerr } = await aq.limit(5)
  if (aerr || !asm || asm.length === 0) {
    return { input: null, reason: 'no matching assembly' }
  }
  const ids = asm.map((a: any) => a.id)
  const primary = asm[0] as {
    id: string
    name: string
    default_labour_hours: number | string
  }

  // The tradie's OWN recipe for this job wins; when they haven't authored
  // one, fall back to the shared baseline recipe (shared_assembly_bom) —
  // exactly as buildBomHint does above. This lets the deterministic builder
  // fire for ANY job with a seeded shared recipe, priced from THIS tenant's
  // tier-hinted catalogue (with shared_materials as the universal floor).
  // No tenant recipe AND no shared recipe → not deterministic (Opus path).
  const { data: ownRecipe } = await supabase
    .from('tenant_assembly_bom')
    .select('material_category, quantity, required, description, sort')
    .eq('tenant_id', tenantId)
    .in('assembly_id', ids)
    .order('sort', { ascending: true })
  let recipe = ownRecipe
  if (!recipe || recipe.length === 0) {
    const { data: sharedRecipe } = await supabase
      .from('shared_assembly_bom')
      .select('material_category, quantity, required, description, sort')
      .in('assembly_id', ids)
      .order('sort', { ascending: true })
    recipe = sharedRecipe
  }
  if (!recipe || recipe.length === 0) {
    return { input: null, reason: 'no recipe (tenant or shared) for this job' }
  }

  // v7 Phase 0: single source of truth per table —
  //   tenant_service_offerings.enabled    → Services-tab toggle (this read)
  //   tenant_assembly_overrides.labour|markup → Estimation-tab overrides
  // (Pre-v7 this block selected labour/markup from tenant_service_offerings,
  // but those columns never existed on that table — see migration 015 and
  // 028. The select was a latent error; only the early-return on the
  // disabled flag was actually doing work.)
  const { data: offerings } = await supabase
    .from('tenant_service_offerings')
    .select('assembly_id, enabled')
    .eq('tenant_id', tenantId)
    .in('assembly_id', ids)
  const primaryOffering =
    (offerings ?? []).find((o: any) => o.assembly_id === primary.id) ?? null
  if (primaryOffering && primaryOffering.enabled === false) {
    return { input: null, reason: 'service disabled in Services tab' }
  }

  const { data: assemblyOverrides } = await supabase
    .from('tenant_assembly_overrides')
    .select('assembly_id, labour_hours_override, markup_pct_override')
    .eq('tenant_id', tenantId)
    .in('assembly_id', ids)
  const primaryOverride =
    (assemblyOverrides ?? []).find((o: any) => o.assembly_id === primary.id) ?? null

  const eff = effectiveAssembly(
    primary.default_labour_hours,
    (pricingBook as any)?.default_markup_pct,
    primaryOverride
      ? {
          labour_hours_override: primaryOverride.labour_hours_override,
          markup_pct_override: primaryOverride.markup_pct_override,
        }
      : null,
  )

  // Catalogue (active, trade) + shared materials (trade) — the price
  // sources. Selects mirror loadCandidatePrices for deploy-safety.
  let cq = supabase
    .from('tenant_material_catalogue')
    .select(
      'id, category, name, brand, range_series, supplier, unit, unit_price_ex_gst, customer_supply_price_ex_gst, tier_hint, active',
    )
    .eq('tenant_id', tenantId)
    .eq('active', true)
  if (trade) cq = cq.eq('trade', trade)
  let mq = supabase
    .from('shared_materials')
    .select('name, category, default_unit_price_ex_gst, unit')
  if (trade) mq = mq.eq('trade', trade)
  const [{ data: catRows }, { data: sharedRows }] = await Promise.all([cq, mq])

  const input: DeterministicTierInput = {
    bom: (recipe ?? []) as BomLine[],
    tenantMaterials: (catRows ?? []) as TenantMaterial[],
    sharedMaterials: (sharedRows ?? []) as SharedMaterial[],
    labourHours: Number(eff.labourHours.value),
    hourlyRate: Number((pricingBook as any)?.hourly_rate),
    markupPct: Number(eff.markupPct.value),
  }
  return { input, assemblyName: primary.name }
}

/**
 * WP4 — load the operator catalogue as {id, name, image_path} so a
 * grounded line can be linked back to the exact product it was priced
 * from (for the render). Best-effort + render-only: this runs AFTER
 * grounding, never feeds the validator, and any failure just means
 * "no product link" (today's behaviour). Absent table (pre-028 prod)
 * → supabase returns {data:null} → [] → no-op.
 */
async function loadCatalogueProductRefs(
  tenantId: string | null,
  trade: string | null,
): Promise<CatalogueProductRef[]> {
  if (!tenantId) return []
  try {
    let q = supabase
      .from('tenant_material_catalogue')
      .select('id, name, image_path, description')
      .eq('tenant_id', tenantId)
      .eq('active', true)
    if (trade) q = q.eq('trade', trade)
    const { data } = await q
    return (data ?? []) as CatalogueProductRef[]
  } catch {
    return []
  }
}

// Opus often prefixes its response with reasoning ("Calculation: ...", "Here is the quote:")
// or wraps in ```json fences. Extract the first balanced { ... } block.
function parseJsonFromText(text: string): any {
  // Try direct parse first (happy path)
  const direct = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try { return JSON.parse(direct) } catch {}

  // Fallback: find the first { and walk forward counting braces (respecting strings)
  const start = text.indexOf('{')
  if (start < 0) throw new Error(`No JSON object found in Opus output. First 300 chars: ${text.slice(0, 300)}`)

  let depth = 0, inStr = false, esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        const candidate = text.slice(start, i + 1)
        try { return JSON.parse(candidate) }
        catch (e: any) {
          throw new Error(`Found JSON-shaped block but couldn't parse it: ${e.message}\n\nFirst 300 chars of candidate:\n${candidate.slice(0, 300)}`)
        }
      }
    }
  }

  throw new Error(`Unbalanced braces in Opus output. First 300 chars: ${text.slice(0, 300)}`)
}
