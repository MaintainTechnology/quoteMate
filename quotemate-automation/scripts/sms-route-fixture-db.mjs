// Test-only PostgREST-shaped adapter over a parent-owned PGlite database.
// Production route/worker code remains unchanged. Fixture columns are declared
// from fixture values; production schema compatibility is a separate gate.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const identifier = value => {
  assert.match(value, /^[a-z_][a-z0-9_]*$/)
  return `"${value}"`
}
const jsonNames = new Set(['scope','access','property','caller','timing','risks','assumptions','assumptions_made','conversation_state','photo_urls','photo_paths','good','better','best','quote','estimate','structures','combined','inputs','address_input','overlays','pricing_authority','items','corrected_items','priced_bom','sheets_used','recommendation','guardrail_flags','metadata','properties','tools_used','pricing_snapshot','draft'])
const arrayNames = new Set(['trades','declined_services'])
const tableNames = [
  'tenants','sms_conversations','sms_messages','intakes','quotes','customers',
  'roofing_measurements','painting_measurements','solar_estimates','paint_runs',
  'plan_uploads','plan_extractions','plan_upload_requests','aircon_recommendations',
  'pricing_book','pricing_book_versions','shared_assemblies','shared_materials',
  'tenant_custom_assemblies','tenant_material_catalogue','job_type_bounds',
  'tenant_material_preferences','tenant_tier_ladder','tenant_assembly_bom','shared_assembly_bom',
  'tenant_service_offerings','tenant_assembly_overrides','tenant_assembly_tasks','shared_assembly_tasks',
  'pipeline_logs','pipeline_traces','sms_traces','agent_traces','solar_config','agent_phone_numbers','trade_prompts',
]

