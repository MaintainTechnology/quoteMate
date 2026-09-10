import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const h=vi.hoisted(()=>({engine:vi.fn(),config:vi.fn(),rates:vi.fn(),payloads:vi.fn(),handoff:vi.fn(),rpc:vi.fn(),lookup:vi.fn()}))
vi.mock('@/lib/solar/intake',()=>({runSolarEstimate:h.engine}))
vi.mock('@/lib/solar/config',()=>({loadSolarConfig:h.config}))
vi.mock('@/lib/solar/rate-card-overlay',()=>({loadSolarTenantRates:h.rates}))
vi.mock('@/lib/solar/persist-helpers',()=>({buildSolarRowPayloads:h.payloads}))
vi.mock('@/lib/solar/geocode',()=>({geocodeAddress:vi.fn()}))
vi.mock('@/lib/solar/network-lookup',()=>({resolveNetworkFromPostcode:()=> 'Ausgrid'}))
vi.mock('./human-handoff',()=>({persistHumanHandoff:h.handoff}))
vi.mock('./durable-work',()=>({currentSmsWork:()=>({jobId:'work-1',ownerToken:'owner-1'})}))
import { solarSmsNext, saveSolarSmsEstimate, handleSolarSmsTurn, type SolarSmsState } from './solar-receptionist'
import { MAX_REQUESTED_SYSTEM_KW } from '@/lib/solar/limits'
const from=()=>{const q:Record<string,unknown>={};for(const method of ['select','eq'])q[method]=()=>q;q.maybeSingle=h.lookup;return q}
const db={from,rpc:h.rpc} as unknown as SupabaseClient
const overlay={install_rate_per_kw:{standard_panels:1000,premium_panels:1500},multi_storey_loading_pct:10,complex_roof_loading_pct:10,call_out_minimum_ex_gst:0,stc_price_aud:20,gst_registered:true}
const state:SolarSmsState={address:{address:'5 Smith Street, Sydney',state:'NSW',postcode:'2000'},confirmed:true,phase:'single',panelType:'standard_panels',step:'estimate'}
const saved={id:'solar-id',public_token:'saved_solar_token_123',address:'5 Smith Street',created_at:'2026-09-08'}
const args={supabase:db,tenantId:'tenant-1',customerPhone:'+61411111111',requestKey:'work-1',state}
beforeEach(()=>{vi.clearAllMocks();h.lookup.mockResolvedValue({data:null,error:null});h.config.mockResolvedValue({});h.rates.mockResolvedValue({config:{},rateCard:{},overlay});h.engine.mockResolvedValue({estimate:'actual'});h.payloads.mockReturnValue({intake:{a:1},quote:{b:2},solarEstimate:{c:3}});h.rpc.mockResolvedValue({data:saved,error:null});h.handoff.mockResolvedValue({id:'task-1',notified:false})})
describe('active solar gathering captures corrections before choosing the next question',()=>{
  it('captures a corrected phase together with the requested panel answer',async()=>{
    const previous:SolarSmsState={...state,step:'panels',panelType:undefined}
    const result=solarSmsNext('Actually it is three phase, premium panels',previous)
    expect(result).toMatchObject({ready:true,state:{phase:'three',panelType:'premium_panels',confirmed:true}})
    expect(previous).toMatchObject({phase:'single',panelType:undefined})
    await handleSolarSmsTurn({...args,state:previous,text:'Actually it is three phase, premium panels',baseUrl:'https://quotemax.com.au',conversationId:'conv-1',sendReply:async()=>({ok:true})})
    expect(h.engine).toHaveBeenCalledTimes(1)
    expect(h.engine).toHaveBeenCalledWith(expect.objectContaining({phase:'three',panelType:'premium_panels',input:state.address}))
  })
  it('retains supplied phase and panels while waiting for address confirmation',()=>{
    const offered=solarSmsNext('Three phase and premium panels',{...state,confirmed:false,phase:undefined,panelType:undefined,step:'confirm_address'})
    expect(offered).toMatchObject({ready:false,state:{confirmed:false,phase:'three',panelType:'premium_panels',step:'confirm_address'}})
    expect(solarSmsNext('yes',offered.state)).toMatchObject({ready:true,state:{confirmed:true,phase:'three',panelType:'premium_panels'}})
  })
  it.each([
    ['Actually postcode is 3000','NSW','3000'],
    ['Actually VIC','VIC','2000'],
    ['Actually VIC 3000','VIC','3000'],
    ['Actually 3000 VIC','VIC','3000'],
    ['Yes, postcode is 3000','NSW','3000'],
  ])('requires a fresh address readback after %s',(text,region,postcode)=>{
    const result=solarSmsNext(text,{...state,step:'panels'})
    expect(result).toMatchObject({ready:false,state:{confirmed:false,step:'confirm_address',address:{address:state.address!.address,state:region,postcode}}})
    expect(result.reply).toContain(`${region} ${postcode}`)
    expect(state.address).toEqual({address:'5 Smith Street, Sydney',state:'NSW',postcode:'2000'})
    expect(solarSmsNext('yes',result.state)).toMatchObject({ready:true,state:{confirmed:true}})
  })
  it('cannot confirm a changed postcode in the same affirmative message',()=>{
    const result=solarSmsNext('Yes, postcode is 3000',{...state,confirmed:false,step:'confirm_address'})
    expect(result).toMatchObject({ready:false,state:{confirmed:false,step:'confirm_address',address:{postcode:'3000'}}})
  })
  it('does not accept a negated address confirmation',()=>{
    const result=solarSmsNext('No, that is not correct',{...state,confirmed:false,step:'confirm_address'})
    expect(result).toMatchObject({ready:false,state:{confirmed:false,step:'confirm_address'}})
  })
  it('reconfirms a corrected street before running any estimate',async()=>{
    const sendReply=vi.fn().mockResolvedValue({ok:true})
    const result=await handleSolarSmsTurn({...args,text:'Actually 12 Jones Road, Melbourne VIC 3000',baseUrl:'https://quotemax.com.au',conversationId:'conv-1',sendReply})
    expect(result.state).toMatchObject({confirmed:false,step:'confirm_address',address:{address:'12 Jones Road, Melbourne VIC 3000',state:'VIC',postcode:'3000'}})
    expect(h.engine).not.toHaveBeenCalled();expect(h.rpc).not.toHaveBeenCalled()
    expect(sendReply).toHaveBeenCalledTimes(1)
  })
  it.each(['three bedrooms','single-storey home','threefold increase','13 phase'])('does not infer supply phase from %s',text=>{
    const result=solarSmsNext(text,{...state,phase:undefined,step:'phase'})
    expect(result).toMatchObject({ready:false,state:{step:'phase',address:state.address,confirmed:true}})
    expect(result.state.phase).toBeUndefined()
  })
  it.each([['3 phase','three'],['three-phase','three'],['1 phase','single'],['single-phase','single']])('recognises the precise phase answer %s without replacing the address',(text,phase)=>{
    expect(solarSmsNext(text,{...state,phase:undefined,step:'phase'})).toMatchObject({ready:true,state:{phase,address:state.address,confirmed:true}})
  })
  it.each(['single phase or three phase','single or three phase','3 phase and 1 phase'])('asks for one phase after conflicting tokens: %s',text=>{
    const result=solarSmsNext(`${text}, premium panels`,{...state,step:'panels',panelType:undefined})
    expect(result).toMatchObject({ready:false,state:{step:'phase',panelType:'premium_panels',address:state.address}})
    expect(result.state.phase).toBeUndefined()
    expect(result.reply).toMatch(/single.phase.*three.phase/i)
    expect(solarSmsNext('three-phase',result.state)).toMatchObject({ready:true,state:{phase:'three',panelType:'premium_panels'}})
  })
  it.each(['No, it is three phase, premium panels','Three phase, no battery, premium panels'])('captures a definite phase without treating unrelated negation as supply uncertainty: %s',text=>{
    expect(solarSmsNext(text,{...state,step:'panels'})).toMatchObject({ready:true,state:{phase:'three',panelType:'premium_panels'}})
  })
  it.each(['not three phase','not sure if it is three phase',"I don't have three phase, premium panels",'I do not have three phase, premium panels'])('asks again instead of silently using an uncertain or negated supply: %s',text=>{
    const result=solarSmsNext(text,{...state,step:'panels'})
    expect(result).toMatchObject({ready:false,state:{step:'phase'}})
    expect(result.state.phase).toBeUndefined()
  })
  it.each(['not premium panels',"I don't want premium panels"] )('does not select an explicitly rejected panel choice: %s',text=>{
    const result=solarSmsNext(text,{...state,step:'panels'})
    expect(result).toMatchObject({ready:false,state:{step:'panels',address:state.address}})
    expect(result.state.panelType).toBeUndefined()
  })
  it('passes a corrected explicit system size to the actual estimator boundary',async()=>{
    const result=await handleSolarSmsTurn({...args,state:{...state,requestedSizeKw:6.6,step:'panels'},text:'Actually make it 10kW, premium panels',baseUrl:'https://quotemax.com.au',conversationId:'conv-1',sendReply:async()=>({ok:true})})
    expect(result.state).toMatchObject({requestedSizeKw:10,panelType:'premium_panels',address:state.address})
    expect(h.engine).toHaveBeenCalledTimes(1)
    expect(h.engine).toHaveBeenCalledWith(expect.objectContaining({requestedSizeKw:10,panelType:'premium_panels',input:state.address}))
  })
  it.each(['0 kW','-5 kW',`${MAX_REQUESTED_SYSTEM_KW+1} kW`,'1000 kW','10kW or 15kW','10-15 kW','10 to 15 kW','not 10kW'])('keeps an explicit invalid or unresolved capacity out of estimation: %s',text=>{
    const next=solarSmsNext(`${text}, premium panels`,{...state,requestedSizeKw:6.6})
    expect(next.ready).toBe(false);expect(next.state.requestedSizeKw).toBeUndefined()
    expect(next.reply).toMatch(/kW/)
    const unrelated=solarSmsNext('premium panels',next.state)
    expect(unrelated.ready).toBe(false)
    expect(solarSmsNext('10 kW',unrelated.state)).toMatchObject({ready:true,state:{requestedSizeKw:10,address:state.address}})
  })
  it.each([0.5,6.6,MAX_REQUESTED_SYSTEM_KW])('accepts an existing-contract system size of %s kW',size=>{
    expect(solarSmsNext(`${size}kW`,state)).toMatchObject({ready:true,state:{requestedSizeKw:size,address:state.address}})
  })
  it('never reads address digits or battery kWh as requested solar array size',()=>{
    const capacity=solarSmsNext('A 10 kWh battery, premium panels',{...state,requestedSizeKw:6.6,step:'panels'})
    expect(capacity).toMatchObject({ready:true,state:{requestedSizeKw:6.6,address:state.address}})
    const address=solarSmsNext('10 Smith Street, Sydney NSW 2000',{...state,requestedSizeKw:6.6})
    expect(address).toMatchObject({ready:false,state:{confirmed:false,requestedSizeKw:6.6}})
  })
  it('retains unresolved size across address confirmation without running an estimate',async()=>{
    const next=solarSmsNext('12 Jones Road, Melbourne VIC 3000; 10kW or 15kW',state)
    expect(next.state).toMatchObject({confirmed:false,step:'confirm_address',sizeClarificationRequired:true})
    const sendReply=vi.fn().mockResolvedValue({ok:true})
    const confirmed=await handleSolarSmsTurn({...args,state:next.state,text:'yes',baseUrl:'https://quotemax.com.au',conversationId:'conv-1',sendReply})
    expect(confirmed.state).toMatchObject({confirmed:true,step:'system_size',sizeClarificationRequired:true})
    expect(h.engine).not.toHaveBeenCalled();expect(h.rpc).not.toHaveBeenCalled();expect(sendReply).toHaveBeenCalledTimes(1)
  })
  it.each([0,-1,Infinity,NaN,MAX_REQUESTED_SYSTEM_KW+1])('refuses a persisted invalid preferred system size at the estimator boundary: %s',async requestedSizeKw=>{
    await expect(saveSolarSmsEstimate({...args,state:{...state,requestedSizeKw}})).rejects.toThrow('brief incomplete')
    expect(h.engine).not.toHaveBeenCalled();expect(h.config).not.toHaveBeenCalled()
  })
  it('refuses a persisted unresolved-size flag at the estimator boundary',async()=>{
    await expect(saveSolarSmsEstimate({...args,state:{...state,sizeClarificationRequired:true}})).rejects.toThrow('brief incomplete')
    expect(h.engine).not.toHaveBeenCalled();expect(h.config).not.toHaveBeenCalled()
  })
})

