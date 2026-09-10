import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterAll,expect,it} from 'vitest'
import {testReceptionistImage} from '../scripts/test-receptionist-image.mjs'
import {receptionistSourceHash} from '../scripts/receptionist-release-fingerprint.mjs'
import {compiledOutputHashes} from '../scripts/receptionist-build.mjs'
const require=createRequire(import.meta.url)
const {createImageFixture}=require('../scripts/sms-image-offline-fixture.cjs')
const roots:string[]=[]
afterAll(()=>roots.forEach(root=>rmSync(root,{recursive:true,force:true})))
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const imageId='sha256:'+'a'.repeat(64)

function fixture(trade='electrical',failure='') {
  const candidate=mkdtempSync(join(tmpdir(),'qm-image-cli-test-'));roots.push(candidate)
  mkdirSync(join(candidate,'dist'));mkdirSync(join(candidate,'src/config'),{recursive:true})
  writeFileSync(join(candidate,'dist/main.js'),'// synthetic Docker CLI fixture, not a built image\n')
  writeFileSync(join(candidate,'src/config/required-env.ts'),'export const REQUIRED_ENV = ["ANTHROPIC_API_KEY"] as const\nexport const OPTIONAL=["GOOGLE_SOLAR_API_KEY"] as const')
  writeFileSync(join(candidate,'package.json'),'{}')
  const source={trade,generatedHashes:{'src/config/required-env.ts':'fixture'},buildInputHashes:{'package.json':sha('{}')},platformContractHashes:{'app/q/[token]/page.tsx':'fixture'}}
  const manifest={...source,sourceHash:receptionistSourceHash(source)}
  const bytes=JSON.stringify(manifest),compiledHashes=compiledOutputHashes(candidate)
  writeFileSync(join(candidate,'release-manifest.json'),bytes)
  writeFileSync(join(candidate,'build-attestation.json'),JSON.stringify({version:1,sourceHash:manifest.sourceHash,compiledHashes}))
  const reportPath=join(candidate,'image-report.json'),calls:{args:string[];timeout?:number}[]=[]
  let name='',mount='',removed=false
  const run=async(args:string[],timeout?:number)=>{
    calls.push({args,timeout})
    if(args[0]==='create') {
      name=args[args.indexOf('--name')+1];mount=args[args.indexOf('--mount')+1]
      const auditDir=mount.split(',src=')[1].split(',dst=')[0];roots.push(auditDir)
      if(process.platform!=='win32') {
        expect(statSync(auditDir).mode&0o777).toBe(0o755)
        expect(statSync(join(auditDir,'sms-image-offline-fixture.cjs')).mode&0o777).toBe(0o644)
      }
      expect(args[args.indexOf('--network')+1]).toBe('none');expect(args).toContain('--read-only')
      expect(args).not.toContain('-p');expect(args).not.toContain('--env-file')
      expect(args).toContain('ANTHROPIC_API_KEY=offline-test-value')
      expect(args.some(arg=>arg.startsWith('GOOGLE_SOLAR_API_KEY='))).toBe(false)
      if(failure==='uncertain create')throw new Error('lost Docker response')
      return 'b'.repeat(64)
    }
    if(args[0]==='inspect')return JSON.stringify([{Image:failure==='wrong image'?'sha256:'+'c'.repeat(64):imageId,
      Config:{Labels:{'quotemax.audit':name}},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,PortBindings:{}},
      Mounts:[{Type:'bind',Destination:'/audit',Source:mount.split(',src=')[1].split(',dst=')[0],RW:failure==='writable mount'}]}])
    if(args[0]==='start')return name
    if(args[0]==='exec') {
      expect(timeout).toBe(60_000)
      if(failure==='probe failure')throw new Error('container HTTP assertion failed')
      return JSON.stringify({pass:true,trade,artifact:{sourceHash:manifest.sourceHash,metadata:{manifest:failure==='wrong manifest'?'changed':sha(bytes)},compiledHashes},
        state:{unexpected:failure==='caught IO'?['forbidden model request']:[]}})
    }
    if(args[0]==='logs')return 'offline container log'
    if(args[0]==='rm') {removed=true;return name}
    if(args[0]==='ps')return failure==='cleanup incomplete'?name:''
    throw new Error('Unexpected Docker command '+args[0])
  }
  return {candidate,reportPath,run,calls,removed:()=>removed}
}
it.each(['electrical','plumbing','roofing','painting','solar','front-desk'])('%s image protocol pins identity, isolates transport and confirms cleanup',async trade=>{
  const f=fixture(trade)
  const result=await testReceptionistImage({...f,imageId})
  expect(result.pass).toBe(true);expect(f.removed()).toBe(true)
  expect(f.calls.at(-1)?.args[0]).toBe('ps')
  expect(result.helperHashes).toHaveProperty('sms-image-offline-fixture.cjs')
})
it.each(['wrong image','writable mount','probe failure','caught IO','wrong manifest','cleanup incomplete','uncertain create'])('fails closed and attempts only its labelled cleanup after %s',async failure=>{
  const f=fixture('electrical',failure)
  await expect(testReceptionistImage({...f,imageId})).rejects.toThrow()
  expect(JSON.parse(readFileSync(f.reportPath,'utf8')).pass).toBe(false)
  expect(f.removed()).toBe(true)
  expect(f.calls.filter(call=>call.args[0]==='rm')).toHaveLength(1)
})
it('rejects mutable image tags before any Docker command',async()=>{
  const f=fixture()
  await expect(testReceptionistImage({...f,imageId:'latest'})).rejects.toThrow('immutable ID')
  expect(f.calls).toHaveLength(0)
})
it('the image provider fixture records unexpected operations even if application code catches them',async()=>{
  const snapshots:unknown[]=[]
  const f=createImageFixture({role:'solar',persist:(state:unknown)=>snapshots.push(structuredClone(state))})
  await expect(f.fetch('https://provider.invalid/messages')).rejects.toThrow('Unexpected provider origin')
  expect(f.state.unexpected).toHaveLength(1);expect(snapshots.length).toBeGreaterThan(1)
})
it('the actual receipt fixture reuses trade and frontdesk identities with PNG metadata',async()=>{
  for(const role of ['solar','front-desk']) {
    const f=createImageFixture({role}),front=role==='front-desk'
    const url='https://sms-image.invalid/rest/v1/'+(front?'sms_frontdesk_jobs?on_conflict=receipt_key':'rpc/enqueue_sms_work')
    let first:unknown
    for(const [i,last] of ['1','1','2'].entries()) {
      const sid='SM0000000000000000000000000000000'+last,id=`00000000-0000-4000-8000-00000000000${i+1}`
      const payload=front?{id,receipt_key:`twilio:${sid}`,from_number:'+61400000001',to_number:'+61400000002',
        payload:{from:'+61400000001',to:'+61400000002',body:'',messageSid:sid,turnId:id,mediaContentTypes:['image/png'],mediaUrls:['https://api.twilio.com/photo.png']}}
        :tradePayload(sid)
      await f.fetch(url,{method:'POST',headers:{apikey:'offline-service-key',prefer:'resolution=ignore-duplicates'},body:JSON.stringify(payload)})
      if(first)expect(f.state.receipts[0]).toEqual(first)
      else first=structuredClone(f.state.receipts[0])
    }
    expect(f.state.receiptWrites).toBe(3);expect(f.state.receipts).toHaveLength(2);expect(f.state.unexpected).toEqual([])
    expect(f.state.receipts[0].id).not.toBe(f.state.receipts[1].id)
  }
})
function tradePayload(sid='SM00000000000000000000000000000001') {
  const turn='00000000-0000-4000-8000-000000000001'
  return {p_key:`inbound:+61400000002:${sid}`,p_turn_id:turn,p_service:'solar',p_kind:'inbound',p_serial_key:'sms:+61400000002:+61400000001',
    p_payload:{url:'http://127.0.0.1:8080/api/sms/inbound',headers:{'content-type':'application/x-www-form-urlencoded','x-quotemax-simulated':'1','x-quotemax-turn-id':turn},
      body:new URLSearchParams({From:'+61400000001',To:'+61400000002',Body:'',MessageSid:sid,NumMedia:'1',MediaUrl0:'https://api.twilio.com/photo.png',MediaContentType0:'image/png'}).toString()}}
}
it.each(['constant receipt key','dropped PNG type'])('image fixture rejects a trade ingress regression: %s',async kind=>{
  const f=createImageFixture({role:'solar'}),payload=tradePayload()
  if(kind==='constant receipt key')payload.p_key='all-customers-one-job'
  else {const form=new URLSearchParams(payload.p_payload.body);form.delete('MediaContentType0');payload.p_payload.body=form.toString()}
  await expect(f.fetch('https://sms-image.invalid/rest/v1/rpc/enqueue_sms_work',{method:'POST',headers:{apikey:'offline-service-key'},body:JSON.stringify(payload)})).rejects.toThrow()
  expect(f.state.unexpected).toHaveLength(1);expect(f.state.receipts).toHaveLength(0)
})
