// Loads the candidate's real POST handlers and specialists. Only database and
// external provider boundaries are adapted; no production files are rewritten.
/* eslint-disable @typescript-eslint/no-require-imports -- This test loader instruments the candidate's CommonJS require boundary. */
const {createRequire}=require('node:module')
const Module=require('node:module')
const {resolve}=require('node:path')
const assert=require('node:assert/strict')
const {fixture,createModelProvider,providerResponse,CUSTOMER,TO}=require('./sms-route-provider-fixtures.cjs')
const [candidate,endpoint,trade,mode,turnText,sid,bodyOverride]=process.argv.slice(2)
const turn=Number(turnText??0)
const config=fixture(trade)
if(process.env.SMS_ROUTE_TEST_RANDOM!==undefined) {
  const value=Number(process.env.SMS_ROUTE_TEST_RANDOM)
  assert.ok(['electrical','plumbing'].includes(trade)&&[0,0.99].includes(value),'Random-variant fixture is limited to generic replay scenarios')
  Math.random=()=>value
}
const load=createRequire(resolve(candidate,'package.json'))
const originalLoad=Module._load
const nativeFetch=global.fetch
const unexpectedErrors=[]
const unexpected=message=>{unexpectedErrors.push(message);process.send?.({event:'unexpected',message});return new Error(message)}
const realFunctions=new Map([
  ['lib/intake/structure',['structureIntake']],['lib/estimate/run',['runEstimation']],
  ['lib/roofing/measure',['measureAndPriceRoofs']],['lib/roofing/pricing',['priceMultiRoof']],
  ['lib/painting/measure',['estimatePainting']],['lib/painting/pricing',['calculatePaintingPrice']],
  ['lib/solar/intake',['runSolarEstimate']],['lib/solar/pricing',['calculateSolarPrice']],
].map(([path,names])=>[resolve(candidate,'dist',`${path}.js`),names]))
const wrappedModules=new Map()
const gateStage=process.env.SMS_ROUTE_TEST_GATE??''
let gateReached=false
const currentWork=()=>load(resolve(candidate,'dist/lib/sms/durable-work.js')).currentSmsWork()
async function pauseAtBoundary(phase,path,body,result) {
  if(!gateStage||gateReached)return
  const work=currentWork()
  if(!work)return
  const pricedTable=trade==='painting'?'painting_measurements':trade==='roofing'?'roofing_measurements':trade==='solar'?'solar_estimates':'quotes'
  const atomicSolarSave=trade==='solar'&&path==='rpc'&&body.name==='sms_save_solar_estimate'
  const resultWrite=(path==='query'&&body.table===pricedTable&&['insert','upsert'].includes(body.action))||atomicSolarSave
  if(atomicSolarSave) {
    assert.equal(body.args.p_work_id,work.jobId,'Solar persistence must use the actual handler work owner')
    assert.equal(body.args.p_work_owner,work.ownerToken)
    if(phase==='after'&&!result.error)assert.ok(result.data?.id&&result.data?.public_token,'Successful solar result boundary must return its saved identity')
  }
  const historyRead=path==='query'&&body.table==='sms_messages'&&body.action==='select'&&body.columns==='direction, body, created_at'
  const matched=(gateStage==='before-history'&&phase==='before'&&historyRead)
    ||(gateStage==='after-history'&&phase==='after'&&path==='rpc'&&body.name==='checkpoint_sms_work'&&body.args.p_name==='history')
    ||(gateStage==='before-result-save'&&phase==='before'&&resultWrite)
    ||(gateStage==='after-result-save'&&phase==='after'&&resultWrite&&!result.error)
    ||(gateStage==='after-publication'&&phase==='after'&&path==='rpc'&&body.name==='sms_outbox_finish'&&body.args.p_status==='accepted'&&result.data?.to_number===CUSTOMER&&
      (['electrical','plumbing'].includes(trade)?work.job.kind==='estimate':true))
    ||(gateStage==='before-unlock'&&phase==='before'&&path==='query'&&body.table==='sms_conversations'&&body.action==='update'&&Object.hasOwn(body.payload,'last_processed_work_sequence'))
  if(!matched)return
  gateReached=true
  const evidence={event:'paused',stage:gateStage,phase,path,table:body.table,rpc:body.name,pid:process.pid,
    jobId:work.jobId,ownerToken:work.ownerToken,kind:work.job.kind,serialKey:work.job.serial_key,sequence:work.sequence,checkpointNames:Object.keys(work.job.checkpoint)}
  await new Promise(resolvePause=>{
    const resume=message=>{if(message.event==='resume'){process.off('message',resume);resolvePause()}}
    process.on('message',resume)
    process.send?.(evidence)
  })
}
async function remote(path,body) {
  await pauseAtBoundary('before',path,body)
  const response=await nativeFetch(`${endpoint}/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)})
  if(!response.ok)throw new Error(await response.text())
  const result=await response.json()
  if(result.fixtureError)throw new Error(result.fixtureError)
  await pauseAtBoundary('after',path,body,result)
  return result
}
const record=event=>remote('event',{...event,pid:process.pid,trade})
const model=createModelProvider(config,record,()=>{
  const work=currentWork()
  return work?.job.kind==='inbound'?new URLSearchParams(work.job.payload.body).get('Body')??'':''
})
model.setTurn(turn)
for(const method of ['generateObject','generateText']) {
  const original=model[method]
  model[method]=async options=>{try{return await original(options)}catch(error){throw unexpected(`Provider fixture ${method}: ${error.message}`)}}
}
const db={
  rpc:(name,args={})=>remote('rpc',{name,args}),
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
      then:(fulfilled,rejected)=>remote('query',state).then(fulfilled,rejected),
    }
    for(const op of ['eq','neq','gte','lte','gt','lt','is','in','contains','like','ilike'])query[op]=(key,value)=>{state.filters.push({op,key,value});return query}
    query.or=value=>{state.filters.push({op:'or',value});return query}
    query.not=(key,op,value)=>{state.filters.push({key,op,value,negated:true});return query}
    query.filter=(key,op,value)=>{state.filters.push({key,op,value});return query}
    return query
  },
  storage:{from:()=>new Proxy({}, {get:(_,name)=>()=>{throw unexpected(`Unexpected storage ${String(name)} in held-draft journey`)}})},
  auth:{getUser:async()=>({data:{user:null},error:null})},
}
const twilioPath=resolve(candidate,'dist/lib/sms/twilio.js')
Module._load=function(request,parent) {
  if(request==='@supabase/supabase-js')return {...originalLoad.apply(this,arguments),createClient:()=>db}
  if(request==='ai')return {...originalLoad.apply(this,arguments),generateObject:model.generateObject,generateText:model.generateText,
    embed:async()=>{await record({kind:'provider',operation:'embedding'});return {embedding:Array(1536).fill(0.01),usage:{tokens:1}}}}
  let resolved
  try {resolved=Module._resolveFilename(request,parent)} catch {return originalLoad.apply(this,arguments)}
  if(resolved===twilioPath)return {...originalLoad.apply(this,arguments),
    sendSms:async options=>{const response=await remote('carrier',{...options,trade,pid:process.pid});return {ok:true,sid:response.sid,status:'queued',raw:{sid:response.sid}}},
    sendWhatsApp:async()=>{throw unexpected('Unexpected WhatsApp fallback in successful offline SMS journey')},
    readTwilioMessage:async()=>{throw unexpected('Unexpected carrier reconciliation during held-draft journey')},
  }
  if(realFunctions.has(resolved)) {
    if(!wrappedModules.has(resolved)) {
      const actual=originalLoad.apply(this,arguments),wrapped={...actual}
      for(const name of realFunctions.get(resolved)) {
        assert.equal(typeof actual[name],'function',`Missing actual compiled export ${resolved}:${name}`)
        wrapped[name]=function(...args){
          let pricingBasis=null
          try {
            if(name==='runEstimation') {
              const expected=config.seed.pricing_book[0]
              assert.equal(args[1].id,expected.id);assert.equal(args[1].tenant_id,expected.tenant_id);assert.equal(args[1].hourly_rate,expected.hourly_rate)
              pricingBasis={bookId:args[1].id,hourlyRate:args[1].hourly_rate}
            } else if(name==='priceMultiRoof') {
              assert.equal(args[0].rateCard?.reroof_rate_per_m2?.colorbond_corrugated,91)
              pricingBasis={ownedCorrugatedRate:91}
            } else if(name==='calculatePaintingPrice') {
              assert.equal(args[0].rateCard?.rate_per_unit?.walls,31)
              pricingBasis={ownedWallsRate:31}
            } else if(name==='calculateSolarPrice') {
              assert.equal(args[0].rateCard?.install_rate_per_kw?.standard_panels,1110)
              pricingBasis={ownedStandardPanelRate:1110}
            }
          } catch(error){throw unexpected(`Actual pricing input assertion ${name}: ${error.message}`)}
          process.send?.({event:'real-function',path:resolved,name,pricingBasis})
          return Reflect.apply(actual[name],this,args)
        }
      }
      wrappedModules.set(resolved,wrapped)
    }
    return wrappedModules.get(resolved)
  }
  return originalLoad.apply(this,arguments)
}
global.fetch=async(input,options)=>{
  const request=new Request(input,options),url=new URL(request.url)
  if(url.origin===endpoint)return nativeFetch(input,options)
  let response
  try{response=await providerResponse(url,request)}catch(error){throw unexpected(`Provider request fixture: ${error.message}`)}
  if(response){await record({kind:'provider',operation:url.hostname+url.pathname});return response}
  await remote('unexpected',{kind:'network',url:url.origin+url.pathname})
  throw unexpected(`Unexpected external I/O blocked: ${url.origin}${url.pathname}`)
}
// SDKs that use node:http rather than fetch cannot bypass the offline fence.
for(const name of ['node:http','node:https']) {
  const transport=require(name)
  for(const method of ['request','get'])transport[method]=()=>{throw unexpected(`Unexpected ${name}.${method} network transport`)}
}
// Also fence SDKs with their own Undici/net transport. The sole real socket
// destination is the parent-owned loopback fixture server.
const net=require('node:net'),originalConnect=net.Socket.prototype.connect
net.Socket.prototype.connect=function(...args) {
  const first=Array.isArray(args[0])?args[0][0]:args[0]
  const host=typeof first==='object'?first?.host:args[1]
  const port=typeof first==='object'?first?.port:first
  if(host!=='127.0.0.1'||Number(port)!==Number(new URL(endpoint).port))throw unexpected(`Unexpected socket destination ${String(host)}:${String(port)}`)
  return Reflect.apply(originalConnect,this,args)
}
require('node:tls').connect=()=>{throw unexpected('Unexpected TLS transport')}

async function main() {
  const work=load(resolve(candidate,'dist/lib/sms/durable-work.js'))
  const {smsDeliveryWorkScope}=load(resolve(candidate,'dist/lib/sms/work-delivery-context.js'))
  const inbound=load(resolve(candidate,'dist/receptionist/inbound.route.js')).POST
  const intake=load(resolve(candidate,'dist/intake/structure.route.js')).POST
  const estimate=load(resolve(candidate,'dist/estimate/draft.route.js')).POST
  if(mode==='receipt') {
    const params={From:CUSTOMER,To:TO,MessageSid:sid,Body:bodyOverride??config.turns[turn],NumMedia:'0'}
    assert.ok(params.Body,`Missing ${trade} turn ${turn}`)
    const url='https://offline-service.invalid/api/sms/inbound'
    const twilio=load('twilio')
    const signature=twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN,url,params)
    const result=await inbound(new Request(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':signature},body:new URLSearchParams(params)}))
    assert.ok(result.ok,`Compiled inbound rejected ${result.status}: ${await result.text()}`)
    process.send?.({event:'receipt',pid:process.pid,status:result.status})
    return
  }
  const handlers=mode==='compete'?{inbound}:{inbound,intake,estimate}
  const results=await work.runSmsWorkBatch(handlers,{db,scope:smsDeliveryWorkScope,limit:25,attemptTimeoutMs:gateStage?120000:45000})
  assert.ok(results.every(result=>result.ok),`Compiled route work failed: ${JSON.stringify(results)}`)
  process.send?.({event:'completed',pid:process.pid,results})
}
main().then(()=>{assert.deepEqual(unexpectedErrors,[],'Caught external/fixture failures still fail this successful journey')})
  .then(()=>process.exit(0),error=>{console.error(error);process.exit(1)})
