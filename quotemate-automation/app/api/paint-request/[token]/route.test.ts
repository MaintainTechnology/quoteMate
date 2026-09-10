import { describe, it, expect, vi, beforeEach } from 'vitest'
const h = vi.hoisted(() => {
  type Result = { data: unknown; error: unknown }
  const results = new Map<string, Result[]>()
  const updates: { table: string; patch: Record<string, unknown> }[] = []
  function from(table: string) {
    const builder: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'maybeSingle']) builder[op] = () => builder
    builder.update = (patch: Record<string, unknown>) => { updates.push({ table, patch }); return builder }
    builder.then = (resolve: (r: Result) => unknown) => Promise.resolve(results.get(table)?.shift() ?? {data:null,error:null}).then(resolve)
    return builder
  }
  return { results, updates, client: { from }, estimate: vi.fn(), send: vi.fn() }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/sms/painting-estimate-dispatch', () => ({ estimateAndDispatchPainting: h.estimate }))
vi.mock('@/lib/sms/dispatch', () => ({ dispatchQuoteMessage: h.send }))
import { GET, POST } from './route'
const lead = { token:'lead-tok',tenant_id:'t1',conversation_id:'c1',customer_phone:'+61400000000',status:'new' }
const body = { address:{address:'5 Smith St',postcode:'2000',state:'NSW'},
  inputs:{scopes:['walls'],coats:2,condition:'sound',ceiling_height:'standard',colour_change:false,storeys:1} }
const state = { slots:{address:'5 Smith St'},last_step:'closed',workflow_stage:'awaiting_review',pending_quote_token:'saved-token' }
const req=(data:unknown=body)=>new Request('https://quotemax.com.au/api/paint-request/lead-tok',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})
const ctx={params:Promise.resolve({token:'lead-tok'})}
function queueHappy(row:Record<string,unknown>=lead) {
  h.results.set('painting_lead_requests',[{data:row,error:null}])
  h.results.set('tenants',[{data:{twilio_sms_number:'+61488888888'},error:null}])
}
beforeEach(()=>{
  h.results.clear();h.updates.length=0
  h.send.mockReset().mockResolvedValue({ok:true,outboxId:'out-1'})
  h.estimate.mockReset().mockImplementation(async (args:{sendReply:(text:string)=>Promise<{ok:boolean}>})=>{
    const sent=await args.sendReply('Your painting draft is saved and awaiting review. It has not been released as a quote yet.')
    return sent.ok ? {ok:true,token:'saved-token',inspection:false,state} : {ok:false,reason:'Status not accepted'}
  })
})
describe('painting form uses the same saved draft and review gate as SMS',()=>{
  it('uses stable request ownership, records the draft and sends only an honest status',async()=>{
    queueHappy()
    const response=await POST(req(),ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ok:true,stage:'awaiting_review',texted:false})
    expect(h.estimate).toHaveBeenCalledWith(expect.objectContaining({tenantId:'t1',customerPhone:lead.customer_phone,conversationId:'c1',requestKey:'paint-form:lead-tok',slots:expect.objectContaining({address:'5 Smith St',address_confirmed:true})}))
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({tenantId:'t1',deliveryKey:'paint-form:lead-tok:status',text:expect.stringMatching(/awaiting review/)}))
    expect(h.send.mock.calls[0][0].text).not.toMatch(/https?:|\$|on its way/)
    expect(h.updates).toEqual([{table:'sms_conversations',patch:expect.objectContaining({painting_state:state})},{table:'painting_lead_requests',patch:expect.objectContaining({status:'submitted',quote_token:'saved-token'})}])
  })
  it('keeps the form retryable if status delivery fails',async()=>{
    queueHappy();h.send.mockResolvedValue({ok:false})
    const response=await POST(req(),ctx)
    expect(response.status).toBe(502);expect(h.updates).toHaveLength(0)
  })
  it('does not consume the form when conversation persistence fails',async()=>{
    queueHappy();h.results.set('sms_conversations',[{data:null,error:{message:'database unavailable'}}])
    expect((await POST(req(),ctx)).status).toBe(503)
    expect(h.updates.some((u)=>u.table==='painting_lead_requests')).toBe(false)
  })
  it('reports a failed final submission write instead of claiming completion',async()=>{
    queueHappy();h.results.get('painting_lead_requests')!.push({data:null,error:{message:'database unavailable'}})
    expect((await POST(req(),ctx)).status).toBe(503)
  })
  it('reports lookup outages distinctly from unknown tokens for both handlers',async()=>{
    for (const handler of [GET,POST]) {
      h.results.set('painting_lead_requests',[{data:null,error:{message:'PGRST204'}}])
      expect((await handler(req(),ctx)).status).toBe(503)
      h.results.set('painting_lead_requests',[{data:null,error:null}])
      expect((await handler(req(),ctx)).status).toBe(404)
    }
    expect(h.estimate).not.toHaveBeenCalled()
  })
  it('requires a customer binding and valid inputs before estimating',async()=>{
    queueHappy({...lead,customer_phone:null});expect((await POST(req(),ctx)).status).toBe(422)
    queueHappy();expect((await POST(req({}),ctx)).status).toBe(400)
    expect(h.estimate).not.toHaveBeenCalled()
  })
  it('does not mark a failed estimate or inspection task as a released quote',async()=>{
    queueHappy();h.estimate.mockResolvedValueOnce({ok:false,reason:'Rates missing'})
    expect((await POST(req(),ctx)).status).toBe(502);expect(h.updates).toHaveLength(0)
    queueHappy();h.estimate.mockResolvedValueOnce({ok:true,token:'saved-token',inspection:true,state})
    expect(await (await POST(req(),ctx)).json()).toMatchObject({inspection:true,stage:'awaiting_review',texted:false})
  })
})
