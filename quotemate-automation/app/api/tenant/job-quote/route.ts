// ════════════════════════════════════════════════════════════════════
// POST /api/tenant/job-quote — the dashboard job quoter's entrypoint.
//
// Electrical + plumbing were only ever reachable through the SMS
// receptionist. This route drives the SAME pipeline from a tradie-typed
// form: labelled answers → prose transcript → structureIntake() → intakes
// row → /api/estimate/draft → quote.
//
// It is deliberately a thin wrapper. The precedent is the web-lead path in
// app/api/t/[slug]/lead/route.ts, which already proved that a form can enter
// the intake pipeline without an SMS conversation; the only additions here
// are the tenant auth gate and the tradieDrafted hold.
//
// NEVER AUTO-SENDS. tradieDrafted:true forces shouldHoldForReview() to hold
// regardless of the tenant's review policy, so the customer is not texted
// until the tradie presses Send on /dashboard/quote/[share_token]. The
// customer's mobile IS stamped on intake.caller so that Send is one click
// (it is source #1 of the recipient chain in lib/quote/send-customer.ts).
// ════════════════════════════════════════════════════════════════════

import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { requireFeature } from '@/lib/features/guard'
import { structureIntake } from '@/lib/intake/structure'
import { embedIntake } from '@/lib/intake/embed'
import { deriveTradeFromJobType, IntakeSchema } from '@/lib/intake/schema'
import {
  allowsPinnedCatalogueProduct,
  EV_CHARGER_TRADIE_SUPPLY_ANSWER,
  fieldsForJobType,
} from '@/lib/quote/job-fields'
import { RECIPE_SLOT_CODES, recipeSlotsFrom } from '@/lib/quote/recipe-slots'
import { normaliseAuMobile } from '@/lib/phone/au'
import { findOrCreateCustomer } from '@/lib/customers/lookup'
import { customerMemoryAllowed } from '@/lib/customers/memory-scope'
import { refreshSignedUrl } from '@/lib/storage/upload'
import {
  claimJobQuoteOperation, jobQuoteOperationResponse, jobQuoteRequestHash,
  readJobQuoteOperation, updateJobQuoteOperation, validJobQuoteMedia,
  type JobQuoteOperation,
} from '@/lib/quote/job-quote-operation'

// structureIntake (Opus) then runEstimation (Opus) run inline so the response
// can carry the share_token the form navigates to. Worst case is ~2 minutes.
// MUST be a static literal — a computed value is silently ignored by Next.
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BodySchema = z.object({
  /** Stable, client-persisted attempt identity. Older web clients remain compatible. */
  operation_id: z.string().uuid().transform(value => value.toLowerCase()).optional(),
  // Reuse the canonical enum rather than re-declaring it — a job type added
  // to lib/intake/schema.ts is accepted here automatically.
  job_type: IntakeSchema.shape.job_type,
  address: z.string().trim().min(1, 'address is required'),
  suburb: z.string().trim().min(1, 'suburb is required'),
  /** code → answer, keyed by JOB_FIELDS[job_type].fields[].code. */
  answers: z.record(z.string(), z.string()).default({}),
  notes: z.string().trim().max(4000).default(''),
  customer_name: z.string().trim().max(200).default(''),
  customer_mobile: z.string().trim().max(40).default(''),
  customer_email: z.string().trim().max(200).default(''),
  /** Optional tenant_material_catalogue product the tradie pinned. */
  product_name: z.string().trim().max(300).optional(),
  /** The pinned product's catalogue row. The NAME alone is only a hint the
   *  estimator may ignore; the id lets the server re-read the row and force
   *  that exact price. Never trust a client-sent price. */
  product_id: z.string().uuid().transform(value => value.toLowerCase()).optional(),
  /** Optional photos of the job, already uploaded to the private intake-photos
   *  bucket by /api/tenant/job-quote/photos (spec ev-charger-location-photo R3).
   *  Storage PATHS are the durable reference stored on the intake; the signed
   *  URLs are short-lived and used only to feed the structurer's vision pass.
   *  Capped at 3 to match the upload route and the estimate document. */
  photo_paths: z.array(z.string().trim().min(1)).max(3).optional(),
  photo_urls: z.array(z.string().trim().min(1)).max(3).optional(),
})

