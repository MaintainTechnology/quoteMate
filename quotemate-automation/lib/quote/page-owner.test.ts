import {beforeEach,it,expect,vi} from 'vitest'
import type {SupabaseClient} from '@supabase/supabase-js'
const h=vi.hoisted(()=>({headers:new Headers(),resolve:vi.fn()}))
vi.mock('next/headers',()=>({headers:async()=>h.headers}))
vi.mock('@/lib/tenant/from-request',()=>({resolveTenantRequest:h.resolve}))
import {isQuotePageOwner} from './page-owner'
beforeEach(()=>{h.headers=new Headers();h.resolve.mockReset().mockResolvedValue({tenant:{id:'tenant-1'}})})
it('never grants draft preview on token possession without a verified owner session',async()=>{
  expect(await isQuotePageOwner({} as SupabaseClient,'tenant-1')).toBe(false);expect(h.resolve).not.toHaveBeenCalled()
})
it('verifies the signed navigation cookie and matches the owning tenant',async()=>{
  h.headers.set('cookie','other=x; __session=verified.jwt')
  expect(await isQuotePageOwner({} as SupabaseClient,'tenant-1')).toBe(true)
  expect(h.resolve.mock.calls[0][1].headers.get('authorization')).toBe('Bearer verified.jwt')
  expect(await isQuotePageOwner({} as SupabaseClient,'tenant-other')).toBe(false)
})
it('rejects malformed cookies without leaking or throwing',async()=>{
  h.headers.set('cookie','__session=%zz');expect(await isQuotePageOwner({} as SupabaseClient,'tenant-1')).toBe(false)
})
