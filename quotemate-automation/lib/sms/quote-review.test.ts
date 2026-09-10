import { describe,it,expect,vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {loadSavedQuoteReview} from './quote-review'
function dbFor(rows:Record<string,unknown>[]) {
  const filters:unknown[][]=[]
  const db={from:()=>{const q:Record<string,unknown>={};for(const op of ['select','eq','not','order','limit'])q[op]=(...a:unknown[])=>{if(op==='eq')filters.push(a);return q};q.maybeSingle=vi.fn(async()=>({data:rows.shift()??null,error:null}));return q}} as unknown as SupabaseClient
  return {db,filters}
}
const base={id:'saved-id',tenant_id:'tenant-1',customer_phone:'0411111111',public_token:'saved_public_token',created_at:'2026-09-08'}
describe('saved review shows the precise owned values the customer will see',()=>{
  it('shows plan quantities AND priced BOM totals so approval cannot hide money',async()=>{
    const {db,filters}=dbFor([{...base,share_token:'saved_public_token',corrected_items:[{label:'Downlights',count:12}],priced_bom:{totalIncGst:1452,assumptions:['Ceiling access included']}},{customer_phone:'0411111111'}])
    const review=await loadSavedQuoteReview(db,'tenant-1','plan','saved-id')
    expect(review).toMatchObject({canApprove:true,amounts:[{label:'Plan total',incGst:1452}],quantities:[{label:'Downlights',quantity:'12'}],scope:['Ceiling access included']})
    expect(filters.filter((p)=>p[0]==='tenant_id')).toEqual([['tenant_id','tenant-1'],['tenant_id','tenant-1']])
  })
  it('holds incomplete or non-finite pricing instead of allowing a blind release',async()=>{
    const {db}=dbFor([{...base,recommendation:{options:[{price:{low:null,high:4000}}]}}])
    expect(await loadSavedQuoteReview(db,'tenant-1','aircon','saved-id')).toMatchObject({canApprove:false})
  })
  it('shows aircon equipment scope and the exact indicative price range',async()=>{
    const {db}=dbFor([{...base,recommendation:{options:[{system_type:'ducted',capacity_kw:12,price:{low:3000,high:4500},pros:['Four zones']}]}}])
    const review=await loadSavedQuoteReview(db,'tenant-1','aircon','saved-id')
    expect(review).toMatchObject({canApprove:true,amounts:[{label:'ducted',incGst:3000,highIncGst:4500}],scope:['ducted: 12 kW','Four zones']})
  })
  it('keeps an unproven legacy tender visible but requires pricing review before approval',async()=>{
    const content={totalIncGst:20000,lines:[{label:'Internal walls',quantity:200}],assumptions:['Two coats']}
    const {db}=dbFor([{...base,status:'priced',job_name:'Office'}, {priced_bom:content}])
    const review=await loadSavedQuoteReview(db,'tenant-1','commercial-paint','saved-id')
    expect(review).toMatchObject({canApprove:false,amounts:[{incGst:20000}],sourceSnapshot:{_review_priced_bom:content,_review_paint_pricing:null}})
  })
})
