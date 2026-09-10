#!/usr/bin/env node
// Real compiled front-desk methods -> actual trade Nest HTTP -> real workers.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {createHash,createHmac,randomUUID} from 'node:crypto'
import Module,{createRequire} from 'node:module'
import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,copyFileSync,symlinkSync,lstatSync} from 'node:fs'
import {resolve,join,dirname,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createCompositionDb} from './sms-fleet-composition-db.mjs'
import {verifyBuildAttestation} from './receptionist-build.mjs'
import {observeSmokeChild,waitForSmokeLiveness,readSmokeResponse,stopSmokeChild} from './sms-smoke-process.mjs'

const require=createRequire(import.meta.url),scripts=dirname(fileURLToPath(import.meta.url)),app=resolve(scripts,'..')
const {fixture,CUSTOMER,OWNER,TO}=require('./sms-route-provider-fixtures.cjs')
const {fixtureClient}=require('./sms-fleet-http-preload.cjs')
const fleet=resolve(process.argv[2]??''),reportPath=resolve(process.argv[3]??'')
assert.ok(process.argv[2]&&process.argv[3],'Usage: node scripts/test-frontdesk-trade-composition.mjs <fleet> <new-report.json>')
assert.ok(!existsSync(reportPath),'Use a new report path; preserve failed and earlier evidence')
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const readyPath=join(fleet,'final-validation-2026-09-09','final-ready.json'),readyHash=sha(readyPath),ready=JSON.parse(readFileSync(readyPath,'utf8'))
assert.equal(ready.ready,true);assert.equal(resolve(ready.candidateRoot),fleet)
const trades=['electrical','plumbing','roofing','painting','solar']
const names=['front-desk',...trades],proofs={}
function bind(trade) {
  const directory=join(fleet,trade==='front-desk'?'qm-front-desk':`qm-${trade}-receptionist`)
  const row=ready.services.find(item=>item.trade===trade)
  assert.ok(row);assert.equal(resolve(row.directory),directory)
  assert.equal(resolve(row.manifestPath),join(directory,'release-manifest.json'))
  assert.equal(resolve(row.attestationPath),join(directory,'build-attestation.json'))
  assert.equal(sha(row.manifestPath),row.manifestSha256);assert.equal(sha(row.attestationPath),row.attestationSha256)
  const manifest=JSON.parse(readFileSync(row.manifestPath,'utf8')),attestation=verifyBuildAttestation(directory,manifest)
  assert.equal(attestation.sourceHash,row.sourceHash);assert.equal(Object.keys(attestation.compiledHashes).length,row.compiledOutputs)
  for(const hashes of [manifest.generatedHashes,manifest.buildInputHashes,manifest.platformContractHashes])assert.ok(!Object.keys(hashes??{}).some(path=>path.includes('test-frontdesk-trade-composition')||path.includes('sms-fleet-composition')||path.includes('sms-fleet-http-preload')))
  return {directory,sourceHash:row.sourceHash,manifestSha256:row.manifestSha256,attestationSha256:row.attestationSha256,compiledHashes:attestation.compiledHashes}
}
for(const trade of names)proofs[trade]=bind(trade)
const runtimeCopies=[]
function copyRuntime(trade) {
  const source=proofs[trade].directory,directory=join(dirname(reportPath),`http-runtime-${trade}-${randomUUID()}`)
  assert.equal(existsSync(directory),false)
  mkdirSync(directory,{recursive:true})
  const manifest=JSON.parse(readFileSync(join(source,'release-manifest.json'),'utf8'))
  const files={...manifest.generatedHashes,...manifest.buildInputHashes,...proofs[trade].compiledHashes,
    'release-manifest.json':proofs[trade].manifestSha256,'build-attestation.json':proofs[trade].attestationSha256}
  for(const [name,expected] of Object.entries(files)) {
    assert.ok(!name.split(/[\\/]/).some(part=>part.startsWith('.env')),'A runtime credential file must not be a release input')
    const input=resolve(source,name),output=resolve(directory,name)
    assert.ok(!relative(source,input).startsWith('..')&&!relative(directory,output).startsWith('..'),'Release input escaped the runtime copy')
    assert.ok(lstatSync(input).isFile(),'Runtime input must be a regular file')
    assert.equal(sha(input),expected)
    mkdirSync(dirname(output),{recursive:true});copyFileSync(input,output);assert.equal(sha(output),expected)
  }
  symlinkSync(join(source,'node_modules'),join(directory,'node_modules'),'junction')
  const copy={trade,directory,source,files,excludedEnvNames:readdirSync(source).filter(name=>name.startsWith('.env')),reusedDependencies:join(source,'node_modules'),lockHash:manifest.buildInputHashes['package-lock.json']}
  assert.deepEqual(verifyBuildAttestation(directory,manifest).compiledHashes,proofs[trade].compiledHashes)
  assert.equal(readdirSync(directory).some(name=>name.startsWith('.env')),false)
  runtimeCopies.push(copy)
  return directory
}
const harnessNames=['test-frontdesk-trade-composition.mjs','sms-fleet-composition-db.mjs','sms-fleet-http-preload.cjs','sms-route-fixture-db.mjs','sms-route-provider-fixtures.cjs','receptionist-build.mjs','sms-smoke-process.mjs']
const harnessHashes=Object.fromEntries(harnessNames.map(name=>[join(scripts,name),sha(join(scripts,name))]))
const net=require('node:net'),tls=require('node:tls'),transports=['node:http','node:https'].map(name=>require(name))
const originals={fetch:global.fetch,load:Module._load,env:{...process.env},cwd:process.cwd(),connect:net.Socket.prototype.connect,tls:tls.connect,
  transports:transports.map(transport=>({request:transport.request,get:transport.get}))}
