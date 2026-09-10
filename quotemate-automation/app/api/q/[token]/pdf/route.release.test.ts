import {beforeEach,describe,it,expect,vi} from 'vitest'
const h=vi.hoisted(()=>({result:{data:null,error:null} as {data:Record<string,unknown>|null;error:unknown},owner:null as unknown,navOwner:false,render:vi.fn(),download:vi.fn(),html:vi.fn()}))
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>h.result};return q}})}))
vi.mock('next/server',()=>({after:vi.fn()}))
vi.mock('@/lib/tenant/from-request',()=>({resolveTenantRequest:async()=>h.owner}))
vi.mock('@/lib/quote/page-owner',()=>({isQuotePageOwner:async()=>h.navOwner}))
vi.mock('@/lib/quote/pdf',()=>({ensureQuotePdf:h.render,downloadQuotePdf:h.download,renderQuoteReportHtml:h.html}))
vi.mock('@/lib/filestore/archive-on-download',()=>({archiveQuoteOnDownload:vi.fn()}))
import {GET} from './route'
import {GET as htmlPreview} from '../html/route'
const request=()=>GET(new Request('https://quotemax.com.au/api/q/saved-token/pdf'),{params:Promise.resolve({token:'saved-token'})})
beforeEach(()=>{h.result={data:{id:'quote-1',tenant_id:'tenant-1',status:'awaiting_tradie_approval',pdf_path:'saved.pdf'},error:null};h.owner=null;h.navOwner=false;h.render.mockReset().mockResolvedValue('saved.pdf');h.download.mockReset().mockResolvedValue(Buffer.from('pdf'));h.html.mockReset().mockResolvedValue('<html>Owned customer report</html>')})
describe('actual generic PDF release boundary',()=>{
  it('holds an unapproved quote and excludes another tenant even when the PDF exists',async()=>{
    h.owner={tenant:{id:'tenant-other'}};expect((await request()).status).toBe(403);expect(h.render).not.toHaveBeenCalled();expect(h.download).not.toHaveBeenCalled()
  })
  it.each([{customer_released_at:'2026-09-08'}, {status:'sent'}, {paid_at:'2026-09-08',status:'paid'}])('serves approved or evidenced historical customer quotes %j',async fields=>{
    Object.assign(h.result.data!,fields);expect((await request()).status).toBe(200)
  })
  it('permits the authenticated owner to preview a held PDF',async()=>{h.owner={tenant:{id:'tenant-1'}};expect((await request()).status).toBe(200)})
  it('separates a database failure from a missing token',async()=>{h.result={data:null,error:{code:'42703'}};expect((await request()).status).toBe(503);h.result={data:null,error:null};expect((await request()).status).toBe(404)})
})
describe('actual HTML preview owner and release boundary',()=>{
  const html=()=>htmlPreview(new Request('https://quotemax.com.au/api/q/saved-token/html',{headers:{Authorization:'Bearer owner-token'}}),{params:Promise.resolve({token:'saved-token'})})
  it('blocks public and wrong-tenant held prices before rendering',async()=>{
    expect((await html()).status).toBe(403);h.owner={tenant:{id:'other'}};expect((await html()).status).toBe(403);expect(h.html).not.toHaveBeenCalled()
  })
  it('allows the native owner bearer request to render the held customer-only HTML',async()=>{
    h.owner={tenant:{id:'tenant-1'}};const res=await html();expect(res.status).toBe(200);expect(await res.text()).toContain('Owned customer report')
  })
  it('serves an approved pending-delivery quote without owner auth',async()=>{
    h.result.data!.customer_released_at='2026-09-08';expect((await html()).status).toBe(200)
  })
  it('keeps dependency failure recoverable and nonexistent token missing',async()=>{
    h.result={data:null,error:{code:'42703'}};expect((await html()).status).toBe(503);h.result={data:null,error:null};expect((await html()).status).toBe(404)
  })
})
