#!/usr/bin/env node
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,existsSync,chmodSync} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {verifyBuildAttestation} from './receptionist-build.mjs'

const scriptDir=dirname(fileURLToPath(import.meta.url))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const execute=promisify(execFile)
const auditFiles=['sms-image-offline-fixture.cjs','sms-image-probe.mjs','sms-smoke-process.mjs','receptionist-build.mjs','receptionist-release-fingerprint.mjs']
export async function dockerCommand(args,timeout=10_000) {
  return (await execute('docker',args,{encoding:'utf8',timeout,killSignal:'SIGKILL',windowsHide:true,maxBuffer:4*1024*1024})).stdout.trim()
}
/** Runs an already-built image only. It never builds, pushes or deploys. */
export async function testReceptionistImage({candidate,imageId,reportPath,run=dockerCommand}) {
  assert.match(imageId,/^sha256:[a-f0-9]{64}$/,'Use the immutable ID emitted by docker build --iidfile')
  assert.ok(!existsSync(reportPath),'Use a fresh image report path')
  const bytes=readFileSync(join(candidate,'release-manifest.json')),manifest=JSON.parse(bytes)
  verifyBuildAttestation(candidate,manifest)
  assert.ok(['electrical','plumbing','roofing','painting','solar','front-desk'].includes(manifest.trade))
  const manifestHash=sha(bytes),auditDir=mkdtempSync(join(tmpdir(),'qm-image-audit-'))
  chmodSync(auditDir,0o755) // Container USER node must traverse a host-owned directory.
  const helperHashes={}
  for(const file of auditFiles) {copyFileSync(join(scriptDir,file),join(auditDir,file));chmodSync(join(auditDir,file),0o644);helperHashes[file]=sha(readFileSync(join(auditDir,file)))}
  const env={NODE_ENV:'production',PORT:'8080',APP_URL:'https://quotemax.example',PUBLIC_WEB_ORIGIN:'https://quotemax.example',NEXT_PUBLIC_APP_URL:'https://quotemax.example',
    ENGINE_BASE_URL:'http://127.0.0.1:8080',NEXT_PUBLIC_SUPABASE_URL:'https://sms-image.invalid',SUPABASE_SERVICE_ROLE_KEY:'offline-service-key',
    TWILIO_AUTH_TOKEN:'offline-auth-token',TWILIO_ACCOUNT_SID:'AC00000000000000000000000000000000',TWILIO_FROM_NUMBER:'+61400000002',
    SIM_API_KEY:'offline-sim-key',RECEPTIONIST_SIM_KEY:'offline-sim-key',SMS_SIMULATE_ENABLED:'1',CRON_SECRET:'offline-cron-secret',
    FRONT_DESK_API_KEY:'offline-front-key',FRONT_DESK_PUBLIC_URL:'https://front.sms-image.invalid',
    SMS_READINESS_TENANT_ID:'',SMS_IMAGE_AUDIT_ACTIVE:'1',SMS_IMAGE_AUDIT_TRADE:manifest.trade}
  const config=readFileSync(join(candidate,'src/config/required-env.ts'),'utf8')
  const required=config.match(/(?:export\s+)?const\s+REQUIRED(?:_ENV)?\s*=\s*(\[[\s\S]*?\])\s+as\s+const/)
  assert.ok(required,'Unknown required-environment declaration')
  for(const key of required[1].match(/["']([A-Z][A-Z0-9_]+)["']/g)??[]) {const name=key.slice(1,-1);if(!(name in env))env[name]='offline-test-value'}
  for(const trade of ['electrical','plumbing','roofing','painting','solar'])env[`RECEPTIONIST_${trade.toUpperCase()}_URL`]=`https://${trade}.sms-image.invalid`
  const name=`qm-sms-contract-${randomUUID()}`,label=`quotemax.audit=${name}`
  let created=false,proof=null,failure=null,logs='',removed=false
  const inspect=async()=>JSON.parse(await run(['inspect',name]))[0]
  try {
    // Mark before create: an uncertain CLI response must still attempt cleanup
    // of this unique, labelled name, without touching any other container.
    created=true
    await run(['create','--name',name,'--label',label,'--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
      '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','768m',
      '--mount',`type=bind,src=${auditDir},dst=/audit,readonly`,...Object.entries(env).flatMap(([key,value])=>['--env',`${key}=${value}`]),
      '--entrypoint','node',imageId,'--require','/audit/sms-image-offline-fixture.cjs','dist/main.js'])
    const initial=await inspect();assert.equal(initial.Image,imageId);assert.equal(initial.Config.Labels['quotemax.audit'],name)
    assert.equal(initial.HostConfig.NetworkMode,'none');assert.equal(initial.HostConfig.ReadonlyRootfs,true)
    const binds=initial.Mounts.filter(mount=>mount.Type==='bind')
    assert.equal(binds.length,1);assert.equal(binds[0].Destination,'/audit');assert.equal(binds[0].RW,false)
    assert.equal(resolve(binds[0].Source),resolve(auditDir))
    assert.ok(initial.Mounts.every(mount=>mount.Type==='bind'||(mount.Type==='tmpfs'&&mount.Destination==='/tmp')))
    assert.ok(!initial.HostConfig.PortBindings||Object.keys(initial.HostConfig.PortBindings).length===0)
    await run(['start',name])
    proof=JSON.parse(await run(['exec',name,'node','/audit/sms-image-probe.mjs','http',manifestHash,manifest.trade],60_000))
    assert.equal(proof.pass,true);assert.equal(proof.trade,manifest.trade);assert.equal(proof.artifact.sourceHash,manifest.sourceHash)
    assert.equal(proof.artifact.metadata.manifest,manifestHash);assert.deepEqual(proof.state.unexpected,[])
    assert.equal(sha(readFileSync(join(candidate,'release-manifest.json'))),manifestHash)
    verifyBuildAttestation(candidate,manifest)
    for(const [file,hash] of Object.entries(helperHashes))assert.equal(sha(readFileSync(join(auditDir,file))),hash)
  } catch(error) {failure=error}
  finally {
    if(created) {
      try {
        const current=await inspect();assert.equal(current.Config.Labels['quotemax.audit'],name,'Refusing cleanup of another container')
        try{logs=await run(['logs',name])}catch(error){failure??=error}
        await run(['rm','--force',name])
        const remaining=await run(['ps','--all','--quiet','--filter',`label=${label}`])
        assert.equal(remaining,'','Container removal was not confirmed');removed=true
      } catch(error) {failure??=error}
    }
  }
  mkdirSync(dirname(reportPath),{recursive:true})
  writeFileSync(reportPath+'.container.log',logs)
  const result={pass:!failure&&removed,completedAt:new Date().toISOString(),imageId,trade:manifest.trade,sourceHash:manifest.sourceHash,
    manifestSha256:manifestHash,helperHashes,containerRemoved:removed,proof,error:failure?String(failure):null,
    limits:['Actual image bootstrap/HTTP with controlled receipt/schema fixtures; no pricing/model/carrier execution.',
      'Docker network none and explicit inert environment; no deployment or provider configuration changes.']}
  writeFileSync(reportPath,JSON.stringify(result,null,2)+'\n')
  if(failure)throw failure
  return result
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [candidate,imageId,reportPath]=process.argv.slice(2)
  assert.ok(candidate&&imageId&&reportPath,'Usage: node test-receptionist-image.mjs <candidate> <sha256:image-id> <new-report.json>')
  const result=await testReceptionistImage({candidate:resolve(candidate),imageId,reportPath:resolve(reportPath)})
  console.log(`PASS ${result.trade} image ${result.imageId}: isolated HTTP contracts and confirmed cleanup`)
}
