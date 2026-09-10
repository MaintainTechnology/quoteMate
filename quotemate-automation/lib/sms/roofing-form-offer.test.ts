import { beforeEach, describe, expect, it, vi } from 'vitest'
import { advanceRoofing, nextRoofingConversationState, roofingTurnIsDeterministic } from './roofing-receptionist'
import { ensureRoofingFormRequest, buildRoofingFormOffer } from './roofing-form-offer'
import { readFileSync } from 'node:fs'

beforeEach(()=>{vi.stubEnv('APP_URL','https://quotemax.com.au');vi.stubEnv('PUBLIC_WEB_ORIGIN','')})
describe('preserved roofing form-first service contract',()=>{
  it('offers a form on the SMS opener while retaining the supplied address',()=>{
    const decision=advanceRoofing(null,'New roof at 12 Smith Street, Bondi NSW 2026',{formFirst:true})
    expect(decision.action).toBe('offer_form')
    expect(decision.slots.address).toContain('12 Smith')
    expect(nextRoofingConversationState(decision).last_step).toBe('offer_form')
    expect(roofingTurnIsDeterministic(null,'new roof')).toBe(true)
  })
  it('choosing the form parks the existing token; texting resumes questions',()=>{
    const prev={slots:{},last_step:'offer_form' as const,pending_form_token:'saved'}
    const form=advanceRoofing(prev,'send me the form',{formFirst:true})
    expect(form.action).toBe('await_form')
    expect(roofingTurnIsDeterministic(prev,'send me the form')).toBe(true)
    expect(advanceRoofing(prev,'just text me',{formFirst:true}).action).toBe('ask')
    const reply='reply' in form ? form.reply : ''
    expect(reply).toMatch(/review/)
    expect(reply).not.toMatch(/straight|on.*way|sent|soon/)
  })
  it('inserts and reads the same owned token after response loss/retry',async()=>{
    let token='';const writes:unknown[]=[]
    const query={eq:vi.fn(()=>query),maybeSingle:vi.fn(async()=>({data:{token},error:null}))}
    const db={from:vi.fn(()=>({upsert:vi.fn(async(row)=>{token=row.token;writes.push(row);return{error:null}}),select:vi.fn(()=>query)}))}
    const args={db:db as never,tenantId:'tenant',conversationId:'conversation',customerPhone:'+61400000001'}
    const first=await ensureRoofingFormRequest(args)
    expect(first).toHaveLength(32)
    expect(await ensureRoofingFormRequest(args)).toBe(first)
    expect(query.eq).toHaveBeenCalledWith('tenant_id','tenant')
    expect(query.eq).toHaveBeenCalledWith('customer_phone','+61400000001')
    expect(writes).toHaveLength(2)
  })
  it('does not provide a form token when insert fails',async()=>{
    const db={from:()=>({upsert:async()=>({error:{message:'database unavailable'}})})}
    expect(await ensureRoofingFormRequest({db:db as never,tenantId:'t',conversationId:'c',customerPhone:'p'})).toBeNull()
  })
  it('uses the website and makes no promise of automatic quote delivery',()=>{
    const reply=buildRoofingFormOffer({firstName:'Jo',token:'saved-token'})
    expect(reply).toContain('https://quotemax.com.au/quote-request/saved-token')
    expect(reply).toMatch(/review/)
    expect(reply).not.toMatch(/straight back|straight over|on.*way/)
  })
  it('the actual SMS route preserves the form choice before normal gather and uses the deterministic opener',()=>{
    const route=readFileSync('app/api/sms/inbound/route.ts','utf8')
    const roof=route.slice(route.indexOf('async function handleRoofingTurn'),route.indexOf('async function handlePaintingTurn'))
    expect(roof).toContain('!roofingTurnIsDeterministic(prevState, decisionInput)')
    expect(roof).toContain('advanceRoofing(prevState, decisionInput, { formFirst: true })')
    expect(roof).toContain('ensureRoofingFormRequest({ db: supabase, tenantId, conversationId, customerPhone: fromNumber })')
    expect(roof.indexOf("decision.action === 'offer_form'")).toBeLessThan(roof.indexOf("decision.action === 'ask'"))
  })
})
