import { beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ resolve:vi.fn(), load:vi.fn(), rpc:vi.fn(), send:vi.fn() }))
vi.mock('@supabase/supabase-js',() => ({ createClient:() => ({rpc:h.rpc}) }))
vi.mock('@/lib/tenant/from-request',() => ({ resolveTenantRequest:h.resolve }))
vi.mock('@/lib/sms/quote-review',() => ({ loadSavedQuoteReview:h.load,
  REVIEW_TABLES:{roof:'roofing_measurements',paint:'painting_measurements',solar:'solar_estimates',plan:'plan_extractions',aircon:'aircon_recommendations','commercial-paint':'paint_runs'} }))
vi.mock('@/lib/sms/dispatch',() => ({ dispatchQuoteMessage:h.send }))
// The actual origin resolver/route boundary has dedicated integration tests.
vi.mock('@/lib/sms/quote-origin-conversation',() => ({ resolveQuoteOriginConversation:async()=>null }))
import { GET,POST } from './route'
const id='11111111-1111-4111-8111-111111111111'
const review={ family:'aircon',id,token:'saved_aircon_token_123',address:'1 Test Street',customerPhone:'+61411111111',createdAt:'2026-09-08',version:'review-1',sourceSnapshot:{id},scope:['Two rooms'],amounts:[{label:'Ducted',incGst:4000}],warnings:[],quantities:[],canApprove:true }
const request=(body:Record<string,unknown>={})=>new Request('https://quotemax.com.au/api/sms/quote-release',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({family:'aircon',id,approve:true,reviewVersion:'review-1',...body})})
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv('APP_URL','https://quotemax.com.au')
  h.resolve.mockResolvedValue({tenant:{id:'tenant-1',twilio_sms_number:'+61488888888'}})
  h.load.mockResolvedValue(review)
  h.rpc.mockResolvedValue({data:{token:review.token,customer_phone:review.customerPhone},error:null})
  h.send.mockResolvedValue({ok:true,outboxId:'outbox-1'})
})
describe('owner quote review and explicit release boundary',()=>{
  it('requires owner authentication for both preview and approval',async()=>{
    h.resolve.mockResolvedValue(null)
    expect((await GET(new Request(`https://quotemax.com.au/api/sms/quote-release?family=aircon&id=${id}`))).status).toBe(401)
    expect((await POST(request())).status).toBe(401)
    expect(h.rpc).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled()
  })
  it('previews the owned saved scope/prices, without exposing internal snapshot tokens',async()=>{
    const response=await GET(new Request(`https://quotemax.com.au/api/sms/quote-release?family=aircon&id=${id}`))
    const body=await response.json()
    expect(body.review.scope).toEqual(['Two rooms']);expect(body.review.amounts[0].incGst).toBe(4000)
    expect(body.review.sourceSnapshot).toBeUndefined()
    expect(h.load).toHaveBeenCalledWith(expect.anything(),'tenant-1','aircon',id)
  })
  it('requires a deliberate approval of the exact reviewed version',async()=>{
    expect((await POST(request({approve:false}))).status).toBe(400)
    expect((await POST(request({reviewVersion:'old'}))).status).toBe(409)
    expect(h.rpc).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled()
  })
  it('commits approval with a durable delivery intent before contacting provider',async()=>{
    const response=await POST(request())
    expect(await response.json()).toMatchObject({approved:true,accepted:true,outboxId:'outbox-1'})
    expect(h.rpc).toHaveBeenCalledWith('sms_release_quote_resource',expect.objectContaining({p_tenant_id:'tenant-1',p_resource_id:id,p_expected_snapshot:{id},p_outbound:expect.objectContaining({to:review.customerPhone,deliveryKey:`quote-release:aircon:${id}`})}))
    expect(h.rpc.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0])
  })
  it('never sends if approval, scope or customer binding fails',async()=>{
    h.rpc.mockResolvedValue({data:null,error:{message:'Customer does not own this result'}})
    expect((await POST(request())).status).toBe(409);expect(h.send).not.toHaveBeenCalled()
  })
  it('cannot approve incomplete work or send using another tenant default number',async()=>{
    h.load.mockResolvedValue({...review,canApprove:false})
    expect((await POST(request())).status).toBe(409)
    h.load.mockResolvedValue(review);h.resolve.mockResolvedValue({tenant:{id:'tenant-1'}})
    expect((await POST(request())).status).toBe(503)
    expect(h.rpc).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled()
  })
  it('reports pending delivery separately from approval when provider fails',async()=>{
    h.send.mockResolvedValue({ok:false,outboxId:'outbox-1'})
    const response=await POST(request())
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({approved:true,accepted:false})
  })
})
