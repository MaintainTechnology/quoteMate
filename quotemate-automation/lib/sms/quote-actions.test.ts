import {beforeEach,describe,it,expect,vi} from 'vitest'
import type {SupabaseClient} from '@supabase/supabase-js'
import {handleExistingQuoteAction,QUOTE_FAMILIES} from './quote-actions'
const rpc=vi.fn()
const db={rpc} as unknown as SupabaseClient
const args={supabase:db,tenantId:'tenant-1',customerPhone:'+61411111111',text:'send the quote link again',baseUrl:'https://quotemax.com.au'}
const row=(family:string,id='job-1',stage='ready')=>({family,resource_id:id,token:`saved_${family}_token_123`,label:`${family} job at Smith Street`,stage,created_at:'2026-09-08'})
beforeEach(()=>{rpc.mockReset();vi.stubEnv('PUBLIC_WEB_ORIGIN','https://quotemax.com.au')})
describe('resend/status revalidates saved tenant and customer ownership across every tool',()=>{
  it.each(QUOTE_FAMILIES)('resends the exact saved %s token without invoking an estimator',async(family)=>{
    const saved=row(family);rpc.mockResolvedValue({data:[saved],error:null})
    const result=await handleExistingQuoteAction(args)
    expect(result.reply).toContain(`https://quotemax.com.au/q/${family==='generic'?'':`${family}/`}${saved.token}`)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('sms_customer_quote_references',{p_tenant_id:'tenant-1',p_customer_phone:args.customerPhone})
  })
  it('never reveals a draft token before approval',async()=>{
    rpc.mockResolvedValue({data:[row('roof','job-1','awaiting_review')],error:null})
    const result=await handleExistingQuoteAction(args)
    expect(result.reply).toMatch(/awaiting.*review/);expect(result.reply).not.toMatch(/https?:/)
  })
  it('asks which job and rechecks the selection against the current owned results',async()=>{
    rpc.mockResolvedValue({data:[row('paint','one'),row('solar','two')],error:null})
    const choices=await handleExistingQuoteAction(args)
    expect(choices.candidates).toHaveLength(2);expect(choices.reply).toMatch(/Which job/)
    const selected=await handleExistingQuoteAction({...args,text:'2',selectionCandidates:[{family:'paint',id:'one'},{family:'solar',id:'two'}]})
    expect(selected.reference?.family).toBe('solar')
    const unowned=await handleExistingQuoteAction({...args,text:'2',selectionCandidates:[{family:'paint',id:'one'},{family:'solar',id:'other-customer'}]})
    expect(unowned.reference).toBeUndefined();expect(unowned.reply).toMatch(/Which job/)
  })
  it('treats storage outage as a retryable failure instead of inventing a missing quote',async()=>{
    rpc.mockResolvedValue({data:null,error:{message:'PGRST204'}})
    await expect(handleExistingQuoteAction(args)).rejects.toThrow('lookup unavailable')
  })
})
