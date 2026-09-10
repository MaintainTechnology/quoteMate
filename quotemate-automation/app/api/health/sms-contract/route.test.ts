import { beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ authorised: true, contract: true, operationSchemaError:null as null|string, rpcError: null as null | { code: string }, reads: [] as string[], rpc: vi.fn() }))
vi.mock('@/lib/agents/cron', () => ({ isCronAuthorised: () => h.authorised }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  from(table: string) { return { select(columns: string) {
    h.reads.push(`${table}:${columns}`)
    return { limit: async (limit: number) => {
      expect(limit).toBe(0)
      // The real solar schema uses confirmed_at; a nonexistent released_at
      // previously made readiness fail even with every migration applied.
      return { data:[],error: table === 'job_quote_operations' && h.operationSchemaError ? {code:h.operationSchemaError}
        : table === 'solar_estimates' && columns.includes('released_at') ? { code: '42703' } : null }
    } }
  } } },
  rpc: h.rpc,
}) }))
import { GET } from './route'
beforeEach(() => {
  h.authorised = true; h.contract = true; h.rpcError = null; h.reads.length = 0;h.operationSchemaError=null
  h.rpc.mockReset().mockImplementation(async (name:string) => name === 'sms_owned_quote_revision_contract'
    ? { data: h.contract, error: h.rpcError } : {data:true,error:null})
  vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://quotemax.com.au')
})
describe('SMS website schema readiness', () => {
  it('requires authentication before probing dependencies', async () => {
    h.authorised = false
    expect((await GET(new Request('https://local.test/api/health/sms-contract'))).status).toBe(401)
    expect(h.reads).toHaveLength(0); expect(h.rpc).not.toHaveBeenCalled()
  })
  it('uses the solar confirmation column and checks the read-only revision RPC', async () => {
    const response = await GET(new Request('https://local.test/api/health/sms-contract'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ready: true, requiredMigrations: [198,199,200,201,202,204,205,207,210,211,212,213,214,215,217,218,219,220,221] })
    expect(h.reads).toContain('solar_estimates:id,public_token,confirmed_at,source_request_key')
    expect(h.rpc.mock.calls.map(([name])=>name)).toEqual(['sms_owned_quote_revision_contract','sms_commercial_quote_guard_ready','sms_plan_quote_guard_ready','sms_quote_chain_ready'])
  })
  it.each([false, true])('fails readiness when revision contract is incomplete or missing (%s)', async (missing) => {
    h.contract = false
    h.rpcError = missing ? { code: 'PGRST202' } : null
    expect((await GET(new Request('https://local.test/api/health/sms-contract'))).status).toBe(503)
  })
  it.each([null,'42P01','42703'])('probes job operations without requiring rows and rejects absent table/column (%s)',async code=>{
    h.operationSchemaError=code
    const response=await GET(new Request('https://local.test/api/health/sms-contract'))
    expect(response.status).toBe(code ? 503 : 200)
    expect(h.reads).toContain('job_quote_operations:tenant_id,operation_id,request_hash,intake_id,quote_id,status,pinned,pin_requested,created_at,updated_at')
    expect(await response.json()).toMatchObject({ready:!code,checks:expect.arrayContaining([{table:'job_quote_operations',ok:!code,code}])})
  })
  for(const [name,rpc] of [['commercial_quote_guard','sms_commercial_quote_guard_ready'],['plan_quote_guard','sms_plan_quote_guard_ready'],['quote_chain','sms_quote_chain_ready']]) {
    it.each(['false','missing','denied','throw'])(`${name}: %s is unavailable despite valid empty table schemas`,async mode=>{
      h.rpc.mockImplementation(async (called:string)=>{
        if(called!==rpc)return {data:true,error:null}
        if(mode==='throw')throw new Error('offline unavailable')
        return {data:false,error:mode==='missing'?{code:'PGRST202'}:mode==='denied'?{code:'42501'}:null}
      })
      const result=await GET(new Request('https://local.test/api/health/sms-contract'))
      expect(result.status).toBe(503)
      const body=await result.json()
      expect(body.checks.filter((check:{ok:boolean})=>!check.ok)).toEqual([{
        table:name,ok:false,code:mode==='throw'?'dependency_unavailable':mode==='missing'?'PGRST202':mode==='denied'?'42501':null,
      }])
    })
  }
  it.each([null,1,'true',{ready:true}])('quote chain requires exact Boolean true, not %j',async value=>{
    h.rpc.mockImplementation(async (name:string)=>({data:name==='sms_quote_chain_ready'?value:true,error:null}))
    const response=await GET(new Request('https://local.test/api/health/sms-contract'))
    expect(response.status).toBe(503)
    expect((await response.json()).checks.filter((check:{ok:boolean})=>!check.ok)).toEqual([{table:'quote_chain',ok:false,code:null}])
  })
})
