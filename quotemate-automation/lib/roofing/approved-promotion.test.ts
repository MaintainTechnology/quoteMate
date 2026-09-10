import {it,expect,vi} from 'vitest'
import type {SupabaseClient} from '@supabase/supabase-js'
import {approvedRoofPromotion} from './approved-promotion'
const roof={tenant_id:'tenant-1',quote_share_token:'saved-quote-token'}
function db(row:unknown,error:unknown=null){const eq=vi.fn(()=>q);const q={select:()=>q,eq,maybeSingle:async()=>({data:row,error})};return {client:{from:()=>q} as unknown as SupabaseClient,eq}}
it('a promoted draft remains held until owner approval, using the saved exact owned token',async()=>{
  const held=db({tenant_id:'tenant-1',share_token:'saved-quote-token',status:'draft'})
  expect(await approvedRoofPromotion(held.client,roof)).toBeNull()
  const approved=db({tenant_id:'tenant-1',share_token:'saved-quote-token',status:'awaiting_tradie_approval',customer_released_at:'2026-09-08'})
  expect(await approvedRoofPromotion(approved.client,roof)).toBe('saved-quote-token')
  expect(approved.eq).toHaveBeenCalledWith('tenant_id','tenant-1')
})
it('cannot redirect to another tenant and preserves the paid original receipt',async()=>{
  const other=db({tenant_id:'tenant-other',share_token:'wrong',status:'sent'})
  expect(await approvedRoofPromotion(other.client,roof)).toBeNull()
  expect(await approvedRoofPromotion(other.client,{...roof,paid_at:'2026-09-08'})).toBeNull()
})
it('surfaces lookup failure instead of treating it as held or missing',async()=>{
  await expect(approvedRoofPromotion(db(null,{code:'42703'}).client,roof)).rejects.toThrow('temporarily unavailable')
})
