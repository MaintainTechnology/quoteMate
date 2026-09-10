import { smsIntakeWorkIdentity } from '@/lib/sms/intake-work'
import { attributeSmsWorkTenant } from '@/lib/sms/durable-work'
import { createClient } from '@supabase/supabase-js'
import { durableAfter as after, currentSmsWork, enqueueSmsWork, enqueueEstimateWork, internalWorkPayload, runSmsWorkNow, withFencedSmsClient, assertSmsWorkOwnership, smsWorkCheckpoint, smsWorkFetch } from '@/lib/sms/durable-work'
import { smsDeliveryWorkScope } from '@/lib/sms/work-delivery-context'
import { updateSmsDeliveryContext } from '@/lib/sms/delivery-context'
import { structureIntake } from '@/lib/intake/structure'
import { deriveTradeFromJobType } from '@/lib/intake/schema'
import { embedIntake } from '@/lib/intake/embed'
import { evaluateIntakeQuality, missingRequiredFields } from '@/lib/intake/quality'
import { reconcileJobType } from '@/lib/intake/job-type-reconcile'
import { pipelineLog } from '@/lib/log/pipeline'
import { withRetry } from '@/lib/util/retry'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { resolveOutboundFromNumber } from '@/lib/sms/outbound-from'
import { buildIncompleteCallSms, buildIntakeRecoverySms, buildPhotoRequestSms, type MissingIntakeField } from '@/lib/sms/templates'
import { findOrCreateCustomer, updateCustomerFromIntake } from '@/lib/customers/lookup'
import { isCronAuthorised } from '@/lib/agents/cron'
import { enqueuePushEvent } from '@/lib/push/events'
import {
  describeChosenProductDirective,
  chosenProductFromChoice,
  type ProductChoiceState,
  type ChosenProduct,
} from '@/lib/sms/product-options'
import { photoDeclined } from '@/lib/sms/quote-readiness'

// WP9 — feed a mid-chat product pick into the estimate. Flag-gated;
// OFF (default) ⇒ this never runs and the transcript is unchanged.
const WP9_ENABLED = process.env.WP9_PRODUCT_OPTIONS === '1'

export const maxDuration = 300

const supabase = withFencedSmsClient(createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { global: { fetch: smsWorkFetch } },
))

type IntakeLeadPushInput = {
  intakeId: string | null
  tenantId: string | null
  leadPushAlreadySent: boolean
  conversationId: string | null
  callId: string | null
  callerName: string | null | undefined
  suburb: string | null | undefined
}

export function scheduleIntakeLeadPush(
  input: IntakeLeadPushInput,
  deps: {
    enqueue?: typeof enqueuePushEvent
    defer?: (callback: () => Promise<unknown>) => void
  } = {},
): boolean {
  if (!input.intakeId || !input.tenantId || input.leadPushAlreadySent) return false
  const chatId = input.conversationId ?? input.callId
  const source = input.conversationId ? 'sms' : input.callId ? 'voice' : 'intake'
  const sourceId = chatId ?? input.intakeId
  const who = [input.callerName, input.suburb].filter(Boolean).join(' in ')
  const enqueue = deps.enqueue ?? enqueuePushEvent
  const defer = deps.defer ?? after
  defer(() => enqueue(supabase, {
    eventKey: `new-lead:${source}:${sourceId}`,
    tenantId: input.tenantId!,
    title: 'New lead',
    body: who ? `${who} just asked for a quote.` : 'A new enquiry just came in.',
    url: chatId ? `/chats?chatId=${chatId}` : '/chats',
  }))
  return true
}

/** Phase answers that mean THREE-PHASE in a customer's own words. Matched
 *  exactly (after trim + lowercase) so a stray mention inside prose never
 *  routes a job to inspection — only a real slot answer does. */
const THREE_PHASE_SLOT_ANSWERS = new Set(['three-phase', 'three phase', '3 phase', '3-phase'])

/**
 * R6(c) (2026-09-02) — deterministic three-phase gate for the SMS path.
 *
 * The dashboard quoter has had one since the EV build (job-quote/route.ts
 * enforceThreePhaseInspection); SMS had nothing, so three-phase routing
 * depended entirely on Opus honouring a prompt rule. Genuine three-phase work
 * IS a site-visit job (switchboard capacity, supply upgrade), and that call is
 * too important to leave to model discretion.
 *
 * Only the customer's OWN explicit answer counts. The slot extractor used to
 * infer 'three-phase' from any EV/Tesla mention — that inference is gone (SMS
 * parity patch), and this helper deliberately does not resurrect it: a
 * single-phase answer, or no answer, changes nothing.
 *
 * PURE: returns the input untouched unless it must set the flag, and it can
 * only ever set inspection_required to true — never clear a decision the
 * structurer or a safety rule already made.
 */
export function enforceSmsThreePhaseInspection<T extends { inspection_required: boolean }>(
  intake: T,
  phaseAnswer: string | null | undefined,
): T {
  const answer = String(phaseAnswer ?? '').trim().toLowerCase()
  if (!THREE_PHASE_SLOT_ANSWERS.has(answer)) return intake
  if (intake.inspection_required === true) return intake
  return { ...intake, inspection_required: true }
}

/**
 * R5(a) — where did THIS job's address come from?
 *
 * A suburb is a stable fact about a customer; a street address is a fact about
 * one job. Backfilling the remembered one silently put an address the customer
 * never typed into the quote, the SMS SCOPE line and the tradie's run sheet
 * (live 2026-09-01: a roofing address from six weeks earlier printed as an EV
 * charger site).
 *
 * So the job address comes from THIS thread or not at all. What memory knows
 * still travels — labelled, tradie-only — as `remembered_address`.
 *
 * PURE.
 */
export function resolveAddressProvenance(
  threadAddress: string | null | undefined,
  customerAddress: string | null | undefined,
): { address_source: 'thread' | 'none'; remembered_address?: string } {
  if ((threadAddress ?? '').trim()) return { address_source: 'thread' }
  const remembered = (customerAddress ?? '').trim()
  return remembered
    ? { address_source: 'none', remembered_address: remembered }
    : { address_source: 'none' }
}

