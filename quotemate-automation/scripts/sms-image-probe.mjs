import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash,createHmac} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {verifyBuildAttestation} from './receptionist-build.mjs'
import {receptionistSourceHash} from './receptionist-release-fingerprint.mjs'
import {readSmokeResponse} from './sms-smoke-process.mjs'

const [mode,expectedManifestHash,trade]=process.argv.slice(2)
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const manifestBytes=readFileSync('/app/release-manifest.json'),manifest=JSON.parse(manifestBytes)
assert.equal(sha(manifestBytes),expectedManifestHash,'Image contains a different source manifest')
assert.equal(manifest.trade,trade);assert.equal(receptionistSourceHash(manifest),manifest.sourceHash)
const inventory=()=>{
  const proof=verifyBuildAttestation('/app',manifest)
  const metadata={manifest:sha(manifestBytes),attestation:sha(readFileSync('/app/build-attestation.json')),
    package:sha(readFileSync('/app/package.json'))}
  assert.equal(metadata.package,manifest.buildInputHashes['package.json'])
  if(trade==='front-desk') {
    metadata.schema=sha(readFileSync('/app/release-schema.json'))
    assert.equal(metadata.schema,manifest.buildInputHashes['release-schema.json'])
  }
  return {sourceHash:proof.sourceHash,metadata,compiledHashes:proof.compiledHashes}
}
if(mode==='inventory') console.log(JSON.stringify(inventory()))
else if(mode==='http') {
  const before=inventory(),base='http://127.0.0.1:8080'
  const deadline=Date.now()+45_000
  let live=null
  while(Date.now()<deadline) {
    try {live=await readSmokeResponse(base+'/api/health');if(live.status===200)break}catch{/* bounded startup retry */}
    await delay(100)
  }
  assert.equal(live?.status,200,'Image liveness did not become ready within 45 seconds')
  const body=JSON.parse(live.body);assert.equal(trade==='front-desk'?body.role:body.trade,trade)
  assert.equal((await readSmokeResponse(base+'/api/health/ready')).status,403)
  const key=trade==='front-desk'?'x-front-desk-key':'x-sim-key'
  const readiness=await readSmokeResponse(base+'/api/health/ready',{headers:{[key]:trade==='front-desk'?'offline-front-key':'offline-sim-key'}},5000)
  assert.equal(readiness.status,503);assert.equal(JSON.parse(readiness.body).ok,false)
  const firstSid='SM00000000000000000000000000000001',secondSid='SM00000000000000000000000000000002'
  const unsigned=trade==='front-desk'?'/api/sms/inbound':'/api/receptionist/simulate'
  assert.equal((await readSmokeResponse(base+unsigned,{method:'POST',headers:{'content-type':trade==='front-desk'?'application/x-www-form-urlencoded':'application/json'},body:trade==='front-desk'?'':JSON.stringify({from:'+61400000001',to:'+61400000002',body:'hello'})})).status,403)
  let firstReceipt=null
  for(const [attempt,sid] of [firstSid,firstSid,secondSid].entries()) {
    let response
    if(trade==='front-desk') {
      const params={From:'+61400000001',To:'+61400000002',Body:'',MessageSid:sid,NumMedia:'1',MediaUrl0:'https://api.twilio.com/photo.png',MediaContentType0:'image/png'}
      const signed='https://front.sms-image.invalid/api/sms/inbound'+Object.keys(params).sort().map(key=>key+params[key]).join('')
      const signature=createHmac('sha1','offline-auth-token').update(signed).digest('base64')
      response=await readSmokeResponse(base+'/api/sms/inbound',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':signature},body:new URLSearchParams(params).toString()},4000)
    } else {
      const payload={from:'+61400000001',to:'+61400000002',body:'',messageSid:sid,turnId:`00000000-0000-4000-8000-${sid===firstSid?'000000000001':'000000000002'}`,mediaUrls:['https://api.twilio.com/photo.png'],mediaContentTypes:['image/png']}
      response=await readSmokeResponse(base+'/api/receptionist/simulate',{method:'POST',headers:{'content-type':'application/json','x-sim-key':'offline-sim-key'},body:JSON.stringify(payload)},4000)
    }
    assert.ok(response.ok,`Durable ingress failed ${response.status}: ${response.body}`)
    const state=JSON.parse(readFileSync('/tmp/sms-image-fixture.json'))
    assert.equal(state.receipts.length,attempt===2?2:1,'Receipt must exist before ACK and distinguish provider identities')
    if(firstReceipt)assert.deepEqual(state.receipts[0],firstReceipt,'Replayed receipt changed its original identity or payload')
    else firstReceipt=state.receipts[0]
    assert.deepEqual(state.unexpected,[])
  }
  const state=JSON.parse(readFileSync('/tmp/sms-image-fixture.json'))
  assert.equal(state.receiptWrites,3);assert.equal(state.receipts.length,2);assert.deepEqual(state.unexpected,[])
  assert.notEqual(state.receipts[0].id,state.receipts[1].id)
  const after=inventory();assert.deepEqual(after,before,'Image artifact changed during runtime checks')
  console.log(JSON.stringify({pass:true,trade,checks:['live200','readiness_auth403','capability503','ingress_auth403','photo_receipt_before_ack','duplicate_receipt','distinct_provider_receipt'],state,artifact:after}))
} else throw new Error('Unknown image probe operation')
