import { parseTwilioForm, validateTwilioSignature } from '@/lib/sms/twilio-validator'
import { publicWebOrigin } from '@/lib/sms/public-origin'
import { recordDeliveryReceipt } from '@/lib/sms/durable-outbox'

export const runtime = 'nodejs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const outboxId = url.searchParams.get('outbox') ?? ''
  const attempt = url.searchParams.get('attempt') ?? ''
  if (!UUID.test(outboxId) || !UUID.test(attempt)) return new Response('Invalid receipt identity', { status: 400 })
  if (Number(request.headers.get('content-length') ?? 0) > 64_000) return new Response('Too large', { status: 413 })
  const raw = await request.text()
  if (raw.length > 64_000) return new Response('Too large', { status: 413 })
  const params = parseTwilioForm(raw)
  const signedUrl = `${publicWebOrigin()}${url.pathname}${url.search}`
  if (params.AccountSid !== process.env.TWILIO_ACCOUNT_SID ||
      !validateTwilioSignature(request.headers.get('x-twilio-signature'), signedUrl, params)) {
    return new Response('Forbidden', { status: 403 })
  }
  if (!/^SM[0-9a-f]{32}$/i.test(params.MessageSid ?? '')) return new Response('Invalid message SID', { status: 400 })
  try {
    const applied = await recordDeliveryReceipt({ outboxId, attempt, sid: params.MessageSid,
      status: params.MessageStatus ?? params.SmsStatus, errorCode: params.ErrorCode })
    return new Response(applied ? null : 'Unknown receipt', { status: applied ? 204 : 409 })
  } catch {
    console.error('[sms/status] receipt unavailable', { outboxId })
    return new Response('Receipt temporarily unavailable', { status: 503 })
  }
}
