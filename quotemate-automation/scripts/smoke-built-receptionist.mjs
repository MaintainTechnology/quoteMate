#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { observeSmokeChild, readSmokeResponse, waitForSmokeLiveness, stopSmokeChild } from './sms-smoke-process.mjs'

const directory = resolve(process.argv[2])
const port = Number(process.argv[3] ?? 3199)
const manifest = JSON.parse(readFileSync(join(directory,'release-manifest.json'),'utf8'))
const source = readFileSync(join(directory,'src/config/required-env.ts'),'utf8')
const env = { ...process.env, NODE_ENV:'production', PORT:String(port), APP_URL:'https://quotemax.com.au',
  PUBLIC_WEB_ORIGIN:'https://quotemax.com.au', NEXT_PUBLIC_APP_URL:'https://quotemax.com.au',
  ENGINE_BASE_URL:`http://127.0.0.1:${port}`, NEXT_PUBLIC_SUPABASE_URL:'https://sms-audit.invalid',
  SUPABASE_SERVICE_ROLE_KEY:'offline-service-key', TWILIO_AUTH_TOKEN:'offline-auth-token',
  TWILIO_ACCOUNT_SID:'AC00000000000000000000000000000000', TWILIO_FROM_NUMBER:'+61400000002',
  SIM_API_KEY:'offline-sim-key', SMS_SIMULATE_ENABLED:'1', CRON_SECRET:'offline-cron-secret',
  ANTHROPIC_API_KEY:'offline-anthropic', STRIPE_SECRET_KEY:'sk_test_offline',
}
for (const key of source.match(/'([A-Z][A-Z0-9_]+)'/g) ?? []) {
  const name=key.slice(1,-1)
  if (!env[name]) env[name]='offline-test-value'
}
// Clear optional real credentials from the spawned process. Known provider
// variables receive nonworking fixture values; all remote fetches are blocked.
for (const name of Object.keys(env)) if (/KEY|SECRET|TOKEN|PASSWORD/.test(name)) env[name]='offline-test-value'
env.SIM_API_KEY='offline-sim-key'; env.TWILIO_AUTH_TOKEN='offline-auth-token';env.CRON_SECRET='offline-cron-secret'
env.SMS_READINESS_TENANT_ID=''
const child = spawn(process.execPath,['--require',join(dirname(fileURLToPath(import.meta.url)),'sms-offline-provider.cjs'),'dist/main.js'],
  { cwd:directory,env,stdio:['ignore','pipe','pipe'],windowsHide:true })
const monitor=observeSmokeChild(child)
const base=`http://127.0.0.1:${port}`
try {
  const live=await waitForSmokeLiveness(monitor,base+'/api/health')
  assert.equal(live.status,200)
  assert.equal(JSON.parse(live.body).trade,manifest.trade)
  const unauthorized=await readSmokeResponse(base+'/api/health/ready')
  assert.equal(unauthorized.status,403)
  const readiness=await readSmokeResponse(base+'/api/health/ready',{headers:{'x-sim-key':'offline-sim-key'}})
  assert.equal(readiness.status,503)
  assert.equal(JSON.parse(readiness.body).ok,false)
  const turnId='00000000-0000-4000-8000-000000000001'
  const request={from:'+61400000001',to:'+61400000002',body:'',messageSid:'SM00000000000000000000000000000001',turnId,
    mediaUrls:['https://api.twilio.com/photo.png'],mediaContentTypes:['image/png']}
  for(let i=0;i<2;i++) {
    const started=Date.now()
    const response=await readSmokeResponse(base+'/api/receptionist/simulate',{method:'POST',headers:{'Content-Type':'application/json','x-sim-key':'offline-sim-key'},body:JSON.stringify(request)},4000)
    assert.ok(response.ok,'Simulated durable ACK failed '+response.status+': '+response.body)
    assert.ok(Date.now()-started<4000,'ACK exceeded short request SLA')
  }
} finally { await stopSmokeChild(monitor) }
console.log('PASS '+manifest.trade+' built HTTP: liveness, authenticated failed-readiness, signed photo-only ingress and duplicate durable ACK; no provider IO; child exit confirmed')