const THREE_PHASE_INSPECTION_ANSWER = 'three phase (on-site inspection)'
const CUSTOMER_SUPPLIES_EV_CHARGER = 'customer already has the charger'

type IntakeWithScope = {
  scope: Record<string, unknown> & { specs?: Record<string, unknown> }
}

/**
 * The phase option is a routing contract, not a suggestion to the structuring
 * model. Preserve the model's decision for every other answer, including
 * "not sure", but make the explicit three-phase choice inspection-only.
 */
export function enforceThreePhaseInspection<T extends { inspection_required: boolean }>(
  intake: T,
  answers: Record<string, string>,
): T {
  if (answers.phase !== THREE_PHASE_INSPECTION_ANSWER) return intake
  return { ...intake, inspection_required: true }
}

/**
 * The select value is authoritative portal data. Canonicalise it after the
 * model structures the transcript so quote safety never depends on the model
 * inferring the supply enum from prose. "Not sure" deliberately unsets it.
 */
export function canonicaliseEvChargerSupply<T extends IntakeWithScope>(
  intake: T,
  jobType: string,
  answers: Record<string, string>,
): T {
  if (jobType !== 'ev_charger') return intake
  const specs = { ...(intake.scope.specs ?? {}) }
  delete specs.supplied_by
  if (answers.charger_supply === CUSTOMER_SUPPLIES_EV_CHARGER) {
    specs.supplied_by = 'customer'
  } else if (answers.charger_supply === EV_CHARGER_TRADIE_SUPPLY_ANSWER) {
    specs.supplied_by = 'tradie'
  }
  return { ...intake, scope: { ...intake.scope, specs } }
}

type PinnedProductRequest = {
  product_id?: string
  product_name?: string
}

/** Defense in depth for stale/tampered EV requests at the API boundary. */
export function filterPinnedProductRequest(
  jobType: string,
  answers: Record<string, string>,
  request: PinnedProductRequest,
): PinnedProductRequest {
  return allowsPinnedCatalogueProduct(jobType, answers) ? request : {}
}

