// Read-only F23 inventory. No provider or database writes and no SMS sends.
// node --env-file=.env.local scripts/audit-sms-webhooks.mjs --output <report.json>
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import twilio from 'twilio'
import { createClient } from '@supabase/supabase-js'
const expected = process.env.SMS_FRONTDESK_WEBHOOK_URL ?? 'https://qm-front-desk-production.up.railway.app/api/sms/inbound'
const sid = process.env.TWILIO_ACCOUNT_SID
const secret = process.env.TWILIO_AUTH_TOKEN
const outputIndex = process.argv.indexOf('--output')
const destination = outputIndex >= 0 ? process.argv[outputIndex + 1] : null
const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0,12)
const safeUrl = value => { try { const url = new URL(value); return url.origin + url.pathname } catch { return value ? 'invalid' : null } }
const report = { checkedAt:new Date().toISOString(), mode:'read-only', expectedWebhook:safeUrl(expected), accountFingerprint:sid ? hash(sid) : null, complete:false, numbers:[], problems:[] }
if (!sid || !secret) report.problems.push('Twilio inventory credentials unavailable')
else {
  let next = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?PageSize=1000`
  try {
    for (let page=0; next && page<20; page++) {
      const url = new URL(next, 'https://api.twilio.com')
      if (url.origin !== 'https://api.twilio.com') throw new Error('Unexpected pagination origin')
      const response = await fetch(url, { method:'GET', headers:{ Authorization:`Basic ${Buffer.from(`${sid}:${secret}`).toString('base64')}` }, signal:AbortSignal.timeout(12000), redirect:'error' })
      if (!response.ok) throw new Error(`Twilio inventory HTTP ${response.status}`)
      const body = await response.json()
      if (!Array.isArray(body.incoming_phone_numbers)) throw new Error('Unexpected inventory response')
      for (const row of body.incoming_phone_numbers) {
        const smsEnabled = row.capabilities?.sms === true
        const primary = safeUrl(row.sms_url); const fallback = safeUrl(row.sms_fallback_url)
        const retired = [primary,fallback].some(url=>url && /https:\/\/(?:www\.)?quotemax\.com\.au\/api\/sms\/inbound\/?$/.test(url))
        report.numbers.push({numberFingerprint:hash(row.phone_number),numberMasked:`…${String(row.phone_number).slice(-4)}`,providerIdFingerprint:hash(row.sid),smsEnabled,
          primary,primaryMethod:row.sms_method,fallback,fallbackMethod:row.sms_fallback_method,
          applicationConfigured:!!row.sms_application_sid,
          routeMatchesExpected:primary===safeUrl(expected),retiredRoute:retired})
        if (smsEnabled && (primary!==safeUrl(expected) || retired)) report.problems.push(`SMS number …${String(row.phone_number).slice(-4)} (${hash(row.phone_number)}) needs route verification`)
      }
      next=body.next_page_uri
    }
    report.complete=!next
    if (next) report.problems.push('Inventory page limit reached')
    const client=twilio(sid,secret,{timeout:12000,autoRetry:false})
    const services=await client.messaging.v1.services.list({limit:100})
    report.messagingServices=[]
    for(const service of services) {
      const numbers=await client.messaging.v1.services(service.sid).phoneNumbers.list({limit:1000})
      report.messagingServices.push({fingerprint:hash(service.sid),useNumberWebhook:service.useInboundWebhookOnNumber,
        inbound:safeUrl(service.inboundRequestUrl),fallback:safeUrl(service.fallbackUrl),numberCount:numbers.length})
      for(const attached of numbers) {
        const number=report.numbers.find(row=>row.providerIdFingerprint===hash(attached.sid))
        if(number) number.serviceOverride=service.useInboundWebhookOnNumber ? null : safeUrl(service.inboundRequestUrl) || 'unset'
      }
      if(numbers.length===1000) report.problems.push('Messaging Service number inventory may be truncated')
    }
    if(services.length===100) report.problems.push('Messaging Service inventory may be truncated')
    if(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(12000)})}})
      const tenants=await db.from('tenants').select('id,twilio_sms_number,status,trade').not('twilio_sms_number','is',null).limit(1000)
      if(tenants.error) report.problems.push(`Tenant-number association unavailable (${tenants.error.code ?? 'read error'})`)
      else for(const number of report.numbers) {
        number.tenantAssignments=tenants.data.filter(tenant=>hash(tenant.twilio_sms_number)===number.numberFingerprint)
          .map(tenant=>({tenantFingerprint:hash(tenant.id),status:tenant.status,trade:tenant.trade}))
      }
    }
    report.problems.push('Inventory covers purchased numbers, application association and Messaging Service overrides; deployed routing and synthetic delivery remain separate checks.')
  } catch(error) { report.problems.push(error instanceof Error ? error.message : 'Inventory unavailable') }
}
if (destination) await writeFile(destination,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({complete:report.complete,numbers:report.numbers.length,smsEnabled:report.numbers.filter(n=>n.smsEnabled).length,retiredRoutes:report.numbers.filter(n=>n.retiredRoute).length,routeMismatches:report.numbers.filter(n=>n.smsEnabled&&!n.routeMatchesExpected).length,problems:report.problems,report:destination},null,2))
if (!report.complete) process.exitCode=2
