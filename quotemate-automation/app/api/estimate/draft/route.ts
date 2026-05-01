import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { runEstimation } from '@/lib/estimate/run'
import { sendSms } from '@/lib/sms/twilio'
import { buildQuoteSms } from '@/lib/sms/templates'
import { pipelineLog } from '@/lib/log/pipeline'

export const maxDuration = 60

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

    log.step('running Opus (Claude 4.7) — typically ~40s')
    const draft = await runEstimation(intake, pricingBook)
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

    log.step('inserting quotes row')
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
    }).select().single()
    log.ok('quote inserted', { quote_id: quote!.id, total_inc_gst: total })

    // Auto-send the quote to the caller via SMS (Path B per current product mode).
    // Skip if no caller_number available. Errors are logged but never fail the route.
    const callerNumber = call?.caller_number ?? null
    log.step(callerNumber ? 'queueing SMS dispatch' : 'skipping SMS — no caller_number')

    after(async () => {
      const sms = pipelineLog('sms', intake.call_id)
      if (!callerNumber) {
        sms.err('skipped', null, { quote_id: quote!.id, reason: 'no caller_number on call row' })
        return
      }
      try {
        sms.step('building quote SMS body')
        const quoteForSms = { ...quote!, scope_short: draft.scope_short ?? null }
        const body = buildQuoteSms(intake, quoteForSms)
        const segs = body.length <= 160 ? 1 : Math.ceil(body.length / 153)
        sms.ok('body built', { chars: body.length, segments: segs })

        sms.step('sending via Twilio', { to: callerNumber, from: process.env.TWILIO_PHONE_NUMBER })
        const result = await sendSms({ to: callerNumber, text: body })
        if (result.ok) {
          sms.ok('Twilio accepted', { sid: result.sid, status: result.status })
          sms.done('SMS dispatched to caller', { quote_id: quote!.id, segments: segs })
        } else {
          sms.err('Twilio rejected', result.reason, { code: result.code })
        }
      } catch (e) {
        sms.err('SMS dispatch threw', e)
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