// Channel-agnostic intake handler.
//   • Voice path: { callId } — loads transcript + photos from `calls` row.
//   • SMS path:   { conversationId, sourceChannel: 'sms' } — stitches the
//     dialog into a transcript and prepends the agent's silent assumptions
//     so structureIntake can incorporate them.
// Everything downstream (Opus structuring, embedding, intakes insert,
// quality gate, post-response dispatches) is shared.
type Body =
  | { callId: string; sourceChannel?: 'voice' }
  | { conversationId: string; sourceChannel: 'sms' }

export async function POST(req: Request) {
  // Internal-only. This route structures an intake with Opus, inserts the
  // intakes row and then self-calls /api/estimate/draft, so an anonymous caller
  // reaches the whole money path. proxy.ts:20 is a bare clerkMiddleware() and
  // gates nothing. Same shared guard as /api/estimate/draft — see the longer
  // note there for why isCronAuthorised is reused and how to split the secret
  // later. Placed before req.json() so nothing is parsed or scheduled.
  if (!isCronAuthorised(req)) {
    return new Response('unauthorised', { status: 401 })
  }

  const body = (await req.json()) as Body
  if (!currentSmsWork()) {
    const source = 'conversationId' in body ? `sms:${body.conversationId}` : `voice:${body.callId}`
    let identity = { key: `intake:${source}:initial`, serialKey: source }
    if ('conversationId' in body) {
      const { data: latest, error } = await supabase.from('sms_messages').select('id,twilio_message_sid')
        .eq('conversation_id', body.conversationId).eq('direction', 'inbound')
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle()
      if (error) throw new Error('Intake input revision unavailable')
      identity = smsIntakeWorkIdentity({ conversationId: body.conversationId, providerMessageSid: latest?.twilio_message_sid, messageId: latest?.id })
    }
    const job = await enqueueSmsWork({ ...identity, kind: 'intake',
      payload: internalWorkPayload('/api/intake/structure', body) })
    return runSmsWorkNow(job, POST, { scope: smsDeliveryWorkScope })
  }
  await assertSmsWorkOwnership()


  // Identify the source. Use callId for voice or a synthetic id for SMS so
  // pipeline logs stay correlatable end-to-end.
  const sourceChannel: 'voice' | 'sms' =
    'sourceChannel' in body && body.sourceChannel === 'sms' ? 'sms' : 'voice'
  const logId =
    sourceChannel === 'sms'
      ? `sms:${(body as { conversationId: string }).conversationId}`
      : (body as { callId: string }).callId

  const log = pipelineLog('intake', logId)
  log.step('received', { sourceChannel, ...(sourceChannel === 'sms'
    ? { conversationId: (body as { conversationId: string }).conversationId }
    : { callId: (body as { callId: string }).callId }) })

  // Per-source input fields the rest of the handler depends on.
  let transcript = ''
  let photoUrls: string[] = []
  // Permanent storage paths for the same photos. Persisted on intakes.photo_paths
  // so /q/[token] can re-sign on demand (signed URLs expire after 24h).
  let photoPaths: string[] = []
  // v5 multi-trade: trade hint passed into structureIntake so Opus is
  // grounded in the right trade's vocabulary. Derived from the dialog's
  // detected job_type (SMS path) or pinned to 'electrical' (voice path
  // since Vapi is electrical-only per v5 strategy doc).
  let tradeHint: 'electrical' | 'plumbing' = 'electrical'
  let callId: string | null = null
  let conversationId: string | null = null
  // True when the in-call `send_sms_photo_link` Vapi tool already fired the
  // photo-request SMS during the live conversation. The post-call SMS in
  // after() is skipped in that case to avoid sending the customer two links.
  let photoRequestAlreadySent = false
  let callerNumber: string | null = null
  // WP9 — the customer's mid-chat product pick (structured), captured in
  // the SMS branch and force-applied to the quote before insert so the
  // chosen product + its catalogue price + photo actually drive it.
  let chosenProductForIntake: ChosenProduct | null = null
  let photoRequestToken: string | null = null
  // v6 multi-tenant: stamp the intake (and downstream quote) with the
  // tenant who owns the destination number the customer contacted.
  // Comes from sms_conversations.tenant_id (SMS path) or calls.tenant_id
  // (voice path). Null for legacy pre-v6 traffic that hit the pilot
  // single-pricing-book pipeline — that branch keeps working since
  // /api/estimate/draft falls back when tenant_id is null.
  let tenantId: string | null = null
  // R17 — the dialog/slot-extractor's job_type, captured at function scope so it
  // can be reconciled against the structurer's job_type after structuring.
  let dialogJobType: string | null = null
  // R6(c) — the customer's own phase answer, read straight off the dialog
  // slots so the three-phase gate below never depends on model discretion.
  let dialogRequestedPhase: string | null = null
  /** Spec ev-charger-location-photo R9 — the customer answered the photo ask
   *  with "I can't". Computed from the SMS transcript below. */
  let dialogPhotoDeclined = false
  let leadPushAlreadySent = false

  if (sourceChannel === 'sms') {
    // ─────────────── SMS PATH ───────────────
    conversationId = (body as { conversationId: string }).conversationId
    log.step('loading sms_conversation + messages', { conversationId })

    const { data: convo } = await supabase
      .from('sms_conversations')
      .select('*')
      .eq('id', conversationId)
      .single()
    if (convo) {
      updateSmsDeliveryContext({ tenantId: convo.tenant_id ?? null, conversationId })
      await attributeSmsWorkTenant(convo.tenant_id)
    }
    if (!convo) {
      log.err('sms conversation not found in DB', null, { conversationId })
      return Response.json({ error: 'sms conversation not found' }, { status: 404 })
    }

    // ─────── Idempotency short-circuit (2026-05-19 "bug zapper" fix) ───────
    // The SMS inbound webhook fires this endpoint inside a withRetry wrapper.
    // If the fetch from the inbound's after() block aborts mid-flight (Vercel
    // can terminate in-flight outbound fetches when the parent function nears
    // its limit, or the platform's edge layer can time out before the server
    // returns), the inbound retries — even though the server completed the
    // whole pipeline. Symptom in prod: two intake rows created ~12s apart,
    // two recovery SMSes ("James, what kind of work…" + "Hi James, can I
    // check what type of work…"). This guard short-circuits the second
    // invocation: if the conversation already has an intake_id from a row
    // created in the last few minutes, return that intakeId and skip the
    // entire pipeline. The 10-min window is generous on purpose — Opus +
    // estimator + dispatch is bounded well under that, and the alternative
    // (running Opus twice + double-dispatching SMS) is what we're protecting
    // against. Long-window add-on / second-quote flows are NOT yet supported
    // on a single conversation in v1, so this is safe.
    // A saved intake is a checkpoint, never proof that a quote was completed.
    const existingIntakeQuery = supabase.from('intakes').select('*')
    const { data: existingIntake, error: existingError } = await (convo.intake_id
      ? existingIntakeQuery.eq('id', convo.intake_id).eq('tenant_id', convo.tenant_id)
      : existingIntakeQuery.eq('sms_source_key', `sms:${conversationId}`)).maybeSingle()
    if (existingError) throw new Error(`Intake recovery lookup failed: ${existingError.message}`)
    if (existingIntake && evaluateIntakeQuality(existingIntake) !== 'empty') {
      await enqueueEstimateWork(existingIntake.id, convo.tenant_id)
      // Replaying intake may recover a missing review task, but must never
      // demote a conversation whose quote is already saved or owner-released.
      if (!convo.quote_id) await supabase.from('sms_conversations')
        .update({ intake_id: existingIntake.id, quote_stage: 'estimate_pending', status: 'structuring' })
        .eq('id', conversationId).is('quote_id', null)
      return Response.json({ ok: true, intakeId: existingIntake.id,
        stage: convo.quote_id ? (convo.quote_stage ?? 'quote_saved') : 'estimate_pending', idempotent: true })
    }

    const { data: messages } = await supabase
      .from('sms_messages')
      .select('direction, body, created_at, photo_urls, photo_paths')
      .eq('conversation_id', conversationId)
      .or('direction.eq.inbound,delivery_status.in.(accepted,delivered)')
      .order('created_at', { ascending: true })

    transcript = (messages ?? [])
      .map(m => `${m.direction === 'inbound' ? 'Customer' : 'Agent'}: ${m.body}`)
      .join('\n')

    // Pre-pend the assumptions the dialog agent applied so structureIntake
    // can incorporate them rather than re-deriving from message text alone.
    if (Array.isArray(convo.assumptions_made) && convo.assumptions_made.length) {
      transcript =
        `Assumptions agent applied during dialog:\n` +
        (convo.assumptions_made as string[]).map(a => `  - ${a}`).join('\n') +
        `\n\nFull SMS conversation:\n` + transcript
    }

    // WP9 FLOW-THROUGH — if the customer picked a product mid-chat,
    // prepend a grounded directive so structureIntake bakes THAT exact
    // product into the scope. Downstream the catalogue hint +
    // chooseMaterial prefer it, the grounding validator still governs
    // the price (it's an operator-catalogue product, so it grounds),
    // and WP4 links the quoted line back to it → the render shows the
    // same product. Same prepend pattern as the assumptions block.
    // Flag-gated + best-effort: OFF or no pick ⇒ transcript unchanged.
    if (WP9_ENABLED) {
      try {
        const pc = (convo.product_choice ?? null) as ProductChoiceState | null
        const directive = describeChosenProductDirective(pc)
        if (directive) {
          transcript = `Customer product selection (authoritative):\n  - ${directive}\n\n` + transcript
          log.step('WP9 — chosen product injected into intake transcript', {
            conversationId,
          })
        }
        // Capture the structured pick → force-applied to the draft below
        // (deterministic, not just a hint).
        chosenProductForIntake = chosenProductFromChoice(pc)
      } catch (e) {
        log.err('WP9 product-choice injection failed (non-fatal)', e as Error)
      }
    }

    callerNumber = convo.from_number ?? null
    photoRequestToken = (convo.photo_request_token as string | null) ?? null
    photoRequestAlreadySent = !!convo.photo_request_sent_at
    tenantId = (convo.tenant_id as string | null) ?? null
    leadPushAlreadySent = !!convo.lead_push_sent_at

    // v5: derive tradeHint from the SMS dialog's already-classified job_type.
    // The extractor classifies plumbing job_types per v5; passing the hint
    // forward grounds Opus in the right trade before structuring the intake.
    const slotJobType = (convo.conversation_state as { slots?: { job_type?: string } } | null)?.slots?.job_type
    if (slotJobType) {
      tradeHint = deriveTradeFromJobType(slotJobType)
    }
    dialogJobType = slotJobType ?? null
    dialogRequestedPhase =
      (convo.conversation_state as
        { slots?: { requested_specs?: { phase?: string } } } | null)
        ?.slots?.requested_specs?.phase ?? null

    // Photos arrive on the SMS path through TWO surfaces — both feed
    // structureIntake the same way:
    //   1. Inbound MMS attachments → sms_messages.photo_urls
    //      (extracted by lib/sms/mms.ts, keyed per message)
    //   2. /upload/[token] uploads → sms_conversations.photo_urls
    //      (from the photo-request SMS the dialog agent fires when
    //      it identifies an easy-5 job_type)
    // We aggregate both into a single de-duplicated list before vision.
    const mmsPhotoUrls = (messages ?? [])
      .flatMap(m => Array.isArray(m.photo_urls) ? m.photo_urls : [])
      .filter((u): u is string => typeof u === 'string' && u.length > 0)

    const uploadedPhotoUrls = Array.isArray(convo.photo_urls)
      ? (convo.photo_urls as string[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
      : []

    photoUrls = Array.from(new Set([...mmsPhotoUrls, ...uploadedPhotoUrls]))

    // Same aggregation for permanent storage paths — these get persisted
    // on intakes.photo_paths so /q/[token] can render the photos via
    // freshly-signed URLs (signed URLs expire after 24h).
    const mmsPhotoPaths = (messages ?? [])
      .flatMap(m => Array.isArray(m.photo_paths) ? m.photo_paths : [])
      .filter((p): p is string => typeof p === 'string' && p.length > 0)

    const uploadedPhotoPaths = Array.isArray(convo.photo_paths)
      ? (convo.photo_paths as string[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []

    photoPaths = Array.from(new Set([...mmsPhotoPaths, ...uploadedPhotoPaths]))

    // RE-SIGN before vision. The URLs stored on sms_messages.photo_urls and
    // sms_conversations.photo_urls were signed when the photo arrived and last
    // 24 HOURS. structureIntake hands them to Anthropic, which fetches them
    // server-side — so the moment a conversation is structured more than a day
    // after its earliest photo, every model in the cascade fails identically
    // with "Unable to download the file. Please verify the URL and try again."
    // and the whole route 500s. No intake, no quote, no SMS: the customer just
    // never hears back.
    //
    // Live 2026-09-06, Electrical3 conversation 4caf84f9: an MMS photo arrived
    // 01:15, the EV charger thread resumed 21h later, and by the time the
    // intake ran the MMS URL returned
    // {"error":"InvalidJWT","message":"\"exp\" claim timestamp check failed"}.
    // Opus 4.8 -> Opus 4.7 -> Sonnet 4.6 all failed on the same dead link.
    //
    // photo_paths is the permanent handle and is already aggregated above, so
    // re-sign from it and only fall back to a stored URL for a legacy row that
    // has no path. Anything that fails to sign is dropped rather than passed
    // on: a missing photo costs detail, a dead URL costs the entire quote.
    if (photoPaths.length > 0) {
      const freshlySigned: string[] = []
      for (const path of photoPaths) {
        const { data, error } = await supabase
          .storage
          .from('intake-photos')
          .createSignedUrl(path, 60 * 60) // one hour outlives any structuring run
        if (error || !data?.signedUrl) {
          log.err('could not re-sign intake photo — dropping it from vision', error?.message ?? 'no url', { path })
          continue
        }
        freshlySigned.push(data.signedUrl)
      }
      // Legacy rows that predate photo_paths keep their stored URL.
      const pathless = photoUrls.filter((u) => !u.includes('/intake-photos/'))
      photoUrls = Array.from(new Set([...freshlySigned, ...pathless]))
      log.ok('re-signed intake photos for vision', {
        paths: photoPaths.length,
        signed: freshlySigned.length,
        legacy_kept: pathless.length,
      })
    }

    // R9 — did the customer decline the photo ask? Same predicate the SMS
    // readiness gate uses, so the intake records exactly what let the quote
    // through without a photo.
    dialogPhotoDeclined = photoDeclined(
      (messages ?? []).map((m) => ({
        direction: (m.direction as 'inbound' | 'outbound') ?? 'inbound',
        body: String(m.body ?? ''),
      })) as Parameters<typeof photoDeclined>[0],
    )

    log.ok('SMS conversation stitched', {
      messages: messages?.length ?? 0,
      assumptions: (convo.assumptions_made as string[] | null)?.length ?? 0,
      transcript_chars: transcript.length,
      photos: photoUrls.length,
      photos_from_mms: mmsPhotoUrls.length,
      photos_from_upload_link: uploadedPhotoUrls.length,
    })
  } else {
    // ─────────────── VOICE PATH (unchanged) ───────────────
    callId = (body as { callId: string }).callId
    log.step('loading transcript from calls')

    const { data: call } = await supabase.from('calls').select('*').eq('id', callId).single()
    if (!call) {
      log.err('call not found in DB', null, { callId })
      return Response.json({ error: 'call not found' }, { status: 404 })
    }
    log.ok('transcript loaded', {
      chars: call.transcript?.length ?? 0,
      photo_count: (call.photo_urls ?? []).length,
    })

    transcript = call.transcript ?? ''
    photoUrls = call.photo_urls ?? []
    photoPaths = Array.isArray(call.photo_paths) ? (call.photo_paths as string[]) : []
    callerNumber = call.caller_number ?? null
    photoRequestToken = call.photo_request_token ?? null
    photoRequestAlreadySent = !!call.photo_request_sent_at
    tenantId = (call.tenant_id as string | null) ?? null
    updateSmsDeliveryContext({ tenantId, conversationId: null })
    await attributeSmsWorkTenant(tenantId)
  }

  const INTAKE_MODEL_CASCADE = [
    { id: 'claude-opus-4-8',   label: 'Opus 4.8'   },
    { id: 'claude-opus-4-7',   label: 'Opus 4.7'   },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  ] as const
  let intakeModelIdx = 0

  log.step(`running intake — model cascade: ${INTAKE_MODEL_CASCADE.map(m => m.label).join(' → ')}, up to ${INTAKE_MODEL_CASCADE.length} attempts`, { tradeHint })
  const intake = await smsWorkCheckpoint('structured_intake', () => withRetry(
    () => {
      const m = INTAKE_MODEL_CASCADE[Math.min(intakeModelIdx++, INTAKE_MODEL_CASCADE.length - 1)]
      return structureIntake(transcript, photoUrls, tradeHint, m.id)
    },
    {
      maxAttempts: INTAKE_MODEL_CASCADE.length,
      baseDelayMs: 2000,
      onAttemptFailed: (err, attempt, willRetry) => {
        const msg = err instanceof Error ? err.message : String(err)
        const used = INTAKE_MODEL_CASCADE[Math.min(attempt - 1, INTAKE_MODEL_CASCADE.length - 1)]
        const next = INTAKE_MODEL_CASCADE[Math.min(attempt, INTAKE_MODEL_CASCADE.length - 1)]
        if (willRetry) {
          log.err(`${used.label} intake attempt ${attempt}/${INTAKE_MODEL_CASCADE.length} failed — retrying with ${next.label}`, msg)
        } else {
          log.err(`${used.label} intake attempt ${attempt}/${INTAKE_MODEL_CASCADE.length} failed — giving up`, msg)
        }
      },
    }
  ))
  log.ok('Opus structured intake', {
    trade: intake.trade,
    job_type: intake.job_type,
    confidence: intake.confidence,
    inspection_required: intake.inspection_required,
    risks: intake.risks?.length ?? 0,
  })

  // Spec ev-charger-location-photo R9 — record that the customer could not send
  // a photo, so the tradie sees WHY the estimate has none rather than assuming
  // the receptionist forgot to ask. Deterministic and SMS-only: the structurer
  // is never asked to infer it, and it is never set for a job that has photos.
  if (intake.job_type === 'ev_charger' && dialogPhotoDeclined && photoPaths.length === 0) {
    const scope = intake.scope as unknown as Record<string, unknown>
    const specs = (scope?.specs ?? {}) as Record<string, unknown>
    intake.scope = {
      ...(scope ?? {}),
      specs: { ...specs, photo_declined: true },
    } as unknown as typeof intake.scope
    log.ok('EV photo declined by customer — recorded on scope.specs (R9)')
  }

  // R6(c) — three-phase is a site-visit call, not a prompt suggestion.
  const phaseGated = enforceSmsThreePhaseInspection(intake, dialogRequestedPhase)
  if (phaseGated.inspection_required !== intake.inspection_required) {
    intake.inspection_required = true
    log.ok('three-phase answered explicitly — inspection required (deterministic)', {
      phase: dialogRequestedPhase,
    })
  }

  // R17 — reconcile the dialog's job_type against the structurer's. A genuine
  // conflict (both classified, and they disagree) means one mis-read the job;
  // rather than silently ground a quote against the WRONG assembly, downgrade
  // confidence to LOW so the quality gate fires a focused clarifying SMS.
  // Conservative + downgrade-only: never touches the agreeing/HIGH happy path.
  {
    const jt = reconcileJobType([
      { source: 'dialog', jobType: dialogJobType },
      { source: 'structure', jobType: intake.job_type },
    ])
    if (jt.agreement === 'conflict') {
      log.err(
        'job_type conflict — downgrading to LOW for a clarify (R17)',
        `dialog=${dialogJobType ?? 'none'} vs structure=${intake.job_type ?? 'none'}`,
      )
      intake.confidence = 'LOW'
      intake.confidence_reason =
        `${intake.confidence_reason ?? ''} [R17 job_type conflict: dialog=${dialogJobType} vs structure=${intake.job_type} - clarify before quoting]`.trim()
    }
  }

  log.step('embedding intake (1536-dim) for similarity search')
  const embedding = await embedIntake(intake)
  log.ok('embedding complete', { dims: embedding.length })

  // Customer-memory lookup. Fail-soft (returns null on DB error) so the
  // intake pipeline keeps working even if the customer table is unhappy.
  const customer = callerNumber
    ? await findOrCreateCustomer(callerNumber, sourceChannel, tenantId)
    : null
  if (customer) {
    log.ok('customer resolved', {
      customerId: customer.id,
      hasName: !!customer.first_name,
      hasSuburb: !!customer.suburb,
      totalQuotes: customer.total_quotes,
    })
  }

  // ─── Customer-memory BACKFILL ───────────────────────────────────────
  // Closes the loop on the dialog's conservative re-engagement design.
  //
  // When formatCustomerContext() injects the KNOWN CUSTOMER MEMORY block,
  // Haiku is instructed to skip the "what's your first name?" / "what
  // suburb?" questions silently if those fields are already known.
  // That means the conversation transcript NEVER contains the name or
  // suburb — Opus has no signal to extract them, so structureIntake()
  // returns intake.caller.name = null and intake.suburb = null with
  // confidence = LOW. The quality gate downstream then false-fires
  // 'empty' on a perfectly good intake and the customer gets the
  // "we didn't catch enough" SMS instead of a quote.
  //
  // Fix: when the customer record has a stable field that the intake
  // is missing, backfill it. We only fill BLANKS — if Opus extracted a
  // value (e.g. customer corrected the suburb mid-conversation), we
  // never overwrite it with the stale customer-record value.
  // Captured BEFORE any backfill so the stamp below reflects what this
  // conversation actually produced, not what memory added.
  const threadAddressAtStructure = (intake.address ?? '').trim()

  if (customer) {
    const backfilled: string[] = []
    const callerName = (intake.caller?.name ?? '').trim()
    if (!callerName) {
      const fromCustomer = (customer.full_name ?? customer.first_name ?? '').trim()
      if (fromCustomer) {
        intake.caller = { ...(intake.caller ?? {}), name: fromCustomer }
        backfilled.push(`caller.name=${fromCustomer}`)
      }
    }
    if (!(intake.suburb ?? '').trim() && customer.suburb) {
      intake.suburb = customer.suburb
      backfilled.push(`suburb=${customer.suburb}`)
    }
    // R5 (2026-09-02) — the remembered STREET address is NOT this job's
    // address. Suburb is a stable fact about a customer; a street address is a
    // fact about one job, and backfilling it silently put an address the
    // customer never typed into the quote, the SMS SCOPE line and the tradie's
    // run sheet. Live 2026-09-01: "652 London Rd, Chandler" — captured six
    // weeks earlier in a ROOFING thread — was printed as the site for an EV
    // charger enquiry whose customer had only ever texted the suburb.
    //
    // The address now comes from THIS thread or not at all. What memory knows
    // still travels, but labelled and tradie-only (scope.remembered_address),
    // so the tradie can confirm it on the phone instead of driving to it.
    if (!threadAddressAtStructure && customer.address) {
      backfilled.push(`remembered_address=${customer.address} (NOT used as the job address)`)
    }
    if (!(intake.caller?.email ?? '').trim() && customer.email) {
      intake.caller = { ...(intake.caller ?? {}), email: customer.email }
      backfilled.push(`caller.email=${customer.email}`)
    }
    if (backfilled.length) {
      log.ok('backfilled intake fields from customer record', { fields: backfilled })
    } else {
      // Negative confirmation: we DID look up the customer, but every
      // critical field was already populated by Opus from the transcript
      // (no backfill needed) OR the customer record itself is empty for
      // those fields (no backfill possible). Either way, audit trail.
      log.ok('no backfill applied', {
        reason: customer.first_name || customer.suburb || customer.address || customer.email
          ? 'transcript already had all stored fields'
          : 'customer record empty for stable fields',
      })
    }
  }

  // R5(a) — record where this job's address came from, ALWAYS. Stamped
  // server-side after structuring, so these stay OUT of IntakeSchema (its
  // optional-parameter budget is capped for Anthropic generateObject,
  // schema.ts:51-54) and the model never supplies either field.
  // Runs unconditionally: an intake with no customers row still deserves an
  // explicit 'none' rather than an undefined nobody can reason about.
  ;(intake as { scope: Record<string, unknown> }).scope = {
    ...(intake.scope ?? {}),
    ...resolveAddressProvenance(threadAddressAtStructure, customer?.address),
  }

  // ─── Optional legacy gas-HWS inspection override ────────────────────
  //
  // Legacy safety valve only. Default OFF because gas HWS rows are now
  // priced in the catalogue and should quote unless the intake itself
  // contains a true safety/access trigger.
  //
  // Bug #5 (2026-05-14 stress test): Opus's structurer non-deterministically
  // set `inspection_required = false` on gas hot-water replacements,
  // letting the estimator auto-quote 3 tiers. The locked v1 policy
  // (per docs/strategy.md + memory project_plumbing_routing_rules) is
  // that gas HWS ALWAYS routes to the $99 onsite scope by a licensed
  // gas fitter — AS/NZS 5601 requires verification of gas-line size,
  // flue clearances and compliance before any swap.
  //
  // We trust Opus on most fields, but for this one regulatory
  // boundary was hard-coded. It is now opt-in only via
  // FORCE_GAS_HWS_SITE_VISIT=1; normal gas HWS pricing is DB-grounded.
  if (
    process.env.FORCE_GAS_HWS_SITE_VISIT === '1' &&
    intake.job_type === 'hot_water' &&
    intake.inspection_required !== true
  ) {
    const haystack = [
      intake.scope?.description ?? '',
      Array.isArray(intake.risks) ? intake.risks.join(' ') : '',
    ].join(' ').toLowerCase()
    const gasKeywords = /\b(gas\s*(?:storage|continuous[-\s]?flow|hws|hot\s*water|fitter|line|supply)|natural\s*gas|lpg\s*(?:bottle|hws|hot\s*water)?|propane)\b/
    if (gasKeywords.test(haystack)) {
      log.ok('regulatory override — gas HWS forced to inspection per AS/NZS 5601', {
        original_inspection_required: intake.inspection_required,
        matched_keywords: (haystack.match(gasKeywords) ?? [])[0],
      })
      intake.inspection_required = true
      const existingRisks = Array.isArray(intake.risks) ? intake.risks : []
      if (!existingRisks.some((r: string) => /gas\s+fitter|licensed\s+gas/i.test(r))) {
        intake.risks = [
          ...existingRisks,
          'gas appliance work — licensed gas fitter required for AS/NZS 5601 compliance',
        ]
      }
      intake.confidence_reason = (intake.confidence_reason ?? '') +
        ' [Forced inspection: gas HWS replacement requires licensed gas fitter onsite per AS/NZS 5601.]'
    }
  }

  // Audit log — exact credentials about to be submitted to the intake row.
  // Lets you verify in production logs that customer details are bundled
  // with the request before insert, not just spliced in mid-pipeline.
  log.ok('credentials attached to intake — submitting to estimation engine', {
    customer_id: customer?.id ?? null,
    caller_name: intake.caller?.name ?? null,
    caller_email: intake.caller?.email ?? null,
    suburb: intake.suburb ?? null,
    address: intake.address ?? null,
    job_type: intake.job_type,
    confidence: intake.confidence,
    has_scope: !!(intake.scope?.description && intake.scope.description.length >= 10),
  })

  log.step('inserting intakes row', {
    photo_paths_count: photoPaths.length,
    trade: intake.trade,
    tenant_id: tenantId,
  })
  // WP9 — carry the structured pick on the intake (scope jsonb, no
  // migration) so the estimator can DETERMINISTICALLY force the chosen
  // product + its catalogue price + photo into the quote. Best-effort;
  // null when nothing chosen ⇒ scope unchanged.
  if (WP9_ENABLED && chosenProductForIntake) {
    // scope is jsonb (loosely read downstream by run.ts) — the extra
    // key is intentional; cast past the structured IntakeSchema type.
    intake.scope = {
      ...(intake.scope ?? {}),
      chosen_product: chosenProductForIntake,
    } as typeof intake.scope
  }

  const { data: intakeRow, error: insertErr } = await supabase.from('intakes').upsert({
    sms_source_key: conversationId ? `sms:${conversationId}` : `voice:${callId}`,
    call_id: callId,                  // null for SMS rows; that's OK
    customer_id: customer?.id ?? null,
    // v6 multi-tenant: stamp the tradie who owns the destination number
    // the customer contacted. Drives pricing_book scoping in
    // /api/estimate/draft AND the dashboard's quotes filter.
    tenant_id: tenantId,
    // v5 multi-trade: derived from job_type by structureIntake. Drives the
    // pricing_book row + prompt routing downstream in /api/estimate/draft.
    trade: intake.trade,
    job_type: intake.job_type,
    address: intake.address,
    suburb: intake.suburb,
    scope: intake.scope,
    access: intake.access,
    property: intake.property,
    risks: intake.risks,
    inspection_required: intake.inspection_required,
    caller: intake.caller,
    timing: intake.timing,
    confidence: intake.confidence,
    confidence_reason: intake.confidence_reason,
    embedding,
    // Permanent storage paths shared by voice + SMS — re-signed on demand
    // by the public quote page so customer photos render alongside the
    // tier cards. Signed URLs are not persisted (24h TTL).
    photo_paths: photoPaths,
  }, { onConflict: 'sms_source_key' }).select().single()

  if (insertErr || !intakeRow) {
    log.err('intakes insert failed', insertErr ?? null)
    return Response.json({ error: 'insert failed' }, { status: 500 })
  }
  log.ok('intakes row inserted', { intake_id: intakeRow.id })

  // Mobile push — a new lead now exists for this tenant. Deep-links to the
  // conversation the Chats tab lists (sms_conversations.id for SMS,
  // calls.id for voice — the same ids /api/tenant/chats returns). Deferred
  // via after() and never throws, so it can't touch the intake pipeline.
  // Legacy pre-v6 traffic has no tenant → nobody to notify.
  scheduleIntakeLeadPush({
    intakeId: intakeRow.id as string,
    tenantId,
    leadPushAlreadySent,
    conversationId,
    callId,
    callerName: intake.caller?.name,
    suburb: intake.suburb,
  })

  // Customer-memory write-back. Persists the freshly-extracted name,
  // suburb, address, email onto the customers row so the next inbound
  // from this phone number can skip those questions. Fail-soft — logs
  // and moves on if the update fails. No await of the underlying call
  // gates the rest of the pipeline.
  if (customer?.id) {
    try {
      await updateCustomerFromIntake({
        customerId: customer.id,
        tenantId,
        intake: {
          caller: intake.caller,
          address: intake.address,
          suburb: intake.suburb,
        },
      })
      log.ok('customer record updated from intake', { customerId: customer.id })
    } catch (e: unknown) {
      log.err('customer update threw', (e instanceof Error ? e.message : undefined) ?? e)
    }
  }

  // Link the intake back to the SMS conversation and mark it 'done' so a
  // future inbound creates a fresh conversation rather than reusing this one.
  //
  // NOTE: Photo state (photo_urls / photo_paths / photo_request_sent_at /
  // photos_completed_at) is NOT cleared here. We used to clear it to
  // prevent a "second-quote bleed" bug, but that broke the recovery flow:
  // when quality='empty' fires and we re-prompt the customer for a missing
  // field, the second pass through structureIntake re-aggregates photos
  // from sms_conversations.photo_urls — which we'd just wiped, so the
  // recovery quote drafted with no photos AND fired a duplicate photo
  // SMS (because !photoRequestAlreadySent was now true again).
  //
  // The photo clear is now deferred to the 'usable' branch below — only
  // performed when the quote is actually drafting. The original bleed-bug
  // protection still holds: by the time status='done', the next inbound
  // would either reuse this conversation (within 5 min done-grace, where
  // photos correctly carry over) or create a fresh one (after 5 min,
  // where the existing PHOTO_RESET_IDLE_MS check in inbound/route.ts
  // resets the photo state).
  if (sourceChannel === 'sms' && conversationId) {
    log.step('linking intake_id back to sms_conversations + status=done')
    const { error: linkErr } = await supabase
      .from('sms_conversations')
      .update({
        intake_id: intakeRow.id,
        status: 'structuring',
        quote_stage: 'intake_saved',
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
    if (linkErr) throw new Error(`Intake link failed: ${linkErr.message}`)
  }

  // Quality gate — decides whether downstream SMS dispatches and the
  // estimation engine should run at all.
  const quality = evaluateIntakeQuality(intake)
  log.ok('intake quality evaluated', {
    quality,
    confidence: intake.confidence,
    has_name: !!intake.caller?.name,
    has_scope: !!(intake.scope?.description && intake.scope.description.length >= 10),
    job_type: intake.job_type,
  })

  const callerFirstName = (intake.caller?.name ?? '').split(' ')[0] || undefined

  if (quality === 'empty') {
    // Empty intake — but we can do better than a generic "we didn't catch
    // enough" SMS. Identify EXACTLY which must-ask field is missing and
    // send a focused recovery question. Voice source still uses the
    // original callback-request template since the call is over.
    const missing: MissingIntakeField[] = []
    if (!intake.caller?.name) missing.push('name')
    if (!intake.suburb) missing.push('suburb')
    if (!intake.scope?.description || intake.scope.description.length < 10) missing.push('scope')
    if (intake.job_type === 'other') missing.push('job_type')

    // R28 — a per-job STRUCTURED-field gap (e.g. a count-based easy-5 job
    // that quality.ts downgraded to 'empty' purely because no count was
    // captured) produces NO universal-field entry above, so without this
    // the recovery path would fall through to the generic "describe the
    // work" wording → the customer re-describes the job → ask-loop. Fold
    // any structured-field gap reported by missingRequiredFields() into
    // the recovery set so buildIntakeRecoverySms asks the exact question
    // ("How many downlights are we doing?"). De-duplicated defensively.
    for (const field of missingRequiredFields({
      confidence: intake.confidence,
      caller: intake.caller,
      scope: intake.scope,
      job_type: intake.job_type,
    })) {
      if (!missing.includes(field)) missing.push(field)
    }

    // CRITICAL — reopen the conversation BEFORE we return the response and
    // before after() runs. The earlier link-back step (above) set status
    // to 'done', which means a fast customer reply to the recovery SMS
    // would land in the <60s INFLIGHT window and trigger the canned
    // "just finalising the quote" hold-on instead of continuing the
    // dialog. By flipping status back to 'open' synchronously, the next
    // inbound webhook sees an open conversation and processes the reply
    // through Haiku normally.
    if (sourceChannel === 'sms' && conversationId) {
      const { error: reopenErr } = await supabase
        .from('sms_conversations')
        .update({ status: 'open', updated_at: new Date().toISOString() })
        .eq('id', conversationId)
      if (reopenErr) {
        log.err('failed to reopen sms_conversation for recovery', reopenErr)
      } else {
        log.ok('sms conversation reopened for recovery flow', { conversationId, missing })
      }
    }

    after(async () => {
      const ds = pipelineLog('dispatch', logId)
      ds.step('intake gated as empty — dispatching recovery SMS', { missing })
      if (!callerNumber) {
        ds.err('no caller_number — cannot send recovery SMS', null, { intake_id: intakeRow.id })
        throw new Error('Empty intake recovery requires a customer number')
      }
      try {
        // SMS source: focused recovery question (the conversation has
        // already been reopened synchronously above, so the customer's
        // reply will be processed normally by the inbound webhook).
        //
        // Pass tradeHint so the job_type recovery prompt lists the
        // RIGHT options for this tradie's trade — plumbing customers
        // must NEVER see "downlights / GPOs / ceiling fans" as the
        // example options. tradeHint was set above from the SMS
        // conversation's stored job_type slot (lib/sms/extract-slots).
        const text = sourceChannel === 'sms'
          ? buildIntakeRecoverySms({
              firstName: callerFirstName,
              missing,
              trade: tradeHint,
              // R28 — drives the 'count' recovery question's noun so the
              // customer sees "how many downlights?" not a generic ask.
              jobType: intake.job_type,
            })
          : buildIncompleteCallSms({ firstName: callerFirstName, source: sourceChannel })

        // v6 multi-tenant: send the recovery SMS from the same tenant
        // number the customer texted OR CALLED, not a platform env number.
        // Without this the customer sees two different senders (live
        // incident 2026-07-23: voice caller got the incomplete-call SMS
        // from the env-default line). Lazy-load the tenant row only when
        // we know we're going to dispatch.
        let tenantSmsNumber: string | null = null
        if (tenantId) {
          const { data: t } = await supabase
            .from('tenants')
            .select('twilio_sms_number')
            .eq('id', tenantId)
            .maybeSingle()
          tenantSmsNumber = (t?.twilio_sms_number as string | null) ?? null
        }
        const fromNumber = resolveOutboundFromNumber({ tenantSmsNumber, sourceChannel })
        const result = await dispatchQuoteMessage({ to: callerNumber, text, from: fromNumber, tenantId,
          conversationId: sourceChannel === 'sms' ? conversationId : undefined,
          deliveryKey: `${currentSmsWork()!.jobId}:empty-intake-recovery` })
        if (!result.ok && !result.outboxId) throw new Error('Empty intake recovery SMS could not be queued')
        if (result.ok) {
          ds.ok('recovery SMS sent', { channel: result.channel, sid: result.sid, missing })
          // Persist the recovery SMS as an outbound message so the dialog
          // agent sees it in the conversation history on the next turn.
          // Without this, Haiku doesn't know we asked for the name/suburb.
          if (sourceChannel === 'sms' && conversationId && !result.outboxId) {
            await supabase.from('sms_messages').insert({
              conversation_id: conversationId,
              direction: 'outbound',
              body: result.channel === 'whatsapp' ? `[WhatsApp fallback] ${text}` : text,
              twilio_message_sid: result.sid,
            })
          }
        } else {
          ds.err('recovery SMS failed', null, {
            sms_code: result.smsAttempt.code,
            wa_code: result.waAttempt?.code,
          })
        }
      } catch (e) {
        ds.err('recovery SMS threw', e)
        throw e
      }
    })

    log.done('intake handler done — quality gate fired (recovery SMS dispatched)', {
      intake_id: intakeRow.id,
      gated_reason: 'empty_intake',
      missing,
      sourceChannel,
    })
    return Response.json({
      ok: true,
      intakeId: intakeRow.id,
      gated: 'empty_intake',
      missing,
    })
  }

  // Quality is 'usable' — quote is going to draft. NOW we can clear the
  // photo buffer on the conversation row, since:
  //   1. The photos are snapshotted onto intakes.photo_paths (the public
  //      quote view re-signs from there).
  //   2. The quote is drafting, so the customer has reached the end of
  //      this request — any subsequent inbound for a NEW request should
  //      start with a clean photo state to prevent "second-quote bleed".
  // This is the original protection the link-back used to do; we just
  // moved it here so the recovery flow above can preserve photo state
  // across its second pass.
  if (sourceChannel === 'sms' && conversationId) {
    const { error: clearErr } = await supabase
      .from('sms_conversations')
      .update({
        photo_urls: [],
        photo_paths: [],
        photo_request_sent_at: null,
        photos_completed_at: null,
      })
      .eq('id', conversationId)
    if (clearErr) log.err('photo buffer clear failed', clearErr)
    else log.ok('photo buffer cleared (quote drafting)')
  }

  // Fire the photo-request SMS (voice only) AND dispatch estimate. Both
  // run in after() so the response goes back to the caller (webhook)
  // immediately and the work survives the function lifetime.
  after(async () => {
    // Tenant's own number for every send in this block (live incident
    // 2026-07-23: voice-path sends defaulted to the platform env number).
    let blockTenantSmsNumber: string | null = null
    if (tenantId) {
      const { data: t } = await supabase
        .from('tenants')
        .select('twilio_sms_number')
        .eq('id', tenantId)
        .maybeSingle()
      blockTenantSmsNumber = (t?.twilio_sms_number as string | null) ?? null
    }
    const blockFromNumber = resolveOutboundFromNumber({
      tenantSmsNumber: blockTenantSmsNumber,
      sourceChannel,
    })

    // Photo-request SMS only fires on the voice path. The SMS path has the
    // customer already in a text thread; a separate photo-request SMS would
    // be duplicative. (Phase 4 adds inbound MMS so customers can attach
    // photos to the existing thread instead.)
    if (sourceChannel === 'voice') {
      const photoLog = pipelineLog('dispatch', logId)
      photoLog.step('dispatching photo-request SMS')
      if (photoRequestAlreadySent) {
        photoLog.ok('photo SMS already sent in-call by send_sms_photo_link tool — skipping post-call dispatch', { call_id: callId })
      } else if (!callerNumber) {
        photoLog.err('no caller_number — skipping photo SMS', null, { call_id: callId })
      } else if (!photoRequestToken) {
        photoLog.err('no photo_request_token on call — skipping photo SMS', null, { call_id: callId })
      } else {
        try {
          const uploadUrl = `${process.env.APP_URL}/upload/${photoRequestToken}`
          const text = buildPhotoRequestSms({ firstName: callerFirstName, uploadUrl, source: 'voice' })
          const result = await dispatchQuoteMessage({ to: callerNumber, text, from: blockFromNumber })
          if (result.ok) {
            photoLog.ok('photo-request SMS sent', { channel: result.channel, sid: result.sid })
          } else {
            photoLog.err('photo-request SMS failed', null, {
              sms_code: result.smsAttempt.code,
              wa_code: result.waAttempt?.code,
            })
          }
        } catch (e) {
          photoLog.err('photo-request SMS threw', e)
        }
      }
    }

    await enqueueEstimateWork(intakeRow.id, tenantId)
    if (conversationId) {
      const { error } = await supabase.from('sms_conversations').update({ quote_stage: 'estimate_pending', status: 'structuring' }).eq('id', conversationId)
      if (error) throw new Error(`Estimate stage update failed: ${error.message}`)
    }
  })

  log.done('intake handler done', { intake_id: intakeRow.id, sourceChannel })
  return Response.json({ ok: true, intakeId: intakeRow.id })
}
