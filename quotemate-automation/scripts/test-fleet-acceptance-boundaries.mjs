#!/usr/bin/env node
// Actual compiled front-desk/readiness methods, controlled HTTP and timers.
// The fixture models queue persistence; PostgreSQL semantics are tested separately.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyBuildAttestation } from './receptionist-build.mjs'

const fleet = resolve(process.argv[2] ?? '')
const reportPath = process.argv[3] ? resolve(process.argv[3]) : null
assert.ok(process.argv[2] && reportPath, 'Usage: node scripts/test-fleet-acceptance-boundaries.mjs <compiled-fleet-directory> <new-report.json>')
assert.ok(!existsSync(reportPath), 'Use a fresh report path to preserve earlier evidence')
const front = join(fleet, 'qm-front-desk'), solar = join(fleet, 'qm-solar-receptionist')
const sha = value => createHash('sha256').update(value).digest('hex')
const scriptPath = fileURLToPath(import.meta.url)
const readyPath=join(fleet,'final-validation-2026-09-09','final-ready.json')
const readyBytes=readFileSync(readyPath), ready=JSON.parse(readyBytes)
assert.equal(ready.ready,true); assert.equal(resolve(ready.candidateRoot),fleet)
assert.equal(ready.services.length,6)
const sourceFiles = [
  ...['release-manifest.json','build-attestation.json','dist/frontdesk/front-desk.service.js','dist/frontdesk/durable-inbox.js','dist/frontdesk/supabase.js','dist/frontdesk/directory.js','dist/health/health.controller.js','dist/config/release.js'].map(name => join(front, name)),
  ...['release-manifest.json','build-attestation.json','dist/runtime/readiness.js','dist/health/health.controller.js','dist/lib/quote/public-schema.js'].map(name => join(solar, name)),
]
const hashes = Object.fromEntries(sourceFiles.map(path => [relative(fleet, path).replaceAll('\\','/'), sha(readFileSync(path))]))
const completeDistProofs={}
for (const dir of [front, solar]) {
  const service=ready.services.find(row => resolve(row.directory)===dir)
  assert.ok(service,'Candidate must be present in final-ready identity')
  assert.equal(resolve(service.manifestPath),join(dir,'release-manifest.json'))
  assert.equal(resolve(service.attestationPath),join(dir,'build-attestation.json'))
  assert.equal(sha(readFileSync(service.manifestPath)),service.manifestSha256)
  assert.equal(sha(readFileSync(service.attestationPath)),service.attestationSha256)
  const manifest = JSON.parse(readFileSync(join(dir, 'release-manifest.json'), 'utf8'))
  const attestation = verifyBuildAttestation(dir,manifest)
  assert.equal(attestation.sourceHash, manifest.sourceHash)
  assert.equal(manifest.sourceHash,service.sourceHash)
  assert.equal(Object.keys(attestation.compiledHashes).length,service.compiledOutputs)
  completeDistProofs[service.trade]=attestation.compiledHashes
  for (const map of ['generatedHashes','buildInputHashes','platformContractHashes']) {
    assert.ok(!Object.keys(manifest[map] ?? {}).some(key => key.endsWith('test-fleet-acceptance-boundaries.mjs')), 'Test harness must stay outside release inputs')
  }
  for (const [name, expected] of Object.entries(attestation.compiledHashes)) {
    const path = join(dir, name)
    if (sourceFiles.includes(path)) assert.equal(sha(readFileSync(path)), expected, `Attested module ${name}`)
  }
}