export async function POST(req: Request) {
  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await req.json())
  } catch (e: unknown) {
    const issues = e instanceof z.ZodError ? e.issues.map((i) => i.message) : ['invalid body']
    return Response.json({ ok: false, error: 'invalid_body', issues }, { status: 400 })
  }

  // The tradie picked the job type, so the trade follows from it — gate on
  // that trade, not on whatever they happen to have selected in the UI.
  const trade = deriveTradeFromJobType(body.job_type)
  const gate = await requireFeature(req, trade)
  if (!gate.ok) return Response.json(gate.body, { status: gate.status })
  const tenant = gate.tenant
  const pinnedProductRequest = filterPinnedProductRequest(body.job_type, body.answers, {
    product_id: body.product_id,
    product_name: body.product_name,
  })

  if (!validJobQuoteMedia(tenant.id, body)) {
    return Response.json({ ok: false, error: 'invalid_body', issues: ['Use up to three distinct photos uploaded by this account.'] }, { status: 400 })
  }
  let operation: JobQuoteOperation | undefined
  // Once INSERT is dispatched, even a transport error can conceal a commit.
  let intakeWriteDispatched = false

  try {
    if (body.operation_id) {
      const hash = jobQuoteRequestHash(body)
      const receipt = await claimJobQuoteOperation(supabase, tenant.id, body.operation_id, hash, !!pinnedProductRequest.product_id)
      if (receipt.operation.request_hash !== hash) {
        return Response.json({ ok: false, error: 'operation_input_conflict' }, { status: 409 })
      }
      if (!receipt.claimed) return jobQuoteOperationResponse(await readJobQuoteOperation(supabase, receipt.operation))
      operation = receipt.operation
    }
    const transcript = buildTranscript(body, trade)
    // Spec ev-charger-location-photo R3 — the second argument has always been
    // `photoUrls: string[]` and has always been passed empty from here, so a
    // dashboard job could never use vision. Feeding the freshly-signed URLs
    // costs no signature change and lets the structurer see the spot.
    // URL expiry/rotation never changes request identity. Vision only receives
    // server-signed private objects from the authenticated upload namespace.
    const photoUrls = await Promise.all((body.photo_paths ?? []).map(path => refreshSignedUrl(path)))
    const structuredIntake = await structureIntake(transcript, photoUrls, trade)
    const inspectionRoutedIntake = enforceThreePhaseInspection(structuredIntake, body.answers)
    const intake = canonicaliseEvChargerSupply(
      inspectionRoutedIntake,
      body.job_type,
      body.answers,
    )

    // The tradie explicitly chose the job type. Opus classifies it again from
    // the transcript and can disagree (e.g. reading "replacing a leaking
    // mixer" as tap_repair when the tradie said tap_replace). The tradie is
    // standing in front of the job — their pick wins, and job_type drives
    // assembly scoping in the validator, so a silent override would price
    // the wrong thing.
    intake.job_type = body.job_type
    intake.trade = trade

    // ── Price-recipe slots ──────────────────────────────────────────
    // buildRecipeSlots (lib/estimate/merge-recipes.ts:394) reads intake.scope.*
    // scalars as its SECOND pass; its third pass is conversation_state.slots,
    // which a portal draft never has (no sms_conversations row). So scope is the
    // only channel these can travel down. Without them applyPriceBands falls
    // back to default_when_unanswered — 2 metres and 10A, the cheapest band of
    // each — so a 10 m run on a dedicated 20A circuit would quote as a 2 m 10A
    // job, and the 20A/three-phase assembly swap would never fire.
    intake.scope = { ...intake.scope, ...recipeSlotsFrom(body.answers) } as typeof intake.scope

    // ── The pinned product ──────────────────────────────────────────
    // The prose directive alone is a hint Opus can override, so nothing
    // guaranteed the quote used the row the tradie picked. Writing
    // scope.chosen_product hands the estimator the same structured channel the
    // SMS picker uses: applyChosenProduct locks THIS row's price and UUID. For
    // a tradie-pinned EV unit it adds a distinct qty-1 material line; other
    // categories retain the existing headline-replacement behaviour.
    //
    // Re-read server-side by (id, tenant_id, trade). The client already holds
    // the price, but trusting it would let a tampered request price a job at
    // any figure — and the trade scope is what makes the row resolvable to the
    // validator's candidate set at all.
    if (pinnedProductRequest.product_id) {
      const { data: row } = await supabase
        .from('tenant_material_catalogue')
        .select('id, name, unit_price_ex_gst, image_path, description, category, trade, properties, active')
        .eq('id', pinnedProductRequest.product_id)
        .eq('tenant_id', tenant.id)
        .eq('trade', trade)
        .maybeSingle()
      const rawPrice = (row as { unit_price_ex_gst?: unknown } | null)?.unit_price_ex_gst
      // Null/blank is missing catalogue authority, never a configured zero.
      const price = typeof rawPrice === 'number' || (typeof rawPrice === 'string' && rawPrice.trim() !== '')
        ? Number(rawPrice) : Number.NaN
      if (row && (row as { active?: boolean }).active !== false && Number.isFinite(price) && price >= 0) {
        const r = row as Record<string, unknown>
        intake.scope = {
          ...intake.scope,
          chosen_product: {
            catalogue_id: String(r.id),
            name: String(r.name ?? ''),
            price_ex_gst: +price.toFixed(2),
            image_path: (r.image_path as string | null) ?? null,
            description: (r.description as string | null) ?? null,
            category: String(r.category ?? ''),
            trade: (r.trade as string | null) ?? trade,
            properties: (r.properties as Record<string, unknown> | null) ?? null,
            // Marks this as a TRADIE pin rather than a customer's SMS pick.
            // lib/estimate/run.ts reads it to (a) run without the WP9 flag and
            // (b) keep the tier menu — see the notes there.
            pinned_by: 'tradie',
          },
        } as typeof intake.scope
      } else {
        // Wrong tenant, wrong trade, archived or unpriced. Fall through to the
        // prose directive rather than failing the whole draft.
        console.warn('[job-quote] pinned product not resolvable; falling back to prose', {
          product_id: pinnedProductRequest.product_id,
        })
      }
    }

    // ── Customer identity ───────────────────────────────────────────
    // Normalise to E.164 before anything stores or matches on it.
    // findOrCreateCustomer keys on EXACT phone_number string equality
    // (lib/customers/lookup.ts:74-78) and every live row is +61-prefixed, so a
    // row minted from the raw '0400 123 456' the form sends is one Twilio's
    // +61400123456 would never match — a silently useless record.
    const mobileE164 = normaliseAuMobile(body.customer_mobile)

    // customers is GLOBALLY phone-keyed and findOrCreateCustomer hands back
    // another tenant's row unchanged, so the memory-scope gate is not optional:
    // without it a shared handset would surface one tradie's customer on
    // another's dashboard. Same gate the SMS route uses.
    let customerId: string | null = null
    if (mobileE164) {
      try {
        const cust = await findOrCreateCustomer(mobileE164, 'web', tenant.id)
        if (cust && customerMemoryAllowed(cust.tenant_id, tenant.id)) customerId = cust.id
      } catch (e: unknown) {
        // Never fail the quote over the address book.
        console.error('[job-quote] customer link failed', e instanceof Error ? e.message : String(e))
      }
    }

    // Stamp contact details verbatim rather than trusting the model to lift
    // them out of the transcript — same reasoning as app/api/t/[slug]/lead.
    // The tradie TYPED these, so their values win over the model's guess; the
    // previous order preferred intake.caller.name and contradicted both this
    // comment and its sibling fields.
    intake.caller = {
      ...(intake.caller ?? {}),
      name: (body.customer_name || intake.caller?.name) ?? '',
      // E.164 when we could parse it — this is recipient source #1 for
      // POST /api/quote/[id]/send. Fall back to the raw string so a landline or
      // an odd format is still visible to a human on the quote page.
      phone: mobileE164 ?? (body.customer_mobile || null),
      ...(body.customer_email ? { email: body.customer_email } : {}),
    } as typeof intake.caller

    const embedding = await embedIntake(intake)

    if (operation) operation = await updateJobQuoteOperation(supabase, operation, {
      pinned: !!(intake.scope as { chosen_product?: unknown } | null)?.chosen_product,
    })

    intakeWriteDispatched = true
    const { data: intakeRow, error: insErr } = await supabase
      .from('intakes')
      .insert({
        ...(operation ? { id: operation.intake_id } : {}),
        tenant_id: tenant.id,
        // Unlocks recipient source #4 for a later Send, and lets a future
        // inbound SMS from this handset be recognised instead of arriving cold.
        customer_id: customerId,
        trade: intake.trade,
        job_type: intake.job_type,
        address: intake.address || body.address,
        suburb: intake.suburb || body.suburb,
        scope: intake.scope,
        access: intake.access,
        property: intake.property,
        risks: intake.risks,
        inspection_required: intake.inspection_required,
        caller: intake.caller,
        timing: intake.timing,
        confidence: intake.confidence,
        confidence_reason: intake.confidence_reason,
        // Spec ev-charger-location-photo R3. photo_paths is the durable
        // reference every downstream reader uses — the EV estimate document's
        // Images section, the customer quote page, and the Gemini render
        // trigger, which does nothing when this array is empty.
        //
        // photo_urls is deliberately NOT written: that column does not exist on
        // intakes (verified against production — only photo_paths does), so
        // including it fails the whole INSERT and costs the tradie their quote.
        // The signed URLs are short-lived anyway; they are used in-memory for
        // the structurer's vision pass above and then discarded, and anything
        // that needs a URL later re-signs the path.
        ...(body.photo_paths?.length ? { photo_paths: body.photo_paths } : {}),
        embedding,
      })
      .select('id')
      .single()

    if (insErr || !intakeRow) {
      console.error('[job-quote] intake insert failed', insErr?.message)
      if (operation) {
        operation = await updateJobQuoteOperation(supabase, operation, { status: 'unknown' })
        return jobQuoteOperationResponse(await readJobQuoteOperation(supabase, operation))
      }
      return Response.json({ ok: false, error: 'intake_insert_failed' }, { status: 500 })
    }

    // Same self-call the web-lead path uses. APP_URL in prod, request origin
    // in dev/preview where it isn't set (otherwise the URL becomes
    // "undefined/api/estimate/draft" and no quote drafts).
    const appUrl =
      process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin
    const draftRes = await fetch(`${appUrl}/api/estimate/draft`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Internal self-call — /api/estimate/draft and /api/intake/structure are
        // guarded by isCronAuthorised, which is fail-closed in production.
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ intakeId: intakeRow.id, tradieDrafted: true }),
    })

    if (!draftRes.ok) {
      const detail = (await draftRes.text()).slice(0, 300)
      console.error('[job-quote] estimate/draft returned', draftRes.status, detail)
      if (operation) {
        operation = await updateJobQuoteOperation(supabase, operation, { status: 'unknown' })
        return jobQuoteOperationResponse(await readJobQuoteOperation(supabase, operation))
      }
      return Response.json(
        { ok: false, error: 'draft_failed', intakeId: intakeRow.id, detail },
        { status: 502 },
      )
    }

    // draft answers HTTP 200 with {ok:false, skipped:'not_entitled'} when the
    // tenant's billing entitlement blocks the quote — a 200 here is NOT
    // success, so read the envelope rather than the status.
    const draft = (await draftRes.json()) as {
      ok?: boolean
      quoteId?: string
      skipped?: string
      reason?: string
      error?: string
    }
    if (operation && draftRes.status === 202) {
      return jobQuoteOperationResponse(await readJobQuoteOperation(supabase, operation))
    }
    if (!draft.ok || !draft.quoteId) {
      if (operation) {
        operation = await updateJobQuoteOperation(supabase, operation, { status: 'unknown' })
        return jobQuoteOperationResponse(await readJobQuoteOperation(supabase, operation))
      }
      return Response.json(
        {
          ok: false,
          error: draft.skipped ?? draft.error ?? 'draft_incomplete',
          reason: draft.reason ?? null,
          intakeId: intakeRow.id,
        },
        { status: 502 },
      )
    }

    // draft mints the share_token internally and returns only the quote id.
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .select('share_token, needs_inspection')
      .eq('id', draft.quoteId)
      .eq('tenant_id', tenant.id)
      .eq('intake_id', intakeRow.id)
      .single()

    if (operation) {
      if (quoteError || !quote) throw new Error('Draft quote could not be verified')
      operation = await updateJobQuoteOperation(supabase, operation, { status: 'completed', quote_id: draft.quoteId })
      return jobQuoteOperationResponse(await readJobQuoteOperation(supabase, operation))
    }

    return Response.json({
      ok: true,
      intakeId: intakeRow.id,
      quoteId: draft.quoteId,
      shareToken: (quote as { share_token?: string } | null)?.share_token ?? null,
      needsInspection: !!(quote as { needs_inspection?: boolean } | null)?.needs_inspection,
      // Whether the pin actually took. A product_id that fails the
      // (tenant, trade, active, priced) re-read falls back to the prose hint,
      // and silent non-application is the worst outcome for a feature whose
      // entire purpose is "force THIS price" — the tradie saw the price in the
      // picker and would have no reason to doubt it.
      pinned: !!(intake.scope as { chosen_product?: unknown } | null)?.chosen_product,
      pinRequested: !!pinnedProductRequest.product_id,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[job-quote] pipeline failed', message)
    if (operation) {
      try {
        // Only the original claimant can prove it never dispatched the intake
        // insert. Crashed/ambiguous writers and readbacks cannot make this claim.
        operation = await updateJobQuoteOperation(supabase, operation, {
          status: intakeWriteDispatched ? 'unknown' : 'failed_no_commit',
        })
        return jobQuoteOperationResponse(await readJobQuoteOperation(supabase, operation))
      } catch { /* The original durable claim stays fenced if outcome persistence fails. */ }
    }
    if (body.operation_id) return Response.json({ ok: false, error: 'operation_unconfirmed' }, { status: 503 })
    return Response.json({ ok: false, error: 'pipeline_failed', detail: message }, { status: 500 })
  }
}

