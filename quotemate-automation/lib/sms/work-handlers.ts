import { runSmsWorkBatch, type SmsWorkHandlers } from './durable-work'
import { smsDeliveryWorkScope } from './work-delivery-context'

export async function runPlatformSmsWork(limit = 4) {
  const handlers: SmsWorkHandlers = {
    inbound: async (req) => (await import('@/app/api/sms/inbound/route')).POST(req),
    intake: async (req) => (await import('@/app/api/intake/structure/route')).POST(req),
    estimate: async (req) => (await import('@/app/api/estimate/draft/route')).POST(req),
    plan: async (req) => (await import('@/lib/estimation/plan-work')).handlePlanAnalysis(req),
  }
  return runSmsWorkBatch(handlers, { limit, scope: smsDeliveryWorkScope })
}
