import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { structureIntake } from '@/lib/intake/structure'
import { deriveTradeFromJobType } from '@/lib/intake/schema'
import { embedIntake } from '@/lib/intake/embed'
import { evaluateIntakeQuality } from '@/lib/intake/quality'
import { pipelineLog } from '@/lib/log/pipeline'
import { withRetry } from '@/lib/util/retry'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { buildIncompleteCallSms, buildIntakeRecoverySms, buildPhotoRequestSms, buildQuoteFailureSms } from '@/lib/sms/templates'
import { findOrCreateCustomer, updateCustomerFromIntake } from '@/lib/customers/lookup'

export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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
  const body = (await req.json()) as Body

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
  let photoRequestToken: string | null = null
  // v6 multi-tenant: stamp the intake (and downstream quote) with the
  // tenant who owns the destination number the customer contacted.
  // Comes from sms_conversations.tenant_id (SMS path) or calls.tenant_id
  // (voice path). Null for legacy pre-v6 traffic that hit the pilot
  // single-pricing-book pipeline — that branch keeps working since
  // /api/estimate/draft falls back when tenant_id is null.
  let tenantId: string | null = null

  if (sourceChannel === 'sms') {
    // ─────────────── SMS PATH ───────────────
    conversationId = (body as { conversationId: string }).conversationId
    log.step('loading sms_conversation + messages', { conversationId })

    const { data: convo } = await supabase
      .from('sms_conversations')
      .select('*')
      .eq('id', conversationId)
      .single()
    if (!convo) {
      log.err('sms conversation not found in DB', null, { conversationId })
      return Response.json({ error: 'sms conversation not found' }, { status: 404 })
    }

    const { data: messages } = await supabase
      .from('sms_messages')
      .select('direction, body, created_at, photo_urls, photo_paths')
      .eq('conversation_id', conversationId)
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

    callerNumber = convo.from_number ?? null
    photoRequestToken = (convo.photo_request_token as string | null) ?? null
    photoRequestAlreadySent = !!convo.photo_request_sent_at
    tenantId = (convo.tenant_id as string | null) ?? null

    // v5: derive tradeHint from the SMS dialog's already-classified job_type.
    // The extractor classifies plumbing job_types per v5; passing the hint
    // forward grounds Opus in the right trade before structuring the intake.
    const slotJobType = (convo.conversation_state as { slots?: { job_type?: string } } | null)?.slots?.job_type
    if (slotJobType) {
      tradeHint = deriveTradeFromJobType(slotJobType)
    }

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
  }

  log.step('running Opus vision (Claude 4.7) — typically ~35s, up to 3 attempts', { tradeHint })
  const intake = await withRetry(
    () => structureIntake(transcript, photoUrls, tradeHint),
    {
      maxAttempts: 3,
      baseDelayMs: 2000,
      onAttemptFailed: (err, attempt, willRetry) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (willRetry) {
          log.err(`Opus intake attempt ${attempt}/3 failed — retrying`, msg)
        } else {
          log.err(`Opus intake attempt ${attempt}/3 failed — giving up`, msg)
        }
      },
    }
  )
  log.ok('Opus structured intake', {
    trade: intake.trade,
    job_type: intake.job_type,
    confidence: intake.confidence,
    inspection_required: intake.inspection_required,
    risks: intake.risks?.length ?? 0,
  })

  log.step('embedding intake (1536-dim) for similarity search')
  const embedding = await embedIntake(intake)
  log.ok('embedding complete', { dims: embedding.length })

  // Customer-memory lookup. Fail-soft (returns null on DB error) so the
  // intake pipeline keeps working even if the customer table is unhappy.
  const customer = callerNumber
    ? await findOrCreateCustomer(callerNumber, sourceChannel)
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
    if (!(intake.address ?? '').trim() && customer.address) {
      intake.address = customer.address
      backfilled.push(`address=${customer.address}`)
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

  // ─── Regulatory override: gas HWS must be inspection-routed ─────────
  //
  // Bug #5 (2026-05-14 stress test): Opus's structurer non-deterministically
  // set `inspection_required = false` on gas hot-water replacements,
  // letting the estimator auto-quote 3 tiers. The locked v1 policy
  // (per docs/strategy.md + memory project_plumbing_routing_rules) is
  // that gas HWS ALWAYS routes to the $199 onsite scope by a licensed
  // gas fitter — AS/NZS 5601 requires verification of gas-line size,
  // flue clearances and compliance before any swap.
  //
  // We trust Opus on most fields, but for this one regulatory
  // boundary the override is hard-coded. Same pattern as Rule 6 in
  // plumbing-prompt.ts which always-inspections gas_fitting / burst_pipe
  // / bathroom_renovation, but those are job_types in their own right;
  // gas HWS is detected via the scope text on a hot_water intake.
  if (intake.job_type === 'hot_water' && intake.inspection_required !== true) {
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
  const { data: intakeRow, error: insertErr } = await supabase.from('intakes').insert({
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
  }).select().single()

  if (insertErr || !intakeRow) {
    log.err('intakes insert failed', insertErr ?? null)
    return Response.json({ error: 'insert failed' }, { status: 500 })
  }
  log.ok('intakes row inserted', { intake_id: intakeRow.id })

  // Customer-memory write-back. Persists the freshly-extracted name,
  // suburb, address, email onto the customers row so the next inbound
  // from this phone number can skip those questions. Fail-soft — logs
  // and moves on if the update fails. No await of the underlying call
  // gates the rest of the pipeline.
  if (customer?.id) {
    try {
      await updateCustomerFromIntake({
        customerId: customer.id,
        intake: {
          caller: intake.caller,
          address: intake.address,
          suburb: intake.suburb,
        },
      })
      log.ok('customer record updated from intake', { customerId: customer.id })
    } catch (e: any) {
      log.err('customer update threw', e?.message ?? e)
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
        status: 'done',
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
    if (linkErr) log.err('sms_conversations update failed', linkErr)
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
    // enough" SMS. Identify EXACTLY which universal must-ask field is
    // missing and send a focused recovery question. Voice source still
    // uses the original callback-request template since the call is over.
    const missing: ('name' | 'suburb' | 'scope' | 'job_type')[] = []
    if (!intake.caller?.name) missing.push('name')
    if (!intake.suburb) missing.push('suburb')
    if (!intake.scope?.description || intake.scope.description.length < 10) missing.push('scope')
    if (intake.job_type === 'other') missing.push('job_type')

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
        return
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
            })
          : buildIncompleteCallSms({ firstName: callerFirstName, source: sourceChannel })

        // v6 multi-tenant: send the recovery SMS from the same tenant
        // number the customer texted, NOT the shared dev TWILIO_SMS_NUMBER.
        // Without this the customer sees two different senders in their
        // SMS thread (the dialog from Number A, the recovery prompt from
        // Number B), which breaks the illusion of a single conversation
        // with the tradie. Lazy-load the tenant row only when we know
        // we're going to dispatch.
        let tenantSmsNumber: string | null = null
        if (sourceChannel === 'sms' && tenantId) {
          const { data: t } = await supabase
            .from('tenants')
            .select('twilio_sms_number')
            .eq('id', tenantId)
            .maybeSingle()
          tenantSmsNumber = (t?.twilio_sms_number as string | null) ?? null
        }
        const fromNumber =
          sourceChannel === 'sms'
            ? (tenantSmsNumber ?? process.env.TWILIO_SMS_NUMBER)
            : undefined
        const result = await dispatchQuoteMessage({ to: callerNumber, text, from: fromNumber })
        if (result.ok) {
          ds.ok('recovery SMS sent', { channel: result.channel, sid: result.sid, missing })
          // Persist the recovery SMS as an outbound message so the dialog
          // agent sees it in the conversation history on the next turn.
          // Without this, Haiku doesn't know we asked for the name/suburb.
          if (sourceChannel === 'sms' && conversationId) {
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
          const result = await dispatchQuoteMessage({ to: callerNumber, text })
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

    // Dispatch to /api/estimate/draft (shared for voice + SMS).
    // Wrapped in withRetry — final hop in the chain. If this drops,
    // the intake row exists but no quote is ever produced. 3 attempts,
    // 2s/4s backoff. Inside after() so non-blocking on webhook ack.
    const dispatch = pipelineLog('intake', logId)
    dispatch.step('dispatching to /api/estimate/draft (with retry)', { intake_id: intakeRow.id })
    try {
      await withRetry(
        async () => {
          const res = await fetch(`${process.env.APP_URL}/api/estimate/draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ intakeId: intakeRow.id }),
          })
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
          }
          return res
        },
        {
          maxAttempts: 3,
          baseDelayMs: 2000,
          onAttemptFailed: (err, attempt, willRetry) => {
            const msg = err instanceof Error ? err.message : String(err)
            const tag = willRetry ? 'retrying' : 'EXHAUSTED'
            dispatch.err(`estimate handoff attempt ${attempt}/3 — ${tag}`, msg.slice(0, 200))
          },
        }
      )
      dispatch.ok('estimate/draft dispatched')
    } catch (e: any) {
      dispatch.err('estimate handoff EXHAUSTED — sending failure SMS', e?.message ?? String(e), { intake_id: intakeRow.id })
      // NEVER leave the customer silent. Send a fallback SMS so they
      // know to expect a callback. Both voice and SMS paths converge
      // here; callerNumber works for either (set above when loading
      // the source row).
      try {
        if (!callerNumber) {
          dispatch.err('cannot send failure SMS — no caller_number / from_number', null, { intake_id: intakeRow.id })
        } else {
          const failureBody = buildQuoteFailureSms({ firstName: callerFirstName })
          const failureDispatch = await dispatchQuoteMessage({ to: callerNumber, text: failureBody })
          if (failureDispatch.ok) {
            dispatch.ok('failure SMS dispatched', {
              channel: failureDispatch.channel,
              sid: failureDispatch.sid,
            })
          } else {
            dispatch.err('failure SMS FAILED on both channels', null, {
              sms_code: failureDispatch.smsAttempt.code,
              wa_code: failureDispatch.waAttempt?.code,
            })
          }
        }
      } catch (notifyErr) {
        dispatch.err('failure SMS itself threw', notifyErr, { intake_id: intakeRow.id })
      }
    }
  })

  log.done('intake handler done', { intake_id: intakeRow.id, sourceChannel })
  return Response.json({ ok: true, intakeId: intakeRow.id })
}
