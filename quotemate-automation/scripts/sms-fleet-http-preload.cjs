// Offline database/provider seams for an unchanged compiled Nest HTTP process.
/* eslint-disable @typescript-eslint/no-require-imports -- Instruments the CommonJS candidate before bootstrap. */
const Module=require('node:module')
const {resolve}=require('node:path')
const assert=require('node:assert/strict')

function fixtureClient(call,unexpected) {
  return {
    rpc:(name,args={})=>call('rpc',{name,args}),
    from(table) {
      const state={table,action:'select',filters:[],orders:[]}
      const query={
        select:(columns='*',options={})=>{state.columns=columns;state.head=options.head;return query},
        insert:payload=>{state.action='insert';state.payload=payload;return query},
        update:payload=>{state.action='update';state.payload=payload;return query},
        upsert:(payload,options={})=>{state.action='upsert';state.payload=payload;state.conflict=options.onConflict;state.ignoreDuplicates=options.ignoreDuplicates;return query},
        delete:()=>{state.action='delete';return query},
        order:(key,options={})=>{state.orders.push({key,...options});return query},
        limit:limit=>{state.limit=limit;return query},
        single:()=>{state.single='single';return query},
        maybeSingle:()=>{state.single='maybeSingle';return query},
        abortSignal:()=>query,
        then:(fulfilled,rejected)=>call('query',state).then(fulfilled,rejected),
      }
      for(const op of ['eq','neq','gte','lte','gt','lt','is','in','contains','like','ilike'])query[op]=(key,value)=>{state.filters.push({op,key,value});return query}
      query.or=value=>{state.filters.push({op:'or',value});return query}
      query.not=(key,op,value)=>{state.filters.push({key,op,value,negated:true});return query}
      query.filter=(key,op,value)=>{state.filters.push({key,op,value});return query}
      return query
    },
    storage:{from:()=>new Proxy({}, {get:(_,name)=>()=>{throw unexpected(`Unexpected storage ${String(name)}`)}})},
    auth:{getUser:async()=>({data:{user:null},error:null})},
  }
}
module.exports={fixtureClient}

