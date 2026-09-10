import { beforeEach,expect,it,vi } from 'vitest'
const mocks=vi.hoisted(()=>({read:vi.fn(),rpc:vi.fn(),upload:vi.fn()}))
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({
  from:()=>({select:()=>({eq:()=>({maybeSingle:mocks.read})})}),rpc:mocks.rpc,
})}))
vi.mock('@/lib/storage/plan-pdf',()=>({uploadPlanPdf:mocks.upload}))
import { POST } from './route'
const context={params:Promise.resolve({token:'fixture-token'})}
function request(bytes='%PDF-1.7 fixture') {
  const form=new FormData();form.set('pdf',new File([bytes],'plan.pdf',{type:'application/pdf'}))
  return new Request('https://quotemax.com.au/api/upload/plan/fixture-token',{method:'POST',body:form})
}
beforeEach(()=>{
  vi.clearAllMocks()
  mocks.read.mockResolvedValue({data:{id:'request-a',tenant_id:'tenant-a',status:'awaiting_upload',expires_at:'2099-01-01'},error:null})
  mocks.upload.mockImplementation(async(args:{requestId:string})=>`${args.requestId}/plan.pdf`)
  mocks.rpc.mockResolvedValue({data:{id:'work-a',status:'pending'},error:null})
})
it('acknowledges only after the immutable input and atomic work receipt exist',async()=>{
  const response=await POST(request(),context)
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ok:true,jobId:'work-a',stage:'pending'})
  const [name,args]=mocks.rpc.mock.calls[0]
  expect(name).toBe('submit_sms_plan')
  expect(args.p_hash).toMatch(/^[a-f0-9]{64}$/)
  expect(args.p_path).toBe(`request-a/${args.p_hash}/plan.pdf`)
  expect(JSON.parse(args.p_payload.body)).toEqual({requestId:'request-a',inputHash:args.p_hash})
  expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0])
})
it('returns a retryable error if durable receipt persistence fails after storage',async()=>{
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'08006'}})
  expect((await POST(request(),context)).status).toBe(503)
})
it('same input retry retains the immutable version and failed work remains visible',async()=>{
  await POST(request(),context)
  mocks.rpc.mockResolvedValueOnce({data:{id:'work-a',status:'failed'},error:null})
  const response=await POST(request(),context)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({jobId:'work-a',ok:false})
  expect(mocks.rpc.mock.calls[0][1].p_hash).toBe(mocks.rpc.mock.calls[1][1].p_hash)
})
it('rejects non-PDF bytes before storage',async()=>{
  expect((await POST(request('not a pdf'),context)).status).toBe(400)
  expect(mocks.upload).not.toHaveBeenCalled()
})
it('distinguishes a missing token from a database outage',async()=>{
  mocks.read.mockResolvedValueOnce({data:null,error:{code:'08006'}})
  expect((await POST(request(),context)).status).toBe(503)
  mocks.read.mockResolvedValueOnce({data:null,error:null})
  expect((await POST(request(),context)).status).toBe(404)
})
