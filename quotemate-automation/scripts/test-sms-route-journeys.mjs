#!/usr/bin/env node
// Offline actual compiled route journeys. Never points at a deployed service.
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs'
import {resolve,dirname,join,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {createRouteFixtureDb} from './sms-route-fixture-db.mjs'
const require=createRequire(import.meta.url)
const {fixture,CUSTOMER,OWNER,ADDRESS}=require('./sms-route-provider-fixtures.cjs')
const scriptDirectory=dirname(fileURLToPath(import.meta.url)),appDirectory=resolve(scriptDirectory,'..')
if(!process.argv[2])throw new Error('Usage: node scripts/test-sms-route-journeys.mjs <compiled-fleet-directory> [report.json] [trade] [normal|recovery] [scenario]')
const fleet=resolve(process.argv[2]),reportPath=process.argv[3]?resolve(process.argv[3]):null
const journeyMode=process.argv[5]??'normal'
assert.ok(['normal','recovery'].includes(journeyMode),'Unknown journey mode')
const trades=process.argv[4]&&process.argv[4]!=='all'?[process.argv[4]]:['electrical','plumbing','roofing','painting','solar']
const recoveryScenarios=[...['before-history','after-history','before-result-save','after-result-save','after-publication','before-unlock'].map(stage=>({name:`kill:${stage}`,kind:'kill',stage})),
  ...['before-history','after-history','before-result-save','before-unlock'].map(stage=>({name:`burst:${stage}`,kind:'burst',stage}))]
const scenarios=journeyMode==='normal'?[{name:'normal',kind:'normal'}]:recoveryScenarios.filter(scenario=>!process.argv[6]||scenario.name===process.argv[6])
assert.ok(scenarios.length,'Unknown recovery scenario')
assert.ok(trades.every(trade=>['electrical','plumbing','roofing','painting','solar'].includes(trade)),'Unknown journey trade')
const results=[]
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
function compiledInventory(candidate) {
  const paths=[]
  const walk=directory=>{
    for(const item of readdirSync(directory,{withFileTypes:true})) {
      const path=join(directory,item.name)
      if(item.isDirectory())walk(path)
      else {assert.ok(item.isFile(),'Compiled inventory cannot contain symlinks or special files');paths.push(relative(candidate,path).replaceAll('\\','/'))}
    }
  }
  walk(join(candidate,'dist'))
  return paths.sort()
}
const readyPath=join(fleet,'final-validation-2026-09-09','final-ready.json')
const ready=JSON.parse(readFileSync(readyPath,'utf8')),readyHash=hash(readyPath)
assert.equal(ready.ready,true,'Final attested fleet must be ready before journey execution')
assert.equal(resolve(ready.candidateRoot),fleet,'Readiness evidence must name the tested fleet')
const harnessHashes=Object.fromEntries(['test-sms-route-journeys.mjs','sms-route-fixture-db.mjs','sms-route-provider-fixtures.cjs','sms-route-journey-child.cjs'].map(name=>{const path=join(scriptDirectory,name);return [path,hash(path)]}))
for(const {trade,scenario} of trades.flatMap(trade=>scenarios.map(scenario=>({trade,scenario})))) {
  const candidate=join(fleet,`qm-${trade}-receptionist`),config=fixture(trade)
  const release=ready.services.find(service=>service.trade===trade)
  assert.ok(release,`Missing final readiness evidence for ${trade}`)
  assert.equal(resolve(release.directory),candidate)
  assert.equal(resolve(release.manifestPath),join(candidate,'release-manifest.json'))
  assert.equal(resolve(release.attestationPath),join(candidate,'build-attestation.json'))
  assert.equal(hash(release.manifestPath),release.manifestSha256,'Release manifest changed after readiness')
  assert.equal(hash(release.attestationPath),release.attestationSha256,'Build attestation changed after readiness')
  const attestation=JSON.parse(readFileSync(release.attestationPath,'utf8'))
  assert.equal(attestation.sourceHash,release.sourceHash,'Readiness and build source hashes must match')
  const compiledPaths=compiledInventory(candidate)
  assert.deepEqual(compiledPaths,Object.keys(attestation.compiledHashes).sort(),'Actual compiled inventory must equal the attested inventory')
  for(const path of compiledPaths)assert.equal(hash(join(candidate,path)),attestation.compiledHashes[path],`Compiled file changed after attestation: ${path}`)
  const db=await createRouteFixtureDb(appDirectory)
  console.log(`START ${trade} ${scenario.name}: parent database ready; real compiled route children`)
  const events=[],carriers=[],unexpected=[],children=new Set(),runs=[],materialBoundaries=[]
  const table=trade==='roofing'?'roofing_measurements':trade==='painting'?'painting_measurements':trade==='solar'?'solar_estimates':'quotes'
  // Observe the real claim/checkpoint/finish boundaries without changing their
  // results. This proves the material correction's own work has no pricing or
  // saved-result mutation, including when the first estimate is still pending.
  async function observeMaterialCorrectionBoundary(body,output) {
    if(scenario.kind!=='burst'||!['claim_sms_work','checkpoint_sms_work','finish_sms_work'].includes(body.name)||output.error)return
    if(body.name==='checkpoint_sms_work'&&body.args.p_name!=='saved_job_correction')return
    const input=burstInputs.find(input=>input.kind==='job-correction')
    const claim=body.name==='claim_sms_work'
    const claimed=claim?output.data?.find(job=>job.kind==='inbound'&&new URLSearchParams(job.payload.body).get('MessageSid')===input.sid):null
    if(claim&&!claimed)return
    const job=(await db.pg.query('select * from sms_work_jobs where id=$1',[claimed?.id??body.args.p_id])).rows[0]
    if(job?.kind!=='inbound'||new URLSearchParams(job.payload.body).get('MessageSid')!==input.sid)return
    const envelope=Object.fromEntries(new URLSearchParams(job.payload.body))
    const expectedEnvelope={From:CUSTOMER,To:config.seed.tenants[0].twilio_sms_number,MessageSid:input.sid,Body:input.body,NumMedia:'0'}
    assert.deepEqual(envelope,expectedEnvelope,'The observed work must retain this exact signed receipt envelope')
    assert.equal(job.work_key,`inbound:${expectedEnvelope.To}:${input.sid}`)
    assert.equal(job.serial_key,`sms:${expectedEnvelope.To}:${CUSTOMER}`)
    const phase=claim?'claimed':body.name==='checkpoint_sms_work'?'chosen':'completed'
    assert.equal(materialBoundaries.filter(value=>value.phase===phase).length,0,'Material correction must claim, choose and finish once')
    if(claim) {
      // The signed receipt producer enqueues before tenant lookup. The worker
      // must attribute it before choosing the owned correction, not at claim.
      assert.equal(job.tenant_id,null,'Raw receipt claim precedes tenant lookup')
      assert.ok(typeof job.owner_token==='string'&&job.owner_token.length>0,'The actual claim must hold a nonempty owner token')
      for(const key of ['id','work_key','serial_key','owner_token','tenant_id'])assert.equal(claimed[key],job[key],'Observe the exact row returned to the worker')
      assert.deepEqual(claimed.payload,job.payload)
      assert.equal(Object.hasOwn(job.checkpoint,'saved_job_correction'),false,'Observe the original claim before the handler can choose or change anything')
    } else {
      assert.equal(job.tenant_id,config.seed.tenants[0].id,'The handler must attribute the exact owning tenant before correction effects')
      assert.equal(job.checkpoint.saved_job_correction?.handled,true,'The actual handler must retain the correction as review work')
    }
    assert.equal(job.status,phase==='completed'?'completed':'running')
    materialBoundaries.push({phase,jobId:job.id,workKey:job.work_key,envelope,tenantId:job.tenant_id,serialKey:job.serial_key,ownerToken:job.owner_token,plan:job.checkpoint.saved_job_correction,
      savedRows:(await db.pg.query(`select * from ${table}`)).rows,
      intakeRows:(await db.pg.query('select * from intakes')).rows,
      tasks:(await db.pg.query('select * from sms_human_tasks order by id')).rows,
      conversations:(await db.pg.query('select * from sms_conversations')).rows,
      intakeJobs:(await db.pg.query("select id,tenant_id,serial_key,status,payload from sms_work_jobs where kind='intake'")).rows,
      modelCount:events.filter(event=>event.kind==='model').length,functionCount:events.filter(event=>event.kind==='real-function').length,
      outboxIds:(await db.pg.query('select id from sms_outbox order by created_at')).rows.map(row=>row.id)})
  }
  const paths=['receptionist/inbound.route','intake/structure.route','estimate/draft.route','lib/sms/durable-work','lib/sms/durable-outbox','lib/sms/work-delivery-context',
    ...(trade==='roofing'?['lib/sms/llm-receptionist','lib/roofing/measure','lib/roofing/pricing']:trade==='painting'?['lib/sms/llm-receptionist','lib/painting/measure','lib/painting/pricing']:trade==='solar'?['lib/sms/solar-receptionist','lib/solar/intake','lib/solar/pricing']:['lib/intake/structure','lib/estimate/run'])]
    .map(name=>join(candidate,'dist',`${name}.js`))
  for(const path of paths)assert.ok(Object.hasOwn(attestation.compiledHashes,relative(candidate,path).replaceAll('\\','/')),'Every executed entry must be attested')
  const hashes=Object.fromEntries([...compiledPaths.map(path=>join(candidate,path)),release.manifestPath,release.attestationPath].map(path=>[path,hash(path)]))
  const server=createServer(async(request,response)=>{
    let operation={operation:request.url}
    try {
      let text=''
      for await(const chunk of request){text+=chunk;assert.ok(text.length<2000000,'Oversized fixture request')}
      const body=JSON.parse(text),path=request.url
      operation={...operation,table:body.table,rpc:body.name,action:body.action,conflict:body.conflict}
      let output
      if(path==='/query')output=await db.query(body)
      else if(path==='/rpc'){output=await db.rpc(body);await observeMaterialCorrectionBoundary(body,output)}
      else if(path==='/event'){events.push(body);output={ok:true}}
      else if(path==='/carrier') {
        assert.ok([CUSTOMER,OWNER].includes(body.to),'Unexpected carrier recipient')
        const sid=`SM${randomUUID().replaceAll('-','')}`
        carriers.push({...body,sid});output={sid}
      } else if(path==='/unexpected'){unexpected.push(body);output={ok:true}}
      else throw new Error(`Unregistered fixture endpoint ${path}`)
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(output))
    } catch(error) {
      // Real SQL errors retain SQLSTATE. An unsupported fixture is itself a
      // failed test, even if a production optional-read catch would ignore it.
      if(error.code!=='23505')unexpected.push({...operation,error:String(error)})
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:null,error:{code:error.code??'FIXTURE',message:String(error)}}))
    }
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  const endpoint=`http://127.0.0.1:${server.address().port}`
  async function child(mode,turn,sid,bodyOverride,control) {
    const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,NODE_ENV:'test',
      NEXT_PUBLIC_SUPABASE_URL:'https://offline-db.invalid',SUPABASE_SERVICE_ROLE_KEY:'offline-test-only',
      APP_URL:'https://offline-engine.invalid',PUBLIC_WEB_ORIGIN:'https://quotemax.com.au',
      TWILIO_AUTH_TOKEN:'offline-auth-only',TWILIO_ACCOUNT_SID:'AC11111111111111111111111111111111',
      CRON_SECRET:'offline-cron-only',SMS_RECEPTIONIST_ENABLED:'1',SMS_WORKER_SERVICE:trade,SMS_DEBOUNCE_MS:'0',
      ANTHROPIC_API_KEY:'offline-model-only',GOOGLE_GEOCODE_API_KEY:'offline-geocode-only',GOOGLE_SOLAR_API_KEY:'offline-solar-only',
      GOOGLE_ADDRESS_VALIDATION_API_KEY:'offline-address-only',ROOFING_SOLAR_ENRICHMENT:trade==='solar'?'true':'false',
      RAG_DISABLED:'true',TENANT_FILESTORE_ENABLED:'false',IG_ENGINE_ENABLED:'0',SMS_QUOTE_PDF_MMS:'0',
      ...(['electrical','plumbing'].includes(trade)&&scenario.name==='kill:before-unlock'?{SMS_ROUTE_TEST_RANDOM:control?'0':'0.99'}:{}),
      ...(control?{SMS_ROUTE_TEST_GATE:control.stage}:{})}
    const processChild=spawn(process.execPath,[join(scriptDirectory,'sms-route-journey-child.cjs'),candidate,endpoint,trade,mode,String(turn),sid,...(bodyOverride===undefined?[]:[bodyOverride])],{env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']})
    children.add(processChild)
    let output='',resolveGate;const messages=[]
    const gate=new Promise(done=>{resolveGate=done})
    processChild.stdout.on('data',chunk=>{output+=chunk});processChild.stderr.on('data',chunk=>{output+=chunk})
    processChild.on('message',message=>{messages.push(message);if(message.event==='paused')resolveGate(message);if(message.event==='unexpected')unexpected.push(message);if(message.event==='real-function')events.push({kind:'real-function',pid:processChild.pid,...message})})
    const completion=new Promise((done,reject)=>{
      const deadline=setTimeout(()=>{processChild.kill('SIGKILL');reject(new Error(`${trade} ${mode} timed out:\n${output}`))},control?180000:90000)
      processChild.once('error',error=>{clearTimeout(deadline);reject(error)})
      processChild.once('exit',(code,signal)=>{clearTimeout(deadline);children.delete(processChild);if(code===0||control?.killed)done({code,signal});else reject(new Error(`${trade} ${mode} exit ${code}/${signal}:\n${output}\nBoundary errors: ${JSON.stringify(unexpected)}`))})
    })
    // The normal await below still propagates failure; this also observes a
    // cleanup kill when a paused-boundary assertion fails before that await.
    completion.catch(()=>{})
    if(control) {
      const paused=await Promise.race([gate,completion.then(()=>{throw new Error(`Actual route never reached ${control.stage}`)})])
      assert.equal(paused.stage,control.stage)
      await control.onPause(paused,processChild)
    }
    const exit=await completion
    assert.deepEqual(unexpected,[],'Every fixture operation and external request must be registered')
    if(control?.killed) {
      assert.notEqual(exit.code,0,'Requested process loss must end the child abnormally')
      const paused=messages.find(item=>item.event==='paused')
      runs.push({mode:'killed',turn,pid:processChild.pid,stage:control.stage,jobId:paused.jobId,exit})
      console.log(`PROGRESS ${trade} ${scenario.name}: killed actual ${paused.kind} child ${processChild.pid} at ${control.stage}`)
      return paused
    }
    const message=messages.find(item=>item.event===(mode==='receipt'?'receipt':'completed'))
    assert.ok(message,`Missing ${mode} completion evidence`)
    runs.push({mode,turn,pid:message.pid,results:message.results??null})
    console.log(`PROGRESS ${trade}: ${mode} turn ${turn+1} completed in child ${message.pid}`)
    return message
  }
  const burstInputs=[{kind:'correction',body:'Correction: my first name is Alex, not Sam.'},{kind:'price-question',body:'How much again?'},{kind:'resend',body:'Could you send the quote link again?'},
    {kind:'job-correction',body:'Correction: the installation address is 22 New Road, Sydney NSW 2000.'}]
    .map(input=>({...input,sid:`SM${randomUUID().replaceAll('-','')}`}))
  const recoveryEvidence={scenario:scenario.name,gates:[],burst:[]}
  if(['electrical','plumbing'].includes(trade)&&scenario.name==='kill:before-unlock')recoveryEvidence.photoTemplateRandomValues={firstAttempt:0,restart:0.99}
  let initialConversationId
  try {
    for(const [table,rows] of Object.entries(config.seed))await db.seed(table,rows)
    const sids=config.turns.map(()=>`SM${randomUUID().replaceAll('-','')}`)
    for(let turn=0;turn<config.turns.length;turn++) {
      await child('receipt',turn,sids[turn])
      const durable=(await db.pg.query("select status from sms_work_jobs where kind='inbound' order by sequence desc limit 1")).rows[0]
      assert.equal(durable?.status,'pending','HTTP receipt must persist work before its child exits')
      if(turn===config.turns.length-1&&scenario.kind!=='normal') {
        const control={stage:scenario.stage,killed:false,onPause:async(paused,leader)=>{
          const held=(await db.pg.query('select id,kind,serial_key,status,owner_token,checkpoint from sms_work_jobs where id=$1',[paused.jobId])).rows[0]
          assert.equal(held.status,'running');assert.equal(held.serial_key,paused.serialKey);assert.equal(held.owner_token,paused.ownerToken)
          recoveryEvidence.gates.push({...paused,checkpointNames:Object.keys(held.checkpoint)})
          if(scenario.kind==='kill') {
            control.killed=true
            assert.equal(leader.kill('SIGKILL'),true,'A real live route process must be killed')
            return
          }
          for(const input of burstInputs)for(let duplicate=0;duplicate<2;duplicate++)await child('receipt',turn,input.sid,input.body)
          const followers=(await db.pg.query("select id,work_key,serial_key,sequence,status,payload from sms_work_jobs where kind='inbound' order by sequence")).rows
            .filter(job=>burstInputs.some(input=>job.payload.body.includes(input.sid)))
          assert.equal(followers.length,4,'Duplicate signed receipts must enqueue exactly four follower jobs')
          assert.ok(followers.every(job=>job.status==='pending'),'Follower receipt alone must not perform business work')
          assert.equal(new Set(followers.map(job=>job.serial_key)).size,1,'Actual inbound routes must assign one customer serial key')
          const original=(await db.pg.query("select serial_key from sms_work_jobs where kind='inbound' and payload->>'body' like $1",[`%${sids[turn]}%`])).rows[0]
          assert.equal(followers[0].serial_key,original.serial_key,'Follower keys must come from the same real route identity')
          const competitor=await child('compete',turn,sids[turn])
          const expected=paused.serialKey===followers[0].serial_key?[]:followers.map(job=>job.id)
          assert.deepEqual(competitor.results.map(job=>job.id),expected,'Competing inbound worker must obey actual serial-key eligibility and FIFO')
          recoveryEvidence.burst=followers.map((job,index)=>({kind:burstInputs[index].kind,sid:burstInputs[index].sid,id:job.id,sequence:job.sequence,serialKey:job.serial_key}))
          recoveryEvidence.competitor={blocked:expected.length===0,results:competitor.results}
          leader.send({event:'resume'})
        }}
        const paused=await child('run',turn,sids[turn],undefined,control)
        if(scenario.kind==='kill') {
          const expired=await db.pg.query("update sms_work_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1 and owner_token=$2 and status='running' returning id",[paused.jobId,paused.ownerToken])
          assert.equal(expired.rows.length,1,'Only the abandoned actual job lease is advanced for restart')
          await assert.rejects(()=>db.rpc({name:'assert_sms_work_owner',args:{p_id:paused.jobId,p_owner:paused.ownerToken}}),/ownership|owner|lease/i,'The expired process owner cannot keep writing')
          await child('run',turn,sids[turn])
          const recovered=(await db.pg.query('select status,attempts from sms_work_jobs where id=$1',[paused.jobId])).rows[0]
          assert.equal(recovered.status,'completed');assert.equal(recovered.attempts,2,'Restart must reclaim the same durable job exactly once')
          recoveryEvidence.reclaimedJob={id:paused.jobId,...recovered}
        }
      } else await child('run',turn,sids[turn])
      if(turn===0)initialConversationId=(await db.pg.query('select id from sms_conversations order by created_at limit 1')).rows[0].id
    }
    const rows=(await db.pg.query(`select * from ${table}`)).rows
    assert.equal(rows.length,1,`${trade} must persist exactly one actual priced result`)
    const saved=rows[0]
    const priceEvidence=trade==='roofing'?saved.quote:trade==='painting'?(saved.estimate??saved.quote):trade==='solar'?(saved.estimate??saved):saved
    assert.ok(priceEvidence&&typeof priceEvidence==='object','Saved result must contain computed price evidence')
    const tierPrices=trade==='roofing'?saved.quote.combined.tiers:trade==='painting'?saved.estimate.price.tiers:trade==='solar'?saved.estimate.price.tiers:[saved.good,saved.better,saved.best].filter(Boolean)
    assert.ok(tierPrices.length>0,'Actual priced tiers must exist')
    const positivePrices=tierPrices.map(tier=>trade==='solar'?tier.net_inc_gst:trade==='roofing'||trade==='painting'?tier.inc_gst:tier.subtotal_ex_gst)
    assert.ok(positivePrices.every(value=>typeof value==='number'&&Number.isFinite(value)&&value>0),'Every saved tier must have a finite positive total')
    if(trade==='roofing')assert.ok(['auto_quote','tradie_review'].includes(saved.quote.routing?.decision),'Roof result must have an explicit quotable routing decision')
    if(trade==='painting')assert.ok(['auto_quote','tradie_review'].includes(saved.estimate.price.routing?.decision),'Painting result must have an explicit quotable routing decision')
    if(trade==='solar')assert.ok(['auto_quote','tradie_review'].includes(saved.estimate.routing?.decision),'Solar result must have an explicit quotable routing decision')
    const invoked=events.filter(event=>event.kind==='real-function').map(event=>event.name)
    const requiredCalls=trade==='roofing'?['measureAndPriceRoofs','priceMultiRoof']:trade==='painting'?['estimatePainting','calculatePaintingPrice']:trade==='solar'?['runSolarEstimate','calculateSolarPrice']:['structureIntake','runEstimation']
    for(const name of requiredCalls)assert.ok(invoked.includes(name),`Actual compiled ${name} must execute, not merely load`)
    assert.equal(saved.released_at??saved.customer_released_at??saved.confirmed_at??null,null,'New result must remain held')
    if(table==='quotes'){assert.equal(saved.status,'awaiting_tradie_approval');assert.equal(saved.needs_inspection,false);assert.ok(saved.pricing_book_version_id,'Actual generic price must bind its immutable version')}
    const tasks=(await db.pg.query('select * from sms_human_tasks')).rows
    assert.equal(tasks.length,scenario.kind==='burst'?2:1,'Only the original quote review and the material correction may create tasks')
    const reviewTasks=tasks.filter(task=>!task.request_key.startsWith('sms-correction:'))
    assert.equal(reviewTasks.length,1,'One original durable review task must own the newly saved result')
    const reviewTask=reviewTasks[0]
    assert.equal(reviewTask.resource_id,saved.id);assert.equal(reviewTask.status,'notified','The configured owner and successful carrier fixture must produce a persisted notification')
    const outbox=(await db.pg.query('select * from sms_outbox order by created_at')).rows
    const expectedInitialIntents=(['electrical','plumbing','solar'].includes(trade)?5:4)+(scenario.kind==='burst'?5:0)
    assert.equal(outbox.length,expectedInitialIntents,'Only the exact original journey intents, four queued replies and one correction owner alert may be accepted')
    assert.ok(outbox.length>0&&outbox.every(row=>row.status==='accepted'),'Successful fake carrier must leave every persisted intent accepted')
    assert.equal(outbox.filter(row=>row.audience==='tradie'&&row.to_number===OWNER&&row.delivery_key===`human-task:${reviewTask.id}:notify`).length,1,'The actual review task must notify its owner exactly once')
    assert.equal(carriers.length,outbox.length,'Every accepted intent must match exactly one fake-carrier call')
    assert.deepEqual(outbox.map(row=>row.provider_sid).sort(),carriers.map(row=>row.sid).sort(),'Saved carrier SIDs must match actual fixture acknowledgements')
    assert.ok(outbox.some(row=>row.to_number===CUSTOMER&&/review|approve/i.test(row.body)),'Customer review status must be a persisted intent')
    for(const row of outbox.filter(row=>row.to_number===CUSTOMER)) {
      assert.doesNotMatch(row.body,/\$\s*\d|https?:\/\/[^\s]+\/(?:q|roof|paint|solar)\//i,'Held draft must not expose a new price or public report link')
      if(trade==='painting'&&row.body.includes('/paint-request/')) {
        assert.match(row.body,/painter to review before sending/i,'Actual painting opener must explain the approval hold')
        assert.doesNotMatch(row.body,/straight back|straight over|on.*way/i)
      }
    }
    const conversations=(await db.pg.query('select * from sms_conversations')).rows
    if(scenario.kind!=='burst')assert.equal(conversations.length,1)
    assert.ok(conversations.every(row=>row.tenant_id===config.seed.tenants[0].id&&row.from_number===CUSTOMER),'Every route-created conversation must retain the original tenant/customer ownership')
    const conversation=conversations.find(row=>row.id===initialConversationId)
    assert.ok(conversation,'The original conversation must survive recovery')
    if(['electrical','plumbing'].includes(trade)) {
      assert.equal(conversation.quote_id,saved.id);assert.equal(conversation.quote_stage,'awaiting_review')
      if(scenario.kind!=='burst')assert.equal(conversation.status,'done')
    } else if(trade==='solar') {
      assert.equal(conversation.conversation_state?.solar?.step,'awaiting_review')
      assert.equal(conversation.conversation_state?.solar?.reference?.id,saved.id)
    } else {
      const state=conversation[trade==='roofing'?'roofing_state':'painting_state']
      assert.equal(state?.workflow_stage,'awaiting_review');assert.equal(state?.pending_quote_token,saved.public_token)
    }
    const transcript=(await db.pg.query('select * from sms_messages')).rows
    for(const intent of outbox.filter(row=>row.audience==='customer')) {
      const isBurst=recoveryEvidence.burst.some(job=>job.id===intent.payload?.workId)
      if(!isBurst)assert.equal(intent.conversation_id,initialConversationId,'Draft journey intents must retain the original conversation identity')
      assert.ok(conversations.some(row=>row.id===intent.conversation_id),'Every customer intent needs an owned persisted conversation')
      const publications=transcript.filter(row=>row.outbox_id===intent.id)
      assert.equal(publications.length,1,'Each accepted customer intent must publish exactly one transcript row')
      assert.deepEqual({conversation:publications[0].conversation_id,sid:publications[0].twilio_message_sid,body:publications[0].body,status:publications[0].delivery_status,direction:publications[0].direction},
        {conversation:intent.conversation_id,sid:intent.provider_sid,body:intent.body,status:'accepted',direction:'outbound'})
    }
    const jobs=(await db.pg.query('select id,work_key,kind,status,sequence,serial_key,payload,checkpoint,result from sms_work_jobs order by sequence')).rows
    assert.ok(jobs.every(job=>job.status==='completed'),'All actual route work must complete')
    const recoveryJobs=[]
    if(['electrical','plumbing'].includes(trade)&&['burst:before-result-save','burst:before-unlock'].includes(scenario.name)) {
      // The real correction handler sees an existing intake while its first
      // estimate is still running and enqueues a SID-keyed recovery wakeup.
      // It must reuse the held result without any second business effect.
      const correction=recoveryEvidence.burst.find(follower=>follower.kind==='correction')
      const expectedKey=`intake:sms:${initialConversationId}:${correction.sid}`
      const extra=jobs.filter(job=>job.work_key===expectedKey)
      assert.equal(extra.length,1,'Exactly one correction-SID recovery wakeup is allowed')
      const recoveryJob=extra[0]
      assert.equal(recoveryJob.kind,'intake');assert.equal(recoveryJob.serial_key,`intake:sms:${initialConversationId}`)
      assert.deepEqual(JSON.parse(recoveryJob.payload.body),{conversationId:initialConversationId,sourceChannel:'sms'})
      assert.equal(recoveryJob.result.status,200)
      assert.deepEqual(JSON.parse(recoveryJob.result.body),{ok:true,intakeId:saved.intake_id,stage:'awaiting_review',idempotent:true})
      const intakeRows=(await db.pg.query('select id,tenant_id from intakes')).rows
      assert.deepEqual(intakeRows,[{id:saved.intake_id,tenant_id:config.seed.tenants[0].id}],'Recovery wakeup cannot create another intake')
      for(const name of ['structureIntake','runEstimation'])assert.equal(invoked.filter(value=>value===name).length,1,`Recovery wakeup cannot rerun ${name}`)
      assert.deepEqual(events.filter(event=>event.kind==='model').map(event=>event.operation).sort(),
        ['slot-extraction','general-dialog','slot-extraction','general-dialog','structure','estimate','slot-extraction','general-dialog'].sort(),
        'Only the original two turns, first structure/estimate and correction may call the model')
      assert.equal(outbox.length,10,'Original five intents plus four queued replies and one correction owner alert, with no recovery-job send')
      assert.equal(outbox.filter(intent=>intent.payload?.workId===recoveryJob.id).length,0)
      assert.equal(transcript.filter(message=>message.direction==='outbound'&&message.audience==='customer').length,8,'Original four customer publications plus four queued replies only')
      assert.equal(transcript.filter(message=>message.direction==='outbound').length,10,'Only the eight customer replies and two owner notifications may publish')
      recoveryJobs.push(recoveryJob)
      recoveryEvidence.idempotentWakeup={jobId:recoveryJob.id,key:expectedKey,intakeId:saved.intake_id,additionalModels:0,additionalPricingCalls:0,additionalIntents:0,additionalPublications:0}
    }
    const baseJobs=jobs.filter(job=>!recoveryEvidence.burst.some(follower=>follower.id===job.id)&&!recoveryJobs.some(recovery=>recovery.id===job.id))
    if(['electrical','plumbing'].includes(trade))assert.deepEqual(baseJobs.map(job=>job.kind),['inbound','inbound','intake','estimate'])
    else assert.ok(jobs.every(job=>job.kind==='inbound'),'Specialists execute inside actual inbound work')
    const draftJob=['electrical','plumbing'].includes(trade)?baseJobs.find(job=>job.kind==='estimate'):baseJobs.find(job=>job.payload.body.includes(sids.at(-1)))
    // SQL198 validates then clears temporary fence columns on every write;
    // the immutable outbox payload retains the originating job identity.
    assert.ok(outbox.some(row=>row.audience==='customer'&&row.payload?.workId===draftJob.id&&/review|approve/i.test(row.body)),
      `The actual draft-producing job must persist its customer review status, not rely on an earlier intake acknowledgement: ${JSON.stringify({jobs,outbox:outbox.map(row=>({audience:row.audience,key:row.delivery_key,body:row.body,workId:row.sms_work_id,payloadWorkId:row.payload?.workId}))})}`)
    if(scenario.kind==='burst') {
      const completedOrder=db.operations.filter(operation=>operation.rpc==='finish_sms_work'&&operation.args.p_result&&recoveryEvidence.burst.some(job=>job.id===operation.args.p_id)).map(operation=>operation.args.p_id)
      assert.deepEqual(completedOrder,recoveryEvidence.burst.map(job=>job.id),'Each queued input must complete once, in real receipt order')
      const replies=[]
      for(const follower of recoveryEvidence.burst) {
        const job=jobs.find(job=>job.id===follower.id)
        assert.equal(job.kind,'inbound');assert.equal(job.status,'completed');assert.equal(job.serial_key,follower.serialKey)
        assert.equal(new URLSearchParams(job.payload.body).get('Body'),burstInputs.find(input=>input.sid===follower.sid).body)
        const messages=transcript.filter(message=>message.direction==='inbound'&&message.twilio_message_sid===follower.sid)
        assert.equal(messages.length,1,'Each queued input must be recorded once despite duplicate receipts')
        const intents=outbox.filter(intent=>intent.audience==='customer'&&intent.payload?.workId===follower.id)
        assert.equal(intents.length,1,'Each queued input must have its own accepted reply, never be consumed by a generic drain')
        assert.doesNotMatch(intents[0].body,/\bon (?:its|the) way\b|\b(?:i|we)(?:['’]ve| have) sent\b|\b(?:sending|texting).{0,30}\bnow\b/i)
        if(follower.kind==='correction') {
          assert.match(intents[0].body,/Alex/i,'The actual correction reply must acknowledge the corrected name')
          const corrected=conversations.find(row=>row.id===intents[0].conversation_id)
          assert.equal(corrected.conversation_state?.slots?.first_name,'Alex','The actual correction must survive in owned persisted conversation state')
        } else if(follower.kind==='job-correction') {
          const input=burstInputs.find(input=>input.sid===follower.sid)
          assert.equal(intents[0].body,'Your requested change is saved for tradie review. It has not been applied to the existing job or quote.')
          assert.equal(intents[0].delivery_key,`${follower.id}:job-correction`,'The correction acknowledgement must have a stable per-work identity')
          assert.deepEqual(materialBoundaries.map(boundary=>boundary.phase),['claimed','chosen','completed'],'Observe the real correction claim before handler execution, checkpoint and completed work')
          const [claimed,chosen,completed]=materialBoundaries
          for(const boundary of materialBoundaries){assert.equal(boundary.jobId,follower.id);assert.equal(boundary.serialKey,follower.serialKey);assert.equal(boundary.workKey,claimed.workKey);assert.deepEqual(boundary.envelope,claimed.envelope)}
          assert.equal(claimed.tenantId,null,'The raw signed receipt is claimed before tenant lookup')
          for(const boundary of [chosen,completed])assert.equal(boundary.tenantId,config.seed.tenants[0].id,'Business handling must retain the exact owning tenant')
          assert.equal(chosen.ownerToken,claimed.ownerToken)
          assert.deepEqual(completed.plan,chosen.plan,'The chosen correction decision must remain checkpointed')
          assert.deepEqual(job.checkpoint.saved_job_correction,chosen.plan)
          assert.deepEqual(chosen.savedRows,claimed.savedRows,'Choosing a correction target must not rewrite any saved price')
          assert.deepEqual(completed.savedRows,chosen.savedRows,'The correction handler must leave every original priced-result byte unchanged')
          assert.deepEqual(chosen.intakeRows,claimed.intakeRows,'Choosing a correction target must not replace consumed inputs')
          assert.deepEqual(completed.intakeRows,chosen.intakeRows,'The correction handler cannot replace consumed inputs or create an intake')
          assert.deepEqual(completed.intakeJobs,claimed.intakeJobs,'The correction handler cannot enqueue another intake')
          assert.equal(chosen.modelCount,claimed.modelCount,'The correction decision must not invoke a model')
          assert.equal(completed.modelCount,chosen.modelCount,'The material correction must not invoke a model')
          assert.equal(chosen.functionCount,claimed.functionCount,'The correction decision must not invoke structuring or pricing')
          assert.equal(completed.functionCount,chosen.functionCount,'The material correction must not invoke structuring or pricing')
          assert.deepEqual(chosen.tasks,claimed.tasks,'Choose the durable correction decision before task effects')
          assert.deepEqual(chosen.outboxIds,claimed.outboxIds,'Choose the durable correction decision before transport effects')
          const expectedTaskKey=`sms-correction:${follower.sid}`
          const correctionTasks=tasks.filter(task=>task.request_key===expectedTaskKey)
          assert.equal(correctionTasks.length,1,'Duplicate correction receipts must create exactly one review task')
          const correctionTask=correctionTasks[0]
          assert.deepEqual({tenant:correctionTask.tenant_id,customer:correctionTask.customer_phone,conversation:correctionTask.conversation_id,status:correctionTask.status,error:correctionTask.notification_error},
            {tenant:config.seed.tenants[0].id,customer:CUSTOMER,conversation:intents[0].conversation_id,status:'notified',error:null})
          assert.equal(correctionTask.reason,`Customer requested a job correction. Existing job and quote are unchanged.\nCustomer request (verbatim):\n${input.body}`)
          const correctionConversation=chosen.conversations.find(row=>row.id===correctionTask.conversation_id)
          assert.ok(correctionConversation,'The correction decision must come from an owned persisted conversation')
          assert.equal(correctionConversation.tenant_id,config.seed.tenants[0].id);assert.equal(correctionConversation.from_number,CUSTOMER)
          if(chosen.savedRows.length===1) {
            const family=trade==='roofing'?'roof':trade==='painting'?'paint':trade==='solar'?'solar':'generic'
            assert.equal(chosen.savedRows[0].id,saved.id)
            assert.equal(chosen.plan.reference?.family,family);assert.equal(chosen.plan.reference?.id,saved.id)
            assert.equal(correctionTask.resource_type,family);assert.equal(correctionTask.resource_id,saved.id)
          } else {
            assert.equal(chosen.savedRows.length,0)
            assert.ok(['electrical','plumbing'].includes(trade),'Specialist corrections must refer to their completed result')
            assert.ok(chosen.intakeJobs.some(work=>work.tenant_id===config.seed.tenants[0].id&&work.serial_key===`intake:sms:${correctionTask.conversation_id}`&&
              ['pending','running'].includes(work.status)&&JSON.parse(work.payload.body).conversationId===correctionTask.conversation_id),
            'An unpriced correction must be attached to the conversation whose real intake is already queued/running')
            assert.equal(chosen.plan.reference,undefined);assert.equal(correctionTask.resource_type,null);assert.equal(correctionTask.resource_id,null)
          }
          assert.deepEqual(completed.tasks.filter(task=>task.request_key!==expectedTaskKey),chosen.tasks,'The original review task cannot be rewritten by a correction')
          const addedIds=completed.outboxIds.filter(id=>!chosen.outboxIds.includes(id))
          assert.equal(addedIds.length,2,'The correction creates exactly its own owner alert and customer acknowledgement')
          const added=outbox.filter(intent=>addedIds.includes(intent.id))
          assert.equal(added.length,2);assert.ok(added.every(intent=>intent.payload?.workId===follower.id))
          const ownerAlerts=added.filter(intent=>intent.audience==='tradie')
          assert.equal(ownerAlerts.length,1)
          assert.equal(ownerAlerts[0].delivery_key,`human-task:${correctionTask.id}:notify`)
          assert.equal(ownerAlerts[0].tenant_id,config.seed.tenants[0].id);assert.equal(ownerAlerts[0].to_number,OWNER)
          assert.ok(ownerAlerts[0].body.includes(input.body),'The owner alert must retain this entire bounded correction text')
          assert.equal(added.find(intent=>intent.audience==='customer')?.id,intents[0].id)
          const pricedAddress=table==='quotes'?(await db.pg.query('select address from intakes where id=$1',[saved.intake_id])).rows[0]?.address:saved.address
          // The deterministic solar street parser preserves the original
          // enquiry's full stop; other fixtures supply the bare ADDRESS.
          assert.equal(pricedAddress,trade==='solar'?`${ADDRESS}.`:ADDRESS,'The original saved brief keeps its confirmed address while the new address awaits review')
          recoveryEvidence.materialCorrection={sid:follower.sid,jobId:follower.id,taskId:correctionTask.id,
            resourceType:correctionTask.resource_type,resourceId:correctionTask.resource_id,conversationId:correctionTask.conversation_id,
            requestedText:input.body,originalAddress:pricedAddress,ownerIntentId:ownerAlerts[0].id,customerIntentId:intents[0].id,
            pricedResultUnchanged:true,consumedInputsUnchanged:true,additionalModels:0,additionalPricingCalls:0,boundaries:materialBoundaries}
        } else assert.match(intents[0].body,/awaiting the tradie['’]s review|cannot find a saved quote linked to this number yet/i,'Queued price/link requests must report the real saved-result state')
        replies.push({kind:follower.kind,jobId:follower.id,intentId:intents[0].id,body:intents[0].body})
      }
      recoveryEvidence.replies=replies
    }
    const before={saved,tasks:(await db.pg.query('select * from sms_human_tasks order by id')).rows,taskIds:tasks.map(task=>task.id),outboxIds:outbox.map(row=>row.id),carrierCount:carriers.length,modelCount:events.filter(event=>event.kind==='model').length,functionCount:events.filter(event=>event.kind==='real-function').length}
    // A brand-new process receives each original webhook again after all
    // predecessor processes exited. It must adopt the durable receipt/result.
    for(let turn=0;turn<config.turns.length;turn++)await child('receipt',turn,sids[turn])
    if(scenario.kind==='burst')for(const input of burstInputs)await child('receipt',config.turns.length-1,input.sid,input.body)
    const replay=await child('run',config.turns.length-1,sids.at(-1))
    assert.deepEqual(replay.results,[],'Completed duplicate receipts must not rerun business work')
    assert.deepEqual((await db.pg.query(`select * from ${table}`)).rows,[before.saved],'Restart replay must preserve the same saved result byte-for-byte')
    assert.deepEqual((await db.pg.query('select id from sms_human_tasks')).rows.map(row=>row.id),before.taskIds)
    assert.deepEqual((await db.pg.query('select * from sms_human_tasks order by id')).rows,before.tasks,'Duplicate receipts must not rewrite either saved review task')
    assert.deepEqual((await db.pg.query('select id from sms_outbox order by created_at')).rows.map(row=>row.id),before.outboxIds)
    assert.equal(carriers.length,before.carrierCount);assert.equal(events.filter(event=>event.kind==='model').length,before.modelCount)
    assert.equal((await db.pg.query("select count(*)::int as n from sms_messages where direction='inbound'")).rows[0].n,config.turns.length+recoveryEvidence.burst.length)
    // A genuinely new customer receipt must resolve the saved HELD result.
    // Asking again never authorises its release or a fresh price calculation.
    const followupSid=`SM${randomUUID().replaceAll('-','')}`,followupBody='Could you send the quote link again?'
    await child('receipt',config.turns.length,followupSid,followupBody)
    const followupRun=await child('run',config.turns.length,followupSid)
    assert.equal(followupRun.results.length,1,'One new held-quote follow-up must run exactly one inbound job')
    const followupJobs=(await db.pg.query('select id,kind,status from sms_work_jobs order by sequence')).rows.filter(job=>!jobs.some(old=>old.id===job.id))
    assert.equal(followupJobs.length,1);assert.equal(followupJobs[0].kind,'inbound');assert.equal(followupJobs[0].status,'completed')
    const afterFollowup=(await db.pg.query('select * from sms_outbox order by created_at')).rows
    const followupIntents=afterFollowup.filter(row=>!before.outboxIds.includes(row.id))
    assert.equal(followupIntents.length,1,'One new held-status customer intent; no additional quote/owner notification')
    const followupIntent=followupIntents[0]
    assert.equal(followupIntent.audience,'customer');assert.equal(followupIntent.to_number,CUSTOMER);assert.equal(followupIntent.status,'accepted')
    assert.equal(followupIntent.payload?.workId,followupJobs[0].id)
    assert.match(followupIntent.body,/^Your .+ draft is saved and awaiting the tradie['’]s review\. It has not been released to you yet\.$/i,'Follow-up must explicitly describe a saved, unreleased review hold')
    assert.doesNotMatch(followupIntent.body,/\bon (?:its|the) way\b|\b(?:i|we)(?:['’]ve| have) sent\b|\b(?:sending|texting).{0,30}\bnow\b/i,'Held follow-up must not promise completed or imminent dispatch')
    assert.doesNotMatch(followupIntent.body,/\$\s*\d|https?:\/\/[^\s]+\/(?:q|roof|paint|solar)\//i,'Held follow-up must not release a price or report link')
    assert.equal(carriers.length,before.carrierCount+1);assert.equal(followupIntent.provider_sid,carriers.at(-1).sid)
    const followupConversation=(await db.pg.query('select tenant_id,from_number from sms_conversations where id=$1',[followupIntent.conversation_id])).rows[0]
    assert.deepEqual(followupConversation,{tenant_id:config.seed.tenants[0].id,from_number:CUSTOMER})
    const followupPublications=(await db.pg.query('select conversation_id,body,twilio_message_sid,delivery_status,direction from sms_messages where outbox_id=$1',[followupIntent.id])).rows
    assert.deepEqual(followupPublications,[{conversation_id:followupIntent.conversation_id,body:followupIntent.body,twilio_message_sid:followupIntent.provider_sid,delivery_status:'accepted',direction:'outbound'}])
    await child('receipt',config.turns.length,followupSid,followupBody)
    assert.deepEqual((await child('run',config.turns.length,followupSid)).results,[],'Restart replay of held-status follow-up must perform no work')
    assert.deepEqual((await db.pg.query(`select * from ${table}`)).rows,[before.saved],'New held follow-up and its replay must preserve saved prices/result')
    assert.deepEqual((await db.pg.query('select id from sms_human_tasks')).rows.map(row=>row.id),before.taskIds)
    assert.deepEqual((await db.pg.query('select * from sms_human_tasks order by id')).rows,before.tasks,'Held follow-up and replay must leave both review tasks unchanged')
    assert.deepEqual((await db.pg.query('select * from sms_outbox order by created_at')).rows,afterFollowup,'Follow-up replay must preserve the same accepted intents')
    assert.equal(carriers.length,before.carrierCount+1);assert.equal(events.filter(event=>event.kind==='model').length,before.modelCount)
    assert.equal(events.filter(event=>event.kind==='real-function').length,before.functionCount,'Held follow-up must not rerun structuring or pricing')
    assert.equal((await db.pg.query("select count(*)::int as n from sms_messages where direction='inbound'")).rows[0].n,config.turns.length+recoveryEvidence.burst.length+1)
    for(const intent of afterFollowup)for(const link of intent.body.match(/https?:\/\/[^\s]+/g)??[]) {
      assert.equal(new URL(link).origin,'https://quotemax.com.au',`Every generated public link must use PUBLIC_WEB_ORIGIN: ${intent.body}`)
    }
    for(const [path,digest] of Object.entries(hashes))assert.equal(hash(path),digest,'Candidate changed during journey')
    assert.deepEqual(compiledInventory(candidate),compiledPaths,'Compiled inventory changed during journey')
    results.push({trade,scenario:scenario.name,recovery:scenario.kind==='normal'?null:recoveryEvidence,sourceHash:release.sourceHash,hashes,runs,resource:{table,id:saved.id,positivePrices},tasks:tasks.map(({id,request_key,resource_type,resource_id,status})=>({id,request_key,resource_type,resource_id,status})),jobs,
      persistedIntents:afterFollowup.length,carrierCalls:carriers.length,providers:events,duplicateReceipts:config.turns.length,replayUnchanged:true,
      heldFollowup:{sid:followupSid,jobId:followupJobs[0].id,intentId:followupIntent.id,body:followupIntent.body,accepted:true,replayUnchanged:true}})
    console.log(`PASS ${trade} ${scenario.name}: actual compiled routes, one priced held result, durable review/status, restart duplicates and new held-quote follow-up unchanged`)
  } catch(error) {
    await Promise.all([...children].map(processChild=>new Promise(done=>{
      processChild.once('exit',done)
      if(!processChild.kill('SIGKILL'))done()
    })))
    if(reportPath) {
      const failurePath=`${reportPath.replace(/\.json$/,'')}.failure-${Date.now()}.json`
      const tables={}
      for(const table of ['sms_work_jobs','sms_conversations','sms_messages','sms_outbox','sms_human_tasks','intakes','quotes','roofing_measurements','painting_measurements','solar_estimates'])tables[table]=(await db.pg.query(`select * from ${table}`)).rows
      mkdirSync(dirname(failurePath),{recursive:true})
      writeFileSync(failurePath,JSON.stringify({trade,scenario:scenario.name,error:{message:error.message,stack:error.stack},readiness:{path:readyPath,sha256:readyHash},harnessHashes,hashes,completedResults:results,runs,recovery:recoveryEvidence,materialBoundaries,events,carriers,unexpected,operations:db.operations,tables},null,2)+'\n')
      console.error(`FAILURE STATE ${failurePath}`)
    }
    throw error
  } finally {
    for(const processChild of children)processChild.kill('SIGKILL')
    await new Promise(done=>server.close(done));await db.close()
  }
}
for(const [path,digest] of Object.entries(harnessHashes))assert.equal(hash(path),digest,'Harness changed during journey matrix')
assert.equal(hash(readyPath),readyHash,'Fleet readiness evidence changed during journey matrix')
const report={generatedAt:new Date().toISOString(),mode:journeyMode,scope:'Actual compiled route/specialist/pricing journeys with explicit offline database and provider fixtures.',readiness:{path:readyPath,sha256:readyHash,readyUtc:ready.readyUtc},harnessHashes,
  limitations:['Scripted model outputs and Google provider data; no model-quality, carrier delivery, or deployed tenant proof.',
    'Compiled POST exports load directly, bypassing generated main.ts bootstrap and HTTP transport; conflicting-origin checks exercise handler behaviour even though normal generated startup normalises APP_URL to PUBLIC_WEB_ORIGIN.',
    'Test-only PostgREST-shaped adapter over PGlite with real 122/154/190/191/198/199/201/207 SQL; not full production schema, RLS, or PostgREST compatibility certification.',
    'Electrical/plumbing execute inbound, intake, estimate POSTs; roofing/painting/solar execute their real specialists within inbound POST, matching production routing.',
    journeyMode==='normal'?'Sequential normal completion followed by new-process duplicate replay; this mode does not certify actual route process-kill timing or concurrent database sessions.':'The named trades execute actual-handler kills and live queued bursts only at the reported database boundaries. Bursts contain first-name Alex, price and resend questions, plus an address correction retained as a distinct owner review task; the address is not automatically applied or repriced. Database snapshots bracket the material correction claim before handler execution, checkpoint and completion. Generic pre-unlock recovery forces different random template choices in the original and restarted processes. The parent serialises fixture PostgreSQL access; after a confirmed process kill only its abandoned lease deadline is advanced. No production multiconnection or live timing certification.',
    'Optional RAG, tenant filestore and generated imagery are disabled by existing feature configuration. No public release, approval mutation, PDF rendering or checkout occurs in these held-draft journeys.'],results}
if(reportPath){mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n')}
console.log(`PASS ${results.length} actual compiled trade route journeys (${journeyMode})`)
