import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { structureIntake } from '@/lib/intake/structure'
import { embedIntake } from '@/lib/intake/embed'
import { pipelineLog } from '@/lib/log/pipeline'

export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: Request) {
  const { callId } = await req.json()
  const log = pipelineLog('intake', callId)
  log.step('received', { callId })

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

  log.step('running Sonnet vision (Claude 4.6) — typically ~25s')
  const intake = await structureIntake(call.transcript, call.photo_urls)
  log.ok('Sonnet structured intake', {
    job_type: intake.job_type,
    confidence: intake.confidence,
    inspection_required: intake.inspection_required,
    risks: intake.risks?.length ?? 0,
  })

  log.step('embedding intake (1536-dim) for similarity search')
  const embedding = await embedIntake(intake)
  log.ok('embedding complete', { dims: embedding.length })

  log.step('inserting intakes row')
  const { data: intakeRow } = await supabase.from('intakes').insert({
    call_id: callId,
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
  }).select().single()
  log.ok('intakes row inserted', { intake_id: intakeRow!.id })

  // Hand off to the Estimation Engine via after() so the dispatch survives
  // the response on Vercel serverless.
  after(async () => {
    const dispatch = pipelineLog('intake', callId)
    dispatch.step('dispatching to /api/estimate/draft', { intake_id: intakeRow!.id })
    try {
      const res = await fetch(`${process.env.APP_URL}/api/estimate/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intakeId: intakeRow!.id }),
      })
      if (res.ok) {
        dispatch.ok('estimate/draft dispatched', { http: res.status })
      } else {
        dispatch.err('estimate/draft rejected', `HTTP ${res.status}`, { body: (await res.text()).slice(0, 200) })
      }
    } catch (e) {
      dispatch.err('estimate dispatch threw', e)
    }
  })

  log.done('intake handler done', { intake_id: intakeRow!.id })
  return Response.json({ ok: true, intakeId: intakeRow!.id })
}
