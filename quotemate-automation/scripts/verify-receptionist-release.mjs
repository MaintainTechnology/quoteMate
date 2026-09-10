#!/usr/bin/env node
// Offline promotion gate for a BUILT candidate. It never contacts providers.
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { verifyPlatformContractHashes } from './receptionist-platform-contract.mjs'
import { receptionistSourceHash } from './receptionist-release-fingerprint.mjs'
import { verifyBuildAttestation } from './receptionist-build.mjs'
import { REQUIRED_RECEPTIONIST_MIGRATIONS, verifyReceptionistSchemaHashes } from './receptionist-schema-contract.mjs'

const directory = resolve(process.argv[2] ?? '.')
const read = (file) => readFileSync(join(directory,file),'utf8')
const manifest = JSON.parse(read('release-manifest.json'))
assert.equal(manifest.contractVersion,2,'Unsupported release contract')
assert.equal(manifest.approvalRequired,true,'Release requires human approval')
assert.deepEqual(manifest.requiredMigrations,REQUIRED_RECEPTIONIST_MIGRATIONS)
const platform = resolve(fileURLToPath(new URL('..',import.meta.url)))
if (manifest.trade !== 'front-desk') {
  verifyPlatformContractHashes(manifest.platformContractHashes, platform)
  verifyReceptionistSchemaHashes(manifest.platformContractHashes,platform)
}
for (const [file,expected] of Object.entries(manifest.generatedHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(join(directory,file))).digest('hex'),expected,`Unreviewed generated edit: ${file}`)
}
assert.ok(manifest.buildInputHashes?.['package.json'],'No dependency/build-input fingerprint')
assert.ok(manifest.buildInputHashes?.['package-lock.json'],'No sealed dependency lock; run seal-receptionist-release.mjs after dependency resolution and before building')
for (const [file,expected] of Object.entries(manifest.buildInputHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(join(directory,file))).digest('hex'),expected,`Unreviewed build input: ${file}`)
}
if (manifest.trade==='front-desk') {
  assert.ok(manifest.buildInputHashes['release-schema.json'],'Front-desk schema contract is not fingerprinted')
  const schema=JSON.parse(read('release-schema.json'))
  assert.equal(schema.version,1,'Unsupported schema contract')
  assert.deepEqual(schema.requiredMigrations,REQUIRED_RECEPTIONIST_MIGRATIONS)
  verifyReceptionistSchemaHashes(schema.migrationHashes,platform)
}
assert.equal(manifest.sourceHash,receptionistSourceHash(manifest),'Release fingerprint does not match its source, build inputs and website contract')
for (const file of ['scripts/receptionist-build.mjs','scripts/receptionist-release-fingerprint.mjs']) {
  assert.ok(manifest.buildInputHashes[file], `Build attestation producer is not fingerprinted: ${file}`)
}
verifyBuildAttestation(directory, manifest)
const lock = JSON.parse(read('package-lock.json'))
const pkg = JSON.parse(read('package.json'))
for (const [name,version] of Object.entries(pkg.dependencies)) {
  assert.ok(lock.packages[`node_modules/${name}`]?.version,`Missing locked dependency ${name}`)
  if (/^\d/.test(version)) assert.equal(lock.packages[`node_modules/${name}`].version,version)
}
const require = createRequire(join(directory,'package.json'))
if (manifest.trade === 'front-desk') {
  require(join(directory,'dist/frontdesk/route-turn.check.js'))
  require(join(directory,'dist/frontdesk/durable-inbox.check.js'))
} else {
  const { publicWebOrigin } = require(join(directory,'dist/lib/sms/public-origin.js'))
  assert.equal(publicWebOrigin({APP_URL:'https://quotemax.com.au',NODE_ENV:'production'}),'https://quotemax.com.au')
  for (const invalid of ['https://qm-test.up.railway.app','http://localhost:3101','https://example.com/q/a']) {
    assert.throws(() => publicWebOrigin({ APP_URL: invalid, NODE_ENV:'production' }))
  }
  for (const file of ['dist/runtime/workers.js','dist/lib/sms/durable-work.js','dist/lib/sms/work-delivery-context.js','dist/lib/sms/durable-outbox.js']) {
    assert.ok(existsSync(join(directory,file)),`Missing compiled runtime: ${file}`)
  }
  const inbound = read('src/receptionist/inbound.route.ts')
  assert.match(inbound,/enqueueSmsWork\(/,'Inbound lacks durable receipt boundary')
  assert.match(read('src/main.ts'),/SMS_WORKER_SERVICE = TRADE/,'Unscoped worker can steal another service turn')
  assert.match(read('src/runtime/workers.ts'),/smsDeliveryWorkScope/,'Outbox lacks durable turn scope')
  assert.match(read('src/runtime/workers.ts'),/recoverSmsOutbox/,'Outbox recovery is not scheduled')
  const { startIndependentPollers } = require(join(directory,'dist/runtime/scheduler.js'))
  // Exercise the compiled scheduler's guards with explicit timer delivery. Host
  // contention must not turn a fixed sleep into a false capability failure.
  const originalSetInterval=globalThis.setInterval, originalClearInterval=globalThis.clearInterval
  const timers=new Set()
  let workCalls=0, recoveryCalls=0, stop
  try {
    globalThis.setInterval=(callback)=>{
      const timer={callback,unref(){return this}}
      timers.add(timer)
      return timer
    }
    globalThis.clearInterval=(timer)=>{timers.delete(timer)}
    stop=startIndependentPollers(()=>{workCalls++;return new Promise(()=>{})},async()=>{recoveryCalls++},5)
    for (let round=0;round<2;round++) {
      for (const timer of timers) timer.callback()
      await new Promise((resolve)=>setImmediate(resolve))
    }
    assert.equal(workCalls,1,'A hung attempt must not start duplicate local work')
    assert.equal(recoveryCalls,2,'A hung model must not pause outbox recovery')
    stop()
    assert.equal(timers.size,0,'Shutdown must clear every polling timer')
  } finally {
    stop?.()
    globalThis.setInterval=originalSetInterval
    globalThis.clearInterval=originalClearInterval
  }
  assert.match(read('src/receptionist/receptionist.controller.ts'),/mediaContentTypes/,'MIME metadata is discarded')
  assert.doesNotMatch(read('src/lib/sms/service-dialog.ts'),/HOLDING_REPLY|general dialog is disabled/,'Terminal holding fallback survived export')
}
console.log(`PASS release contract ${manifest.trade}: ${manifest.sourceHash}; build, lock, hashes, required schema, worker and origin checks`)