if(process.env.QM_COMPOSITION_ENDPOINT) {
  const {fixture,createModelProvider,providerResponse}=require('./sms-route-provider-fixtures.cjs')
  const candidate=process.cwd(),endpoint=process.env.QM_COMPOSITION_ENDPOINT,trade=process.env.QM_COMPOSITION_TRADE
  const config=fixture(trade),nativeFetch=global.fetch,originalLoad=Module._load
  const unexpected=message=>{const error=new Error(message);process.send?.({event:'unexpected',message,stack:error.stack});return error}
  async function call(path,body) {
    const response=await nativeFetch(`${endpoint}/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)})
    assert.ok(response.ok,'Parent fixture rejected request')
    return response.json()
  }
  const record=event=>call('event',{...event,pid:process.pid,trade})
  const model=createModelProvider(config,record)
  const modelCall=method=>async options=>{
    try {model.setTurn((await call('turn',{})).turn);return await model[method](options)}
    catch(error){throw unexpected(`Provider fixture ${method}: ${error.message}`)}
  }
  const db=fixtureClient(call,unexpected)
  const functions=new Map([
    ['lib/intake/structure',['structureIntake']],['lib/estimate/run',['runEstimation']],
    ['lib/roofing/measure',['measureAndPriceRoofs']],['lib/roofing/pricing',['priceMultiRoof']],
    ['lib/painting/measure',['estimatePainting']],['lib/painting/pricing',['calculatePaintingPrice']],
    ['lib/solar/intake',['runSolarEstimate']],['lib/solar/pricing',['calculateSolarPrice']],
  ].map(([path,names])=>[resolve(candidate,'dist',path+'.js'),names]))
  const wrapped=new Map(),twilioPath=resolve(candidate,'dist/lib/sms/twilio.js')
  Module._load=function(request,parent) {
    if(request==='@supabase/supabase-js')return {...originalLoad.apply(this,arguments),createClient:()=>db}
    if(request==='ai')return {...originalLoad.apply(this,arguments),generateObject:modelCall('generateObject'),generateText:modelCall('generateText'),
      embed:async()=>{await record({kind:'provider',operation:'embedding'});return {embedding:Array(1536).fill(0.01),usage:{tokens:1}}}}
    if(request==='stripe')return class OfflineStripe {
      constructor(key) {
        assert.equal(key,'sk_test_offline')
        const strict=value=>new Proxy(value,{get(target,name){if(Object.hasOwn(target,name))return target[name];throw unexpected(`Unexpected Stripe operation ${String(name)}`)}})
        return strict({checkout:strict({sessions:strict({create:parameters=>call('stripe-session',{parameters})})})})
      }
    }
    let path
    try{path=Module._resolveFilename(request,parent)}catch{return originalLoad.apply(this,arguments)}
    if(path===twilioPath)return {...originalLoad.apply(this,arguments),
      sendSms:async options=>{const response=await call('carrier',{...options,trade,pid:process.pid});return {ok:true,sid:response.sid,status:'queued',raw:{sid:response.sid}}},
      sendWhatsApp:async()=>{throw unexpected('Unexpected WhatsApp fallback')},
      readTwilioMessage:async()=>{throw unexpected('Unexpected carrier reconciliation')},
    }
    if(functions.has(path)) {
      if(!wrapped.has(path)) {
        const actual=originalLoad.apply(this,arguments),result={...actual}
        for(const name of functions.get(path)) {
          assert.equal(typeof actual[name],'function')
          result[name]=function(...args){
            try {
              const book=config.seed.pricing_book[0]
              if(name==='runEstimation'){assert.equal(args[1].id,book.id);assert.equal(args[1].tenant_id,book.tenant_id);assert.equal(args[1].hourly_rate,book.hourly_rate)}
              if(name==='priceMultiRoof')assert.equal(args[0].rateCard.reroof_rate_per_m2.colorbond_corrugated,book.overlays.roofing_rate_card.reroof_rate_per_m2.colorbond_corrugated)
              if(name==='calculatePaintingPrice')assert.equal(args[0].rateCard.rate_per_unit.walls,book.overlays.painting_rate_card.rate_per_unit.walls)
              if(name==='calculateSolarPrice')assert.equal(args[0].rateCard.install_rate_per_kw.standard_panels,book.overlays.solar_rate_card.install_rate_per_kw.standard_panels)
            } catch(error){throw unexpected(`Actual pricing inputs: ${error.message}`)}
            process.send?.({event:'real-function',name,path});return Reflect.apply(actual[name],this,args)
          }
        }
        wrapped.set(path,result)
      }
      return wrapped.get(path)
    }
    return originalLoad.apply(this,arguments)
  }
  const engineOrigin=new URL(process.env.ENGINE_BASE_URL).origin
  global.fetch=async(input,options)=>{
    const request=new Request(input,options),url=new URL(request.url)
    if(url.origin===endpoint||url.origin===engineOrigin)return nativeFetch(input,options)
    let response
    try{response=await providerResponse(url,request)}catch(error){throw unexpected(`Provider request: ${error.message}`)}
    if(response){await record({kind:'provider',operation:url.hostname+url.pathname});return response}
    throw unexpected(`Unexpected external I/O ${url.origin}${url.pathname}`)
  }
  for(const name of ['node:http','node:https'])for(const method of ['request','get'])require(name)[method]=()=>{throw unexpected(`Unexpected ${name}.${method}`)}
  const net=require('node:net'),originalConnect=net.Socket.prototype.connect
  const allowedPorts=new Set([Number(new URL(endpoint).port),Number(new URL(engineOrigin).port)])
  net.Socket.prototype.connect=function(...args) {
    const first=Array.isArray(args[0])?args[0][0]:args[0],host=typeof first==='object'?first?.host:args[1],port=typeof first==='object'?first?.port:first
    if(host!=='127.0.0.1'||!allowedPorts.has(Number(port)))throw unexpected(`Unexpected socket ${String(host)}:${String(port)}`)
    return Reflect.apply(originalConnect,this,args)
  }
  require('node:tls').connect=()=>{throw unexpected('Unexpected TLS transport')}
}
