import { currentSmsWork } from '@/lib/sms/durable-work'
import { runSmsPlanAnalysis } from './sms-run'

/** Called only inside the platform's durable worker; no public execution route. */
export async function handlePlanAnalysis(request: Request): Promise<Response> {
  if (currentSmsWork()?.job.kind!=='plan') throw new Error('Plan worker ownership required')
  const input=await request.json() as {requestId?:string;inputHash?:string}
  if (!input.requestId || !input.inputHash || !/^[0-9a-f]{64}$/.test(input.inputHash)) throw new Error('Invalid saved plan payload')
  await runSmsPlanAnalysis(input.requestId,input.inputHash)
  return Response.json({ok:true,requestId:input.requestId})
}