describe('solar facts use the deterministic estimator and durable saved review path',()=>{
  it('gathers real address, confirms it and asks phase/panels without assuming a state',()=>{
    const incomplete=solarSmsNext('5 Smith Street')
    expect(incomplete.ready).toBe(false);expect(incomplete.state.address?.state).toBeFalsy()
    const address=solarSmsNext('5 Smith Street, Sydney NSW 2000')
    expect(address.state.step).toBe('confirm_address')
    const confirm=solarSmsNext('yes',address.state);expect(confirm.state.step).toBe('phase')
    const phase=solarSmsNext('not sure',confirm.state);expect(phase.state.phase).toBe('unknown');expect(phase.state.step).toBe('panels')
    const panels=solarSmsNext('standard',phase.state);expect(panels.ready).toBe(true);expect(panels.state.panelType).toBe('standard_panels')
  })
  it('saves the existing estimator output and atomic token under tenant and worker ownership',async()=>{
    expect(await saveSolarSmsEstimate(args)).toMatchObject({family:'solar',token:saved.public_token,stage:'awaiting_review'})
    expect(h.engine).toHaveBeenCalledWith(expect.objectContaining({input:state.address,phase:'single',panelType:'standard_panels'}))
    expect(h.rpc).toHaveBeenCalledWith('sms_save_solar_estimate',expect.objectContaining({p_tenant_id:'tenant-1',p_request_key:'work-1',p_customer_phone:args.customerPhone,p_work_id:'work-1',p_work_owner:'owner-1',p_solar:{c:3}}))
  })
  it('replays the same token before any provider or pricing work',async()=>{
    h.lookup.mockResolvedValue({data:saved,error:null})
    expect((await saveSolarSmsEstimate(args)).token).toBe(saved.public_token)
    expect(h.engine).not.toHaveBeenCalled();expect(h.rates).not.toHaveBeenCalled();expect(h.rpc).not.toHaveBeenCalled()
  })
  it('never estimates using missing monetary tenant rates',async()=>{
    h.rates.mockResolvedValue({config:{},rateCard:{},overlay:{...overlay,stc_price_aud:undefined}})
    await expect(saveSolarSmsEstimate(args)).rejects.toThrow('pricing setup')
    expect(h.engine).not.toHaveBeenCalled();expect(h.rpc).not.toHaveBeenCalled()
  })
  it('persists actionable recovery before claiming a saved request and never emits a failed token',async()=>{
    h.rpc.mockResolvedValue({data:null,error:{message:'PGRST204'}})
    const sendReply=vi.fn().mockResolvedValue({ok:true})
    const result=await handleSolarSmsTurn({...args,text:'please continue',baseUrl:'https://quotemax.com.au',conversationId:'conv-1',sendReply})
    expect(result.stage).toBe('unavailable');expect(result.reference).toBeUndefined()
    expect(h.handoff).toHaveBeenCalledWith(expect.objectContaining({requestKey:'work-1:solar-recovery',reason:expect.stringMatching(/could not be saved/)}))
    expect(h.handoff.mock.invocationCallOrder[0]).toBeLessThan(sendReply.mock.invocationCallOrder[0])
    expect(sendReply.mock.calls[0][0]).not.toMatch(/https?:|\$/)
  })
  it('holds a successful saved draft for explicit installer review, with no customer quote URL',async()=>{
    const sendReply=vi.fn().mockResolvedValue({ok:true})
    const result=await handleSolarSmsTurn({...args,text:'continue',baseUrl:'https://quotemax.com.au',conversationId:'conv-1',sendReply})
    expect(result.state.reference?.token).toBe(saved.public_token);expect(result.stage).toBe('awaiting_review')
    expect(h.handoff).toHaveBeenCalledWith(expect.objectContaining({resourceType:'solar',resourceId:'solar-id'}))
    expect(sendReply.mock.calls[0][0]).toMatch(/awaiting.*review/);expect(sendReply.mock.calls[0][0]).not.toContain(saved.public_token)
  })
  it('propagates a failed reply for durable retry rather than silently completing the turn',async()=>{
    await expect(handleSolarSmsTurn({...args,text:'continue',baseUrl:'https://quotemax.com.au',conversationId:'conv-1',sendReply:async()=>({ok:false})})).rejects.toThrow('status send failed')
  })
})