export async function createRouteFixtureDb(appDirectory) {
  const pg = new PGlite()
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create table tenants(id uuid primary key);
    create table sms_conversations(id uuid primary key default gen_random_uuid(), tenant_id uuid, from_number text, to_number text,
      status text default 'open', conversation_type text default 'customer', customer_id uuid, photo_request_token text,
      conversation_state jsonb default '{}', created_at timestamptz default now(), last_message_at timestamptz default now());
    create table sms_messages(id uuid primary key default gen_random_uuid(), conversation_id uuid, direction text, body text,
      twilio_message_sid text unique, audience text default 'customer', to_number text, tenant_id uuid, created_at timestamptz default now());
    create table intakes(id uuid primary key default gen_random_uuid(),tenant_id uuid,trade text,address text,job_type text,caller jsonb);
    create table quotes(id uuid primary key default gen_random_uuid(),tenant_id uuid,intake_id uuid,status text,share_token text unique,
      good jsonb,better jsonb,best jsonb,total_inc_gst numeric,created_at timestamptz default now(),sent_at timestamptz,paid_at timestamptz,parent_quote_id uuid);
    create table roofing_measurements(id uuid primary key default gen_random_uuid(),tenant_id uuid,address text,public_token text,customer_phone text,quote jsonb,quote_id uuid,created_at timestamptz default now());
    create table painting_measurements(id uuid primary key default gen_random_uuid(),tenant_id uuid,address text,public_token text,customer_phone text,released_at timestamptz,created_at timestamptz default now());
    create table solar_estimates(id uuid primary key default gen_random_uuid(),tenant_id uuid,address text,public_token text unique,intake_id uuid,quote_id uuid,confirmed_at timestamptz,guardrail_flags jsonb default '[]',created_at timestamptz default now());
    create table plan_uploads(id uuid primary key default gen_random_uuid(),tenant_id uuid,filename text);
    create table plan_extractions(id uuid primary key default gen_random_uuid(),tenant_id uuid,plan_upload_id uuid,share_token text,corrected_items jsonb,paint_run_id uuid,priced_bom jsonb,priced_at timestamptz,created_at timestamptz default now());
    create table plan_upload_requests(id uuid primary key default gen_random_uuid(),token text unique,tenant_id uuid,plan_extraction_id uuid,sms_conversation_id uuid,customer_phone text,twilio_number text,status text,created_at timestamptz default now(),updated_at timestamptz default now(),expires_at timestamptz default now()+interval '7 days');
    create table aircon_recommendations(id uuid primary key default gen_random_uuid(),tenant_id uuid,address text,public_token text,customer_phone text,created_at timestamptz default now());
    create table paint_runs(id uuid primary key default gen_random_uuid(),tenant_id uuid,job_name text,site_address text,public_token text,status text,created_at timestamptz default now());`)
  for (const table of tableNames) await pg.exec(`create table if not exists ${identifier(table)}(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),trade text,name text)`)
  for (const file of ['122_sms_conversation_active_unique.sql','154_painting_sms_receptionist.sql','190_trade_lead_requests.sql','191_push_tokens.sql','198_sms_durable_work.sql','199_sms_delivery_outbox.sql','201_sms_trade_quote_contract.sql','207_quote_pricing_versions.sql']) {
    await pg.exec(readFileSync(join(appDirectory,'sql/migrations',file),'utf8'))
  }
  const allowedTables = new Set([...tableNames,'sms_work_jobs','sms_outbox','sms_human_tasks','quote_pricing_versions','push_events','push_tokens','push_tickets','push_event_deliveries','trade_lead_requests','painting_lead_requests'])
  const operations = []
  const columns = new Map()
  async function schema(table) {
    if (!columns.has(table)) {
      const rows = await pg.query('select column_name,data_type from information_schema.columns where table_schema=$1 and table_name=$2',['public',table])
      columns.set(table,new Map(rows.rows.map(row=>[row.column_name,row.data_type])))
    }
    return columns.get(table)
  }
  async function ensureColumns(table,row) {
    assert.ok(allowedTables.has(table),`Unregistered fixture table ${table}`)
    const known=await schema(table)
    for(const [key,value] of Object.entries(row)) {
      if(known.has(key))continue
      const type = jsonNames.has(key) || (value !== null && typeof value === 'object' && !arrayNames.has(key)) ? 'jsonb'
        : arrayNames.has(key) ? 'text[]' : key==='id'||key.endsWith('_id')||key==='sms_work_owner' ? 'uuid'
          : typeof value==='boolean' ? 'boolean' : typeof value==='number' ? 'numeric' : 'text'
      await pg.exec(`alter table ${identifier(table)} add column if not exists ${identifier(key)} ${type}`)
      known.set(key,type)
    }
  }
  async function query(input) {
    const {table,action='select',payload,filters=[],orders=[],limit,single,conflict,ignoreDuplicates}=input
    assert.ok(allowedTables.has(table),`Unregistered fixture table ${table}`)
    operations.push({table,action,filters})
    const rows=Array.isArray(payload)?payload:payload?[payload]:[]
    for(const row of rows) await ensureColumns(table,row)
    const known=await schema(table), values=[]
    const bind=value=>{values.push(value);return `$${values.length}`}
    const field=key=>{
      const parts=key.split(/->>?/)
      if(!known.has(parts[0]))return 'NULL'
      let expression=identifier(parts[0])
      for(let i=1;i<parts.length;i++)expression+=`${i===parts.length-1?'->>':'->'}${bind(parts[i])}`
      return expression
    }
    const clause=filter=>{
      const {op,key,value,negated}=filter
      if(op==='or'||op==='and') return `(${splitFilterList(value).map(term=>{
        const group=/^(or|and)\((.*)\)$/.exec(term)
        if(group)return clause({op:group[1],value:group[2]})
        const match=/^([^\.]+)\.(eq|neq|is|gte|lte|gt|lt|like|ilike|in)\.(.*)$/.exec(term)
        assert.ok(match,`Unsupported fixture OR ${term}`)
        const literal=match[3]==='null'?null:match[3]==='true'?true:match[3]==='false'?false:match[3]
        return clause({key:match[1],op:match[2],value:literal})
      }).join(` ${op} `)})`
      const left=field(key)
      if(op==='is')return `${left} is ${negated?'not ':''}${value===null?'null':value===true?'true':'false'}`
      if(op==='in') {
        const members=Array.isArray(value)?value:typeof value==='string'&&/^\(.*\)$/.test(value)?splitFilterList(value.slice(1,-1)):null
        assert.ok(members,'IN requires an explicit member list')
        return `${left} ${negated?'not ':''}in (${members.map(bind).join(',')||'null'})`
      }
      if(op==='contains')return `${negated?'not (':''}${left} @> ${bind(JSON.stringify(value))}::jsonb${negated?')':''}`
      const operators={eq:'=',neq:'<>',gte:'>=',lte:'<=',gt:'>',lt:'<',like:'like',ilike:'ilike'}
      assert.ok(operators[op],`Unsupported fixture filter ${op}`)
      return `${negated?'not (':''}${left} ${operators[op]} ${bind(value)}${negated?')':''}`
    }
    const where=()=>filters.length?` where ${filters.map(clause).join(' and ')}`:''
    const encode=(key,value)=>known.get(key)==='jsonb'&&value!==null?JSON.stringify(value):value
    let sql
    if(action==='select') sql=`select * from ${identifier(table)}${where()}`
    else if(action==='delete')sql=`delete from ${identifier(table)}${where()} returning *`
    else if(action==='update') {
      const entries=Object.entries(rows[0])
      sql=`update ${identifier(table)} set ${entries.map(([key,value])=>`${identifier(key)}=${bind(encode(key,value))}`).join(',')}${where()} returning *`
    } else {
      assert.ok(['insert','upsert'].includes(action),`Unsupported fixture write ${action}`)
      const keys=[...new Set(rows.flatMap(row=>Object.keys(row)))]
      sql=`insert into ${identifier(table)}(${keys.map(identifier).join(',')}) values ${rows.map(row=>`(${keys.map(key=>bind(encode(key,row[key]??null))).join(',')})`).join(',')}`
      if(action==='upsert') {
        const targets=(conflict??'id').split(',')
        sql+=` on conflict(${targets.map(identifier).join(',')}) do ${ignoreDuplicates?'nothing':`update set ${keys.filter(key=>!targets.includes(key)).map(key=>`${identifier(key)}=excluded.${identifier(key)}`).join(',')}`}`
      }
      sql+=' returning *'
    }
    if(action==='select') {
      if(orders.length)sql+=` order by ${orders.map(order=>`${field(order.key)} ${order.ascending===false?'desc':'asc'}`).join(',')}`
      if(limit!==undefined)sql+=` limit ${Math.max(0,Number(limit))}`
    }
    // PostgREST serialises inside Postgres. Preserve that representation for
    // timestamps/numerics so migration207 compares the exact book snapshot.
    const raw=await pg.query(`with fixture_result as (${sql}) select to_jsonb(fixture_result) as row from fixture_result`,values)
    const result={rows:raw.rows.map(item=>item.row)}
    if(single==='single'&&result.rows.length!==1)return {data:null,error:{code:'PGRST116',message:`Expected one ${table} row, found ${result.rows.length}`}}
    return {data:single?result.rows[0]??null:result.rows,error:null,count:result.rows.length}
  }
  async function rpc({name,args}) {
    operations.push({rpc:name,args})
    if(name==='sms_save_solar_estimate') {
      for(const [table,key] of [['intakes','p_intake'],['quotes','p_quote'],['solar_estimates','p_solar']])await ensureColumns(table,args[key])
    }
    const allowed=new Set(['create_sms_conversation_idempotent','enqueue_sms_work','claim_sms_work','renew_sms_work','assert_sms_work_owner','checkpoint_sms_work','finish_sms_work','sms_outbox_enqueue','sms_outbox_claim','sms_outbox_finish','sms_customer_quote_references','sms_save_solar_estimate','capture_quote_pricing_version','claim_push_event','initialise_push_event_deliveries','claim_push_event_delivery_batch','complete_push_event','release_push_event','record_push_delivery_results'])
    assert.ok(allowed.has(name),`Unregistered fixture RPC ${name}`)
    const entries=Object.entries(args)
    const jsonArgs=new Set(['p_payload','p_result','p_results','p_value','p_conversation_state','p_intake','p_quote','p_solar','p_expected_book'])
    const raw=await pg.query(`select to_jsonb(fixture_result) as row from (select * from ${identifier(name)}(${entries.map(([key],i)=>`${identifier(key)}=>$${i+1}`).join(',')})) fixture_result`,entries.map(([key,value])=>jsonArgs.has(key)?JSON.stringify(value):value))
    const result={rows:raw.rows.map(item=>item.row)}
    const multiple=['claim_sms_work','sms_customer_quote_references'].includes(name)
    const composite=['enqueue_sms_work','create_sms_conversation_idempotent'].includes(name)
    return {data:multiple?result.rows:composite?result.rows[0]:result.rows[0]?.[name],error:null}
  }
  async function seed(table,rows) {
    for(const row of rows)await query({table,action:'insert',payload:{id:randomUUID(),...row}})
  }
  return {pg,query,rpc,seed,operations,close:()=>pg.close()}
}
function splitFilterList(value) {
  const parts=[];let start=0,depth=0
  // Exact simple PostgREST logical grouping / IN-list grammar used by these
  // route queries. Quoted/escaped values require an explicit future adapter.
  assert.ok(!/["\\]/.test(value),'Quoted fixture filter needs an explicit adapter')
  for(let index=0;index<value.length;index++) {
    if(value[index]==='(')depth++
    else if(value[index]===')'){depth--;assert.ok(depth>=0,'Unbalanced fixture filter')}
    else if(value[index]===','&&depth===0){parts.push(value.slice(start,index));start=index+1}
  }
  assert.equal(depth,0,'Unbalanced fixture filter')
  parts.push(value.slice(start))
  return parts
}
