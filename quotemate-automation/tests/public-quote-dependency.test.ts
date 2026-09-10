import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// Execute each actual server page until its first database boundary. Remaining
// imports are inert because outage/missing-token outcomes must exit before them.
function loadPage(family: string, result: {data: unknown; error: unknown}, stopAtPricedRender = false) {
  const query: Record<string, unknown> = {}
  const selections:string[]=[]
  for(const name of ['from','select','eq','limit','order']) query[name]=()=>query
  query.maybeSingle=async()=>result
  query.select=(value:string)=>{selections.push(value);return query}
  const diagnostics=vi.fn(()=> 'safe-reference')
  const exports:Record<string,unknown>={}
  const compiled=ts.transpileModule(readFileSync(`app/q/${family ? `${family}/` : ''}[token]/page.tsx`,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022},
  }).outputText
  const noop = new Proxy(()=>undefined,{get:()=>noop})
  runInNewContext(compiled,{exports,module:{exports},process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://database.test',SUPABASE_SERVICE_ROLE_KEY:'test'}},console,
    require:(name:string)=>{
      if(name==='@supabase/supabase-js') return {createClient:()=>query}
      if(name==='next/navigation') return {notFound:()=>{throw new Error('REAL_404')},redirect:()=>{throw new Error('UNEXPECTED_REDIRECT')}}
      if(name==='react/jsx-runtime') return {jsx:(type:unknown,props:unknown)=>({type,props}),jsxs:(type:unknown,props:unknown)=>({type,props})}
      if(name==='@/app/q/_chrome/QuoteUnavailable') return {QuoteUnavailable:'unavailable'}
      if(name==='@/app/q/_chrome/QuoteAwaitingReview') return {QuoteAwaitingReview:'awaiting-review'}
      if(name==='@/lib/quote/read-failure') return {quoteReadFailure:diagnostics}
      if(stopAtPricedRender && name==='@/lib/quote/tenant-identity') return {loadTenantIdentity:()=>{throw new Error('RELEASED_RENDER')}}
      if(stopAtPricedRender && name==='@/lib/aircon/recommendation-schema') return {parseStoredPricedRecommendation:()=>({pricing_authority:{}})}
      if(stopAtPricedRender && name==='@/lib/aircon/pricing-context') return {loadTenantAcPricingContext:async()=>({}),acPricingAuthorityMatches:()=>true}
      return noop
    }})
  return {page:exports.default as (props:unknown)=>Promise<{type:unknown;props:unknown}>,diagnostics,selections}
}
describe('all seven public token families distinguish outage from absence',()=>{
  for(const family of ['','roof','paint','solar','plan','aircon','commercial-paint']) {
    it(`${family || 'generic'} returns recoverable state for a resolved database error`,async()=>{
      const {page,diagnostics}=loadPage(family,{data:null,error:{code:'42703',message:'secret database detail'}})
      const result=await page({params:Promise.resolve({token:'valid-persisted-token'}),searchParams:Promise.resolve({})})
      expect(result).toEqual({type:'unavailable',props:{correlationId:'safe-reference'}})
      expect(diagnostics).toHaveBeenCalledOnce()
    })
    it(`${family || 'generic'} keeps a genuine missing token as 404`,async()=>{
      const {page,diagnostics}=loadPage(family,{data:null,error:null})
      await expect(page({params:Promise.resolve({token:'missing-token'}),searchParams:Promise.resolve({})})).rejects.toThrow('REAL_404')
      expect(diagnostics).not.toHaveBeenCalled()
    })
  }
})

describe('public customer prices require persisted approval',()=>{
  for(const family of ['plan','aircon','commercial-paint']) {
    it.each([null,undefined])(`${family} hides all amounts and download links without approval (%s)`,async released_at=>{
      const {page,selections}=loadPage(family,{data:{released_at,tenant_id:'tenant',priced_bom:{totalIncGst:98765},recommendation:{price:98765}},error:null},true)
      expect(await page({params:Promise.resolve({token:'saved-token'})})).toEqual({type:'awaiting-review',props:{}})
      expect(selections[0].split(',').map(value=>value.trim())).toContain('released_at')
    })
    it(`${family} preserves the existing priced rendering path when approval is recorded`,async()=>{
      const {page}=loadPage(family,{data:{released_at:'2020-01-01T00:00:00Z',tenant_id:'tenant',recommendation:{}},error:null},true)
      await expect(page({params:Promise.resolve({token:'saved-token'})})).rejects.toThrow('RELEASED_RENDER')
    })
  }
})