const original = { cwd: process.cwd(), env: { ...process.env }, fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, abortTimeout: AbortSignal.timeout }
const tenantId = '11111111-1111-4111-8111-111111111111'
const to = '+61400000001', from = '+61400000002'
const tenant = { id:tenantId, business_name:'Offline fixture', trades:['solar','electrical'], status:'active', twilio_sms_number:to }
const tables = { tenants:[tenant], sms_frontdesk_jobs:[], sms_outbox:[], sms_work_jobs:[], pricing_book:[], sms_readiness_evidence:[] }
const schemaTables = new Set(['sms_work_jobs','sms_outbox','sms_frontdesk_jobs','job_quote_operations','quotes','roofing_measurements','painting_measurements','solar_estimates','plan_extractions','aircon_recommendations','paint_runs'])
const failures = [], requests = [], results = [], forwardCalls = [], timeoutRequests = []
let schemaFailure = null, forwardMode = 'success', slowForwardSignal = null, badEngine = null
let guardRpcFailure = null, engineReadinessResult = null
let claimTime=Date.now()
let service = null, workerCallback = null, intervalCleared = false
let releasePoll = null, pollCount = 0, receiptWrites = 0
const response = (body, status=200) => new Response(JSON.stringify(body), { status, headers:{'content-type':'application/json'} })
const clone = value => structuredClone(value)

// Interpret the real PostgREST filters, including ownership and deterministic order.
function rowsFor(url, rows) {
  const result = rows.filter(row => [...url.searchParams].every(([column, expression]) => {
    if (['select','order','limit','on_conflict'].includes(column)) return true
    const dot = expression.indexOf('.'), operator = expression.slice(0,dot), value = expression.slice(dot+1)
    if (operator === 'eq') return String(row[column]) === value
    if (operator === 'gt') return row[column] != null && String(row[column]) > value
    if (operator === 'in') { assert.match(value, /^\([^()]+\)$/); return value.slice(1,-1).split(',').includes(String(row[column])) }
    throw new Error(`Unsupported fixture filter ${column}=${expression}`)
  }))
  if (url.searchParams.has('order')) {
    const order = url.searchParams.get('order').split(',').map(field => field.split('.'))
    result.sort((a,b) => {
      for (const [column,direction] of order) {
        const comparison = String(a[column] ?? '').localeCompare(String(b[column] ?? ''))
        if (comparison) return direction === 'desc' ? -comparison : comparison
      }
      return 0
    })
  }
  return url.searchParams.has('limit') ? result.slice(0,Number(url.searchParams.get('limit'))) : result
}

