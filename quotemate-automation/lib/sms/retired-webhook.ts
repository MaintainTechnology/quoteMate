import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { enqueueSmsWork } from './durable-work'
import { parseTwilioForm, validateTwilioSignature } from './twilio-validator'

/** A stale number route must be observable without letting unauthenticated
 * callers fill the recovery queue. Never let a normal worker consume this job.
 */
export async function flagRetiredSmsWebhook(request: Request, database?: SupabaseClient) {
  const rawBody = await request.text()
  const params = parseTwilioForm(rawBody)
  const original = new URL(request.url)
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const signedUrl = host ? `${request.headers.get('x-forwarded-proto') ?? 'https'}://${host}${original.pathname}${original.search}` : original.toString()
  if (!validateTwilioSignature(request.headers.get('x-twilio-signature'), signedUrl, params)) {
    return new Response('Invalid signature', { status: 403 })
  }
  if (!params.MessageSid || !params.To || !params.From) return new Response('Missing provider receipt fields', { status: 400 })
  const db = database ?? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(3500) }) },
  })
  try {
    const tenant = await db.from('tenants').select('id').eq('twilio_sms_number', params.To).maybeSingle()
    // Even an unknown number is retained for operational reconciliation. A DB
    // lookup error must not be mislabelled as successful tenant resolution.
    if (tenant.error) throw new Error('Retired webhook tenant lookup unavailable')
    const job = await enqueueSmsWork({ key: `retired:${params.To}:${params.MessageSid}`, kind: 'inbound',
      serialKey: `retired:${params.To}:${params.From}`, serviceKey: 'retired-platform', tenantId: tenant.data?.id ?? null,
      payload: { url: request.url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: rawBody },
    }, db)
    console.error('[sms/inbound] retired route receipt requires migration recovery', { jobId: job.id, tenantResolved: !!tenant.data?.id })
    return Response.json({ ok: false, error: 'retired_webhook', recoveryId: job.id }, { status: 503, headers: { 'Retry-After': '60' } })
  } catch {
    console.error('[sms/inbound] retired route could not persist recovery receipt')
    return Response.json({ ok: false, error: 'retired_webhook_recovery_unavailable' }, { status: 503, headers: { 'Retry-After': '60' } })
  }
}
