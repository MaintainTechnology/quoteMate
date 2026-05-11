import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { runEstimation } from '@/lib/estimate/run'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { sendWhatsApp } from '@/lib/sms/twilio'
import {
  buildQuoteSms,
  buildTradieDraftNotification,
  buildTradieInspectionNotification,
} from '@/lib/sms/templates'
import { pipelineLog } from '@/lib/log/pipeline'
import { createCheckoutSessionsForQuote, createInspectionCheckoutSession, generateShareToken } from '@/lib/stripe/checkout'
import { withRetry } from '@/lib/util/retry'
import { decideRouting } from '@/lib/routing/decide'
import { generatePreviewImage } from '@/lib/preview/generate'
import { generateSampleImages } from '@/lib/preview/samples'

export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: Request) {
  const { intakeId } = await req.json()
  const log = pipelineLog('estimate')
  log.step('received', { intakeId })

  try {
    log.step('loading intake, pricing_book, caller_number')
    const { data: intake } = await supabase.from('intakes').select('*').eq('id', intakeId).single()

    // v5 multi-trade: pick the pricing_book row matching intake.trade.
    // Legacy intake rows pre-dating v5 have no trade field — fall back to
    // 'electrical' for them (the existing NSW/NECA pilot tenant).
    const intakeTrade = (intake?.trade as 'electrical' | 'plumbing' | undefined) ?? 'electrical'
    const { data: pricingBook } = await supabase
      .from('pricing_book')
      .select('*')
      .eq('trade', intakeTrade)
      .single()
    if (!pricingBook) {
      log.err('no pricing_book row for trade — aborting', null, { trade: intakeTrade })
      return Response.json({ ok: false, error: `No pricing_book row for trade=${intakeTrade}` }, { status: 500 })
    }

    // Channel-aware customer lookup. Voice path: intake.call_id is set -> read
    // calls.caller_number. SMS path: intake.call_id is null -> look up the
    // sms_conversations row that points at this intake to recover the
    // customer's mobile number AND mark this quote as SMS-sourced (drives the
    // Phase 4 tradie-notify gate further down).
    const isSmsSource = intake.call_id == null
    let call: { caller_number: string | null } | null = null
    let smsConversationId: string | null = null

    if (isSmsSource) {
      const { data: convo } = await supabase
        .from('sms_conversations')
        .select('id, from_number')
        .eq('intake_id', intakeId)
        .maybeSingle()
      if (convo) {
        smsConversationId = convo.id
        call = { caller_number: convo.from_number ?? null }
      }
    } else {
      const { data: callRow } = await supabase
        .from('calls')
        .select('caller_number')
        .eq('id', intake.call_id)
        .single()
      call = callRow ?? null
    }

    log.ok('inputs loaded', {
      source: isSmsSource ? 'sms' : 'voice',
      trade: intakeTrade,
      job_type: intake.job_type,
      confidence: intake.confidence,
      caller_number: call?.caller_number ? 'set' : 'null',
      hourly_rate: pricingBook.hourly_rate,
      sms_conversation_id: smsConversationId ?? 'n/a',
    })

    log.step('running Opus (Claude 4.7) — typically ~40s, up to 3 attempts')
    const estimation = await withRetry(
      () => runEstimation(intake, pricingBook),
      {
        maxAttempts: 3,
        baseDelayMs: 2000,
        onAttemptFailed: (err, attempt, willRetry) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (willRetry) {
            log.err(`Opus attempt ${attempt}/3 failed — retrying`, msg)
          } else {
            log.err(`Opus attempt ${attempt}/3 failed — giving up`, msg)
          }
        },
      }
    )
    const draft = estimation.draft

    // Surface grounding failures clearly in the Vercel logs.
    if (estimation.downgradedToInspection) {
      const failureCount = estimation.groundingFailures?.length ?? 0
      const firstFailure = estimation.groundingFailures?.[0]
      log.err('grounding check failed — downgrading quote to inspection-required', null, {
        total_failures: failureCount,
        first_failure_tier: firstFailure?.tier ?? 'n/a',
        first_failure_description: firstFailure?.description ?? 'n/a',
        first_failure_unit: firstFailure?.unit ?? 'n/a',
        first_failure_price: firstFailure?.unit_price_ex_gst ?? 'n/a',
        first_failure_expected: firstFailure?.expected ?? 'n/a',
      })
    }
    const tierCount = [draft.good, draft.better, draft.best].filter(Boolean).length
    log.ok('Opus parsed', {
      tiers: tierCount,
      better_total_ex_gst: draft.better?.subtotal_ex_gst ?? 'null',
      scope_short: draft.scope_short ? `"${draft.scope_short}"` : 'absent',
      needs_inspection: draft.needs_inspection ?? false,
    })

    // Two pricing paths — totals diverge based on the inspection branch.
    //   AUTO-QUOTE: total = selected (better) tier inc GST, deposit_pct from
    //               pricing_book, real DB-grounded numbers throughout.
    //   INSPECTION: total = $199 inc GST (the only chargeable amount); all
    //               three tiers FORCED to null, even if Opus tried to hand
    //               us indicative numbers (defence-in-depth against
    //               LLM hallucination — STRICT GROUNDING #10).
    const INSPECTION_TOTAL_INC_GST = 199
    const INSPECTION_GST_AMOUNT = +(INSPECTION_TOTAL_INC_GST / 11).toFixed(2)
    const INSPECTION_SUBTOTAL_EX_GST = +(INSPECTION_TOTAL_INC_GST - INSPECTION_GST_AMOUNT).toFixed(2)

    const isInspection = draft.needs_inspection === true

    let goodTier: typeof draft.good   | null = null
    let betterTier: typeof draft.better | null = null
    let bestTier: typeof draft.best   | null = null
    let selectedTier: 'good' | 'better' | 'best' | 'inspection' | null
    let selectedSubtotal: number
    let gst: number
    let total: number

    if (isInspection) {
      // Force null tiers regardless of what Opus emitted — pricing comes
      // only after the on-site visit.
      goodTier = null
      betterTier = null
      bestTier = null
      selectedTier = 'inspection'
      selectedSubtotal = INSPECTION_SUBTOTAL_EX_GST
      gst = INSPECTION_GST_AMOUNT
      total = INSPECTION_TOTAL_INC_GST
      if (draft.good || draft.better || draft.best) {
        log.err('Opus emitted indicative tier numbers on inspection-required quote — discarding per STRICT GROUNDING #10', null, {
          had_good:   !!draft.good,
          had_better: !!draft.better,
          had_best:   !!draft.best,
        })
      }
    } else {
      // Default selected tier for the customer portal is "better".
      // Falls through to "good" if better is missing (e.g. fault_finding has no best).
      goodTier = draft.good ?? null
      betterTier = draft.better ?? null
      bestTier = draft.best ?? null
      const defaultTier = draft.better ?? draft.good
      selectedTier = 'better'
      selectedSubtotal = defaultTier?.subtotal_ex_gst ?? 0
      gst = pricingBook.gst_registered ? +(selectedSubtotal * 0.10).toFixed(2) : 0
      total = +(selectedSubtotal + gst).toFixed(2)
    }

    const routing_decision = decideRouting({
      intake: {
        confidence: intake.confidence,
        inspection_required: intake.inspection_required ?? false,
      },
      quote: { needs_inspection: isInspection },
    })
    log.ok('routing decided', { routing_decision })

    log.step('inserting quotes row')
    const shareToken = generateShareToken()
    const { data: quote } = await supabase.from('quotes').insert({
      intake_id: intakeId,
      status: 'draft',
      scope_of_works:      draft.scope_of_works,
      assumptions:         draft.assumptions      ?? [],
      risk_flags:          draft.risk_flags       ?? [],
      good:                goodTier,
      better:              betterTier,
      best:                bestTier,
      optional_upsells:    draft.optional_upsells ?? [],
      estimated_timeframe: draft.estimated_timeframe,
      needs_inspection:    isInspection,
      inspection_reason:   draft.inspection_reason,
      gst_note:            draft.gst_note,
      selected_tier:       selectedTier,
      subtotal_ex_gst:     selectedSubtotal,
      gst,
      total_inc_gst:       total,
      share_token:         shareToken,
      routing_decision,
    }).select().single()
    log.ok('quote inserted', { quote_id: quote!.id, total_inc_gst: total, routing: routing_decision, inspection: isInspection, share_token: shareToken.slice(0, 8) + '…' })

    // Create Stripe Checkout Session(s). Two distinct paths:
    //   • auto-quote → 3 Sessions (one per tier, deposit only)
    //   • inspection-required → 1 Session for the $199 site-visit fee
    // If creation fails for any reason we log + continue without links — the
    // quote is still saved; SMS will go without pay buttons rather than failing.
    let payLinks: Partial<Record<'good' | 'better' | 'best' | 'inspection', string>> | undefined
    let depositPct: number | null = null
    const appUrl = process.env.APP_URL!

    if (!draft.needs_inspection) {
      log.step('creating Stripe Checkout Sessions (one per tier, deposit only)')
      try {
        const stripeLinks = await createCheckoutSessionsForQuote({
          quote: { id: quote!.id, good: draft.good ?? null, better: draft.better ?? null, best: draft.best ?? null, deposit_pct: 30 },
          intake,
          shareToken,
          appUrl,
        })

        await supabase.from('quotes').update({ stripe_links: stripeLinks }).eq('id', quote!.id)
        depositPct = 30

        payLinks = {
          good:   stripeLinks.good   ? `${appUrl}/r/${shareToken}/good`   : undefined,
          better: stripeLinks.better ? `${appUrl}/r/${shareToken}/better` : undefined,
          best:   stripeLinks.best   ? `${appUrl}/r/${shareToken}/best`   : undefined,
        }

        log.ok('Stripe sessions created (auto-quote)', {
          tiers_with_links: Object.values(payLinks).filter(Boolean).length,
        })
      } catch (e: any) {
        log.err('Stripe session creation failed — SMS will go without pay links', e?.message ?? e)
      }
    } else {
      log.step('creating Stripe Checkout Session for $199 site-visit deposit (inspection-required path)')
      try {
        const inspectionUrl = await createInspectionCheckoutSession({
          quoteId: quote!.id,
          intake,
          shareToken,
          appUrl,
        })

        if (inspectionUrl) {
          await supabase.from('quotes').update({ stripe_links: { inspection: inspectionUrl } }).eq('id', quote!.id)
          payLinks = {
            inspection: `${appUrl}/r/${shareToken}/inspection`,
          }
          log.ok('Stripe inspection-fee Session created', { inspection_link_set: true })
        } else {
          log.err('Stripe inspection Session returned no URL — SMS will mention the fee without a link')
        }
      } catch (e: any) {
        log.err('Stripe inspection-fee creation failed — SMS will mention the fee without a link', e?.message ?? e)
      }
    }

    // ─── AI preview trigger 3 (estimate draft completion) ───
    // Quote row exists; if photos already on file the preview can begin
    // generating in parallel with SMS dispatch. Customer's first photo
    // is the reference — Gemini edits THAT image. Idempotent: if photo
    // upload already kicked it off (trigger 1), the CAS in
    // generatePreviewImage() skips this call.
    after(async () => {
      const previewLog = pipelineLog('dispatch', `preview:${quote!.id.slice(0, 8)}`)
      try {
        const photoPaths = (Array.isArray(intake.photo_paths) ? intake.photo_paths : []) as string[]
        previewLog.step('preview + samples trigger 3 — kicking off Gemini in parallel', {
          quote_id: quote!.id,
          intake_id: intake.id,
          photo_count: photoPaths.length,
        })

        // Sample gallery doesn't need customer photos — fires regardless.
        // Main preview only fires if we have at least one photo on the
        // intake (photo-upload trigger 1 will catch it later otherwise).
        const previewPromise = photoPaths.length > 0
          ? generatePreviewImage(quote!.id as string)
          : Promise.resolve({ status: 'skipped' as const, reason: 'no photos yet on intake' })

        const samplesPromise = generateSampleImages(quote!.id as string)

        const [previewResult, samplesResult] = await Promise.all([previewPromise, samplesPromise])
        previewLog.ok('preview trigger 3 result', { status: previewResult.status })
        previewLog.ok('samples trigger 3 result', { status: samplesResult.status })
      } catch (e: any) {
        previewLog.err('preview/samples trigger 3 threw', e?.message ?? String(e))
      }
    })

    // Auto-send the quote to the caller via SMS (Path B per current product mode).
    // Skip if no caller_number available. Errors are logged but never fail the route.
    const callerNumber = call?.caller_number ?? null
    log.step(callerNumber ? 'queueing SMS dispatch' : 'skipping SMS — no caller_number')

    after(async () => {
      const dispatch = pipelineLog('dispatch', intake.call_id)
      if (!callerNumber) {
        dispatch.err('skipped', null, { quote_id: quote!.id, reason: 'no caller_number on call row' })
        return
      }
      try {
        dispatch.step('building quote message body')
        const quoteForSms = {
          ...quote!,
          scope_short: draft.scope_short ?? null,
          pay_links: payLinks,
          deposit_pct: depositPct,
          needs_inspection: draft.needs_inspection ?? false,
          inspection_reason: draft.inspection_reason ?? null,
          quote_view_url: `${appUrl}/q/${shareToken}`,
        }
        const body = buildQuoteSms(intake, quoteForSms)
        const segs = body.length <= 160 ? 1 : Math.ceil(body.length / 153)
        dispatch.ok('body built', { chars: body.length, sms_segments: segs })

        // Origin number policy:
        //   • SMS-sourced quote → reply from TWILIO_SMS_NUMBER so the customer
        //     sees ONE continuous thread (dialog turns + final quote in the
        //     same conversation on their phone).
        //   • Voice-sourced quote → fall through to dispatchQuoteMessage's
        //     default (TWILIO_PHONE_NUMBER, the voice line) — preserves prior
        //     behaviour exactly.
        const fromNumber = isSmsSource ? process.env.TWILIO_SMS_NUMBER : undefined
        dispatch.step('attempting SMS first (WhatsApp fallback if SMS rejects)', {
          to: callerNumber,
          from: fromNumber ?? '(default TWILIO_PHONE_NUMBER)',
        })
        const result = await dispatchQuoteMessage({ to: callerNumber, text: body, from: fromNumber })

        if (result.ok) {
          if (result.channel === 'sms') {
            dispatch.ok('SMS delivered', { sid: result.sid, status: result.status })
          } else {
            dispatch.ok('SMS rejected, WhatsApp delivered as fallback', {
              sid: result.sid,
              status: result.status,
              sms_failure_code: result.smsAttempt?.code,
              sms_failure_reason: result.smsAttempt?.reason,
            })
          }
          dispatch.done('quote dispatched to caller', { quote_id: quote!.id, channel: result.channel })
        } else {
          dispatch.err('both SMS and WhatsApp failed', null, {
            sms_code: result.smsAttempt.code,
            sms_reason: result.smsAttempt.reason,
            wa_code: result.waAttempt?.code,
            wa_reason: result.waAttempt?.reason,
          })
        }
      } catch (e) {
        dispatch.err('dispatch threw', e)
      }

      // ──────────────── Phase 4 / notify ────────────────
      // SMS-only tradie ping. Voice quotes intentionally skip this so the
      // voice path's behaviour stays exactly as it was before Phase 4.
      // Sends BOTH:
      //   • SMS+WhatsApp-fallback to TRADIE_NOTIFY_NUMBER (mobile)
      //   • a standalone WhatsApp to TRADIE_NOTIFY_WHATSAPP (the tradie's
      //     joined-sandbox or registered-WABA WhatsApp identity)
      // Errors are logged but never block.
      if (!isSmsSource) {
        return
      }

      const notifyMobile = process.env.TRADIE_NOTIFY_NUMBER
      const notifyWhatsApp = process.env.TRADIE_NOTIFY_WHATSAPP
      if (!notifyMobile && !notifyWhatsApp) {
        dispatch.ok('tradie notify skipped — no TRADIE_NOTIFY_NUMBER / TRADIE_NOTIFY_WHATSAPP env')
        return
      }

      try {
        const customerName = intake.caller?.name ?? undefined
        const customerPhone = callerNumber ?? undefined
        const quoteUrl = `${appUrl}/q/${shareToken}`
        const tradieBody = isInspection
          ? buildTradieInspectionNotification({
              customerName,
              customerPhone,
              jobType: intake.job_type,
              inspectionReason: draft.inspection_reason ?? null,
              quoteUrl,
            })
          : buildTradieDraftNotification({
              customerName,
              customerPhone,
              jobType: intake.job_type,
              itemCount: intake.scope?.item_count ?? undefined,
              totalIncGst: total,
              quoteUrl,
            })

        if (notifyMobile) {
          dispatch.step('tradie notify — SMS (with WhatsApp fallback)', { to: notifyMobile })
          const r = await dispatchQuoteMessage({ to: notifyMobile, text: tradieBody })
          if (r.ok) {
            dispatch.ok('tradie SMS notify sent', { channel: r.channel, sid: r.sid })
          } else {
            dispatch.err('tradie SMS notify failed (both SMS + WA)', null, {
              sms_code: r.smsAttempt.code,
              wa_code: r.waAttempt?.code,
            })
          }
        }

        if (notifyWhatsApp) {
          dispatch.step('tradie notify — explicit WhatsApp', { to: notifyWhatsApp })
          const r = await sendWhatsApp({ to: notifyWhatsApp, text: tradieBody })
          if (r.ok) {
            dispatch.ok('tradie WhatsApp notify sent', { sid: r.sid, status: r.status })
          } else {
            dispatch.err('tradie WhatsApp notify failed', null, { code: r.code, reason: r.reason })
          }
        }
      } catch (e) {
        dispatch.err('tradie notify threw', e)
      }
    })

    log.done('estimate handler done', { quote_id: quote!.id })
    return Response.json({ ok: true, quoteId: quote!.id })
  } catch (err: any) {
    log.err('estimate handler failed', err, { stack: err?.stack?.split('\n').slice(0, 4).join(' | ') })
    return Response.json({
      ok: false,
      error: err?.message ?? String(err),
      cause: err?.cause?.message,
      stack: err?.stack?.split('\n').slice(0, 6).join('\n'),
    }, { status: 500 })
  }
}
