// Additional front-desk schema over the unchanged actual-route fixture database.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createRouteFixtureDb} from './sms-route-fixture-db.mjs'

export async function createCompositionDb(appDirectory) {
  const db=await createRouteFixtureDb(appDirectory)
  await db.pg.exec(readFileSync(join(appDirectory,'sql/migrations/200_frontdesk_durable_inbox.sql'),'utf8'))
  await db.pg.exec('alter table sms_conversations add column if not exists updated_at timestamptz')
  const columns=new Set((await db.pg.query("select column_name from information_schema.columns where table_name='sms_frontdesk_jobs' and table_schema='public'")).rows.map(row=>row.column_name))
  const field=key=>{assert.ok(columns.has(key),`Unknown front-desk fixture column ${key}`);return `"${key}"`}
  return {...db,
    async query(input) {
      if(input.table!=='sms_frontdesk_jobs')return db.query(input)
      const {action='select',payload,filters=[],orders=[],single,limit,conflict,ignoreDuplicates}=input
      const values=[],bind=value=>{values.push(value);return `$${values.length}`}
      const where=filters.map(({op,key,value})=>{
        assert.ok(['eq','gt'].includes(op),`Unsupported front-desk fixture filter ${op}`)
        return `${field(key)} ${op==='eq'?'=':'>'} ${bind(value)}`
      }).join(' and ')
      const rowValue=(key,value)=>['payload','decision'].includes(key)?JSON.stringify(value):value
      let sql
      if(action==='select')sql=`select * from sms_frontdesk_jobs${where?' where '+where:''}`
      else if(action==='upsert') {
        assert.equal(conflict,'receipt_key');assert.equal(ignoreDuplicates,true)
        assert.equal(filters.length,0);assert.ok(payload&&!Array.isArray(payload))
        const keys=Object.keys(payload)
        sql=`insert into sms_frontdesk_jobs(${keys.map(field).join(',')}) values(${keys.map(key=>bind(rowValue(key,payload[key]))).join(',')}) on conflict(receipt_key) do nothing returning *`
      } else if(action==='update') {
        assert.ok(where,'Front-desk fixture must reject an unfenced update')
        const keys=Object.keys(payload)
        sql=`update sms_frontdesk_jobs set ${keys.map(key=>`${field(key)}=${bind(rowValue(key,payload[key]))}`).join(',')} where ${where} returning *`
      } else throw new Error(`Unsupported front-desk fixture action ${action}`)
      if(action==='select') {
        if(orders.length)sql+=` order by ${orders.map(order=>`${field(order.key)} ${order.ascending===false?'desc':'asc'}`).join(',')}`
        if(limit!==undefined){assert.ok(Number.isInteger(limit)&&limit>=0);sql+=` limit ${limit}`}
      }
      const {rows}=await db.pg.query(`with result as (${sql}) select to_jsonb(result) as row from result`,values)
      const result=rows.map(item=>item.row)
      if(single==='single'&&result.length!==1)return {data:null,error:{code:'PGRST116',message:'Expected one front-desk row'}}
      return {data:single?result[0]??null:result,error:null}
    },
    async rpc(input) {
      if(input.name!=='claim_sms_frontdesk_job')return db.rpc(input)
      assert.deepEqual(Object.keys(input.args),['p_owner'])
      const {rows}=await db.pg.query('select to_jsonb(result) as row from claim_sms_frontdesk_job($1) result',[input.args.p_owner])
      return {data:rows.map(item=>item.row),error:null}
    },
  }
}