const results=[],unexpected=[]
let active,allowedEngine
const allowedPorts=new Set()
const fail=message=>{unexpected.push(message);return new Error(message)}
for(const transport of transports)for(const method of ['request','get'])transport[method]=()=>{throw fail(`Unexpected parent HTTP transport ${method}`)}
net.Socket.prototype.connect=function(...args) {
  const first=Array.isArray(args[0])?args[0][0]:args[0],host=typeof first==='object'?first?.host:args[1],port=typeof first==='object'?first?.port:first
  if(host!=='127.0.0.1'||!allowedPorts.has(Number(port)))throw fail(`Unexpected parent socket ${String(host)}:${String(port)}`)
  return Reflect.apply(originals.connect,this,args)
}
tls.connect=()=>{throw fail('Unexpected parent TLS transport')}
async function queryCall(path,input) {
  try {return await active.db[path](input)}
  catch(error){unexpected.push(`${path}: ${String(error)}`);throw error}
}
const frontDb=fixtureClient(queryCall,fail)
Module._load=function(request) {
  if(request==='@supabase/supabase-js')return {...originals.load.apply(this,arguments),createClient:()=>frontDb}
  if(request==='ai')return {...originals.load.apply(this,arguments),generateText:async()=>{throw fail('Single-trade front desk must not need a model')}}
  return originals.load.apply(this,arguments)
}
global.fetch=async(input,options)=>{
  const request=new Request(input,options),url=new URL(request.url)
  if(url.origin===active?.frontBase&&url.pathname==='/api/sms/inbound'&&request.method==='POST')return originals.fetch(input,options)
  if(url.origin!==allowedEngine)throw fail(`Unexpected front-desk network ${url.origin}${url.pathname}`)
  if(url.pathname==='/api/health'&&request.method==='GET')return originals.fetch(input,options)
  if(url.pathname!=='/api/receptionist/simulate')throw fail(`Unexpected front-desk endpoint ${url.pathname}`)
  const payload=await request.clone().json()
  if(active.authProbe) {
    assert.equal(payload.body,'Unauthorized composition probe');assert.equal(request.headers.get('x-sim-key'),null)
    return originals.fetch(input,options)
  }
  assert.equal(request.headers.get('x-sim-key'),'offline-sim-only')
  const response=await originals.fetch(input,options)
  active.forwards.push({payload,status:response.status})
  return response
}
async function until(predicate,description,timeout=90000,cleanup=false) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline) {
    if(!cleanup)assert.deepEqual(unexpected,[],'Even caught fixture/network failures must fail composition')
    if(await predicate())return
    await new Promise(done=>setTimeout(done,150))
  }
  throw new Error(`Timed out: ${description}`)
}
async function reservePort() {
  const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done))
  const port=server.address().port;await new Promise(done=>server.close(done));return port
}
async function sendFrontReceipt(dto) {
  const params={From:dto.from,To:dto.to,Body:dto.body,MessageSid:dto.messageSid,NumMedia:'0'}
  const url=active.frontBase+'/api/sms/inbound'
  const signature=createHmac('sha1','offline-front-auth-only').update(url+Object.keys(params).sort().map(key=>key+params[key]).join('')).digest('base64')
  const started=Date.now()
  const response=await readSmokeResponse(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':signature},body:new URLSearchParams(params).toString()},4000)
  const ackMs=Date.now()-started
  assert.equal(response.status,200);assert.match(response.body,/<Response/)
  const row=(await active.db.pg.query('select * from sms_frontdesk_jobs where receipt_key=$1',[`twilio:${dto.messageSid}`])).rows[0]
  assert.ok(row,'Signed HTTP success must have its durable receipt already committed')
  return {ok:true,turnId:row.id,ackMs}
}
try {
  for(const key of Object.keys(process.env))if(/KEY|SECRET|TOKEN|PASSWORD/.test(key))process.env[key]='offline-test-only'
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://offline-db.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY='offline-test-only'
  const frontRuntime=copyRuntime('front-desk')
  process.chdir(frontRuntime)
  const frontRequire=createRequire(join(frontRuntime,'package.json'))
  for(const entry of readFileSync(join(frontRuntime,'src/config/required-env.ts'),'utf8').matchAll(/'([A-Z][A-Z0-9_]+)'/g))if(!process.env[entry[1]])process.env[entry[1]]='offline-test-only'
  process.env.FRONT_DESK_API_KEY='offline-front-key-only';process.env.TWILIO_AUTH_TOKEN='offline-front-auth-only'
  const {FrontDeskService}=frontRequire('./dist/frontdesk/front-desk.service.js')
  const {AppModule}=frontRequire('./dist/app.module.js'),{NestFactory}=frontRequire('@nestjs/core'),{ValidationPipe}=frontRequire('@nestjs/common')
  assert.deepEqual(frontRequire('./dist/config/required-env.js').missingEnv(),[])
  for(const trade of trades) {
    const config=fixture(trade),candidate=copyRuntime(trade),db=await createCompositionDb(app)
    active={db,forwards:[],events:[],carriers:[],checkouts:[],turn:0}
    for(const [table,rows] of Object.entries(config.seed))await db.seed(table,rows)
    let monitor,service,frontApp
    const server=createServer(async(request,response)=>{
      try {
        assert.equal(request.method,'POST');let bytes=''
        for await(const part of request){bytes+=part;assert.ok(bytes.length<2_000_000)}
        const body=JSON.parse(bytes),path=request.url.slice(1)
        let value
        if(path==='query'||path==='rpc')value=await queryCall(path,body)
        else if(path==='turn')value={turn:active.turn}
        else if(path==='event'){active.events.push(body);value={ok:true}}
        else if(path==='carrier') {
          assert.ok([CUSTOMER,OWNER].includes(body.to),'Unexpected recipient')
          const sid=`SM${randomUUID().replaceAll('-','')}`;active.carriers.push({...body,sid});value={sid}
        } else if(path==='stripe-session') {
          const params=body.parameters
          assert.ok(['electrical','plumbing'].includes(trade));assert.equal(params.mode,'payment');assert.equal(params.metadata.tier,'inspection')
          assert.equal(params.line_items.length,1);assert.equal(params.line_items[0].quantity,1)
          assert.equal(params.line_items[0].price_data.currency,'aud');assert.equal(params.line_items[0].price_data.unit_amount,9900)
          const saved=(await db.pg.query('select * from quotes where id=$1',[params.metadata.quote_id])).rows[0]
          assert.ok(saved);assert.equal(saved.tenant_id,config.seed.tenants[0].id);assert.equal(saved.customer_released_at??null,null)
          assert.equal(new URL(params.success_url).origin,'https://quotemax.com.au')
          assert.equal(new URL(params.cancel_url).pathname,`/q/${saved.share_token}/cancelled`)
          const id=`cs_test_${randomUUID().replaceAll('-','')}`,url=`https://checkout.stripe.com/c/pay/${id}`
          active.checkouts.push({parameters:params,id,url});value={id,url}
        } else throw fail(`Unexpected parent endpoint ${path}`)
        response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value))
      } catch(error) {
        unexpected.push(String(error));response.writeHead(500).end(String(error))
      }
    })
    try {
      await new Promise(done=>server.listen(0,'127.0.0.1',done))
      const endpoint=`http://127.0.0.1:${server.address().port}`,port=await reservePort(),engine=`http://127.0.0.1:${port}`
      allowedPorts.clear();allowedPorts.add(server.address().port);allowedPorts.add(port)
      allowedEngine=engine;process.env[`RECEPTIONIST_${trade.toUpperCase()}_URL`]=engine;process.env.RECEPTIONIST_SIM_KEY='offline-sim-only'
      const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,NODE_ENV:'production',PORT:String(port),
        NEXT_PUBLIC_SUPABASE_URL:'https://offline-db.invalid',SUPABASE_SERVICE_ROLE_KEY:'offline-test-only',
        APP_URL:'https://quotemax.com.au',PUBLIC_WEB_ORIGIN:'https://quotemax.com.au',ENGINE_BASE_URL:engine,
        TWILIO_AUTH_TOKEN:'offline-auth-only',TWILIO_ACCOUNT_SID:'AC11111111111111111111111111111111',TWILIO_FROM_NUMBER:TO,
        CRON_SECRET:'offline-cron-only',SIM_API_KEY:'offline-sim-only',SMS_RECEPTIONIST_ENABLED:'1',SMS_SIMULATE_ENABLED:'1',SMS_DEBOUNCE_MS:'0',
        ANTHROPIC_API_KEY:'offline-model-only',GOOGLE_GEOCODE_API_KEY:'offline-geocode-only',GOOGLE_SOLAR_API_KEY:'offline-solar-only',
        GOOGLE_ADDRESS_VALIDATION_API_KEY:'offline-address-only',STRIPE_SECRET_KEY:'sk_test_offline',ROOFING_SOLAR_ENRICHMENT:trade==='solar'?'true':'false',
        RAG_DISABLED:'true',TENANT_FILESTORE_ENABLED:'false',IG_ENGINE_ENABLED:'0',SMS_QUOTE_PDF_MMS:'0',
        QM_COMPOSITION_ENDPOINT:endpoint,QM_COMPOSITION_TRADE:trade}
      for(const entry of readFileSync(join(candidate,'src/config/required-env.ts'),'utf8').matchAll(/'([A-Z][A-Z0-9_]+)'/g))if(!env[entry[1]])env[entry[1]]='offline-test-only'
      assert.equal(readdirSync(candidate).some(name=>name.startsWith('.env')),false,'Runtime copy must contain no environment files')
      const child=spawn(process.execPath,['--require',join(scripts,'sms-fleet-http-preload.cjs'),'dist/main.js'],{cwd:candidate,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']})
      monitor=observeSmokeChild(child)
      child.on('message',message=>{if(message.event==='unexpected')unexpected.push(message.stack??message.message);else active.events.push(message)})
      const live=await waitForSmokeLiveness(monitor,engine+'/api/health');assert.equal(JSON.parse(live.body).trade,trade)
      active.authProbe=true
      assert.equal((await readSmokeResponse(engine+'/api/receptionist/simulate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from:CUSTOMER,to:TO,body:'Unauthorized composition probe'})})).status,403)
      active.authProbe=false
      assert.equal((await db.pg.query('select count(*)::int as n from sms_work_jobs')).rows[0].n,0,'Unauthorized engine request must not enqueue')
      // Execute the attested front-desk AppModule/controller with the same
      // parsing and validation settings as its normal main.ts bootstrap.
      frontApp=await NestFactory.create(AppModule,{rawBody:true,logger:false})
      frontApp.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}))
      await frontApp.listen(0,'127.0.0.1')
      const frontPort=frontApp.getHttpServer().address().port
      allowedPorts.add(frontPort);active.frontBase=`http://127.0.0.1:${frontPort}`;process.env.FRONT_DESK_PUBLIC_URL=active.frontBase
      service=frontApp.get(FrontDeskService)
      // Pause only scheduling for the first receipt to establish ACK before
      // forwarding; the same real onModuleInit timer then processes the job.
      service.onModuleDestroy();await until(()=>!service.draining,'Initial empty front-desk drain',5000)
      const rejected=await readSmokeResponse(active.frontBase+'/api/sms/inbound',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':'bad'},body:'From=%2B61411111111&To=%2B61488888888&Body=unauthorized&MessageSid=SM00000000000000000000000000000000&NumMedia=0'})
      assert.equal(rejected.status,403);assert.equal((await db.pg.query('select count(*)::int as n from sms_frontdesk_jobs')).rows[0].n,0)
      const receipts=[]
      for(let turn=0;turn<config.turns.length;turn++) {
        active.turn=turn
        const dto={from:CUSTOMER,to:TO,body:config.turns[turn],messageSid:`SM${randomUUID().replaceAll('-','')}`}
        const ack=await sendFrontReceipt(dto),ackMs=ack.ackMs
        assert.equal(ack.ok,true);assert.ok(ackMs<4000,'Front-desk durable acknowledgement exceeded 4 seconds')
        const savedReceipt=(await db.pg.query('select * from sms_frontdesk_jobs where id=$1',[ack.turnId])).rows[0]
        assert.ok(savedReceipt);assert.equal(savedReceipt.receipt_key,`twilio:${dto.messageSid}`)
        if(turn===0){assert.equal(savedReceipt.state,'pending');assert.equal(active.forwards.length,0);service.onModuleInit()}
        await until(async()=>{
          const status=await service.turnStatus(ack.turnId)
          if(status.state==='failed'||status.pipeline.stage==='needs_recovery')throw new Error(JSON.stringify(status))
          return status.state==='forwarded'&&status.pipeline.complete
        },`${trade} actual HTTP turn ${turn+1}`)
        const status=await service.turnStatus(ack.turnId)
        assert.equal(status.trade,trade);assert.ok(status.replies.length>0);assert.equal(status.pipeline.stage,'completed')
        const forwards=active.forwards.filter(item=>item.payload.turnId===ack.turnId)
        assert.equal(forwards.length,1);assert.equal(forwards[0].payload.messageSid,dto.messageSid);assert.equal(forwards[0].payload.body,dto.body)
        assert.ok(forwards[0].status>=200&&forwards[0].status<300)
        const jobs=(await db.pg.query('select * from sms_work_jobs where turn_id=$1',[ack.turnId])).rows
        assert.ok(jobs.length>0);assert.ok(jobs.every(job=>job.tenant_id===config.seed.tenants[0].id&&job.status==='completed'))
        receipts.push({dto,turnId:ack.turnId,status,ackMs})
        console.log(`PASS ${trade} front-desk turn ${turn+1}: durable receipt -> HTTP -> ${jobs.length} completed work stages`)
      }
      const table=({roofing:'roofing_measurements',painting:'painting_measurements',solar:'solar_estimates'})[trade]??'quotes'
      const saved=(await db.pg.query(`select * from ${table}`)).rows
      assert.equal(saved.length,1);assert.equal(saved[0].released_at??saved[0].customer_released_at??saved[0].confirmed_at??null,null)
      const tiers=trade==='roofing'?saved[0].quote.combined.tiers:['painting','solar'].includes(trade)?saved[0].estimate.price.tiers:[saved[0].good,saved[0].better,saved[0].best]
      const prices=tiers.map(tier=>trade==='solar'?tier.net_inc_gst:['roofing','painting'].includes(trade)?tier.inc_gst:tier.subtotal_ex_gst)
      assert.ok(prices.length>0&&prices.every(price=>Number.isFinite(price)&&price>0))
      if(table==='quotes'){assert.equal(saved[0].status,'awaiting_tradie_approval');assert.equal(saved[0].needs_inspection,false);assert.ok(saved[0].pricing_book_version_id)}
      else {
        const decision=trade==='roofing'?saved[0].quote.routing?.decision:trade==='painting'?saved[0].estimate.price.routing?.decision:saved[0].estimate.routing?.decision
        assert.ok(['auto_quote','tradie_review'].includes(decision),'Saved specialist result must be explicitly quotable')
      }
      const expected=({roofing:['measureAndPriceRoofs','priceMultiRoof'],painting:['estimatePainting','calculatePaintingPrice'],solar:['runSolarEstimate','calculateSolarPrice']})[trade]??['structureIntake','runEstimation']
      for(const name of expected)assert.ok(active.events.some(event=>event.event==='real-function'&&event.name===name),`Actual ${name} must execute`)
      const tasks=(await db.pg.query('select * from sms_human_tasks')).rows
      assert.equal(tasks.length,1);assert.equal(tasks[0].resource_id,saved[0].id);assert.equal(tasks[0].status,'notified')
      const intents=(await db.pg.query('select * from sms_outbox order by id')).rows,messages=(await db.pg.query('select * from sms_messages')).rows
      assert.ok(intents.every(row=>row.status==='accepted'));assert.equal(intents.length,active.carriers.length)
      assert.equal(active.checkouts.length,table==='quotes'?1:0)
      assert.deepEqual(intents.map(row=>row.provider_sid).sort(),active.carriers.map(row=>row.sid).sort())
      for(const intent of intents.filter(row=>row.audience==='customer')) {
        assert.ok(receipts.some(receipt=>receipt.turnId===intent.turn_id),'Customer output must retain the actual front-desk turn identity')
        assert.equal(messages.filter(message=>message.outbox_id===intent.id).length,1)
        assert.doesNotMatch(intent.body,/\$\s*\d|https?:\/\/[^\s]+\/(?:q|roof|paint|solar)\//i)
        assert.doesNotMatch(intent.body,/checkout\.stripe\.com/i,'Held customer status must not expose the fixture checkout')
      }
      for(const intent of intents)for(const link of intent.body.match(/https?:\/\/[^\s]+/g)??[])assert.equal(new URL(link).origin,'https://quotemax.com.au','Post-bootstrap public links must use the configured website')
      const conversations=(await db.pg.query('select * from sms_conversations')).rows
      assert.equal(conversations.length,1)
      if(table==='quotes')assert.equal(conversations[0].quote_stage,'awaiting_review')
      else if(trade==='solar')assert.equal(conversations[0].conversation_state?.solar?.step,'awaiting_review')
      else assert.equal(conversations[0][trade==='roofing'?'roofing_state':'painting_state']?.workflow_stage,'awaiting_review')
      const before={forwards:active.forwards.length,events:active.events.length,carriers:active.carriers.length,checkouts:active.checkouts.length,jobs:(await db.pg.query('select * from sms_work_jobs order by sequence')).rows}
      for(const receipt of receipts)assert.equal((await sendFrontReceipt(receipt.dto)).turnId,receipt.turnId)
      await service.drain();await until(()=>!service.draining,'Front-desk drain to finish',5000)
      assert.equal(active.forwards.length,before.forwards);assert.equal(active.events.length,before.events);assert.equal(active.carriers.length,before.carriers)
      assert.equal(active.checkouts.length,before.checkouts)
      assert.deepEqual((await db.pg.query('select * from sms_work_jobs order by sequence')).rows,before.jobs)
      assert.deepEqual((await db.pg.query(`select * from ${table}`)).rows,saved)
      assert.deepEqual((await db.pg.query('select * from sms_outbox order by id')).rows,intents)
      results.push({trade,pass:true,pid:child.pid,frontController:{signedHttp:true,rejectedBadSignature:true,rawBody:true},receipts,resourceId:saved[0].id,reviewTaskId:tasks[0].id,workJobs:before.jobs.length,intents:intents.length,forwarded:active.forwards.length,fixtureCheckouts:active.checkouts,actualFunctions:expected})
    } catch(error) {
      if(monitor)process.stderr.write(monitor.output)
      throw error
    } finally {
      service?.onModuleDestroy()
      try {if(service)await until(()=>!service.draining,'Final front-desk drain to finish',25000,true)}
      finally {
        try {if(monitor)await stopSmokeChild(monitor)}
        finally {
          try {if(frontApp)await frontApp.close()}
          finally {server.closeAllConnections();await new Promise(done=>server.close(done));await db.close()}
        }
      }
    }
  }
} finally {
  global.fetch=originals.fetch;Module._load=originals.load
  net.Socket.prototype.connect=originals.connect;tls.connect=originals.tls
  for(let index=0;index<transports.length;index++)Object.assign(transports[index],originals.transports[index])
  for(const key of Object.keys(process.env))if(!(key in originals.env))delete process.env[key]
  Object.assign(process.env,originals.env)
  process.chdir(originals.cwd)
}
assert.deepEqual(unexpected,[]);assert.equal(results.length,5);assert.equal(sha(readyPath),readyHash)
for(const trade of names)assert.deepEqual(bind(trade),proofs[trade],'Complete compiled bytes and metadata must remain frozen')
for(const copy of runtimeCopies) {
  for(const [name,expected] of Object.entries(copy.files))assert.equal(sha(join(copy.directory,name)),expected,'Runtime copy changed during execution')
  assert.deepEqual(verifyBuildAttestation(copy.directory).compiledHashes,proofs[copy.trade].compiledHashes)
  assert.equal(sha(join(copy.source,'package-lock.json')),copy.lockHash,'Reused dependency lock changed')
  assert.equal(readdirSync(copy.directory).some(name=>name.startsWith('.env')),false)
}
for(const [path,hash] of Object.entries(harnessHashes))assert.equal(sha(path),hash)
mkdirSync(dirname(reportPath),{recursive:true})
writeFileSync(reportPath,JSON.stringify({completed:true,generatedAt:new Date().toISOString(),readiness:{path:readyPath,sha256:readyHash},results,proofs,runtimeCopies,harnessHashes,unexpected,
  limits:['Actual compiled front-desk AppModule/controller and signed HTTP ingress use normal rawBody/ValidationPipe settings; its main.ts/Swagger/hosting bootstrap is not started.','Actual trade bootstrap, HTTP controller authentication and workers; providers/models are explicit fixtures.','Parent-owned PGlite serializes SQL; no production RLS/concurrency, deployment or carrier proof.','All five routed trades to a held priced result; no owner-approved release, website/PDF or additional platform-tool composition.']},null,2))
console.log('PASS 5 actual front-desk -> compiled trade HTTP -> held result compositions; exact owned child exits confirmed')