/**
 * Render the form answers as the prose an intake structurer expects. The
 * pipeline's only input is a transcript, so the form's real job is to
 * produce good prose — which is why JOB_FIELDS carries human-readable option
 * strings rather than canonical enum values.
 */
export function buildTranscript(body: z.infer<typeof BodySchema>, trade: string): string {
  const spec = fieldsForJobType(body.job_type)
  const lines: string[] = [
    `Job typed directly by the ${trade} tradie in the QuoteMax dashboard — this is the tradie describing a job they have already scoped, not a customer enquiry.`,
    ``,
    `Trade: ${trade}`,
    `Job type: ${body.job_type.replace(/_/g, ' ')}`,
    `Address: ${body.address}`,
    `Suburb: ${body.suburb}`,
  ]

  if (body.customer_name) lines.push(`Customer name: ${body.customer_name}`)
  if (body.customer_mobile) lines.push(`Contact mobile: ${body.customer_mobile}`)
  if (body.customer_email) lines.push(`Contact email: ${body.customer_email}`)

  // Answered fields only, in the registry's order, using each field's own
  // question so the model sees the same Q&A shape the SMS receptionist emits.
  // Recipe answers are deliberately WITHHELD from the prose. They reach the
  // price-bands engine through intake.scope, and the recipe adds the cable /
  // labour lines deterministically. Spelling "6 metres from the nearest
  // existing power point" out in the transcript pulls the estimator into
  // pricing cable itself — which violates prompt Rule 18 ("NO RECIPE LINES",
  // lib/estimate/electrical-prompt.ts:166) and then collides with the recipe's
  // own line on the same catalogue row. The D-1 dedup rule rejects the
  // duplicate and the grounding validator dumps the WHOLE quote to the $99
  // inspection route. Observed end-to-end 2026-07-29 on a 6 m / 2-GPO job.
  const answered = spec.fields
    .filter((f) => !(RECIPE_SLOT_CODES as readonly string[]).includes(f.code))
    .map((f) => [f, (body.answers[f.code] ?? '').trim()] as const)
    .filter(([, v]) => v.length > 0)

  if (answered.length > 0) {
    lines.push(``, `Job details:`)
    for (const [f, v] of answered) lines.push(`- ${f.label} ${v}`)
  }

  // Any answer whose code isn't in this job type's spec — keeps a stale
  // client from silently dropping detail the tradie actually typed.
  const known = new Set(spec.fields.map((f) => f.code))
  const extras = Object.entries(body.answers).filter(
    ([k, v]) => !known.has(k) && (v ?? '').trim().length > 0,
  )
  if (extras.length > 0) {
    lines.push(...extras.map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v.trim()}`))
  }

  const pinnedProductRequest = filterPinnedProductRequest(body.job_type, body.answers, {
    product_name: body.product_name,
  })
  if (pinnedProductRequest.product_name) {
    lines.push(
      ``,
      `The tradie has specified this exact product from their own catalogue: ${pinnedProductRequest.product_name}. Quote THIS product and price it from the operator catalogue.`,
    )
  }

  if (body.notes) lines.push(``, `Additional notes from the tradie: ${body.notes}`)

  return lines.join('\n')
}
