import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>({rpc:vi.fn()}))
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({rpc:mocks.rpc})}))
import { dispatchDurably } from './durable-outbox'

beforeEach(()=>{
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://database.test')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','fixture')
  vi.stubEnv('PUBLIC_WEB_ORIGIN','https://quotemax.com.au')
})
afterEach(()=>vi.unstubAllEnvs())
it.each(['sms_outbox_claim','sms_outbox_finish'])('preserves a saved receipt if %s throws',async(failingRpc)=>{
  const row={id:'outbox-a',status:'pending',payload:{to:'+61400000000',text:'Approved quote'}}
  mocks.rpc.mockImplementation(async(name:string)=>{
    if(name===failingRpc) throw new Error('connection interrupted')
    return {data:row,error:null}
  })
  const transport=vi.fn(async()=>({ok:true as const,channel:'sms' as const,sid:'SM1',status:'queued'}))
  const result=await dispatchDurably(row.payload,transport)
  expect(result).toMatchObject({ok:false,outboxId:'outbox-a',smsAttempt:{code:'AMBIGUOUS'}})
  expect(transport).toHaveBeenCalledTimes(failingRpc==='sms_outbox_claim'?0:1)
})
it('distinguishes an enqueue failure from a saved delivery',async()=>{
  mocks.rpc.mockRejectedValueOnce(new Error('database unavailable'))
  const transport=vi.fn()
  const result=await dispatchDurably({to:'+61400000000',text:'Approved quote'},transport)
  expect(result).toMatchObject({ok:false,smsAttempt:{code:'OUTBOX_UNAVAILABLE'}})
  expect(result.outboxId).toBeUndefined()
  expect(transport).not.toHaveBeenCalled()
})
