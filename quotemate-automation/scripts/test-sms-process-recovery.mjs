#!/usr/bin/env node
// Parent PGlite remains alive across real child SIGKILL/restart cycles. This is
// an offline compiled-primitive acceptance harness, not a deployed SMS journey.
import { PGlite } from '@electric-sql/pglite'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const appDirectory = resolve(scriptDirectory, '..')
const fleet = resolve(process.argv[2] ?? '')
const reportPath = process.argv[3] ? resolve(process.argv[3]) : null
if (!process.argv[2]) throw new Error('Usage: node scripts/test-sms-process-recovery.mjs <compiled-fleet-directory> [report.json] [trade]')
const trades = process.argv[4] ? [process.argv[4]] : ['electrical', 'plumbing', 'roofing', 'painting', 'solar']
const db = new PGlite()
const children = new Set()
const events = [], transports = [], results = [], burstResults = [], compiled = []
const identifier = value => { if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid SQL identifier'); return `"${value}"` }
const allowedTables = new Set(['sms_conversations','sms_messages','intakes','quotes'])
const allowedRpc = new Set(['enqueue_sms_work','claim_sms_work','renew_sms_work','assert_sms_work_owner','checkpoint_sms_work','finish_sms_work','sms_outbox_enqueue','sms_outbox_claim','sms_outbox_finish'])
await db.exec(`create role anon; create role authenticated; create role service_role;
  create table tenants(id uuid primary key);
  create table sms_conversations(id uuid primary key,tenant_id uuid,from_number text,to_number text,status text,conversation_type text,latest_action text);
  create table sms_messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,direction text,body text,twilio_message_sid text unique,audience text default 'customer',to_number text,tenant_id uuid);
  create table intakes(id uuid primary key,scope jsonb);
  create table quotes(id uuid primary key,intake_id uuid,status text,total_ex_gst integer);
  create table plan_upload_requests(id uuid primary key default gen_random_uuid(),token text unique,tenant_id uuid,sms_conversation_id uuid,customer_phone text,twilio_number text,status text,created_at timestamptz default now(),updated_at timestamptz default now(),expires_at timestamptz default now()+interval '7 days');`)
for (const migration of ['198_sms_durable_work.sql','199_sms_delivery_outbox.sql']) await db.exec(readFileSync(join(appDirectory,'sql/migrations',migration),'utf8'))
const server = createServer(async (request, response) => {
  try {
    let text = ''
    for await (const chunk of request) { text += chunk; if (text.length > 100000) throw new Error('Oversized fixture request') }
    const body = JSON.parse(text)
    let output
    if (request.url === '/rpc') {
      assert.ok(allowedRpc.has(body.name))
      const keys = Object.keys(body.args)
      const jsonParameters = new Set(['p_payload','p_value','p_result'])
      const result = await db.query(`select * from ${identifier(body.name)}(${keys.map((key, i) => `${identifier(key)} => $${i+1}`).join(',')})`, keys.map(key=>jsonParameters.has(key) ? JSON.stringify(body.args[key]) : body.args[key]))
      output = { data: body.name === 'claim_sms_work' ? result.rows : body.name === 'enqueue_sms_work' ? result.rows[0] : result.rows[0]?.[body.name], error: null }
    } else if (request.url === '/table') {
      assert.ok(allowedTables.has(body.table))
      const entries = Object.entries(body.payload ?? {}), values = []
      const value = item => { values.push(item); return `$${values.length}` }
      let sql = `select * from ${identifier(body.table)}`
      if (body.action === 'insert') sql = `insert into ${identifier(body.table)}(${entries.map(([key]) => identifier(key)).join(',')}) values(${entries.map(([, item]) => value(item)).join(',')})`
      if (body.action === 'update') sql = `update ${identifier(body.table)} set ${entries.map(([key, item]) => `${identifier(key)}=${value(item)}`).join(',')}`
      const filters = Object.entries(body.filters)
      if (filters.length) sql += ` where ${filters.map(([key, item]) => `${identifier(key)}=${value(item)}`).join(' and ')}`
      if (body.action !== 'select') sql += ' returning *'
      const result = await db.query(sql, values)
      output = { data: body.single ? result.rows[0] ?? null : result.rows, error: null }
    } else if (request.url === '/event') { events.push(body); output = { ok: true } }
    else if (request.url === '/carrier') { const sid = `SM${randomUUID().replaceAll('-','')}`; transports.push({ ...body, sid }); output = { sid } }
    else throw new Error('Unknown fixture endpoint')
    response.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(output))
  } catch (error) {
    // Like PostgREST: database failures are structured results, preserving SQLSTATE.
    response.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({ data:null,error:{code:error.code ?? 'FIXTURE',message:String(error)} }))
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}`
function child(candidate, mode, boundary, data) {
  const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, NODE_ENV:'test',
    PUBLIC_WEB_ORIGIN:'https://quotemax.com.au', CRON_SECRET:'offline-only' }
  const processChild = spawn(process.execPath,[join(scriptDirectory,'sms-process-worker.cjs'),candidate,endpoint,mode,boundary,data.scenario,data.tenant,data.conversation,data.trade,data.followupSerial ?? ''],
    { env, windowsHide:true, stdio:['ignore','pipe','pipe','ipc'] })
  children.add(processChild)
  let output = ''
  const messages = []
  processChild.stdout.on('data', chunk => { output += chunk }); processChild.stderr.on('data', chunk => { output += chunk })
  let stopped = false
  const finished = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { processChild.kill('SIGKILL'); reject(new Error(`Child timed out: ${output}`)) },30000)
    processChild.once('error', reject)
    processChild.once('exit', (code, signal) => { clearTimeout(deadline);children.delete(processChild);if(code === 0 || stopped)resolve({code,signal});else reject(new Error(`Child exit ${code}/${signal}: ${output}`)) })
  })
  // Register both boundary and completion listeners before the child can run.
  let notifyBoundary
  const boundaryReached = new Promise(resolve => { notifyBoundary = resolve })
  processChild.on('message', message => { messages.push(message);if(message.event === 'boundary')notifyBoundary(message) })
  async function pauseAtBoundary() {
    const message = await Promise.race([boundaryReached, finished.then(() => { throw new Error(`No ${boundary} boundary: ${output}`) })])
    assert.equal(message.pid, processChild.pid)
    return message
  }
  return { finished, messages, pauseAtBoundary, resume:()=>processChild.send({command:'continue'}), async killAtBoundary() {
    const message = await pauseAtBoundary()
    stopped = true
    processChild.kill('SIGKILL')
    await finished
    return message
  } }
}
async function expire() { await db.exec("update sms_work_jobs set lease_until=now()-interval '1 second' where status='running'; update sms_outbox set lease_until=now()-interval '1 second' where status='sending'") }
async function run(candidate, data) { const worker = child(candidate,'run','none',data);await worker.finished;return worker }
try {
  for (const trade of trades) {
    const candidate = join(fleet,`qm-${trade}-receptionist`)
    const compiledFiles = ['durable-work','durable-outbox','delivery-context'].map(name => join(candidate,`dist/lib/sms/${name}.js`))
    const hashes = Object.fromEntries(compiledFiles.map(path => [path,createHash('sha256').update(readFileSync(path)).digest('hex')]))
    compiled.push({trade,hashes})
    for (const boundary of ['receipt','intake','quote','outbox','ambiguous']) {
      await db.exec('truncate sms_outbox,sms_work_jobs,sms_messages,sms_conversations,intakes,quotes,tenants cascade')
      events.length = 0;transports.length = 0
      const data = { trade,scenario:`${trade}-${boundary}-${randomUUID()}`,tenant:randomUUID(),conversation:randomUUID() }
      await db.query('insert into tenants values($1)',[data.tenant])
      await db.query("insert into sms_conversations(id,tenant_id,status) values($1,$2,'open')",[data.conversation,data.tenant])
      const first = child(candidate,'receipt',boundary === 'receipt' ? boundary : 'none',data)
      let killed
      if (boundary === 'receipt') killed = await first.killAtBoundary()
      else {
        await first.finished
        killed = await child(candidate,'run',boundary,data).killAtBoundary()
      }
      const afterKill = (await db.query('select kind,status,checkpoint from sms_work_jobs order by sequence')).rows
      assert.ok(afterKill.length > 0,'Receipt must remain in the parent database after process loss')
      await expire()
      let staleOwnerRejected = false
      if(killed.owner) {
        const successor = (await db.query("select * from claim_sms_work(array['inbound','intake','estimate'],$1,90,$2)",[killed.job,trade])).rows[0]
        assert.ok(successor?.owner_token && successor.owner_token !== killed.owner)
        await assert.rejects(db.query('insert into quotes(id,sms_work_id,sms_work_owner) values($1,$2,$3)',[randomUUID(),killed.job,killed.owner]),/lease lost/)
        await assert.rejects(db.query('select finish_sms_work($1,$2)',[killed.job,killed.owner]),/lease lost/)
        assert.equal((await db.query('select owner_token from sms_work_jobs where id=$1',[killed.job])).rows[0].owner_token,successor.owner_token)
        staleOwnerRejected = true
        await expire()
      }
      // Duplicate transport receipt after the killed process uses the same job.
      await child(candidate,'receipt','none',data).finished
      await run(candidate,data)
      assert.equal((await db.query('select count(*)::int as n from intakes')).rows[0].n,1)
      const quotes = (await db.query('select status,total_ex_gst from quotes')).rows
      assert.deepEqual(quotes,[{status:'awaiting_tradie_approval',total_ex_gst:12345}])
      let outbound = (await db.query('select status,requires_attention from sms_outbox')).rows
      assert.deepEqual(outbound,[{status:boundary === 'ambiguous' ? 'unknown' : 'accepted',requires_attention:boundary === 'ambiguous'}])
      assert.equal(transports.length,1,'A killed or ambiguous worker must not automatically send twice')
      assert.equal((await db.query("select count(*)::int as n from sms_messages where direction='outbound'")).rows[0].n,boundary === 'ambiguous' ? 0 : 1)
      assert.deepEqual(events.filter(event=>event.kind==='model').map(event=>event.key),['initial','facts','price'])
      const checkpointAfterRecovery = (await db.query('select kind,status,attempts,checkpoint from sms_work_jobs order by sequence')).rows
      assert.ok(checkpointAfterRecovery.every(row=>row.status==='completed'))
      // Queue ordered distinct turns; eight simultaneous duplicate deliveries
      // per turn must collapse into one durable receipt and one intended reply.
      for(const action of ['correction','price-question','resend']) {
        const burst = child(candidate,'enqueue',action,data)
        await burst.finished
        const ids = burst.messages.find(message=>message.event==='enqueued')?.ids
        assert.equal(ids?.length,8)
        assert.equal(new Set(ids).size,1)
      }
      await Promise.all([run(candidate,data),run(candidate,data)])
      await run(candidate,data)
      assert.deepEqual(events.filter(event=>event.kind==='processed').map(event=>event.key),['correction','price-question','resend'])
      assert.deepEqual(events.filter(event=>event.kind==='model').map(event=>event.key),['initial','facts','price','correction','price-question','resend'])
      assert.equal((await db.query('select latest_action from sms_conversations')).rows[0].latest_action,'resend')
      assert.equal((await db.query('select count(*)::int as n from quotes')).rows[0].n,1)
      assert.equal((await db.query("select count(*)::int as n from sms_work_jobs where status='completed'")).rows[0].n,6)
      assert.equal((await db.query("select count(*)::int as n from sms_messages where direction='inbound'")).rows[0].n,4)
      outbound = (await db.query('select status from sms_outbox')).rows
      assert.equal(outbound.length,4)
      assert.equal(transports.length,4)
      assert.equal((await db.query("select count(*)::int as n from sms_messages where direction='outbound'")).rows[0].n,boundary === 'ambiguous' ? 3 : 4)
      results.push({trade,boundary,killedPid:killed.pid,staleOwnerRejected,afterKill,checkpointAfterRecovery,
        initialDrafts:1,initialOutboxIntents:1,transportCallsBeforeBurst:1,ambiguousStatus:boundary==='ambiguous'?'unknown':null,
        duplicateDeliveries:24,followupIntents:3,fifo:['correction','price-question','resend'],completedJobs:6})
      console.log(`PASS ${trade} ${boundary}: killed ${killed.pid}; one draft/intent; FIFO burst; ${staleOwnerRejected ? 'stale owner fenced' : 'receipt survives'}`)
    }
    for(const boundary of ['before-history','after-history','during-draft','before-unlock']) {
      await db.exec('truncate sms_outbox,sms_work_jobs,sms_messages,sms_conversations,intakes,quotes,tenants cascade')
      events.length=0;transports.length=0
      const data={trade,scenario:`${trade}-${boundary}-${randomUUID()}`,tenant:randomUUID(),conversation:randomUUID()}
      await db.query('insert into tenants values($1)',[data.tenant])
      await db.query("insert into sms_conversations(id,tenant_id,status) values($1,$2,'open')",[data.conversation,data.tenant])
      await child(candidate,'receipt','none',data).finished
      const predecessor=child(candidate,'run',boundary,data)
      const paused=await predecessor.pauseAtBoundary()
      const owner=(await db.query('select serial_key,owner_token,status from sms_work_jobs where id=$1',[paused.job])).rows[0]
      assert.equal(owner.status,'running');assert.equal(owner.owner_token,paused.owner)
      for(const action of ['correction','price-question','resend']) {
        const burst=child(candidate,'enqueue',action,{...data,followupSerial:owner.serial_key})
        await burst.finished
        const ids=burst.messages.find(message=>message.event==='enqueued')?.ids
        assert.equal(ids?.length,8);assert.equal(new Set(ids).size,1)
      }
      const competitor=child(candidate,'inbound-only','none',data)
      await competitor.finished
      assert.deepEqual(competitor.messages.find(message=>message.event==='complete')?.results,[],'Same serial followers must remain blocked until the predecessor releases')
      assert.equal(events.filter(event=>event.kind==='processed').length,0)
      const queued=(await db.query("select work_key,status from sms_work_jobs where work_key in ($1,$2,$3) order by sequence",[`${data.scenario}:correction`,`${data.scenario}:price-question`,`${data.scenario}:resend`])).rows
      assert.equal(queued.length,3);assert.ok(queued.every(row=>row.status==='pending'))
      predecessor.resume()
      await predecessor.finished
      await run(candidate,data)
      assert.deepEqual(events.filter(event=>event.kind==='processed').map(event=>event.key),['correction','price-question','resend'])
      assert.deepEqual(events.filter(event=>event.kind==='model').map(event=>event.key).sort(),['correction','facts','initial','price','price-question','resend'])
      assert.equal((await db.query('select count(*)::int as n from quotes')).rows[0].n,1)
      assert.equal((await db.query('select count(*)::int as n from intakes')).rows[0].n,1)
      assert.equal((await db.query('select count(*)::int as n from sms_outbox')).rows[0].n,4)
      assert.equal((await db.query("select count(*)::int as n from sms_work_jobs where status='completed'")).rows[0].n,6)
      assert.equal((await db.query("select count(*)::int as n from sms_messages where direction='inbound'")).rows[0].n,4)
      assert.equal((await db.query("select count(*)::int as n from sms_messages where direction='outbound'")).rows[0].n,4)
      assert.equal(transports.length,4)
      burstResults.push({trade,boundary,predecessorPid:paused.pid,duplicateDeliveries:24,queuedReceipts:3,competitorClaims:0,fifo:['correction','price-question','resend'],completedJobs:6,initialDrafts:1,outboxIntents:4})
      console.log(`PASS ${trade} ${boundary} burst: 24 deliveries/3 queued receipts; competitor claims0; FIFO once after resume`)
    }
    for(const [path,hash] of Object.entries(hashes))assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),hash,'Compiled library changed during acceptance run')
  }
} finally {
  await Promise.all([...children].map(processChild=>new Promise(resolve=>{processChild.once('exit',resolve);processChild.kill('SIGKILL')})))
  await new Promise(resolve => server.close(resolve))
  await db.close()
}
const report = { generatedAt:new Date().toISOString(),scope:'Compiled durable-work/outbox primitives with fixture stages; parent PGlite survives child kills. Not full handlers, live carrier, or deployed E2E.',
  limitations:['Fixture inbound/intake/estimate handlers, not full compiled route handlers. Existing actual-route regression tests cover route-specific replay.',
    'PGlite serializes local SQL; this does not certify multi-connection production Postgres contention.',
    'Lease expiration is advanced with local SQL to avoid wall-clock waits; production lease durations are unchanged.',
    'Correction/resend fixtures prove FIFO work/intents, not business pricing or approved-link selection semantics.',
    'Paused draft followers deliberately share the draft job serial key. Actual production route serial-key assignment and timing remain covered only by separate route tests.'],compiled,results,burstResults }
if(reportPath){mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n')}
console.log(`PASS ${results.length} compiled process-kill scenarios and ${burstResults.length} paused FIFO burst scenarios across ${compiled.length} candidates${reportPath ? `; evidence ${reportPath}` : ''}`)
