import { beforeEach, describe, expect, it, vi } from 'vitest'
const h=vi.hoisted(()=>({owner:vi.fn(),send:vi.fn(),dispatch:vi.fn(),intent:vi.fn(),read:vi.fn(),filters:[] as unknown[]}))
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:(table:string)=>{
  const b={select:()=>b,eq:(...args:unknown[])=>{h.filters.push(args);return b},maybeSingle:table==='sms_outbox'?h.intent:h.read};return b
}})}))
vi.mock('@/lib/tenant/from-request',()=>({resolveTenantRequest:h.owner}))
vi.mock('@/lib/painting/release',()=>({sendPaintingQuoteToCustomer:h.send}))
vi.mock('@/lib/sms/dispatch',()=>({dispatchQuoteMessage:h.dispatch}))
vi.mock('@/lib/sms/public-origin',()=>({publicWebOrigin:()=> 'https://quotemax.com.au'}))
import { POST } from './route'
const ctx={params:Promise.resolve({token:'estimate-token'})}
const row={id:'p1',tenant_id:'tenant-1',estimate_token:'estimate-token',public_token:'public-token',released_at:'2026-09-08',quote_sent_at:null}
const request=(body?:unknown)=>new Request('https://quotemax.com.au/api/painting/release/estimate-token',{method:'POST',...(body?{body:JSON.stringify(body)}:{})})
beforeEach(()=>{vi.clearAllMocks();h.filters.length=0;h.owner.mockResolvedValue({tenant:{id:'tenant-1'}});h.read.mockResolvedValue({data:row,error:null});h.send.mockResolvedValue({sent:true});h.intent.mockResolvedValue({data:null,error:null});h.dispatch.mockResolvedValue({ok:true,outboxId:'approved-outbox'})})
describe('painting explicit send authority and recovery',()=>{
  it('uses the original central approval delivery intent instead of creating another first send',async()=>{
    const payload={deliveryKey:'quote-release:paint:p1',to:'+61400111222',text:'Approved saved quote'}
    h.intent.mockResolvedValue({data:{id:'approved-outbox',payload},error:null})
    const res=await POST(request(),ctx);expect(res.status).toBe(200);expect(h.dispatch).toHaveBeenCalledWith(payload);expect(h.send).not.toHaveBeenCalled()
  })
  it('rejects a review token without an owner session before quote access',async()=>{h.owner.mockResolvedValue(null);expect((await POST(request(),ctx)).status).toBe(401);expect(h.read).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled()})
  it('scopes lookup to the authenticated owner and hides another tenant record',async()=>{h.read.mockResolvedValue({data:{...row,tenant_id:'other'},error:null});expect((await POST(request(),ctx)).status).toBe(404);expect(h.filters).toContainEqual(['tenant_id','tenant-1']);expect(h.send).not.toHaveBeenCalled()})
  it('routes first approval through the saved result review gate',async()=>{h.read.mockResolvedValue({data:{...row,released_at:null},error:null});const res=await POST(request(),ctx);expect(res.status).toBe(409);expect(await res.json()).toMatchObject({reviewUrl:'/dashboard/quote-review?family=paint&id=p1'});expect(h.send).not.toHaveBeenCalled()})
  it('retries an already approved unsent quote with the stable initial intent',async()=>{const res=await POST(request(),ctx);expect(res.status).toBe(200);expect(h.send).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({tenantId:'tenant-1',estimateToken:'estimate-token',requestId:undefined}))})
  it('reuses explicit resend identity across transport retries',async()=>{const requestId='11111111-1111-4111-8111-111111111111';await POST(request({resend:true,requestId}),ctx);await POST(request({resend:true,requestId}),ctx);expect(h.send.mock.calls.map(([,args])=>args.requestId)).toEqual([requestId,requestId])})
  it('requires a client request identity for a new resend',async()=>{expect((await POST(request({resend:true}),ctx)).status).toBe(400);expect(h.send).not.toHaveBeenCalled()})
  it('reports existing acceptance honestly without another dispatch',async()=>{h.read.mockResolvedValue({data:{...row,quote_sent_at:'2026-09-08'},error:null});expect(await (await POST(request(),ctx)).json()).toMatchObject({sent:true,alreadyAccepted:true});expect(h.send).not.toHaveBeenCalled()})
  it('preserves approval and exposes the recovery intent after an uncertain send',async()=>{h.send.mockResolvedValue({sent:false,outboxId:'out-1',status:'unknown'});const res=await POST(request(),ctx);expect(res.status).toBe(202);expect(await res.json()).toMatchObject({sent:false,approved:true,outboxId:'out-1',released_at:row.released_at})})
  it('distinguishes an outage from an unknown token',async()=>{h.read.mockResolvedValue({data:null,error:{message:'down'}});expect((await POST(request(),ctx)).status).toBe(503);h.read.mockResolvedValue({data:null,error:null});expect((await POST(request(),ctx)).status).toBe(404)})
})
