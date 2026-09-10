import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
type Row=Record<string,unknown>
const A='11111111-2222-4333-8444-555555555555',B='11111111-2222-4333-8444-666666666666'
const PN='PN'+'a'.repeat(32),PHONE='+61482012345'
const h=vi.hoisted(()=>({client:null as unknown,tenant:null as Row|null,failRead:'',failWrite:'',loseClaim:false,loseFinish:false,
  sms:vi.fn(),twilio:vi.fn(),vapi:vi.fn(),register:vi.fn(),welcome:vi.fn()}))
vi.mock('next/server',()=>({after:()=>{}}))
vi.mock('@/lib/twilio/set-sms-webhook',()=>({setTwilioSmsWebhook:h.sms}))
vi.mock('@/lib/twilio/provision',()=>({provisionTwilioNumber:h.twilio,smsWebhookUrl:()=> 'https://frontdesk.example.test/sms'}))
vi.mock('@/lib/vapi/provision',()=>({provisionVapiAssistant:h.vapi}))
vi.mock('@/lib/vapi/register-number',()=>({registerNumberWithVapi:h.register}))
vi.mock('@/lib/twilio/welcome-sms',()=>({sendWelcomeSms:h.welcome}))
vi.mock('@supabase/supabase-js',()=>({createClient:()=>new Proxy({},{get:(_,key)=>(h.client as Row)[key as string]})}))
vi.mock('@/lib/tenant/from-request',()=>({resolveTenantRequest:async()=>h.tenant===null?null:{tenant:h.tenant}}))
import { runProvisioning } from './run-provisioning'
import { readProvisioningStatus, type ProvisioningTenant } from './provisioning-status'
import { GET } from '../../app/api/onboard/provisioning-status/route'
import { POST } from '../../app/api/onboard/retry-provision/route'
let pg:PGlite
const input={tenantId:A,businessName:'Test business',trade:'electrical',trades:['electrical','plumbing'],ownerFirstName:'Owner',ownerMobile:'+61412345678'}
const db=()=>h.client as SupabaseClient
const status=async()=>readProvisioningStatus(db(),await tenant() as ProvisioningTenant)
const run=()=>runProvisioning(db(),input)
async function tenant(id=A){ return (await pg.query<{row:Row}>('select to_jsonb(t) row from tenants t where id=$1',[id])).rows[0]?.row }
async function receipt(){return (await pg.query<{row:Row}>('select to_jsonb(t) row from tenant_provisioning_attempts t where tenant_id=$1',[A])).rows[0]?.row}
beforeAll(async()=>{
 pg=new PGlite()
 await pg.exec(`create role anon;create role authenticated;create role service_role;
 create table tenants(id uuid primary key,status text,twilio_sms_number text,twilio_voice_number text,twilio_number_sid text,vapi_assistant_id text,activated_at timestamptz);`)
 await pg.exec(readFileSync('sql/migrations/216_tenant_provisioning_attempts.sql','utf8'))
 h.client={
  rpc:async(name:string,args:Row)=>{
   try{const r=await pg.query<{row:Row}>(`select ${name}($1) row`,[args.p_tenant_id]);return h.loseClaim?{error:{message:'Lost ACK'},data:null}:{error:null,data:r.rows[0].row}}
   catch(error){return {error,data:null}}
  },
  from:(table:string)=>{
   const filters:string[]=[],values:unknown[]=[];let patch:Row|null=null,projection='*'
   const execute=async()=>{
    if((patch?h.failWrite:h.failRead)===table)return {data:null,error:{message:'Unavailable'}}
    try{
     const params=[...values],where=filters.length?' where '+filters.join(' and '):''
     let sql='select '+projection+' from '+table+where
     if(patch){const sets=Object.entries(patch).map(([key,value])=>{params.push(value);return key+'=$'+params.length});sql='update '+table+' set '+sets.join(',')+where+' returning '+projection}
     const r=await pg.query<{row:Row}>(patch?'with changed as ('+sql+') select to_jsonb(t) row from changed t':'select to_jsonb(t) row from ('+sql+') t',params)
     if(patch&&table==='tenant_provisioning_attempts'&&h.loseFinish)return {error:{message:'Lost ACK'},data:null}
     return {data:r.rows[0]?.row??null,error:null}
    }catch(error){return {data:null,error}}
   }
   const q={select:(s:string)=>{projection=s;return q},update:(p:Row)=>{patch=p;return q},eq:(key:string,value:unknown)=>{values.push(value);filters.push(key+'=$'+values.length);return q},single:execute,maybeSingle:execute,then:(resolve:(v:unknown)=>unknown,reject:(e:unknown)=>unknown)=>execute().then(resolve,reject)}
   return q
  },
 }
},30_000)
afterAll(async()=>{await pg?.close();vi.unstubAllEnvs()})
beforeEach(async()=>{
 vi.clearAllMocks();h.failRead='';h.failWrite='';h.loseClaim=false;h.loseFinish=false
 for(const [key,value] of Object.entries({NEXT_PUBLIC_SUPABASE_URL:'https://db.example.test',SUPABASE_SERVICE_ROLE_KEY:'test',TWILIO_PROVISIONING_ENABLED:'true',VAPI_PROVISIONING_ENABLED:'true',TWILIO_ACCOUNT_SID:'AC_test',TWILIO_AUTH_TOKEN:'test',TWILIO_ADDRESS_SID:'AD_test',APP_URL:'https://example.test',VAPI_API_KEY:'test'}))vi.stubEnv(key,value)
 await pg.exec('truncate tenant_provisioning_attempts,tenants cascade');await pg.query("insert into tenants(id,status) values($1,'onboarding'),($2,'onboarding')",[A,B])
 h.tenant=await tenant()
 h.twilio.mockResolvedValue({ok:true,stubbed:false,phoneNumber:PHONE,twilioSid:PN,capabilities:{sms:true,voice:true}})
 h.vapi.mockResolvedValue({ok:true,stubbed:false,assistantId:'real-assistant'})
 h.register.mockResolvedValue({ok:true,stubbed:false,vapiPhoneNumberId:'real-number-binding'})
 h.sms.mockResolvedValue({ok:true,stubbed:false,twilioSid:PN})
 h.welcome.mockResolvedValue({ok:true,stubbed:false,sid:'SM_test'})
})
describe('durable provisioning real SQL216 and action boundaries',()=>{
 it('persists proof before reporting ready; a real PN proves a number even in the stub digit range',async()=>{
  expect(await run()).toMatchObject({ok:true,phoneReadiness:{state:'ready',setupComplete:true,smsReady:true,voiceReady:true}})
  expect(await receipt()).toMatchObject({state:'completed',result:{twilioNumberSid:PN}})
  expect(h.vapi).toHaveBeenCalledWith(expect.objectContaining({trades:['electrical','plumbing']}))
 })
 it('replays completed setup without buying, registering, changing webhooks or welcoming again',async()=>{
  await run();expect((await run()).phoneReadiness?.state).toBe('ready')
  for(const mock of [h.twilio,h.vapi,h.register,h.sms,h.welcome])expect(mock).toHaveBeenCalledTimes(1)
 })
 it('serializes two concurrent attempts before provider dispatch',async()=>{
  await Promise.all([run(),run()]);expect(h.twilio).toHaveBeenCalledTimes(1);expect(h.vapi).toHaveBeenCalledTimes(1);expect((await status()).state).toBe('ready')
 })
 it('does not dispatch when the claim ACK is lost, and never reclaims that processing receipt',async()=>{
  h.loseClaim=true;await run();h.loseClaim=false;await run();expect(h.twilio).not.toHaveBeenCalled();expect((await status()).state).toBe('processing')
 })
 it('recovers completed DB success after a lost final ACK through owned GET without re-dispatch',async()=>{
  h.loseFinish=true;expect((await run()).ok).toBe(false);h.loseFinish=false;h.tenant=await tenant()
  const response=await GET(new Request('https://example.test/status'));expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(await response.json()).toMatchObject({ok:true,tenantId:A,phoneReadiness:{state:'ready'}});await run();expect(h.twilio).toHaveBeenCalledTimes(1)
 })
 it.each(['twilio','vapi'])('fences a false %s result after dispatch, including partial persisted artifacts',async provider=>{
  h[provider as 'twilio'|'vapi'].mockResolvedValue({ok:false,reason:'Network outcome uncertain'});await run();await run()
  expect((await status()).state).toBe('unknown');expect(h.twilio).toHaveBeenCalledTimes(1);expect(h.welcome).not.toHaveBeenCalled()
 })
 it('fences a thrown provider response',async()=>{h.twilio.mockRejectedValue(new Error('Lost'));await run();await run();expect(h.twilio).toHaveBeenCalledTimes(1);expect((await status()).state).toBe('unknown')})
 it('does not retry after tenant persistence fails',async()=>{h.failWrite='tenants';await run();h.failWrite='';await run();expect(h.twilio).toHaveBeenCalledTimes(1);expect((await status()).state).toBe('unknown')})
 it.each(['sms','register'])('does not claim full readiness after %s routing failure',async provider=>{
  h[provider as 'sms'|'register'].mockResolvedValue({ok:false,reason:'Routing rejected'});await run();expect((await status()).state).toBe('incomplete');expect(h.welcome).not.toHaveBeenCalled()
 })
 it('rejects a webhook update acknowledging a different phone SID',async()=>{h.sms.mockResolvedValue({ok:true,stubbed:false,twilioSid:'PN'+'b'.repeat(32)});await run();expect((await status()).setupComplete).toBe(false)})
 it.each([{sms:false,voice:false},{sms:'false',voice:'false'}])('does not complete setup with missing or malformed capabilities %j',async capabilities=>{
  h.twilio.mockResolvedValue({ok:true,stubbed:false,phoneNumber:PHONE,twilioSid:PN,capabilities});await run();expect((await status()).setupComplete).toBe(false)
 })
 it('shows stub mode honestly and sends no welcome SMS',async()=>{
  vi.stubEnv('TWILIO_PROVISIONING_ENABLED','false');vi.stubEnv('VAPI_PROVISIONING_ENABLED','false')
  h.twilio.mockResolvedValue({ok:true,stubbed:true,phoneNumber:PHONE});h.vapi.mockResolvedValue({ok:true,stubbed:true,assistantId:'vapi-stub-A'});h.register.mockResolvedValue({ok:true,stubbed:true})
  await run();expect((await status()).state).toBe('stub');expect(h.sms).not.toHaveBeenCalled();expect(h.welcome).not.toHaveBeenCalled()
 })
 it.each(['twilio_sms_number','twilio_voice_number','twilio_number_sid','vapi_assistant_id'])('never repurchases historical %s without a receipt',async field=>{
  await pg.query('update tenants set '+field+'=$1 where id=$2',[field==='vapi_assistant_id'?'vapi-stub-A':field==='twilio_number_sid'?PN:PHONE,A]);await run()
  expect((await status()).state).toBe('unknown');expect(h.twilio).not.toHaveBeenCalled();expect(await receipt()).toBeUndefined()
 })
 it('allows a configuration-only preflight failure to be retried without a previous provider attempt',async()=>{
  vi.stubEnv('VAPI_API_KEY','');expect((await run()).phoneReadiness?.retryable).toBe(true);expect(await receipt()).toBeUndefined();expect(h.twilio).not.toHaveBeenCalled()
  vi.stubEnv('VAPI_API_KEY','test');expect((await run()).phoneReadiness?.state).toBe('ready')
 })
 it('fails closed on receipt read outages before provider work',async()=>{h.failRead='tenant_provisioning_attempts';expect((await run()).ok).toBe(false);expect(h.twilio).not.toHaveBeenCalled();expect((await GET(new Request('https://example.test'))).status).toBe(503)})
 it('invalidates readiness after the saved account artifacts change',async()=>{await run();await pg.query('update tenants set vapi_assistant_id=$1 where id=$2',['other-assistant',A]);expect((await status()).state).toBe('unknown')})
 it('does not share the other tenant operation through owned GET or retry',async()=>{
  await run();h.tenant=await tenant(B);expect(await(await GET(new Request('https://example.test?tenantId='+A))).json()).toMatchObject({tenantId:B,phoneReadiness:{state:'not_started',operationId:null}})
  h.tenant=null;expect((await POST(new Request('https://example.test',{method:'POST'}))).status).toBe(401)
 })
 it('retry POST reads an unknown attempt without another provider call',async()=>{h.twilio.mockRejectedValue(new Error('Lost'));await run();h.tenant=await tenant();expect(await(await POST(new Request('https://example.test',{method:'POST'}))).json()).toMatchObject({ok:false,setupComplete:false,phoneReadiness:{state:'unknown'}});expect(h.twilio).toHaveBeenCalledTimes(1)})
 it('protects receipt identity and prevents automatic state reset',async()=>{
  await run();await expect(pg.query("update tenant_provisioning_attempts set state='processing' where tenant_id=$1",[A])).rejects.toThrow('cannot be reclaimed')
  for(const role of ['anon','authenticated','service_role'])expect((await pg.query<{allowed:boolean}>("select has_function_privilege($1,'claim_tenant_provisioning(uuid)','execute') allowed",[role])).rows[0].allowed).toBe(role==='service_role')
 })
})
