import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { runEstimation } from '@/lib/estimate/run'
import { dispatchQuoteMessage } from '@/lib/sms/dispatch'
import { buildQuoteSms } from '@/lib/sms/templates'
import { pipelineLog } from '@/lib/log/pipeline'
import { createCheckoutSessionsForQuote, createInspectionCheckoutSession, generateShareToken } from '@/lib/stripe/checkout'
import { withRetry } from '@/lib/util/retry'
import { decideRouting } from '@/lib/routing/decide'

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
    const { data: pricingBook } = await supabase.from('pricing_book').select('*').single()
    const { data: call } = await supabase.from('calls').select('caller_number').eq('id', intake.call_id).single()
    log.ok('inputs loaded', {
      job_type: intake.job_type,
      confidence: intake.confidence,
      caller_number: call?.caller_number ? 'set' : 'null',
      hourly_rate: pricingBook.hourly_rate,
    })

    log.step('running Opus (Claude 4.7) — typically ~40s, up to 3 attempts')
    const draft = await withRetry(
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
    const tierCount = [draft.good, draft.better, draft.best].filter(Boolean).length
    log.ok('Opus parsed', {
      tiers: tierCount,
      better_total_ex_gst: draft.better?.subtotal_ex_gst ?? 'null',
      scope_short: draft.scope_short ? `"${draft.scope_short}"` : 'absent',
      needs_inspection: draft.needs_inspection ?? false,
    })

    // Default selected tier for the customer portal is "better".
    // Falls through to "good" if better is missing (e.g. fault_finding has no best).
    const defaultTier = draft.better ?? draft.good
    const selectedSubtotal = defaultTier?.subtotal_ex_gst ?? 0
    const gst = pricingBook.gst_registered ? +(selectedSubtotal * 0.10).toFixed(2) : 0
    const total = +(selectedSubtotal + gst).toFixed(2)

    const routing_decision = decideRouting({
      intake: {
        confidence: intake.confidence,
        inspection_required: intake.inspection_required ?? false,
      },
      quote: { needs_inspection: draft.needs_inspection ?? false },
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
      good:                draft.good             ?? null,
      better:              draft.better           ?? null,
      best:                draft.best             ?? null,
      optional_upsells:    draft.optional_upsells ?? [],
      estimated_timeframe: draft.estimated_timeframe,
      needs_inspection:    draft.needs_inspection,
      inspection_reason:   draft.inspection_reason,
      gst_note:            draft.gst_note,
      selected_tier:       'better',
      subtotal_ex_gst:     selectedSubtotal,
      gst,
      total_inc_gst:       total,
      share_token:         shareToken,
      routing_decision,
    }).select().single()
    log.ok('quote inserted', { quote_id: quote!.id, total_inc_gst: total, routing: routing_decision, share_token: shareToken.slice(0, 8) + '…' })

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
        }
        const body = buildQuoteSms(intake, quoteForSms)
        const segs = body.length <= 160 ? 1 : Math.ceil(body.length / 153)
        dispatch.ok('body built', { chars: body.length, sms_segments: segs })

        dispatch.step('attempting SMS first (WhatsApp fallback if SMS rejects)', { to: callerNumber })
        const result = await dispatchQuoteMessage({ to: callerNumber, text: body })

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
