import { beforeEach, expect, it, vi } from 'vitest'
const A='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',B='bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',ID='cccccccc-1111-4111-8111-cccccccccccc'
type Row=Record<string,unknown>
const h=vi.hoisted(()=>({tenantId:null as string|null,record:null as Row|null,promoted:null as Row|null,readError:'',calls:[] as {table:string;filters:[string,unknown][]}[],pricing:null as unknown}))
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({from:(table:string)=>{
 const call={table,filters:[] as [string,unknown][]};h.calls.push(call)
 const query={select:()=>query,eq:(key:string,value:unknown)=>{call.filters.push([key,value]);return query},maybeSingle:async()=>{
  if(h.readError===table)return {data:null,error:{message:'Read failed'}}
  const row=table==='roofing_measurements'?h.record:h.promoted
  return {data:row&&call.filters.every(([key,value])=>row[key]===value)?row:null,error:null}
 }};return query
}})}))
vi.mock('@/lib/tenant/from-request',()=>({resolveTenantRequest:async()=>h.tenantId?{tenant:{id:h.tenantId}}:null}))
vi.mock('@/lib/roofing/pricing-authority',()=>({loadTenantRoofingPricingContext:async()=>h.pricing,roofMeasurementTokensForRun:({runId}:{runId:string})=>({measure_token:'run-'+runId})}))
vi.mock('@/lib/roofing/solar-detect',()=>({detectSolarForJob:vi.fn()}))
import { GET } from './route'
import { roofMeasurementVersion } from '@/lib/roofing/measurement-version'
const get=(token=ID,query='?lookup=id')=>GET(new Request('https://example.test/api/roofing/measurement/'+token+query),{params:Promise.resolve({token})})
beforeEach(()=>{h.tenantId=A;h.record={id:ID,tenant_id:A,measure_token:'private-measure-token',public_token:'public-customer-token',quote:{structures:[]},included_indices:[1],customer_name:'Owner customer',customer_phone:'+61412345678',created_by:'private-auth-id',internal_metadata:{provider:'private'},released_at:null,paid_at:null};h.promoted=null;h.pricing={authority:{tenant_id:A,revision:'a'.repeat(64)}};h.readError='';h.calls=[]})
it('requires authenticated ownership even with a valid private token',async()=>{h.tenantId=null;expect((await get('private-measure-token','')).status).toBe(401);expect(h.calls).toHaveLength(0)})
it.each([['id',ID],['token','private-measure-token']])('reads the owned measurement by %s and returns the exact write revision',async(lookup,key)=>{
 const response=await get(key,'?lookup='+lookup);const body=await response.json();expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store')
 expect(body.measurement).toMatchObject({id:ID,tenant_id:A,measure_token:'private-measure-token',revision:roofMeasurementVersion(h.record as {quote:unknown;included_indices:unknown}),customer_name:'Owner customer'})
 expect(body.measurement).not.toHaveProperty('created_by');expect(body.measurement).not.toHaveProperty('internal_metadata')
 expect(h.calls[0].filters).toContainEqual(['tenant_id',A])
})
it('does not accept a public customer token as owner lookup',async()=>{expect((await get('public-customer-token','')).status).toBe(404)})
it('does not expose another tenant record',async()=>{h.tenantId=B;expect((await get()).status).toBe(404)})
it('retains historical stored results when current pricing is unavailable',async()=>{h.pricing=null;expect(await(await get()).json()).toMatchObject({measurement:{quote:{structures:[]},pricing_authority:null}})})
it('shows an uncommitted promotion as pending and never manufactures a quote id',async()=>{h.record!.quote_share_token='claimed';expect(await(await get()).json()).toMatchObject({measurement:{promoted_quote_id:null,promotion_pending:true}})})
it('returns a promoted quote id only from an actual owned matching record',async()=>{
 h.record!.quote_share_token='claimed';h.promoted={id:'persisted-quote',tenant_id:B,share_token:'claimed'};expect(await(await get()).json()).toMatchObject({measurement:{promoted_quote_id:null}})
 h.promoted.tenant_id=A;expect(await(await get()).json()).toMatchObject({measurement:{promoted_quote_id:'persisted-quote',promotion_pending:false}})
})
it.each(['roofing_measurements','quotes'])('reports a %s read failure as unavailable',async table=>{h.record!.quote_share_token='claimed';h.readError=table;expect((await get()).status).toBe(503)})
it.each([['bad','?lookup=id'],[ID,'?lookup=public']])('rejects invalid lookup %s',async(token,query)=>{expect((await get(token,query)).status).toBe(400);expect(h.calls).toHaveLength(0)})
it('recovers an owned persisted run without replaying measurement or save',async()=>{
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','test-key');const run='a'.repeat(32);h.record!.measure_token='run-'+run
 const response=await get(run,'?lookup=run');expect(response.status).toBe(200)
 expect((await response.json()).measurement.id).toBe(ID);expect(h.calls[0].filters).toContainEqual(['tenant_id',A]);vi.unstubAllEnvs()
})
it('does not recover a foreign run and rejects malformed run identities',async()=>{
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','test-key');const run='a'.repeat(32);h.record!.measure_token='run-'+run;h.tenantId=B
 expect((await get(run,'?lookup=run')).status).toBe(404);expect((await get('bad','?lookup=run')).status).toBe(400);vi.unstubAllEnvs()
})
