import {beforeEach,describe,it,expect,vi} from 'vitest'
import type {SupabaseClient} from '@supabase/supabase-js'
const send=vi.hoisted(()=>vi.fn())
vi.mock('./dispatch',()=>({dispatchQuoteMessage:send}))
import {persistHumanHandoff} from './human-handoff'
function database(){
  const state={task:{id:'task-1',status:'open'} as {id:string;status:string}|null,insertError:null as unknown,updateError:null as unknown,updates:0,ownerMobile:'+61422222222'}
  const db={from:(table:string)=>{
    let operation='select';let patch:Record<string,unknown>={};const filters:Record<string,unknown>={};const q:Record<string,unknown>={}
    q.select=()=>q;q.eq=(key:string,value:unknown)=>{filters[key]=value;return q}
    q.upsert=()=>{operation='upsert';return q};q.update=(value:Record<string,unknown>)=>{operation='update';patch=value;return q}
    function result(){
      if(table==='tenants')return {data:{owner_mobile:state.ownerMobile,twilio_sms_number:'+61488888888'},error:null}
      if(operation==='upsert')return {data:null,error:state.insertError}
      if(operation==='update'){
        if(state.updateError)return {data:null,error:state.updateError}
        if(!state.task||filters.status!==state.task.status)return {data:null,error:null}
        state.updates++;state.task={...state.task,...patch} as {id:string;status:string}
      }
      return {data:state.task?{...state.task}:null,error:null}
    }
    q.single=async()=>result();q.maybeSingle=async()=>result();q.then=(resolve:(r:unknown)=>unknown)=>Promise.resolve(result()).then(resolve)
    return q
  }} as unknown as SupabaseClient
  return {db,state}
}
const args={tenantId:'tenant-1',customerPhone:'+61411111111',requestKey:'saved-review',trade:'roofing',reason:'Review saved roof',baseUrl:'https://quotemax.com.au'}
beforeEach(()=>{send.mockReset().mockResolvedValue({ok:true,outboxId:'out-1'});vi.stubEnv('PUBLIC_WEB_ORIGIN','https://quotemax.com.au')})
describe('durable human review task completion',()=>{
  it('confirms saved notification state and uses a stable owner alert intent',async()=>{
    const {db,state}=database()
    expect(await persistHumanHandoff({...args,supabase:db})).toEqual({id:'task-1',notified:true})
    expect(state.task?.status).toBe('notified')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({deliveryKey:'human-task:task-1:notify',tenantId:'tenant-1'}))
  })
  it.each([true,false])('preserves a concurrent owner resolution when carrier acceptance is %s',async(ok)=>{
    const {db,state}=database()
    send.mockImplementation(async()=>{state.task!.status='resolved';return {ok,outboxId:'out-1'}})
    expect(await persistHumanHandoff({...args,supabase:db})).toEqual({id:'task-1',notified:true})
    expect(state.task?.status).toBe('resolved');expect(state.updates).toBe(0)
  })
  it('requires an actual returned task and never claims persistence after deletion',async()=>{
    const {db,state}=database()
    send.mockImplementation(async()=>{state.task=null;return {ok:true,outboxId:'out-1'}})
    await expect(persistHumanHandoff({...args,supabase:db})).rejects.toThrow('confirm review task')
  })
  it('does not send if a stale-worker insert is rejected by the persistence fence',async()=>{
    const {db,state}=database();state.insertError={code:'40001',message:'SMS work lease lost'}
    await expect(persistHumanHandoff({...args,supabase:db})).rejects.toThrow('persist review task')
    expect(send).not.toHaveBeenCalled()
  })
  it('does not report success when notification-state persistence fails',async()=>{
    const {db,state}=database();state.updateError={message:'write failed'}
    await expect(persistHumanHandoff({...args,supabase:db})).rejects.toThrow('persist review notification')
  })
})
