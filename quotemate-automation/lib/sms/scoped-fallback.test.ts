import { beforeEach, describe, expect, it, vi } from 'vitest'
const h=vi.hoisted(()=>({generate:vi.fn()}))
vi.mock('ai',()=>({generateObject:h.generate}))
vi.mock('@ai-sdk/anthropic',()=>({anthropic:()=> 'test-model'}))
import { decideScopedFallback } from './scoped-fallback'
const args=(body:string)=>({history:[{direction:'inbound' as const,body}],inboundCount:1})
beforeEach(()=>{h.generate.mockReset().mockResolvedValue({object:{reply:'What room would you like to include?'}})})
describe('dedicated trade fallback keeps ordinary questions alive without inventing tools',()=>{
  it.each(['roofing','painting','solar'] as const)('answers an ordinary %s question without ending or claiming a handoff',async(trade)=>{
    const reply=await decideScopedFallback(args('Can I change the rooms?'),trade)
    expect(reply.action).toBe('ask');expect(reply.ready_for_intake).toBe(false);expect(reply.reply_to_send).toBe('What room would you like to include?')
  })
  it('uses a deterministic saved quote action suggestion instead of inventing a price',async()=>{
    const reply=await decideScopedFallback(args('How much and where is the link?'),'solar')
    expect(reply.action).toBe('ask');expect(reply.reply_to_send).toMatch(/existing solar quote/);expect(h.generate).not.toHaveBeenCalled()
  })
  it('rejects model money and unperformed notification promises',async()=>{
    h.generate.mockResolvedValue({object:{reply:'I have notified the owner. It costs $300.'}})
    const reply=await decideScopedFallback(args('Please add the garage'),'roofing')
    expect(reply.reply_to_send).not.toMatch(/\$|notified/);expect(reply.action).toBe('ask')
  })
  it('recovers model failure with a clarification and only ends on an explicit goodbye',async()=>{
    h.generate.mockRejectedValue(new Error('deadline'))
    expect((await decideScopedFallback(args('When can I get help?'),'painting')).action).toBe('ask')
    expect((await decideScopedFallback(args('goodbye'),'painting')).action).toBe('end_conversation')
  })
})
