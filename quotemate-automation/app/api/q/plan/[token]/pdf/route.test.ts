import {beforeEach,describe,expect,it,vi} from 'vitest'
const h=vi.hoisted(()=>({read:vi.fn(),download:vi.fn()}))
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({
  from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:h.read};return q},
  storage:{from:()=>({download:h.download})},
})}))
import {GET} from './route'
const request=()=>GET(new Request('https://quotemax.com.au/api/q/plan/token/pdf'),{params:Promise.resolve({token:'saved-token'})})
beforeEach(()=>{vi.clearAllMocks();h.download.mockResolvedValue({data:new Blob(['approved PDF']),error:null})})
describe('public plan PDF approval gate',()=>{
  it('never downloads an unapproved priced report',async()=>{
    h.read.mockResolvedValue({data:{report_pdf_path:'priced.pdf',released_at:null},error:null})
    const result=await request()
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({status:'awaiting_review'})
    expect(h.download).not.toHaveBeenCalled()
  })
  it('keeps a previously approved report downloadable',async()=>{
    h.read.mockResolvedValue({data:{report_pdf_path:'priced.pdf',released_at:'2020-01-01T00:00:00Z'},error:null})
    const result=await request()
    expect(result.status).toBe(200)
    expect(await result.text()).toBe('approved PDF')
    expect(h.download).toHaveBeenCalledOnce()
  })
  it('distinguishes database unavailability from a missing token',async()=>{
    h.read.mockResolvedValueOnce({data:null,error:{code:'42703'}})
    expect((await request()).status).toBe(503)
    h.read.mockResolvedValueOnce({data:null,error:null})
    expect((await request()).status).toBe(404)
    expect(h.download).not.toHaveBeenCalled()
  })
})
