import { recoverSmsOutbox } from '@/lib/sms/dispatch'

export const runtime = 'nodejs'
export const maxDuration = 300
export async function GET(request: Request): Promise<Response> {
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'unauthorised' }, { status: 401 })
  }
  try { return Response.json({ ok: true, ...await recoverSmsOutbox() }) }
  catch { return Response.json({ ok: false, error: 'outbox_unavailable' }, { status: 503 }) }
}
