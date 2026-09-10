import { isCronAuthorised } from '@/lib/agents/cron'
import { runPlatformSmsWork } from '@/lib/sms/work-handlers'

export const maxDuration = 300
export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  if (!isCronAuthorised(req)) return new Response('unauthorised', { status: 401 })
  return Response.json({ jobs: await runPlatformSmsWork(4) })
}
