/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preload executes as CommonJS. */
// Test-only image preload. Network isolation is also enforced by Docker.
const assert = require('node:assert/strict')
const {writeFileSync} = require('node:fs')

function createImageFixture({role,persist=()=>{}}) {
  const state={version:1,role,unexpected:[],receiptWrites:0,receipts:[],claims:0}
  const receipts=new Map()
  const save=()=>{state.receipts=[...receipts.values()];persist(state)}
  const fail=error=>{state.unexpected.push(String(error));save();throw error}
  const response=(body,status=200)=>Response.json(body,{status})
  const fetch=async(input,options)=>{
    try {
      const req=new Request(input,options),url=new URL(req.url)
      if (/^(electrical|plumbing|roofing|painting|solar)\.sms-image\.invalid$/.test(url.hostname)) {
        assert.equal(role,'front-desk');assert.equal(req.method,'GET');assert.equal(url.pathname,'/api/health/ready')
        assert.equal(req.headers.get('x-sim-key'),'offline-sim-key')
        return response({ok:false},503)
      }
      assert.equal(url.origin,'https://sms-image.invalid','Unexpected provider origin')
      assert.equal(req.headers.get('apikey'),'offline-service-key')
      const path=url.pathname
      if (path==='/rest/v1/rpc/enqueue_sms_work') {
        assert.notEqual(role,'front-desk');assert.equal(req.method,'POST')
        const payload=await req.json();assert.equal(payload.p_service,role)
        assert.equal(payload.p_kind,'inbound');assert.equal(typeof payload.p_key,'string')
        const envelope=payload.p_payload,form=Object.fromEntries(new URLSearchParams(envelope.body))
        assert.ok(['SM00000000000000000000000000000001','SM00000000000000000000000000000002'].includes(form.MessageSid))
        assert.deepEqual(form,{From:'+61400000001',To:'+61400000002',Body:'',MessageSid:form.MessageSid,NumMedia:'1',MediaUrl0:'https://api.twilio.com/photo.png',MediaContentType0:'image/png'})
        assert.equal(payload.p_key,`inbound:+61400000002:${form.MessageSid}`)
        assert.equal(payload.p_serial_key,'sms:+61400000002:+61400000001')
        assert.equal(envelope.url,'http://127.0.0.1:8080/api/sms/inbound')
        assert.equal(envelope.headers['content-type'],'application/x-www-form-urlencoded')
        assert.equal(envelope.headers['x-quotemax-simulated'],'1')
        assert.equal(envelope.headers['x-quotemax-turn-id'],payload.p_turn_id)
        state.receiptWrites++
        if (!receipts.has(payload.p_key)) receipts.set(payload.p_key,{id:`00000000-0000-4000-8000-${String(receipts.size+2).padStart(12,'0')}`,
          turn_id:payload.p_turn_id,status:'pending',kind:payload.p_kind,service_key:role,key:payload.p_key,payload:envelope})
        save();return response(receipts.get(payload.p_key))
      }
      if (path==='/rest/v1/rpc/claim_sms_work'||path==='/rest/v1/rpc/claim_sms_frontdesk_job') {
        assert.equal(req.method,'POST');assert.equal(path.endsWith('frontdesk_job'),role==='front-desk')
        state.claims++;save();return response([])
      }
      if (path==='/rest/v1/sms_outbox'&&req.method==='GET') {assert.notEqual(role,'front-desk');return response([])}
      if (path==='/rest/v1/sms_frontdesk_jobs'&&req.method==='POST') {
        assert.equal(role,'front-desk');assert.equal(url.searchParams.get('on_conflict'),'receipt_key')
        assert.match(req.headers.get('prefer'),/resolution=ignore-duplicates/)
        const payload=await req.json(),sid=payload.payload.messageSid
        assert.ok(['SM00000000000000000000000000000001','SM00000000000000000000000000000002'].includes(sid))
        assert.equal(payload.receipt_key,`twilio:${sid}`)
        assert.match(payload.id,/^[a-f0-9-]{36}$/)
        assert.equal(payload.from_number,'+61400000001');assert.equal(payload.to_number,'+61400000002')
        assert.deepEqual(payload.payload,{from:'+61400000001',to:'+61400000002',body:'',messageSid:sid,
          mediaContentTypes:['image/png'],mediaUrls:['https://api.twilio.com/photo.png'],turnId:payload.id})
        state.receiptWrites++
        if (!receipts.has(payload.receipt_key)) receipts.set(payload.receipt_key,payload)
        save();return response(null,201)
      }
      if (path==='/rest/v1/sms_frontdesk_jobs'&&req.method==='GET'&&url.searchParams.has('receipt_key')) {
        assert.equal(role,'front-desk');assert.equal(url.searchParams.get('select'),'id')
        const row=receipts.get(url.searchParams.get('receipt_key').replace(/^eq\./,''))
        assert.ok(row);return response({id:row.id})
      }
      const schemas=['sms_work_jobs','sms_outbox','sms_frontdesk_jobs','job_quote_operations','quotes','roofing_measurements',
        'painting_measurements','solar_estimates','plan_extractions','aircon_recommendations','paint_runs']
      if (req.method==='GET'&&url.searchParams.get('limit')==='0'&&schemas.includes(path.split('/').at(-1))) {
        assert.match(path,/^\/rest\/v1\/\w+$/);return response({code:'OFFLINE',message:'Offline schema unavailable'},400)
      }
      if (['/rest/v1/rpc/sms_commercial_quote_guard_ready','/rest/v1/rpc/sms_plan_quote_guard_ready','/rest/v1/rpc/sms_quote_chain_ready'].includes(path)) {
        assert.equal(req.method,'POST');return response(false)
      }
      throw new Error(`Unexpected fixture request ${req.method} ${path}`)
    } catch(error) {return fail(error)}
  }
  save();return {fetch,state,fail}
}
module.exports={createImageFixture}

if (process.env.SMS_IMAGE_AUDIT_ACTIVE==='1') {
  const fixture=createImageFixture({role:process.env.SMS_IMAGE_AUDIT_TRADE,
    persist:state=>writeFileSync('/tmp/sms-image-fixture.json',JSON.stringify(state))})
  globalThis.fetch=fixture.fetch
  // Native provider clients cannot escape the fetch fixture silently. Listening
  // sockets are unaffected; the probe runs separately on container loopback.
  const deny=()=>fixture.fail(new Error('Unexpected native network operation'))
  for(const api of [require('node:http'),require('node:https')]) {
    api.request=deny;api.get=deny
  }
  const net=require('node:net');net.connect=deny;net.createConnection=deny
  require('node:tls').connect=deny
}
