import { describe,expect,it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transpileModule,ModuleKind } from 'typescript'
import { tenantPricingReadiness } from '../lib/sms/pricing-readiness'
import { verifyPublicQuoteSchema,JOB_QUOTE_OPERATION_SCHEMA } from '../lib/quote/public-schema'
import { DEFAULT_PAINTING_RATE_CARD } from '../lib/painting/pricing'
import { DEFAULT_SOLAR_CONFIG } from '../lib/solar/config'
import { DEFAULT_ROOFING_RATE_CARD } from '../lib/roofing/pricing'

type Row=Record<string,unknown>
const tenant='tenant-1'
const trades=['electrical','plumbing','roofing','painting','solar'] as const
const cards={
  solar:{...DEFAULT_SOLAR_CONFIG.default_rate_card,stc_price_aud:DEFAULT_SOLAR_CONFIG.stc_price_aud},
  painting:DEFAULT_PAINTING_RATE_CARD,
  roofing:{...DEFAULT_ROOFING_RATE_CARD,reroof_rate_per_m2:{...DEFAULT_ROOFING_RATE_CARD.reroof_rate_per_m2,cement_sheet:140},complexity_loading_pct:0.15,solar_detach_reinstate_base_ex_gst:1200,solar_detach_reinstate_per_array_ex_gst:500},
}
function book(trade: string): Row {
  return {id:'book-1',tenant_id:tenant,trade,gst_registered:true,
    overlays:trade in cards ? {[`${trade}_rate_card`]:structuredClone(cards[trade as keyof typeof cards])} : {}}
}
function fixture(rows:Row[],options:{error?:boolean;throwRead?:boolean;wrongTenantResponse?:boolean;schemaError?:string;guard?:string;guardFailure?:string;guardValue?:unknown;proofAt?:unknown}={}) {
  const reads:{table:string;filters:Record<string,unknown>;signal?:AbortSignal;columns?:string;limit?:number}[]=[]
  const rpcs:{name:string;signal?:AbortSignal}[]=[]
  const db={from(table:string) {
    const read={table,filters:{} as Record<string,unknown>,signal:undefined as AbortSignal|undefined,columns:undefined as string|undefined,limit:undefined as number|undefined}
    reads.push(read)
    let zero=false
    const result=()=>{
      if (options.throwRead && table==='pricing_book') throw new Error('offline unavailable')
      const data=zero ? [] : table==='tenants' ? {trades:[...trades],trade:'electrical',status:'active'}
        : table==='sms_readiness_evidence' ? {passed:true,verified_at:'proofAt' in options ? options.proofAt : new Date().toISOString()}
        : table==='pricing_book' ? rows.filter(row=>options.wrongTenantResponse || Object.entries(read.filters).every(([key,value])=>row[key]===value)) : []
      return {data,error:options.error && table==='pricing_book' ? {code:'XX000'} : table==='job_quote_operations' && options.schemaError ? {code:options.schemaError} : null}
    }
    const query={select:(columns:string)=>{read.columns=columns;return query},eq:(key:string,value:unknown)=>{read.filters[key]=value;return query},
      limit:(n:number)=>{zero=n===0;read.limit=n;return query},abortSignal:(signal:AbortSignal)=>{read.signal=signal;return query},
      maybeSingle:async()=>result(),then:(resolve:(value:ReturnType<typeof result>)=>unknown,reject:(error:unknown)=>unknown)=>Promise.resolve().then(result).then(resolve,reject)}
    return query
  },rpc(name:string){
    expect(['sms_commercial_quote_guard_ready','sms_plan_quote_guard_ready','sms_quote_chain_ready']).toContain(name)
    const entry:{name:string;signal?:AbortSignal}={name};rpcs.push(entry)
    const result=()=>{
      if(name!==options.guard)return {data:true,error:null}
      if(options.guardFailure==='throw')throw new Error('offline guard unavailable')
      return {data:'guardValue' in options ? options.guardValue : false,error:options.guardFailure==='missing'?{code:'PGRST202'}:options.guardFailure==='denied'?{code:'42501'}:null}
    }
    const query={abortSignal:(signal:AbortSignal)=>{entry.signal=signal;return query},
      then:(resolve:(value:ReturnType<typeof result>)=>unknown,reject:(error:unknown)=>unknown)=>Promise.resolve().then(result).then(resolve,reject)}
    return query
  }} as unknown as SupabaseClient
  return {db,reads,rpcs}
}
const code=transpileModule(readFileSync('scripts/receptionist-runtime/readiness.ts.template','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText
function runtime(db:SupabaseClient,trade:string,now?:number) {
  const runtimeModule={exports:{}}
  runInNewContext(code,{exports:runtimeModule.exports,module:runtimeModule,AbortSignal,
    Date:class extends Date {static now(){return now ?? Date.now()}},
    process:{cwd:()=>'/offline',env:{CRON_SECRET:'offline',SIM_API_KEY:'offline',SMS_SIMULATE_ENABLED:'1',SMS_READINESS_TENANT_ID:tenant,NEXT_PUBLIC_SUPABASE_URL:'https://offline.invalid',SUPABASE_SERVICE_ROLE_KEY:'offline'}},
    require:(name:string)=>{
      if (name==='@supabase/supabase-js') return {createClient:()=>db}
      if (name==='node:fs') return {readFileSync:(file:string)=>JSON.stringify(file.endsWith('build-attestation.json') ? {version:1,sourceHash:'fixture-release'} : {sourceHash:'fixture-release',contractVersion:2,trade})}
      if (name==='node:path') return {resolve:(...parts:string[])=>parts.join('/')}
      if (name.endsWith('public-origin')) return {publicWebOrigin:()=> 'https://public.fixture.invalid'}
      if (name.endsWith('public-schema')) return {verifyPublicQuoteSchema,JOB_QUOTE_OPERATION_SCHEMA}
      if (name.endsWith('pricing-readiness')) return {tenantPricingReadiness}
      throw new Error(`Unexpected dependency ${name}`)
    }})
  return runtimeModule.exports as {receptionistReadiness:(trade:string)=>Promise<{ok:boolean;capabilities:{quote:boolean;conversation:boolean};checks:{name:string;ok:boolean}[]}>}
}

describe('actual trade readiness uses owned estimator pricing gates',()=>{
  it.each([
    ['current','2026-09-09T00:00:00.000Z',true],
    ['just inside 24 hours','2026-09-08T00:00:00.001Z',true],
    ['exactly 24 hours old','2026-09-08T00:00:00.000Z',false],
    ['one millisecond future','2026-09-09T00:00:00.001Z',false],
    ['future year','2099-01-01T00:00:00.000Z',false],
    ['malformed','not-a-date',false],
    ['null',null,false],
    ['missing',undefined,false],
  ])('%s synthetic proof must have a finite age within the past 24 hours',async(_label,proofAt,expected)=>{
    const {db}=fixture([book('solar')],{proofAt})
    const result=await runtime(db,'solar',Date.parse('2026-09-09T00:00:00.000Z')).receptionistReadiness('solar')
    expect(result.ok).toBe(expected);expect(result.capabilities.quote).toBe(expected)
    expect(result.capabilities.conversation).toBe(true)
    expect(result.checks.filter(check=>!check.ok)).toEqual(expected ? [] : [{name:'synthetic_workflow',ok:false}])
  })
  it.each(trades)('%s has a green control with owned complete setup',async trade=>{
    const {db,reads}=fixture([book(trade)])
    const result=await runtime(db,trade).receptionistReadiness(trade)
    expect(result.ok).toBe(true);expect(result.capabilities.quote).toBe(true)
    const pricing=reads.find(read=>read.table==='pricing_book')!
    expect(pricing.filters.tenant_id).toBe(tenant);expect(pricing.signal).toBeInstanceOf(AbortSignal)
  })
  for (const trade of trades) {
    it.each(['missing','wrong tenant','database error','throwing database'])(`${trade}: %s fails closed without disabling conversation`,async kind=>{
      const row=book(trade)
      if (kind==='wrong tenant') row.tenant_id='another-tenant'
      const {db}=fixture(kind==='missing' ? [] : [row],{wrongTenantResponse:kind==='wrong tenant',error:kind==='database error',throwRead:kind==='throwing database'})
      const result=await runtime(db,trade).receptionistReadiness(trade)
      expect(result.ok).toBe(false);expect(result.capabilities.quote).toBe(false)
      expect(result.capabilities.conversation).toBe(true)
      expect(result.checks.filter(check=>!check.ok)).toEqual([{name:'tenant_pricing',ok:false}])
    })
  }
  for (const trade of ['roofing','painting','solar'] as const) {
    it.each(['unknown fields','empty','missing GST','nonfinite'])(`${trade}: %s cannot certify a complete card`,async kind=>{
      const row=book(trade),overlay=row.overlays as Record<string,Record<string,unknown>>
      const key=`${trade}_rate_card`
      if (kind==='unknown fields') overlay[key]={fixture_rate:1}
      if (kind==='empty') overlay[key]={}
      if (kind==='missing GST') delete overlay[key].gst_registered
      if (kind==='nonfinite') overlay[key].call_out_minimum_ex_gst=Number.POSITIVE_INFINITY
      const {db}=fixture([row])
      expect((await runtime(db,trade).receptionistReadiness(trade)).checks.filter(check=>!check.ok)).toEqual([{name:'tenant_pricing',ok:false}])
    })
  }
  it.each(['electrical','plumbing'])('%s generic setup requires exact book trade and GST without plan-only assemblies',async trade=>{
    for (const patch of [{trade:'roofing'},{gst_registered:null},{id:null}]) {
      expect(await tenantPricingReadiness(fixture([{...book(trade),...patch}]).db,tenant,trade,null)).toBe(false)
    }
    expect(await tenantPricingReadiness(fixture([book(trade)]).db,tenant,trade,null)).toBe(true)
  })
  it('keeps established specialty fallback selection, including an invalid preferred solar row',async()=>{
    const solar=book('solar');solar.trade='electrical'
    expect(await tenantPricingReadiness(fixture([solar]).db,tenant,'solar','electrical')).toBe(true)
    expect(await tenantPricingReadiness(fixture([{...book('solar'),overlays:{}},solar]).db,tenant,'solar','electrical')).toBe(false)
    const paint=book('painting');paint.trade='electrical'
    expect(await tenantPricingReadiness(fixture([paint]).db,tenant,'painting','electrical')).toBe(true)
    const roof=book('roofing');roof.trade='electrical'
    expect(await tenantPricingReadiness(fixture([roof]).db,tenant,'roofing','electrical')).toBe(true)
  })
  it.each([undefined,'42P01','42703'])('zero-row job operations probe distinguishes empty schema from missing table/column (%s)',async schemaError=>{
    const {db,reads}=fixture([book('solar')],{schemaError})
    const result=await runtime(db,'solar').receptionistReadiness('solar')
    expect(result.ok).toBe(!schemaError);expect(result.capabilities.quote).toBe(!schemaError)
    expect(reads.find(read=>read.table==='job_quote_operations')).toMatchObject({limit:0,
      columns:'tenant_id,operation_id,request_hash,intake_id,quote_id,status,pinned,pin_requested,created_at,updated_at'})
    expect(result.checks.find(check=>check.name==='schema:job_quote_operations')?.ok).toBe(!schemaError)
  })
  for(const [name,guard] of [['commercial_quote_guard','sms_commercial_quote_guard_ready'],['plan_quote_guard','sms_plan_quote_guard_ready'],['quote_chain','sms_quote_chain_ready']]) {
    it.each(['false','missing','denied','throw'])(`${name}: %s disables quotes but preserves conversation capability`,async guardFailure=>{
      const {db,rpcs}=fixture([book('solar')],{guard,guardFailure})
      const result=await runtime(db,'solar').receptionistReadiness('solar')
      expect(result.ok).toBe(false);expect(result.capabilities.quote).toBe(false);expect(result.capabilities.conversation).toBe(true)
      expect(result.checks.filter(check=>!check.ok)).toEqual([{name:`schema:${name}`,ok:false}])
      expect(rpcs.find(call=>call.name===guard)?.signal).toBeInstanceOf(AbortSignal)
    })
  }
  it.each([null,1,'true',{ready:true}])('quote chain requires exact Boolean true, not %j',async guardValue=>{
    const {db}=fixture([book('solar')],{guard:'sms_quote_chain_ready',guardValue})
    const result=await runtime(db,'solar').receptionistReadiness('solar')
    expect(result.ok).toBe(false);expect(result.capabilities.quote).toBe(false);expect(result.capabilities.conversation).toBe(true)
    expect(result.checks.filter(check=>!check.ok)).toEqual([{name:'schema:quote_chain',ok:false}])
  })
})
