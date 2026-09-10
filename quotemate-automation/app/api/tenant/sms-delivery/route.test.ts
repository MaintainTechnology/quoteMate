import {beforeEach,it,expect,vi} from 'vitest'
const h=vi.hoisted(()=>({tenant:{id:'tenant-1'} as {id:string}|null,quote:null as unknown,outbox:null as unknown,errorTable:'',filters:[] as Array<[string,string,unknown]>}))
vi.mock('@/lib/estimation/auth',()=>({tenantFromBearer:async()=>h.tenant}))
vi.mock('@/lib/sms/durable-outbox',()=>({outboxDb:()=>({from:(table:string)=>{const q={select:()=>q,eq:(field:string,value:unknown)=>{h.filters.push([table,field,value]);return q},maybeSingle:async()=>({data:table==='quotes'?h.quote:h.outbox,error:h.errorTable===table?{code:'08006'}:null})};return q}})}))
import {GET} from './route'
const id='11111111-1111-4111-8111-111111111111',requestId='33333333-3333-4333-8333-333333333333'
const get=(extra='')=>GET(new Request(`https://quotemax.com.au/api/tenant/sms-delivery?quoteId=${id}${extra}`))
beforeEach(()=>{h.tenant={id:'tenant-1'};h.quote={id,tenant_id:'tenant-1',status:'awaiting_tradie_approval',customer_released_at:'2026-09-08'};h.outbox={id:'outbox-1',status:'unknown',requires_attention:true};h.errorTable='';h.filters=[]})
it('recovers a lost POST response by its original requestId without needing the unseen outboxId',async()=>{
  const response=await get(`&requestId=${requestId}`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({quoteId:id,requestId,status:'unknown',outboxId:'outbox-1',approved:true})
  expect(h.filters).toContainEqual(['sms_outbox','delivery_key',`quote-release:generic:${id}:resend:${requestId}`])
  expect(h.filters).toContainEqual(['sms_outbox','tenant_id','tenant-1'])
  expect(h.filters).toContainEqual(['quotes','tenant_id','tenant-1'])
})
it('derives the stable initial key when no resend ID was used',async()=>{
  await get();expect(h.filters).toContainEqual(['sms_outbox','delivery_key',`quote-release:generic:${id}:initial`])
})
it('reconciles the same UUID when the client changes its letter casing',async()=>{
  const quoteId='abcdefab-cdef-4abc-8def-abcdefabcdef',resendId='fedcbafe-dcba-4abc-8def-abcdefabcdef'
  h.quote={id:quoteId,tenant_id:'tenant-1',status:'sent'}
  const response=await GET(new Request(`https://quotemax.com.au/api/tenant/sms-delivery?quoteId=${quoteId.toUpperCase()}&requestId=${resendId.toUpperCase()}`))
  expect(response.status).toBe(200)
  expect(h.filters).toContainEqual(['sms_outbox','delivery_key',`quote-release:generic:${quoteId}:resend:${resendId}`])
})
it('does not disclose other tenants or query their delivery intents',async()=>{
  h.quote={id,tenant_id:'tenant-other'};expect((await get()).status).toBe(404)
  expect(h.filters.some(([table])=>table==='sms_outbox')).toBe(false)
  h.tenant=null;expect((await get()).status).toBe(401)
})
it('distinguishes a known owned quote without an intent from a dependency failure',async()=>{
  h.outbox=null;const missing=await get();expect(missing.status).toBe(200);expect(await missing.json()).toMatchObject({status:'not_found',outboxId:null,approved:true})
  h.errorTable='sms_outbox';expect((await get()).status).toBe(503)
  h.errorTable='quotes';expect((await get()).status).toBe(503)
})
it('rejects malformed IDs rather than accepting caller-provided arbitrary delivery keys',async()=>{
  expect((await get('&requestId=another-tenant-key')).status).toBe(400)
  expect(h.filters).toHaveLength(0)
})
