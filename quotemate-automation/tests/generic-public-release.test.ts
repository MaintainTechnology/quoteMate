import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {it,expect} from 'vitest'
import {genericQuoteReleased} from '@/lib/quote/customer-release'

function page(file:string,quote:Record<string,unknown>,owner=false){
  const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:quote,error:null})}
  const exports:Record<string,unknown>={}
  const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText
  const noop=new Proxy(()=>undefined,{get:()=>noop})
  runInNewContext(compiled,{exports,module:{exports},console,process:{env:{}},require:(name:string)=>{
    if(name==='@supabase/supabase-js')return {createClient:()=>({from:()=>q})}
    if(name==='@/lib/quote/customer-release')return {genericQuoteReleased}
    if(name==='@/lib/quote/page-owner')return {isQuotePageOwner:async()=>owner}
    if(name==='@/app/q/_chrome/QuoteAwaitingReview')return {QuoteAwaitingReview:'held'}
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:unknown)=>({type,props}),jsxs:(type:unknown,props:unknown)=>({type,props})}
    if(name==='@/lib/quote/mint-tier')return {asQuoteKind:()=>{throw new Error('AUTHORISED_RENDER')}}
    return noop
  }})
  return exports.default as (props:unknown)=>Promise<unknown>
}
const props={params:Promise.resolve({token:'saved-token'}),searchParams:Promise.resolve({})}
for(const status of ['draft','awaiting_tradie_approval','viewed'])it(`actual generic page hides held prices for status ${status}`,async()=>{
  const render=page('app/q/[token]/page.tsx',{status,tenant_id:'tenant-1',total_inc_gst:99887})
  expect(await render(props)).toEqual({type:'held',props:{}})
})
for(const fields of [{customer_released_at:'2026-09-08'}, {status:'sent'}, {paid_at:'2026-09-08'}])it(`actual generic page preserves approved or historical release ${JSON.stringify(fields)}`,async()=>{
  const render=page('app/q/[token]/page.tsx',{status:'awaiting_tradie_approval',tenant_id:'tenant-1',...fields})
  await expect(render(props)).rejects.toThrow('AUTHORISED_RENDER')
})
it('actual generic page allows authenticated owner review before release',async()=>{
  await expect(page('app/q/[token]/page.tsx',{status:'draft',tenant_id:'tenant-1'},true)(props)).rejects.toThrow('AUTHORISED_RENDER')
})
for(const path of ['app/q/[token]/approve/page.tsx','app/dashboard/quote/[token]/page.tsx'])it(`held prices cannot leak through ${path} without the owner`,async()=>{
  expect(await page(path,{status:'awaiting_tradie_approval',tenant_id:'tenant-1',total_inc_gst:99887})(props)).toEqual({type:'held',props:{}})
})