async function fixtureFetch(input, init={}) {
  try {
    assert.ok(typeof input === 'string' || input instanceof URL, 'Unexpected Request transport')
    const url = new URL(String(input)), method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    requests.push({ host:url.hostname, path:url.pathname, method, query:url.search })
    if (/^(electrical|plumbing|roofing|painting|solar)\.fixture\.invalid$/.test(url.hostname)) {
      const trade = url.hostname.split('.')[0]
      if (url.pathname === '/api/health/ready' && method === 'GET') {
        const rejected = trade === badEngine
        assert.equal(headers.get('x-sim-key'), rejected ? 'offline-wrong-key' : 'offline-engine-key')
        if (!rejected && trade === 'solar' && engineReadinessResult) return response(engineReadinessResult.body,engineReadinessResult.status)
        return response({ok:!rejected}, rejected ? 403 : 200)
      }
      assert.equal(url.pathname, '/api/receptionist/simulate'); assert.equal(method, 'POST')
      assert.equal(headers.get('x-sim-key'), 'offline-engine-key')
      if (init.signal?.aborted) return Promise.reject(init.signal.reason)
      forwardCalls.push(JSON.parse(init.body))
      if (forwardMode === 'slow') {
        slowForwardSignal = init.signal
        assert.ok(slowForwardSignal)
        return new Promise((_, reject) => {
          const abort = () => reject(slowForwardSignal.reason)
          if (slowForwardSignal.aborted) abort()
          else slowForwardSignal.addEventListener('abort', abort, { once:true })
        })
      }
      return response({ok:true})
    }
    assert.equal(url.origin, 'https://database.fixture.invalid', 'Unexpected external I/O')
    assert.equal(headers.get('apikey'), 'offline-service-role')
    if (['/rest/v1/rpc/sms_commercial_quote_guard_ready','/rest/v1/rpc/sms_plan_quote_guard_ready','/rest/v1/rpc/sms_quote_chain_ready'].includes(url.pathname)) {
      assert.equal(method,'POST');assert.deepEqual(JSON.parse(init.body),{})
      assert.ok(init.signal,'Guard capability reads must have a request deadline')
      return response(url.pathname.split('/').at(-1)!==guardRpcFailure)
    }
    if (url.pathname === '/rest/v1/rpc/claim_sms_frontdesk_job') {
      assert.equal(method, 'POST')
      const {p_owner} = JSON.parse(init.body)
      assert.match(p_owner, /^[\da-f-]{36}$/)
      const job = tables.sms_frontdesk_jobs.find(row => row.state === 'pending' && Date.parse(row.available_at) <= claimTime)
      if (!job) return response([])
      Object.assign(job, {state:'processing', attempts:job.attempts+1, lease_owner:p_owner, lease_until:new Date(Date.now()+60_000).toISOString()})
      return response([clone(job)])
    }
    assert.match(url.pathname, /^\/rest\/v1\/[a-z_]+$/)
    const table = url.pathname.split('/').at(-1)
    assert.ok(table in tables || schemaTables.has(table), `Unexpected table ${table}`)
    if (url.searchParams.get('limit') === '0') {
      assert.equal(method, 'GET'); assert.ok(schemaTables.has(table)); assert.ok(url.searchParams.get('select'))
      return table === schemaFailure ? response({code:'42703',message:'Offline missing schema fixture'},400) : response([])
    }
    assert.ok(table in tables, `Only schema access allowed for ${table}`)
    if (method === 'POST') {
      assert.equal(table, 'sms_frontdesk_jobs'); assert.equal(url.searchParams.get('on_conflict'), 'receipt_key')
      assert.match(headers.get('prefer'), /resolution=ignore-duplicates/)
      receiptWrites++
      const inputRow = JSON.parse(init.body)
      if (!tables[table].some(row => row.receipt_key === inputRow.receipt_key)) tables[table].push({
        state:'pending', attempts:0, sequence:tables[table].length+1, lease_owner:null, lease_until:null,
        tenant_id:null, trade:null, decision:null, last_error:null, available_at:new Date().toISOString(),
        updated_at:new Date().toISOString(), ...inputRow,
      })
      return response(null,201)
    }
    let rows = rowsFor(url, tables[table])
    if (method === 'PATCH') {
      assert.equal(table, 'sms_frontdesk_jobs')
      for (const column of ['id','lease_owner','state','lease_until']) assert.ok(url.searchParams.has(column), `Missing ownership filter ${column}`)
      assert.equal(url.searchParams.get('state'), 'eq.processing')
      assert.match(url.searchParams.get('lease_until'), /^gt\./)
      const update = JSON.parse(init.body)
      rows.forEach(row => Object.assign(row, update))
    } else assert.equal(method, 'GET')
    const select = url.searchParams.get('select')
    if (select && select !== '*') rows = rows.map(row => Object.fromEntries(select.split(',').map(key => [key,row[key]])))
    if (headers.get('accept')?.includes('vnd.pgrst.object+json')) {
      assert.equal(rows.length,1,'Fixture single-row contract')
      return response(rows[0])
    }
    return response(rows)
  } catch (error) { failures.push(String(error)); throw error }
}

async function until(predicate, description) {
  const deadline = Date.now()+5000
  while (!predicate()) {
    assert.ok(Date.now()<deadline, `Bounded fixture wait: ${description}`)
    await new Promise(resolve => original.setTimeout(resolve,2))
  }
  assert.deepEqual(failures,[], 'Unexpected fixture I/O must fail the harness')
}
const decision = {trade:'electrical', reason:'Saved offline routing decision', switched:false}
const makeDto = id => ({from,to,body:'Offline quote request',turnId:id,messageSid:`SM${id.replaceAll('-','')}`})
function ownedRow(id) { return tables.sms_frontdesk_jobs.find(row => row.id === id) }
function resStatus() { return {code:200,status(code) { this.code=code; return this }} }
function record(name, detail) { assert.deepEqual(failures,[]); results.push({name,pass:true,...detail}); process.stdout.write(`PASS ${name}\n`) }

try {
  // No inherited credentials: all transport is intercepted before compiled imports.
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, {NODE_ENV:'test', NEXT_PUBLIC_SUPABASE_URL:'https://database.fixture.invalid',
    SUPABASE_SERVICE_ROLE_KEY:'offline-service-role', FRONT_DESK_API_KEY:'offline-front-key',
    RECEPTIONIST_SIM_KEY:'offline-engine-key', TWILIO_AUTH_TOKEN:'offline-twilio-token',
    FRONT_DESK_PUBLIC_URL:'https://front.fixture.invalid', PUBLIC_WEB_ORIGIN:'https://public.fixture.invalid',
    APP_URL:'https://engine.fixture.invalid', SIM_API_KEY:'offline-engine-key', CRON_SECRET:'offline-cron',
    SMS_SIMULATE_ENABLED:'1', SMS_READINESS_TENANT_ID:tenantId })
  for (const trade of ['electrical','plumbing','roofing','painting','solar']) process.env[`RECEPTIONIST_${trade.toUpperCase()}_URL`] = `https://${trade}.fixture.invalid`
  globalThis.fetch = fixtureFetch
  const frontRequire = createRequire(join(front,'package.json')), solarRequire = createRequire(join(solar,'package.json'))
  const {FrontDeskService} = frontRequire('./dist/frontdesk/front-desk.service.js')
  const {HealthController:FrontHealth} = frontRequire('./dist/health/health.controller.js')
  const {HealthController:SolarHealth} = solarRequire('./dist/health/health.controller.js')
  const {receptionistReadiness} = solarRequire('./dist/runtime/readiness.js')
  const {DEFAULT_SOLAR_CONFIG} = solarRequire('./dist/lib/solar/config.js')
  const validSolarCard={...clone(DEFAULT_SOLAR_CONFIG.default_rate_card),stc_price_aud:DEFAULT_SOLAR_CONFIG.stc_price_aud}
  service = new FrontDeskService()

  // F13: real receipt, persisted decision, real worker tick/forward/failed retry path.
  process.chdir(front)
  const retryId = '22222222-2222-4222-8222-222222222222'
  const dto = makeDto(retryId)
  const ack = await service.handleWebhookTurn(dto)
  assert.deepEqual(ack,{ok:true,turnId:retryId})
  Object.assign(ownedRow(retryId),{decision}) // Isolate transport recovery from model classification.
  const interval = {unref() { return this }}
  globalThis.setInterval = (callback,ms) => { assert.equal(ms,1000); assert.equal(workerCallback,null); workerCallback=callback; return interval }
  globalThis.clearInterval = handle => { assert.equal(handle,interval); intervalCleared=true }
  const forwardDeadlines=[]
  AbortSignal.timeout = ms => {
    timeoutRequests.push(ms)
    if (ms!==20_000) return original.abortTimeout(ms)
    const controller=new AbortController(); forwardDeadlines.push(controller); return controller.signal
  }
  forwardMode='slow'
  claimTime=Date.parse(ownedRow(retryId).available_at)
  service.onModuleInit()
  workerCallback()
  await until(() => slowForwardSignal !== null, 'actual forward request')
  assert.equal(slowForwardSignal,forwardDeadlines[0].signal)
  assert.equal(service.draining,true)
  assert.equal(ownedRow(retryId).state,'processing')
  forwardDeadlines[0].abort(new DOMException('Offline controlled 20 second deadline','TimeoutError'))
  await until(() => !service.draining, 'failed forwarding persisted')
  const failedAttempt = clone(ownedRow(retryId))
  assert.equal(failedAttempt.state,'pending'); assert.equal(failedAttempt.attempts,1)
  assert.equal(failedAttempt.lease_owner,null); assert.equal(failedAttempt.lease_until,null)
  assert.match(failedAttempt.last_error,/did not answer within 20s/)
  assert.ok(Date.parse(failedAttempt.available_at)>Date.parse(failedAttempt.updated_at))
  workerCallback()
  await until(() => !service.draining,'early retry tick')
  assert.equal(forwardCalls.length,1,'Backoff prevents immediate forwarding')
  claimTime=Date.parse(ownedRow(retryId).available_at)+1
  forwardMode='success'
  workerCallback()
  await until(() => !service.draining,'automatic retry tick')
  assert.equal(receiptWrites,1,'Retry requires no new inbound receipt')
  assert.equal(ownedRow(retryId).state,'forwarded'); assert.equal(ownedRow(retryId).attempts,2)
  assert.equal(ownedRow(retryId).last_error,null); assert.equal(ownedRow(retryId).lease_owner,null)
  assert.equal(forwardCalls.length,2); assert.deepEqual(forwardCalls[0],forwardCalls[1])
  assert.equal(forwardCalls[1].turnId,retryId); assert.equal(forwardCalls[1].messageSid,dto.messageSid)
  assert.equal(timeoutRequests.filter(ms => ms===20_000).length,2)
  assert.equal(forwardDeadlines[1].signal.aborted,false,'Retry gets a fresh request deadline')
  service.onModuleDestroy(); assert.equal(intervalCleared,true)
  globalThis.setInterval=original.setInterval; globalThis.clearInterval=original.clearInterval; AbortSignal.timeout=original.abortTimeout
  record('F13 worker retries timed-out forwarding without new inbound',{receipts:1,forwardAttempts:2,requestedTimeoutMs:20_000,backoffMs:Date.parse(failedAttempt.available_at)-Date.parse(failedAttempt.updated_at),finalState:'forwarded'})

  // F20: mixed insertion order, tied timestamps, two turns, internal and queued noise.
  const turnA='33333333-3333-4333-8333-333333333333', turnB='44444444-4444-4444-8444-444444444444'
  const at='2026-09-08T00:00:00.000Z'
  const out = (id,turn_id,body,extra={}) => ({id,turn_id,body,audience:'customer',status:'accepted',conversation_id:`conversation:${turn_id}`,created_at:at,...extra})
  tables.sms_outbox=[out('b2',turnB,'B second'),out('a2',turnA,'A second',{status:'delivered'}),out('old','old-turn','Historical'),
    out('a1',turnA,'A first'),out('b1',turnB,'B first'),out('a0',turnA,'Internal',{audience:'owner'}),out('a3',turnA,'Unaccepted',{status:'queued'})]
  const [replyA,replyB]=await Promise.all([service.repliesForTurn(turnA),service.repliesForTurn(turnB)])
  assert.deepEqual(replyA,{conversationId:`conversation:${turnA}`,replies:['A first','A second']})
  assert.deepEqual(replyB,{conversationId:`conversation:${turnB}`,replies:['B first','B second']})
  record('F20 tied timestamp replies remain isolated and deterministically ordered',{turns:2,fixtureRows:7,returnedReplies:4})

  // F20: actual polling loop sees running, pending, then terminal descendant work.
  const pollId='55555555-5555-4555-8555-555555555555', pollDto=makeDto(pollId)
  await service.handleWebhookTurn(pollDto)
  Object.assign(ownedRow(pollId),{decision,tenant_id:tenantId,trade:'electrical',state:'forwarded'})
  tables.sms_outbox=[out('p1',pollId,'Details received')]
  tables.sms_work_jobs=[{id:'w1',turn_id:pollId,sequence:1,kind:'inbound',status:'completed'},
    {id:'w2',turn_id:pollId,sequence:2,kind:'intake',status:'completed'},
    {id:'w3',turn_id:pollId,sequence:3,kind:'estimate',status:'running'}]
  globalThis.setTimeout=(callback,ms,...args) => {
    if (ms===1500) { assert.equal(releasePoll,null); pollCount++; releasePoll=() => { releasePoll=null; callback(...args) }; return {poll:true} }
    return original.setTimeout(callback,ms,...args)
  }
  let completed=false
  const polling=service.handleMessage(pollDto).then(result => { completed=true; return result })
  await until(() => pollCount===1,'first pipeline poll')
  assert.equal(completed,false,'Intermediate acceptance cannot end a running pipeline')
  tables.sms_work_jobs[2].status='pending'
  releasePoll()
  await until(() => pollCount===2,'pending descendant poll')
  assert.equal(completed,false,'Pending descendant cannot be mistaken for terminal work')
  tables.sms_work_jobs[2].status='completed'; tables.sms_outbox.push(out('p2',pollId,'Draft saved for review'))
  releasePoll()
  const polled=await polling
  assert.equal(polled.stage,'completed'); assert.equal(polled.repliesTimedOut,false)
  assert.deepEqual(polled.replies,['Details received','Draft saved for review'])
  assert.equal(polled.turnId,pollId)
  assert.deepEqual(await service.pipelineForTurn('empty-turn'),{complete:false,stage:'in_progress',jobs:[]})
  globalThis.setTimeout=original.setTimeout
  record('F20 polling waits through running and pending estimate stages',{pollSleeps:pollCount,replies:2,emptyPipelineComplete:false})

  // No accepted output can mean either unfinished work or a legitimate terminal
  // turn. Exercise the actual poller, retaining historical/owner/queued noise.
  const silentId='66666666-6666-4666-8666-666666666666', silentDto=makeDto(silentId)
  await service.handleWebhookTurn(silentDto)
  Object.assign(ownedRow(silentId),{decision,tenant_id:tenantId,trade:'electrical',state:'forwarded'})
  tables.sms_outbox=[out('historic',pollId,'Previous turn reply'),out('silent-owner',silentId,'Internal only',{audience:'owner'}),
    out('silent-pending',silentId,'Not yet accepted',{status:'pending'})]
  tables.sms_work_jobs=[{id:'silent-work',turn_id:silentId,sequence:1,kind:'inbound',status:'pending'}]
  const beforeSilentPolls=pollCount
  globalThis.setTimeout=(callback,ms,...args) => {
    if (ms===1500) { assert.equal(releasePoll,null); pollCount++; releasePoll=() => { releasePoll=null; callback(...args) }; return {poll:true} }
    return original.setTimeout(callback,ms,...args)
  }
  let silentCompleted=false
  const silentPolling=service.handleMessage(silentDto).then(result => { silentCompleted=true; return result })
  await until(() => pollCount===beforeSilentPolls+1,'silent pending work remains pollable')
  assert.equal(silentCompleted,false,'An empty accepted-output set does not terminate pending work')
  assert.deepEqual(await service.repliesForTurn(silentId),{conversationId:null,replies:[]})
  tables.sms_work_jobs[0].status='completed'
  releasePoll()
  await until(() => silentCompleted,'terminal silent turn completes without an accepted reply')
  const silentResult=await silentPolling
  assert.equal(silentResult.turnId,silentId);assert.equal(silentResult.stage,'completed')
  assert.equal(silentResult.repliesTimedOut,false);assert.deepEqual(silentResult.replies,[])
  assert.equal(silentResult.conversationId,null)
  globalThis.setTimeout=original.setTimeout
  record('F20 pending silence waits and terminal silence completes without borrowed replies',{pollSleeps:pollCount-beforeSilentPolls,replies:0,terminalStage:'completed',repliesTimedOut:false})

  const failedSilentId='77777777-7777-4777-8777-777777777777', failedSilentDto=makeDto(failedSilentId)
  await service.handleWebhookTurn(failedSilentDto)
  Object.assign(ownedRow(failedSilentId),{decision,tenant_id:tenantId,trade:'electrical',state:'forwarded'})
  tables.sms_work_jobs=[{id:'failed-silent-work',turn_id:failedSilentId,sequence:1,kind:'inbound',status:'failed',last_error:'Offline terminal failure'}]
  let failedSilentCompleted=false
  const failedSilentPolling=service.handleMessage(failedSilentDto).then(result => { failedSilentCompleted=true; return result })
  await until(() => failedSilentCompleted,'terminal failed work returns its recovery state without accepted output')
  const failedSilentResult=await failedSilentPolling
  assert.equal(failedSilentResult.turnId,failedSilentId);assert.equal(failedSilentResult.stage,'needs_recovery')
  assert.equal(failedSilentResult.repliesTimedOut,false);assert.deepEqual(failedSilentResult.replies,[])
  assert.equal(failedSilentResult.conversationId,null)
  record('F20 terminal failed silence returns recovery state without fabricated replies',{replies:0,terminalStage:'needs_recovery',repliesTimedOut:false})

  // F21: establish an all-green baseline so each failure is attributable.
  process.chdir(solar)
  const manifest=JSON.parse(readFileSync(join(solar,'release-manifest.json'),'utf8'))
  tables.pricing_book=[{id:'pricing',tenant_id:tenantId,trade:'solar',overlays:{solar_rate_card:validSolarCard}}]
  tables.sms_readiness_evidence=[{release_hash:manifest.sourceHash,tenant_id:tenantId,trade:'solar',tool:'sms_quote',passed:true,verified_at:new Date().toISOString()}]
  const baseline=await receptionistReadiness('solar')
  assert.equal(baseline.ok,true); assert.equal(baseline.capabilities.quote,true)
  assert.ok(baseline.checks.every(check => check.ok))
  record('F21 compiled solar readiness all-green control',{checks:baseline.checks.map(check => check.name),releaseHash:manifest.sourceHash})
  const solarHealth=new SolarHealth()
  const negativeCases=[
    ['enabled_trade',() => {tenant.trades=['electrical']},() => {tenant.trades=['solar','electrical']}],
    ['tenant_pricing',() => {tables.pricing_book[0].overlays={}},() => {tables.pricing_book[0].overlays={solar_rate_card:validSolarCard}}],
    ['synthetic_workflow',() => {tables.sms_readiness_evidence[0].release_hash='different-release'},() => {tables.sms_readiness_evidence[0].release_hash=manifest.sourceHash}],
    ['public_schema:solar',() => {schemaFailure='solar_estimates'},() => {schemaFailure=null}],
    ['schema:job_quote_operations',() => {schemaFailure='job_quote_operations'},() => {schemaFailure=null}],
  ]
  for (const [checkName,breakFixture,restoreFixture] of negativeCases) {
    breakFixture()
    try {
      const res=resStatus(), result=await solarHealth.ready('offline-engine-key',res)
      assert.equal(res.code,503); assert.equal(result.ok,false); assert.equal(result.capabilities.quote,false)
      assert.deepEqual(result.checks.filter(check => !check.ok).map(check => check.name),[checkName])
      assert.equal(solarHealth.live().ok,true)
      record(`F21 solar ${checkName} failure rejects quoting readiness`,{failedCheck:checkName,readinessStatus:503,liveness:true})
    } finally { restoreFixture() }
  }
  assert.equal((await receptionistReadiness('solar')).ok,true,'Restored all-green baseline')

  process.chdir(front)
  const frontHealth=new FrontHealth(), readyRes=resStatus()
  assert.equal((await frontHealth.dependencies('offline-front-key',readyRes)).ok,true)
  assert.equal(readyRes.code,200)
  for (const [rpc,checkName] of [
    ['sms_commercial_quote_guard_ready','schema:commercial_quote_guard'],
    ['sms_plan_quote_guard_ready','schema:plan_quote_guard'],
    ['sms_quote_chain_ready','schema:quote_chain'],
  ]) {
    guardRpcFailure=rpc
    try {
      process.chdir(solar)
      const engineRes=resStatus(), engineBody=await solarHealth.ready('offline-engine-key',engineRes)
      assert.equal(engineRes.code,503);assert.equal(engineBody.ok,false);assert.equal(engineBody.capabilities.quote,false)
      assert.deepEqual(engineBody.checks.filter(check=>!check.ok).map(check=>check.name),[checkName])
      assert.equal(solarHealth.live().ok,true)
      // The actual compiled engine response is the controlled HTTP boundary for
      // the actual front-desk dependency method; no fabricated readiness result.
      engineReadinessResult={body:engineBody,status:engineRes.code}
      process.chdir(front)
      const frontRes=resStatus(), frontBody=await frontHealth.dependencies('offline-front-key',frontRes)
      assert.equal(frontRes.code,503);assert.equal(frontBody.ok,false)
      assert.equal(frontBody.config,true);assert.equal(frontBody.schema,true)
      assert.deepEqual(frontBody.services.filter(row=>!row.ok).map(row=>row.trade),['solar'])
      assert.match(frontBody.services.find(row=>row.trade==='solar').detail,/HTTP 503/)
      assert.equal(frontHealth.live().ok,true)
      record(`F21 ${checkName} failure reaches engine and front-desk dependency readiness`,{failedCheck:checkName,engineStatus:503,frontDeskStatus:503,liveness:true})
    } finally {guardRpcFailure=null;engineReadinessResult=null;process.chdir(front)}
  }
  process.env.RECEPTIONIST_SOLAR_SIM_KEY='offline-wrong-key'; badEngine='solar'
  const health=await service.serviceHealth()
  assert.deepEqual(health.filter(row => !row.ok).map(row => row.trade),['solar'])
  assert.match(health.find(row => row.trade==='solar').detail,/HTTP 403/)
  const dependencyRes=resStatus(), dependencies=await frontHealth.dependencies('offline-front-key',dependencyRes)
  assert.equal(dependencyRes.code,503); assert.equal(dependencies.ok,false)
  assert.equal(dependencies.config,true); assert.equal(dependencies.schema,true); assert.ok(dependencies.release)
  assert.deepEqual(dependencies.services.filter(row => !row.ok).map(row => row.trade),['solar'])
  assert.equal(frontHealth.live().ok,true)
  record('F21 bad engine auth rejects front-desk capability while liveness stays green',{healthyControlStatus:200,failedTrade:'solar',engineStatus:403,dependencyStatus:503,liveness:true})

  process.chdir(solar)
  tables.pricing_book[0].overlays={solar_rate_card:{fixture_rate:1}}
  const invalidCardRes=resStatus(), invalidCard=await solarHealth.ready('offline-engine-key',invalidCardRes)
  assert.equal(invalidCardRes.code,503,'Nonempty invalid rate card must not certify solar quote capability')
  assert.equal(invalidCard.ok,false); assert.equal(invalidCard.capabilities.quote,false)
  assert.deepEqual(invalidCard.checks.filter(check => !check.ok).map(check => check.name),['tenant_pricing'])
  assert.equal(solarHealth.live().ok,true)
  record('F21 nonempty invalid solar rate card rejects quote readiness',{readinessStatus:503,liveness:true})

  for (const [name,expected] of Object.entries(hashes)) assert.equal(sha(readFileSync(join(fleet,name))),expected,`Artifact changed during acceptance: ${name}`)
  assert.equal(sha(readFileSync(readyPath)),sha(readyBytes),'Final-ready identity changed during acceptance')
  for (const dir of [front,solar]) {
    const service=ready.services.find(row => resolve(row.directory)===dir)
    assert.deepEqual(verifyBuildAttestation(dir).compiledHashes,completeDistProofs[service.trade],'Complete compiled inventory changed during acceptance')
  }
  assert.deepEqual(failures,[])
  mkdirSync(dirname(reportPath),{recursive:true})
  writeFileSync(reportPath,JSON.stringify({pass:true,completedAt:new Date().toISOString(),scriptHash:sha(readFileSync(scriptPath)),
    readyIdentity:{path:readyPath,sha256:sha(readyBytes)},artifacts:hashes,completeDistProofs,results,transportRequests:requests.length,unexpectedIo:failures,
    limits:['Controlled in-memory PostgREST/HTTP responses; not real PostgreSQL claim semantics or provider availability.',
      'Actual compiled methods invoked directly; no Nest HTTP server, live model, carrier, credentials or deployed readiness certification.',
      'Forward timeout requested 20000ms and abort behavior exercised; elapsed wall-time deadline is controlled.',
      'Valid solar pricing fixture copies the shipped test values into tenant storage; no production prices or model estimates are verified.']},null,2)+'\n')
} finally {
  if (service && workerCallback && !intervalCleared) service.onModuleDestroy()
  globalThis.fetch=original.fetch; globalThis.setTimeout=original.setTimeout; globalThis.clearTimeout=original.clearTimeout
  globalThis.setInterval=original.setInterval; globalThis.clearInterval=original.clearInterval; AbortSignal.timeout=original.abortTimeout
  process.chdir(original.cwd)
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env,original.env)
}
